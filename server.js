import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

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
  getTrackingStartIso,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.API_KEY || "";
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.1 (contact: missing)";

// ✅ sanity limit pro délku zásahu (default 3 dny)
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny

// ✅ hrubé hranice ČR (bbox) – ochrana proti chybnému geocodu
const CZ_BOUNDS = { minLat: 48.55, maxLat: 51.06, minLon: 12.09, maxLon: 18.87 };

// ✅ hrubé hranice Středočeského kraje (bbox) – extra ochrana proti chybné geokódaci (Polsko apod.)
const STC_BOUNDS = { minLat: 49.20, maxLat: 50.80, minLon: 13.10, maxLon: 15.80 };

let TRACKING_START_ISO = null;

// PDF font (TTF) — prefer ENV, fallback na /public/fonts/DejaVuSans.ttf
const PDF_FONT_PATH =
  process.env.PDF_FONT_PATH || path.join(__dirname, "public", "fonts", "DejaVuSans.ttf");
const PDF_FONT_BOLD_PATH =
  process.env.PDF_FONT_BOLD_PATH || path.join(__dirname, "public", "fonts", "DejaVuSans-Bold.ttf");

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
  if (t.includes("technick") || t.includes("technicka") || t.includes("odstranění") || t.includes("odstraneni"))
    return "tech";
  if (t.includes("záchrana") || t.includes("zachrana") || t.includes("transport") || t.includes("zvířat") || t.includes("zvirat"))
    return "rescue";
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

  // očekávaný formát např. "2. února 2026, 17:27"
  const m = norm.match(/(\d{1,2})\.\s*([a-z]+)\s*(\d{4}).*?(\d{1,2}):(\d{2})/i);
  if (!m) return null;

  const d = Number(m[1]);
  const monName = m[2];
  const y = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);

  const months = {
    ledna: 0,
    unora: 1,
    brezna: 2,
    dubna: 3,
    kvetna: 4,
    cervna: 5,
    cervence: 6,
    srpna: 7,
    zari: 8,
    rijna: 9,
    listopadu: 10,
    prosince: 11,
  };

  const mon = months[monName];
  if (mon == null) return null;

  // Czech local time -> ISO (Z)
  const dt = new Date(Date.UTC(y, mon, d, hh - 1, mm, 0)); // Prague ~ CET/CEST; jednoduchý posun (funguje pro náš případ)
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().replace(".000Z", "Z");
}

function parseTimesFromDescription(descRaw = "") {
  // RSS description mívá entity + <br>. Převod na řádky.
  const norm = String(descRaw)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<br\s*\/?>/gi, "\n");

  const lines = norm
    .split("\n")
    .map((l) => String(l).trim())
    .filter(Boolean);

  let startText = null;
  let isClosed = false;

  for (const line of lines) {
    const low = line
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

    // ✅ uzavření bereme jen ze "stav:"
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
    // ✅ end_time posíláme jako NOW, ale DB ho použije jen při prvním uzavření
    endIso: isClosed ? new Date().toISOString().replace(".000Z", "Z") : null,
    isClosed,
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
    if (!inBounds(cached.lat, cached.lon, CZ_BOUNDS) || !inBounds(cached.lat, cached.lon, STC_BOUNDS)) {
      await deleteCachedGeocode(q);
    } else {
      return cached;
    }
  }

  const base = "https://nominatim.openstreetmap.org/search";
  const url = `${base}?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(
    q + ", Středočeský kraj, Czechia"
  )}`;
  const j = await fetchJson(url);
  if (!j || !Array.isArray(j) || j.length === 0) return null;

  const item = j[0];
  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!inBounds(lat, lon, CZ_BOUNDS) || !inBounds(lat, lon, STC_BOUNDS)) return null;

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
  if (!endIso) return null;

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
    .filter((r) => {
      if (!(r?.is_closed && r?.closed_detected_at && (!Number.isFinite(r.duration_min) || r.duration_min <= 0)))
        return false;
      if (!TRACKING_START_ISO) return true;
      const ts = new Date(TRACKING_START_ISO).getTime();
      const st = r.start_time_iso ? new Date(r.start_time_iso).getTime() : NaN;
      if (Number.isFinite(st) && st < ts) return false;
      return true;
    })
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
    const q = r.city_text && String(r.city_text).trim() ? String(r.city_text).trim() : null;
    const place = q || (r.place_text ? String(r.place_text).trim() : null);
    if (!place) continue;

    const geo = await geocodePlace(place);
    if (!geo) continue;

    await updateEventCoords(r.id, geo.lat, geo.lon);
    r.lat = geo.lat;
    r.lon = geo.lon;
    fixed++;
  }

  return fixed;
}

function normalizeFilters(req) {
  return {
    day: String(req.query.day || "all").trim(), // today|yesterday|all
    status: String(req.query.status || "all").trim(), // all|open|closed
    city: String(req.query.city || "").trim(),
    month: String(req.query.month || "").trim(), // YYYY-MM
    types: req.query.type ? [String(req.query.type).trim()] : [],
  };
}

// ---------------- API ----------------
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    let accepted = 0;

    // tracking start (persistuje v DB) – jen odtud počítáme "nejdelší zásahy" aby historické backlogy nedělaly extrémy
    if (!TRACKING_START_ISO) TRACKING_START_ISO = await getTrackingStartIso();

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
      const endIso = isClosed ? times.endIso || null : null;

      // duration jen pokud zavřeno (a DB ji uloží jen při prvním uzavření)
      let durationMin = null;
      if (isClosed) {
        // jen nové události od TRACKING_START (historické necháme bez délky)
        const ts = TRACKING_START_ISO ? new Date(TRACKING_START_ISO).getTime() : null;
        const st = startIso ? new Date(startIso).getTime() : null;
        const pb = pubDate ? new Date(pubDate).getTime() : null;

        const isNewEnough =
          ts == null ||
          (Number.isFinite(st) && st >= ts) ||
          (!Number.isFinite(st) && Number.isFinite(pb) && pb >= ts);

        if (isNewEnough) {
          durationMin = await computeDurationMin(id, startIso, endIso);
        } else {
          durationMin = null;
        }
      }

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
        isClosed,
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
    const filters = normalizeFilters(req);

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
    const filters = normalizeFilters(req);
    const stats = await getStatsFiltered(filters);
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "stats failed" });
  }
});

// -------- PDF EXPORT --------
app.get("/api/export/pdf", async (req, res) => {
  try {
    const filters = normalizeFilters(req);
    const items = await getEventsFiltered(filters, 5000);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="firewatchcz_export.pdf"`);

    const doc = new PDFDocument({ margin: 24, size: "A4" });
    doc.pipe(res);

    // TTF fonty kvůli diakritice
    if (fs.existsSync(PDF_FONT_PATH)) doc.font(PDF_FONT_PATH);
    const fontBoldOk = fs.existsSync(PDF_FONT_BOLD_PATH);

    doc.fontSize(16).text("FireWatch CZ – Export", { align: "left" });
    doc.moveDown(0.5);

    const now = new Date();
    doc.fontSize(9).text(`Vygenerováno: ${now.toLocaleString("cs-CZ")}`);
    doc.moveDown(0.8);

    // hlavička tabulky
    const cols = [
      { k: "title", label: "Název", w: 250 },
      { k: "city_text", label: "Místo", w: 120 },
      { k: "is_closed", label: "Stav", w: 70 },
      { k: "duration_min", label: "Délka", w: 55 },
    ];

    const startX = doc.x;
    let y = doc.y;

    const rowH = 14;

    const drawRow = (cells, bold = false) => {
      let x = startX;
      if (bold && fontBoldOk) doc.font(PDF_FONT_BOLD_PATH);
      else if (!bold && fs.existsSync(PDF_FONT_PATH)) doc.font(PDF_FONT_PATH);

      doc.fontSize(9);

      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        const txt = String(cells[i] ?? "");
        doc.text(txt, x, y, { width: c.w, height: rowH, ellipsis: true });
        x += c.w;
      }
      y += rowH;
    };

    drawRow(cols.map((c) => c.label), true);
    y += 2;

    for (const it of items) {
      const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
      const dur = Number.isFinite(it.duration_min) && it.duration_min > 0 ? `${it.duration_min} min` : "—";
      const place = it.city_text || it.place_text || "";

      // stránkování
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = doc.y;
        drawRow(cols.map((c) => c.label), true);
        y += 2;
      }

      drawRow([it.title || "", place, state, dur], false);
    }

    doc.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "export pdf failed" });
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
TRACKING_START_ISO = await getTrackingStartIso();

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log("listening on", PORT);
});