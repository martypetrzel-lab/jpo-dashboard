import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

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
  getClosedEventsMissingDuration
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.7 (contact: missing)";

// RSS pro kontrolu ukončení (server-side)
const RSS_URL = process.env.RSS_URL || "";
const RSS_POLL_MS = Math.max(30_000, Number(process.env.RSS_POLL_MS || 5 * 60 * 1000)); // default 5 min

// ✅ region filter: "cz" (default) nebo "stc"
const REGION_FILTER = String(process.env.REGION_FILTER || "cz").trim().toLowerCase();

// ✅ sanity limit pro délku zásahu (default 3 dny)
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny
const FUTURE_END_TOLERANCE_MS = 5 * 60 * 1000; // ukončení nesmí být "v budoucnu" o víc než 5 min

// ✅ hrubé hranice ČR (bbox) – ochrana proti chybnému geocodu
const CZ_BOUNDS = { minLat: 48.55, maxLat: 51.06, minLon: 12.09, maxLon: 18.87 };

// ✅ hrubé hranice Středočeského kraje (bbox) – jen doplňkově
// (je to schválně širší, aby se nic důležitého “neuseklo”)
const STC_BOUNDS = { minLat: 49.20, maxLat: 50.75, minLon: 13.20, maxLon: 15.80 };

// ✅ okresy Středočeského kraje – hlavní filtr (podle RSS "okres ...")
const STC_DISTRICTS = new Set([
  "Benešov",
  "Beroun",
  "Kladno",
  "Kolín",
  "Kutná Hora",
  "Mělník",
  "Mladá Boleslav",
  "Nymburk",
  "Praha východ",
  "Praha-východ",
  "Praha západ",
  "Praha-západ",
  "Příbram",
  "Rakovník"
]);

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

/**
 * RSS description často obsahuje "stav: ...&lt;br&gt;ukončení: ..."
 * Musíme nejdřív dekódovat entity a až pak převést <br> na \n
 */
function normalizeDesc(descRaw = "") {
  if (!descRaw) return "";
  return String(descRaw)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

function extractDistrictFromDescription(descRaw = "") {
  const norm = normalizeDesc(descRaw);
  if (!norm) return null;
  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^\s*okres\s+(.+)\s*$/i);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function isAllowedByRegion(descRaw = "") {
  // default: CZ = nic nevyhazujeme podle okresu, jen ohlídáme souřadnice geocodem
  if (REGION_FILTER !== "stc") return true;

  const district = extractDistrictFromDescription(descRaw);
  if (!district) return true; // když okres chybí, raději nevyhazuj (necháme projít)

  // normalizace (Praha Západ / Praha-západ apod.)
  const d = district
    .replace(/\s+/g, " ")
    .replace(/–/g, "-")
    .trim();

  return STC_DISTRICTS.has(d);
}

function extractCityFromDescription(descRaw = "") {
  const norm = normalizeDesc(descRaw);
  if (!norm) return null;

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

function extractStatusFromDescription(descRaw = "") {
  const norm = normalizeDesc(descRaw);
  if (!norm) return null;

  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const n = line.toLowerCase().trim();
    if (n.startsWith("stav:")) return line.split(":").slice(1).join(":").trim() || null;
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
  if (!norm) return { startIso: null, endIso: null, isClosed: false };

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
    // ✅ cache taky hlídáme
    if (!inBounds(cached.lat, cached.lon, CZ_BOUNDS)) return null;
    if (REGION_FILTER === "stc" && !inBounds(cached.lat, cached.lon, STC_BOUNDS)) return null;
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

    // ✅ omez na ČR už u dotazu
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

      // ✅ tvrdá kontrola ČR bounds (řeší Polsko apod.)
      if (!inBounds(lat, lon, CZ_BOUNDS)) continue;

      // ✅ pokud chceš StČ, tak i bbox StČ
      if (REGION_FILTER === "stc" && !inBounds(lat, lon, STC_BOUNDS)) continue;

      const cc = String(cand?.address?.country_code || "").toLowerCase();
      if (cc && cc !== "cz") continue;

      await setCachedGeocode(placeText, lat, lon);
      return { lat, lon, cached: false, qUsed: q };
    }
  }

  return null;
}

function parseFilters(req) {
  const day = String(req.query.day || "today").trim().toLowerCase();
  const typeQ = String(req.query.type || "").trim();
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").trim().toLowerCase();
  const month = String(req.query.month || "").trim();

  const types = typeQ ? typeQ.split(",").map(s => s.trim()).filter(Boolean) : [];
  const normStatus = ["all", "open", "closed"].includes(status) ? status : "all";
  const normDay = ["today", "yesterday", "all"].includes(day) ? day : "today";
  const normMonth = /^\d{4}-\d{2}$/.test(month) ? month : "";

  return { types, city, status: normStatus, day: normDay, month: normMonth };
}

// ✅ dopočítávání délky (uložení do DB) – jen pro řádky, co zrovna posíláme ven
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

// ✅ Zpětné dopočítání délky zásahu i mimo aktuální filtr (historie)
async function durationMaintenance(limit = 300) {
  const missing = await getClosedEventsMissingDuration(Math.max(1, Math.min(limit, 500)));
  let fixed = 0;
  for (const r of missing) {
    const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.created_at);
    if (Number.isFinite(dur) && dur > 0) {
      await updateEventDuration(r.id, dur);
      fixed++;
    }
  }
  return { checked: missing.length, fixed };
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

// ---------------- RSS MAINTENANCE ----------------
const rssParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true
});

function arrify(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function rssMaintenanceOnce() {
  if (!RSS_URL) return { ok: false, reason: "RSS_URL not set", processed: 0, closed_found: 0, skipped_by_region: 0 };

  let xml = "";
  try {
    const r = await fetch(RSS_URL, { headers: { "User-Agent": "jpo-dashboard-rss/1.0" } });
    if (!r.ok) return { ok: false, reason: `RSS HTTP ${r.status}`, processed: 0, closed_found: 0, skipped_by_region: 0 };
    xml = await r.text();
  } catch (e) {
    return { ok: false, reason: `RSS fetch failed: ${e?.message || e}`, processed: 0, closed_found: 0, skipped_by_region: 0 };
  }

  let parsed;
  try {
    parsed = rssParser.parse(xml);
  } catch (e) {
    return { ok: false, reason: `RSS parse failed: ${e?.message || e}`, processed: 0, closed_found: 0, skipped_by_region: 0 };
  }

  const channel = parsed?.rss?.channel;
  const items = arrify(channel?.item);

  let processed = 0;
  let closedFound = 0;
  let skippedByRegion = 0;

  for (const it of items) {
    const title = String(it?.title || "").trim();
    const link = String(it?.link || "").trim();
    const guid = String(it?.guid || "").trim();
    const desc = String(it?.description || "").trim();
    const pubDate = String(it?.pubDate || "").trim();

    if (!title || !link) continue;

    // ✅ region gate (StČ podle okresu)
    if (!isAllowedByRegion(desc)) {
      skippedByRegion++;
      continue;
    }

    const id = guid || link;

    const eventType = classifyType(title);
    const times = parseTimesFromDescription(desc);

    const startIso = times.startIso || null;
    const endIso = times.endIso || null;
    const isClosed = !!times.isClosed;

    let durationMin = null;
    if (isClosed && endIso) {
      durationMin = await computeDurationMin(id, startIso, endIso, null);
    }

    const placeText = null;
    const cityFromDesc = extractCityFromDescription(desc);
    const cityFromTitle = extractCityFromTitle(title);

    const cityText =
      cityFromDesc ||
      (!placeText ? cityFromTitle : (isDistrictPlace(placeText) ? cityFromTitle : placeText)) ||
      null;

    const statusText = extractStatusFromDescription(desc);

    const ev = {
      id,
      title,
      link,
      pubDate: pubDate || null,
      placeText,
      cityText,
      statusText: statusText || null,
      eventType,
      descriptionRaw: desc || null,
      startTimeIso: startIso,
      endTimeIso: endIso,
      durationMin,
      isClosed
    };

    await upsertEvent(ev);
    processed++;

    if (ev.isClosed) closedFound++;
  }

  return { ok: true, processed, closed_found: closedFound, skipped_by_region: skippedByRegion };
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
    let skippedByRegion = 0;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";

      // ✅ region gate (StČ podle okresu)
      if (!isAllowedByRegion(desc)) {
        skippedByRegion++;
        continue;
      }

      const times = parseTimesFromDescription(desc);

      const startIso = it.startTimeIso || times.startIso || null;
      const endIso = it.endTimeIso || times.endIso || null;
      const isClosed = !!times.isClosed;

      let durationMin = null;
      if (Number.isFinite(it.durationMin)) {
        const candidate = Math.round(it.durationMin);
        durationMin = (candidate > 0 && candidate <= MAX_DURATION_MINUTES) ? candidate : null;
      } else if (isClosed && endIso) {
        durationMin = await computeDurationMin(it.id, startIso, endIso, null);
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
        statusText: it.statusText || extractStatusFromDescription(desc) || null,
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
      skipped_by_region: skippedByRegion,
      closed_seen_in_batch: updatedClosed,
      geocoded,
      region_filter: REGION_FILTER
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// ✅ ADMIN: ruční přepočet délek (heslo)
app.post("/api/admin/recalc-durations", requireAdminPassword, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 500), 5000));

    const rss = await rssMaintenanceOnce();
    const dur = await durationMaintenance(limit);

    res.json({
      ok: true,
      region_filter: REGION_FILTER,
      rss,
      durations: dur
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

  res.json({
    ok: true,
    region_filter: REGION_FILTER,
    filters,
    backfilled_coords: fixedCoords,
    backfilled_durations: fixedDur,
    items: rows
  });
});

// ✅ stats (30 dní) – vždy ze všech dnů (ignoruje filtr "Den")
app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);
  const statsFilters = { ...filters, day: "all" };

  const stats = await getStatsFiltered(statsFilters);

  const openCount = stats?.openVsClosed?.open ?? 0;
  const closedCount = stats?.openVsClosed?.closed ?? 0;

  res.json({ ok: true, region_filter: REGION_FILTER, filters: statsFilters, ...stats, openCount, closedCount });
});

// export CSV
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

// export PDF (beze změn logiky)
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
    y += 8;
    if (font.ok) doc.font("CZ");
  }

  function rowHeightFor(rowObj) {
    doc.fontSize(9);
    const d = new Date(rowObj.pub_date || rowObj.created_at);
    const timeText = Number.isNaN(d.getTime()) ? String(rowObj.pub_date || rowObj.created_at || "") : d.toLocaleString("cs-CZ");
    const state = rowObj.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(rowObj.event_type || "other");
    const city = String(rowObj.city_text || rowObj.place_text || "");
    const dur = Number.isFinite(rowObj.duration_min) ? `${rowObj.duration_min} min` : "—";
    const ttl = String(rowObj.title || "");
    const opts = { align: "left", lineBreak: true };

    const h = Math.max(
      doc.heightOfString(timeText, { width: col.time, ...opts }),
      doc.heightOfString(state, { width: col.state, ...opts }),
      doc.heightOfString(typ, { width: col.type, ...opts }),
      doc.heightOfString(city, { width: col.city, ...opts }),
      doc.heightOfString(dur, { width: col.dur, ...opts }),
      doc.heightOfString(ttl, { width: col.title, ...opts })
    );
    return Math.max(14, Math.ceil(h) + 4);
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

  const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 18;

  drawHeader();

  for (const r of rows) {
    const h = rowHeightFor(r);
    if (y + h > bottomLimit()) {
      doc.addPage({ size: "A4", layout: "landscape", margin: 24 });
      y = doc.y;
      drawHeader();
    }
    drawRow(r);
    y += h;
  }

  doc.fontSize(9).fillColor("#444").text(`Záznamů: ${rows.length}`, startX, y + 10);
  doc.end();
});

// admin: re-geocode mimo ČR (ponecháno)
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

// Po startu: 1) zkus RSS sync (pokud nastaven), 2) dopočítej chybějící délky
rssMaintenanceOnce()
  .then((r) => {
    if (r.ok) console.log(`[rss] processed=${r.processed} closed_found=${r.closed_found} skipped_by_region=${r.skipped_by_region}`);
    else console.log(`[rss] skipped: ${r.reason}`);
  })
  .catch((e) => console.warn("[rss] failed", e?.message || e));

durationMaintenance(500)
  .then((r) => {
    if (r.fixed > 0) console.log(`[dur-maint] fixed=${r.fixed} checked=${r.checked}`);
  })
  .catch((e) => console.warn("[dur-maint] failed", e?.message || e));

// ✅ Každých 5 minut: prohledej RSS a doplň ukončení (a tím i délku)
setInterval(() => {
  rssMaintenanceOnce()
    .then(async (r) => {
      if (r.ok) {
        if (r.closed_found > 0 || r.skipped_by_region > 0) {
          console.log(`[rss] processed=${r.processed} closed_found=${r.closed_found} skipped_by_region=${r.skipped_by_region}`);
        }
        const d = await durationMaintenance(500);
        if (d.fixed > 0) console.log(`[dur-maint] fixed=${d.fixed} checked=${d.checked}`);
      } else {
        console.log(`[rss] skipped: ${r.reason}`);
      }
    })
    .catch((e) => console.warn("[rss] failed", e?.message || e));
}, RSS_POLL_MS);

app.listen(port, () => console.log(`listening on ${port}`));
