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
  updateEventTimes
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.7 (contact: missing)";
const DETAIL_UA = process.env.DETAIL_USER_AGENT || "jpo-dashboard/1.7 detail-fetch (contact: missing)";

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

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtmlToText(html) {
  const withBreaks = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h\d>/gi, "\n");

  const noTags = withBreaks.replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlEntities(noTags);
  return decoded
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseCzDateToIsoFlexible(s) {
  if (!s) return null;

  const raw = String(s).trim();
  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  // 1) 2. února 2026, 17:27  /  2. února 2026 17:27
  const months = {
    ledna: 1, unora: 2, brezna: 3, dubna: 4, kvetna: 5, cervna: 6,
    cervence: 7, srpna: 8, zari: 9, rijna: 10, listopadu: 11, prosince: 12
  };

  const m1 = norm.match(/(\d{1,2})\.?\s+([a-z]+)\s+(\d{4})(?:,)?\s*(\d{1,2}):(\d{2})/);
  if (m1) {
    const day = Number(m1[1]);
    const monName = m1[2];
    const year = Number(m1[3]);
    const hh = Number(m1[4]);
    const mm = Number(m1[5]);
    const month = months[monName];
    if (month) {
      const dt = new Date(Date.UTC(year, month - 1, day, hh, mm, 0));
      if (!Number.isNaN(dt.getTime())) return dt.toISOString();
    }
  }

  // 2) 2.2.2026 17:27 / 02.02.2026 17:27
  const m2 = norm.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m2) {
    const day = Number(m2[1]);
    const month = Number(m2[2]);
    const year = Number(m2[3]);
    const hh = Number(m2[4]);
    const mm = Number(m2[5]);
    const dt = new Date(Date.UTC(year, month - 1, day, hh, mm, 0));
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }

  return null;
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
    // RSS často umí jen: "stav: ukončená"
    if (n.startsWith("stav:") && n.includes("ukonc")) isClosed = true;
  }

  return {
    startIso: parseCzDateToIsoFlexible(startText),
    endIso: parseCzDateToIsoFlexible(endText),
    isClosed
  };
}

async function computeDurationMin(id, startIso, endIso, createdAtFallback) {
  if (!endIso) return null;

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

      await setCachedGeocode(placeText, lat, lon);
      return { lat, lon, cached: false, qUsed: q };
    }
  }

  return null;
}

// ---------------- DETAIL FETCH (VARIANTA B) ----------------
// Z detailní stránky (link) vytáhneme Vyhlášení/Ohlášení/Ukončení,
// protože v RSS často tyto časy nejsou.
async function fetchDetailTimes(link) {
  if (!link || typeof link !== "string") return null;

  // bezpečnost: bereme jen http(s)
  if (!/^https?:\/\//i.test(link)) return null;

  try {
    const r = await fetch(link, {
      headers: { "User-Agent": DETAIL_UA, "Accept-Language": "cs,en;q=0.8" }
    });
    if (!r.ok) return null;

    const html = await r.text();
    const text = stripHtmlToText(html);

    const lines = text.split("\n").map(x => x.trim()).filter(Boolean);

    let startIso = null;
    let endIso = null;

    for (const line of lines) {
      const n = line
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");

      // typicky: "Vyhlášení: 2. února 2026, 17:25"
      if (!startIso && (n.startsWith("vyhlaseni") || n.startsWith("ohlaseni"))) {
        const v = line.split(":").slice(1).join(":").trim();
        startIso = parseCzDateToIsoFlexible(v) || startIso;
      }

      // typicky: "Ukončení: 2. února 2026, 17:27"
      if (!endIso && n.startsWith("ukonceni")) {
        const v = line.split(":").slice(1).join(":").trim();
        endIso = parseCzDateToIsoFlexible(v) || endIso;
      }
    }

    const isClosed = !!endIso;
    if (!startIso && !endIso) return null;

    return { startIso, endIso, isClosed };
  } catch {
    return null;
  }
}

// ---- DAY FILTER (Europe/Prague) ----
const PRAGUE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Prague",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function pragueYmdOffset(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + Number(offsetDays || 0));
  return PRAGUE_FMT.format(d); // YYYY-MM-DD
}

// ---------------- FILTERS ----------------
function parseFilters(req) {
  const typeQ = String(req.query.type || "").trim();
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").trim().toLowerCase();

  const day = String(req.query.day || "today").trim().toLowerCase(); // today/yesterday/3d/7d/all

  const types = typeQ ? typeQ.split(",").map(s => s.trim()).filter(Boolean) : [];
  const normStatus = ["all", "open", "closed"].includes(status) ? status : "all";
  const normDay = ["today", "yesterday", "3d", "7d", "all"].includes(day) ? day : "today";

  // Překlad na DB filtr:
  // - today/yesterday => date (Prague) + spanDays=1
  // - 3d/7d => recentDays
  // - all => nic
  let date = null;
  let spanDays = null;
  let recentDays = null;

  if (normDay === "today") {
    date = pragueYmdOffset(0);
    spanDays = 1;
  } else if (normDay === "yesterday") {
    date = pragueYmdOffset(-1);
    spanDays = 1;
  } else if (normDay === "3d") {
    recentDays = 3;
  } else if (normDay === "7d") {
    recentDays = 7;
  }

  return { types, city, status: normStatus, day: normDay, date, spanDays, recentDays };
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

// ✅ VARIANTA B: doplnění start/end z DETAILU (a pak i duration)
async function backfillTimesFromDetail(rows, max = 12) {
  const candidates = rows
    .filter(r => r?.is_closed && (!r.end_time_iso || !r.start_time_iso || r.duration_min == null) && r.link)
    .slice(0, Math.max(0, Math.min(max, 30)));

  let fixed = 0;

  for (const r of candidates) {
    const detail = await fetchDetailTimes(r.link);
    if (!detail) continue;

    const newStart = r.start_time_iso || detail.startIso || null;
    const newEnd = r.end_time_iso || detail.endIso || null;
    const newClosed = r.is_closed || !!detail.isClosed;

    // update times do DB (jen když něco přibylo)
    if (newStart !== r.start_time_iso || newEnd !== r.end_time_iso || newClosed !== r.is_closed) {
      await updateEventTimes(r.id, newStart, newEnd, newClosed);
      r.start_time_iso = newStart;
      r.end_time_iso = newEnd;
      r.is_closed = newClosed;
      fixed++;
    }

    // a zkusíme hned duration
    if (r.is_closed && r.end_time_iso && (r.duration_min == null)) {
      const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.created_at);
      if (Number.isFinite(dur) && dur > 0) {
        await updateEventDuration(r.id, dur);
        r.duration_min = dur;
      }
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
    let detailFetched = 0;

    // detail fetch limit (abychom nezatížili server)
    const MAX_DETAIL_FETCH = 10;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const timesFromRss = parseTimesFromDescription(desc);

      // poznáme ukončení i když není "Ukončení:" (jen stav: ukončená)
      const descNorm = String(desc || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
      const isClosedByStatus =
        descNorm.includes("stav: ukonc") ||
        String(it.statusText || "").toLowerCase().includes("ukon");

      let startIso = it.startTimeIso || timesFromRss.startIso || null;
      let endIso = it.endTimeIso || timesFromRss.endIso || null;
      let isClosed = !!timesFromRss.isClosed || !!isClosedByStatus;

      // ✅ VARIANTA B: když je ukončené, ale chybí end/start -> zkus detail stránky
      if (isClosed && (!endIso || !startIso) && detailFetched < MAX_DETAIL_FETCH) {
        const det = await fetchDetailTimes(it.link);
        if (det) {
          startIso = startIso || det.startIso || null;
          endIso = endIso || det.endIso || null;
          isClosed = isClosed || !!det.isClosed;
        }
        detailFetched++;
      }

      const durationMin =
        Number.isFinite(it.durationMin)
          ? it.durationMin
          : await computeDurationMin(it.id, startIso, endIso, null);

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

      // pokud jsme doplnili časy, zapíšeme je i do DB (upsertEvent je ukládá, ale jen když přijde EXCLUDED)
      if (startIso || endIso || isClosed) {
        await updateEventTimes(ev.id, startIso, endIso, isClosed);
      }
      if (Number.isFinite(durationMin) && durationMin > 0 && isClosed) {
        await updateEventDuration(ev.id, durationMin);
      }

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
      geocoded,
      detail_fetched: detailFetched
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// events (filters) + backfill coords + backfill duration + VARIANTA B times
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);

  const rows = await getEventsFiltered(filters, limit);

  // 1) doplnit souřadnice
  const fixedCoords = await backfillCoords(rows, 8);

  // 2) Varianta B: doplnit start/end z detailu (hlavně ukončené)
  const fixedTimes = await backfillTimesFromDetail(rows, 12);

  // 3) dopočítat duration z end_time_iso (když už existuje)
  const fixedDur = await backfillDurations(rows, 120);

  res.json({
    ok: true,
    filters,
    backfilled_coords: fixedCoords,
    backfilled_times: fixedTimes,
    backfilled_durations: fixedDur,
    items: rows
  });
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

  await backfillTimesFromDetail(rows, 30);
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
    "start_time_iso",
    "end_time_iso",
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
      csvEscape(r.start_time_iso || ""),
      csvEscape(r.end_time_iso || ""),
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

  await backfillTimesFromDetail(rows, 30);
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
EOF"]}```

---

## ✅ db.js (CELÝ SOUBOR)

```js
import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false
});

async function colExists(table, col) {
  const res = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
    LIMIT 1
    `,
    [table, col]
  );
  return res.rowCount > 0;
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      link TEXT NOT NULL,

      pub_date TEXT,

      place_text TEXT,
      city_text TEXT,

      status_text TEXT,
      event_type TEXT,

      description_raw TEXT,

      start_time_iso TEXT,
      end_time_iso TEXT,
      duration_min INTEGER,
      is_closed BOOLEAN NOT NULL DEFAULT FALSE,

      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,

      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      place_text TEXT PRIMARY KEY,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const adds = [
    ["events", "city_text", "TEXT"],
    ["events", "event_type", "TEXT"],
    ["events", "description_raw", "TEXT"],
    ["events", "start_time_iso", "TEXT"],
    ["events", "end_time_iso", "TEXT"],
    ["events", "duration_min", "INTEGER"],
    ["events", "is_closed", "BOOLEAN"],
    ["events", "first_seen_at", "TIMESTAMPTZ"],
    ["events", "last_seen_at", "TIMESTAMPTZ"],
    ["events", "lat", "DOUBLE PRECISION"],
    ["events", "lon", "DOUBLE PRECISION"]
  ];

  for (const [t, c, typ] of adds) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await colExists(t, c);
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`ALTER TABLE ${t} ADD COLUMN ${c} ${typ};`);
    }
  }

  await pool.query(`
    UPDATE events
    SET is_closed = COALESCE(is_closed, FALSE),
        first_seen_at = COALESCE(first_seen_at, created_at, NOW()),
        last_seen_at = COALESCE(last_seen_at, NOW())
    WHERE is_closed IS NULL OR first_seen_at IS NULL OR last_seen_at IS NULL;
  `);
}

export async function upsertEvent(ev) {
  await pool.query(
    `
    INSERT INTO events (
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      first_seen_at, last_seen_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      pub_date = EXCLUDED.pub_date,

      place_text = COALESCE(EXCLUDED.place_text, events.place_text),
      city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),

      status_text = COALESCE(EXCLUDED.status_text, events.status_text),
      event_type  = COALESCE(EXCLUDED.event_type, events.event_type),
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),
      end_time_iso   = COALESCE(EXCLUDED.end_time_iso,   events.end_time_iso),
      duration_min   = COALESCE(EXCLUDED.duration_min,   events.duration_min),
      is_closed      = (events.is_closed OR EXCLUDED.is_closed),

      last_seen_at = NOW()
    `,
    [
      ev.id,
      ev.title,
      ev.link,
      ev.pubDate || null,
      ev.placeText || null,
      ev.cityText || null,
      ev.statusText || null,
      ev.eventType || null,
      ev.descriptionRaw || null,
      ev.startTimeIso || null,
      ev.endTimeIso || null,
      Number.isFinite(ev.durationMin) ? Math.round(ev.durationMin) : null,
      !!ev.isClosed
    ]
  );
}

export async function updateEventCoords(id, lat, lon) {
  await pool.query(`UPDATE events SET lat=$2, lon=$3 WHERE id=$1`, [id, lat, lon]);
}

export async function clearEventCoords(id) {
  await pool.query(`UPDATE events SET lat=NULL, lon=NULL WHERE id=$1`, [id]);
}

export async function updateEventDuration(id, durationMin) {
  await pool.query(`UPDATE events SET duration_min=$2 WHERE id=$1`, [
    id,
    Number.isFinite(durationMin) ? Math.round(durationMin) : null
  ]);
}

// ✅ NOVÉ: update start/end/is_closed (Varianta B)
export async function updateEventTimes(id, startIso, endIso, isClosed) {
  await pool.query(
    `
    UPDATE events
    SET
      start_time_iso = COALESCE($2, start_time_iso),
      end_time_iso   = COALESCE($3, end_time_iso),
      is_closed      = (is_closed OR COALESCE($4, FALSE))
    WHERE id = $1
    `,
    [id, startIso || null, endIso || null, !!isClosed]
  );
}

export async function getCachedGeocode(placeText) {
  const res = await pool.query(
    `SELECT lat, lon FROM geocode_cache WHERE place_text=$1`,
    [placeText]
  );
  return res.rows[0] || null;
}

export async function setCachedGeocode(placeText, lat, lon) {
  await pool.query(
    `
    INSERT INTO geocode_cache (place_text, lat, lon)
    VALUES ($1,$2,$3)
    ON CONFLICT (place_text) DO UPDATE SET
      lat=EXCLUDED.lat,
      lon=EXCLUDED.lon,
      updated_at=NOW()
    `,
    [placeText, lat, lon]
  );
}

export async function deleteCachedGeocode(placeText) {
  await pool.query(`DELETE FROM geocode_cache WHERE place_text=$1`, [placeText]);
}

export async function getEventFirstSeen(id) {
  const res = await pool.query(`SELECT first_seen_at FROM events WHERE id=$1`, [id]);
  return res.rows[0]?.first_seen_at || null;
}

export async function getEventsOutsideCz(limit = 200) {
  const res = await pool.query(
    `
    SELECT id, city_text, place_text, lat, lon
    FROM events
    WHERE lat IS NOT NULL AND lon IS NOT NULL AND (
      lat < 48.55 OR lat > 51.06 OR lon < 12.09 OR lon > 18.87
    )
    ORDER BY last_seen_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
}

// --- FILTERED EVENTS (mapa/tabulka/export) ---
export async function getEventsFiltered(filters, limit = 400) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();

  const date = String(filters?.date || "").trim(); // YYYY-MM-DD
  const spanDays = Number.isFinite(filters?.spanDays)
    ? Math.max(1, Math.min(3660, Math.round(filters.spanDays)))
    : null;
  const recentDays = Number.isFinite(filters?.recentDays)
    ? Math.max(1, Math.min(3660, Math.round(filters.recentDays)))
    : null;

  const where = [];
  const params = [];
  let i = 1;

  if (types.length) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(COALESCE(city_text,'') ILIKE $${i} OR COALESCE(place_text,'') ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") where.push(`is_closed = FALSE`);
  if (status === "closed") where.push(`is_closed = TRUE`);

  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && spanDays) {
    where.push(
      `(created_at AT TIME ZONE 'Europe/Prague') >= ($${i}::date)::timestamp
       AND (created_at AT TIME ZONE 'Europe/Prague') <  (($${i}::date)::timestamp + make_interval(days => $${i + 1}))`
    );
    params.push(date);
    params.push(spanDays);
    i += 2;
  } else if (recentDays) {
    where.push(`created_at >= NOW() - make_interval(days => $${i})`);
    params.push(recentDays);
    i++;
  }

  const sql =
    `
    SELECT
      id, title, link, pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      lat, lon,
      first_seen_at, last_seen_at, created_at
    FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(pub_date, created_at::text) DESC, created_at DESC
    LIMIT $${i}
    `;

  params.push(limit);

  const res = await pool.query(sql, params);
  return res.rows;
}

// ✅ STATISTIKY: vždy posledních 30 dnů + filtry Typ/Město/Stav
// ❌ ZÁMĚRNĚ ignorujeme filtr "Dny", aby se graf 30 dnů nikdy neresetoval na Dnes/Včera.
export async function getStatsFiltered(filters) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();

  const where = [`created_at >= NOW() - INTERVAL '30 days'`];
  const params = [];
  let i = 1;

  if (types.length) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(COALESCE(city_text,'') ILIKE $${i} OR COALESCE(place_text,'') ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") where.push(`is_closed = FALSE`);
  if (status === "closed") where.push(`is_closed = TRUE`);

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const byDay = await pool.query(
    `
    SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY day
    ORDER BY day ASC;
    `,
    params
  );

  const byType = await pool.query(
    `
    SELECT COALESCE(event_type,'other') AS type, COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY type
    ORDER BY count DESC;
    `,
    params
  );

  const topCities = await pool.query(
    `
    SELECT COALESCE(NULLIF(city_text,''), NULLIF(place_text,''), '(neznámé)') AS city, COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY city
    ORDER BY count DESC
    LIMIT 15;
    `,
    params
  );

  const openVsClosed = await pool.query(
    `
    SELECT
      SUM(CASE WHEN is_closed THEN 1 ELSE 0 END)::int AS closed,
      SUM(CASE WHEN NOT is_closed THEN 1 ELSE 0 END)::int AS open
    FROM events
    ${whereSql}
    `,
    params
  );

  const longest = await pool.query(
    `
    SELECT id, title, link, COALESCE(NULLIF(city_text,''), place_text) AS city, duration_min, start_time_iso, end_time_iso, created_at
    FROM events
    ${whereSql} AND duration_min IS NOT NULL AND duration_min > 0
    ORDER BY duration_min DESC
    LIMIT 10;
    `,
    params
  );

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longest.rows
  };
}