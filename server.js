import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import http from "http";
import https from "https";
import zlib from "zlib";

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
  clearExtremeDurations,
  recalcDurationsFromTimes,
  clearCoordsFor
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.7 (contact: missing)";

// ✅ RSS JPO (autopull)
const RSS_ENABLED = (process.env.JPO_RSS_ENABLED ?? "1") !== "0";
const JPO_RSS_URL = process.env.JPO_RSS_URL || "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml";
const RSS_INTERVAL_MS = Math.max(30_000, Number(process.env.JPO_RSS_INTERVAL_MS || 60_000)); // default 60s

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

async function computeDurationMin(id, startIso, endIso, createdAtFallback) {
  if (!endIso) return null;

  let startMs = startIso ? new Date(startIso).getTime() : NaN;

  if (!Number.isFinite(startMs)) {
    const firstSeen = await getEventFirstSeen(id);
    if (firstSeen?.first_seen_at) startMs = new Date(firstSeen.first_seen_at).getTime();
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

    const top = data[0];
    const lat = Number(top.lat);
    const lon = Number(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    await setCachedGeocode(placeText, lat, lon);
    return { lat, lon, cached: false };
  }

  return null;
}

// ---------------- RSS PARSER (bez dalších knihoven) ----------------
function decodeXmlEntities(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  return decodeXmlEntities(m[1].trim());
}

function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml).match(/<item[\s\S]*?>[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = getTag(b, "title");
    const link = getTag(b, "link");
    const desc = getTag(b, "description");
    const pubDate = getTag(b, "pubDate");
    const guid = getTag(b, "guid");
    const id = guid || link || `${title}__${pubDate}`;
    items.push({ id, title, link, descriptionRaw: desc, pubDate });
  }
  return items;
}

/**
 * ✅ Robustní stažení URL (http/https, redirecty, gzip/br) bez fetch().
 * DŮLEŽITÉ: loguje konkrétní chyby (ENOTFOUND, ECONNRESET, ETIMEDOUT...)
 */
function fetchTextNative(urlStr, timeoutMs = 20000, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error(`Bad URL: ${urlStr}`));
      return;
    }

    const lib = u.protocol === "http:" ? http : https;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        method: "GET",
        headers: {
          "User-Agent": GEOCODE_UA,
          "Accept": "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br"
        }
      },
      (res) => {
        // Redirect
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
          const loc = res.headers.location;
          res.resume();
          if (!loc) return reject(new Error(`Redirect without location (HTTP ${res.statusCode})`));
          if (maxRedirects <= 0) return reject(new Error(`Too many redirects, last=${loc}`));
          const next = new URL(loc, urlStr).toString();
          return resolve(fetchTextNative(next, timeoutMs, maxRedirects - 1));
        }

        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          const chunks = [];
          res.on("data", (d) => chunks.push(d));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ""} body=${body.slice(0, 200)}`));
          });
          return;
        }

        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        let stream = res;

        if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on("data", (d) => chunks.push(d));
        stream.on("error", (e) => reject(e));
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`ETIMEDOUT after ${timeoutMs}ms`));
    });

    req.on("error", (e) => reject(e));
    req.end();
  });
}

function formatErr(e) {
  const cause = e?.cause;
  const parts = [];
  parts.push(e?.name || "Error");
  parts.push(e?.message || String(e));
  if (cause) {
    parts.push(`cause=${cause?.code || cause?.name || "unknown"}:${cause?.message || String(cause)}`);
  }
  if (e?.code) parts.push(`code=${e.code}`);
  return parts.join(" | ");
}

async function runRssOnce(tag = "interval") {
  if (!RSS_ENABLED) return { ok: false, reason: "disabled" };

  try {
    const xml = await fetchTextNative(JPO_RSS_URL, 20000, 5);
    const parsed = parseRssItems(xml);

    let accepted = 0;
    let closedSeen = 0;

    for (const it of parsed) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const eventType = classifyType(it.title);
      const desc = it.descriptionRaw || "";
      const times = parseTimesFromDescription(desc);

      let pubTs = null;
      if (it.pubDate) {
        const d = new Date(it.pubDate);
        if (!Number.isNaN(d.getTime())) pubTs = d.toISOString();
      }

      const durationMin = await computeDurationMin(it.id, times.startIso || pubTs, times.endIso, null);

      const placeText = null;
      const cityFromDesc = extractCityFromDescription(desc);
      const cityFromTitle = extractCityFromTitle(it.title);

      const cityText = cityFromDesc || cityFromTitle || null;

      const ev = {
        id: it.id,
        title: it.title,
        link: it.link,
        pubDate: it.pubDate || null,
        pubTs,

        placeText,
        cityText,

        statusText: null,
        eventType,
        descriptionRaw: desc || null,

        startTimeIso: times.startIso || pubTs || null,
        endTimeIso: times.endIso || null,
        durationMin,
        isClosed: !!times.isClosed
      };

      await upsertEvent(ev);
      accepted++;
      if (ev.isClosed) closedSeen++;
    }

    console.log(`[rss] ${tag} ok accepted=${accepted} closed_seen=${closedSeen} total=${parsed.length} url=${JPO_RSS_URL}`);
    return { ok: true, accepted, closedSeen, count: parsed.length };
  } catch (e) {
    console.error(`[rss] ${tag} error ${formatErr(e)}`);
    return { ok: false, error: formatErr(e) };
  }
}

// ---------------- FILTERS ----------------
function parseFilters(req) {
  const typeQ = String(req.query.type || "").trim();
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").trim().toLowerCase();
  const day = String(req.query.day || "today").trim().toLowerCase();
  const month = String(req.query.month || "").trim();

  const types = typeQ ? typeQ.split(",").map(s => s.trim()).filter(Boolean) : [];
  const normStatus = ["all", "open", "closed"].includes(status) ? status : "all";
  const normDay = ["today", "yesterday", "all"].includes(day) ? day : "today";

  return { types, city, status: normStatus, day: normDay, month };
}

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
app.post("/api/rss/refresh", requireKey, async (req, res) => {
  const out = await runRssOnce("manual");
  res.json(out);
});

app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);

  const rows = await getEventsFiltered(filters, limit);

  const fixedCoords = await backfillCoords(rows, 8);
  const fixedDur = await backfillDurations(rows, 80);

  res.json({ ok: true, filters, backfilled_coords: fixedCoords, backfilled_durations: fixedDur, items: rows });
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
  await backfillDurations(rows, 500);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.csv"`);

  const csvEscape = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r;]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };

  const header = [
    "time_iso", "state", "type", "title", "city", "place_text", "status_text", "duration_min", "link"
  ].join(";");

  const lines = rows.map(r => {
    const timeIso = new Date(r.pub_ts || r.created_at).toISOString();
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

  drawHeader();
  doc.fontSize(9).fillColor("#000");

  for (const r of rows) {
    const time = new Date(r.pub_ts || r.created_at).toLocaleString("cs-CZ");
    const state = r.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(r.event_type || "other");
    const city = (r.city_text || r.place_text || "");
    const dur = (Number.isFinite(r.duration_min) ? `${r.duration_min} min` : "—");
    const title = (r.title || "");

    if (y > doc.page.height - 40) {
      doc.addPage();
      y = doc.y;
      drawHeader();
      doc.fontSize(9).fillColor("#000");
    }

    doc.text(time, startX, y, { width: col.time });
    doc.text(state, startX + col.time, y, { width: col.state });
    doc.text(typ, startX + col.time + col.state, y, { width: col.type });
    doc.text(city, startX + col.time + col.state + col.type, y, { width: col.city });
    doc.text(dur, startX + col.time + col.state + col.type + col.city, y, { width: col.dur });
    doc.text(title, startX + col.time + col.state + col.type + col.city + col.dur, y, { width: col.title });

    y += 12;
  }

  doc.end();
});

// ✅ admin: skutečné „re-geocode města“ (cache pryč + coords pryč)
app.post("/api/admin/regeocode-city", requireKey, async (req, res) => {
  try {
    const city = String(req.body?.city || "").trim();
    if (!city) return res.status(400).json({ ok: false, error: "city missing" });

    const cacheDeleted = await deleteCachedGeocode(city);
    const cleared = await clearCoordsFor(city);

    res.json({ ok: true, city, cache_deleted: cacheDeleted, coords_cleared: cleared });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
await initDb();

// ✅ start RSS loop
if (RSS_ENABLED) {
  setTimeout(() => runRssOnce("startup"), 4000);
  setInterval(() => runRssOnce("interval"), RSS_INTERVAL_MS);
  console.log(`[rss] enabled url=${JPO_RSS_URL} every=${RSS_INTERVAL_MS}ms`);
} else {
  console.log("[rss] disabled");
}

// ✅ duration maintenance
const MAINT_MAX_MINUTES = Math.max(1, Math.min(Number(process.env.DURATION_MAX_MINUTES || 720), 43200));
const MAINT_EVERY_MS = Math.max(60_000, Number(process.env.DURATION_MAINT_INTERVAL_MS || 6 * 60 * 60 * 1000));

async function runDurationMaintenance(tag = "scheduled") {
  try {
    const cleared = await clearExtremeDurations(MAINT_MAX_MINUTES);
    const recalced = await recalcDurationsFromTimes({ maxMinutes: MAINT_MAX_MINUTES, limit: 5000 });
    if (cleared || recalced) {
      console.log(`[dur-maint] ${tag} cleared=${cleared} recalced=${recalced} max=${MAINT_MAX_MINUTES}`);
    }
  } catch (e) {
    console.error("[dur-maint] error", e);
  }
}

setTimeout(() => runDurationMaintenance("startup"), 2 * 60 * 1000);
setInterval(() => runDurationMaintenance("interval"), MAINT_EVERY_MS);

app.listen(port, () => console.log(`listening on ${port}`));
