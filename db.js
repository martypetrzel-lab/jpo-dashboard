import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false }
});

let _inited = false;

export async function initDb() {
  if (_inited) return;
  _inited = true;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT,
      link TEXT,
      pub_date TEXT,
      pub_ts TIMESTAMPTZ,

      place_text TEXT,
      city_text TEXT,
      status_text TEXT,
      event_type TEXT,
      description_raw TEXT,

      start_time_iso TEXT,
      end_time_iso TEXT,
      duration_min INT,
      is_closed BOOLEAN DEFAULT FALSE,

      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,

      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_pub_ts ON events(pub_ts DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_city ON events(city_text);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(is_closed);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS geocache (
      key TEXT PRIMARY KEY,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      source TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/**
 * ✅ Admin helper: vynulovat extrémní duration_min, ale NESMAZAT události.
 */
export async function clearExtremeDurations(maxMinutes = 720) {
  const mm = Number(maxMinutes);
  const safe = Number.isFinite(mm) ? Math.max(1, Math.min(mm, 43200)) : 720;
  const res = await pool.query(
    `
    UPDATE events
    SET duration_min = NULL
    WHERE duration_min IS NOT NULL
      AND (duration_min < 0 OR duration_min > $1)
    `,
    [safe]
  );
  return res.rowCount;
}

/**
 * ✅ Recalc duration_min pro uzavřené zásahy podle:
 *   - start_time_iso (ideálně z pubDate)
 *   - end_time_iso (z "ukončení:" v RSS)
 * Fallbacky:
 *   - pub_ts
 *   - created_at
 */
export async function recalcDurationsFromTimes({ maxMinutes = 10080, limit = 2000 } = {}) {
  const mm = Number(maxMinutes);
  const safeMax = Number.isFinite(mm) ? Math.max(1, Math.min(mm, 43200)) : 10080;
  const lim = Math.max(1, Math.min(Number(limit) || 2000, 10000));

  // 1) Doplnit start_time_iso z pub_ts, kde chybí (jen pro uzavřené a s end_time)
  await pool.query(
    `
    UPDATE events
    SET start_time_iso = pub_ts::text
    WHERE start_time_iso IS NULL
      AND pub_ts IS NOT NULL
      AND end_time_iso IS NOT NULL
      AND is_closed = TRUE
    `
  );

  // 2) Přepočet duration_min – pouze tam, kde je NULL nebo extrém
  const res = await pool.query(
    `
    WITH cand AS (
      SELECT id,
             COALESCE(NULLIF(start_time_iso,''), pub_ts::text, created_at::text) AS start_iso,
             NULLIF(end_time_iso,'') AS end_iso
      FROM events
      WHERE is_closed = TRUE
        AND end_time_iso IS NOT NULL
        AND (duration_min IS NULL OR duration_min < 0 OR duration_min > $1)
      ORDER BY COALESCE(pub_ts, created_at) DESC
      LIMIT $2
    )
    UPDATE events e
    SET duration_min = sub.new_min
    FROM (
      SELECT id,
             CASE
               WHEN start_iso IS NULL OR end_iso IS NULL THEN NULL
               WHEN (end_iso::timestamptz <= start_iso::timestamptz) THEN NULL
               ELSE (
                 CASE
                   WHEN ROUND(EXTRACT(EPOCH FROM (end_iso::timestamptz - start_iso::timestamptz))/60)::int BETWEEN 0 AND $1
                     THEN ROUND(EXTRACT(EPOCH FROM (end_iso::timestamptz - start_iso::timestamptz))/60)::int
                   ELSE NULL
                 END
               )
             END AS new_min
      FROM cand
    ) sub
    WHERE e.id = sub.id
      AND sub.new_min IS NOT NULL;
    `,
    [safeMax, lim]
  );

  return res.rowCount;
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
      pub_ts = COALESCE(EXCLUDED.pub_ts, events.pub_ts),

      place_text = COALESCE(EXCLUDED.place_text, events.place_text),
      city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),

      status_text = COALESCE(EXCLUDED.status_text, events.status_text),
      event_type  = COALESCE(EXCLUDED.event_type, events.event_type),
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),
      end_time_iso   = COALESCE(EXCLUDED.end_time_iso,   events.end_time_iso),
      duration_min   = COALESCE(EXCLUDED.duration_min,   events.duration_min),

      is_closed = COALESCE(EXCLUDED.is_closed, events.is_closed),

      last_seen_at = NOW()
    `,
    [
      ev.id,
      ev.title || null,
      ev.link || null,
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
      ev.isClosed === true
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

  // ✅ denní filtr pro mapu + tabulku (v časové zóně Europe/Prague)
  // FE pro "today"/"yesterday" očekává, že se mapují jen události z daného dne.
  if (day === "today") {
    where.push(
      `(COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague')::date = (NOW() AT TIME ZONE 'Europe/Prague')::date`
    );
  } else if (day === "yesterday") {
    where.push(
      `(COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague')::date = ((NOW() AT TIME ZONE 'Europe/Prague')::date - INTERVAL '1 day')::date`
    );
  } // day === "all" -> bez omezení

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

export async function getStatsFiltered(filters) {
  const types = Array.isArray(filters?.types) ? filters.types : [];
  const city = String(filters?.city || "").trim();
  const status = String(filters?.status || "all").toLowerCase();
  const month = String(filters?.month || "").trim();

  const where = [`COALESCE(pub_ts, created_at) >= NOW() - INTERVAL '30 days'`];
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
    SELECT
      to_char((COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague')::date, 'YYYY-MM-DD') AS day,
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

  const longest = await pool.query(
    `
    SELECT id, title, link, COALESCE(NULLIF(city_text,''), place_text) AS city, duration_min, created_at
    FROM events
    ${whereSql} AND duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= 720
    ORDER BY duration_min DESC
    LIMIT 10;
    `,
    params
  );

  // ✅ Žebříček měst podle vybraného měsíce (ignoruje textový filtr města)
  // FE hlavička: "Měsíc podle filtru (všechna města)"
  let monthlyCities = [];
  if (/^\d{4}-\d{2}$/.test(month)) {
    const monthParams = [];
    let j = 1;

    const monthStartParam = `$${j++}`;
    const monthEndParam = `$${j++}`;

    monthParams.push(`${month}-01`);

    const [yy, mm] = month.split("-").map((n) => Number(n));
    const nextMonth = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
    monthParams[1] = nextMonth;

    const monthWhere = [];
    // časový rozsah podle pub_ts / created_at převedený do Prague
    monthWhere.push(
      `((COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague') >= (${monthStartParam}::date) AND (COALESCE(pub_ts, created_at) AT TIME ZONE 'Europe/Prague') < (${monthEndParam}::date))`
    );

    if (types.length) {
      monthWhere.push(`event_type = ANY($${j}::text[])`);
      monthParams.push(types);
      j++;
    }
    if (status === "open") monthWhere.push(`is_closed = FALSE`);
    if (status === "closed") monthWhere.push(`is_closed = TRUE`);

    const monthlyRes = await pool.query(
      `
      SELECT COALESCE(NULLIF(city_text,''), NULLIF(place_text,''), '(neznámé)') AS city, COUNT(*)::int AS count
      FROM events
      WHERE ${monthWhere.join(" AND ")}
      GROUP BY city
      ORDER BY count DESC
      LIMIT 15;
      `,
      monthParams
    );
    monthlyCities = monthlyRes.rows;
  }

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longest.rows,
    monthlyCities
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

export async function getEventsNeedingGeocode(limit = 100) {
  const res = await pool.query(
    `
    SELECT id, title, city_text, place_text, created_at
    FROM events
    WHERE (lat IS NULL OR lon IS NULL)
    ORDER BY COALESCE(pub_ts, created_at) DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
}

export async function getEventsOutsideCz(limit = 100) {
  const res = await pool.query(
    `
    SELECT id, title, city_text, place_text, lat, lon, created_at
    FROM events
    WHERE lat IS NOT NULL AND lon IS NOT NULL
      AND (lat < 48.0 OR lat > 51.2 OR lon < 12.0 OR lon > 19.0)
    ORDER BY COALESCE(pub_ts, created_at) DESC
    LIMIT $1
    `,
    [limit]
  );
  return res.rows;
}

export async function getEventFirstSeen(id) {
  const res = await pool.query(
    `
    SELECT id, first_seen_at, created_at, pub_ts, pub_date
    FROM events
    WHERE id=$1
    `,
    [id]
  );
  return res.rows[0] || null;
}
