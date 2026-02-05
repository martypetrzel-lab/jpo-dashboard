import pg from "pg";

const { Pool } = pg;

// Railway/Render/etc. typicky dávají DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

let pool = null;

function getPool() {
  if (pool) return pool;

  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL not set");
  }

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return pool;
}

export async function initDb() {
  const p = getPool();

  // events
  await p.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT,
      link TEXT,
      pub_date TIMESTAMPTZ NULL,
      place_text TEXT NULL,
      city_text TEXT NULL,
      status_text TEXT NULL,
      event_type TEXT NULL,
      description_raw TEXT NULL,

      start_time_iso TIMESTAMPTZ NULL,
      end_time_iso TIMESTAMPTZ NULL,

      is_closed BOOLEAN NOT NULL DEFAULT FALSE,
      closed_detected_at TIMESTAMPTZ NULL,
      duration_min INTEGER NULL,

      lat DOUBLE PRECISION NULL,
      lon DOUBLE PRECISION NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_pub_date ON events(pub_date);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time_iso);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_closed ON events(is_closed);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_city ON events(city_text);`);

  // geocode cache
  await p.query(`
    CREATE TABLE IF NOT EXISTS geocode_cache (
      q TEXT PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function upsertEvent(ev) {
  const p = getPool();

  const id = ev.id;
  const title = ev.title ?? null;
  const link = ev.link ?? null;

  const pubDate = ev.pubDate ? new Date(ev.pubDate) : null;
  const pubDateTs = pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate.toISOString() : null;

  const placeText = ev.placeText ?? null;
  const cityText = ev.cityText ?? null;
  const statusText = ev.statusText ?? null;
  const eventType = ev.eventType ?? null;
  const descriptionRaw = ev.descriptionRaw ?? null;

  const startTimeIso = ev.startTimeIso ? new Date(ev.startTimeIso) : null;
  const startTs = startTimeIso && !Number.isNaN(startTimeIso.getTime()) ? startTimeIso.toISOString() : null;

  const endTimeIso = ev.endTimeIso ? new Date(ev.endTimeIso) : null;
  const endTs = endTimeIso && !Number.isNaN(endTimeIso.getTime()) ? endTimeIso.toISOString() : null;

  const isClosed = !!ev.isClosed;
  const durationMin = Number.isFinite(ev.durationMin) ? Math.round(ev.durationMin) : null;

  // Logika:
  // - closed_detected_at nastav jen při přechodu FALSE->TRUE
  // - end_time_iso nastav jen při prvním uzavření
  // - duration_min ulož jen pokud se ještě nepoužila (při prvním uzavření)
  await p.query(
    `
    INSERT INTO events (
      id, title, link, pub_date, place_text, city_text, status_text, event_type, description_raw,
      start_time_iso, end_time_iso, is_closed, closed_detected_at, duration_min,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,
      $10,$11,$12,
      CASE WHEN $12 = TRUE THEN NOW() ELSE NULL END,
      $13,
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, events.title),
      link = COALESCE(EXCLUDED.link, events.link),
      pub_date = COALESCE(EXCLUDED.pub_date, events.pub_date),
      place_text = COALESCE(EXCLUDED.place_text, events.place_text),
      city_text = COALESCE(EXCLUDED.city_text, events.city_text),
      status_text = COALESCE(EXCLUDED.status_text, events.status_text),
      event_type = COALESCE(EXCLUDED.event_type, events.event_type),
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),

      -- end_time_iso jen při prvním uzavření
      end_time_iso = CASE
        WHEN events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE THEN COALESCE(EXCLUDED.end_time_iso, NOW())
        ELSE events.end_time_iso
      END,

      is_closed = (events.is_closed OR EXCLUDED.is_closed),

      -- closed_detected_at jen při prvním uzavření
      closed_detected_at = CASE
        WHEN events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE THEN NOW()
        ELSE events.closed_detected_at
      END,

      -- duration_min jen při prvním uzavření (pokud máme spočítané)
      duration_min = CASE
        WHEN events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE AND EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min
        ELSE events.duration_min
      END,

      updated_at = NOW()
    ;
    `,
    [
      id,
      title,
      link,
      pubDateTs,
      placeText,
      cityText,
      statusText,
      eventType,
      descriptionRaw,
      startTs,
      endTs,
      isClosed,
      durationMin,
    ]
  );
}

export async function getEventFirstSeen(id) {
  const p = getPool();
  const r = await p.query(`SELECT first_seen FROM events WHERE id=$1`, [id]);
  return r.rows?.[0]?.first_seen || null;
}

export async function updateEventDuration(id, durMin) {
  const p = getPool();
  const v = Number.isFinite(durMin) ? Math.round(durMin) : null;
  if (!v || v <= 0) return;

  await p.query(`UPDATE events SET duration_min=$2, updated_at=NOW() WHERE id=$1`, [id, v]);
}

export async function updateEventCoords(id, lat, lon) {
  const p = getPool();
  await p.query(`UPDATE events SET lat=$2, lon=$3, updated_at=NOW() WHERE id=$1`, [id, lat, lon]);
}

export async function clearEventCoords(id) {
  const p = getPool();
  await p.query(`UPDATE events SET lat=NULL, lon=NULL, updated_at=NOW() WHERE id=$1`, [id]);
}

// ---------------- GEOCODE CACHE ----------------
export async function getCachedGeocode(q) {
  const p = getPool();
  const r = await p.query(`SELECT lat, lon FROM geocode_cache WHERE q=$1`, [q]);
  return r.rows?.[0] || null;
}

export async function setCachedGeocode(q, lat, lon) {
  const p = getPool();
  await p.query(
    `
    INSERT INTO geocode_cache(q, lat, lon)
    VALUES($1,$2,$3)
    ON CONFLICT (q) DO UPDATE SET lat=EXCLUDED.lat, lon=EXCLUDED.lon
    `,
    [q, lat, lon]
  );
}

export async function deleteCachedGeocode(q) {
  const p = getPool();
  await p.query(`DELETE FROM geocode_cache WHERE q=$1`, [q]);
}

// ---------------- FILTER HELPERS ----------------
function buildWhere(filters, params) {
  const where = [];

  // status
  if (filters.status === "open") where.push(`is_closed = FALSE`);
  else if (filters.status === "closed") where.push(`is_closed = TRUE`);

  // type(s)
  if (filters.types && filters.types.length > 0) {
    params.push(filters.types[0]);
    where.push(`event_type = $${params.length}`);
  }

  // city substring (city_text OR place_text)
  if (filters.city) {
    params.push(`%${filters.city}%`);
    where.push(`(COALESCE(city_text,'') ILIKE $${params.length} OR COALESCE(place_text,'') ILIKE $${params.length})`);
  }

  // month YYYY-MM (podle lokálního CZ dne)
  if (filters.month) {
    // použijeme local_date = (COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date
    params.push(filters.month);
    where.push(`to_char((COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date, 'YYYY-MM') = $${params.length}`);
  }

  // day today/yesterday/all
  if (filters.day === "today") {
    where.push(
      `((COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date = (NOW() AT TIME ZONE 'Europe/Prague')::date)`
    );
  } else if (filters.day === "yesterday") {
    where.push(
      `((COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date = ((NOW() AT TIME ZONE 'Europe/Prague')::date - INTERVAL '1 day')::date)`
    );
  }

  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

// ---------------- QUERIES ----------------
export async function getEventsFiltered(filters, limit = 400) {
  const p = getPool();
  const params = [];
  const whereSql = buildWhere(filters, params);

  params.push(limit);

  const r = await p.query(
    `
    SELECT
      id,
      title,
      link,
      pub_date,
      place_text,
      city_text,
      status_text,
      event_type,
      description_raw,
      start_time_iso,
      end_time_iso,
      is_closed,
      closed_detected_at,
      duration_min,
      lat,
      lon,
      created_at,
      updated_at
    FROM events
    ${whereSql}
    ORDER BY COALESCE(start_time_iso, pub_date, created_at) DESC
    LIMIT $${params.length}
    `,
    params
  );

  return r.rows || [];
}

export async function getStatsFiltered(filters) {
  const p = getPool();
  const params = [];
  const whereSql = buildWhere(filters, params);

  // counts
  const c = await p.query(
    `
    SELECT
      SUM(CASE WHEN is_closed=FALSE THEN 1 ELSE 0 END)::int AS open_count,
      SUM(CASE WHEN is_closed=TRUE THEN 1 ELSE 0 END)::int AS closed_count
    FROM events
    ${whereSql}
    `,
    params
  );

  const openCount = c.rows?.[0]?.open_count ?? 0;
  const closedCount = c.rows?.[0]?.closed_count ?? 0;

  // byDay (posledních 14 dní v rámci filtru)
  const by = await p.query(
    `
    SELECT
      to_char((COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date, 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 14
    `,
    params
  );

  const byDay = (by.rows || []).reverse();

  // topCities
  const tc = await p.query(
    `
    SELECT
      NULLIF(trim(COALESCE(city_text, place_text, '')), '') AS city,
      COUNT(*)::int AS count
    FROM events
    ${whereSql}
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 10
    `,
    params
  );

  const topCities = (tc.rows || []).filter((x) => x.city);

  // longest — ✅ po uzavření a uložení duration se sem automaticky dostanou
  // (bereme jen ty, co mají duration_min > 0 a closed_detected_at != null)
  const lo = await p.query(
    `
    SELECT
      id, title, city_text, place_text, duration_min
    FROM events
    ${whereSql}
    AND is_closed = TRUE
    AND closed_detected_at IS NOT NULL
    AND duration_min IS NOT NULL
    AND duration_min > 0
    ORDER BY duration_min DESC
    LIMIT 10
    `,
    params
  ).catch(async () => {
    // pokud whereSql je prázdné (bez WHERE), tak ten "AND ..." by spadl.
    // fallback: udělej query správně
    const params2 = [];
    const w = buildWhere(filters, params2);
    const extra = w ? `${w} AND` : `WHERE`;
    return await p.query(
      `
      SELECT
        id, title, city_text, place_text, duration_min
      FROM events
      ${extra}
        is_closed = TRUE
        AND closed_detected_at IS NOT NULL
        AND duration_min IS NOT NULL
        AND duration_min > 0
      ORDER BY duration_min DESC
      LIMIT 10
      `,
      params2
    );
  });

  const longest = lo.rows || [];

  return { openCount, closedCount, byDay, topCities, longest };
}

export async function getEventsOutsideCz(limit = 200) {
  const p = getPool();
  const r = await p.query(
    `
    SELECT id, lat, lon
    FROM events
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND (
        lat < 48.55 OR lat > 51.06 OR
        lon < 12.09 OR lon > 18.87
      )
    ORDER BY updated_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return r.rows || [];
}