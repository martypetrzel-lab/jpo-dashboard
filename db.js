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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_visits_daily (
      day DATE NOT NULL,
      mode TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (day, mode)
    );
  `);


  // ---------------- AUTH TABLES ----------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ops',
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_sha256 TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip TEXT,
      user_agent TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ops_requests_status ON ops_requests(status);`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_requests_pending_user ON ops_requests(user_id) WHERE status='pending';`);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);`);

  // ✅ od kdy počítat "nejdelší zásahy" a ukládat nové délky (nezasahuje do historie)
  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('duration_cutoff_iso', NOW()::text)
    ON CONFLICT (key) DO NOTHING;
  `);

  // ✅ NOVÝ START "nejdelších zásahů" od nasazení této změny.
  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('longest_cutoff_v2_iso', NOW()::text)
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

export async function getSetting(key) {
  const res = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
  return res.rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await pool.query(
    `
    INSERT INTO app_settings (key, value)
    VALUES ($1,$2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [key, value == null ? null : String(value)]
  );
}

// ---------------- AUTH: users / sessions / audit ----------------
export async function getUsersCount() {
  const r = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);
  return r.rows[0]?.c ?? 0;
}

export async function getUserByUsername(username) {
  const r = await pool.query(
    `SELECT id, username, password_hash, role, is_enabled, created_at, last_login_at FROM users WHERE username=$1`,
    [username]
  );
  return r.rows[0] || null;
}

export async function getUserById(id) {
  const r = await pool.query(
    `SELECT id, username, role, is_enabled, created_at, last_login_at FROM users WHERE id=$1`,
    [id]
  );
  return r.rows[0] || null;
}

export async function createUser({ username, passwordHash, role = "ops", isEnabled = true }) {
  const r = await pool.query(
    `
    INSERT INTO users (username, password_hash, role, is_enabled)
    VALUES ($1,$2,$3,$4)
    RETURNING id, username, role, is_enabled, created_at, last_login_at
    `,
    [username, passwordHash, role, !!isEnabled]
  );
  return r.rows[0];
}

export async function listUsers(limit = 200) {
  const r = await pool.query(
    `
    SELECT id, username, role, is_enabled, created_at, last_login_at
    FROM users
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [Math.min(Math.max(1, Number(limit) || 200), 500)]
  );
  return r.rows;
}

export async function updateUserById(id, patch = {}) {
  const fields = [];
  const params = [id];
  let i = 2;

  if (patch.username != null) {
    fields.push(`username=$${i++}`);
    params.push(String(patch.username));
  }
  if (patch.passwordHash != null) {
    fields.push(`password_hash=$${i++}`);
    params.push(String(patch.passwordHash));
  }
  if (patch.role != null) {
    fields.push(`role=$${i++}`);
    params.push(String(patch.role));
  }
  if (patch.isEnabled != null) {
    fields.push(`is_enabled=$${i++}`);
    params.push(!!patch.isEnabled);
  }
  if (patch.lastLoginAtNow) {
    fields.push(`last_login_at=NOW()`);
  }

  if (!fields.length) return await getUserById(id);

  const r = await pool.query(
    `UPDATE users SET ${fields.join(", ")} WHERE id=$1 RETURNING id, username, role, is_enabled, created_at, last_login_at`,
    params
  );
  return r.rows[0] || null;
}

export async function createSession({ userId, tokenSha256, expiresAt, ip, userAgent }) {
  const r = await pool.query(
    `
    INSERT INTO user_sessions (user_id, token_sha256, expires_at, ip, user_agent)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id, user_id, token_sha256, created_at, expires_at
    `,
    [userId, tokenSha256, expiresAt, ip || null, userAgent || null]
  );
  return r.rows[0];
}

export async function deleteSessionByTokenSha(tokenSha256) {
  await pool.query(`DELETE FROM user_sessions WHERE token_sha256=$1`, [tokenSha256]);
}

export async function deleteExpiredSessions() {
  await pool.query(`DELETE FROM user_sessions WHERE expires_at < NOW()`);
}

export async function getSessionUserByTokenSha(tokenSha256) {
  const r = await pool.query(
    `
    SELECT
      s.id AS session_id,
      s.expires_at,
      u.id AS user_id,
      u.username,
      u.role,
      u.is_enabled
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_sha256 = $1
    LIMIT 1
    `,
    [tokenSha256]
  );
  return r.rows[0] || null;
}

export async function insertAudit({ userId = null, username = null, action, details = null, ip = null }) {
  await pool.query(
    `INSERT INTO audit_log (user_id, username, action, details, ip) VALUES ($1,$2,$3,$4,$5)`,
    [userId, username, String(action), details == null ? null : String(details), ip]
  );
}

export async function getDurationCutoffIso() {
  const v = await getSetting("duration_cutoff_iso");
  return v || new Date().toISOString();
}

export async function getLongestCutoffIso() {
  const v = await getSetting("longest_cutoff_v2_iso");
  return v || new Date().toISOString();
}

export async function getEventMeta(id) {
  const res = await pool.query(
    `SELECT id, is_closed, first_seen_at, start_time_iso, end_time_iso, duration_min FROM events WHERE id=$1`,
    [id]
  );
  return res.rows[0] || null;
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

export async function autoCloseStaleOpenEvents({ staleMinutes = 20, limit = 200 } = {}) {
  const stale = Math.max(2, Number(staleMinutes || 0));
  const lim = Math.max(1, Math.min(Number(limit || 0) || 200, 2000));

  // Kandidáti: otevřené události, které nebyly vidět déle než staleMinutes.
  // Uzavřeme je "na základě ESP dat" – end_time = last_seen_at a dopočítáme duration.
  const res = await pool.query(
    `
    WITH candidates AS (
      SELECT
        id,
        last_seen_at,
        COALESCE(NULLIF(start_time_iso,'' )::timestamptz, first_seen_at, created_at) AS start_ts
      FROM events
      WHERE is_closed = FALSE
        AND last_seen_at < (NOW() - ($1::text || ' minutes')::interval)
      ORDER BY last_seen_at ASC
      LIMIT $2
    )
    UPDATE events e
    SET
      is_closed = TRUE,
      end_time_iso = to_char((c.last_seen_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      duration_min = (
        CASE
          WHEN ROUND(EXTRACT(EPOCH FROM (c.last_seen_at - c.start_ts)) / 60.0)::int <= 0 THEN NULL
          WHEN ROUND(EXTRACT(EPOCH FROM (c.last_seen_at - c.start_ts)) / 60.0)::int > $3 THEN NULL
          ELSE ROUND(EXTRACT(EPOCH FROM (c.last_seen_at - c.start_ts)) / 60.0)::int
        END
      ),
      status_text = COALESCE(e.status_text, 'ukončená')
    FROM candidates c
    WHERE e.id = c.id
    RETURNING e.id, e.duration_min, e.end_time_iso;
    `,
    [stale, lim, MAX_DURATION_MINUTES]
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

  const cutoffIso = await getLongestCutoffIso();

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


  // -----------------------------
  // Nejdelší zásahy
  // - pokud je zvolený měsíc (YYYY-MM): TOP 15 UZAVŘENÝCH podle END času (end_time_iso; fallback last_seen_at)
  // - jinak: zachováme původní chování (od cutoff, včetně aktivních – orientačně)
  // -----------------------------

  const hasMonth = /^\d{4}-\d{2}$/.test(String(month || "").trim());

  let longestRows = [];

  if (hasMonth) {
    const whereLongest = [];
    const paramsLongest = [];
    let iL = 1;

    if (types.length) {
      whereLongest.push(`event_type = ANY($${iL}::text[])`);
      paramsLongest.push(types);
      iL++;
    }
    if (city) {
      whereLongest.push(`(COALESCE(city_text,'') ILIKE $${iL} OR COALESCE(place_text,'') ILIKE $${iL})`);
      paramsLongest.push(`%${city}%`);
      iL++;
    }

    // TOP za měsíc dává smysl jen pro uzavřené s uloženou délkou
    whereLongest.push(`is_closed = TRUE`);
    whereLongest.push(`duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${iL}`);
    paramsLongest.push(MAX_DURATION_MINUTES);
    iL++;

    // měsíc podle ukončení (end_time_iso), fallback last_seen_at
    whereLongest.push(`
      (
        (COALESCE(NULLIF(end_time_iso,'' )::timestamptz, last_seen_at) AT TIME ZONE 'Europe/Prague')
        >= date_trunc('month', to_date($${iL}, 'YYYY-MM'))
        AND
        (COALESCE(NULLIF(end_time_iso,'' )::timestamptz, last_seen_at) AT TIME ZONE 'Europe/Prague')
        <  (date_trunc('month', to_date($${iL}, 'YYYY-MM')) + interval '1 month')
      )
    `);
    paramsLongest.push(String(month).trim());
    iL++;

    const whereLongestSql = `WHERE ${whereLongest.join(" AND ")}`;

    const longest = await pool.query(
      `
      SELECT
        id,
        title,
        link,
        COALESCE(NULLIF(city_text,''), place_text) AS city,
        duration_min,
        start_time_iso,
        end_time_iso,
        is_closed,
        created_at
      FROM events
      ${whereLongestSql}
      ORDER BY duration_min DESC NULLS LAST
      LIMIT 15;
      `,
      paramsLongest
    );

    longestRows = longest.rows;
  } else {
    const whereLongest = [];
    const paramsLongest = [];
    let iL = 1;

    if (types.length) {
      whereLongest.push(`event_type = ANY($${iL}::text[])`);
      paramsLongest.push(types);
      iL++;
    }
    if (city) {
      whereLongest.push(`(COALESCE(city_text,'') ILIKE $${iL} OR COALESCE(place_text,'') ILIKE $${iL})`);
      paramsLongest.push(`%${city}%`);
      iL++;
    }
    if (status === "open") whereLongest.push(`is_closed = FALSE`);
    if (status === "closed") whereLongest.push(`is_closed = TRUE`);

    // ochrana proti extrémům a "jen od nynějška"
    whereLongest.push(`first_seen_at >= $${iL}::timestamptz`);
    paramsLongest.push(cutoffIso);
    iL++;

    const whereLongestSql = `WHERE ${whereLongest.join(" AND ")}`;

    const longest = await pool.query(
      `
      SELECT
        id,
        title,
        link,
        COALESCE(NULLIF(city_text,''), place_text) AS city,
        CASE
          WHEN duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${iL}
            THEN duration_min
          WHEN (NOT is_closed)
            THEN LEAST(
              $${iL},
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
          (duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${iL})
          OR (NOT is_closed)
        )
      ORDER BY duration_min DESC NULLS LAST
      LIMIT 10;
      `,
      [...paramsLongest, MAX_DURATION_MINUTES]
    );

    longestRows = longest.rows;
  }


  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longestRows,
    durationCutoffIso: cutoffIso
  };
}


export async function incPageVisit(mode, dayIso) {
  const m = String(mode || "public");
  const day = dayIso; // 'YYYY-MM-DD'
  await pool.query(
    `INSERT INTO page_visits_daily(day, mode, hits)
     VALUES ($1::date, $2, 1)
     ON CONFLICT (day, mode)
     DO UPDATE SET hits = page_visits_daily.hits + 1, updated_at = NOW()`,
    [day, m]
  );
}

export async function getVisitStats(days = 30) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const r = await pool.query(
    `SELECT day::text AS day, mode, hits
     FROM page_visits_daily
     WHERE day >= (CURRENT_DATE - ($1::int - 1))
     ORDER BY day ASC`,
    [d]
  );
  // aggregate totals
  const totals = {};
  for (const row of r.rows) {
    totals[row.mode] = (totals[row.mode] || 0) + Number(row.hits || 0);
  }
  const grand = Object.values(totals).reduce((a,b)=>a+b,0);
  return { days: d, rows: r.rows, totals, grandTotal: grand };
}


export async function createUserPublic({ username, passwordHash }) {
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role, is_enabled) VALUES ($1,$2,'public',TRUE) RETURNING id, username, role, is_enabled`,
    [username, passwordHash]
  );
  return r.rows[0] || null;
}

export async function createOpsRequest(userId) {
  // unique pending per user (partial index)
  const r = await pool.query(
    `INSERT INTO ops_requests (user_id, status) VALUES ($1,'pending')
     ON CONFLICT DO NOTHING
     RETURNING id, status, requested_at`,
    [userId]
  );
  return r.rows[0] || null;
}

export async function listPendingOpsRequests(limit = 50) {
  const r = await pool.query(
    `SELECT r.id, r.user_id, r.requested_at, u.username
     FROM ops_requests r
     JOIN users u ON u.id = r.user_id
     WHERE r.status='pending'
     ORDER BY r.requested_at ASC
     LIMIT $1`,
    [limit]
  );
  return r.rows || [];
}

export async function decideOpsRequest({ requestId, adminUserId, approve }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rr = await client.query(
      `SELECT r.id, r.user_id, r.status FROM ops_requests r WHERE r.id=$1 FOR UPDATE`,
      [requestId]
    );
    const row = rr.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, error: "not_found" };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, error: "already_decided" };
    }
    const newStatus = approve ? "approved" : "rejected";
    await client.query(
      `UPDATE ops_requests
       SET status=$2, decided_at=NOW(), decided_by=$3
       WHERE id=$1`,
      [requestId, newStatus, adminUserId]
    );
    if (approve) {
      await client.query(`UPDATE users SET role='ops' WHERE id=$1`, [row.user_id]);
    }
    await client.query("COMMIT");
    return { ok: true, status: newStatus, user_id: row.user_id };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function getEventsMissingCoords(limit = 50) {
  const r = await pool.query(
    `SELECT id, title, city_text, place_text, status_text, pub_date, is_closed, start_time_iso, end_time_iso, first_seen_at, last_seen_at
     FROM events
     WHERE (lat IS NULL OR lon IS NULL)
     ORDER BY last_seen_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows || [];
}
