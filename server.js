import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import {
  initDb,
  upsertEvent,
  getEventsFiltered,
  getStats30Days,
  getTopCities,
  getDailyCounts,
  setEventCoords,
  clearEventCoords,
  updateEventDuration,
  pool
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== Simple CORS (bez externí závislosti) =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ===== ENV =====
const API_KEY = process.env.API_KEY || "";

// ===== Helpers =====
function norm(s) {
  return String(s || "").trim();
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex");
}

function safeJson(res, obj, code = 200) {
  res.status(code).json(obj);
}

function isValidApiKey(req) {
  if (!API_KEY) return true;
  const k = req.headers["x-api-key"];
  return k && String(k) === String(API_KEY);
}

function extractFromTitle(title) {
  const t = norm(title);
  // formát: "technická pomoc - odstranění stromu - Lány"
  const parts = t.split(" - ").map((x) => norm(x)).filter(Boolean);
  const typ = parts[0] || "";
  const city = parts[parts.length - 1] || "";
  return { typ, city };
}

function parsePubDateToISO(pubDate) {
  // RSS pubDate je RFC822, Date() to zvládá (UTC)
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function htmlDecodeBr(s) {
  return String(s || "").replace(/&lt;br&gt;/g, "\n");
}

// "ukončení: 2. dubna 2026, 09:02"
function parseCzDateTimeFromText(txt) {
  const s = String(txt || "").trim();
  // extrahujeme "2. dubna 2026, 09:02"
  // mapping měsíců
  const months = {
    ledna: 0,
    února: 1,
    unora: 1,
    března: 2,
    brezna: 2,
    dubna: 3,
    května: 4,
    kvetna: 4,
    června: 5,
    cervna: 5,
    července: 6,
    cervence: 6,
    srpna: 7,
    září: 8,
    zari: 8,
    října: 9,
    rijna: 9,
    listopadu: 10,
    prosince: 11
  };

  const m = s.match(/(\d{1,2})\.\s*([^\s]+)\s*(\d{4}),\s*(\d{1,2}):(\d{2})/i);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const monKey = String(m[2] || "").toLowerCase();
  const year = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mm = parseInt(m[5], 10);

  if (!Number.isFinite(day) || !Number.isFinite(year) || !Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (!(monKey in months)) return null;

  // Vytvoříme datum v lokálním čase serveru, ale chceme CZ (Europe/Prague).
  // Railway je typicky UTC, proto skládáme jako "YYYY-MM-DDTHH:mm:00+01/+02" by bylo ideální.
  // Jednoduchá a stabilní varianta pro náš dashboard:
  // uložíme jako ISO přes Date.UTC a počítáme délku jen rozdílem, takže posun není kritický.
  // Přesto: poskládáme jako lokální CZ přes Intl by vyžadovalo TZ knihovnu.
  // Necháme to jako "naivní" konstrukci v lokálním prostředí.
  const d = new Date(year, months[monKey], day, hh, mm, 0, 0);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseDescription(descRaw) {
  const desc = htmlDecodeBr(descRaw);
  const lines = desc.split("\n").map((x) => norm(x)).filter(Boolean);

  let status = "";
  let endedISO = null;
  let city = "";
  let district = "";

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.startsWith("stav:")) {
      status = norm(line.split(":").slice(1).join(":"));
      continue;
    }

    if (lower.startsWith("ukončení:") || lower.startsWith("ukonceni:")) {
      const t = norm(line.split(":").slice(1).join(":"));
      const iso = parseCzDateTimeFromText(t);
      if (iso) endedISO = iso;
      continue;
    }

    // město je často samotný řádek bez prefixu, ale někdy:
    // "Lány" / "okres Kladno"
    if (lower.startsWith("okres")) {
      district = norm(line);
      continue;
    }

    // pokud je to jen text bez prefixu, bereme jako city (první takový)
    if (!line.includes(":") && !city) {
      city = norm(line);
      continue;
    }
  }

  const isClosed = status.toLowerCase().includes("ukon");
  return { status, isClosed, endedISO, city, district };
}

// ===== Routes =====
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// ingest z ESP (ESP ti posílá už hotové eventy)
app.post("/api/ingest", async (req, res) => {
  if (!isValidApiKey(req)) return safeJson(res, { ok: false, error: "unauthorized" }, 401);

  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];

    let inserted = 0;
    let updated = 0;

    for (const it of items) {
      const title = norm(it.title);
      const link = norm(it.link);
      const guid = norm(it.guid) || (link ? `link:${sha1(link)}` : `title:${sha1(title)}`);
      const pubDate = it.pubDate || it.pubdate || it.date || null;
      const desc = it.description || it.desc || "";

      const { typ, city: cityFromTitle } = extractFromTitle(title);
      const parsed = parseDescription(desc);

      const row = {
        guid,
        title,
        link,
        typ: norm(typ),
        city: norm(parsed.city || cityFromTitle),
        district: norm(parsed.district),
        status: norm(parsed.status),
        is_closed: !!parsed.isClosed,
        pub_time_iso: pubDate ? parsePubDateToISO(pubDate) : null,
        end_time_iso: parsed.endedISO
      };

      const r = await upsertEvent(row);
      if (r && r.inserted) inserted++;
      else updated++;
    }

    return safeJson(res, { ok: true, inserted, updated, count: items.length });
  } catch (e) {
    console.error("[ingest] error", e);
    return safeJson(res, { ok: false, error: "ingest_failed" }, 500);
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const day = norm(req.query.day || "today"); // today | all
    const typ = norm(req.query.typ || "all");   // all | ...
    const city = norm(req.query.city || "");
    const status = norm(req.query.status || "all"); // all | active | closed
    const month = norm(req.query.month || ""); // YYYY-MM

    const data = await getEventsFiltered({ day, typ, city, status, month });
    return safeJson(res, { ok: true, items: data.items, meta: data.meta });
  } catch (e) {
    console.error("[api/events] error", e);
    return safeJson(res, { ok: false, error: "events_failed" }, 500);
  }
});

app.get("/api/stats30", async (req, res) => {
  try {
    // Statistika 30 dnů má být ze všech dnů, bez závislosti na filtru dne.
    const typ = norm(req.query.typ || "all");
    const city = norm(req.query.city || "");
    const status = norm(req.query.status || "all");
    const month = norm(req.query.month || "");

    const stats = await getStats30Days({ typ, city, status, month });
    return safeJson(res, { ok: true, ...stats });
  } catch (e) {
    console.error("[api/stats30] error", e);
    return safeJson(res, { ok: false, error: "stats_failed" }, 500);
  }
});

app.get("/api/top-cities", async (req, res) => {
  try {
    const month = norm(req.query.month || "");
    const typ = norm(req.query.typ || "all");
    const status = norm(req.query.status || "all");
    const city = norm(req.query.city || "");

    const rows = await getTopCities({ month, typ, status, city });
    return safeJson(res, { ok: true, items: rows });
  } catch (e) {
    console.error("[api/top-cities] error", e);
    return safeJson(res, { ok: false, error: "top_cities_failed" }, 500);
  }
});

app.get("/api/daily-counts", async (req, res) => {
  try {
    const typ = norm(req.query.typ || "all");
    const city = norm(req.query.city || "");
    const status = norm(req.query.status || "all");
    const month = norm(req.query.month || "");

    const rows = await getDailyCounts({ typ, city, status, month });
    return safeJson(res, { ok: true, items: rows });
  } catch (e) {
    console.error("[api/daily-counts] error", e);
    return safeJson(res, { ok: false, error: "daily_counts_failed" }, 500);
  }
});

// uložení souřadnic (geocoding)
app.post("/api/coords", async (req, res) => {
  try {
    const { id, lat, lng } = req.body || {};
    if (!id) return safeJson(res, { ok: false, error: "missing_id" }, 400);

    if (lat == null || lng == null) {
      await clearEventCoords(id);
      return safeJson(res, { ok: true });
    }

    await setEventCoords(id, Number(lat), Number(lng));
    return safeJson(res, { ok: true });
  } catch (e) {
    console.error("[api/coords] error", e);
    return safeJson(res, { ok: false, error: "coords_failed" }, 500);
  }
});

// fallback na index
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Zpětný přepočet délky zásahu (historie) =====
// Přepočítá jen tam, kde už máme ukončení (end_time_iso), ale chybí duration_min.
// Používá first_seen_at jako start (čas, kdy jsme zásah poprvé uložili z ESP/RSS).
const DUR_BACKFILL_MS = 10 * 60 * 1000; // každých 10 minut
const DUR_BACKFILL_LIMIT = 500;
const DUR_BACKFILL_LOOKBACK_DAYS = 30;
const DUR_BACKFILL_MAX_MIN = 7 * 24 * 60; // bezpečnostní strop: 7 dní

async function backfillMissingDurations() {
  try {
    const q = `
      SELECT id, end_time_iso, first_seen_at
      FROM events
      WHERE is_closed = true
        AND duration_min IS NULL
        AND end_time_iso IS NOT NULL
        AND first_seen_at IS NOT NULL
        AND first_seen_at >= NOW() - ($1::int || ' days')::interval
      ORDER BY end_time_iso DESC
      LIMIT $2
    `;
    const { rows } = await pool.query(q, [DUR_BACKFILL_LOOKBACK_DAYS, DUR_BACKFILL_LIMIT]);

    let updated = 0;
    let skipped = 0;
    for (const r of rows) {
      const start = new Date(r.first_seen_at);
      const end = new Date(r.end_time_iso);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        skipped++;
        continue;
      }

      let diffMin = Math.round((end.getTime() - start.getTime()) / 60000);
      if (!Number.isFinite(diffMin) || diffMin < 0) {
        skipped++;
        continue;
      }
      if (diffMin > DUR_BACKFILL_MAX_MIN) diffMin = DUR_BACKFILL_MAX_MIN;

      await updateEventDuration(r.id, diffMin);
      updated++;
    }

    if (rows.length > 0) {
      console.log(`[dur-maint] scanned=${rows.length} updated=${updated} skipped=${skipped}`);
    }
  } catch (e) {
    console.error("[dur-maint] error", e);
  }
}

function startDurationMaintenance() {
  backfillMissingDurations();
  setInterval(backfillMissingDurations, DUR_BACKFILL_MS);
}

// ===== Start =====
const PORT = process.env.PORT || 8080;
await initDb();
startDurationMaintenance();

app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});
