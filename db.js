import pg from "pg";

const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 720)); // 12h

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

      closed_detected_at TIMESTAMPTZ,

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
    ["events", "city_text", "TEXT"],
    ["events", "event_type", "TEXT"],
    ["events", "description_raw", "TEXT"],
    ["events", "start_time_iso", "TEXT"],
    ["events", "end_time_iso", "TEXT"],
    ["events", "duration_min", "INTEGER"],
    ["events", "is_closed", "BOOLEAN"],
    ["events", "closed_detected_at", "TIMESTAMPTZ"],
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

  // pojistka – smaž extrémy
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

// ✅ generuj ISO string v UTC přímo v SQL (TEXT)
function sqlUtcIsoNow() {
  // bez milisekund (stabilní a parsovatelný)
  return `to_char((NOW() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
}

export async function upsertEvent(ev) {
  const dur = clampDuration(ev.durationMin);

  // ✅ důležité:
  // - pokud přechází do ukončeno poprvé (events.is_closed=false, excluded.is_closed=true):
  //   - nastav closed_detected_at = NOW()
  //   - a pokud nemáme validní end_time_iso z RSS/ESP => end_time_iso = NOW(UTC)
  // - další updaty už end_time neposunou dopředu (zůstane původní)
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
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      CASE
        WHEN $13 = TRUE AND $11 IS NULL THEN ${sqlUtcIsoNow()}
        ELSE $11
      END,
      $12,$13,
      CASE WHEN $13 = TRUE THEN NOW() ELSE NULL END,
      NOW(), NOW()
    )
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

      is_closed = (events.is_closed OR EXCLUDED.is_closed),

      closed_detected_at = CASE
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN NOW()
        ELSE events.closed_detected_at
      END,

      end_time_iso = CASE
        WHEN EXCLUDED.end_time_iso IS NOT NULL THEN EXCLUDED.end_time_iso
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN ${sqlUtcIsoNow()}
        ELSE events.end_time_iso
      END,

      duration_min = CASE
        WHEN EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min
        WHEN events.duration_min IS NOT NULL AND events.duration_min > $14 THEN NULL
        ELSE events.duration_min
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

export async function updateEventEndTime(id, endTimeIso) {
  const v = String(endTimeIso || "").trim();
  if (!v) return;
  await pool.query(
    `UPDATE events SET end_time_iso=$2, is_closed=TRUE, closed_detected_at=COALESCE(closed_detected_at, NOW()), last_seen_at=NOW() WHERE id=$1`,
    [id, v]
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

// ✅ Tohle je ten „START OD TEĎ“ fix:
// staré ukončené záznamy (olderThanHours) vyčistíme,
// aby neměly duration ani end_time => nikdy se do žebříčků nebudou počítat
export async function purgeOldClosedBadDurations({ olderThanHours = 12, maxDurationMinutes = MAX_DURATION_MINUTES } = {}) {
  const hrs = Math.max(1, Number(olderThanHours) || 12);
  const maxDur = Math.max(60, Number(maxDurationMinutes) || MAX_DURATION_MINUTES);

  const res = await pool.query(
    `
    UPDATE events
    SET duration_min = NULL,
        end_time_iso = NULL
    WHERE is_closed = TRUE
      AND (
        duration_min IS NULL
        OR duration_min > $2
        OR COALESCE(NULLIF(end_time_iso,'')::timestamptz, closed_detected_at, last_seen_at, created_at) < (NOW() - ($1 || ' hours')::interval)
      )
    `,
    [hrs, maxDur]
  );

  return { ok: true, cleared: res.rowCount };
}

export async function getClosedEventsMissingDuration(limit = 200) {
  const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
  const res = await pool.query(
    `
    SELECT
      id,
      title,
      link,
      pub_date,
      city_text,
      place_text,
      status_text,
      start_time_iso,
      end_time_iso,
      duration_min,
      is_closed,
      created_at
    FROM events
    WHERE duration_min IS NULL
      AND end_time_iso IS NOT NULL
      AND is_closed = TRUE
    ORDER BY COALESCE(NULLIF(end_time_iso,'' )::timestamptz, created_at) DESC
    LIMIT $1
    `,
    [lim]
  );
  return res.rows;
}

function buildTimeWindowSql(day, params, iStart) {
  const clauses = [];
  let i = iStart;

  if (day === "today" || day === "yesterday" || day === "tomorrow") {
    const offset = day === "yesterday" ? 1 : (day === "tomorrow" ? -1 : 0);
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

  const dayWin = buildTimeWindowSql(day, params, i);
  where.push(...dayWin.clauses);
  i = dayWin.nextI;

  const mWin = buildMonthSql(month, params, i);
  where.push(...mWin.clauses);
  i = mWin.nextI;

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
      SUM(CASE WHEN is_closed THEN 1 ELSE 0 END)::int AS closed,
      SUM(CASE WHEN NOT is_closed THEN 1 ELSE 0 END)::int AS open
    FROM events
    ${whereSql}
    `,
    params
  );

  // ✅ Nejdelší: ber jen to, co má smysl:
  // - buď aktivní (počítá se od startu do teď max do limitu),
  // - nebo ukončené s uloženou duration_min (a ta už nebude u starých “vyčištěných” existovat)
  const longest = await pool.query(
    `
    SELECT
      id,
      title,
      link,
      COALESCE(NULLIF(city_text,''), place_text) AS city,
      CASE
        WHEN duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${i}
          THEN duration_min
        WHEN NOT is_closed
          THEN LEAST(
            $${i},
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
    ${whereSql}
      AND (
        (duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${i})
        OR (NOT is_closed)
      )
    ORDER BY duration_min DESC NULLS LAST
    LIMIT 10;
    `,
    [...params, MAX_DURATION_MINUTES]
  );

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longest.rows
  };
}
