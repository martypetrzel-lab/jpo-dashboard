import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false }
});

export async function initDb() {
  // events tabulka
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
      is_closed BOOLEAN DEFAULT FALSE,

      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,

      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // geocache tabulka
  await pool.query(`
    CREATE TABLE IF NOT EXISTS geocache (
      key TEXT PRIMARY KEY,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      source TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // migrace: přidání sloupců pokud chybí (bez pádu)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='city_text'
      ) THEN
        ALTER TABLE events ADD COLUMN city_text TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='event_type'
      ) THEN
        ALTER TABLE events ADD COLUMN event_type TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='description_raw'
      ) THEN
        ALTER TABLE events ADD COLUMN description_raw TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='start_time_iso'
      ) THEN
        ALTER TABLE events ADD COLUMN start_time_iso TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='end_time_iso'
      ) THEN
        ALTER TABLE events ADD COLUMN end_time_iso TEXT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='duration_min'
      ) THEN
        ALTER TABLE events ADD COLUMN duration_min INTEGER;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='is_closed'
      ) THEN
        ALTER TABLE events ADD COLUMN is_closed BOOLEAN DEFAULT FALSE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='first_seen_at'
      ) THEN
        ALTER TABLE events ADD COLUMN first_seen_at TIMESTAMPTZ DEFAULT NOW();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='last_seen_at'
      ) THEN
        ALTER TABLE events ADD COLUMN last_seen_at TIMESTAMPTZ DEFAULT NOW();
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='lat'
      ) THEN
        ALTER TABLE events ADD COLUMN lat DOUBLE PRECISION;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='events' AND column_name='lon'
      ) THEN
        ALTER TABLE events ADD COLUMN lon DOUBLE PRECISION;
      END IF;

    END$$;
  `);

  // doplnění NULLů po migracích
  await pool.query(`
    UPDATE events
    SET
      is_closed = COALESCE(is_closed, FALSE),
      first_seen_at = COALESCE(first_seen_at, created_at, NOW()),
      last_seen_at  = COALESCE(last_seen_at, NOW())
    WHERE is_closed IS NULL OR first_seen_at IS NULL OR last_seen_at IS NULL;
  `);
}

// --- ČIŠTĚNÍ DÉLEK (ochrana proti extrémům) ---
export async function clearExtremeDurations(maxMinutes = 24 * 60) {
  const res = await pool.query(
    `
    UPDATE events
    SET duration_min=NULL
    WHERE duration_min IS NOT NULL AND duration_min > $1
    `,
    [maxMinutes]
  );
  return res.rowCount;
}

// --- REKALKULACE DÉLEK Z ČASŮ (pokud existují start/end) ---
export async function recalcDurationsFromTimes() {
  // duration_min = rozdíl end-start v minutách (pokud smysluplné)
  const res = await pool.query(`
    UPDATE events
    SET duration_min = GREATEST(
      0,
      FLOOR( EXTRACT(EPOCH FROM (end_time_iso::timestamptz - start_time_iso::timestamptz)) / 60 )
    )::int
    WHERE start_time_iso IS NOT NULL
      AND end_time_iso IS NOT NULL
      AND (start_time_iso::timestamptz) <= (end_time_iso::timestamptz);
  `);
  return res.rowCount;
}

// --- UPSERT EVENT ---
export async function upsertEvent(ev) {
  await pool.query(
    `
    INSERT INTO events (
      id, title, link,
      pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso,
      duration_min,
      is_closed,
      first_seen_at, last_seen_at, created_at
    )
    VALUES (
      $1,$2,$3,
      $4,
      $5,$6,
      $7,$8,
      $9,
      $10,$11,
      $12,
      $13,
      NOW(), NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      title=EXCLUDED.title,
      link=EXCLUDED.link,
      pub_date=EXCLUDED.pub_date,

      place_text=COALESCE(EXCLUDED.place_text, events.place_text),
      city_text =COALESCE(EXCLUDED.city_text,  events.city_text),

      status_text=COALESCE(EXCLUDED.status_text, events.status_text),
      event_type =COALESCE(EXCLUDED.event_type,  events.event_type),

      description_raw=COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso=COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),
      end_time_iso  =COALESCE(EXCLUDED.end_time_iso,   events.end_time_iso),
      duration_min  =COALESCE(EXCLUDED.duration_min,   events.duration_min),

      is_closed = (events.is_closed OR EXCLUDED.is_closed),

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
      Number.isFinite(ev.durationMin) ? Math.round(ev.durationMin) : null,
      !!ev.isClosed
    ]
  );

  // upsert: neumíme snadno poznat inserted/updated → vrátíme "updated" (server si to počítá jemně)
  // Ale pro počítadla je to ok: server zvyšuje inserted/updated podle návratové hodnoty,
  // zde držíme kompatibilitu s dřívější verzí tím, že budeme vracet string.
  return "updated";
}

export async function updateEventCoords(id, lat, lon) {
  await pool.query(
    `
    UPDATE events
    SET lat=$2, lon=$3
    WHERE id=$1
    `,
    [id, lat, lon]
  );
}

// Alias expected by server.js (re-geocode endpoint): clear coords for one event id
export async function clearEventCoords(id) {
  await pool.query(
    `
    UPDATE events
    SET lat=NULL, lon=NULL
    WHERE id=$1
    `,
    [id]
  );
}

export async function updateEventDuration(id, durationMin) {
  await pool.query(
    `
    UPDATE events
    SET duration_min=$2
    WHERE id=$1
    `,
    [id, durationMin]
  );
}

// --- FILTERED EVENTS ---
export async function getEventsFiltered(filters, limit = 400) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();
  const day = String(filters?.day || "today").toLowerCase();

  const where = [];
  const params = [];
  let i = 1;

  if (types.length) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(COALESCE(city_text,'') ILIKE $${i} OR COALESCE(place_text,'') ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") where.push(`is_closed = FALSE`);
  if (status === "closed") where.push(`is_closed = TRUE`);

  // day filtr (dnes / včera / all) – založeno na created_at (ingest time)
  if (day === "today") {
    where.push(`created_at::date = (NOW() AT TIME ZONE 'Europe/Prague')::date`);
  } else if (day === "yesterday") {
    where.push(`created_at::date = ((NOW() AT TIME ZONE 'Europe/Prague')::date - 1)`);
  }

  const sql =
    `
    SELECT
      id, title, link, pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      lat, lon,
      first_seen_at, last_seen_at, created_at
    FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(pub_date, created_at::text) DESC, created_at DESC
    LIMIT $${i}
    `;

  params.push(limit);

  const res = await pool.query(sql, params);
  return res.rows;
}

export async function getStatsFiltered(filters) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();
  const month = String(filters?.month || "").trim();

  const where = [];
  const params = [];
  let i = 1;

  // default posledních 30 dnů
  where.push(`created_at >= NOW() - INTERVAL '30 days'`);

  if (types.length) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    where.push(`(COALESCE(city_text,'') ILIKE $${i} OR COALESCE(place_text,'') ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") where.push(`is_closed = FALSE`);
  if (status === "closed") where.push(`is_closed = TRUE`);

  if (month) {
    // month = YYYY-MM, filtr podle created_at v Europe/Prague
    where.push(`to_char((created_at AT TIME ZONE 'Europe/Prague')::date, 'YYYY-MM') = $${i}`);
    params.push(month);
    i++;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const byDay = await pool.query(
    `
    SELECT to_char((created_at AT TIME ZONE 'Europe/Prague')::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY day
    ORDER BY day ASC;
    `,
    params
  );

  const byType = await pool.query(
    `
    SELECT COALESCE(event_type,'other') AS type, COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY type
    ORDER BY count DESC;
    `,
    params
  );

  const topCities = await pool.query(
    `
    SELECT COALESCE(NULLIF(city_text,''), NULLIF(place_text,''), '(neznámé)') AS city, COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY city
    ORDER BY count DESC
    LIMIT 15;
    `,
    params
  );

  const openVsClosed = await pool.query(
    `
    SELECT
      SUM(CASE WHEN is_closed THEN 1 ELSE 0 END)::int AS closed,
      SUM(CASE WHEN NOT is_closed THEN 1 ELSE 0 END)::int AS open
    FROM events
    ${whereSql}
    `,
    params
  );

  const longest = await pool.query(
    `
    SELECT id, title, link,
           COALESCE(NULLIF(city_text,''), place_text) AS city,
           duration_min, start_time_iso, end_time_iso, created_at
    FROM events
    ${whereSql} AND duration_min IS NOT NULL AND duration_min > 0
    ORDER BY duration_min DESC
    LIMIT 10;
    `,
    params
  );

  // měsíční žebříček měst (pokud month není, tak podle posledních 30 dnů)
  const monthlyCities = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(city_text,''), NULLIF(place_text,''), '(neznámé)') AS city,
      COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY city
    ORDER BY count DESC
    LIMIT 50;
    `,
    params
  );

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longest.rows,
    monthlyCities: monthlyCities.rows
  };
}

// ---------- GEOCACHE ----------
export async function getGeocache(key) {
  const res = await pool.query(`SELECT * FROM geocache WHERE key=$1`, [key]);
  return res.rows[0] || null;
}

export async function setGeocache(key, lat, lon, source) {
  await pool.query(
    `
    INSERT INTO geocache (key, lat, lon, source, updated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (key) DO UPDATE SET
      lat=EXCLUDED.lat,
      lon=EXCLUDED.lon,
      source=EXCLUDED.source,
      updated_at=NOW()
    `,
    [key, lat, lon, source || null]
  );
  return true;
}

export async function deleteGeocache(key) {
  const res = await pool.query(`DELETE FROM geocache WHERE key=$1`, [key]);
  return res.rowCount;
}

// ----- Backward/forward compatibility exports (server.js expects these names) -----
export async function getCachedGeocode(key) {
  return getGeocache(key);
}

export async function setCachedGeocode(key, lat, lon) {
  // server.js volá pouze (key, lat, lon) → source doplníme
  return setGeocache(key, lat, lon, "nominatim");
}

export async function deleteCachedGeocode(key) {
  return deleteGeocache(key);
}

// ---------- Admin helpers ----------
export async function clearCoordsFor(city) {
  const res = await pool.query(
    `
    UPDATE events
    SET lat=NULL, lon=NULL
    WHERE COALESCE(city_text,'') ILIKE $1 OR COALESCE(place_text,'') ILIKE $1
    `,
    [`%${city}%`]
  );
  return res.rowCount;
}

export async function getEventsNeedingGeocode(limit = 200) {
  const res = await pool.query(
    `
    SELECT id, city_text, place_text
    FROM events
    WHERE (lat IS NULL OR lon IS NULL)
      AND (COALESCE(city_text,'') <> '' OR COALESCE(place_text,'') <> '')
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
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
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
}

export async function getEventFirstSeen(id) {
  const res = await pool.query(`SELECT first_seen_at FROM events WHERE id=$1`, [id]);
  return res.rows[0]?.first_seen_at || null;
}
