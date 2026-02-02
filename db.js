import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  const sql = `
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      pub_date TEXT,
      place_text TEXT,
      place_norm TEXT,
      status_text TEXT,
      description_raw TEXT,
      is_closed BOOLEAN NOT NULL DEFAULT false,
      start_time_iso TEXT,
      end_time_iso TEXT,
      duration_min INTEGER,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION
    );

    CREATE INDEX IF NOT EXISTS idx_events_last_seen_at ON events(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_is_closed ON events(is_closed);
    CREATE INDEX IF NOT EXISTS idx_events_place_norm ON events(place_norm);
  `;
  await pool.query(sql);
}

export async function upsertEvent(row) {
  const sql = `
    INSERT INTO events (
      id, title, link, pub_date, place_text, place_norm, status_text, description_raw,
      is_closed, start_time_iso, end_time_iso, duration_min, lat, lon
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,$14
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      pub_date = EXCLUDED.pub_date,
      place_text = EXCLUDED.place_text,
      place_norm = EXCLUDED.place_norm,
      status_text = EXCLUDED.status_text,
      description_raw = EXCLUDED.description_raw,
      is_closed = EXCLUDED.is_closed,
      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),
      end_time_iso = COALESCE(EXCLUDED.end_time_iso, events.end_time_iso),
      duration_min = COALESCE(EXCLUDED.duration_min, events.duration_min),
      lat = COALESCE(EXCLUDED.lat, events.lat),
      lon = COALESCE(EXCLUDED.lon, events.lon),
      last_seen_at = NOW()
    RETURNING *;
  `;
  const vals = [
    row.id,
    row.title,
    row.link,
    row.pubDate || null,
    row.placeText || null,
    row.placeNorm || null,
    row.statusText || null,
    row.descriptionRaw || null,
    !!row.isClosed,
    row.startTimeIso || null,
    row.endTimeIso || null,
    row.durationMin ?? null,
    row.lat ?? null,
    row.lon ?? null,
  ];
  const res = await pool.query(sql, vals);
  return res.rows[0];
}

export async function getEvents(limit = 200, onlyActive = false) {
  const lim = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const where = onlyActive ? `WHERE is_closed = false` : ``;
  const sql = `
    SELECT *
    FROM events
    ${where}
    ORDER BY last_seen_at DESC
    LIMIT $1
  `;
  const res = await pool.query(sql, [lim]);
  return res.rows;
}

export async function getStats(days = 30) {
  const d = Math.max(1, Math.min(Number(days) || 30, 365));

  const byDaySql = `
    SELECT to_char(date_trunc('day', first_seen_at), 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS cnt
    FROM events
    WHERE first_seen_at >= NOW() - ($1::text || ' days')::interval
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  const topCitiesSql = `
    SELECT COALESCE(place_norm, place_text, 'nezname') AS city,
           COUNT(*)::int AS cnt
    FROM events
    WHERE first_seen_at >= NOW() - ($1::text || ' days')::interval
    GROUP BY 1
    ORDER BY cnt DESC
    LIMIT 10
  `;
  const longestSql = `
    SELECT id, title, link, place_text, place_norm, duration_min, start_time_iso, end_time_iso, is_closed
    FROM events
    WHERE duration_min IS NOT NULL
      AND first_seen_at >= NOW() - ($1::text || ' days')::interval
    ORDER BY duration_min DESC
    LIMIT 10
  `;
  const activeSql = `
    SELECT COUNT(*)::int AS cnt
    FROM events
    WHERE is_closed = false
      AND first_seen_at >= NOW() - ($1::text || ' days')::interval
  `;

  const [byDay, topCities, longest, active] = await Promise.all([
    pool.query(byDaySql, [d]),
    pool.query(topCitiesSql, [d]),
    pool.query(longestSql, [d]),
    pool.query(activeSql, [d]),
  ]);

  return {
    days: d,
    byDay: byDay.rows,
    topCities: topCities.rows,
    longest: longest.rows,
    activeCount: active.rows?.[0]?.cnt ?? 0,
  };
}

export async function exportCsv(days = 30) {
  const d = Math.max(1, Math.min(Number(days) || 30, 365));
  const sql = `
    SELECT
      id,
      title,
      link,
      place_text,
      place_norm,
      status_text,
      is_closed,
      start_time_iso,
      end_time_iso,
      duration_min,
      to_char(first_seen_at, 'YYYY-MM-DD HH24:MI:SS') AS first_seen_at,
      to_char(last_seen_at, 'YYYY-MM-DD HH24:MI:SS')  AS last_seen_at,
      lat,
      lon
    FROM events
    WHERE first_seen_at >= NOW() - ($1::text || ' days')::interval
    ORDER BY first_seen_at DESC
    LIMIT 5000
  `;
  const res = await pool.query(sql, [d]);
  return res.rows;
}
