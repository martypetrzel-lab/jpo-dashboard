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
  getEventMeta,
  updateEventDuration,
  getDurationCutoffIso,
  getLongestCutoffIso
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

function extractDistrictFromDescription(descRaw = "") {
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

    if (low.startsWith("okres ")) {
      const district = line.replace(/^\s*okres\s+/i, "").trim();
      return district || null;
    }
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

    // ✅ některé RSS mají jen "stav: ukončená" bez řádku "ukončení: ..."
    if (n.startsWith("stav:") && (n.includes("ukoncena") || n.includes("ukonceni") || n.includes("ukoncen"))) {
      isClosed = true;
    }

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

// ✅ záloha: když se z nějakého důvodu nepodaří vyčíst uzavření z descriptionRaw,
// použij statusText, který posílá ESP (např. "ukončená")
function isClosedFromStatusText(statusText = "") {
  const n = String(statusText || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  // ukoncena / ukonceni / ukonceno / ukončená...
  return n.includes("ukon");
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

  if (!Number.isFinite(startMs)) return null;

  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(endMs)) return null;

  // ✅ ukončení nesmí být v budoucnu (kromě tolerance)
  if (endMs > nowMs + FUTURE_END_TOLERANCE_MS) return null;

  let minutes = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;

  if (minutes > MAX_DURATION_MINUTES) return null;
  return minutes;
}

// ---------------- GEOCODE ----------------
async function geocodePlace(placeText) {
  if (!placeText) return null;

  // cache
  const cached = await getCachedGeocode(placeText);
  if (cached?.lat && cached?.lon) return cached;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", placeText);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");

  // ✅ viewbox pro Středočeský kraj (omezí falešné shody)
  url.searchParams.set("viewbox", STC_VIEWBOX);
  url.searchParams.set("bounded", "1");

  const resp = await fetch(url.toString(), {
    headers: {
      "User-Agent": GEOCODE_UA
    }
  });

  if (!resp.ok) return null;
  const arr = await resp.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const it = arr[0];
  const lat = Number(it.lat);
  const lon = Number(it.lon);

  // ✅ filtr: musí to být CZ + ideálně Středočeský kraj
  const addr = it.address || {};
  const countryCode = String(addr.country_code || "").toLowerCase();
  if (countryCode && countryCode !== "cz") return null;

  const state = String(addr.state || "");
  if (state && !STC_STATE_ALLOW.test(state)) {
    // necháme projít, ale jen pokud je ve viewboxu; bounded by měl stačit
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  await setCachedGeocode(placeText, lat, lon);
  return { lat, lon };
}

// ---------------- FILTERS ----------------
function parseFilters(req) {
  const day = String(req.query.day || "today");
  const type = String(req.query.type || "all");
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all");
  const month = String(req.query.month || "all");

  return { day, type, city, status, month };
}

// ---------------- COORDS BACKFILL ----------------
async function backfillCoords(rows, limit = 10) {
  let fixed = 0;
  for (const r of rows) {
    if (fixed >= limit) break;
    if (r.lat && r.lon) continue;

    // smaž cache pro nesmysly mimo ČR (historie)
    if (r.city_text) {
      const cached = await getCachedGeocode(r.city_text);
      if (cached && (cached.lat < 48 || cached.lat > 51.2 || cached.lon < 12 || cached.lon > 19)) {
        await deleteCachedGeocode(r.city_text);
      }
    }

    const queries = [];
    if (r.city_text && r.district_text) queries.push(`${r.city_text}, okres ${r.district_text}`);
    if (r.city_text) queries.push(r.city_text);
    if (r.place_text && r.place_text !== r.city_text) queries.push(r.place_text);

    for (const q of queries) {
      const g = await geocodePlace(q);
      if (g) {
        await updateEventCoords(r.id, g.lat, g.lon);
        fixed++;
        break;
      }
    }
  }
  return fixed;
}

async function backfillDurations(rows, cutoffIso, limit = 20) {
  let fixed = 0;
  for (const r of rows) {
    if (fixed >= limit) break;
    if (!r.is_closed) continue;
    if (r.duration_min != null) continue;

    const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.first_seen_at, cutoffIso);
    if (dur != null) {
      await updateEventDuration(r.id, dur);
      fixed++;
    }
  }
  return fixed;
}

// ---------------- PDF EXPORT ----------------
function typeLabel(t) {
  const map = {
    fire: "požár",
    traffic: "nehoda",
    tech: "technická",
    rescue: "záchrana",
    false_alarm: "planý poplach",
    other: "jiné"
  };
  return map[t] || t || "jiné";
}

app.get("/api/export.pdf", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);
  const rows = await getEventsFiltered(filters, limit);

  const doc = new PDFDocument({ margin: 40, size: "A4" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="zasahy.pdf"`);

  doc.pipe(res);

  doc.fontSize(16).text("Přehled zásahů JPO", { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(10).text(`Filtry: den=${filters.day}, typ=${filters.type}, město="${filters.city}", stav=${filters.status}, měsíc=${filters.month}`);
  doc.moveDown(1);

  doc.fontSize(9);

  for (const r of rows) {
    const line = `${r.pub_date || ""} | ${typeLabel(r.event_type)} | ${r.title || ""} | ${r.city_text || ""} | ${r.is_closed ? "ukončeno" : "aktivní"} | ${r.duration_min != null ? (r.duration_min + " min") : ""}`;
    doc.text(line);
  }

  doc.end();
});

// ---------------- INIT ----------------
await initDb();

// ---------------- API ----------------

// ingest
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

      // ✅ meta z DB pro detekci přechodu "aktivní -> ukončené"
      const prev = await getEventMeta(it.id);

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const times = parseTimesFromDescription(desc);

      const startIso = it.startTimeIso || times.startIso || null;
      let endIso = it.endTimeIso || times.endIso || null;

      // ✅ FIX: ber ukončení i z ESP (isClosedGuess) a ze statusText
      const isClosed = !!(times.isClosed || it.isClosedGuess || isClosedFromStatusText(it.statusText));

      // ✅ RSS často nemá ukončení časem – když se událost poprvé označí jako ukončená,
      // zmrazíme konec na "teď" a dopočítáme duration z first_seen_at.
      const closingNow = isClosed && (!prev || !prev.is_closed);
      if (closingNow && !endIso) {
        endIso = new Date().toISOString();
      }

      let durationMin = null;
      if (Number.isFinite(it.durationMin)) {
        const candidate = Math.round(it.durationMin);
        durationMin = (candidate > 0 && candidate <= MAX_DURATION_MINUTES) ? candidate : null;
      } else if (isClosed && endIso) {
        // ✅ pro žebříček nejdelších zásahů počítáme pouze "nové" od nasazení této změny
        const cutoffIso = await getLongestCutoffIso();
        durationMin = await computeDurationMin(it.id, startIso, endIso, null, cutoffIso);
      }

      const placeText = it.placeText || null;
      const cityFromDesc = extractCityFromDescription(desc);
      const cityFromTitle = extractCityFromTitle(it.title);
      const districtFromDesc = extractDistrictFromDescription(desc);

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

      // ✅ zpřesnění polohy: nejdřív zkus "MĚSTO, okres OKRES", pak město, pak place_text
      const geoQueries = [];
      if (ev.cityText && districtFromDesc) geoQueries.push(`${ev.cityText}, okres ${districtFromDesc}`);
      if (ev.cityText) geoQueries.push(ev.cityText);
      if (ev.placeText && ev.placeText !== ev.cityText) geoQueries.push(ev.placeText);

      for (const q of geoQueries) {
        const g = await geocodePlace(q);
        if (g) {
          await updateEventCoords(ev.id, g.lat, g.lon);
          geocoded++;
          break;
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

  const fixedCoords = await backfillCoords(rows, 12);
  const cutoffIso = await getLongestCutoffIso();
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

// events outside CZ (debug)
app.get("/api/debug/outside-cz", async (req, res) => {
  const rows = await getEventsOutsideCz();
  res.json({ ok: true, count: rows.length, items: rows });
});

// serve
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});
