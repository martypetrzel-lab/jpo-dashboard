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
  updateEventTimes,
  getEventTimes,
  recalcDurationsSql
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

/**
 * Parsuje české datumy z detailu (text), vrací ISO.
 * Pozn.: pro výpočet délky je OK, i když to není přesně "Europe/Prague",
 * protože oba časy (start/end) jsou ve stejném systému.
 */
function parseCzDateToIsoFlexible(s) {
  if (!s) return null;

  const raw = String(s).trim();
  const norm = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  const months = {
    ledna: 1, unora: 2, brezna: 3, dubna: 4, kvetna: 5, cervna: 6,
    cervence: 7, srpna: 8, zari: 9, rijna: 10, listopadu: 11, prosince: 12
  };

  // 1) 2. února 2026, 17:27  /  2. února 2026 17:27
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
    if (n.startsWith("stav:") && n.includes("ukonc")) isClosed = true;
  }

  return {
    startIso: parseCzDateToIsoFlexible(startText),
    endIso: parseCzDateToIsoFlexible(endText),
    isClosed
  };
}

function isoFromPubDate(pubDateText) {
  if (!pubDateText) return null;
  try {
    const d = new Date(pubDateText);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * ✅ OPRAVA: fallback pořadí pro start:
 * 1) startIso (pokud existuje)
 * 2) pubDateIso (RSS pubDate) – to je nejlepší “zahájení/ohlášení” v RSS světě
 * 3) first_seen_at (DB)
 * 4) createdAtFallback (pokud máme)
 */
async function computeDurationMin(id, startIso, endIso, pubDateIso, createdAtFallback) {
  if (!endIso) return null;

  const endMs = new Date(endIso).getTime();
  if (!Number.isFinite(endMs)) return null;

  let startMs = startIso ? new Date(startIso).getTime() : NaN;

  if (!Number.isFinite(startMs) && pubDateIso) {
    const pd = new Date(pubDateIso).getTime();
    if (Number.isFinite(pd)) startMs = pd;
  }

  if (!Number.isFinite(startMs)) {
    const firstSeen = await getEventFirstSeen(id);
    if (firstSeen) {
      const fsMs = new Date(firstSeen).getTime();
      if (Number.isFinite(fsMs)) startMs = fsMs;
    }
  }

  if (!Number.isFinite(startMs) && createdAtFallback) {
    const ca = new Date(createdAtFallback).getTime();
    if (Number.isFinite(ca)) startMs = ca;
  }

  if (!Number.isFinite(startMs) || endMs <= startMs) return null;

  const min = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(min) || min <= 0) return null;

  return min;
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
async function fetchDetailTimes(link) {
  if (!link || typeof link !== "string") return null;
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

      if (!startIso && (n.startsWith("vyhlaseni") || n.startsWith("ohlaseni"))) {
        const v = line.split(":").slice(1).join(":").trim();
        startIso = parseCzDateToIsoFlexible(v) || startIso;
      }

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

// ✅ přepočet duration: opravujeme i “nesmyslné” uložené hodnoty
async function backfillDurations(rows, max = 80) {
  const candidates = rows
    .filter(r => r?.is_closed && r?.end_time_iso)
    .slice(0, Math.max(0, Math.min(max, 300)));

  let fixed = 0;

  for (const r of candidates) {
    const pubIso = isoFromPubDate(r.pub_date) || null;

    const computed = await computeDurationMin(
      r.id,
      r.start_time_iso,
      r.end_time_iso,
      pubIso,
      r.created_at
    );

    // Pokud computed nedává smysl, necháme DB beze změny
    if (!Number.isFinite(computed) || computed <= 0) continue;

    const current = Number.isFinite(r.duration_min) ? Number(r.duration_min) : null;

    // opravujeme když:
    // - duration je null
    // - nebo se liší “výrazně” (typicky starý bug -> všude stejná hodnota)
    const shouldUpdate =
      current == null ||
      current <= 0 ||
      Math.abs(current - computed) >= 3;

    if (shouldUpdate) {
      await updateEventDuration(r.id, computed);
      r.duration_min = computed;
      fixed++;
    }
  }

  return fixed;
}

// ✅ VARIANTA B: doplnění start/end z DETAILU (a pak i duration)
async function backfillTimesFromDetail(rows, max = 12) {
  const candidates = rows
    .filter(r => r?.is_closed && (!r.end_time_iso || !r.start_time_iso) && r.link)
    .slice(0, Math.max(0, Math.min(max, 30)));

  let fixed = 0;

  for (const r of candidates) {
    const detail = await fetchDetailTimes(r.link);
    if (!detail) continue;

    const newStart = r.start_time_iso || detail.startIso || null;
    const newEnd = r.end_time_iso || detail.endIso || null;
    const newClosed = r.is_closed || !!detail.isClosed;

    if (newStart !== r.start_time_iso || newEnd !== r.end_time_iso || newClosed !== r.is_closed) {
      await updateEventTimes(r.id, newStart, newEnd, newClosed);
      r.start_time_iso = newStart;
      r.end_time_iso = newEnd;
      r.is_closed = newClosed;
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

// ---------------- PDF FONT ----------------
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

    const MAX_DETAIL_FETCH = 10;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const timesFromRss = parseTimesFromDescription(desc);

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

      // pubDate ISO (RSS)
      const pubIso = isoFromPubDate(it.pubDate) || null;

      // ✅ VARIANTA B: detail fetch jen pokud je ukončeno a chybí start/end
      if (isClosed && (!endIso || !startIso) && detailFetched < MAX_DETAIL_FETCH) {
        const det = await fetchDetailTimes(it.link);
        if (det) {
          startIso = startIso || det.startIso || null;
          endIso = endIso || det.endIso || null;
          isClosed = isClosed || !!det.isClosed;
        }
        detailFetched++;
      }

      // ✅ duration počítáme jen když máme end (a start si umíme smysluplně odvodit)
      const durationMin =
        Number.isFinite(it.durationMin)
          ? Math.round(it.durationMin)
          : await computeDurationMin(it.id, startIso, endIso, pubIso, null);

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

      // update times (když se něco objevilo)
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

// events
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);

  const rows = await getEventsFiltered(filters, limit);

  const fixedCoords = await backfillCoords(rows, 8);
  const fixedTimes = await backfillTimesFromDetail(rows, 14);

  // ✅ klíč: přepočti duration i když už v DB nějaká je
  const fixedDur = await backfillDurations(rows, 160);

  res.json({
    ok: true,
    filters,
    backfilled_coords: fixedCoords,
    backfilled_times: fixedTimes,
    backfilled_durations: fixedDur,
    items: rows
  });
});

// stats
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

// export PDF
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

// ✅ admin: oprav špatné body mimo ČR
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

// ✅ admin: hromadný přepočet durations v DB (fixne i “10h48” co už je uložené)
app.post("/api/admin/recalc-durations", requireKey, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 2000), 20000));
    const result = await recalcDurationsSql(limit);
    res.json({ ok: true, updated: result.updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// debug: vrátí časy pro konkrétní id (aby ses mohl rychle ujistit)
app.get("/api/debug/event-times/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "missing id" });
  const row = await getEventTimes(id);
  res.json({ ok: true, id, ...row });
});

app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
await initDb();
app.listen(port, () => console.log(`listening on ${port}`));