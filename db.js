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
      pub_ts TIMESTAMPTZ,

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

  // ✅ měsíční statistika měst (persistovaná)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS city_monthly_stats (
      month_key TEXT NOT NULL,          -- "YYYY-MM"
      city TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (month_key, city)
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
    ["events", "lon", "DOUBLE PRECISION"],
    ["events", "pub_ts", "TIMESTAMPTZ"]
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

  // best-effort backfill pub_ts from pub_date for older rows
  await pool.query(`
    UPDATE events
    SET pub_ts = CASE
      WHEN pub_ts IS NULL AND pub_date IS NOT NULL AND pub_date <> '' THEN (pub_date::timestamptz)
      ELSE pub_ts
    END
    WHERE pub_ts IS NULL AND pub_date IS NOT NULL AND pub_date <> '';
  `).catch(() => {
    // některé staré pub_date nemusí být castnutelné; nevadí
  });
}

export async function upsertEvent(ev) {
  await pool.query(
    `
    INSERT INTO events (
      id, title, link, pub_date, pub_ts,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      first_seen_at, last_seen_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      pub_date = EXCLUDED.pub_date,
      pub_ts   = COALESCE(EXCLUDED.pub_ts, events.pub_ts),

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
      ev.pubTs || null,
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
  const day = String(filters?.day || "today").toLowerCase(); // today | yesterday | all

  const where = [];
  const params = [];
  let i = 1;

  if (types.length) {
    where.push(`event_type = ANY($${i}::text[])`);
    params.push(types);
    i++;
  }

  if (city) {
    // hledáme v city_text primárně, fallback i v place_text
    where.push(`(COALESCE(city_text,'') ILIKE $${i} OR COALESCE(place_text,'') ILIKE $${i})`);
    params.push(`%${city}%`);
    i++;
  }

  if (status === "open") where.push(`is_closed = FALSE`);
  if (status === "closed") where.push(`is_closed = TRUE`);

  // ✅ denní filtr pro mapu+tabulku (Praha)
  if (day === "today") {
    where.push(`(COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague')::date = (NOW() AT TIME ZONE 'Europe/Prague')::date`);
  } else if (day === "yesterday") {
    where.push(`(COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague')::date = ((NOW() AT TIME ZONE 'Europe/Prague')::date - INTERVAL '1 day')::date`);
  } // all -> nic

  const sql =
    `
    SELECT
      id, title, link, pub_date, pub_ts,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      lat, lon,
      first_seen_at, last_seen_at, created_at
    FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(pub_ts, created_at) DESC, created_at DESC
    LIMIT $${i}
    `;

  params.push(limit);

  const res = await pool.query(sql, params);
  return res.rows;
}

// --- MONTHLY CITY STATS (persist) ---
export async function recomputeMonthlyCityStats(monthKey) {
  const mk = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(mk)) return { ok: false, error: "bad monthKey" };

  // přepočet za daný měsíc (Praha) – idempotentní: nejdřív smažeme měsíc, pak vložíme vše znovu
  await pool.query("BEGIN");
  try {
    await pool.query(`DELETE FROM city_monthly_stats WHERE month_key=$1`, [mk]);

    await pool.query(
      `
      WITH bounds AS (
        SELECT
          to_date($1 || '-01', 'YYYY-MM-DD')::date AS d0,
          (to_date($1 || '-01', 'YYYY-MM-DD')::date + INTERVAL '1 month')::date AS d1
      ),
      agg AS (
        SELECT
          COALESCE(NULLIF(city_text,''), NULLIF(place_text,''), '(neznámé)') AS city,
          COUNT(*)::int AS count
        FROM events, bounds
        WHERE
          (COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague')::date >= bounds.d0
          AND (COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague')::date < bounds.d1
        GROUP BY city
      )
      INSERT INTO city_monthly_stats (month_key, city, count, updated_at)
      SELECT $1, city, count, NOW()
      FROM agg
      `,
      [mk]
    );

    await pool.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await pool.query("ROLLBACK");
    return { ok: false, error: e?.message || "recompute_failed" };
  }
}

export async function getMonthlyCityStats(monthKey) {
  const mk = String(monthKey || "").trim();
  if (!/^\d{4}-\d{2}$/.test(mk)) return [];
  const res = await pool.query(
    `
    SELECT city, count
    FROM city_monthly_stats
    WHERE month_key=$1
    ORDER BY count DESC, city ASC
    `,
    [mk]
  );
  return res.rows;
}

export async function getStatsFiltered(filters) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();
  const monthKey = String(filters?.month || "").trim(); // "YYYY-MM"

  const where = [`created_at >= NOW() - INTERVAL '30 days'`];
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

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const byDay = await pool.query(
    `
    SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
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
    SELECT id, title, link, COALESCE(NULLIF(city_text,''), place_text) AS city, duration_min, start_time_iso, end_time_iso, created_at
    FROM events
    ${whereSql} AND duration_min IS NOT NULL AND duration_min > 0
    ORDER BY duration_min DESC
    LIMIT 10;
    `,
    params
  );

  // ✅ měsíční města (persistované + vrácené celé)
  let monthlyCities = [];
  if (/^\d{4}-\d{2}$/.test(monthKey)) {
    await recomputeMonthlyCityStats(monthKey);
    monthlyCities = await getMonthlyCityStats(monthKey);
  }

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longest.rows,
    monthlyCities
  };
}
