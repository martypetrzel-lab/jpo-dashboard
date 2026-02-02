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
  clearEventCoords,
  deleteCachedGeocode,
  getEventsOutsideCz,
  getEventFirstSeen
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.7 (contact: missing)";

// ---------------- AUTH ----------------
function requireKey(req, res, next) {
  const key = req.header("X-API-Key") || "";
  if (!API_KEY) return res.status(500).json({ ok: false, error: "API_KEY not set on server" });
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// ---------------- HELPERS ----------------
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

function extractCityFromTitle(title = "") {
  const s = String(title || "").trim();
  if (!s.includes(" - ")) return null;
  const parts = s.split(" - ").map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  if (last.length < 2) return null;
  return last;
}

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

// ---------------- GEOCODE (CZ ONLY) ----------------
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

  const CZ_VIEWBOX = "12.09,51.06,18.87,48.55";

  for (const q of candidates) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "3");
    url.searchParams.set("q", q);

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

    for (const cand of data) {
      const lat = Number(cand.lat);
      const lon = Number(cand.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const cc = String(cand?.address?.country_code || "").toLowerCase();
      if (cc && cc !== "cz") continue;

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

// ---------------- PDF FONT (robust) ----------------
function readFirstBytes(fontPath, n = 64) {
  const fd = fs.openSync(fontPath, "r");
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, 0);
  fs.closeSync(fd);
  return buf;
}

function isProbablyText(buf) {
  let printable = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13) { printable++; continue; }
    if (b >= 32 && b <= 126) printable++;
  }
  return printable / buf.length > 0.85;
}

function sniffFontHeader(buf4) {
  const s = buf4.toString("ascii");
  const u32 = buf4.readUInt32BE(0);

  if (s === "OTTO") return "OTF";
  if (s === "ttcf") return "TTC";
  if (s === "true" || s === "typ1") return "TTF";
  if (u32 === 0x00010000) return "TTF";
  return "UNKNOWN";
}

function validateFontFile(fontPath) {
  try {
    if (!fs.existsSync(fontPath)) return { ok: false, reason: "missing" };

    const st = fs.statSync(fontPath);
    if (!st.isFile()) return { ok: false, reason: "not_file" };
    if (st.size < 50_000) return { ok: false, reason: `too_small_${st.size}` };

    const buf64 = readFirstBytes(fontPath, 64);
    if (isProbablyText(buf64)) return { ok: false, reason: "looks_like_text_file" };

    const hdr = sniffFontHeader(buf64.subarray(0, 4));
    if (hdr === "TTF" || hdr === "OTF") return { ok: true, format: hdr };
    if (hdr === "TTC") return { ok: false, reason: "ttc_not_supported_use_ttf" };

    return { ok: false, reason: `unknown_header_${hdr}` };
  } catch (e) {
    return { ok: false, reason: `exception_${e?.message || e}` };
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
    const ext = path.extname(p).toLowerCase();
    if (ext !== ".ttf" && ext !== ".otf") continue;

    const v = validateFontFile(p);
    if (v.ok) return { path: p, format: v.format, reason: "ok" };

    if (p.includes(path.join("assets", "DejaVuSans.ttf")) && v.reason) {
      return { path: p, format: null, reason: v.reason, invalid: true };
    }
  }
  return { path: null, format: null, reason: "not_found" };
}

function tryApplyPdfFont(doc) {
  const r = findCzFontPath();
  if (!r.path) return { ok: false, fontPath: null, reason: r.reason };
  if (r.invalid) return { ok: false, fontPath: r.path, reason: r.reason };

  try {
    doc.registerFont("CZ", r.path);
    doc.font("CZ");
    return { ok: true, fontPath: r.path, reason: "ok" };
  } catch (e) {
    console.error("PDF: Font load failed:", r.path, e?.message || e);
    return { ok: false, fontPath: r.path, reason: `load_failed_${e?.message || "unknown"}` };
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

// ingest (data z ESP)
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

// events (filters)
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);
  const rows = await getEventsFiltered(filters, limit);
  const fixed = await backfillCoords(rows, 8);
  res.json({ ok: true, filters, backfilled_coords: fixed, items: rows });
});

// stats (filters)
app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);
  const stats = await getStatsFiltered(filters);
  res.json({ ok: true, filters, ...stats });
});

// export CSV
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

// ✅ export PDF (FIX: stránkování dle reálné výšky řádku)
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
  doc.moveDown(0.4);

  if (!font.ok) {
    const fp = font.fontPath ? `(${font.fontPath})` : "";
    doc.fontSize(9).fillColor("#a33").text(
      `Pozn.: CZ font nelze použít ${fp}. Důvod: ${font.reason}.`
    );
    doc.moveDown(0.3);
  }

  // tabulka
  const col = { time: 88, state: 62, type: 78, city: 170, dur: 70, title: 330 };
  const startX = doc.x;
  let y = doc.y;

  const tableWidth = col.time + col.state + col.type + col.city + col.dur + col.title;

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
    doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor("#999").stroke();
    y += 8;
  }

  function rowHeightFor(docRef, rowObj, fontSize = 9) {
    docRef.fontSize(fontSize);

    const d = new Date(rowObj.pub_date || rowObj.created_at);
    const timeText = Number.isNaN(d.getTime()) ? String(rowObj.pub_date || rowObj.created_at || "") : d.toLocaleString("cs-CZ");
    const state = rowObj.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(rowObj.event_type || "other");
    const city = String(rowObj.city_text || rowObj.place_text || "");
    const dur = Number.isFinite(rowObj.duration_min) ? `${rowObj.duration_min} min` : "—";
    const ttl = String(rowObj.title || "");

    const opts = { align: "left", lineBreak: true };

    const hTime = docRef.heightOfString(timeText, { width: col.time, ...opts });
    const hState = docRef.heightOfString(state, { width: col.state, ...opts });
    const hType = docRef.heightOfString(typ, { width: col.type, ...opts });
    const hCity = docRef.heightOfString(city, { width: col.city, ...opts });
    const hDur = docRef.heightOfString(dur, { width: col.dur, ...opts });
    const hTitle = docRef.heightOfString(ttl, { width: col.title, ...opts });

    const maxH = Math.max(hTime, hState, hType, hCity, hDur, hTitle);
    return Math.max(14, Math.ceil(maxH) + 4); // min výška řádku + padding
  }

  function drawRow(rowObj) {
    doc.fontSize(9).fillColor("#111");

    const d = new Date(rowObj.pub_date || rowObj.created_at);
    const timeText = Number.isNaN(d.getTime()) ? String(rowObj.pub_date || rowObj.created_at || "") : d.toLocaleString("cs-CZ");
    const state = rowObj.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(rowObj.event_type || "other");
    const city = String(rowObj.city_text || rowObj.place_text || "");
    const dur = Number.isFinite(rowObj.duration_min) ? `${rowObj.duration_min} min` : "—";
    const ttl = String(rowObj.title || "");

    const opts = { align: "left", lineBreak: true };

    doc.text(timeText, startX, y, { width: col.time, ...opts });
    doc.text(state, startX + col.time, y, { width: col.state, ...opts });
    doc.text(typ, startX + col.time + col.state, y, { width: col.type, ...opts });
    doc.text(city, startX + col.time + col.state + col.type, y, { width: col.city, ...opts });
    doc.text(dur, startX + col.time + col.state + col.type + col.city, y, { width: col.dur, ...opts });
    doc.text(ttl, startX + col.time + col.state + col.type + col.city + col.dur, y, { width: col.title, ...opts });
  }

  drawHeader();
  ensureFontAfterPage();

  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 18; // rezerva

  for (const r of rows) {
    const h = rowHeightFor(doc, r, 9);

    // když se nevejde, uděláme novou stránku
    if (y + h > bottomLimit()) {
      doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
      ensureFontAfterPage();
      y = doc.y;
      drawHeader();
      ensureFontAfterPage();
    }

    drawRow(r);

    // oddělovač řádku (jemně)
    y += h;
    doc.moveTo(startX, y - 2).lineTo(startX + tableWidth, y - 2).strokeColor("#eee").opacity(0.5).stroke();
    doc.opacity(1);
  }

  // footer se záznamy vždy na poslední stránce dolů (pokud je místo)
  if (y + 24 > bottomLimit()) {
    doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
    ensureFontAfterPage();
    y = doc.y;
  }
  doc.fontSize(9).fillColor("#444").text(`Záznamů: ${rows.length}`, startX, y + 10);

  doc.end();
});

// ✅ Varianta B: oprava špatných bodů mimo ČR (purge cache + re-geocode)
app.post("/api/admin/regeocode", requireKey, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "outside_cz");
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 200), 2000));

    if (mode !== "outside_cz") {
      return res.status(400).json({ ok: false, error: "mode must be 'outside_cz'" });
    }

    const bad = await getEventsOutsideCz(limit);

    let cacheDeleted = 0;
    let coordsCleared = 0;
    let reGeocoded = 0;
    let failed = 0;

    for (const ev of bad) {
      const q = (ev.city_text && String(ev.city_text).trim()) ? ev.city_text : ev.place_text;
      if (!q) continue;

      await deleteCachedGeocode(q);
      cacheDeleted++;

      await clearEventCoords(ev.id);
      coordsCleared++;

      const g = await geocodePlace(q);
      if (g) {
        await updateEventCoords(ev.id, g.lat, g.lon);
        reGeocoded++;
      } else {
        failed++;
      }
    }

    res.json({
      ok: true,
      mode,
      processed: bad.length,
      cache_deleted: cacheDeleted,
      coords_cleared: coordsCleared,
      re_geocoded: reGeocoded,
      failed
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
await initDb();
app.listen(port, () => console.log(`listening on ${port}`));
