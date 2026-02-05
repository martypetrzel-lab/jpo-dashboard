import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn("⚠️ DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.PGSSL === "false"
      ? false
      : process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// ISO string (UTC) bez milisekund
function nowIsoUtcText() {
  return new Date().toISOString().replace(".000Z", "Z");
}

// -------------------------
// INIT DB
// -------------------------
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,

      title TEXT,
      link TEXT,
      pub_date TEXT,

      place_text TEXT,
      city_text TEXT,
      status_text TEXT,
      event_type TEXT,
      description_raw TEXT,

      start_time_iso TEXT,
      end_time_iso TEXT,

      duration_min INT,
      is_closed BOOLEAN NOT NULL DEFAULT FALSE,
      closed_detected_at TIMESTAMPTZ,

      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,

      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      q TEXT PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_created_at   ON events (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_last_seen_at ON events (last_seen_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_is_closed    ON events (is_closed);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_event_type   ON events (event_type);`);
}

// -------------------------
// UPSERT EVENT
// -------------------------
export async function upsertEvent(ev) {
  const {
    id,
    title,
    link,
    pubDate,
    placeText,
    cityText,
    statusText,
    eventType,
    descriptionRaw,
    startTimeIso,
    endTimeIso,
    durationMin,
    isClosed,
  } = ev;

  const MAX_DUR = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320));

  // DŮLEŽITÉ: end_time_iso je TEXT -> když nemáme endIso a dojde k prvnímu uzavření,
  // nastavíme ho jako ISO string (UTC) = text. Ne NOW().
  const closeNowIso = nowIsoUtcText();

  const q = `
    INSERT INTO events (
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso,
      duration_min, is_closed,
      closed_detected_at,
      first_seen_at, last_seen_at, updated_at, created_at
    )
    VALUES (
      $1,$2,$3,$4,
      $5,$6,$7,$8,
      $9,
      $10::text,
      $11::text,
      $12::int,
      $13::boolean,
      CASE WHEN $13 = TRUE THEN NOW() ELSE NULL END,
      NOW(), NOW(), NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      pub_date = EXCLUDED.pub_date,

      place_text = COALESCE(EXCLUDED.place_text, events.place_text),
      city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),

      status_text = COALESCE(EXCLUDED.status_text, events.status_text),
      event_type  = COALESCE(EXCLUDED.event_type,  events.event_type),
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),

      -- end_time_iso (TEXT) jen při prvním uzavření
      end_time_iso = CASE
        WHEN EXCLUDED.end_time_iso IS NOT NULL THEN EXCLUDED.end_time_iso
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN $15::text
        ELSE events.end_time_iso
      END,

      -- duration: když nový dur null, drž starý; ale když starý je extrém, smaž
      duration_min = CASE
        WHEN EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min
        WHEN events.duration_min IS NOT NULL AND events.duration_min > $14 THEN NULL
        ELSE events.duration_min
      END,

      is_closed = (events.is_closed OR EXCLUDED.is_closed),

      closed_detected_at = CASE
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN NOW()
        ELSE events.closed_detected_at
      END,

      last_seen_at = NOW(),
      updated_at = NOW()
  `;

  const values = [
    id,
    title || null,
    link || null,
    pubDate || null,

    placeText || null,
    cityText || null,
    statusText || null,
    eventType || null,

    descriptionRaw || null,

    startTimeIso || null,
    endTimeIso || null,

    Number.isFinite(durationMin) ? Math.round(durationMin) : null,
    Boolean(isClosed),

    MAX_DUR,
    closeNowIso,
  ];

  await pool.query(q, values);
}

// -------------------------
// FILTERS
// -------------------------
function buildWhere(filters) {
  const where = [];
  const params = [];
  let i = 1;

  if (filters?.status === "open") where.push(`is_closed = FALSE`);
  if (filters?.status === "closed") where.push(`is_closed = TRUE`);

  if (filters?.types && Array.isArray(filters.types) && filters.types.length > 0) {
    where.push(`event_type = $${i++}`);
    params.push(filters.types[0]);
  }

  if (filters?.city) {
    where.push(`(LOWER(city_text) LIKE $${i} OR LOWER(place_text) LIKE $${i})`);
    params.push(`%${String(filters.city).toLowerCase()}%`);
    i++;
  }

  if (filters?.month && /^\d{4}-\d{2}$/.test(filters.month)) {
    where.push(`(
      (start_time_iso IS NOT NULL AND LEFT(start_time_iso, 7) = $${i})
      OR
      (start_time_iso IS NULL AND pub_date IS NOT NULL AND pub_date LIKE $${i + 1})
    )`);
    params.push(filters.month);
    params.push(`%${filters.month}%`);
    i += 2;
  }

  if (filters?.day === "today" || filters?.day === "yesterday") {
    const offset = filters.day === "today" ? 0 : 1;
    where.push(`
      DATE((created_at AT TIME ZONE 'Europe/Prague')) =
      (DATE(NOW() AT TIME ZONE 'Europe/Prague') - $${i}::int)
    `);
    params.push(offset);
    i++;
  }

  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

// -------------------------
// GET EVENTS
// -------------------------
export async function getEventsFiltered(filters, limit = 400) {
  const lim = Math.max(1, Math.min(5000, Number(limit || 400)));
  const { whereSql, params } = buildWhere(filters);

  const q = `
    SELECT
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso,
      duration_min, is_closed, closed_detected_at,
      lat, lon,
      first_seen_at, last_seen_at, updated_at, created_at
    FROM events
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT ${lim}
  `;

  const r = await pool.query(q, params);
  return r.rows || [];
}

// -------------------------
// STATS
// -------------------------
export async function getStatsFiltered(filters) {
  const { whereSql, params } = buildWhere(filters);

  const q = `
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN is_closed THEN 1 ELSE 0 END)::int AS closed,
      SUM(CASE WHEN NOT is_closed THEN 1 ELSE 0 END)::int AS open
    FROM events
    ${whereSql}
  `;

  const r = await pool.query(q, params);
  const row = r.rows?.[0] || { total: 0, closed: 0, open: 0 };

  const qt = `
    SELECT event_type, COUNT(*)::int AS c
    FROM events
    ${whereSql}
    GROUP BY event_type
    ORDER BY c DESC
  `;
  const rt = await pool.query(qt, params);

  return { total: row.total || 0, closed: row.closed || 0, open: row.open || 0, byType: rt.rows || [] };
}

// -------------------------
// GEOCODE CACHE
// -------------------------
export async function getCachedGeocode(q) {
  const r = await pool.query(`SELECT q, lat, lon FROM geocode_cache WHERE q = $1 LIMIT 1`, [q]);
  return r.rows?.[0] || null;
}

export async function setCachedGeocode(q, lat, lon) {
  await pool.query(
    `
    INSERT INTO geocode_cache (q, lat, lon, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (q) DO UPDATE SET
      lat = EXCLUDED.lat,
      lon = EXCLUDED.lon,
      updated_at = NOW()
    `,
    [q, lat, lon]
  );
}

export async function deleteCachedGeocode(q) {
  await pool.query(`DELETE FROM geocode_cache WHERE q = $1`, [q]);
}

// -------------------------
// COORDS
// -------------------------
export async function updateEventCoords(id, lat, lon) {
  await pool.query(`UPDATE events SET lat=$2, lon=$3, updated_at=NOW() WHERE id=$1`, [id, lat, lon]);
}

export async function clearEventCoords(id) {
  await pool.query(`UPDATE events SET lat=NULL, lon=NULL, updated_at=NOW() WHERE id=$1`, [id]);
}

export async function getEventsOutsideCz(limit = 200) {
  const lim = Math.max(1, Math.min(2000, Number(limit || 200)));
  const q = `
    SELECT id, lat, lon
    FROM events
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND (
        lat < 48.55 OR lat > 51.06 OR lon < 12.09 OR lon > 18.87
      )
    ORDER BY last_seen_at DESC
    LIMIT ${lim}
  `;
  const r = await pool.query(q);
  return r.rows || [];
}

// -------------------------
// FIRST SEEN / DURATION
// -------------------------
export async function getEventFirstSeen(id) {
  const r = await pool.query(`SELECT first_seen_at FROM events WHERE id=$1 LIMIT 1`, [id]);
  const v = r.rows?.[0]?.first_seen_at || null;
  return v ? new Date(v).toISOString() : null;
}

export async function updateEventDuration(id, durationMin) {
  const n = Number(durationMin);
  if (!Number.isFinite(n) || n <= 0) return;
  await pool.query(`UPDATE events SET duration_min=$2, updated_at=NOW() WHERE id=$1`, [id, Math.round(n)]);
}