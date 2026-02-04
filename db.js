import pg from "pg";

// ✅ sanity limit pro délku zásahu (default 3 dny)
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

      -- ✅ pouze pro "nově detekované uzavření"
      closed_detected_at TIMESTAMPTZ,

      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,

      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  // migrations (kdybys startoval ze staršího schématu)
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
    ["events", "lon", "DOUBLE PRECISION"],
    ["events", "closed_detected_at", "TIMESTAMPTZ"]
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

  // ✅ baseline: staré uzavřené ber jako historické (bez délky)
  const base = await pool.query(`SELECT value FROM meta WHERE key='closed_baseline_v1' LIMIT 1`);
  if (base.rowCount === 0) {
    await pool.query(`
      UPDATE events
      SET duration_min = NULL,
          end_time_iso = NULL,
          closed_detected_at = NULL
      WHERE is_closed = TRUE;
    `);
    await pool.query(
      `INSERT INTO meta(key, value)
       VALUES('closed_baseline_v1','1')
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`
    );
  }

  // pojistka proti extrémům
  await pool.query(
    `UPDATE events SET duration_min = NULL WHERE duration_min IS NOT NULL AND duration_min > $1`,
    [MAX_DURATION_MINUTES]
  );
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
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      closed_detected_at,
      first_seen_at, last_seen_at
    )
    VALUES (
      $1,$2,$3,$4,
      $5,$6,$7,$8,
      $9,
      $10::text,
      $11::text,
      $12::int,
      $13::boolean,
      CASE WHEN $13::boolean = TRUE THEN NOW() ELSE NULL END,
      NOW(), NOW()
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

      -- ✅ end_time: nastav jen při prvním uzavření (OPEN->CLOSED)
      end_time_iso = CASE
        WHEN events.end_time_iso IS NOT NULL THEN events.end_time_iso
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN COALESCE(EXCLUDED.end_time_iso, to_char((NOW() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        ELSE events.end_time_iso
      END,

      -- ✅ duration: jen při prvním uzavření / první insert (po uzavření už NIKDY nepřepisuj)
      duration_min = CASE
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN COALESCE(EXCLUDED.duration_min, events.duration_min)
        WHEN (events.is_closed = TRUE) THEN events.duration_min
        ELSE COALESCE(EXCLUDED.duration_min, events.duration_min)
      END,

      is_closed = (events.is_closed OR EXCLUDED.is_closed),

      closed_detected_at = CASE
        WHEN events.closed_detected_at IS NOT NULL THEN events.closed_detected_at
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN NOW()
        ELSE events.closed_detected_at
      END,

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
      dur,
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
  const dur = clampDuration(durationMin);
  await pool.query(`UPDATE events SET duration_min=$2 WHERE id=$1`, [id, dur]);
}

export async function getCachedGeocode(placeText) {
  const res = await pool.query(`SELECT lat, lon FROM geocode_cache WHERE place_text=$1`, [placeText]);
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

export async function getEventFirstSeen(id) {
  const res = await pool.query(`SELECT first_seen_at FROM events WHERE id=$1`, [id]);
  return res.rows[0]?.first_seen_at || null;
}

function buildWhereSql(filters, params) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();
  const day = String(filters?.day || "all").toLowerCase();
  const month = String(filters?.month || "").trim();

  const where = [];
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

  if (day === "today" || day === "yesterday") {
    const offset = day === "yesterday" ? 1 : 0;
    where.push(
      `( (COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date =
         ((NOW() AT TIME ZONE 'Europe/Prague')::date - $${i}::int) )`
    );
    params.push(offset);
    i++;
  }

  if (month) {
    const m = month.match(/^\d{4}-\d{2}$/);
    if (m) {
      where.push(
        `date_trunc('month', (COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')) =
         date_trunc('month', to_date($${i}, 'YYYY-MM'))`
      );
      params.push(month);
      i++;
    }
  }

  return { where, nextIndex: i };
}

export async function getEventsFiltered(filters, limit = 400) {
  const lim = Math.max(1, Math.min(5000, Number(limit) || 400));

  const params = [];
  const built = buildWhereSql(filters, params);

  const sql = `
    SELECT
      id, title, link, pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      closed_detected_at,
      lat, lon,
      first_seen_at, last_seen_at, created_at
    FROM events
    ${built.where.length ? "WHERE " + built.where.join(" AND ") : ""}
    ORDER BY COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) DESC, created_at DESC
    LIMIT $${built.nextIndex}
  `;

  params.push(lim);

  const res = await pool.query(sql, params);
  return res.rows;
}

export async function getStatsFiltered(filters) {
  const params = [];
  const built = buildWhereSql(filters, params);

  const where = [...built.where];
  where.unshift(`created_at >= NOW() - INTERVAL '30 days'`);
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const byDay = await pool.query(
    `
    SELECT
      to_char(((COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS count
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
      SUM(CASE WHEN is_closed = FALSE THEN 1 ELSE 0 END)::int AS open,
      SUM(CASE WHEN is_closed = TRUE  THEN 1 ELSE 0 END)::int AS closed
    FROM events
    ${whereSql};
    `,
    params
  );

  // ✅ nejdelší jen u nově uzavřených (má closed_detected_at)
  const longest = await pool.query(
    `
    SELECT
      id, title, link, duration_min, city_text, place_text
    FROM events
    ${whereSql}
      AND duration_min IS NOT NULL
      AND duration_min > 0
      AND is_closed = TRUE
      AND closed_detected_at IS NOT NULL
    ORDER BY duration_min DESC
    LIMIT 12;
    `,
    params
  );

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openCount: openVsClosed.rows[0]?.open ?? 0,
    closedCount: openVsClosed.rows[0]?.closed ?? 0,
    longest: longest.rows
  };
}