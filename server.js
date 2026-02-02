import express from "express";
import {
  initDb,
  upsertEvent,
  getEvents,
  getStats,
  getCachedGeocode,
  setCachedGeocode,
  updateEventCoords
} from "./db.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.0";

function requireKey(req, res, next) {
  const key = req.header("X-API-Key") || "";
  if (!API_KEY) return res.status(500).json({ ok: false, error: "API_KEY not set on server" });
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// --- Type classification (icons handled on frontend) ---
function classifyType(title = "") {
  const t = title.toLowerCase();
  if (t.includes("požár") || t.includes("pozar")) return "fire";
  if (t.includes("doprav") || t.includes("nehoda") || t.includes("dn")) return "traffic";
  if (t.includes("technick") || t.includes("čerpad") || t.includes("cerpad") || t.includes("strom")) return "tech";
  if (t.includes("záchrana") || t.includes("zachrana") || t.includes("transport") || t.includes("resusc")) return "rescue";
  if (t.includes("planý poplach") || t.includes("plany poplach")) return "false_alarm";
  return "other";
}

// --- Czech date parser for strings like: "31. ledna 2026, 15:07" ---
function parseCzDateToIso(s) {
  if (!s) return null;
  let x = String(s).trim();

  // normalize diacritics-insensitive compare
  const norm = x
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

  // pattern: "31. ledna 2026, 15:07"
  const m = norm.match(/(\d{1,2})\.?\s+([a-z]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;

  const day = Number(m[1]);
  const monName = m[2];
  const year = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);

  const month = months[monName];
  if (!month) return null;

  // Create Date in UTC for consistency; duration differences stay correct
  const dt = new Date(Date.UTC(year, month - 1, day, hh, mm, 0));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function extractBetween(text, startToken) {
  const idx = text.toLowerCase().indexOf(startToken);
  if (idx < 0) return "";
  return text.slice(idx + startToken.length).trim();
}

function parseTimesFromDescription(descRaw = "") {
  // desc often: "stav: ukončená<br>ukončení: 31. ledna 2026, 15:07<br>Mladá Boleslav"
  const desc = String(descRaw);

  // get "vyhlášení:" / "ukončení:" if present (works even with diacritics removed)
  const norm = desc
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  // Try to find lines
  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);

  let startText = null;
  let endText = null;

  for (const line of lines) {
    const n = line
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

    if (n.startsWith("vyhlaseni:")) startText = line.split(":").slice(1).join(":").trim();
    if (n.startsWith("ukonceni:")) endText = line.split(":").slice(1).join(":").trim();
    // Some feeds use "ohlášení"/"ohlašeni"
    if (n.startsWith("ohlaseni:")) startText = startText || line.split(":").slice(1).join(":").trim();
  }

  const startIso = parseCzDateToIso(startText);
  const endIso = parseCzDateToIso(endText);

  let durationMin = null;
  if (startIso && endIso) {
    const a = new Date(startIso).getTime();
    const b = new Date(endIso).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      durationMin = Math.round((b - a) / 60000);
    }
  }

  return { startIso, endIso, durationMin };
}

async function geocodePlace(placeText) {
  if (!placeText || placeText.trim().length < 2) return null;

  const cached = await getCachedGeocode(placeText);
  if (cached && typeof cached.lat === "number" && typeof cached.lon === "number") {
    return { lat: cached.lat, lon: cached.lon, cached: true };
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", placeText);

  const r = await fetch(url.toString(), {
    headers: { "User-Agent": GEOCODE_UA }
  });

  if (!r.ok) return null;
  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const lat = Number(data[0].lat);
  const lon = Number(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  await setCachedGeocode(placeText, lat, lon);
  return { lat, lon, cached: false };
}

// ESP ingest
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const { source, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items missing" });
    }

    let accepted = 0;
    let geocoded = 0;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const eventType = it.eventType || classifyType(it.title);
      const times = parseTimesFromDescription(it.descriptionRaw || it.descRaw || it.description || "");

      const ev = {
        id: it.id,
        title: it.title,
        link: it.link,
        pubDate: it.pubDate || null,
        placeText: it.placeText || null,
        statusText: it.statusText || null,
        eventType,
        startTimeIso: it.startTimeIso || times.startIso || null,
        endTimeIso: it.endTimeIso || times.endIso || null,
        durationMin: Number.isFinite(it.durationMin) ? it.durationMin : times.durationMin
      };

      await upsertEvent(ev);
      accepted++;

      if (ev.placeText) {
        const g = await geocodePlace(ev.placeText);
        if (g) {
          await updateEventCoords(ev.id, g.lat, g.lon);
          geocoded++;
        }
      }
    }

    res.json({ ok: true, source: source || "unknown", accepted, geocoded });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// dashboard API
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const rows = await getEvents(limit);
  res.json({ ok: true, items: rows });
});

app.get("/api/stats", async (req, res) => {
  const stats = await getStats();
  res.json({ ok: true, ...stats });
});

app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;

await initDb();
app.listen(port, () => console.log(`listening on ${port}`));
