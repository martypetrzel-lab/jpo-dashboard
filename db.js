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
  // Base tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      pub_date TEXT,
      place_text TEXT,
      status_text TEXT,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
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

  // Migrations (add extra fields if missing)
  const adds = [
    ["events", "event_type", "TEXT"],
    ["events", "start_time_iso", "TEXT"],
    ["events", "end_time_iso", "TEXT"],
    ["events", "duration_min", "INTEGER"]
  ];

  for (const [t, c, typ] of adds) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await colExists(t, c);
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`ALTER TABLE ${t} ADD COLUMN ${c} ${typ};`);
    }
  }
}

export async function upsertEvent(ev) {
  await pool.query(
    `
    INSERT INTO events (
      id, title, link, pub_date, place_text, status_text,
      event_type, start_time_iso, end_time_iso, duration_min
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      pub_date = EXCLUDED.pub_date,
      place_text = EXCLUDED.place_text,
      status_text = EXCLUDED.status_text,
      event_type = EXCLUDED.event_type,
      start_time_iso = EXCLUDED.start_time_iso,
      end_time_iso = EXCLUDED.end_time_iso,
      duration_min = EXCLUDED.duration_min
    `,
    [
      ev.id,
      ev.title,
      ev.link,
      ev.pubDate || null,
      ev.placeText || null,
      ev.statusText || null,
      ev.eventType || null,
      ev.startTimeIso || null,
      ev.endTimeIso || null,
      Number.isFinite(ev.durationMin) ? Math.round(ev.durationMin) : null
    ]
  );
}

export async function updateEventCoords(id, lat, lon) {
  await pool.query(`UPDATE events SET lat=$2, lon=$3 WHERE id=$1`, [id, lat, lon]);
}

export async function getEvents(limit = 200) {
  const res = await pool.query(
    `SELECT * FROM events ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function getStats() {
  const byDay = await pool.query(`
    SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM events
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY day
    ORDER BY day ASC;
  `);

  const topCities = await pool.query(`
    SELECT COALESCE(place_text,'(neznamé)') AS city, COUNT(*)::int AS count
    FROM events
    GROUP BY city
    ORDER BY count DESC
    LIMIT 10;
  `);

  const bestCity = topCities.rows[0] || null;

  const longest = await pool.query(`
    SELECT id, title, link, place_text, status_text, duration_min, start_time_iso, end_time_iso, created_at
    FROM events
    WHERE duration_min IS NOT NULL AND duration_min > 0
    ORDER BY duration_min DESC
    LIMIT 10;
  `);

  return {
    byDay: byDay.rows,
    bestCity,
    topCities: topCities.rows,
    longest: longest.rows
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
