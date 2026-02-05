import pg from "pg";

// ✅ stejný limit jako v serveru (fallback), aby se do DB neukládaly extrémy
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ✅ od kdy počítat "nejdelší zásahy" a ukládat nové délky (nezasahuje do historie)
  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('duration_cutoff_iso', NOW()::text)
    ON CONFLICT (key) DO NOTHING;
  `);

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

  await pool.query(`
    UPDATE events
    SET is_closed = COALESCE(is_closed, FALSE),
        first_seen_at = COALESCE(first_seen_at, created_at, NOW()),
        last_seen_at = COALESCE(last_seen_at, NOW())
    WHERE is_closed IS NULL OR first_seen_at IS NULL OR last_seen_at IS NULL;
  `);

  // ✅ jednorázové vyčištění extrémních délek (nepovinné, ale pomůže hned)
  await pool.query(
    `UPDATE events SET duration_min = NULL WHERE duration_min IS NOT NULL AND duration_min > $1`,
    [MAX_DURATION_MINUTES]
  );
}

// ---------------- GEOCODE CACHE (normalized key) ----------------
function normalizeKey(placeText) {
  return String(placeText || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

export async function getCachedGeocode(placeText) {
  const key = normalizeKey(placeText);
  if (!key) return null;
  const r = await pool.query(
    `SELECT lat, lon FROM geocode_cache WHERE place_text=$1`,
    [key]
  );
  if (r.rowCount <= 0) return null;
  const row = r.rows[0];
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export async function setCachedGeocode(placeText, lat, lon) {
  const key = normalizeKey(placeText);
  const la = Number(lat);
  const lo = Number(lon);
  if (!key || !Number.isFinite(la) || !Number.isFinite(lo)) return;

  await pool.query(
    `
    INSERT INTO geocode_cache (place_text, lat, lon)
    VALUES ($1, $2, $3)
    ON CONFLICT (place_text)
    DO UPDATE SET lat=EXCLUDED.lat, lon=EXCLUDED.lon, updated_at=NOW()
    `,
    [key, la, lo]
  );
}

export async function deleteCachedGeocode(placeText) {
  const key = normalizeKey(placeText);
  if (!key) return;
  await pool.query(`DELETE FROM geocode_cache WHERE place_text=$1`, [key]);
}

function clampDuration(v) {
  if (!Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n <= 0) return null;
  if (n > MAX_DURATION_MINUTES) return null;
  return n;
}

export async function upsertEvent(ev) {
  const dur = clampDuration(ev.durationMin);

  await pool.query(
    `
    INSERT INTO events (
      id, title, link,
      pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      last_seen_at
    )
    VALUES (
      $1,$2,$3,
      $4,
      $5,$6,
      $7,$8,
      $9,
      $10,$11,$12,$13,
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      title=EXCLUDED.title,
      link=EXCLUDED.link,
      pub_date=COALESCE(EXCLUDED.pub_date, events.pub_date),
      place_text=COALESCE(EXCLUDED.place_text, events.place_text),
      city_text=COALESCE(EXCLUDED.city_text, events.city_text),
      status_text=COALESCE(EXCLUDED.status_text, events.status_text),
      event_type=COALESCE(EXCLUDED.event_type, events.event_type),
      description_raw=COALESCE(EXCLUDED.description_raw, events.description_raw),
      start_time_iso=COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),
      end_time_iso=COALESCE(EXCLUDED.end_time_iso, events.end_time_iso),
      duration_min=COALESCE(EXCLUDED.duration_min, events.duration_min),
      is_closed=COALESCE(EXCLUDED.is_closed, events.is_closed),
      last_seen_at=NOW()
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
      dur,
      !!ev.isClosed
    ]
  );
}

export async function getEventsFiltered(filters, limit = 400) {
  const params = [];
  let i = 1;

  const where = [];
  const types = Array.isArray(filters?.types) ? filters.types.filter(Boolean) : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();
  const day = String(filters?.day || "today").toLowerCase();

  if (types.length > 0) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(city_text ILIKE $${i} OR place_text ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") where.push(`is_closed = FALSE`);
  if (status === "closed") where.push(`is_closed = TRUE`);

  if (day === "today" || day === "yesterday") {
    const offset = day === "yesterday" ? 1 : 0;
    where.push(
      `( (COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date = ((NOW() AT TIME ZONE 'Europe/Prague')::date - $${i}::int) )`
    );
    params.push(offset);
    i++;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const res = await pool.query(
    `
    SELECT
      id, title, link,
      pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      lat, lon,
      first_seen_at, last_seen_at, created_at
    FROM events
    ${whereSql}
    ORDER BY COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) DESC
    LIMIT $${i}
    `,
    [...params, limit]
  );

  return res.rows;
}

export async function getStatsFiltered(filters) {
  const params = [];
  let i = 1;

  const where = [];
  const types = Array.isArray(filters?.types) ? filters.types.filter(Boolean) : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();

  if (types.length > 0) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(city_text ILIKE $${i} OR place_text ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") where.push(`is_closed = FALSE`);
  if (status === "closed") where.push(`is_closed = TRUE`);

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";

  const byDay = await pool.query(
    `
    SELECT
      to_char((COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date, 'YYYY-MM-DD') as day,
      COUNT(*)::int as count
    FROM events
    WHERE COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) >= (NOW() - interval '30 days')
    ${whereSql}
    GROUP BY 1
    ORDER BY 1
    `,
    params
  );

  const openVsClosed = await pool.query(
    `
    SELECT
      SUM(CASE WHEN is_closed = FALSE THEN 1 ELSE 0 END)::int as open,
      SUM(CASE WHEN is_closed = TRUE THEN 1 ELSE 0 END)::int as closed
    FROM events
    WHERE COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) >= (NOW() - interval '30 days')
    ${whereSql}
    `,
    params
  );

  const topCities = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(city_text,''), NULLIF(place_text,''), '—') as city,
      COUNT(*)::int as count
    FROM events
    WHERE COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) >= (NOW() - interval '30 days')
    ${whereSql}
    GROUP BY 1
    ORDER BY count DESC, city ASC
    LIMIT 15
    `,
    params
  );

  const longest = await pool.query(
    `
    SELECT
      id, title, link,
      duration_min
    FROM events
    WHERE duration_min IS NOT NULL
    ORDER BY duration_min DESC
    LIMIT 10
    `
  );

  return {
    byDay: byDay.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    topCities: topCities.rows,
    longest: longest.rows
  };
}

export async function updateEventCoords(id, lat, lon) {
  await pool.query(`UPDATE events SET lat=$2, lon=$3 WHERE id=$1`, [id, lat, lon]);
}

export async function clearEventCoords(id) {
  await pool.query(`UPDATE events SET lat=NULL, lon=NULL WHERE id=$1`, [id]);
}

export async function updateEventDuration(id, durationMin) {
  const dur = clampDuration(durationMin);
  await pool.query(`UPDATE events SET duration_min=$2 WHERE id=$1`, [id, dur]);
}

export async function getEventFirstSeen(id) {
  const res = await pool.query(`SELECT first_seen_at FROM events WHERE id=$1`, [id]);
  return res.rows[0]?.first_seen_at || null;
}

export async function getEventsOutsideCz(limit = 200) {
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

export async function getDurationCutoffIso() {
  const res = await pool.query(`SELECT value FROM app_settings WHERE key='duration_cutoff_iso' LIMIT 1`);
  return res.rows[0]?.value || null;
}
