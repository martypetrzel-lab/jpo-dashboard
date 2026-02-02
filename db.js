import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false
});

async function colExists(table, col) {
  const res = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
    LIMIT 1
    `,
    [table, col]
  );
  return res.rowCount > 0;
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      pub_date TEXT,

      place_text TEXT,
      city_text TEXT,

      status_text TEXT,
      event_type TEXT,

      description_raw TEXT,

      start_time_iso TEXT,
      end_time_iso TEXT,
      duration_min INTEGER,
      is_closed BOOLEAN NOT NULL DEFAULT FALSE,

      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,

      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      place_text TEXT PRIMARY KEY,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const adds = [
    ["events", "event_type", "TEXT"],
    ["events", "description_raw", "TEXT"],
    ["events", "start_time_iso", "TEXT"],
    ["events", "end_time_iso", "TEXT"],
    ["events", "duration_min", "INTEGER"],
    ["events", "is_closed", "BOOLEAN"],
    ["events", "first_seen_at", "TIMESTAMPTZ"],
    ["events", "last_seen_at", "TIMESTAMPTZ"],
    ["events", "city_text", "TEXT"]
  ];

  for (const [t, c, typ] of adds) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await colExists(t, c);
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`ALTER TABLE ${t} ADD COLUMN ${c} ${typ};`);
    }
  }

  await pool.query(`
    UPDATE events
    SET is_closed = COALESCE(is_closed, FALSE),
        first_seen_at = COALESCE(first_seen_at, created_at, NOW()),
        last_seen_at = COALESCE(last_seen_at, NOW())
    WHERE is_closed IS NULL OR first_seen_at IS NULL OR last_seen_at IS NULL;
  `);

  // backfill city_text for existing rows (ne okres)
  await pool.query(`
    UPDATE events
    SET city_text = COALESCE(city_text, place_text)
    WHERE (city_text IS NULL OR city_text = '')
      AND place_text IS NOT NULL
      AND place_text !~* '^\\s*okres\\s+';
  `);

  // fallback: city z title " - Město"
  await pool.query(`
    UPDATE events
    SET city_text = COALESCE(
      NULLIF(city_text, ''),
      NULLIF(regexp_replace(title, '^.*\\s-\\s', ''), title)
    )
    WHERE (city_text IS NULL OR city_text = '')
      AND title LIKE '% - %';
  `);
}

function buildWhere(filters = {}, startIndex = 1) {
  const clauses = [];
  const params = [];
  let i = startIndex;

  const types = Array.isArray(filters.types) ? filters.types.filter(Boolean) : [];
  const city = (filters.city || "").trim();
  const status = (filters.status || "all").toLowerCase();

  if (types.length > 0) {
    clauses.push(`event_type = ANY($${i})`);
    params.push(types);
    i++;
  }

  if (city) {
    clauses.push(`COALESCE(city_text,'') ILIKE $${i}`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") clauses.push(`is_closed = FALSE`);
  if (status === "closed") clauses.push(`is_closed = TRUE`);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params, nextIndex: i };
}

export async function upsertEvent(ev) {
  await pool.query(
    `
    INSERT INTO events (
      id, title, link, pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      first_seen_at, last_seen_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      pub_date = EXCLUDED.pub_date,
      place_text = EXCLUDED.place_text,
      city_text = COALESCE(EXCLUDED.city_text, events.city_text),
      status_text = EXCLUDED.status_text,
      event_type = EXCLUDED.event_type,
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),
      end_time_iso   = COALESCE(EXCLUDED.end_time_iso, events.end_time_iso),
      duration_min   = COALESCE(EXCLUDED.duration_min, events.duration_min),
      is_closed      = (events.is_closed OR EXCLUDED.is_closed),

      last_seen_at = NOW()
    `,
    [
      ev.id,
      ev.title,
      ev.link,
      ev.pubDate || null,
      ev.placeText || null,
      ev.cityText || null,
      ev.statusText || null,
      ev.eventType || null,
      ev.descriptionRaw || null,
      ev.startTimeIso || null,
      ev.endTimeIso || null,
      Number.isFinite(ev.durationMin) ? Math.round(ev.durationMin) : null,
      !!ev.isClosed
    ]
  );
}

export async function updateEventCoords(id, lat, lon) {
  await pool.query(`UPDATE events SET lat=$2, lon=$3 WHERE id=$1`, [id, lat, lon]);
}

export async function clearEventCoords(id) {
  await pool.query(`UPDATE events SET lat=NULL, lon=NULL WHERE id=$1`, [id]);
}

export async function getEventsFiltered(filters = {}, limit = 300) {
  const lim = Math.max(1, Math.min(Number(limit || 300), 2000));

  const { where, params, nextIndex } = buildWhere(filters, 1);
  const sql = `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT $${nextIndex}`;
  const res = await pool.query(sql, [...params, lim]);
  return res.rows;
}

export async function getStatsFiltered(filters = {}) {
  const baseTime = `created_at >= NOW() - INTERVAL '30 days'`;

  const { where, params } = buildWhere(filters, 1);
  const where30 = where ? `${where} AND ${baseTime}` : `WHERE ${baseTime}`;

  const byDay = await pool.query(
    `
    SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM events
    ${where30}
    GROUP BY day
    ORDER BY day ASC;
    `,
    params
  );

  const byType = await pool.query(
    `
    SELECT COALESCE(event_type,'other') AS type, COUNT(*)::int AS count
    FROM events
    ${where30}
    GROUP BY type
    ORDER BY count DESC;
    `,
    params
  );

  const topCities = await pool.query(
    `
    SELECT COALESCE(NULLIF(city_text,''),'(neznamé)') AS city, COUNT(*)::int AS count
    FROM events
    ${where30}
    GROUP BY city
    ORDER BY count DESC
    LIMIT 15;
    `,
    params
  );

  const bestCity = topCities.rows[0] || null;

  const longest = await pool.query(
    `
    SELECT id, title, link, place_text, city_text, status_text, duration_min, start_time_iso, end_time_iso, created_at, is_closed
    FROM events
    ${where30}
      AND duration_min IS NOT NULL AND duration_min > 0
    ORDER BY duration_min DESC
    LIMIT 10;
    `,
    params
  );

  const fNoStatus = { ...filters, status: "all" };
  const ws = buildWhere(fNoStatus, 1);
  const where30NoStatus = ws.where ? `${ws.where} AND ${baseTime}` : `WHERE ${baseTime}`;

  const openCount = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM events
    ${where30NoStatus}
      AND is_closed = FALSE;
    `,
    ws.params
  );

  const closedCount = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM events
    ${where30NoStatus}
      AND is_closed = TRUE;
    `,
    ws.params
  );

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    bestCity,
    topCities: topCities.rows,
    longest: longest.rows,
    openCount: openCount.rows[0]?.count ?? 0,
    closedCount: closedCount.rows[0]?.count ?? 0
  };
}

export async function getCachedGeocode(placeText) {
  const res = await pool.query(
    `SELECT lat, lon FROM geocode_cache WHERE place_text=$1`,
    [placeText]
  );
  return res.rows[0] || null;
}

export async function setCachedGeocode(placeText, lat, lon) {
  await pool.query(
    `
    INSERT INTO geocode_cache (place_text, lat, lon)
    VALUES ($1,$2,$3)
    ON CONFLICT (place_text) DO UPDATE SET
      lat=EXCLUDED.lat,
      lon=EXCLUDED.lon,
      updated_at=NOW()
    `,
    [placeText, lat, lon]
  );
}

export async function deleteCachedGeocode(placeText) {
  await pool.query(`DELETE FROM geocode_cache WHERE place_text=$1`, [placeText]);
}

// ✅ mimo CZ (bounding box) - pro Variant B
export async function getEventsOutsideCz(limit = 200) {
  const lim = Math.max(1, Math.min(Number(limit || 200), 2000));
  const res = await pool.query(
    `
    SELECT id, city_text, place_text, lat, lon
    FROM events
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND (lat < 48.55 OR lat > 51.06 OR lon < 12.09 OR lon > 18.87)
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [lim]
  );
  return res.rows;
}

export async function getEventFirstSeen(id) {
  const res = await pool.query(`SELECT first_seen_at FROM events WHERE id=$1`, [id]);
  return res.rows[0]?.first_seen_at || null;
}
