import express from "express";
import { initDb, upsertEvent, getEvents, getStats, exportCsv } from "./db.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- CORS (aby šel web i API v pohodě) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-API-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireKey(req, res, next) {
  const need = process.env.API_KEY || "";
  if (!need) return res.status(500).json({ ok: false, error: "API_KEY not configured" });

  const got = req.header("X-API-Key") || "";
  if (got !== need) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// --- helpers: text parsing + normalizace místa ---
function stripDiacritics(s = "") {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function cleanPlaceText(raw = "") {
  let s = String(raw || "").replace(/\s+/g, " ").trim();

  // často se v RSS objevuje "okres ..." nebo "část ..." – necháme, ale zkusíme vytáhnout město
  // odstraň přebytečné prefixy typu "Mladá Boleslav" OK, ale "okres Praha Východ" nechceme jako město
  s = s.replace(/^okres\s+/i, "");
  return s.trim();
}

function normalizeCity(rawPlace = "") {
  let s = cleanPlaceText(rawPlace);
  if (!s) return "";

  // když je tam " - " (např. "transport pacienta - Mladá Boleslav"), vezmi poslední část
  if (s.includes(" - ")) {
    const parts = s.split(" - ").map(x => x.trim()).filter(Boolean);
    if (parts.length) s = parts[parts.length - 1];
  }

  // když je tam čárka, často "Město, část" – vezmi první
  if (s.includes(",")) s = s.split(",")[0].trim();

  // když je to pořád něco jako "Praha Východ" z RSS, tak to není město
  // tak aspoň sjednoť běžné názvy
  s = s.replace(/Praha\s*Vychod/i, "okres Praha Východ");

  return s.trim();
}

function parseEndTimeFromDescription(desc = "") {
  const t = String(desc || "");

  // RSS má typicky: "ukončení: 31. ledna 2026, 15:07"
  // Zkusíme zachytit cokoliv za "ukončení:"
  const m = t.match(/ukonč(?:ení|eni)\s*:\s*([^<\n\r]+)/i);
  if (!m) return null;

  const raw = m[1].trim();
  // raw necháme jako text (server-side nebudeme složitě parsovat české měsíce),
  // ale duration počítáme aspoň fallbackem přes first_seen_at.
  return raw;
}

function isClosedByDescription(desc = "", statusText = "") {
  const d = String(desc || "").toLowerCase();
  const st = String(statusText || "").toLowerCase();

  if (d.includes("stav: ukon") || d.includes("ukončení:") || d.includes("ukonceni:")) return true;
  if (st.includes("ukon")) return true;
  return false;
}

// --- GEOCODING (Nominatim) ---
// lepší přesnost: countrycodes=cz + viewbox bias (CZ) + bounded=1
async function geocodeCZ(placeText = "") {
  const ua = process.env.GEOCODE_USER_AGENT || "jpo-dashboard/1.0";
  const p = cleanPlaceText(placeText);
  if (!p || p.length < 2) return null;

  const q = encodeURIComponent(`${p}, Czechia`);
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=json&limit=1` +
    `&countrycodes=cz` +
    `&bounded=1` +
    `&viewbox=12.0,51.2,19.0,48.5` + // zhruba ČR (minLon,maxLat,maxLon,minLat)
    `&q=${q}`;

  const r = await fetch(url, { headers: { "User-Agent": ua, "Accept": "application/json" } });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return null;

  const it = arr[0];
  const lat = Number(it.lat);
  const lon = Number(it.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// --- Static web ---
app.use(express.static("public"));

// --- API ---
app.get("/health", (req, res) => res.send("OK"));

app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 1000);
  const onlyActive = String(req.query.onlyActive || "") === "1";
  const rows = await getEvents(limit, onlyActive);
  res.json({ ok: true, items: rows });
});

app.get("/api/stats", async (req, res) => {
  const days = Number(req.query.days || 30);
  const stats = await getStats(days);
  res.json({ ok: true, ...stats });
});

app.get("/api/export.csv", async (req, res) => {
  const days = Number(req.query.days || 30);
  const rows = await exportCsv(days);

  // CSV
  const headers = [
    "id","title","link","place_text","place_norm","status_text","is_closed",
    "start_time_iso","end_time_iso","duration_min",
    "first_seen_at","last_seen_at","lat","lon"
  ];
  const escape = (v) => {
    const s = (v === null || v === undefined) ? "" : String(v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g,'""')}"`;
    return s;
  };

  let csv = headers.join(",") + "\n";
  for (const row of rows) {
    csv += headers.map(h => escape(row[h])).join(",") + "\n";
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_export_${days}d.csv"`);
  res.send(csv);
});

// ingest: batch
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const { source, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items[] required" });
    }

    let accepted = 0;
    let geocoded = 0;
    let updatedClosed = 0;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const placeText = it.placeText || "";
      const placeNorm = normalizeCity(placeText);

      const statusText = it.statusText || "";
      const desc = it.descriptionRaw || it.description || "";

      const closed = isClosedByDescription(desc, statusText) || !!it.isClosed;

      // end_time_iso necháme jako text z RSS (ukončení: ...)
      const endTimeIso = closed ? (it.endTimeIso || parseEndTimeFromDescription(desc)) : null;

      // duration: pokud nemáme start, použijeme first_seen_at (na DB straně) – tady jen držíme null
      // později můžeme přidat přesnější parsing "vyhlášení" apod.
      const row = {
        id: String(it.id),
        title: String(it.title),
        link: String(it.link),
        pubDate: it.pubDate || null,
        placeText,
        placeNorm,
        statusText,
        descriptionRaw: desc,
        isClosed: closed,
        startTimeIso: it.startTimeIso || null,
        endTimeIso: endTimeIso || null,
        durationMin: it.durationMin ?? null,
        lat: it.lat ?? null,
        lon: it.lon ?? null,
      };

      // geocoding jen když nemáme lat/lon
      if ((!row.lat || !row.lon) && placeText) {
        const g = await geocodeCZ(placeText);
        if (g) {
          row.lat = g.lat;
          row.lon = g.lon;
          geocoded++;
        }
      }

      const saved = await upsertEvent(row);
      accepted++;

      if (closed && saved?.is_closed) updatedClosed++;
    }

    res.json({
      ok: true,
      source: source || "unknown",
      accepted,
      closed_seen_in_batch: updatedClosed,
      geocoded,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

const port = process.env.PORT || 3000;
await initDb();
app.listen(port, () => console.log(`listening on ${port}`));
