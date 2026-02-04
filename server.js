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

// ✅ region filter: vždy Středočeský kraj (API vrací jen StČ)
// Pozn.: můžeš přepsat env REGION_FILTER, ale default je "stc".
const REGION_FILTER = String(process.env.REGION_FILTER || "stc").trim().toLowerCase();

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

function normKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .replace(/–/g, "-");
}

const STC_DISTRICTS_NORM = new Set(Array.from(STC_DISTRICTS).map(normKey));

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
  if (REGION_FILTER !== "stc") return true;

  const district = extractDistrictFromDescription(descRaw);
  if (!district) return true;

  return STC_DISTRICTS_NORM.has(normKey(district));
}

function isRowAllowedByRegion(row) {
  if (REGION_FILTER !== "stc") return true;

  const desc = String(row?.description_raw || "");
  const district = extractDistrictFromDescription(desc);
  if (district) {
    return STC_DISTRICTS_NORM.has(normKey(district));
  }

  if (typeof row?.lat === "number" && typeof row?.lon === "number") {
    return inBounds(row.lat, row.lon, STC_BOUNDS);
  }

  return true;
}

// ✅ Historické ukončené zásahy (z doby před nasazením) mají closed_detected_at = NULL.
// Tyto NESMÍ ukazovat délku (jinak vznikají extrémy při refreshi).
function maskDurationForHistory(row) {
  if (row?.is_closed && !row?.closed_detected_at) {
    row.duration_min = null;
  }
  return row;
}

function computeStatsFromRows(rows) {
  const now = Date.now();
  const sinceMs = now - 30 * 24 * 60 * 60 * 1000;

  const inWindow = rows.filter(r => {
    const t = new Date(r.created_at || r.pub_date || r.first_seen_at || r.last_seen_at || 0).getTime();
    return Number.isFinite(t) && t >= sinceMs;
  });

  const byDayMap = new Map();
  const byTypeMap = new Map();
  const cityMap = new Map();
  let open = 0;
  let closed = 0;

  for (const r of inWindow) {
    const startCandidate = r.start_time_iso || r.created_at || r.pub_date;
    const d = new Date(startCandidate || 0);
    const dayKey = Number.isNaN(d.getTime())
      ? "unknown"
      : new Date(d.toLocaleString("en-US", { timeZone: "Europe/Prague" })).toISOString().slice(0, 10);

    byDayMap.set(dayKey, (byDayMap.get(dayKey) || 0) + 1);

    const typ = r.event_type || "other";
    byTypeMap.set(typ, (byTypeMap.get(typ) || 0) + 1);

    const city = String(r.city_text || r.place_text || "(neznámé)").trim() || "(neznámé)";
    cityMap.set(city, (cityMap.get(city) || 0) + 1);

    if (r.is_closed) closed++;
    else open++;
  }

  const byDay = Array.from(byDayMap.entries())
    .filter(([k]) => k !== "unknown")
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, count]) => ({ day, count }));

  const byType = Array.from(byTypeMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  const topCities = Array.from(cityMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([city, count]) => ({ city, count }));

  // Nejdelší: jen záznamy, které byly ukončené po nasazení (closed_detected_at != null)
  const longest = inWindow
    .filter(r => r.is_closed && r.closed_detected_at && Number.isFinite(r.duration_min) && r.duration_min > 0)
    .sort((a, b) => b.duration_min - a.duration_min)
    .slice(0, 12)
    .map(r => ({
      id: r.id,
      title: r.title,
      link: r.link,
      duration_min: r.duration_min,
      city_text: r.city_text,
      place_text: r.place_text
    }));

  return { byDay, byType, topCities, openCount: open, closedCount: closed, longest };
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

  // Čas je lokální (CZ), převedeme do UTC ISO
  const dt = new Date(Date.UTC(year, month - 1, day, hh - 1, mm, 0)); // +01:00 zhruba, pro stabilitu
  if (Number.isNaN(dt.getTime())) return null;

  return dt.toISOString().replace(".000Z", "Z");
}

function extractEndTimeIsoFromDescription(descRaw = "") {
  const norm = normalizeDesc(descRaw);
  if (!norm) return null;
  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const low = line
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

    if (low.startsWith("ukonceni:")) {
      const val = line.split(":").slice(1).join(":").trim();
      const iso = parseCzDateToIso(val);
      if (iso) return iso;
    }
  }
  return null;
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

function parseFilters(req) {
  return {
    day: String(req.query.day || "today"),
    type: String(req.query.type || ""),
    city: String(req.query.city || ""),
    status: String(req.query.status || "all"),
    month: String(req.query.month || "")
  };
}

// ---------------- GEOCODE (OSM Nominatim) ----------------
async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": GEOCODE_UA,
      "Accept": "application/json"
    }
  });
  if (!r.ok) return null;
  return await r.json();
}

async function geocodePlace(q) {
  if (!q) return null;

  // cache
  const cached = await getCachedGeocode(q);
  if (cached && typeof cached.lat === "number" && typeof cached.lon === "number") {
    // sanity check: cache mimo ČR pryč
    if (!inBounds(cached.lat, cached.lon, CZ_BOUNDS)) {
      await deleteCachedGeocode(q);
    } else {
      // při region=stc: cache mimo StČ raději také smaž, aby se to nevracelo
      if (REGION_FILTER === "stc" && !inBounds(cached.lat, cached.lon, STC_BOUNDS)) {
        await deleteCachedGeocode(q);
      } else {
        return cached;
      }
    }
  }

  const base = "https://nominatim.openstreetmap.org/search";
  const url = `${base}?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q + ", Czechia")}`;
  const j = await fetchJson(url);
  if (!j || !Array.isArray(j) || j.length === 0) return null;

  const item = j[0];
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // sanity check: mimo ČR -> nepoužít
  if (!inBounds(lat, lon, CZ_BOUNDS)) return null;

  // při region=stc: mimo StČ -> nepoužít (ať se do mapy nic cizího nedostane)
  if (REGION_FILTER === "stc" && !inBounds(lat, lon, STC_BOUNDS)) return null;

  await setCachedGeocode(q, lat, lon);

  return { lat, lon };
}

// ---------------- DURATIONS ----------------
function minutesBetweenIso(startIso, endIso) {
  const a = new Date(startIso);
  const b = new Date(endIso);
  const ta = a.getTime();
  const tb = b.getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  const diffMin = Math.round((tb - ta) / 60000);
  if (diffMin <= 0) return null;
  if (diffMin > MAX_DURATION_MINUTES) return null;
  return diffMin;
}

// Uživatelem požadovaná logika:
// - RSS z ESP často má špatné "ukončení" (budoucnost)
// - Jakmile server poprvé uvidí "stav: ukončená", nastaví konec = NOW (UTC) a uloží closed_detected_at
// - Délka se pak počítá z start_time_iso (z pubDate / start) do end_time_iso (NOW při detekci)
async function maybeCloseEventByServer(evId, startIso, descRaw) {
  if (!evId) return { changed: false };

  const status = extractStatusFromDescription(descRaw) || "";
  const statusNorm = status.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const isClosedNow = statusNorm.includes("ukoncena") || statusNorm.includes("ukonceno") || statusNorm.includes("ukončená") || statusNorm.includes("ukončen");

  if (!isClosedNow) return { changed: false };

  // pokud už bylo někdy ukončeno, necháme DB logiku (is_closed OR) + end_time přidělený při prvním přechodu
  // jen dopočítáme duration, pokud chybí a máme end_time_iso
  const firstSeen = await getEventFirstSeen(evId);
  if (!firstSeen) return { changed: false };

  // pokud startIso chybí, vezmi z DB
  const start = startIso || firstSeen.start_time_iso || firstSeen.pub_date;
  if (!start) return { changed: false };

  // pokud DB ještě nemá end_time_iso, nastaví se v upsertEvent SQL při přechodu is_closed false->true (NOW)
  // my tady jen vrátíme indikaci, že je uzavřené
  return { changed: true, shouldBeClosed: true, start };
}

async function durationMaintenance(limit = 500) {
  const missing = await getClosedEventsMissingDuration(limit);
  let fixed = 0;
  let checked = 0;

  for (const ev of missing) {
    checked++;

    if (!ev?.closed_detected_at) {
      // historické ukončené před nasazením – nemají mít duration
      continue;
    }

    // pokud end_time_iso chybí, zkus NOW (ale jen pokud už jsou uzavřené a close_detected_at existuje)
    let endIso = ev.end_time_iso;
    if (!endIso) {
      endIso = new Date().toISOString().replace(".000Z", "Z");
    } else {
      // pokud je end_time v budoucnu (kvůli špatnému RSS), ignoruj a použij NOW
      const endMs = new Date(endIso).getTime();
      const nowMs = Date.now();
      if (Number.isFinite(endMs) && endMs > nowMs + FUTURE_END_TOLERANCE_MS) {
        endIso = new Date().toISOString().replace(".000Z", "Z");
      }
    }

    const durMin = minutesBetweenIso(ev.start_time_iso || ev.pub_date, endIso);
    if (!durMin) continue;

    await updateEventDuration(ev.id, endIso, durMin);
    fixed++;
  }

  return { ok: true, fixed, checked };
}

async function backfillDurations(rows, limit = 80) {
  let fixed = 0;
  const slice = rows
    .filter(r => r?.is_closed && r?.closed_detected_at && (!Number.isFinite(r.duration_min) || r.duration_min <= 0))
    .slice(0, limit);

  for (const r of slice) {
    const startIso = r.start_time_iso || r.pub_date;
    if (!startIso) continue;

    const endIso = r.end_time_iso || new Date().toISOString().replace(".000Z", "Z");
    const durMin = minutesBetweenIso(startIso, endIso);
    if (!durMin) continue;

    await updateEventDuration(r.id, endIso, durMin);
    r.end_time_iso = endIso;
    r.duration_min = durMin;
    fixed++;
  }

  return fixed;
}

async function backfillCoords(rows, limit = 8) {
  let fixed = 0;
  const slice = rows
    .filter(r => (r.lat == null || r.lon == null))
    .slice(0, limit);

  for (const r of slice) {
    // prefer city_text, then place_text
    const q = (r.city_text && String(r.city_text).trim()) ? r.city_text : r.place_text;
    if (!q) continue;

    const g = await geocodePlace(q);
    if (!g) continue;

    await updateEventCoords(r.id, g.lat, g.lon);
    r.lat = g.lat;
    r.lon = g.lon;
    fixed++;
  }
  return fixed;
}

// ---------------- RSS maintenance ----------------
async function rssFetchItems() {
  if (!RSS_URL) return [];
  const r = await fetch(RSS_URL, { headers: { "User-Agent": "jpo-dashboard/rss-maint" } });
  if (!r.ok) return [];
  const xml = await r.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const j = parser.parse(xml);
  const items = j?.rss?.channel?.item;
  if (!items) return [];
  if (Array.isArray(items)) return items;
  return [items];
}

async function rssMaintenanceOnce(limit = 250) {
  if (!RSS_URL) return { ok: false, reason: "RSS_URL not set" };

  const items = await rssFetchItems();
  const slice = items.slice(0, limit);

  let processed = 0;
  let closedFound = 0;
  let skippedByRegion = 0;

  for (const it of slice) {
    const id = String(it.guid || it.id || it.link || it.title || "").trim();
    if (!id) continue;

    const title = String(it.title || "").trim();
    const link = String(it.link || "").trim();
    const pub_date = String(it.pubDate || it.pub_date || "").trim();
    const descRaw = String(it.description || "").trim();

    if (REGION_FILTER === "stc" && !isAllowedByRegion(descRaw)) {
      skippedByRegion++;
      continue;
    }

    const eventType = classifyType(title);
    const statusText = extractStatusFromDescription(descRaw) || "";
    const cityText = extractCityFromDescription(descRaw) || extractCityFromTitle(title) || null;
    const placeText = extractDistrictFromDescription(descRaw) ? `okres ${extractDistrictFromDescription(descRaw)}` : null;

    // start time (z pubDate)
    const startIso = (() => {
      const d = new Date(pub_date);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().replace(".000Z", "Z");
    })();

    // status: ukončeno?
    const maybe = await maybeCloseEventByServer(id, startIso, descRaw);
    const isClosed = Boolean(maybe?.shouldBeClosed);

    const row = {
      id,
      title,
      link,
      pub_date: pub_date || null,
      place_text: placeText,
      city_text: cityText,
      status_text: statusText,
      event_type: eventType,
      description_raw: descRaw,
      start_time_iso: startIso,
      end_time_iso: null,        // záměrně: ignorujeme RSS "ukončení" protože bývá špatně
      duration_min: null,
      is_closed: isClosed
    };

    await upsertEvent(row);

    processed++;
    if (isClosed) closedFound++;
  }

  return { ok: true, processed, closed_found: closedFound, skipped_by_region: skippedByRegion };
}

// ---------------- PDF font helper ----------------
// ✅ Použije assets/DejaVuSans.ttf a hlavně nastaví font hned po vytvoření doc (aby diakritika fungovala všude)
function tryApplyPdfFont(doc) {
  try {
    const f = path.join(__dirname, "assets", "DejaVuSans.ttf");
    if (fs.existsSync(f)) {
      doc.registerFont("CZ", f);
      // ⚠️ Nevolat doc.font("CZ") tady je taky OK, ale my to stejně nastavíme hned po vytvoření dokumentu.
      // Pro jistotu to nastavíme i zde, ať se font použije okamžitě.
      doc.font("CZ");
      return { ok: true };
    }
    return { ok: false, reason: `font file not found: ${f}` };
  } catch (e) {
    return { ok: false, reason: e?.message || "font error" };
  }
}

// ---------------- API endpoints ----------------

// ingest: ESP → server (batch)
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const safe = items.slice(0, 120);

    let inserted = 0;
    let updated = 0;
    let skippedRegion = 0;
    let skippedOutside = 0;

    for (const it of safe) {
      const id = String(it.id || "").trim();
      if (!id) continue;

      const title = String(it.title || "").trim();
      const link = String(it.link || "").trim();
      const pub_date = String(it.pub_date || "").trim();
      const descRaw = String(it.description_raw || it.description || "").trim();

      if (REGION_FILTER === "stc" && !isAllowedByRegion(descRaw)) {
        skippedRegion++;
        continue;
      }

      const statusText = String(it.status_text || extractStatusFromDescription(descRaw) || "").trim();
      const eventType = String(it.event_type || classifyType(title) || "other").trim();

      const cityText = String(it.city_text || extractCityFromDescription(descRaw) || extractCityFromTitle(title) || "").trim() || null;
      const placeText = String(it.place_text || (extractDistrictFromDescription(descRaw) ? `okres ${extractDistrictFromDescription(descRaw)}` : "")).trim() || null;

      const startIso = String(it.start_time_iso || "").trim() || (() => {
        const d = new Date(pub_date);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().replace(".000Z", "Z");
      })();

      // ✅ ukončení řeší server až při detekci "stav: ukončená"
      const maybe = await maybeCloseEventByServer(id, startIso, descRaw);
      const isClosed = Boolean(maybe?.shouldBeClosed);

      const row = {
        id,
        title,
        link,
        pub_date: pub_date || null,
        place_text: placeText,
        city_text: cityText,
        status_text: statusText,
        event_type: eventType,
        description_raw: descRaw,
        start_time_iso: startIso,
        end_time_iso: null,
        duration_min: null,
        is_closed: isClosed
      };

      const r = await upsertEvent(row);
      if (r?.inserted) inserted++;
      else updated++;

      // coords sanity: pokud existují a jsou mimo ČR (nebo mimo StČ), rovnou je smaž
      if (typeof it.lat === "number" && typeof it.lon === "number") {
        const okCz = inBounds(it.lat, it.lon, CZ_BOUNDS);
        const okStc = (REGION_FILTER !== "stc") ? true : inBounds(it.lat, it.lon, STC_BOUNDS);
        if (!okCz || !okStc) {
          await clearEventCoords(id);
          skippedOutside++;
        } else {
          await updateEventCoords(id, it.lat, it.lon);
        }
      }
    }

    res.json({ ok: true, inserted, updated, skipped_region: skippedRegion, skipped_outside: skippedOutside });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// admin: ruční přepočet délek přes heslo (spustí RSS scan + duration maintenance)
app.post("/api/admin/recalc-durations", requireAdminPassword, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 2000), 5000));

    const rss = await rssMaintenanceOnce(limit);
    const durations = await durationMaintenance(2000);

    res.json({ ok: true, rss, durations });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// list events
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);

  const rawRows = await getEventsFiltered(filters, limit);
  const rows = rawRows
    .filter(isRowAllowedByRegion)
    .map(maskDurationForHistory);

  const fixedCoords = await backfillCoords(rows, 8);
  const fixedDur = await backfillDurations(rows, 80);

  // ✅ ochrana proti špatnému geocodu: co je mimo ČR (resp. mimo StČ při REGION_FILTER=stc),
  // neposílej na frontend a rovnou smaž z DB, aby se to nevracelo do mapy.
  let clearedOutside = 0;
  for (const r of rows) {
    if (typeof r?.lat !== "number" || typeof r?.lon !== "number") continue;
    const okCz = inBounds(r.lat, r.lon, CZ_BOUNDS);
    const okStc = (REGION_FILTER !== "stc") ? true : inBounds(r.lat, r.lon, STC_BOUNDS);
    if (!okCz || !okStc) {
      // eslint-disable-next-line no-await-in-loop
      await clearEventCoords(r.id);
      r.lat = null;
      r.lon = null;
      clearedOutside++;
    }
  }

  res.json({
    ok: true,
    region_filter: REGION_FILTER,
    filters,
    filtered_out: Math.max(0, rawRows.length - rows.length),
    backfilled_coords: fixedCoords,
    backfilled_durations: fixedDur,
    cleared_outside_coords: clearedOutside,
    items: rows
  });
});

// ✅ stats (30 dní) – vždy ze všech dnů (ignoruje filtr "Den")
app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);
  const statsFilters = { ...filters, day: "all" };

  // bere data z DB, ale finální statistiky počítá na serveru
  // (kvůli region filtru StČ + maskování historických zásahů)
  const rawRows = await getEventsFiltered(statsFilters, 5000);
  const rows = rawRows
    .filter(isRowAllowedByRegion)
    .map(maskDurationForHistory);

  const stats = computeStatsFromRows(rows);

  res.json({ ok: true, region_filter: REGION_FILTER, filters: statsFilters, ...stats });
});

// export CSV
app.get("/api/export.csv", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  const rawRows = await getEventsFiltered(filters, limit);
  const rows = rawRows
    .filter(isRowAllowedByRegion)
    .map(maskDurationForHistory);

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
  const rawRows = await getEventsFiltered(filters, limit);
  const rows = rawRows
    .filter(isRowAllowedByRegion)
    .map(maskDurationForHistory);

  await backfillDurations(rows, 500);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  doc.pipe(res);

  // ✅ Font nastav hned po vytvoření dokumentu, ještě před prvním textem
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
    // ✅ pro jistotu vždy drž CZ font i v headeru
    if (font.ok) doc.font("CZ");

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

  function rowHeightFor(rowObj) {
    if (font.ok) doc.font("CZ");
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
    if (font.ok) doc.font("CZ");
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

  if (font.ok) doc.font("CZ");
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
app.listen(port, () => console.log(`listening on ${port}`));