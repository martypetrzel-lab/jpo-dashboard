// server.js
import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  pool,
  upsertEvent,
  getEventsFiltered,
  getStatsFiltered,
  getCachedGeocode,
  setCachedGeocode,
  updateEventCoords,
  clearEventCoords,
  deleteCachedGeocode,
  getEventsOutsideCz,
  getEventFirstSeen,
  updateEventDuration,
  getClosedEventsMissingDuration,
  getEventsNeedingReparse,
  updateEventTimesAndDuration
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.7 (contact: missing)";

// RSS tahá ESP a posílá na ingest – tady děláme jen zpětné opravy z uložených description_raw.

// ✅ sanity limit pro délku zásahu (default 3 dny)
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320));
const FUTURE_END_TOLERANCE_MS = 5 * 60 * 1000;

// ✅ tvrdé hranice ČR (kvůli špatnému geocodu)
const CZ_BOUNDS = { minLat: 48.55, maxLat: 51.06, minLon: 12.09, maxLon: 18.87 };

function inBounds(lat, lon, b) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= b.minLat && lat <= b.maxLat &&
    lon >= b.minLon && lon <= b.maxLon
  );
}

// ---------------- AUTH ----------------
function requireKey(req, res, next) {
  const key = req.header("X-API-Key") || "";
  if (!API_KEY) return res.status(500).json({ ok: false, error: "API_KEY not set on server" });
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

function requireAdminPassword(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: "ADMIN_PASSWORD not set on server" });
  const pw = req.header("X-Admin-Password") || "";
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "unauthorized" });
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

function normalizeDesc(descRaw = "") {
  if (!descRaw) return "";
  // v RSS je často "&lt;br&gt;" – nejdřív dekóduj entity, pak teprve nahraď <br>
  return String(descRaw)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .trim();
}

function extractStatusFromDescription(descRaw = "") {
  const norm = normalizeDesc(descRaw);
  if (!norm) return null;
  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const low = line
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
    if (low.startsWith("stav:")) {
      return line.split(":").slice(1).join(":").trim() || null;
    }
  }
  return null;
}

function extractCityFromDescription(descRaw = "") {
  if (!descRaw) return null;

  const norm = normalizeDesc(descRaw);

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
  const norm = normalizeDesc(descRaw);

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

async function computeDurationMin(id, startIso, endIso, createdAtFallback) {
  if (!endIso) return null;

  const nowMs = Date.now();

  let startMs = startIso ? new Date(startIso).getTime() : NaN;

  if (!Number.isFinite(startMs)) {
    const firstSeen = await getEventFirstSeen(id);
    if (firstSeen) startMs = new Date(firstSeen).getTime();
  }

  if (!Number.isFinite(startMs) && createdAtFallback) {
    const ca = new Date(createdAtFallback).getTime();
    if (Number.isFinite(ca)) startMs = ca;
  }

  const endMs = new Date(endIso).getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (endMs > nowMs + FUTURE_END_TOLERANCE_MS) return null;

  const dur = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  if (dur > MAX_DURATION_MINUTES) return null;
  return dur;
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
    if (inBounds(cached.lat, cached.lon, CZ_BOUNDS)) {
      return { lat: cached.lat, lon: cached.lon, cached: true };
    }
    // špatný cache z minulosti – smaž a zkus znovu
    try { await deleteCachedGeocode(placeText); } catch { /* ignore */ }
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

      if (!inBounds(lat, lon, CZ_BOUNDS)) continue;

      const cc = String(cand?.address?.country_code || "").toLowerCase();
      if (cc && cc !== "cz") continue;

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

// ✅ PRŮBĚŽNÉ DOPOČÍTÁVÁNÍ DÉLKY (a uložení do DB)
async function backfillDurations(rows, max = 40) {
  const candidates = rows
    .filter(r => r?.is_closed && r?.end_time_iso && (r.duration_min == null))
    .slice(0, Math.max(0, Math.min(max, 200)));

  let fixed = 0;

  for (const r of candidates) {
    const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.created_at);
    if (Number.isFinite(dur) && dur > 0) {
      await updateEventDuration(r.id, dur);
      r.duration_min = dur;
      fixed++;
    }
  }

  return fixed;
}

async function backfillCoords(rows, max = 8) {
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

// ✅ Zpětné opravy: z uloženého description_raw vytáhni časy/stav a dopočítej délku
async function reparseAndRecalcFromStored(limit = 500) {
  const rows = await getEventsNeedingReparse(limit);
  let touched = 0;
  let filledEnd = 0;
  let filledStart = 0;
  let filledDur = 0;

  for (const r of rows) {
    const desc = r.description_raw || "";
    const times = parseTimesFromDescription(desc);
    const statusFromDesc = extractStatusFromDescription(desc);

    const startIso = r.start_time_iso || times.startIso || null;
    const endIso = r.end_time_iso || times.endIso || null;
    const isClosed = (r.is_closed || times.isClosed || (statusFromDesc && statusFromDesc.toLowerCase().includes("ukon"))) ? true : false;

    let durationMin = r.duration_min;
    if (isClosed && endIso && (durationMin == null)) {
      const dur = await computeDurationMin(r.id, startIso, endIso, r.created_at);
      if (Number.isFinite(dur) && dur > 0) {
        durationMin = dur;
      }
    }

    const needUpdate =
      (!r.start_time_iso && startIso) ||
      (!r.end_time_iso && endIso) ||
      (r.is_closed === false && isClosed) ||
      (!r.status_text && statusFromDesc) ||
      (r.duration_min == null && Number.isFinite(durationMin));

    if (!needUpdate) continue;

    await updateEventTimesAndDuration(r.id, {
      startTimeIso: !r.start_time_iso ? startIso : null,
      endTimeIso: !r.end_time_iso ? endIso : null,
      isClosed: r.is_closed ? null : isClosed,
      statusText: !r.status_text ? statusFromDesc : null,
      durationMin: (r.duration_min == null && Number.isFinite(durationMin)) ? durationMin : null
    });

    touched++;
    if (!r.start_time_iso && startIso) filledStart++;
    if (!r.end_time_iso && endIso) filledEnd++;
    if (r.duration_min == null && Number.isFinite(durationMin)) filledDur++;
  }

  return { scanned: rows.length, touched, filledStart, filledEnd, filledDur };
}

// ---------------- PDF FONT (robust minimal) ----------------
function findFontPath() {
  const p = path.join(__dirname, "assets", "DejaVuSans.ttf");
  if (fs.existsSync(p)) return p;
  return null;
}

function tryApplyPdfFont(doc) {
  const p = findFontPath();
  if (!p) return { ok: false, fontPath: null, reason: "not_found" };
  try {
    doc.registerFont("CZ", p);
    doc.font("CZ");
    return { ok: true, fontPath: p, reason: "ok" };
  } catch (e) {
    return { ok: false, fontPath: p, reason: `load_failed_${e?.message || "unknown"}` };
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

// ruční přepočet (admin heslo) – opraví staré záznamy z uloženého description_raw
app.post("/api/admin/recalc", requireAdminPassword, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(10000, Number(req.body?.limit || 2000)));
    const result = await reparseAndRecalcFromStored(limit);

    // navíc: dopočítej duration pro ty, co už mají end_time_iso (rychlá cesta)
    const missing = await getClosedEventsMissingDuration(2000);
    let fixedDur = 0;
    for (const r of missing) {
      const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.created_at);
      if (Number.isFinite(dur) && dur > 0) {
        await updateEventDuration(r.id, dur);
        fixedDur++;
      }
    }

    res.json({ ok: true, ...result, additionally_fixed_duration: fixedDur });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

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
      const statusFromDesc = extractStatusFromDescription(desc);

      const durationMin =
        Number.isFinite(it.durationMin)
          ? it.durationMin
          : await computeDurationMin(it.id, it.startTimeIso || times.startIso, it.endTimeIso || times.endIso, null);

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
        statusText: it.statusText || statusFromDesc || null,
        eventType,
        descriptionRaw: desc || null,
        startTimeIso: it.startTimeIso || times.startIso || null,
        endTimeIso: it.endTimeIso || times.endIso || null,
        durationMin,
        isClosed: !!(times.isClosed || (statusFromDesc && statusFromDesc.toLowerCase().includes("ukon")))
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

// events (filters) + backfill coords + backfill duration
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);

  const rows = await getEventsFiltered(filters, limit);

  const fixedCoords = await backfillCoords(rows, 8);
  const fixedDur = await backfillDurations(rows, 80);

  res.json({ ok: true, filters, backfilled_coords: fixedCoords, backfilled_durations: fixedDur, items: rows });
});

// stats (filters)
app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);
  const stats = await getStatsFiltered(filters);
  res.json({ ok: true, filters, ...stats });
});

// export CSV (nejdřív backfill duration, aby export měl vše)
app.get("/api/export.csv", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  const rows = await getEventsFiltered(filters, limit);

  await backfillDurations(rows, 500);

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

// export PDF (backfill duration + jednoduché stránkování podle výšky řádku)
app.get("/api/export.pdf", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 800), 2000);
  const rows = await getEventsFiltered(filters, limit);

  await backfillDurations(rows, 500);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  doc.pipe(res);

  const font = tryApplyPdfFont(doc);

  const now = new Date();
  doc.fontSize(18).fillColor("#000").text("JPO výjezdy – export");
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#333").text(`Vygenerováno: ${now.toLocaleString("cs-CZ")}`);
  doc.moveDown(0.4);

  if (!font.ok) {
    doc.fontSize(9).fillColor("#a33").text(`Pozn.: font nelze použít (${font.reason})`);
    doc.moveDown(0.3);
  }

  const col = { time: 88, state: 62, type: 78, city: 170, dur: 70, title: 330 };
  const startX = doc.x;
  let y = doc.y;
  const tableWidth = col.time + col.state + col.type + col.city + col.dur + col.title;

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
    y += 6;
  }

  function newPage() {
    doc.addPage();
    y = doc.y;
    drawHeader();
  }

  drawHeader();

  doc.fontSize(9).fillColor("#000");

  const rowH = 14;
  for (const r of rows) {
    if (y + rowH > doc.page.height - 30) newPage();

    const time = formatDateForCsv(r.pub_date || r.created_at);
    const state = r.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(r.event_type || "other");
    const city = r.city_text || r.place_text || "";
    const dur = Number.isFinite(r.duration_min) ? `${r.duration_min} min` : "—";
    const title = r.title || "";

    doc.fillColor("#111");
    doc.text(time, startX, y, { width: col.time });
    doc.text(state, startX + col.time, y, { width: col.state });
    doc.text(typ, startX + col.time + col.state, y, { width: col.type });
    doc.text(city, startX + col.time + col.state + col.type, y, { width: col.city });
    doc.text(dur, startX + col.time + col.state + col.type + col.city, y, { width: col.dur });
    doc.text(title, startX + col.time + col.state + col.type + col.city + col.dur, y, { width: col.title });

    y += rowH;
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
app.listen(port, () => {
  console.log(`listening on ${port}`);

  // každých 5 min zkus z uložených description_raw doplnit ukončení a délku
  setInterval(async () => {
    try {
      await reparseAndRecalcFromStored(400);
    } catch {
      // ignore
    }
  }, 5 * 60 * 1000);
});
