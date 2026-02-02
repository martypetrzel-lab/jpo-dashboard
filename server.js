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

// Nominatim
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.3 (contact: missing)";

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

function isDistrictPlace(placeText = "") {
  return /^\s*okres\s+/i.test(String(placeText || ""));
}

// parse CZ date like "31. ledna 2026, 15:07"
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
  if (cleaned) candidates.push(`${cleaned}, Czechia`);
  candidates.push(`${String(placeText).trim()}, Czechia`);

  for (const q of candidates) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    url.searchParams.set("q", q);

    const r = await fetch(url.toString(), {
      headers: { "User-Agent": GEOCODE_UA, "Accept-Language": "cs,en;q=0.8" }
    });
    if (!r.ok) continue;

    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) continue;

    const lat = Number(data[0].lat);
    const lon = Number(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    await setCachedGeocode(placeText, lat, lon);
    return { lat, lon, cached: false, qUsed: q };
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

/**
 * ✅ VALIDACE FONTU: PDFKit/fontkit berou jen TTF/OTF.
 * - TTF hlavička: 00 01 00 00 / 'true' / 'typ1'
 * - OTF hlavička: 'OTTO'
 * - TTC hlavička: 'ttcf' (kolekce) – tu radši odmítneme, protože často dělá problémy
 */
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
    // 🔥 Doporučeno: přibal do repa validní TTF
    path.join(__dirname, "assets", "DejaVuSans.ttf"),
    path.join(__dirname, "assets", "Roboto-Regular.ttf"),

    // systémové (Railway/Ubuntu někdy má, někdy ne)
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf"
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;

      // nejdřív rychlá validace přípony
      const ext = path.extname(p).toLowerCase();
      if (ext !== ".ttf" && ext !== ".otf") continue;

      // pak hlavička
      const fmt = sniffFontFormat(p);
      if (fmt === "TTF" || fmt === "OTF") return p;

      // TTC nebo UNKNOWN → přeskoč
      console.warn(`PDF font skipped (unsupported format ${fmt}): ${p}`);
    } catch {
      // ignore
    }
  }

  return null;
}

function tryApplyPdfFont(doc) {
  const fontPath = findCzFontPath();
  if (!fontPath) return { ok: false, fontPath: null };

  try {
    doc.registerFont("CZ", fontPath);
    doc.font("CZ");
    return { ok: true, fontPath };
  } catch (e) {
    // ✅ klíčové: už nikdy to nespadne na "Unknown font format"
    console.error("PDF font load failed:", e?.message || e);
    return { ok: false, fontPath };
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

// -------------------- ROUTES --------------------

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
      const cityFromTitle = extractCityFromTitle(it.title);

      const cityText =
        it.cityText ||
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

      // geokóduj primárně město
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

app.get("/api/export.csv", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  const rows = await getEventsFiltered(filters, limit);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.csv"`);

  const csvEscape = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r;]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };

  const formatDateForCsv = (v) => {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toISOString();
  };

  const header = [
    "time_iso",
    "state",
    "type",
    "title",
    "city",
    "place_text",
    "status_text",
    "duration_min",
    "link"
  ].join(";");

  const lines = rows.map(r => {
    const timeIso = formatDateForCsv(r.pub_date || r.created_at);
    const state = r.is_closed ? "UKONCENO" : "AKTIVNI";
    const typ = typeLabel(r.event_type || "other");
    return [
      csvEscape(timeIso),
      csvEscape(state),
      csvEscape(typ),
      csvEscape(r.title || ""),
      csvEscape(r.city_text || ""),
      csvEscape(r.place_text || ""),
      csvEscape(r.status_text || ""),
      csvEscape(Number.isFinite(r.duration_min) ? r.duration_min : ""),
      csvEscape(r.link || "")
    ].join(";");
  });

  res.send([header, ...lines].join("\n"));
});

app.get("/api/export.pdf", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 800), 2000);
  const rows = await getEventsFiltered(filters, limit);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  doc.pipe(res);

  // ✅ aplikuj font bezpečně (bez pádu)
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

  // pokud font chybí, dej malou poznámku (aby bylo jasné proč není diakritika)
  if (!font.ok) {
    doc.fontSize(9).fillColor("#a33")
      .text("Pozn.: CZ font nebyl nalezen/nelze načíst. Přidej validní TTF do assets/DejaVuSans.ttf pro správnou diakritiku.");
    doc.moveDown(0.5);
  } else {
    doc.moveDown(0.6);
  }

  const col = { time: 88, state: 62, type: 78, city: 140, dur: 70, title: 360 };
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
