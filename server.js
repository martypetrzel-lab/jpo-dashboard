import express from "express";
import { XMLParser } from "fast-xml-parser";
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
  updateEventDuration
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.1 (contact: missing)";

// ✅ sanity limit pro délku zásahu (default 3 dny)
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny

// ✅ hrubé hranice ČR (bbox) – ochrana proti chybnému geocodu
const CZ_BOUNDS = { minLat: 48.55, maxLat: 51.06, minLon: 12.09, maxLon: 18.87 };

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

function inBounds(lat, lon, b) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= b.minLat &&
    lat <= b.maxLat &&
    lon >= b.minLon &&
    lon <= b.maxLon
  );
}

function parseCzDateToIso(s) {
  if (!s) return null;
  const norm = String(s)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  const months = {
    ledna: 1,
    unora: 2,
    brezna: 3,
    dubna: 4,
    kvetna: 5,
    cervna: 6,
    cervence: 7,
    srpna: 8,
    zari: 9,
    rijna: 10,
    listopadu: 11,
    prosince: 12
  };

  const m = norm.match(/(\d{1,2}).?\s+([a-z]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;

  const day = Number(m[1]);
  const monName = m[2];
  const year = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);

  const month = months[monName];
  if (!month) return null;

  // Čas je lokální (CZ) -> aproximace do UTC (stabilní chování)
  const dt = new Date(Date.UTC(year, month - 1, day, hh - 1, mm, 0));
  if (Number.isNaN(dt.getTime())) return null;

  return dt.toISOString().replace(".000Z", "Z");
}

function parseTimesFromDescription(descRaw = "") {
  // RSS description mívá HTML entity + <br>. Nejdřív dekóduj a převod na řádky.
  const norm = String(descRaw)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<br\s*\/?>/gi, "\n");

  const lines = norm.split("\n").map((l) => String(l).trim()).filter(Boolean);

  let startText = null;
  let isClosed = false;

  for (const line of lines) {
    const low = line
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

    // ✅ uzavření bereme jen ze "stav:", ne z "ukončení:" (to bývá často špatně / budoucnost)
    if (low.startsWith("stav:")) {
      const v = line.split(":").slice(1).join(":").trim();
      const vNorm = v
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
      if (vNorm.includes("ukoncena") || vNorm.includes("ukonceno")) isClosed = true;
      continue;
    }

    if (low.startsWith("vyhlaseni:") || low.startsWith("ohlaseni:")) {
      startText = line.split(":").slice(1).join(":").trim();
      continue;
    }
  }

  const startIso = parseCzDateToIso(startText);

  return {
    startIso,
    // ✅ end_time posíláme jako NOW, ale DB ho použije jen při prvním uzavření (jinak ne)
    endIso: isClosed ? new Date().toISOString().replace(".000Z", "Z") : null,
    isClosed
  };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": GEOCODE_UA, Accept: "application/json" } });
  if (!r.ok) return null;
  return await r.json();
}

async function geocodePlace(q) {
  if (!q) return null;

  const cached = await getCachedGeocode(q);
  if (cached && typeof cached.lat === "number" && typeof cached.lon === "number") {
    if (!inBounds(cached.lat, cached.lon, CZ_BOUNDS)) {
      await deleteCachedGeocode(q);
    } else {
      return cached;
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
  if (!inBounds(lat, lon, CZ_BOUNDS)) return null;

  await setCachedGeocode(q, lat, lon);
  return { lat, lon };
}

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

async function computeDurationMin(evId, startIso, endIso) {
  if (!startIso || !endIso) return null;

  // pokud startIso chybí, zkus DB first_seen
  let start = startIso;
  if (!start) {
    const firstSeen = await getEventFirstSeen(evId);
    if (firstSeen) start = new Date(firstSeen).toISOString().replace(".000Z", "Z");
  }
  if (!start) return null;

  return minutesBetweenIso(start, endIso);
}

async function backfillDurations(rows, limit = 80) {
  let fixed = 0;
  const slice = rows
    .filter((r) => r?.is_closed && r?.closed_detected_at && (!Number.isFinite(r.duration_min) || r.duration_min <= 0))
    .slice(0, limit);

  for (const r of slice) {
    const startIso = r.start_time_iso || r.pub_date;
    const endIso = r.end_time_iso;
    if (!startIso || !endIso) continue;

    const durMin = minutesBetweenIso(startIso, endIso);
    if (!durMin) continue;

    await updateEventDuration(r.id, durMin);
    r.duration_min = durMin;
    fixed++;
  }

  return fixed;
}

async function backfillCoords(rows, limit = 8) {
  let fixed = 0;
  const slice = rows.filter((r) => r.lat == null || r.lon == null).slice(0, limit);

  for (const r of slice) {
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

// ---------------- API ----------------
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    let accepted = 0;

    for (const it of items) {
      const id = String(it.guid || it.id || it.link || it.title || "").trim();
      if (!id) continue;

      const title = String(it.title || "").trim();
      const link = String(it.link || "").trim();
      const pubDate = String(it.pubDate || it.pub_date || it.pub_date_text || "").trim();
      const descriptionRaw = String(it.description || it.description_raw || "").trim();

      const times = parseTimesFromDescription(descriptionRaw);

      // start: prefer vyhlášení/ohlášení, pak pubDate
      const startIso =
        times.startIso ||
        (() => {
          const d = new Date(pubDate);
          if (Number.isNaN(d.getTime())) return null;
          return d.toISOString().replace(".000Z", "Z");
        })();

      const isClosed = Boolean(times.isClosed);
      const endIso = isClosed ? (times.endIso || null) : null;

      const durationMin = isClosed ? await computeDurationMin(id, startIso, endIso) : null;

      await upsertEvent({
        id,
        title,
        link,
        pubDate: pubDate || null,
        placeText: String(it.place || it.place_text || "").trim() || null,
        cityText: String(it.city || it.city_text || "").trim() || null,
        statusText: String(it.status || it.status_text || "").trim() || null,
        eventType: classifyType(title),
        descriptionRaw,
        startTimeIso: startIso,
        endTimeIso: endIso,
        durationMin,
        isClosed
      });

      accepted++;
    }

    res.json({ ok: true, accepted });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "ingest failed" });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 400)));
    const filters = {
      day: String(req.query.day || "all"),
      status: String(req.query.status || "all"),
      city: String(req.query.city || ""),
      month: String(req.query.month || ""),
      types: req.query.type ? [String(req.query.type)] : []
    };

    const rows = await getEventsFiltered(filters, limit);

    // malé údržby "za běhu"
    await backfillDurations(rows, 80);
    await backfillCoords(rows, 8);

    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "events failed" });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const filters = {
      day: String(req.query.day || "all"),
      status: String(req.query.status || "all"),
      city: String(req.query.city || ""),
      month: String(req.query.month || ""),
      types: req.query.type ? [String(req.query.type)] : []
    };

    const stats = await getStatsFiltered(filters);
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "stats failed" });
  }
});

app.post("/api/admin/clear-bad-geocode", async (req, res) => {
  try {
    const lim = Math.max(1, Math.min(2000, Number(req.body?.limit || 200)));
    const rows = await getEventsOutsideCz(lim);

    let cleared = 0;
    for (const r of rows) {
      await clearEventCoords(r.id);
      cleared++;
    }

    res.json({ ok: true, cleared });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "clear failed" });
  }
});

// bootstrap
await initDb();

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log("listening on", PORT);
});