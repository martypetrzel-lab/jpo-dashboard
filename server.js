import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import PDFDocument from "pdfkit";

import {
  initDb,
  upsertEvent,
  updateEventCoords,
  getEventsFiltered,
  getStatsFiltered,
  getGeocache,
  setGeocache,
  deleteGeocache,
  clearCoordsFor,
  getEventsNeedingGeocode,
  getEventsOutsideCz,
  getEventFirstSeen,
  updateEventDuration,
  clearExtremeDurations,
  recalcDurationsFromTimes
} from "./db.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_KEY = process.env.API_KEY || "JPO_KEY_123456";
const ENABLE_CORS = String(process.env.CORS || "1") === "1";

if (ENABLE_CORS) {
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

app.use(express.static(path.join(__dirname, ".")));

// ---------- Helpers ----------
function requireKey(req, res, next) {
  const key = String(req.query.apikey || req.headers["x-api-key"] || "").trim();
  if (!API_KEY || key === API_KEY) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

function normalizeType(s) {
  const t = String(s || "").toLowerCase();
  if (t.includes("požár") || t.includes("pozar")) return "fire";
  if (t.includes("dopravní nehoda") || t.includes("nehoda")) return "traffic";
  if (t.includes("technická") || t.includes("technicka")) return "tech";
  if (t.includes("záchrana") || t.includes("zachrana")) return "rescue";
  if (t.includes("planý") || t.includes("plany") || t.includes("poplach")) return "false_alarm";
  return "other";
}

function parseCzDateToIso(text) {
  // "2. února 2026, 18:07"
  if (!text) return null;
  const s = String(text).trim();

  const months = {
    ledna: 1,
    února: 2,
    brezna: 3,
    března: 3,
    dubna: 4,
    kvetna: 5,
    května: 5,
    cervna: 6,
    června: 6,
    cervence: 7,
    července: 7,
    srpna: 8,
    zari: 9,
    září: 9,
    rijna: 10,
    října: 10,
    listopadu: 11,
    prosince: 12
  };

  const m = s
    .replace(/\s+/g, " ")
    .match(/(\d{1,2})\.\s*([^\s]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/i);

  if (!m) return null;

  const day = Number(m[1]);
  const monName = m[2].toLowerCase();
  const year = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);

  const monthNum = months[monName];
  if (!monthNum || !day || !year) return null;

  // Pozn.: používáme UTC konstrukci – na délku zásahu to nevadí (rozdíl je konstantní),
  // hlavní je, že se to nebude rozpadat.
  const d = new Date(Date.UTC(year, monthNum - 1, day, hh, mm, 0));
  return d.toISOString();
}

function extractUkonceni(descriptionRaw) {
  // description obsahuje "ukončení: 2. února 2026, 18:07"
  if (!descriptionRaw) return null;
  const s = String(descriptionRaw);
  const m = s.match(/ukončen[íi]:\s*([^<\n\r]+)/i);
  if (!m) return null;
  return String(m[1]).trim();
}

function extractStatus(descriptionRaw) {
  if (!descriptionRaw) return "";
  const s = String(descriptionRaw).toLowerCase();
  if (s.includes("stav: ukončená") || s.includes("stav: ukoncena") || s.includes("ukončení:") || s.includes("ukonceni:"))
    return "UKONČENO";
  if (s.includes("stav:")) {
    const m = String(descriptionRaw).match(/stav:\s*([^<\n\r]+)/i);
    if (m) return String(m[1]).trim();
  }
  return "";
}

function extractPlace(descriptionRaw) {
  if (!descriptionRaw) return "";
  const parts = String(descriptionRaw)
    .split("<br>")
    .map((x) => x.replace(/<[^>]*>/g, "").trim())
    .filter(Boolean);

  // typicky:
  // ["stav: ukončená", "ukončení: ...", "Město", "okres ..."]
  // vybereme první položku, která není stav/ukončení/okres
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low.startsWith("stav:")) continue;
    if (low.startsWith("ukončení:") || low.startsWith("ukonceni:")) continue;
    if (low.startsWith("okres")) continue;
    return p;
  }
  return "";
}

function guessCityFromTitle(title) {
  // "... - Město" (poslední pomlčka)
  if (!title) return "";
  const s = String(title);
  const parts = s.split(" - ").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return "";
}

function computeDurationMin(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const a = new Date(startIso);
  const b = new Date(endIso);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  const diff = Math.round((b.getTime() - a.getTime()) / 60000);
  if (diff <= 0) return null;
  return diff;
}

function parseFilters(req) {
  const typeQ = String(req.query.type || "").trim();
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").trim().toLowerCase();

  // den: today | yesterday | all
  // ✅ FE pro "today" standardně query param neposílá, proto default = today
  const day = String(req.query.day || "today").trim().toLowerCase();
  const normDay = ["today", "yesterday", "all"].includes(day) ? day : "today";

  // měsíc: YYYY-MM (pro žebříček měst)
  const month = String(req.query.month || "").trim();
  const normMonth = /^\d{4}-\d{2}$/.test(month) ? month : "";

  let types = [];
  if (typeQ && typeQ !== "all") {
    if (typeQ.includes(",")) {
      types = typeQ.split(",").map((x) => x.trim()).filter(Boolean);
    } else {
      types = [typeQ];
    }
  }

  return {
    day: normDay,
    types,
    city,
    status,
    month: normMonth
  };
}

// ---------- Ingest ----------
app.post("/api/ingest", requireKey, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.json({ ok: true, inserted: 0 });

  let inserted = 0;
  let updated = 0;

  for (const it of items) {
    try {
      const id = String(it.id || it.guid || it.link || "").trim();
      if (!id) continue;

      const title = String(it.title || "").trim();
      const link = String(it.link || "").trim();
      const pubDateRaw = it.pubDate || it.pub_date || null;

      let pubDateIso = null;
      try {
        if (pubDateRaw) pubDateIso = new Date(pubDateRaw).toISOString();
      } catch (_) {}

      const descriptionRaw = it.description || it.description_raw || it.desc || "";
      const statusText = extractStatus(descriptionRaw);
      const isClosed = String(statusText).toLowerCase().includes("ukončen") || String(statusText).toLowerCase().includes("ukonc");

      const placeText = extractPlace(descriptionRaw) || String(it.place || "").trim();
      const cityText = String(it.city || "").trim() || guessCityFromTitle(title) || placeText;

      const endText = extractUkonceni(descriptionRaw);
      const endTimeIso = parseCzDateToIso(endText);

      const startTimeIso = pubDateIso; // start = pubDate
      const durationMin = computeDurationMin(startTimeIso, endTimeIso);

      const ev = {
        id: id,
        title,
        link,
        // pub_date necháme původní (RFC2822) -> pro zobrazení funguje
        pubDate: pubDateRaw || null,
        // ✅ ISO timestamp pro filtry "dnes/včera" (v DB je pub_ts)
        pubTs: pubDateIso || null,
        placeText: placeText || null,
        cityText: cityText || null,
        statusText: statusText || null,
        eventType: normalizeType(title),
        descriptionRaw: descriptionRaw || null,
        startTimeIso: startTimeIso || null,
        endTimeIso: endTimeIso || null,
        durationMin: durationMin || null,
        isClosed: Boolean(isClosed)
      };

      const r = await upsertEvent(ev);
      if (r === "inserted") inserted++;
      else updated++;
    } catch (e) {
      console.error("ingest item error", e);
    }
  }

  res.json({ ok: true, inserted, updated });
});

// ---------- API ----------
app.get("/api/events", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const rows = await getEventsFiltered(filters, limit);
  res.json({ ok: true, filters, rows });
});

app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);
  const stats = await getStatsFiltered(filters);

  // ✅ FE očekává konkrétní klíče (openCount/closedCount/monthlyCities/longest/byDay)
  const openCount = Number(stats?.openVsClosed?.open ?? 0);
  const closedCount = Number(stats?.openVsClosed?.closed ?? 0);

  res.json({
    ok: true,
    filters,
    byDay: stats.byDay || [],
    openCount,
    closedCount,
    monthlyCities: stats.monthlyCities || [],
    longest: stats.longest || [],

    // bonus/debug (nevadí FE)
    byType: stats.byType || [],
    topCities: stats.topCities || []
  });
});

// ✅ ADMIN: vynulovat extrémní délky (NEmazat události)
app.get("/api/admin/clear-extreme-durations", requireKey, async (req, res) => {
  try {
    const maxMinutes = Math.max(1, Math.min(Number(req.query.maxMinutes || 720), 43200));
    const changed = await clearExtremeDurations(maxMinutes);
    res.json({ ok: true, maxMinutes, changed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// ✅ ADMIN: přepočítat délky zásahů z uložených časů (start/end)
// Použití (stejný klíč):
// /api/admin/recalc-durations?apikey=...&maxMinutes=720
app.get("/api/admin/recalc-durations", requireKey, async (req, res) => {
  try {
    const maxMinutes = Math.max(1, Math.min(Number(req.query.maxMinutes || 720), 43200));
    // 1) nejdřív vynulovat extrémy
    const cleared = await clearExtremeDurations(maxMinutes);
    // 2) potom přepočítat z časů u ukončených událostí
    const recalced = await recalcDurationsFromTimes({ maxMinutes, limit: 5000 });
    res.json({ ok: true, maxMinutes, cleared, recalced });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// export CSV (aby fungoval Excel -> BOM)
app.get("/api/export.csv", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  const rows = await getEventsFiltered(filters, limit);

  await backfillDurations(rows, 500);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.csv"`);

  const csvEscape = (v) => {
    const s = String(v ?? "");
    if (/[\",\n]/.test(s)) return `"${s.replace(/\"/g, '""')}"`;
    return s;
  };

  const header = ["čas", "stav", "typ", "město", "délka_min", "název", "odkaz"];
  let out = "\uFEFF" + header.map(csvEscape).join(",") + "\n";

  for (const r of rows) {
    out += [
      r.pub_date || "",
      r.is_closed ? "UKONČENO" : "AKTIVNÍ",
      r.event_type || "",
      r.city_text || r.place_text || "",
      r.duration_min ?? "",
      r.title || "",
      r.link || ""
    ]
      .map(csvEscape)
      .join(",") + "\n";
  }

  res.send(out);
});

// export PDF (diakritika přes DejaVuSans.ttf v assets/)
app.get("/api/export.pdf", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  const rows = await getEventsFiltered(filters, limit);

  await backfillDurations(rows, 500);

  const fontPath = path.join(__dirname, "assets", "DejaVuSans.ttf");
  if (!fs.existsSync(fontPath)) {
    return res.status(500).json({
      ok: false,
      error: "Missing font file",
      hint: "Expected: assets/DejaVuSans.ttf"
    });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.registerFont("DejaVu", fontPath);
  doc.font("DejaVu");

  doc.pipe(res);

  doc.fontSize(18).text("JPO výjezdy – export", { align: "left" });
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor("#333");
  doc.text(
    `Filtry: den=${filters.day} | typ=${filters.types.length ? filters.types.join(",") : "vše"} | město=${filters.city || "—"} | stav=${filters.status || "all"}`
  );

  doc.moveDown(0.8);

  doc.fontSize(10).fillColor("#000");

  const cols = [
    { name: "Čas", w: 90 },
    { name: "Stav", w: 65 },
    { name: "Typ", w: 55 },
    { name: "Město", w: 105 },
    { name: "Délka", w: 55 },
    { name: "Název", w: 160 }
  ];

  let x = doc.x;
  let y = doc.y;

  doc.fontSize(10).fillColor("#000");
  for (const c of cols) {
    doc.text(c.name, x, y, { width: c.w, continued: false });
    x += c.w;
  }

  y += 14;
  doc.moveTo(doc.x, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor("#aaa").stroke();
  y += 8;

  doc.strokeColor("#000").fillColor("#000");

  const rowH = 14;

  for (const r of rows) {
    const durText = r.duration_min != null ? `${r.duration_min} min` : "—";
    const row = [
      r.pub_date || "",
      r.is_closed ? "UKONČENO" : "AKTIVNÍ",
      r.event_type || "",
      r.city_text || r.place_text || "",
      durText,
      r.title || ""
    ];

    if (y > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      doc.font("DejaVu");
      y = doc.y;
    }

    x = doc.x;
    for (let i = 0; i < cols.length; i++) {
      doc.text(row[i], x, y, { width: cols[i].w, height: rowH, ellipsis: true });
      x += cols[i].w;
    }
    y += rowH;
  }

  doc.end();
});

// ---------- Backfill duration helper ----------
async function backfillDurations(rows, maxItems = 300) {
  let done = 0;
  for (const r of rows) {
    if (done >= maxItems) break;
    if (r.duration_min != null) continue;

    if (r.is_closed && r.start_time_iso && r.end_time_iso) {
      const computed = computeDurationMin(r.start_time_iso, r.end_time_iso);
      if (computed != null && computed > 0) {
        await updateEventDuration(r.id, computed);
        r.duration_min = computed;
        done++;
      }
    } else if (!r.is_closed) {
      // aktivní – necháme "—"
    } else {
      // ukončeno bez dat -> necháme null
    }
  }
}

// ---------- GEOCODE CACHE ----------
app.get("/api/geocache", requireKey, async (req, res) => {
  const key = String(req.query.key || "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "missing key" });
  const row = await getGeocache(key);
  res.json({ ok: true, row: row || null });
});

app.post("/api/geocache", requireKey, async (req, res) => {
  const key = String(req.body?.key || "").trim();
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  const source = String(req.body?.source || "").trim();

  if (!key || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ ok: false, error: "invalid payload" });
  }

  await setGeocache(key, lat, lon, source || null);
  res.json({ ok: true });
});

app.delete("/api/geocache", requireKey, async (req, res) => {
  const key = String(req.query.key || "").trim();
  if (!key) return res.status(400).json({ ok: false, error: "missing key" });
  const del = await deleteGeocache(key);
  res.json({ ok: true, deleted: del });
});

// ---------- ADMIN TOOLS ----------
app.post("/api/admin/coords", requireKey, async (req, res) => {
  const id = String(req.body?.id || "").trim();
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);

  if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ ok: false, error: "invalid payload" });
  }

  await updateEventCoords(id, lat, lon);
  res.json({ ok: true });
});

app.post("/api/admin/clear-coords", requireKey, async (req, res) => {
  const city = String(req.body?.city || "").trim();
  if (!city) return res.status(400).json({ ok: false, error: "missing city" });
  const n = await clearCoordsFor(city);
  res.json({ ok: true, cleared: n });
});

app.get("/api/admin/events-needing-geocode", requireKey, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const rows = await getEventsNeedingGeocode(limit);
  res.json({ ok: true, rows });
});

app.get("/api/admin/events-outside-cz", requireKey, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const rows = await getEventsOutsideCz(limit);
  res.json({ ok: true, rows });
});

app.get("/api/admin/first-seen", requireKey, async (req, res) => {
  const id = String(req.query.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "missing id" });
  const row = await getEventFirstSeen(id);
  res.json({ ok: true, row: row || null });
});

app.get("/api/admin/geocode-reset-city", requireKey, async (req, res) => {
  const city = String(req.query.city || "").trim();
  if (!city) return res.status(400).json({ ok: false, error: "missing city" });

  // 1) vynulovat souřadnice v events
  const coordsCleared = await clearCoordsFor(city);

  // 2) smazat geocache klíče obsahující město
  // (přesněji: procházíme seznam events needing geocode a delete cache z klíčů)
  const needing = await getEventsNeedingGeocode(2000);
  let cacheDeleted = 0;
  for (const r of needing) {
    const key = `${r.city_text || ""}|${r.place_text || ""}`.trim();
    if (key.toLowerCase().includes(city.toLowerCase())) {
      cacheDeleted += await deleteGeocache(key);
    }
  }

  // 3) re-geocode (vyžaduje externí geocoding – zde jen vrátíme seznam co je potřeba)
  const reGeocoded = 0;
  const failed = 0;

  res.json({
    ok: true,
    city,
    cache_deleted: cacheDeleted,
    coords_cleared: coordsCleared,
    re_geocoded: reGeocoded,
    failed
  });
});

app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
await initDb();

// ✅ AUTOMATICKÁ ÚDRŽBA (několikrát za den)
// - vynuluje extrémní délky (default 720 min)
// - pak přepočítá délky z časů start/end, pokud jde
// Pozn.: nezasahuje do mapy, statistik ani exportů – pouze opravuje duration_min.
const MAINT_MAX_MINUTES = Math.max(1, Math.min(Number(process.env.DURATION_MAX_MINUTES || 720), 43200));
const MAINT_EVERY_MS = Math.max(60_000, Number(process.env.DURATION_MAINT_INTERVAL_MS || 6 * 60 * 60 * 1000)); // default 6h

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

// první běh krátce po startu (až se vše nahodí)
setTimeout(() => runDurationMaintenance("startup"), 2 * 60 * 1000);
setInterval(() => runDurationMaintenance("interval"), MAINT_EVERY_MS);

app.listen(port, () => console.log(`listening on ${port}`));
