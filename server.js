import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  initDb,
  clearBadDurations,
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
const GEOCODE_UA = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.7 (contact: missing)";

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

async function computeDurationMin(id, startIso, endIso) {
  const start = startIso ? new Date(startIso).getTime() : null;
  const end = endIso ? new Date(endIso).getTime() : null;

  if (!Number.isFinite(end)) return null;

  const startMs = Number.isFinite(start) ? start : null;
  if (startMs == null) return null;

  const dur = Math.round((end - startMs) / 60000);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  return dur;
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

// ingest (data z RSS / ESP)
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const { source, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items missing" });
    }

    let accepted = 0;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const times = parseTimesFromDescription(desc);

      const durationMin =
        Number.isFinite(it.durationMin)
          ? it.durationMin
          : await computeDurationMin(it.id, it.startTimeIso || times.startIso, it.endTimeIso || times.endIso);

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
        startTimeIso: it.startTimeIso || times.startIso || null,
        endTimeIso: it.endTimeIso || times.endIso || null,
        durationMin,
        isClosed: !!times.isClosed
      };

      await upsertEvent(ev);
      accepted++;

      const geoQuery = ev.cityText || ev.placeText;
      if (geoQuery) {
        const g = await geocodePlace(geoQuery);
        if (g) {
          await updateEventCoords(ev.id, g.lat, g.lon);
        }
      }
    }

    res.json({
      ok: true,
      source: source || "unknown",
      accepted
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// ✅ events (filters) — TADY JE KLÍČOVÁ OPRAVA: default day="today"
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = {
    day: String(req.query.day || "today").trim() || "today",
    types: (String(req.query.type || "").trim() ? String(req.query.type).split(",").map(s => s.trim()).filter(Boolean) : []),
    city: String(req.query.city || "").trim(),
    status: (["all", "open", "closed"].includes(String(req.query.status || "all").toLowerCase()) ? String(req.query.status || "all").toLowerCase() : "all")
  };

  const rows = await getEventsFiltered(filters, limit);
  res.json({ ok: true, filters, items: rows });
});

// stats (filters) — ponecháváme jak je, jen bereme day parametr (UI ho posílá)
app.get("/api/stats", async (req, res) => {
  const filters = {
    day: String(req.query.day || "today").trim() || "today",
    types: (String(req.query.type || "").trim() ? String(req.query.type).split(",").map(s => s.trim()).filter(Boolean) : []),
    city: String(req.query.city || "").trim(),
    status: (["all", "open", "closed"].includes(String(req.query.status || "all").toLowerCase()) ? String(req.query.status || "all").toLowerCase() : "all"),
    month: String(req.query.month || "").trim()
  };

  const stats = await getStatsFiltered(filters);
  res.json({ ok: true, filters, ...stats });
});

// CSV export
app.get("/api/export.csv", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 2000), 5000);
    const filters = {
      day: String(req.query.day || "today").trim() || "today",
      types: (String(req.query.type || "").trim() ? String(req.query.type).split(",").map(s => s.trim()).filter(Boolean) : []),
      city: String(req.query.city || "").trim(),
      status: (["all", "open", "closed"].includes(String(req.query.status || "all").toLowerCase()) ? String(req.query.status || "all").toLowerCase() : "all")
    };

    const rows = await getEventsFiltered(filters, limit);

    const header = ["time", "type", "title", "city", "state", "duration_min", "link"];
    const lines = [header.join(",")];

    for (const r of rows) {
      const d = new Date(r.pub_date || r.created_at);
      const timeText = Number.isNaN(d.getTime()) ? String(r.pub_date || r.created_at || "") : d.toLocaleString("cs-CZ");
      const state = r.is_closed ? "UKONCENO" : "AKTIVNI";
      const typ = String(r.event_type || "other");
      const city = String(r.city_text || r.place_text || "");
      const dur = Number.isFinite(r.duration_min) ? String(r.duration_min) : "";
      const link = String(r.link || "");

      const row = [
        timeText,
        typ,
        String(r.title || "").replaceAll('"', '""'),
        city.replaceAll('"', '""'),
        state,
        dur,
        link
      ];

      lines.push(row.map(v => `"${String(v)}"`).join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=jpo_export.csv");
    res.send(lines.join("\n"));
  } catch (e) {
    console.error(e);
    res.status(500).send("export failed");
  }
});

// PDF export
app.get("/api/export.pdf", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 1200), 2000);
    const filters = {
      day: String(req.query.day || "today").trim() || "today",
      types: (String(req.query.type || "").trim() ? String(req.query.type).split(",").map(s => s.trim()).filter(Boolean) : []),
      city: String(req.query.city || "").trim(),
      status: (["all", "open", "closed"].includes(String(req.query.status || "all").toLowerCase()) ? String(req.query.status || "all").toLowerCase() : "all")
    };

    const rows = await getEventsFiltered(filters, limit);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=jpo_export.pdf");

    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
    doc.pipe(res);

    doc.fontSize(16).fillColor("#111").text("JPO výjezdy – export", { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#555").text(`Filtry: den=${filters.day} | typ=${filters.types.join("|") || "vše"} | město=${filters.city || "vše"} | stav=${filters.status}`, { align: "left" });
    doc.moveDown(0.5);

    const startX = doc.x;
    let y = doc.y;

    const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const col = {
      time: Math.floor(tableWidth * 0.14),
      state: Math.floor(tableWidth * 0.09),
      type: Math.floor(tableWidth * 0.08),
      city: Math.floor(tableWidth * 0.14),
      dur: Math.floor(tableWidth * 0.09),
      title: tableWidth - (Math.floor(tableWidth * 0.14) + Math.floor(tableWidth * 0.09) + Math.floor(tableWidth * 0.08) + Math.floor(tableWidth * 0.14) + Math.floor(tableWidth * 0.09))
    };

    function drawHeader() {
      doc.fontSize(9).fillColor("#000");

      doc.text("Čas", startX, y, { width: col.time });
      doc.text("Stav", startX + col.time, y, { width: col.state });
      doc.text("Typ", startX + col.time + col.state, y, { width: col.type });
      doc.text("Město", startX + col.time + col.state + col.type, y, { width: col.city });
      doc.text("Délka", startX + col.time + col.state + col.type + col.city, y, { width: col.dur });
      doc.text("Název", startX + col.time + col.state + col.type + col.city + col.dur, y, { width: col.title });

      y += 12;
      doc.moveTo(startX, y).lineTo(startX + tableWidth, y).strokeColor("#999").stroke();
      y += 8;
    }

    function rowHeightFor(rowObj) {
      doc.fontSize(9);
      const d = new Date(rowObj.pub_date || rowObj.created_at);
      const timeText = Number.isNaN(d.getTime()) ? String(rowObj.pub_date || rowObj.created_at || "") : d.toLocaleString("cs-CZ");
      const state = rowObj.is_closed ? "UKONČENO" : "AKTIVNÍ";
      const typ = String(rowObj.event_type || "other");
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
      const typ = String(rowObj.event_type || "other");
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
  } catch (e) {
    console.error(e);
    res.status(500).send("pdf export failed");
  }
});

app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
await initDb();
app.listen(port, () => console.log(`listening on ${port}`));
