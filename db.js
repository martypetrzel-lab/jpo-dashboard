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

function clampDuration(v) {
  if (!Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n <= 0) return null;
  if (n > MAX_DURATION_MINUTES) return null;
  return n;
}

async function getSetting(key) {
  const res = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
  return res.rows[0]?.value ?? null;
}

export async function getDurationCutoffIso() {
  const v = await getSetting("duration_cutoff_iso");
  // fallback: když by tabulka nebyla ready
  return v || new Date().toISOString();
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

      -- ✅ duration: když je nový dur null, nech starý; ale když je starý extrémní, smaž ho
      duration_min = CASE
        WHEN EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min
        WHEN events.duration_min IS NOT NULL AND events.duration_min > $14 THEN NULL
        ELSE events.duration_min
      END,

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
      dur,
      !!ev.isClosed,
      MAX_DURATION_MINUTES
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

function buildTimeWindowSql(day, params, iStart) {
  const clauses = [];
  let i = iStart;

  if (day === "today" || day === "yesterday") {
    const offset = day === "yesterday" ? 1 : 0;
    clauses.push(
      `( (COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date = ((NOW() AT TIME ZONE 'Europe/Prague')::date - $${i}::int) )`
    );
    params.push(offset);
    i++;
  }

  return { clauses, nextI: i };
}

function buildMonthSql(month, params, iStart) {
  const clauses = [];
  let i = iStart;
  if (month) {
    const m = month.match(/^\d{4}-\d{2}$/);
    if (m) {
      clauses.push(
        `date_trunc('month', (COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')) = date_trunc('month', to_date($${i}, 'YYYY-MM'))`
      );
      params.push(month);
      i++;
    }
  }
  return { clauses, nextI: i };
}

export async function getEventsFiltered(filters, limit = 400) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();
  const day = String(filters?.day || "all").toLowerCase();
  const month = String(filters?.month || "").trim();

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

  const dayWin = buildTimeWindowSql(day, params, i);
  where.push(...dayWin.clauses);
  i = dayWin.nextI;

  const mWin = buildMonthSql(month, params, i);
  where.push(...mWin.clauses);
  i = mWin.nextI;

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
    ORDER BY COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) DESC, created_at DESC
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
  const day = String(filters?.day || "all").toLowerCase();
  const month = String(filters?.month || "").trim();

  // ✅ cutoff: od tohoto okamžiku počítáme "nejdelší zásahy" a ukládáme nové délky
  // (historie zůstává nedotčená)
  const cutoffIso = await getDurationCutoffIso();

  // ------------------------
  // 30 dní – graf / typy / open×closed
  // ------------------------
  const where30 = [`created_at >= NOW() - INTERVAL '30 days'`];
  const params30 = [];
  let i30 = 1;

  if (types.length) {
    where30.push(`event_type = ANY($${i30}::text[])`);
    params30.push(types);
    i30++;
  }

  if (city) {
    where30.push(`(COALESCE(city_text,'') ILIKE $${i30} OR COALESCE(place_text,'') ILIKE $${i30})`);
    params30.push(`%${city}%`);
    i30++;
  }

  if (status === "open") where30.push(`is_closed = FALSE`);
  if (status === "closed") where30.push(`is_closed = TRUE`);

  const dayWin30 = buildTimeWindowSql(day, params30, i30);
  where30.push(...dayWin30.clauses);
  i30 = dayWin30.nextI;

  const mWin30 = buildMonthSql(month, params30, i30);
  where30.push(...mWin30.clauses);
  i30 = mWin30.nextI;

  const where30Sql = `WHERE ${where30.join(" AND ")}`;

  const byDay = await pool.query(
    `
    SELECT
      to_char(((COALESCE(NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS count
    FROM events
    ${where30Sql}
    GROUP BY day
    ORDER BY day ASC;
    `,
    params30
  );

  const byType = await pool.query(
    `
    SELECT COALESCE(event_type,'other') AS type, COUNT(*)::int AS count
    FROM events
    ${where30Sql}
    GROUP BY type
    ORDER BY count DESC;
    `,
    params30
  );

  const openVsClosed = await pool.query(
    `
    SELECT
      SUM(CASE WHEN is_closed THEN 1 ELSE 0 END)::int AS closed,
      SUM(CASE WHEN NOT is_closed THEN 1 ELSE 0 END)::int AS open
    FROM events
    ${where30Sql}
    `,
    params30
  );

  // ------------------------
  // Žebříček měst – ZE VŠECH VÝJEZDŮ (bez 30denního okna)
  // ------------------------
  const whereAll = [];
  const paramsAll = [];
  let iAll = 1;

  if (types.length) {
    whereAll.push(`event_type = ANY($${iAll}::text[])`);
    paramsAll.push(types);
    iAll++;
  }
  if (city) {
    whereAll.push(`(COALESCE(city_text,'') ILIKE $${iAll} OR COALESCE(place_text,'') ILIKE $${iAll})`);
    paramsAll.push(`%${city}%`);
    iAll++;
  }
  if (status === "open") whereAll.push(`is_closed = FALSE`);
  if (status === "closed") whereAll.push(`is_closed = TRUE`);

  // ✅ den v žebříčku měst ignorujeme – už filtrujeme v serveru day=all, ale pro jistotu
  const mWinAll = buildMonthSql(month, paramsAll, iAll);
  whereAll.push(...mWinAll.clauses);
  iAll = mWinAll.nextI;

  const whereAllSql = whereAll.length ? `WHERE ${whereAll.join(" AND ")}` : "";

  const topCities = await pool.query(
    `
    SELECT COALESCE(NULLIF(city_text,''), NULLIF(place_text,''), '(neznámé)') AS city, COUNT(*)::int AS count
    FROM events
    ${whereAllSql}
    GROUP BY city
    ORDER BY count DESC
    LIMIT 15;
    `,
    paramsAll
  );

  // ------------------------
  // Nejdelší zásahy – POUZE NOVÉ od cutoff
  // ------------------------
  const whereLongest = [...whereAll, `first_seen_at >= $${iAll}::timestamptz`];
  const paramsLongest = [...paramsAll, cutoffIso];
  const whereLongestSql = `WHERE ${whereLongest.join(" AND ")}`;

  const longest = await pool.query(
    `
    SELECT
      id,
      title,
      link,
      COALESCE(NULLIF(city_text,''), place_text) AS city,
      CASE
        WHEN duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${iAll + 1}
          THEN duration_min
        WHEN NOT is_closed
          THEN LEAST(
            $${iAll + 1},
            GREATEST(
              1,
              FLOOR(
                EXTRACT(EPOCH FROM (
                  NOW() - COALESCE(NULLIF(start_time_iso,'')::timestamptz, first_seen_at, created_at)
                )) / 60
              )::int
            )
          )
        ELSE NULL
      END AS duration_min,
      start_time_iso,
      end_time_iso,
      is_closed,
      created_at
    FROM events
    ${whereLongestSql}
      AND (
        (duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${iAll + 1})
        OR (NOT is_closed)
      )
    ORDER BY duration_min DESC NULLS LAST
    LIMIT 10;
    `,
    [...paramsLongest, MAX_DURATION_MINUTES]
  );

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longest.rows,
    durationCutoffIso: cutoffIso
  };
}
