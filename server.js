import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  upsertEvent,
  getEventsFiltered,
  getStatsFiltered,
  getCachedGeocode,
  setCachedGeocode,
  updateEventCoords,
  getEventFirstSeen
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.5 (contact: missing)";

function requireKey(req, res, next) {
  const key = req.header("X-API-Key") || "";
  if (!API_KEY) return res.status(500).json({ ok: false, error: "API_KEY not set on server" });
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

function classifyType(title = "") {
  const t = title.toLowerCase();
  if (t.includes("požár") || t.includes("pozar")) return "fire";
  if (t.includes("doprav") || t.includes("nehoda") || t.includes("dn")) return "traffic";
  if (t.includes("technick") || t.includes("čerpad") || t.includes("cerpad") || t.includes("strom")) return "tech";
  if (t.includes("záchrana") || t.includes("zachrana") || t.includes("transport") || t.includes("resusc")) return "rescue";
  if (t.includes("planý poplach") || t.includes("plany poplach")) return "false_alarm";
  return "other";
}

function isDistrictPlace(placeText = "") {
  return /^\s*okres\s+/i.test(String(placeText || ""));
}

// město z title: poslední segment po " - "
function extractCityFromTitle(title = "") {
  const s = String(title || "").trim();
  if (!s.includes(" - ")) return null;
  const parts = s.split(" - ").map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (last.length < 2) return null;
  return last;
}

// město z DESCRIPTION
function extractCityFromDescription(descRaw = "") {
  if (!descRaw) return null;

  const norm = String(descRaw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const low = line
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

    if (low.startsWith("stav:")) continue;
    if (low.startsWith("ukonceni:")) continue;
    if (low.startsWith("vyhlaseni:")) continue;
    if (low.startsWith("ohlaseni:")) continue;
    if (low.startsWith("okres ")) continue;
    if (line.length < 2) continue;

    return line;
  }
  return null;
}

// parse CZ date like "2. února 2026, 17:27"
function parseCzDateToIso(s) {
  if (!s) return null;
  const norm = String(s)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  const months = {
    ledna: 1, unora: 2, brezna: 3, dubna: 4, kvetna: 5, cervna: 6,
    cervence: 7, srpna: 8, zari: 9, rijna: 10, listopadu: 11, prosince: 12
  };

  const m = norm.match(/(\d{1,2})\.?\s+([a-z]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;

  const day = Number(m[1]);
  const monName = m[2];
  const year = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);

  const month = months[monName];
  if (!month) return null;

  const dt = new Date(Date.UTC(year, month - 1, day, hh, mm, 0));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function parseTimesFromDescription(descRaw = "") {
  const norm = String(descRaw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);

  let startText = null;
  let endText = null;
  let isClosed = false;

  for (const line of lines) {
    const n = line
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

    if (n.startsWith("vyhlaseni:")) startText = line.split(":").slice(1).join(":").trim();
    if (n.startsWith("ohlaseni:")) startText = startText || line.split(":").slice(1).join(":").trim();
    if (n.startsWith("ukonceni:")) {
      endText = line.split(":").slice(1).join(":").trim();
      isClosed = true;
    }
  }

  return {
    startIso: parseCzDateToIso(startText),
    endIso: parseCzDateToIso(endText),
    isClosed
  };
}

async function computeDurationMin(id, startIso, endIso) {
  if (!endIso) return null;

  let startMs = startIso ? new Date(startIso).getTime() : NaN;
  if (!Number.isFinite(startMs)) {
    const firstSeen = await getEventFirstSeen(id);
    if (firstSeen) startMs = new Date(firstSeen).getTime();
  }

  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  return Math.round((endMs - startMs) / 60000);
}

function normalizePlaceQuery(placeText) {
  const raw = String(placeText || "").trim();
  if (!raw) return "";
  return raw.replace(/^okres\s+/i, "").replace(/^ok\.\s*/i, "").trim();
}

/**
 * ✅ GEOCODE pouze ČR:
 * - countrycodes=cz
 * - addressdetails=1 + kontrola address.country_code
 * - viewbox + bounded=1 (pevné ohraničení)
 */
async function geocodePlace(placeText) {
  if (!placeText || placeText.trim().length < 2) return null;

  const cached = await getCachedGeocode(placeText);
  if (cached && typeof cached.lat === "number" && typeof cached.lon === "number") {
    return { lat: cached.lat, lon: cached.lon, cached: true };
  }

  const cleaned = normalizePlaceQuery(placeText);

  const candidates = [];
  candidates.push(String(placeText).trim());
  if (cleaned && cleaned !== String(placeText).trim()) candidates.push(cleaned);

  // vždy přidáme "Czechia" jako kontext (ale stejně enforce přes countrycodes)
  if (cleaned) candidates.push(`${cleaned}, Czechia`);
  candidates.push(`${String(placeText).trim()}, Czechia`);

  // Rough bounding box ČR: left,top,right,bottom
  // (lon_left, lat_top, lon_right, lat_bottom)
  const CZ_VIEWBOX = "12.09,51.06,18.87,48.55";

  for (const q of candidates) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "3"); // vezmeme pár kandidátů a ověříme CZ
    url.searchParams.set("q", q);

    // ✅ omezení na ČR
    url.searchParams.set("countrycodes", "cz");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("bounded", "1");
    url.searchParams.set("viewbox", CZ_VIEWBOX);

    const r = await fetch(url.toString(), {
      headers: { "User-Agent": GEOCODE_UA, "Accept-Language": "cs,en;q=0.8" }
    });
    if (!r.ok) continue;

    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) continue;

    // projdi kandidáty a vezmi první, který je fakt CZ
    for (const cand of data) {
      const lat = Number(cand.lat);
      const lon = Number(cand.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const cc = String(cand?.address?.country_code || "").toLowerCase();
      if (cc && cc !== "cz") continue; // mimo ČR

      // někdy address není – tak ještě druhá pojistka: display_name
      const dn = String(cand.display_name || "").toLowerCase();
      if (!cc && dn && !(dn.includes("czechia") || dn.includes("cesko") || dn.includes("česko") || dn.includes("czech republic"))) {
        continue;
      }

      await setCachedGeocode(placeText, lat, lon);
      return { lat, lon, cached: false, qUsed: q };
    }
  }

  return null;
}

function parseFilters(req) {
  const typeQ = String(req.query.type || "").trim();
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").trim().toLowerCase();

  const types = typeQ ? typeQ.split(",").map(s => s.trim()).filter(Boolean) : [];
  const normStatus = ["all", "open", "closed"].includes(status) ? status : "all";

  return { types, city, status: normStatus };
}

async function backfillCoords(rows, max = 5) {
  const need = rows
    .filter(r => ((r.city_text || r.place_text) && (r.lat == null || r.lon == null)))
    .slice(0, Math.max(0, Math.min(max, 20)));

  let fixed = 0;
  for (const r of need) {
    try {
      const q = r.city_text || r.place_text;
      const g = await geocodePlace(q);
      if (g) {
        await updateEventCoords(r.id, g.lat, g.lon);
        r.lat = g.lat;
        r.lon = g.lon;
        fixed++;
      }
    } catch {
      // ignore
    }
  }
  return fixed;
}

// ---------------- PDF FONT (beze změn) ----------------

function sniffFontFormat(fontPath) {
  try {
    const fd = fs.openSync(fontPath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);

    const s = buf.toString("ascii");
    const u32 = buf.readUInt32BE(0);

    if (s === "OTTO") return "OTF";
    if (s === "ttcf") return "TTC";
    if (s === "true" || s === "typ1") return "TTF";
    if (u32 === 0x00010000) return "TTF";
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function findCzFontPath() {
  const candidates = [
    path.join(__dirname, "assets", "DejaVuSans.ttf"),
    path.join(__dirname, "assets", "NotoSans-Regular.ttf"),
    path.join(__dirname, "assets", "Roboto-Regular.ttf"),

    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf"
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;

      const ext = path.extname(p).toLowerCase();
      if (ext !== ".ttf" && ext !== ".otf") continue;

      const fmt = sniffFontFormat(p);
      if (fmt === "TTF" || fmt === "OTF") return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function tryApplyPdfFont(doc) {
  const fontPath = findCzFontPath();
  if (!fontPath) return { ok: false, fontPath: null, reason: "not_found" };

  try {
    doc.registerFont("CZ", fontPath);
    doc.font("CZ");
    return { ok: true, fontPath, reason: "ok" };
  } catch {
    return { ok: false, fontPath, reason: "load_failed" };
  }
}

function typeLabel(t) {
  switch (t) {
    case "fire": return "požár";
    case "traffic": return "nehoda";
    case "tech": return "technická";
    case "rescue": return "záchrana";
    case "false_alarm": return "planý poplach";
    default: return "jiné";
  }
}

// ---------------- ROUTES ----------------

app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const { source, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items missing" });
    }

    let accepted = 0;
    let updatedClosed = 0;
    let geocoded = 0;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const eventType = it.eventType || classifyType(it.title);

      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const times = parseTimesFromDescription(desc);

      const durationMin =
        Number.isFinite(it.durationMin)
          ? it.durationMin
          : await computeDurationMin(it.id, times.startIso, times.endIso);

      const placeText = it.placeText || null;
      const cityFromDesc = extractCityFromDescription(desc);
      const cityFromTitle = extractCityFromTitle(it.title);

      const cityText =
        it.cityText ||
        cityFromDesc ||
        (!placeText ? cityFromTitle : (isDistrictPlace(placeText) ? cityFromTitle : placeText)) ||
        null;

      const ev = {
        id: it.id,
        title: it.title,
        link: it.link,
        pubDate: it.pubDate || null,
        placeText,
        cityText,
        statusText: it.statusText || null,
        eventType,
        descriptionRaw: desc || null,
        startTimeIso: it.startTimeIso || times.startIso || null,
        endTimeIso: it.endTimeIso || times.endIso || null,
        durationMin,
        isClosed: !!times.isClosed
      };

      await upsertEvent(ev);
      accepted++;

      if (ev.isClosed) updatedClosed++;

      const geoQuery = ev.cityText || ev.placeText;
      if (geoQuery) {
        const g = await geocodePlace(geoQuery);
        if (g) {
          await updateEventCoords(ev.id, g.lat, g.lon);
          geocoded++;
        }
      }
    }

    res.json({
      ok: true,
      source: source || "unknown",
      accepted,
      closed_seen_in_batch: updatedClosed,
      geocoded
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);
  const rows = await getEventsFiltered(filters, limit);
  const fixed = await backfillCoords(rows, 5);
  res.json({ ok: true, filters, backfilled_coords: fixed, items: rows });
});

app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);
  const stats = await getStatsFiltered(filters);
  res.json({ ok: true, filters, ...stats });
});

app.get("/api/export.pdf", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 800), 2000);
  const rows = await getEventsFiltered(filters, limit);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  doc.pipe(res);

  const font = tryApplyPdfFont(doc);

  const now = new Date();
  const title = "JPO výjezdy – export";
  const filt = [
    filters.types?.length ? `Typ: ${filters.types.join(", ")}` : "Typ: všechny",
    filters.city ? `Město: "${filters.city}"` : "Město: všechny",
    filters.status === "open" ? "Stav: aktivní" : filters.status === "closed" ? "Stav: ukončené" : "Stav: všechny"
  ].join("  •  ");

  doc.fontSize(18).fillColor("#000").text(title);
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#333").text(`Vygenerováno: ${now.toLocaleString("cs-CZ")}   •   ${filt}`);
  doc.moveDown(0.3);

  if (!font.ok) {
    doc.fontSize(9).fillColor("#a33")
      .text("Pozn.: CZ font nebyl nalezen/nelze načíst. Přidej validní TTF do assets/DejaVuSans.ttf pro správnou diakritiku.");
    doc.moveDown(0.5);
  } else {
    doc.moveDown(0.6);
  }

  const col = { time: 88, state: 62, type: 78, city: 160, dur: 70, title: 340 };
  const startX = doc.x;
  let y = doc.y;

  function ensureFontAfterPage() {
    if (font.ok) {
      try { doc.font("CZ"); } catch { /* ignore */ }
    }
  }

  function drawHeader() {
    doc.fontSize(10).fillColor("#000");
    doc.text("Čas", startX, y, { width: col.time });
    doc.text("Stav", startX + col.time, y, { width: col.state });
    doc.text("Typ", startX + col.time + col.state, y, { width: col.type });
    doc.text("Město", startX + col.time + col.state + col.type, y, { width: col.city });
    doc.text("Délka", startX + col.time + col.state + col.type + col.city, y, { width: col.dur });
    doc.text("Název", startX + col.time + col.state + col.type + col.city + col.dur, y, { width: col.title });

    y += 14;
    doc.moveTo(startX, y)
      .lineTo(startX + col.time + col.state + col.type + col.city + col.dur + col.title, y)
      .strokeColor("#999")
      .stroke();
    y += 8;
  }

  drawHeader();
  doc.fontSize(9).fillColor("#111");

  for (const r of rows) {
    const d = new Date(r.pub_date || r.created_at);
    const timeText = Number.isNaN(d.getTime()) ? String(r.pub_date || r.created_at || "") : d.toLocaleString("cs-CZ");

    const state = r.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(r.event_type || "other");
    const city = String(r.city_text || r.place_text || "");
    const dur = Number.isFinite(r.duration_min) ? `${r.duration_min} min` : "—";
    const ttl = String(r.title || "");

    if (y > doc.page.height - 40) {
      doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
      ensureFontAfterPage();
      y = doc.y;
      drawHeader();
      doc.fontSize(9).fillColor("#111");
    }

    doc.text(timeText, startX, y, { width: col.time });
    doc.text(state, startX + col.time, y, { width: col.state });
    doc.text(typ, startX + col.time + col.state, y, { width: col.type });
    doc.text(city, startX + col.time + col.state + col.type, y, { width: col.city });
    doc.text(dur, startX + col.time + col.state + col.type + col.city, y, { width: col.dur });
    doc.text(ttl, startX + col.time + col.state + col.type + col.city + col.dur, y, { width: col.title });

    y += 14;
  }

  doc.moveDown(0.6);
  doc.fontSize(9).fillColor("#444").text(`Záznamů: ${rows.length}`);
  doc.end();
});

app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
await initDb();
app.listen(port, () => console.log(`listening on ${port}`));
