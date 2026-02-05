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
  getEventFirstSeen,
  updateEventDuration,
  getDurationCutoffIso
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.7 (contact: missing)";

// ✅ sanity limit pro délku zásahu (default 3 dny)
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny
const FUTURE_END_TOLERANCE_MS = 5 * 60 * 1000; // ukončení nesmí být "v budoucnu" o víc než 5 min

// ✅ Středočeský kraj – omez geocode (aby se stejnojmenná místa nehledala v Polsku apod.)
const STC_VIEWBOX = process.env.STC_VIEWBOX || "13.25,50.71,15.65,49.30"; // left,top,right,bottom
const STC_STATE_ALLOW = /stredocesky|central bohemia/i;

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

// ✅ fix na extrémní / nesmyslné délky
async function computeDurationMin(id, startIso, endIso, createdAtFallback, cutoffIso) {
  if (!endIso) return null;

  const nowMs = Date.now();

  let startMs = startIso ? new Date(startIso).getTime() : NaN;

  if (!Number.isFinite(startMs)) {
    const firstSeen = await getEventFirstSeen(id);
    if (firstSeen) startMs = new Date(firstSeen).getTime();

    // ✅ nepočítat délky pro historické události (před cutoff)
    if (firstSeen && cutoffIso) {
      const cMs = new Date(cutoffIso).getTime();
      const fMs = new Date(firstSeen).getTime();
      if (Number.isFinite(cMs) && Number.isFinite(fMs) && fMs < cMs) return null;
    }
  }

  if (!Number.isFinite(startMs) && createdAtFallback) {
    const ca = new Date(createdAtFallback).getTime();
    if (Number.isFinite(ca)) startMs = ca;
  }

  // ✅ cutoff i pro případy, kdy jsme start brali z title/desc – rozhoduje first_seen_at
  if (cutoffIso) {
    const firstSeen = await getEventFirstSeen(id);
    if (firstSeen) {
      const cMs = new Date(cutoffIso).getTime();
      const fMs = new Date(firstSeen).getTime();
      if (Number.isFinite(cMs) && Number.isFinite(fMs) && fMs < cMs) return null;
    }
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
    return { lat: cached.lat, lon: cached.lon, cached: true };
  }

  const cleaned = normalizePlaceQuery(placeText);

  const candidates = [];
  candidates.push(String(placeText).trim());
  if (cleaned && cleaned !== String(placeText).trim()) candidates.push(cleaned);
  if (cleaned) candidates.push(`${cleaned}, Czechia`);
  candidates.push(`${String(placeText).trim()}, Czechia`);

  // původní CZ viewbox byl široký – tady používáme Středočeský kraj
  const CZ_VIEWBOX = STC_VIEWBOX;

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

      // ✅ Středočeský kraj – ověř "state" z adresy (pokud ho Nominatim vrátí)
      const state = String(cand?.address?.state || cand?.address?.region || "");
      if (state && !STC_STATE_ALLOW.test(state)) continue;

      // ✅ poslední brzda: bounding box Středočeského kraje (když state chybí)
      const vb = String(STC_VIEWBOX).split(",").map(x => Number(x));
      if (vb.length === 4 && vb.every(n => Number.isFinite(n))) {
        const [left, top, right, bottom] = vb;
        if (lon < left || lon > right || lat < bottom || lat > top) continue;
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

  const day = String(req.query.day || "today").trim().toLowerCase();
  const month = String(req.query.month || "").trim();

  const types = typeQ ? typeQ.split(",").map(s => s.trim()).filter(Boolean) : [];
  const normStatus = ["all", "open", "closed"].includes(status) ? status : "all";
  const normDay = ["today", "yesterday", "all"].includes(day) ? day : "today";
  const normMonth = /^\d{4}-\d{2}$/.test(month) ? month : "";

  return { types, city, status: normStatus, day: normDay, month: normMonth };
}

// ✅ dopočítávání délky (uložení do DB)
async function backfillDurations(rows, cutoffIso, max = 40) {
  const candidates = rows
    .filter(r => r?.is_closed && r?.end_time_iso && (r.duration_min == null) && (!cutoffIso || (r.first_seen_at && new Date(r.first_seen_at).getTime() >= new Date(cutoffIso).getTime())))
    .slice(0, Math.max(0, Math.min(max, 200)));

  let fixed = 0;

  for (const r of candidates) {
    const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.created_at, cutoffIso);
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

      const startIso = it.startTimeIso || times.startIso || null;
      const endIso = it.endTimeIso || times.endIso || null;
      const isClosed = !!times.isClosed;

      let durationMin = null;
      if (Number.isFinite(it.durationMin)) {
        const candidate = Math.round(it.durationMin);
        durationMin = (candidate > 0 && candidate <= MAX_DURATION_MINUTES) ? candidate : null;
      } else if (isClosed && endIso) {
        const cutoffIso = await getDurationCutoffIso();
        durationMin = await computeDurationMin(it.id, startIso, endIso, null, cutoffIso);
      }

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
        startTimeIso: startIso,
        endTimeIso: endIso,
        durationMin,
        isClosed
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
  const cutoffIso = await getDurationCutoffIso();
  const fixedDur = await backfillDurations(rows, cutoffIso, 80);

  res.json({ ok: true, filters, backfilled_coords: fixedCoords, backfilled_durations: fixedDur, items: rows });
});

// ✅ stats (30 dní) – vždy ze všech dnů (ignoruje filtr "Den")
app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);

  // ✅ klíčová změna: statistika se nikdy nefiltruje podle dne
  const statsFilters = { ...filters, day: "all" };

  const stats = await getStatsFiltered(statsFilters);

  const openCount = stats?.openVsClosed?.open ?? 0;
  const closedCount = stats?.openVsClosed?.closed ?? 0;

  res.json({ ok: true, filters: statsFilters, ...stats, openCount, closedCount });
});

// export CSV
app.get("/api/export.csv", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  const rows = await getEventsFiltered(filters, limit);

  const cutoffIso = await getDurationCutoffIso();
  await backfillDurations(rows, cutoffIso, 500);

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

// export PDF
app.get("/api/export.pdf", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 800), 2000);
  const rows = await getEventsFiltered(filters, limit);

  const cutoffIso = await getDurationCutoffIso();
  await backfillDurations(rows, cutoffIso, 500);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  doc.pipe(res);

  tryApplyPdfFont(doc);

  const now = new Date();
  doc.fontSize(18).fillColor("#000").text("JPO výjezdy – export");
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#333").text(`Vygenerováno: ${now.toLocaleString("cs-CZ")}`);
  doc.moveDown(0.8);

  const col = {
    time: 24,
    state: 155,
    type: 240,
    city: 330,
    dur: 470,
    title: 555
  };

  doc.fontSize(10).fillColor("#000");
  doc.text("Čas", col.time, doc.y);
  doc.text("Stav", col.state, doc.y);
  doc.text("Typ", col.type, doc.y);
  doc.text("Město", col.city, doc.y);
  doc.text("Délka", col.dur, doc.y);
  doc.text("Název", col.title, doc.y);
  doc.moveDown(0.5);
  doc.moveTo(24, doc.y).lineTo(820, doc.y).strokeColor("#ddd").stroke();
  doc.moveDown(0.3);

  const fmt = (v) => {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString("cs-CZ");
  };

  const fmtDur = (m) => {
    if (!Number.isFinite(m) || m <= 0) return "—";
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h <= 0) return `${mm} min`;
    return `${h} h ${mm} min`;
  };

  for (const r of rows) {
    const y = doc.y;

    const time = fmt(r.pub_date || r.created_at);
    const state = r.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(r.event_type || "other");
    const city = r.city_text || r.place_text || "";
    const dur = fmtDur(r.duration_min);
    const title = r.title || "";

    doc.fillColor("#000").text(time, col.time, y, { width: 120 });
    doc.fillColor("#000").text(state, col.state, y, { width: 80 });
    doc.fillColor("#000").text(typ, col.type, y, { width: 85 });
    doc.fillColor("#000").text(city, col.city, y, { width: 130 });
    doc.fillColor("#000").text(dur, col.dur, y, { width: 70 });
    doc.fillColor("#000").text(title, col.title, y, { width: 260 });

    doc.moveDown(0.35);
    doc.moveTo(24, doc.y).lineTo(820, doc.y).strokeColor("#f0f0f0").stroke();
    doc.moveDown(0.25);

    if (doc.y > 560) doc.addPage();
  }

  doc.end();
});

// admin: geocode cache purge + re-geocode
app.post("/api/admin/fix-geocode", requireKey, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "preview");
    const bad = await getEventsOutsideCz(300);

    let cacheDeleted = 0;
    let coordsCleared = 0;
    let reGeocoded = 0;
    let failed = 0;

    for (const r of bad) {
      const q = r.city_text || r.place_text;
      if (!q) continue;

      if (mode !== "preview") {
        await deleteCachedGeocode(q);
        cacheDeleted++;
        await clearEventCoords(r.id);
        coordsCleared++;
      }

      const g = await geocodePlace(q);
      if (g && mode !== "preview") {
        await updateEventCoords(r.id, g.lat, g.lon);
        reGeocoded++;
      } else if (!g) {
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
