// db.js (ESM)
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

export function normText(s = "") {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // pryč diakritika
    .replace(/\s+/g, " ")
    .trim();
}

// Lepší normalizace místa – odstraňuje bordel typu "okres", závorky, pomlčky apod.
export function normPlace(place = "") {
  let s = String(place || "");
  s = s.replace(/\r/g, " ").replace(/\n/g, " ");
  s = s.replace(/\(.*?\)/g, " ");            // pryč závorky
  s = s.replace(/\bokres\b/gi, " ");
  s = s.replace(/\bkraj\b/gi, " ");
  s = s.replace(/\bobec\b/gi, " ");
  s = s.replace(/\bcast obce\b/gi, " ");
  s = s.replace(/\bcast\b/gi, " ");
  s = s.replace(/\bmunicipalita\b/gi, " ");
  s = s.replace(/[–—-]/g, " ");              // pomlčky
  s = s.replace(/[,:;]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = normText(s);

  // Častý pattern v datech: "okres praha vychod" apod → necháme jako jeden token
  s = s.replace(/\bpraha vychod\b/g, "praha vychod");

  return s;
}

// Detekce typu události podle title
export function detectKind(title = "") {
  const t = normText(title);
  if (t.includes("pozar") || t.includes("požár")) return "pozar";
  if (t.includes("dopravni nehoda") || t.includes("nehoda")) return "nehoda";
  if (t.includes("technicka") || t.includes("technická")) return "technicka";
  if (t.includes("zachrana") || t.includes("záchrana") || t.includes("vyprost")) return "zachrana";
  return "jine";
}

// pokus vytáhnout datum ukončení ze description_raw (česky)
function parseCzDatetimeFromText(descRaw = "") {
  // typicky: "ukončení: 31. ledna 2026, 15:07"
  const raw = String(descRaw || "");
  const m = raw.match(/ukončen[íi]\s*:\s*([0-9]{1,2})\.\s*([^\s]+)\s*([0-9]{4}),\s*([0-9]{1,2}):([0-9]{2})/i);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const monName = normText(m[2]);
  const year = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10);
  const mm = parseInt(m[5], 10);

  const months = {
    ledna: 1, leden: 1,
    unora: 2, února: 2, unor: 2, únor: 2,
    brezna: 3, března: 3, brezen: 3, březen: 3,
    dubna: 4, duben: 4,
    kvetna: 5, května: 5, kveten: 5, květen: 5,
    cervna: 6, června: 6, cerven: 6, červen: 6,
    cervence: 7, července: 7, cervenec: 7, červenec: 7,
    srpna: 8, srpen: 8,
    zari: 9, září: 9,
    rijna: 10, října: 10, rijen: 10, říjen: 10,
    listopadu: 11, listopad: 11,
    prosince: 12, prosinec: 12
  };

  const mon = months[monName];
  if (!mon || !day || !year) return null;

  // vytvoříme ISO v Europe/Prague offsetu nejjednodušeji jako UTC z “lokálního”
  // (neřešíme přesně DST, pro délku zásahu to je OK; pokud chceš 100% DST přesnost, doladíme)
  const dt = new Date(Date.UTC(year, mon - 1, day, hh - 1, mm, 0)); // přibližný posun CET
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id              text PRIMARY KEY,
      title           text,
      link            text,
      place_text      text,
      status_text     text,
      description_raw text
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS geocache (
      place_norm text PRIMARY KEY,
      lat double precision,
      lon double precision,
      provider text,
      updated_at timestamptz DEFAULT now()
    );
  `);

  // migrace sloupců
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS place_norm text;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS status_norm text;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS pub_date timestamptz;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS opened_at timestamptz;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS closed_at timestamptz;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS duration_sec integer;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS is_closed boolean DEFAULT false;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS lat double precision;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS lon double precision;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS kind text;`);

  // indexy
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_is_closed ON events (is_closed);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_opened_at ON events (opened_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_place_norm ON events (place_norm);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_updated_at ON events (updated_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind);`);
}

async function getGeocache(placeNorm) {
  const r = await pool.query(`SELECT lat, lon FROM geocache WHERE place_norm=$1`, [placeNorm]);
  if (r.rowCount === 0) return null;
  return { lat: r.rows[0].lat, lon: r.rows[0].lon };
}

async function setGeocache(placeNorm, lat, lon, provider = "nominatim") {
  await pool.query(
    `INSERT INTO geocache(place_norm, lat, lon, provider, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT(place_norm) DO UPDATE SET
       lat=EXCLUDED.lat, lon=EXCLUDED.lon, provider=EXCLUDED.provider, updated_at=now()`,
    [placeNorm, lat, lon, provider]
  );
}

async function geocodeNominatim(placeNorm) {
  // Nominatim: musí být slušný User-Agent
  const q = encodeURIComponent(placeNorm + ", Czechia");
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`;

  const r = await fetch(url, {
    headers: {
      "User-Agent": "jpo-dashboard/1.1 (contact: your-email@example.com)",
      "Accept": "application/json"
    }
  });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;

  const lat = parseFloat(arr[0].lat);
  const lon = parseFloat(arr[0].lon);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon };
}

export async function upsertEvent(e) {
  const id = String(e.id || "").trim();
  if (!id) return { upserted: false, reason: "missing id" };

  const title = e.title ?? null;
  const link = e.link ?? null;
  const placeText = e.placeText ?? null;
  const statusText = e.statusText ?? null;
  const descRaw = e.descriptionRaw ?? null;

  const placeNorm = normPlace(placeText || "");
  const statusNorm = normText(statusText);

  let pubDate = null;
  if (e.pubDate) {
    const d = new Date(e.pubDate);
    if (!isNaN(d.getTime())) pubDate = d.toISOString();
  }

  const kind = detectKind(title || "");

  // active/closed heuristika
  const st = statusNorm;
  const isClosed = st.includes("ukonc") || st.includes("ukoncen") || st.includes("ukoncena") || st.includes("ukoncená");
  const closedAtFromDesc = isClosed ? parseCzDatetimeFromText(descRaw || "") : null;

  // geocode: nejdřív cache → pak nomin. (jen když máme smysluplné placeNorm)
  let lat = null, lon = null;
  if (placeNorm && placeNorm.length >= 2) {
    const cached = await getGeocache(placeNorm);
    if (cached) {
      lat = cached.lat;
      lon = cached.lon;
    } else {
      const geo = await geocodeNominatim(placeNorm);
      if (geo) {
        lat = geo.lat;
        lon = geo.lon;
        await setGeocache(placeNorm, lat, lon, "nominatim");
      }
    }
  }

  const q = `
    INSERT INTO events (
      id, title, link, place_text, status_text, description_raw,
      place_norm, status_norm, pub_date,
      opened_at, closed_at, is_closed, duration_sec, updated_at,
      lat, lon, kind
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,
      COALESCE($9, now()),
      $10,
      $11,
      NULL,
      now(),
      $12, $13, $14
    )
    ON CONFLICT (id) DO UPDATE SET
      title           = EXCLUDED.title,
      link            = EXCLUDED.link,
      place_text      = EXCLUDED.place_text,
      status_text     = EXCLUDED.status_text,
      description_raw = EXCLUDED.description_raw,
      place_norm      = EXCLUDED.place_norm,
      status_norm     = EXCLUDED.status_norm,
      pub_date        = COALESCE(events.pub_date, EXCLUDED.pub_date),
      is_closed       = EXCLUDED.is_closed,
      closed_at       = CASE
                        WHEN EXCLUDED.is_closed = true AND events.closed_at IS NULL THEN COALESCE(EXCLUDED.closed_at, now())
                        WHEN EXCLUDED.is_closed = true AND events.closed_at IS NOT NULL THEN events.closed_at
                        ELSE events.closed_at
                       END,
      lat             = COALESCE(events.lat, EXCLUDED.lat),
      lon             = COALESCE(events.lon, EXCLUDED.lon),
      kind            = COALESCE(EXCLUDED.kind, events.kind),
      duration_sec    = CASE
                        WHEN (CASE
                              WHEN EXCLUDED.is_closed = true AND events.closed_at IS NULL THEN COALESCE(EXCLUDED.closed_at, now())
                              ELSE events.closed_at
                             END) IS NOT NULL
                             AND events.opened_at IS NOT NULL
                        THEN EXTRACT(EPOCH FROM (
                          (CASE
                            WHEN EXCLUDED.is_closed = true AND events.closed_at IS NULL THEN COALESCE(EXCLUDED.closed_at, now())
                            ELSE events.closed_at
                           END) - events.opened_at
                        ))::int
                        ELSE events.duration_sec
                       END,
      updated_at      = now()
    RETURNING id, is_closed, opened_at, closed_at, duration_sec, lat, lon, kind;
  `;

  const r = await pool.query(q, [
    id, title, link, placeText, statusText, descRaw,
    placeNorm, statusNorm, pubDate,
    closedAtFromDesc, isClosed,
    lat, lon, kind
  ]);

  return { upserted: true, row: r.rows[0] };
}

export async function getEvents({ limit = 500, active = null, kind = null } = {}) {
  const l = Math.max(1, Math.min(Number(limit) || 200, 2000));

  const where = [];
  const params = [];
  let p = 1;

  if (active === true) {
    where.push(`is_closed = false`);
  } else if (active === false) {
    where.push(`is_closed = true`);
  }

  if (kind && String(kind).trim()) {
    where.push(`kind = $${p++}`);
    params.push(String(kind));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const r = await pool.query(
    `
    SELECT *
    FROM events
    ${whereSql}
    ORDER BY opened_at DESC NULLS LAST, updated_at DESC
    LIMIT ${l}
    `,
    params
  );

  return r.rows;
}

export async function getStats(days = 30) {
  const d = Math.max(1, Math.min(Number(days) || 30, 365));

  const r = await pool.query(
    `
    WITH base AS (
      SELECT *
      FROM events
      WHERE opened_at >= now() - ($1::int || ' days')::interval
    ),
    by_day AS (
      SELECT to_char(date_trunc('day', opened_at), 'YYYY-MM-DD') AS day,
             count(*)::int AS cnt
      FROM base
      GROUP BY 1
      ORDER BY 1
    ),
    by_hour AS (
      SELECT to_char(date_trunc('hour', opened_at), 'YYYY-MM-DD HH24:00') AS hour,
             count(*)::int AS cnt
      FROM base
      GROUP BY 1
      ORDER BY 1
    ),
    by_city AS (
      SELECT COALESCE(NULLIF(place_text,''), 'Neznámé') AS city,
             count(*)::int AS cnt
      FROM base
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    ),
    top_city AS (
      SELECT COALESCE(NULLIF(place_text,''), 'Neznámé') AS city, count(*)::int AS cnt
      FROM base
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 1
    ),
    longest AS (
      SELECT id, title, link, place_text, status_text, opened_at, closed_at, duration_sec, kind
      FROM events
      WHERE duration_sec IS NOT NULL
      ORDER BY duration_sec DESC
      LIMIT 10
    ),
    active_cnt AS (
      SELECT count(*)::int AS cnt FROM events WHERE is_closed = false
    ),
    closed_cnt AS (
      SELECT count(*)::int AS cnt FROM events WHERE is_closed = true
    )
    SELECT
      (SELECT json_agg(by_day) FROM by_day) AS by_day,
      (SELECT json_agg(by_hour) FROM by_hour) AS by_hour,
      (SELECT json_agg(by_city) FROM by_city) AS top_cities,
      (SELECT row_to_json(top_city) FROM top_city) AS top_city,
      (SELECT json_agg(longest) FROM longest) AS longest,
      (SELECT cnt FROM active_cnt) AS active_count,
      (SELECT cnt FROM closed_cnt) AS closed_count
    `,
    [d]
  );

  return r.rows[0] || {};
}

export async function exportCsv({ from = null, to = null } = {}) {
  // jednoduchý export z DB (ISO rozsah)
  const where = [];
  const params = [];
  let p = 1;

  if (from) {
    where.push(`opened_at >= $${p++}`);
    params.push(from);
  }
  if (to) {
    where.push(`opened_at <= $${p++}`);
    params.push(to);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const r = await pool.query(
    `
    SELECT
      id, title, link, place_text, status_text, kind,
      opened_at, closed_at, duration_sec, is_closed, lat, lon
    FROM events
    ${whereSql}
    ORDER BY opened_at DESC NULLS LAST
    `,
    params
  );

  // CSV header
  const header = [
    "id","title","link","place_text","status_text","kind",
    "opened_at","closed_at","duration_sec","is_closed","lat","lon"
  ].join(",");

  const lines = [header];

  for (const row of r.rows) {
    const vals = [
      row.id,
      row.title,
      row.link,
      row.place_text,
      row.status_text,
      row.kind,
      row.opened_at ? new Date(row.opened_at).toISOString() : "",
      row.closed_at ? new Date(row.closed_at).toISOString() : "",
      row.duration_sec ?? "",
      row.is_closed ?? "",
      row.lat ?? "",
      row.lon ?? ""
    ].map(v => {
      const s = String(v ?? "");
      // CSV escape
      if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
        return `"${s.replace(/"/g, "\"\"")}"`;
      }
      return s;
    });

    lines.push(vals.join(","));
  }

  return lines.join("\n");
}
