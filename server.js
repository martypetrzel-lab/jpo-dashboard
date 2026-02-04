import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { parseStringPromise } from "xml2js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

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
  getClosedEventsNeedingDuration
} from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.API_KEY || "JPO_KEY_123456";
const RSS_URL = process.env.RSS_URL || "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml";

// --- helpers --------------------------------------------------

function safeInt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny

function formatDurationMinToText(mins) {
  const m = safeInt(mins);
  if (!m || m <= 0) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h <= 0) return `${mm} min`;
  return `${h} h ${mm} min`;
}

// ✅ fix na extrémní / nesmyslné délky + lepší fallback startu pro historii
async function computeDurationMin(id, startIso, endIso, createdAtFallback, pubDateFallback) {
  if (!endIso) return null;

  const nowMs = Date.now();
  const endMs = new Date(endIso).getTime();

  if (!Number.isFinite(endMs)) return null;

  // pokud by end byl „z budoucnosti“ o hodně (RSS někdy dělá chyby), radši nic
  if (endMs > nowMs + 2 * 60 * 1000) return null;

  let startMs = startIso ? new Date(startIso).getTime() : NaN;

  // 1) start_time_iso (pokud je)
  if (Number.isFinite(startMs) && startMs < endMs) {
    const diffMin = Math.round((endMs - startMs) / 60000);
    if (diffMin > 0 && diffMin <= MAX_DURATION_MINUTES) return diffMin;
    return null;
  }

  // 2) pubDate (lepší než firstSeen u historie – firstSeen může být až po ukončení)
  const pubMs = pubDateFallback ? new Date(pubDateFallback).getTime() : NaN;
  if (Number.isFinite(pubMs) && pubMs < endMs) {
    const diffMin = Math.round((endMs - pubMs) / 60000);
    if (diffMin > 0 && diffMin <= MAX_DURATION_MINUTES) return diffMin;
  }

  // 3) firstSeen (jen pokud je před end)
  const firstSeen = await getEventFirstSeen(id);
  const firstSeenMs = firstSeen ? new Date(firstSeen).getTime() : NaN;
  if (Number.isFinite(firstSeenMs) && firstSeenMs < endMs) {
    const diffMin = Math.round((endMs - firstSeenMs) / 60000);
    if (diffMin > 0 && diffMin <= MAX_DURATION_MINUTES) return diffMin;
  }

  // 4) createdAtFallback (jen pokud je před end)
  const createdMs = createdAtFallback ? new Date(createdAtFallback).getTime() : NaN;
  if (Number.isFinite(createdMs) && createdMs < endMs) {
    const diffMin = Math.round((endMs - createdMs) / 60000);
    if (diffMin > 0 && diffMin <= MAX_DURATION_MINUTES) return diffMin;
  }

  return null;
}

async function backfillDurations(rows, max = 40) {
  let fixed = 0;
  for (let i = 0; i < rows.length && fixed < max; i++) {
    const r = rows[i];

    if (r.duration_min != null) continue;
    if (!r.end_time_iso) continue;

    const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.created_at, r.pub_date);
    if (dur != null) {
      await updateEventDuration(r.id, dur);
      fixed++;
    }
  }
  return fixed;
}

// ✅ zpětný přepočet pro historii (zásahy už jsou v DB, ale nemají duration_min)
async function backfillHistoryDurations(limit = 400) {
  const rows = await getClosedEventsNeedingDuration(limit);
  let fixed = 0;

  for (const r of rows) {
    const dur = await computeDurationMin(r.id, r.start_time_iso, r.end_time_iso, r.created_at, r.pub_date);
    if (dur != null) {
      await updateEventDuration(r.id, dur);
      fixed++;
    }
  }

  if (fixed > 0) console.log(`[dur-history] backfilled=${fixed} (checked=${rows.length})`);
  return fixed;
}

// --- ingest ----------------------------------------------------

app.post("/api/ingest", async (req, res) => {
  try {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const saved = [];

    for (const it of items) {
      const ev = {
        id: String(it.id || ""),
        title: String(it.title || ""),
        link: String(it.link || ""),
        pubDate: it.pubDate || null,
        placeText: it.placeText || null,
        cityText: it.cityText || null,
        statusText: it.statusText || null,
        eventType: it.eventType || null,
        descriptionRaw: it.descriptionRaw || null,
        startTimeIso: it.startTimeIso || null,
        endTimeIso: it.endTimeIso || null,
        durationMin: it.durationMin ?? null,
        isClosed: !!it.isClosed
      };

      if (!ev.id || !ev.title || !ev.link) continue;

      // ✅ pokud je ukončeno a duration není – dopočti (i pro historii)
      if (ev.isClosed && (ev.durationMin == null) && ev.endTimeIso) {
        const dur = await computeDurationMin(ev.id, ev.startTimeIso, ev.endTimeIso, null, ev.pubDate);
        if (dur != null) ev.durationMin = dur;
      }

      await upsertEvent(ev);
      saved.push(ev.id);
    }

    return res.json({ ok: true, saved: saved.length });
  } catch (e) {
    console.error("ingest error", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// --- API -------------------------------------------------------

app.get("/api/events", async (req, res) => {
  try {
    const filters = {
      day: req.query.day || "all",
      status: req.query.status || "all",
      month: req.query.month || "",
      city: req.query.city || "",
      types: req.query.types ? String(req.query.types).split(",").filter(Boolean) : []
    };

    const rows = await getEventsFiltered(filters, 400);

    // ✅ průběžné dopočítání (rychlá oprava toho, co se právě zobrazuje)
    await backfillDurations(rows, 60);

    // ✅ doplň “live” duration pro aktivní
    const now = Date.now();
    const mapped = rows.map((r) => {
      let liveDurationMin = null;

      if (!r.is_closed) {
        const startMs =
          (r.start_time_iso ? new Date(r.start_time_iso).getTime() : NaN) ||
          (r.first_seen_at ? new Date(r.first_seen_at).getTime() : NaN) ||
          (r.created_at ? new Date(r.created_at).getTime() : NaN);

        if (Number.isFinite(startMs)) {
          const diffMin = Math.round((now - startMs) / 60000);
          if (diffMin > 0 && diffMin <= MAX_DURATION_MINUTES) liveDurationMin = diffMin;
        }
      }

      return {
        ...r,
        duration_text: r.duration_min != null ? formatDurationMinToText(r.duration_min) : "—",
        live_duration_min: liveDurationMin,
        live_duration_text: liveDurationMin != null ? formatDurationMinToText(liveDurationMin) : "—"
      };
    });

    res.json({ ok: true, rows: mapped });
  } catch (e) {
    console.error("events error", e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const filters = {
      day: req.query.day || "all",
      status: req.query.status || "all",
      month: req.query.month || "",
      city: req.query.city || "",
      types: req.query.types ? String(req.query.types).split(",").filter(Boolean) : []
    };

    const stats = await getStatsFiltered(filters);
    res.json({ ok: true, stats });
  } catch (e) {
    console.error("stats error", e);
    res.status(500).json({ error: "server_error" });
  }
});

// --- geocode ---------------------------------------------------

async function geocodeWithCache(placeText) {
  if (!placeText) return null;

  const cached = await getCachedGeocode(placeText);
  if (cached?.lat && cached?.lon) return cached;

  const q = encodeURIComponent(`${placeText}, Czechia`);
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`;

  const r = await fetch(url, {
    headers: { "User-Agent": "jpo-dashboard/1.0 (contact: none)" }
  });

  if (!r.ok) return null;

  const js = await r.json();
  if (!Array.isArray(js) || !js[0]) return null;

  const lat = Number(js[0].lat);
  const lon = Number(js[0].lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  await setCachedGeocode(placeText, lat, lon);
  return { lat, lon };
}

app.post("/api/geocode", async (req, res) => {
  try {
    const { id, placeText } = req.body || {};
    if (!id || !placeText) return res.status(400).json({ error: "bad_request" });

    const geo = await geocodeWithCache(placeText);
    if (!geo) return res.status(404).json({ error: "not_found" });

    await updateEventCoords(id, geo.lat, geo.lon);
    res.json({ ok: true, ...geo });
  } catch (e) {
    console.error("geocode error", e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/geocode/clear", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "bad_request" });
    await clearEventCoords(id);
    res.json({ ok: true });
  } catch (e) {
    console.error("geocode clear error", e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/geocode/cache/delete", async (req, res) => {
  try {
    const { placeText } = req.body || {};
    if (!placeText) return res.status(400).json({ error: "bad_request" });
    await deleteCachedGeocode(placeText);
    res.json({ ok: true });
  } catch (e) {
    console.error("geocode cache delete error", e);
    res.status(500).json({ error: "server_error" });
  }
});

// --- maintenance ----------------------------------------------

app.get("/api/maintenance/outside-cz", async (req, res) => {
  try {
    const rows = await getEventsOutsideCz(200);
    res.json({ ok: true, rows });
  } catch (e) {
    console.error("outside-cz error", e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/health", async (req, res) => {
  res.json({ ok: true });
});

// --- SPA fallback ---------------------------------------------

app.get("*", (req, res) => {
  const p = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(404).send("not found");
});

// --- start -----------------------------------------------------

const port = process.env.PORT || 3000;
await initDb();
app.listen(port, () => console.log(`listening on ${port}`));

// ---------------- BACKGROUND JOBS ----------------
// Zpětné dopočítávání délky u UKONČENÝCH zásahů v historii
// (typicky: end_time_iso už existuje, ale duration_min je NULL)
const HISTORY_BACKFILL_MS = Math.max(60_000, Number(process.env.HISTORY_BACKFILL_MS || 10 * 60 * 1000));

(async () => {
  try {
    await backfillHistoryDurations(800);
  } catch (e) {
    console.error("[dur-history] initial backfill failed", e);
  }

  setInterval(async () => {
    try {
      await backfillHistoryDurations(800);
    } catch (e) {
      console.error("[dur-history] periodic backfill failed", e);
    }
  }, HISTORY_BACKFILL_MS);
})();
