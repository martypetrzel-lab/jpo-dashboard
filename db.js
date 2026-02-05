// db.js
// Postgres helper: schema bootstrap + safe upsert for events + filtering/stats + geocode cache
// FireWatch CZ / JPO Dashboard

import pg from "pg";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("[db] Missing DATABASE_URL env");
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.PGSSL === "false"
      ? false
      : {
          rejectUnauthorized: false,
        },
});

export async function dbPing() {
  const r = await pool.query("SELECT NOW() AS now");
  return r.rows?.[0]?.now;
}

async function ensureSchema() {
  // events + geocode cache + app meta (tracking_start)
  const sql = `
  CREATE TABLE IF NOT EXISTS events (
    id               TEXT PRIMARY KEY,

    title            TEXT,
    link             TEXT,
    pub_date         TIMESTAMPTZ,

    place_text       TEXT,
    city_text        TEXT,
    status_text      TEXT,
    event_type       TEXT,
    description_raw  TEXT,

    -- ISO stringy z RSS/ESP (drž jako TEXT, ať se nikdy nehádá typově)
    start_time_iso   TEXT,
    end_time_iso     TEXT,

    duration_min     INTEGER,
    is_closed        BOOLEAN NOT NULL DEFAULT FALSE,

    closed_detected_at TIMESTAMPTZ,

    -- coords
    lat              DOUBLE PRECISION,
    lon              DOUBLE PRECISION,

    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- pro upgrade starších DB
  ALTER TABLE events ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION;

  CREATE INDEX IF NOT EXISTS idx_events_pub_date ON events (pub_date DESC);
  CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events (last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_is_closed ON events (is_closed);
  CREATE INDEX IF NOT EXISTS idx_events_city_text ON events (city_text);
  CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);
  CREATE INDEX IF NOT EXISTS idx_events_first_seen ON events (first_seen_at DESC);

  CREATE TABLE IF NOT EXISTS geocode_cache (
    q          TEXT PRIMARY KEY,
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  `;
  await pool.query(sql);

  // tracking start: pokud není nastaveno, nastav teď (persistuje i přes restarty)
  await pool.query(
    `
    INSERT INTO app_meta (k, v)
    VALUES ('tracking_start_iso', $1)
    ON CONFLICT (k) DO NOTHING
    `,
    [new Date().toISOString()]
  );
}

export async function initDb() {
  await ensureSchema();
  await dbPing();
}

/**
 * Upsert event.
 *
 * event = {
 *  id: string,
 *  title?: string,
 *  link?: string,
 *  pubDate?: Date|string|null,
 *  placeText?: string|null,
 *  cityText?: string|null,
 *  statusText?: string|null,
 *  eventType?: string|null,
 *  descriptionRaw?: string|null,
 *  startTimeIso?: string|null,
 *  endTimeIso?: string|null,
 *  durationMin?: number|null,
 *  isClosed?: boolean,
 * }
 */
export async function upsertEvent(event, options = {}) {
  const maxDurationMin =
    Number.isFinite(options.maxDurationMin) ? options.maxDurationMin : 4320; // 3 dny (pojistka)

  // typová normalizace
  const id = String(event.id || "").trim();
  if (!id) throw new Error("upsertEvent: missing id");

  const isClosed = !!event.isClosed;

  // pub_date: ukládej jako timestamptz
  let pubDate = null;
  if (event.pubDate instanceof Date) pubDate = event.pubDate.toISOString();
  else if (typeof event.pubDate === "string" && event.pubDate.trim()) pubDate = event.pubDate.trim();

  const nowIso = new Date().toISOString(); // pro fallback end_time_iso (TEXT)

  // durationMin: jen číslo nebo null
  const durationMin =
    event.durationMin === 0
      ? 0
      : Number.isFinite(Number(event.durationMin))
      ? Number(event.durationMin)
      : null;

  const q = `
  INSERT INTO events (
    id, title, link, pub_date,
    place_text, city_text, status_text, event_type,
    description_raw,
    start_time_iso, end_time_iso,
    duration_min, is_closed,
    closed_detected_at,
    first_seen_at, last_seen_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,
    $5,$6,$7,$8,
    $9,
    $10::text,$11::text,
    $12::int,$13::boolean,
    CASE WHEN $13 = TRUE THEN NOW() ELSE NULL END,
    NOW(), NOW(), NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    link  = EXCLUDED.link,
    pub_date = COALESCE(EXCLUDED.pub_date, events.pub_date),

    place_text = COALESCE(EXCLUDED.place_text, events.place_text),
    city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),
    status_text = COALESCE(EXCLUDED.status_text, events.status_text),
    event_type  = COALESCE(EXCLUDED.event_type,  events.event_type),
    description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

    start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),

    -- end_time_iso (TEXT):
    -- 1) pokud přijde z RSS, vezmi ho
    -- 2) jinak při prvním uzavření nastav fallback ISO string (posíláme $15)
    -- 3) jinak nech původní
    end_time_iso = CASE
      WHEN EXCLUDED.end_time_iso IS NOT NULL THEN EXCLUDED.end_time_iso
      WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN $15::text
      ELSE events.end_time_iso
    END,

    -- duration:
    -- 1) když nový dur přijde, vezmi ho
    -- 2) když starý je extrémní, smaž ho (NULL)
    -- 3) jinak nech původní
    duration_min = CASE
      WHEN EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min
      WHEN events.duration_min IS NOT NULL AND events.duration_min > $14 THEN NULL
      ELSE events.duration_min
    END,

    -- uzavření je sticky (už jednou zavřený = zavřený)
    is_closed = (events.is_closed OR EXCLUDED.is_closed),

    -- closed_detected_at jen při prvním uzavření
    closed_detected_at = CASE
      WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN NOW()
      ELSE events.closed_detected_at
    END,

    last_seen_at = NOW(),
    updated_at = NOW()
  RETURNING id;
  `;

  const params = [
    id,
    event.title ?? null,
    event.link ?? null,
    pubDate, // $4

    event.placeText ?? null,
    event.cityText ?? null,
    event.statusText ?? null,
    event.eventType ?? null,

    event.descriptionRaw ?? null,

    event.startTimeIso ?? null, // $10
    event.endTimeIso ?? null,   // $11

    durationMin, // $12
    isClosed,    // $13

    maxDurationMin, // $14
    nowIso,         // $15 (fallback end_time_iso)
  ];

  const res = await pool.query(q, params);
  return res.rows?.[0]?.id;
}

// ---------- meta ----------
export async function getTrackingStartIso() {
  const r = await pool.query("SELECT v FROM app_meta WHERE k='tracking_start_iso' LIMIT 1");
  return r.rows?.[0]?.v || null;
}

// ---------- geocode cache ----------
export async function getCachedGeocode(q) {
  const qq = String(q || "").trim();
  if (!qq) return null;
  const r = await pool.query("SELECT q, lat, lon FROM geocode_cache WHERE q=$1 LIMIT 1", [qq]);
  return r.rows?.[0] || null;
}

export async function setCachedGeocode(q, lat, lon) {
  const qq = String(q || "").trim();
  if (!qq) return;
  await pool.query(
    `
    INSERT INTO geocode_cache (q, lat, lon, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (q) DO UPDATE SET
      lat=EXCLUDED.lat, lon=EXCLUDED.lon, updated_at=NOW()
    `,
    [qq, Number(lat), Number(lon)]
  );
}

export async function deleteCachedGeocode(q) {
  const qq = String(q || "").trim();
  if (!qq) return;
  await pool.query("DELETE FROM geocode_cache WHERE q=$1", [qq]);
}

// ---------- coords on events ----------
export async function updateEventCoords(id, lat, lon) {
  const evId = String(id || "").trim();
  if (!evId) return;
  await pool.query(
    "UPDATE events SET lat=$2, lon=$3, updated_at=NOW() WHERE id=$1",
    [evId, Number(lat), Number(lon)]
  );
}

export async function clearEventCoords(id) {
  const evId = String(id || "").trim();
  if (!evId) return;
  await pool.query("UPDATE events SET lat=NULL, lon=NULL, updated_at=NOW() WHERE id=$1", [evId]);
}

export async function getEventsOutsideCz(limit = 200) {
  const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
  // hrubý bbox ČR – stejné jako na serveru
  const r = await pool.query(
    `
    SELECT id, lat, lon
    FROM events
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND NOT (lat BETWEEN 48.55 AND 51.06 AND lon BETWEEN 12.09 AND 18.87)
    ORDER BY updated_at DESC
    LIMIT $1
    `,
    [lim]
  );
  return r.rows || [];
}

// ---------- duration helpers ----------
export async function getEventFirstSeen(id) {
  const evId = String(id || "").trim();
  if (!evId) return null;
  const r = await pool.query("SELECT first_seen_at FROM events WHERE id=$1 LIMIT 1", [evId]);
  return r.rows?.[0]?.first_seen_at || null;
}

export async function updateEventDuration(id, durationMin) {
  const evId = String(id || "").trim();
  if (!evId) return;
  const d = Number(durationMin);
  if (!Number.isFinite(d) || d <= 0) return;
  await pool.query(
    `
    UPDATE events
    SET duration_min=$2, updated_at=NOW()
    WHERE id=$1
    `,
    [evId, Math.round(d)]
  );
}

// ---------- filtering ----------
const STC_BOUNDS = { minLat: 49.2, maxLat: 50.8, minLon: 13.1, maxLon: 15.8 };

function eventTimeExpr() {
  return `COALESCE(
    CASE
      WHEN start_time_iso ~ '^\\d{4}-\\d{2}-\\d{2}' THEN start_time_iso::timestamptz
      ELSE NULL
    END,
    pub_date
  )`;
}
function normalizeDay(day) {
  const d = String(day || "all").trim().toLowerCase();
  if (d === "today" || d === "yesterday" || d === "all") return d;
  return "all";
}

function normalizeStatus(status) {
  const s = String(status || "all").trim().toLowerCase();
  if (s === "open" || s === "closed" || s === "all") return s;
  return "all";
}

export async function getEventsFiltered(filters = {}, limit = 400) {
  const lim = Math.max(1, Math.min(5000, Number(limit) || 400));

  const day = normalizeDay(filters.day);
  const status = normalizeStatus(filters.status);
  const city = String(filters.city || "").trim();
  const month = String(filters.month || "").trim(); // YYYY-MM
  const types = Array.isArray(filters.types) ? filters.types.map((x) => String(x).trim()).filter(Boolean) : [];

  const wh = [];
  const params = [];
  const eventTime = eventTimeExpr();

  // day filter: podle pub_date v timezone Praha
  if (day !== "all") {
    // porovnáváme DATE(event_time AT TIME ZONE ...)
    const target = day === "today" ? "CURRENT_DATE" : "(CURRENT_DATE - INTERVAL '1 day')";
    wh.push(`DATE(${eventTime} AT TIME ZONE 'Europe/Prague') = ${target}`);
  }

  if (status === "open") wh.push("is_closed = FALSE");
  if (status === "closed") wh.push("is_closed = TRUE");

  if (city) {
    params.push(`%${city}%`);
    wh.push(`COALESCE(city_text, place_text, '') ILIKE $${params.length}`);
  }

  if (month && /^\\d{4}-\\d{2}$/.test(month)) {
    // měsíc podle Prahy
    params.push(month);
    wh.push(`to_char((${eventTime} AT TIME ZONE 'Europe/Prague'), 'YYYY-MM') = $${params.length}`);
  }

  if (types.length > 0) {
    params.push(types);
    wh.push(`event_type = ANY($${params.length}::text[])`);
  }

  // omez na Středočeský kraj (pokud jsou coords známé)
  wh.push(
    `(lat IS NULL OR lon IS NULL OR (lat BETWEEN ${STC_BOUNDS.minLat} AND ${STC_BOUNDS.maxLat} AND lon BETWEEN ${STC_BOUNDS.minLon} AND ${STC_BOUNDS.maxLon}))`
  );

  const whereSql = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

  const q = `
    SELECT *
    FROM events
    ${whereSql}
    ORDER BY ${eventTime} DESC NULLS LAST, pub_date DESC NULLS LAST, last_seen_at DESC
    LIMIT ${lim}
  `;
  const r = await pool.query(q, params);
  return r.rows || [];
}

// ---------- stats ----------
export async function getStatsFiltered(filters = {}) {
  const day = normalizeDay(filters.day);
  const status = normalizeStatus(filters.status);
  const city = String(filters.city || "").trim();
  const month = String(filters.month || "").trim();
  const types = Array.isArray(filters.types) ? filters.types.map((x) => String(x).trim()).filter(Boolean) : [];

  const wh = [];
  const params = [];
  const eventTime = eventTimeExpr();

  if (day !== "all") {
    const target = day === "today" ? "CURRENT_DATE" : "(CURRENT_DATE - INTERVAL '1 day')";
    wh.push(`DATE(${eventTime} AT TIME ZONE 'Europe/Prague') = ${target}`);
  }
  if (status === "open") wh.push("is_closed = FALSE");
  if (status === "closed") wh.push("is_closed = TRUE");
  if (city) {
    params.push(`%${city}%`);
    wh.push(`COALESCE(city_text, place_text, '') ILIKE $${params.length}`);
  }
  if (month && /^\\d{4}-\\d{2}$/.test(month)) {
    params.push(month);
    wh.push(`to_char((${eventTime} AT TIME ZONE 'Europe/Prague'), 'YYYY-MM') = $${params.length}`);
  }
  if (types.length > 0) {
    params.push(types);
    wh.push(`event_type = ANY($${params.length}::text[])`);
  }

  // omez na Středočeský kraj (pokud jsou coords známé)
  wh.push(
    `(lat IS NULL OR lon IS NULL OR (lat BETWEEN ${STC_BOUNDS.minLat} AND ${STC_BOUNDS.maxLat} AND lon BETWEEN ${STC_BOUNDS.minLon} AND ${STC_BOUNDS.maxLon}))`
  );

  const whereSql = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

  // counts (respektují filtry)
  const openQ = `SELECT COUNT(*)::int AS c FROM events ${whereSql}${whereSql ? " AND" : " WHERE"} is_closed=FALSE`;
  const closedQ = `SELECT COUNT(*)::int AS c FROM events ${whereSql}${whereSql ? " AND" : " WHERE"} is_closed=TRUE`;

  // by day (respektuje filtry, ale seskupí)
  const byDayQ = `
    SELECT
      to_char(DATE(${eventTime} AT TIME ZONE 'Europe/Prague'), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 31
  `;

  // top cities – ZÁMĚRNĚ ze všech výjezdů (ignoruje UI filtry)
  const topCitiesQ = `
    SELECT
      COALESCE(NULLIF(TRIM(city_text), ''), NULLIF(TRIM(place_text), ''), 'Neznámé') AS city,
      COUNT(*)::int AS count
    FROM events
    WHERE (lat IS NULL OR lon IS NULL OR (lat BETWEEN ${STC_BOUNDS.minLat} AND ${STC_BOUNDS.maxLat} AND lon BETWEEN ${STC_BOUNDS.minLon} AND ${STC_BOUNDS.maxLon}))
    GROUP BY 1
    ORDER BY count DESC, city ASC
    LIMIT 20
  `;

  // nejdelší zásahy – jen nové od tracking_start
  const trackingIso = await getTrackingStartIso();
  const longestParams = [];
  let longestWhere = "WHERE is_closed=TRUE AND duration_min IS NOT NULL AND duration_min > 0";
  if (trackingIso) {
    longestParams.push(trackingIso);
    // first_seen_at je spolehlivý "od teď" a nepůjde do extrémů backlogu
    longestWhere += ` AND first_seen_at >= $${longestParams.length}::timestamptz`;
    // navíc pojistka: pokud existuje start_time_iso, tak musí být také >= tracking
    longestParams.push(trackingIso);
    longestWhere += ` AND (start_time_iso IS NULL OR (start_time_iso ~ '^\\d{4}-\\d{2}-\\d{2}' AND start_time_iso::timestamptz >= $${longestParams.length}::timestamptz))`;
  }
  longestWhere += ` AND (lat IS NULL OR lon IS NULL OR (lat BETWEEN ${STC_BOUNDS.minLat} AND ${STC_BOUNDS.maxLat} AND lon BETWEEN ${STC_BOUNDS.minLon} AND ${STC_BOUNDS.maxLon}))`;
  const longestQ = `
    SELECT
      id, title, link, city_text, place_text, duration_min, start_time_iso, end_time_iso, pub_date
    FROM events
    ${longestWhere}
    ORDER BY duration_min DESC
    LIMIT 20
  `;

  const [openR, closedR, byDayR, topCitiesR, longestR] = await Promise.all([
    pool.query(openQ, params),
    pool.query(closedQ, params),
    pool.query(byDayQ, params),
    pool.query(topCitiesQ),
    pool.query(longestQ, longestParams),
  ]);

  return {
    openCount: openR.rows?.[0]?.c ?? 0,
    closedCount: closedR.rows?.[0]?.c ?? 0,
    byDay: byDayR.rows || [],
    topCities: topCitiesR.rows || [],
    longest: longestR.rows || [],
    trackingStartIso: trackingIso || null,
  };
}

export async function close() {
  await pool.end();
}
