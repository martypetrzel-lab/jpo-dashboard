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

// ✅ region filter: default Středočeský kraj
const REGION_FILTER = String(process.env.REGION_FILTER || "stc").trim().toLowerCase();

// ✅ hrubé hranice ČR (bbox) – ochrana proti chybnému geocodu
const CZ_BOUNDS = { minLat: 48.55, maxLat: 51.06, minLon: 12.09, maxLon: 18.87 };

// ✅ hrubé hranice Středočeského kraje (bbox) – doplňkově
const STC_BOUNDS = { minLat: 49.20, maxLat: 50.75, minLon: 13.20, maxLon: 15.80 };

// ✅ okresy Středočeského kraje – hlavní filtr
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

function isAllowedByRegion(descRaw = "") {
  if (REGION_FILTER !== "stc") return true;

  const district = extractDistrictFromDescription(descRaw);
  if (!district) return true;

  return STC_DISTRICTS_NORM.has(normKey(district));
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

  // při region=stc: mimo StČ -> nepoužít
  if (REGION_FILTER === "stc" && !inBounds(lat, lon, STC_BOUNDS)) return null;

  await setCachedGeocode(q, lat, lon);
  return { lat, lon };
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
    const statusNorm = statusText.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const isClosed = statusNorm.includes("ukoncena") || statusNorm.includes("ukonceno") || statusNorm.includes("ukoncen");

    const cityText = extractCityFromDescription(descRaw) || extractCityFromTitle(title) || null;
    const district = extractDistrictFromDescription(descRaw);
    const placeText = district ? `okres ${district}` : null;

    const startIso = (() => {
      const d = new Date(pub_date);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().replace(".000Z", "Z");
    })();

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
      // ✅ end_time_iso z RSS ignorujeme
      end_time_iso: null,
      duration_min: null,
      is_closed: isClosed
    };

    await upsertEvent(row);
    processed++;
    if (isClosed) closedFound++;
  }

  return { ok: true, processed, closed_found: closedFound, skipped_by_region: skippedByRegion };
}

// ---------------- API endpoints ----------

// ingest (data z ESP)
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const { source, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items missing" });
    }

    let accepted = 0;
    let closedSeen = 0;
    let geocoded = 0;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const descRaw = String(it.description_raw || it.descriptionRaw || it.descRaw || it.description || "").trim();

      // ✅ uzavření poznáme podle "stav: ukončená"
      const statusText = String(it.status_text || it.statusText || extractStatusFromDescription(descRaw) || "").trim();
      const statusNorm = statusText.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
      const isClosed = statusNorm.includes("ukoncena") || statusNorm.includes("ukonceno") || statusNorm.includes("ukoncen");

      const eventType = it.event_type || it.eventType || classifyType(it.title);

      const placeText = it.place_text || it.placeText || null;
      const cityFromDesc = extractCityFromDescription(descRaw);
      const cityFromTitle = extractCityFromTitle(it.title);

      const cityText =
        it.city_text ||
        it.cityText ||
        cityFromDesc ||
        (!placeText ? cityFromTitle : (isDistrictPlace(placeText) ? cityFromTitle : placeText)) ||
        null;

      // start_time_iso: ideálně z pubDate; když přijde text ISO, necháme
      const startIso = (() => {
        const raw = it.start_time_iso || it.startTimeIso || null;
        if (raw) return raw;
        const pd = it.pub_date || it.pubDate || null;
        if (!pd) return null;
        const d = new Date(pd);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().replace(".000Z", "Z");
      })();

      const ev = {
        id: String(it.id).trim(),
        title: String(it.title).trim(),
        link: String(it.link).trim(),
        pub_date: it.pub_date || it.pubDate || null,
        place_text: placeText,
        city_text: cityText,
        status_text: statusText || null,
        event_type: eventType,
        description_raw: descRaw || null,
        start_time_iso: startIso,
        // ✅ end_time_iso a duration_min z RSS ignorujeme -> DB nastaví "hned" při přechodu OPEN->CLOSED
        end_time_iso: null,
        duration_min: null,
        is_closed: isClosed
      };

      await upsertEvent(ev);
      accepted++;
      if (isClosed) closedSeen++;

      const geoQuery = cityText || placeText;
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
      closed_seen_in_batch: closedSeen,
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
  res.json({ ok: true, filters, items: rows });
});

// ✅ ADMIN: ruční údržba (pokud by někdy něco chybělo)
app.post("/api/admin/recalc-durations", requireAdminPassword, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(2000, Number(req.body?.limit || 500)));

    // 1) natáhni RSS a projdi poslední položky (detekce uzavření)
    const rss = await rssMaintenanceOnce(250);

    // 2) dopočti případné chybějící duration tam, kde už máme end_time_iso + closed_detected_at
    const missing = await getClosedEventsMissingDuration(limit);
    let fixed = 0;

    for (const ev of missing) {
      const startIso = ev.start_time_iso;
      const endIso = ev.end_time_iso;
      if (!startIso || !endIso) continue;

      const a = new Date(startIso).getTime();
      const b = new Date(endIso).getTime();
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;

      const dur = Math.round((b - a) / 60000);
      if (!Number.isFinite(dur) || dur <= 0) continue;

      await updateEventDuration(ev.id, endIso, dur);
      fixed++;
    }

    res.json({ ok: true, rss, durations: { fixed, checked: missing.length } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

// ---- start ----
const PORT = process.env.PORT || 8080;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log("listening on " + PORT));
  })
  .catch((e) => {
    console.error("initDb failed:", e);
    process.exit(1);
  });

// ✅ RSS poll (server-side)
setInterval(async () => {
  try {
    await rssMaintenanceOnce(250);
  } catch (e) {
    console.error("rss poll error:", e);
  }
}, RSS_POLL_MS);