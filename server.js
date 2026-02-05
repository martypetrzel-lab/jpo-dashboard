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
  getEventMeta,
  updateEventDuration,
  getLongestCutoffIso
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "";

// ✅ stejný limit jako v db.js (fallback), aby se do DB neukládaly extrémy
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const key = String(req.headers["x-api-key"] || "");
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusEmoji(isClosed) {
  return isClosed ? "✅" : "🟥";
}

function classifyType(title = "") {
  const t = String(title).toLowerCase();

  if (t.includes("požár") || t.includes("pozar")) return "fire";
  if (t.includes("dopravní") || t.includes("nehoda") || t.includes("dopravni")) return "traffic";
  if (t.includes("technická") || t.includes("technicka")) return "tech";
  if (t.includes("záchrana") || t.includes("zachrana")) return "rescue";
  if (t.includes("planý poplach") || t.includes("plany poplach")) return "false_alarm";

  return "other";
}

function isDistrictPlace(placeText = "") {
  const p = String(placeText).toLowerCase();
  return p.includes("okres");
}

function extractDistrictFromDescription(descRaw = "") {
  const norm = String(descRaw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  const m = norm.match(/okres\s+([A-Za-zÁ-Žá-ž\s\-]+)/i);
  if (!m) return null;
  return String(m[1]).trim();
}

function extractCityFromDescription(descRaw = "") {
  const norm = String(descRaw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  const lines = norm.split("\n").map(l => l.trim()).filter(Boolean);

  // typicky poslední relevantní řádek (místo) bývá město
  // formáty: "Libušín" nebo "Velvary" apod.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const low = l.toLowerCase();
    if (low.startsWith("stav:")) continue;
    if (low.startsWith("ukončen")) continue;
    if (low.startsWith("vyhláš")) continue;
    if (low.startsWith("ohláš")) continue;
    if (low.startsWith("okres")) continue;
  }

  // vezmeme nejspíš "město" řádek: ten co není stav/ukončení/okres
  const candidates = lines.filter(l => {
    const n = l
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
    if (n.startsWith("stav:")) return false;
    if (n.startsWith("ukonc")) return false;
    if (n.startsWith("vyhlas")) return false;
    if (n.startsWith("ohlas")) return false;
    if (n.startsWith("okres")) return false;
    return true;
  });

  if (!candidates.length) return null;
  return candidates[candidates.length - 1] || null;
}

function extractCityFromTitle(title = "") {
  // formát: "požár - něco - Město"
  const parts = String(title).split(" - ").map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return null;
}

function geocodeKey(q) {
  return String(q || "").trim().toLowerCase();
}

// ✅ CZ bounding box – rychlá ochrana proti „Polsko / Německo“
function withinCz(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return !(lat < 48.55 || lat > 51.06 || lon < 12.09 || lon > 18.87);
}

async function geocodePlace(placeText) {
  const q = String(placeText || "").trim();
  if (!q) return null;

  const cached = await getCachedGeocode(q);
  if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) {
    return cached;
  }

  // Nominatim (public) – jednoduché; v reálu pro větší provoz ideálně vlastní key/provider
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "firewatchcz/1.0 (contact: info@firewatchcz)"
      }
    });

    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null;

    const lat = Number(data[0].lat);
    const lon = Number(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    // ✅ ochrana – neukládat mimo ČR
    if (!withinCz(lat, lon)) return null;

    await setCachedGeocode(q, lat, lon);
    return { lat, lon };
  } catch {
    return null;
  }
}

const months = {
  ledna: 1,
  února: 2,
  unora: 2,
  března: 3,
  brezna: 3,
  dubna: 4,
  května: 5,
  kvetna: 5,
  června: 6,
  cervna: 6,
  července: 7,
  cervence: 7,
  srpna: 8,
  září: 9,
  zari: 9,
  října: 10,
  rijna: 10,
  listopadu: 11,
  prosince: 12
};

function parseCzDateToIso(txt) {
  if (!txt) return null;
  const s = String(txt).trim();

  // "31. ledna 2026, 15:07"
  const m = s.match(/(\d{1,2})\.\s*([A-Za-zÁ-Žá-ž]+)\s*(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;

  const day = Number(m[1]);
  const monName = String(m[2]).toLowerCase();
  const year = Number(m[3]);
  const hh = Number(m[4] || "0");
  const mm = Number(m[5] || "0");

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

    // ✅ některé RSS mají jen "stav: ukončená" bez řádku "ukončení: ..."
    if (n.startsWith("stav:") && (n.includes("ukoncena") || n.includes("ukonceni") || n.includes("ukoncen"))) {
      isClosed = true;
    }

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

// ✅ fix na extrémní / nesmyslné délky
async function computeDurationMin(id, startIso, endIso, firstSeenAt, cutoffIso) {
  try {
    // ✅ jen "nové" od cutoff (aby se nepočítaly staré historické)
    const firstSeen = firstSeenAt || (await getEventFirstSeen(id));
    if (firstSeen && cutoffIso) {
      const fsMs = new Date(firstSeen).getTime();
      const cutMs = new Date(cutoffIso).getTime();
      if (Number.isFinite(fsMs) && Number.isFinite(cutMs) && fsMs < cutMs) return null;
    }

    const s = startIso ? new Date(startIso) : (firstSeen ? new Date(firstSeen) : null);
    const e = endIso ? new Date(endIso) : null;
    if (!s || !e) return null;

    const diffMin = Math.floor((e.getTime() - s.getTime()) / 60000);
    if (!Number.isFinite(diffMin) || diffMin <= 0) return null;
    if (diffMin > MAX_DURATION_MINUTES) return null;

    return diffMin;
  } catch {
    return null;
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

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      // ✅ meta z DB pro detekci přechodu "aktivní -> ukončené"
      const prev = await getEventMeta(it.id);

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const times = parseTimesFromDescription(desc);

      let startIso = it.startTimeIso || times.startIso || null;
      let endIso = it.endTimeIso || times.endIso || null;
      const isClosed = !!times.isClosed;

      // ✅ RSS občas vrací nesmyslné "ukončení" (např. budoucí datum).
      // Pravidlo:
      // - když vidíme přechod aktivní -> ukončená, bereme konec jako "teď"
      // - když už byla ukončená dřív, držíme existující end_time (a když chybí, dáme "teď")
      const nowIso = new Date().toISOString();
      const nowMs = Date.now();
      const FUTURE_TOL_MS = 5 * 60 * 1000; // 5 min tolerance

      const closingNow = isClosed && (!prev || !prev.is_closed);

      if (isClosed) {
        const endMs = endIso ? Date.parse(endIso) : NaN;
        const endIsFuture = Number.isFinite(endMs) && endMs > (nowMs + FUTURE_TOL_MS);

        if (closingNow) {
          // při prvním označení jako ukončené – vždy "teď" (bez ohledu na RSS datum)
          endIso = nowIso;
        } else {
          // už ukončené dřív: nepřepisujeme stabilní end_time, ale opravíme budoucí/nesmyslné hodnoty
          if (!endIso || endIsFuture) {
            endIso = prev?.end_time_iso || nowIso;
          }
        }
      }

      // ✅ když by byl konec před startem (nebo start chybí), necháme výpočet spadnout na first_seen_at
      if (startIso && endIso) {
        const sMs = Date.parse(startIso);
        const eMs = Date.parse(endIso);
        if (Number.isFinite(sMs) && Number.isFinite(eMs) && eMs < sMs) {
          startIso = null;
        }
      }

      let durationMin = null;
      if (Number.isFinite(it.durationMin)) {
        const candidate = Math.round(it.durationMin);
        durationMin = (candidate > 0 && candidate <= MAX_DURATION_MINUTES) ? candidate : null;
      } else if (isClosed && endIso) {
        // ✅ pro žebříček nejdelších zásahů počítáme pouze "nové" od nasazení této změny
        const cutoffIso = await getLongestCutoffIso();
        durationMin = await computeDurationMin(it.id, startIso, endIso, null, cutoffIso);
      }

      const placeText = it.placeText || null;
      const cityFromDesc = extractCityFromDescription(desc);
      const cityFromTitle = extractCityFromTitle(it.title);
      const districtFromDesc = extractDistrictFromDescription(desc);

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

      if (ev.isClosed) updatedClosed++;

      // ✅ zpřesnění polohy: nejdřív zkus "MĚSTO, okres OKRES", pak město, pak place_text
      const geoQueries = [];
      if (ev.cityText && districtFromDesc) geoQueries.push(`${ev.cityText}, okres ${districtFromDesc}`);
      if (ev.cityText) geoQueries.push(ev.cityText);
      if (ev.placeText && ev.placeText !== ev.cityText) geoQueries.push(ev.placeText);

      for (const q of geoQueries) {
        const g = await geocodePlace(q);
        if (g) {
          await updateEventCoords(ev.id, g.lat, g.lon);
          geocoded++;
          break;
        }
      }
    }

    res.json({
      ok: true,
      source: source || "unknown",
      accepted,
      closed_seen_in_batch: updatedClosed,
      geocoded
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// events (filters) + backfill coords + backfill duration
app.get("/api/events", async (req, res) => {
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 500)));

  const types = String(req.query.types || "").split(",").map(x => x.trim()).filter(Boolean);
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").toLowerCase();
  const day = String(req.query.day || "all").toLowerCase();
  const month = String(req.query.month || "").trim();

  const rows = await getEventsFiltered({ types, city, status, day, month }, limit);
  res.json({ ok: true, items: rows });
});

// stats
app.get("/api/stats", async (req, res) => {
  const types = String(req.query.types || "").split(",").map(x => x.trim()).filter(Boolean);
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").toLowerCase();
  const day = String(req.query.day || "all").toLowerCase();
  const month = String(req.query.month || "").trim();

  const stats = await getStatsFiltered({ types, city, status, day, month });
  res.json({
    ok: true,
    byDay: stats.byDay,
    byType: stats.byType,
    openCount: stats.openVsClosed?.open ?? 0,
    closedCount: stats.openVsClosed?.closed ?? 0,
    topCities: stats.topCities,
    longest: stats.longest
  });
});

// export CSV
app.get("/api/export.csv", async (req, res) => {
  const types = String(req.query.types || "").split(",").map(x => x.trim()).filter(Boolean);
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").toLowerCase();
  const day = String(req.query.day || "all").toLowerCase();
  const month = String(req.query.month || "").trim();

  const rows = await getEventsFiltered({ types, city, status, day, month }, 2000);

  const cols = [
    "id", "pub_date", "title", "city_text", "place_text", "event_type", "is_closed", "duration_min", "link"
  ];

  const lines = [cols.join(";")];
  for (const r of rows) {
    lines.push(cols.map(c => {
      const v = r[c];
      return `"${String(v ?? "").replace(/"/g, '""')}"`;
    }).join(";"));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=firewatchcz.csv");
  res.send(lines.join("\n"));
});

// export PDF
app.get("/api/export.pdf", async (req, res) => {
  const types = String(req.query.types || "").split(",").map(x => x.trim()).filter(Boolean);
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").toLowerCase();
  const day = String(req.query.day || "all").toLowerCase();
  const month = String(req.query.month || "").trim();

  const rows = await getEventsFiltered({ types, city, status, day, month }, 2000);

  const doc = new PDFDocument({ margin: 30, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=firewatchcz.pdf");
  doc.pipe(res);

  doc.fontSize(16).text("FirewatchCZ – export výjezdů", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Vygenerováno: ${new Date().toLocaleString("cs-CZ")}`);
  doc.moveDown(1);

  doc.fontSize(10).text(`Počet záznamů: ${rows.length}`);
  doc.moveDown(0.6);

  for (const r of rows) {
    const line =
      `${statusEmoji(r.is_closed)}  ${escapeHtml(r.title)}\n` +
      `Město: ${escapeHtml(r.city_text || r.place_text || "")} | Typ: ${escapeHtml(typeLabel(r.event_type))} | Délka: ${escapeHtml(String(r.duration_min ?? ""))} min\n` +
      `Čas: ${escapeHtml(r.pub_date || r.created_at || "")}\n` +
      `Odkaz: ${escapeHtml(r.link || "")}`;
    doc.text(line);
    doc.moveDown(0.8);
  }

  doc.end();
});

// debug – eventy mimo ČR (kontrola)
app.get("/api/debug/outside", async (req, res) => {
  const rows = await getEventsOutsideCz(200);
  res.json({ ok: true, items: rows });
});

// debug – smaž cache geocode konkrétního dotazu
app.delete("/api/geocode_cache", requireKey, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ ok: false, error: "q missing" });
  await deleteCachedGeocode(q);
  res.json({ ok: true });
});

// static
app.use(express.static(path.join(__dirname, "public")));

// init + start
await initDb();

app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});
