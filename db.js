// db.js
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

  // migrations if you started from older schema
  const adds = [
    ["events", "city_text", "TEXT"],
    ["events", "event_type", "TEXT"],
    ["events", "description_raw", "TEXT"],
    ["events", "start_time_iso", "TEXT"],
    ["events", "end_time_iso", "TEXT"],
    ["events", "duration_min", "INTEGER"],
    ["events", "is_closed", "BOOLEAN"],
    ["events", "first_seen_at", "TIMESTAMPTZ"],
    ["events", "last_seen_at", "TIMESTAMPTZ"],
    ["events", "lat", "DOUBLE PRECISION"],
    ["events", "lon", "DOUBLE PRECISION"]
  ];

  for (const [t, c, typ] of adds) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await colExists(t, c);
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`ALTER TABLE ${t} ADD COLUMN ${c} ${typ};`);
    }
  }

  // ensure defaults for new columns if migrated
  await pool.query(`
    UPDATE events
    SET is_closed = COALESCE(is_closed, FALSE),
        first_seen_at = COALESCE(first_seen_at, created_at, NOW()),
        last_seen_at = COALESCE(last_seen_at, NOW())
    WHERE is_closed IS NULL OR first_seen_at IS NULL OR last_seen_at IS NULL;
  `);
}

export async function upsertEvent(ev) {
  await pool.query(
    `
    INSERT INTO events (
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      first_seen_at, last_seen_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      pub_date = EXCLUDED.pub_date,

      place_text = COALESCE(EXCLUDED.place_text, events.place_text),
      city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),

      status_text = COALESCE(EXCLUDED.status_text, events.status_text),
      event_type  = COALESCE(EXCLUDED.event_type, events.event_type),
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),
      end_time_iso   = COALESCE(EXCLUDED.end_time_iso,   events.end_time_iso),
      duration_min   = COALESCE(EXCLUDED.duration_min,   events.duration_min),
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

export async function updateEventDuration(id, durationMin) {
  await pool.query(`UPDATE events SET duration_min=$2 WHERE id=$1`, [
    id,
    Number.isFinite(durationMin) ? Math.round(durationMin) : null
  ]);
}

// --- ADMIN / MAINTENANCE ---
// Najde ukončené události, které mají end_time_iso, ale chybí duration_min
export async function getClosedEventsMissingDuration(limit = 200) {
  const lim = Math.max(1, Math.min(5000, Number(limit) || 200));
  const res = await pool.query(
    `
    SELECT id, title, link, pub_date, place_text, city_text, status_text,
           start_time_iso, end_time_iso, is_closed, created_at
    FROM events
    WHERE duration_min IS NULL
      AND end_time_iso IS NOT NULL
      AND is_closed = TRUE
    ORDER BY COALESCE(end_time_iso, pub_date, created_at::text) DESC
    LIMIT $1
    `,
    [lim]
  );
  return res.rows;
}

// Najde události, kde je uložené description_raw, ale nejsou z něj vytažené časy/délka.
export async function getEventsNeedingReparse(limit = 500) {
  const lim = Math.max(1, Math.min(10000, Number(limit) || 500));
  const res = await pool.query(
    `
    SELECT id, title, link, pub_date, place_text, city_text, status_text,
           description_raw, start_time_iso, end_time_iso, duration_min, is_closed, created_at
    FROM events
    WHERE description_raw IS NOT NULL
      AND (
        end_time_iso IS NULL
        OR start_time_iso IS NULL
        OR (is_closed = TRUE AND duration_min IS NULL)
      )
    ORDER BY COALESCE(pub_date, created_at::text) DESC
    LIMIT $1
    `,
    [lim]
  );
  return res.rows;
}

// Upraví časy/stav/délku pro existující událost.
// (Používá se při ručním přepočtu, aby se opravily staré záznamy.)
export async function updateEventTimesAndDuration(id, {
  startTimeIso = null,
  endTimeIso = null,
  isClosed = null,
  statusText = null,
  durationMin = null
} = {}) {
  await pool.query(
    `
    UPDATE events
    SET
      start_time_iso = COALESCE($2, start_time_iso),
      end_time_iso   = COALESCE($3, end_time_iso),
      is_closed      = COALESCE($4, is_closed),
      status_text    = COALESCE($5, status_text),
      duration_min   = COALESCE($6, duration_min)
    WHERE id = $1
    `,
    [
      id,
      startTimeIso,
      endTimeIso,
      typeof isClosed === "boolean" ? isClosed : null,
      statusText,
      Number.isFinite(durationMin) ? Math.round(durationMin) : null
    ]
  );
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

export async function getEventFirstSeen(id) {
  const res = await pool.query(`SELECT first_seen_at FROM events WHERE id=$1`, [id]);
  return res.rows[0]?.first_seen_at || null;
}

export async function getEventsOutsideCz(limit = 200) {
  // CZ bounding box: lon 12.09–18.87, lat 48.55–51.06
  const res = await pool.query(
    `
    SELECT id, city_text, place_text, lat, lon
    FROM events
    WHERE lat IS NOT NULL AND lon IS NOT NULL AND (
      lat < 48.55 OR lat > 51.06 OR lon < 12.09 OR lon > 18.87
    )
    ORDER BY last_seen_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
}

// --- FILTERED EVENTS ---
export async function getEventsFiltered(filters, limit = 400) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();

  const where = [];
  const params = [];
  let i = 1;

  if (types.length) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(city_text ILIKE $${i} OR place_text ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") {
    where.push(`is_closed = FALSE`);
  } else if (status === "closed") {
    where.push(`is_closed = TRUE`);
  }

  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const lim = Math.max(1, Math.min(5000, Number(limit) || 400));
  const res = await pool.query(
    `
    SELECT
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      start_time_iso, end_time_iso, duration_min, is_closed,
      lat, lon,
      created_at, first_seen_at, last_seen_at
    FROM events
    ${sqlWhere}
    ORDER BY COALESCE(pub_date, created_at::text) DESC
    LIMIT $${i}
    `,
    [...params, lim]
  );

  return res.rows;
}

export async function getStatsFiltered(filters) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();

  const where = [];
  const params = [];
  let i = 1;

  if (types.length) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(city_text ILIKE $${i} OR place_text ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") {
    where.push(`is_closed = FALSE`);
  } else if (status === "closed") {
    where.push(`is_closed = TRUE`);
  }

  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const openRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM events ${sqlWhere} ${sqlWhere ? "AND" : "WHERE"} is_closed = FALSE`,
    params
  );
  const closedRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM events ${sqlWhere} ${sqlWhere ? "AND" : "WHERE"} is_closed = TRUE`,
    params
  );

  const byDayRes = await pool.query(
    `
    SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM events
    ${sqlWhere}
    GROUP BY 1
    ORDER BY 1
    `,
    params
  );

  const topCitiesRes = await pool.query(
    `
    SELECT COALESCE(city_text, place_text, '—') AS city, COUNT(*)::int AS count
    FROM events
    ${sqlWhere}
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 10
    `,
    params
  );

  const longestRes = await pool.query(
    `
    SELECT title, link, duration_min
    FROM events
    ${sqlWhere}
    AND duration_min IS NOT NULL
    ORDER BY duration_min DESC
    LIMIT 10
    `,
    params
  );

  return {
    openCount: openRes.rows[0]?.c ?? 0,
    closedCount: closedRes.rows[0]?.c ?? 0,
    byDay: byDayRes.rows,
    topCities: topCitiesRes.rows,
    longest: longestRes.rows
  };
}
