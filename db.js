import pg from "pg";

// ✅ sanity limit (default 3 dny)
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

  // migrations (když DB vznikla ve starší verzi)
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

  // ✅ „baseline“: všechny existující ukončené záznamy bereme jako historické
  // (nesmí jim to dopočítávat délky podle "teď"). Spustí se pouze jednou.
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
      `INSERT INTO meta(key, value) VALUES('closed_baseline_v1','1')
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`
    );
  }

  // ✅ jednorázové vyčištění extrémních délek
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

function pick(ev, a, b, fallback = null) {
  const va = ev?.[a];
  if (va !== undefined && va !== null && String(va).length) return va;
  const vb = ev?.[b];
  if (vb !== undefined && vb !== null && String(vb).length) return vb;
  return fallback;
}

// ✅ UPSERT s okamžitým spočtem délky při přechodu OPEN->CLOSED
export async function upsertEvent(ev) {
  const id = pick(ev, "id", "ID", "").trim();
  if (!id) return;

  const title = pick(ev, "title", "Title", "");
  const link = pick(ev, "link", "Link", "");
  const pubDate = pick(ev, "pubDate", "pub_date", null);

  const placeText = pick(ev, "placeText", "place_text", null);
  const cityText = pick(ev, "cityText", "city_text", null);

  const statusText = pick(ev, "statusText", "status_text", null);
  const eventType = pick(ev, "eventType", "event_type", null);

  const descriptionRaw = pick(ev, "descriptionRaw", "description_raw", null);

  const startTimeIso = pick(ev, "startTimeIso", "start_time_iso", null);

  // ⚠️ end_time_iso z RSS ignorujeme (ESP/RSS mívá špatně budoucnost).
  // Konec se nastaví v SQL při přechodu OPEN->CLOSED jako NOW (UTC).
  const endTimeIso = null;

  // durationMin sem neposíláme "z RSS" – počítá se v SQL při přechodu OPEN->CLOSED.
  const durationMin = null;

  const isClosed = !!(ev?.isClosed ?? ev?.is_closed ?? false);

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
      $10::text, NULL, NULL, $11::boolean,
      NULL,
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

      -- ✅ end_time_iso: nastav jen při přechodu OPEN->CLOSED, jinak nech
      end_time_iso = CASE
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE)
          THEN to_char((NOW() AT TIME ZONE 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ELSE events.end_time_iso
      END,

      -- ✅ closed_detected_at: jen při přechodu OPEN->CLOSED
      closed_detected_at = CASE
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE)
          THEN NOW()
        ELSE events.closed_detected_at
      END,

      -- ✅ duration_min: hned při přechodu OPEN->CLOSED, ale jen když máme start_time_iso a výsledek je rozumný
      duration_min = CASE
        WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN
          CASE
            WHEN COALESCE(NULLIF(events.start_time_iso,''), NULLIF(EXCLUDED.start_time_iso,'')) IS NULL THEN NULL
            ELSE
              CASE
                WHEN (
                  ROUND(
                    EXTRACT(
                      EPOCH FROM (
                        (NOW() AT TIME ZONE 'utc') -
                        (COALESCE(NULLIF(events.start_time_iso,''), NULLIF(EXCLUDED.start_time_iso,''))::timestamptz AT TIME ZONE 'utc')
                      )
                    ) / 60.0
                  )
                ) BETWEEN 1 AND $12
                THEN ROUND(
                  EXTRACT(
                    EPOCH FROM (
                      (NOW() AT TIME ZONE 'utc') -
                      (COALESCE(NULLIF(events.start_time_iso,''), NULLIF(EXCLUDED.start_time_iso,''))::timestamptz AT TIME ZONE 'utc')
                    )
                  ) / 60.0
                )::int
                ELSE NULL
              END
          END
        ELSE
          CASE
            WHEN events.duration_min IS NOT NULL AND events.duration_min > $12 THEN NULL
            ELSE events.duration_min
          END
      END,

      is_closed = (events.is_closed OR EXCLUDED.is_closed),
      last_seen_at = NOW()
    `,
    [
      id,
      title,
      link,
      pubDate || null,
      placeText || null,
      cityText || null,
      statusText || null,
      eventType || null,
      descriptionRaw || null,
      startTimeIso || null,
      isClosed,
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

// ✅ pokud někdy chceš ručně přepsat end_time + duration
export async function updateEventDuration(id, endTimeIso, durationMin) {
  const dur = clampDuration(durationMin);
  await pool.query(
    `UPDATE events SET end_time_iso=$2, duration_min=$3 WHERE id=$1`,
    [id, endTimeIso || null, dur]
  );
}

export async function getClosedEventsMissingDuration(limit = 200) {
  const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
  const res = await pool.query(
    `
    SELECT
      id,
      start_time_iso,
      end_time_iso,
      duration_min,
      is_closed,
      closed_detected_at,
      created_at
    FROM events
    WHERE duration_min IS NULL
      AND is_closed = TRUE
      AND closed_detected_at IS NOT NULL
      AND end_time_iso IS NOT NULL
    ORDER BY COALESCE(NULLIF(end_time_iso,'' )::timestamptz, created_at) DESC
    LIMIT $1
    `,
    [lim]
  );
  return res.rows;
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
  const res = await pool.query(
    `SELECT start_time_iso, pub_date, first_seen_at FROM events WHERE id=$1`,
    [id]
  );
  return res.rows[0] || null;
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

// ---- filtrování (ponecháno stejné, jako máš v projektu) ----
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
      closed_detected_at,
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