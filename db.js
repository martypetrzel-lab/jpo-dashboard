import {canImprove} from './geocoding.js';
import { normalizeReportFilters, buildReportWhere } from "./report-query.js";
import pg from "pg";

// ✅ stejný limit jako v serveru (fallback), aby se do DB neukládaly extrémy
const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320)); // 3 dny

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=UTC',
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false
});

const RSS_WORKER_LOCK_KEY = 748_329_101;

// Session-level advisory lock: the dedicated client stays checked out for the
// whole RSS cycle, so only one Railway replica can ingest the feed at a time.
export async function acquireRssWorkerLock() {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [RSS_WORKER_LOCK_KEY]);
    if (!result.rows?.[0]?.acquired) {
      client.release();
      return null;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [RSS_WORKER_LOCK_KEY]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

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
      duration_source TEXT,
      is_closed BOOLEAN NOT NULL DEFAULT FALSE,

      alarm_level INTEGER,
      alarm_level_text TEXT,
      is_major_event BOOLEAN NOT NULL DEFAULT FALSE,
      major_reason TEXT,
      status_source TEXT,
      source_kind TEXT,
      source_note TEXT,
      manual_detail_text TEXT,
      manual_detail_source TEXT,
      manual_detail_updated_at TIMESTAMPTZ,

      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      geo_source TEXT,
      geo_note TEXT,
      geo_updated_at TIMESTAMPTZ,

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



  await pool.query(`
    CREATE TABLE IF NOT EXISTS archived_reports (
      id BIGSERIAL PRIMARY KEY,
      period_type TEXT NOT NULL,
      period_key TEXT NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      title TEXT NOT NULL,
      total_events INTEGER NOT NULL DEFAULT 0,
      open_count INTEGER NOT NULL DEFAULT 0,
      closed_count INTEGER NOT NULL DEFAULT 0,
      missing_coords_count INTEGER NOT NULL DEFAULT 0,
      data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(period_type, period_key)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_archived_reports_period ON archived_reports(period_type, period_key DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingest_log (
      id BIGSERIAL PRIMARY KEY,
      source TEXT,
      source_kind TEXT,
      received_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      new_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      closed_count INTEGER NOT NULL DEFAULT 0,
      geocoded_count INTEGER NOT NULL DEFAULT 0,
      error_text TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS skipped_older_count INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ingest_log_created_at ON ingest_log(created_at DESC);`);


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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;`);

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
  for(const [name,type] of Object.entries({source_updated_at:'TEXT',start_time_source:'TEXT',end_time_source:'TEXT',time_model_version:'INTEGER NOT NULL DEFAULT 0',time_original_values:'JSONB'})) await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  for (const [name,type] of Object.entries({geo_precision:'TEXT',geo_confidence:'DOUBLE PRECISION',geo_query:'TEXT',geo_display_name:'TEXT',geo_verified:'BOOLEAN NOT NULL DEFAULT FALSE',geo_failure_reason:'TEXT',geo_context_key:'TEXT'})) await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS geocode_cache_v2 (context_key TEXT PRIMARY KEY, result JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS geocode_provider_limits (provider TEXT PRIMARY KEY, next_request_at TIMESTAMPTZ NOT NULL)`);


  
  if (!(await colExists("events", "geo_source"))) {
    await pool.query(`ALTER TABLE events ADD COLUMN geo_source TEXT`);
  }
  if (!(await colExists("events", "geo_note"))) {
    await pool.query(`ALTER TABLE events ADD COLUMN geo_note TEXT`);
  }
  if (!(await colExists("events", "geo_updated_at"))) {
    await pool.query(`ALTER TABLE events ADD COLUMN geo_updated_at TIMESTAMPTZ`);
  }

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
    ["events", "duration_source", "TEXT"],
    ["events", "is_closed", "BOOLEAN"],
    ["events", "first_seen_at", "TIMESTAMPTZ"],
    ["events", "last_seen_at", "TIMESTAMPTZ"],
    ["events", "lat", "DOUBLE PRECISION"],
    ["events", "lon", "DOUBLE PRECISION"],
    ["events", "alarm_level", "INTEGER"],
    ["events", "alarm_level_text", "TEXT"],
    ["events", "is_major_event", "BOOLEAN"],
    ["events", "major_reason", "TEXT"],
    ["events", "status_source", "TEXT"],
    ["events", "source_kind", "TEXT"],
    ["events", "source_note", "TEXT"],
    ["events", "manual_detail_text", "TEXT"],
    ["events", "manual_detail_source", "TEXT"],
    ["events", "manual_detail_updated_at", "TIMESTAMPTZ"]
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
        is_major_event = COALESCE(is_major_event, FALSE),
        first_seen_at = COALESCE(first_seen_at, created_at, NOW()),
        last_seen_at = COALESCE(last_seen_at, NOW())
    WHERE is_closed IS NULL OR is_major_event IS NULL OR first_seen_at IS NULL OR last_seen_at IS NULL;
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
    `SELECT id, username, password_hash, role, is_enabled, permissions, created_at, last_login_at FROM users WHERE username=$1`,
    [username]
  );
  return r.rows[0] || null;
}

export async function getUserById(id) {
  const r = await pool.query(
    `SELECT id, username, role, is_enabled, permissions, created_at, last_login_at FROM users WHERE id=$1`,
    [id]
  );
  return r.rows[0] || null;
}

export async function createUser({ username, passwordHash, role = "ops", isEnabled = true, permissions = {} }) {
  const r = await pool.query(
    `
    INSERT INTO users (username, password_hash, role, is_enabled, permissions)
    VALUES ($1,$2,$3,$4,$5::jsonb)
    RETURNING id, username, role, is_enabled, permissions, created_at, last_login_at
    `,
    [username, passwordHash, role, !!isEnabled, JSON.stringify(permissions || {})]
  );
  return r.rows[0];
}

export async function listUsers(limit = 200) {
  const r = await pool.query(
    `
    SELECT id, username, role, is_enabled, permissions, created_at, last_login_at
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
  if (patch.permissions != null) {
    fields.push(`permissions=$${i++}::jsonb`);
    params.push(JSON.stringify(patch.permissions || {}));
  }
  if (patch.lastLoginAtNow) {
    fields.push(`last_login_at=NOW()`);
  }

  if (!fields.length) return await getUserById(id);

  const r = await pool.query(
    `UPDATE users SET ${fields.join(", ")} WHERE id=$1 RETURNING id, username, role, is_enabled, permissions, created_at, last_login_at`,
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
      u.permissions,
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
    `SELECT source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, is_closed, first_seen_at, pub_date, start_time_iso, end_time_iso, duration_min, duration_source, alarm_level, is_major_event, status_text, status_source, source_note, lat, lon, geo_source FROM events WHERE id=$1`,
    [id]
  );
  return res.rows[0] || null;
}

export async function upsertEvent(ev) {
  const isIncomingClosed = ev.statusSource === "explicit_closed" || ev.isClosed === true;

  // DŮLEŽITÉ:
  // Pokud RSS pošle událost už rovnou jako ukončenou a nedodá skutečný čas konce,
  // nesmíme si konec vymýšlet podle aktuálního času. Vznikaly tím falešné délky 10–14 minut.
  // Konec doplníme jen tehdy, když ho zdroj/ruční editace opravdu pošle.
  const normalizedEndTimeIso = ev.endTimeIso || null;

  let normalizedDurationMin = clampDuration(ev.durationMin);
  const hasRealEndTime = !!normalizedEndTimeIso;
  if (isIncomingClosed && hasRealEndTime && normalizedDurationMin == null) {
    const startRaw = ev.startTimeIso || (ev.sourceKind === "rss" ? null : ev.pubDate) || null;
    const start = startRaw ? new Date(startRaw) : null;
    const end = normalizedEndTimeIso ? new Date(normalizedEndTimeIso) : null;
    if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      normalizedDurationMin = clampDuration((end.getTime() - start.getTime()) / 60000);
    }
  }

  const dur = normalizedDurationMin;

  await pool.query(
    `
    INSERT INTO events (
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      source_kind, source_note,
      first_seen_at, last_seen_at, source_updated_at, start_time_source, end_time_source, time_model_version
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12::integer <= $19::integer THEN $12 ELSE NULL END,COALESCE($22::text, CASE WHEN $12::integer IS NOT NULL AND NULLIF($11::text,'' ) IS NOT NULL THEN 'rss_end_time' ELSE NULL END),$13,$14,$15,$16,$17,$18,$20,$21, NOW(), NOW(), $23, $24, $25, 1)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      link = EXCLUDED.link,
      time_original_values=CASE WHEN events.time_model_version=0 AND EXCLUDED.source_kind='rss' THEN COALESCE(events.time_original_values,jsonb_build_object('pub_date',events.pub_date,'start_time_iso',events.start_time_iso,'end_time_iso',events.end_time_iso,'duration_min',events.duration_min,'duration_source',events.duration_source,'captured_at',NOW())) ELSE events.time_original_values END,
      time_model_version=1,
      source_updated_at=COALESCE(EXCLUDED.source_updated_at,events.source_updated_at),
      start_time_source=CASE WHEN events.start_time_source IN ('manual','rss_description','explicit','esp') OR events.status_source='manual' OR events.source_kind='manual' OR events.duration_source='manual' THEN COALESCE(events.start_time_source,'manual') ELSE EXCLUDED.start_time_source END,
      end_time_source=CASE WHEN events.end_time_source='manual' AND EXCLUDED.status_source IS DISTINCT FROM 'explicit_open' THEN events.end_time_source WHEN EXCLUDED.status_source='explicit_open' THEN NULL WHEN EXCLUDED.end_time_iso IS NOT NULL THEN EXCLUDED.end_time_source ELSE events.end_time_source END,
      pub_date=CASE WHEN EXCLUDED.source_kind='rss' AND events.source_kind IS DISTINCT FROM 'manual' AND events.status_source IS DISTINCT FROM 'manual' THEN COALESCE(EXCLUDED.pub_date,events.pub_date) ELSE COALESCE(events.pub_date,EXCLUDED.pub_date) END,

      place_text = COALESCE(EXCLUDED.place_text, events.place_text),
      city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),

      status_text = COALESCE(EXCLUDED.status_text, events.status_text),
      event_type  = COALESCE(EXCLUDED.event_type, events.event_type),
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso=CASE WHEN events.start_time_source IN ('manual','rss_description','explicit','esp') OR events.status_source='manual' OR events.source_kind='manual' OR events.duration_source='manual' THEN events.start_time_iso WHEN EXCLUDED.source_kind='rss' THEN EXCLUDED.start_time_iso ELSE COALESCE(events.start_time_iso,EXCLUDED.start_time_iso) END,
      end_time_iso   = CASE
        WHEN events.end_time_source='manual' AND EXCLUDED.status_source IS DISTINCT FROM 'explicit_open' THEN events.end_time_iso
        WHEN EXCLUDED.status_source = 'explicit_open' THEN NULL
        WHEN NULLIF(EXCLUDED.end_time_iso,'' ) IS NOT NULL THEN EXCLUDED.end_time_iso
        ELSE events.end_time_iso
      END,

      duration_min=CASE WHEN EXCLUDED.status_source='explicit_open' THEN NULL WHEN events.duration_source='manual' THEN events.duration_min WHEN EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min WHEN EXCLUDED.source_kind='rss' THEN NULL ELSE events.duration_min END,
      duration_source=CASE WHEN EXCLUDED.status_source='explicit_open' THEN NULL WHEN events.duration_source='manual' THEN events.duration_source WHEN EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_source WHEN EXCLUDED.source_kind='rss' THEN NULL ELSE events.duration_source END,

      is_closed = CASE
        WHEN EXCLUDED.status_source = 'explicit_open' THEN FALSE
        WHEN EXCLUDED.status_source = 'explicit_closed' THEN TRUE
        WHEN EXCLUDED.is_closed = TRUE THEN TRUE
        ELSE events.is_closed
      END,

      alarm_level = COALESCE(EXCLUDED.alarm_level, events.alarm_level),
      alarm_level_text = COALESCE(EXCLUDED.alarm_level_text, events.alarm_level_text),
      is_major_event = (COALESCE(events.is_major_event, FALSE) OR COALESCE(EXCLUDED.is_major_event, FALSE)),
      major_reason = COALESCE(EXCLUDED.major_reason, events.major_reason),
      status_source = COALESCE(EXCLUDED.status_source, events.status_source),
      source_kind = COALESCE(EXCLUDED.source_kind, events.source_kind),
      source_note = COALESCE(EXCLUDED.source_note, events.source_note),

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
      normalizedEndTimeIso,
      dur,
      !!ev.isClosed,
      Number.isFinite(Number(ev.alarmLevel)) ? Number(ev.alarmLevel) : null,
      ev.alarmLevelText || null,
      !!ev.isMajorEvent,
      ev.majorReason || null,
      ev.statusSource || null,
      MAX_DURATION_MINUTES,
      ev.sourceKind || null,
      ev.sourceNote || null,
      ev.durationSource || null,
      ev.sourceUpdatedAt || null,
      ev.startTimeSource || null,
      ev.endTimeSource || null
    ]
  );
}

export async function updateEventCoords(id, lat, lon, source = "manual", note = "", metadata = {}) {
  await pool.query(
    `UPDATE events
     SET lat=$2, lon=$3, geo_source=$4, geo_note=$5, geo_updated_at=NOW(), geo_precision=$6, geo_confidence=$7, geo_query=$8, geo_display_name=$9, geo_verified=$10, geo_failure_reason=$11, geo_context_key=$12
     WHERE id=$1`,
    [id, lat, lon, source, note, metadata.precision || (source === "manual" ? "manual" : null),metadata.confidence ?? null,metadata.query || null,metadata.display_name || null,metadata.verified === true,metadata.failure_reason || null,metadata.context_key || null]
  );
}

export async function clearEventCoords(id) {
  await pool.query(
    `UPDATE events SET lat=NULL, lon=NULL, geo_source=NULL, geo_note=NULL, geo_precision=NULL, geo_confidence=NULL, geo_query=NULL, geo_display_name=NULL, geo_verified=FALSE, geo_failure_reason=NULL, geo_context_key=NULL, geo_updated_at=NOW() WHERE id=$1`,
    [id]
  );
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
        AND COALESCE(source_kind, 'esp') = 'esp'
        AND status_source IS DISTINCT FROM 'explicit_open'
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
      duration_source = 'estimated_stale_close',
      status_text = CASE
        WHEN e.status_text IS NULL OR LOWER(e.status_text) LIKE '%prob%' OR LOWER(e.status_text) LIKE '%aktiv%' THEN 'ukončená'
        ELSE e.status_text
      END
    FROM candidates c
    WHERE e.id = c.id
    RETURNING e.id, e.duration_min, e.end_time_iso;
    `,
    [stale, lim, MAX_DURATION_MINUTES]
  );

  return res.rows;
}


export async function repairClosedEventsMissingEndTime({ limit = 500 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit || 0) || 500, 5000));

  const res = await pool.query(
    `
    WITH candidates AS (
      SELECT
        id,
        COALESCE(NULLIF(start_time_iso,'' )::timestamptz, first_seen_at, created_at) AS start_ts,
        COALESCE(NULLIF(end_time_iso,'' )::timestamptz, last_seen_at, NOW()) AS end_ts
      FROM events
      WHERE is_closed = TRUE
        AND (end_time_iso IS NULL OR end_time_iso = '' OR duration_min IS NULL)
      ORDER BY last_seen_at DESC
      LIMIT $1
    )
    UPDATE events e
    SET
      end_time_iso = CASE
        WHEN e.end_time_iso IS NULL OR e.end_time_iso = '' THEN to_char((c.end_ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ELSE e.end_time_iso
      END,
      duration_min = CASE
        WHEN e.duration_min IS NOT NULL THEN e.duration_min
        WHEN ROUND(EXTRACT(EPOCH FROM (c.end_ts - c.start_ts)) / 60.0)::int <= 0 THEN NULL
        WHEN ROUND(EXTRACT(EPOCH FROM (c.end_ts - c.start_ts)) / 60.0)::int > $2 THEN NULL
        ELSE ROUND(EXTRACT(EPOCH FROM (c.end_ts - c.start_ts)) / 60.0)::int
      END,
      status_text = CASE
        WHEN e.status_text IS NULL OR LOWER(e.status_text) LIKE '%prob%' OR LOWER(e.status_text) LIKE '%aktiv%' THEN 'ukončená'
        ELSE e.status_text
      END
    FROM candidates c
    WHERE e.id = c.id
    RETURNING e.id, e.end_time_iso, e.duration_min;
    `,
    [lim, MAX_DURATION_MINUTES]
  );

  return res.rows || [];
}




export async function updateEventStatusFromRecheck(id, { isClosed = null, statusSource = null, statusText = null } = {}) {
  await pool.query(
    `
    UPDATE events
    SET
      is_closed = CASE
        WHEN $2::boolean IS NULL THEN is_closed
        ELSE $2::boolean
      END,
      status_source = COALESCE($3::text, status_source),
      status_text = COALESCE($4::text, status_text),
      end_time_iso = CASE
        WHEN $2::boolean = FALSE THEN NULL
        ELSE end_time_iso
      END,
      duration_min = CASE
        WHEN $2::boolean = FALSE THEN NULL
        ELSE duration_min
      END,
      duration_source = CASE
        WHEN $2::boolean = FALSE THEN NULL
        ELSE duration_source
      END
    WHERE id = $1
    `,
    [id, isClosed, statusSource, statusText]
  );
}


export async function insertManualEvent(ev) {
  const id = ev.id || `MANUAL_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const dur = clampDuration(ev.durationMin);

  await pool.query(
    `
    INSERT INTO events (
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      source_kind, source_note,
      lat, lon, geo_source, geo_note, geo_updated_at, geo_precision,
      first_seen_at, last_seen_at
    )
    VALUES (
      $1,$2,$3,$4,
      $5,$6,$7,$8,
      $9,
      $10,$11,$12,CASE WHEN $12::integer IS NULL THEN NULL ELSE 'manual' END,$13,
      $14,$15,$16,$17,$18,
      'manual',$19,
      $20::double precision,$21::double precision,
      CASE WHEN $20::double precision IS NULL OR $21::double precision IS NULL THEN NULL ELSE 'manual_event_create' END,
      CASE WHEN $20::double precision IS NULL OR $21::double precision IS NULL THEN NULL ELSE 'Ručně zadáno při vytvoření výjezdu' END,
      CASE WHEN $20::double precision IS NULL OR $21::double precision IS NULL THEN NULL ELSE NOW() END,
      CASE WHEN $20::double precision IS NULL OR $21::double precision IS NULL THEN NULL ELSE 'manual' END,
      NOW(), NOW()
    )
    RETURNING *
    `,
    [
      id,
      ev.title,
      ev.link || `manual:${id}`,
      ev.pubDate || ev.startTimeIso || new Date().toISOString(),
      ev.placeText || null,
      ev.cityText || null,
      ev.statusText || null,
      ev.eventType || null,
      ev.descriptionRaw || null,
      ev.startTimeIso || ev.pubDate || null,
      ev.endTimeIso || null,
      dur,
      !!ev.isClosed,
      Number.isFinite(Number(ev.alarmLevel)) ? Number(ev.alarmLevel) : null,
      ev.alarmLevelText || null,
      !!ev.isMajorEvent,
      ev.majorReason || null,
      ev.statusSource || "manual",
      ev.sourceNote || "Ručně doplněno přes admin",
      ev.lat != null && String(ev.lat).trim() !== "" && Number.isFinite(Number(ev.lat)) ? Number(ev.lat) : null,
      ev.lon != null && String(ev.lon).trim() !== "" && Number.isFinite(Number(ev.lon)) ? Number(ev.lon) : null
    ]
  );

  return id;
}

export async function insertIngestLog({
  source = null,
  sourceKind = null,
  receivedCount = 0,
  acceptedCount = 0,
  newCount = 0,
  updatedCount = 0,
  closedCount = 0,
  geocodedCount = 0,
  skippedCount = 0,
  skippedOlderCount = 0,
  errorText = null,
  ip = null,
  userAgent = null
} = {}) {
  const r = await pool.query(
    `
    INSERT INTO ingest_log (
      source, source_kind, received_count, accepted_count, new_count, updated_count,
      closed_count, geocoded_count, error_text, ip, user_agent, skipped_count, skipped_older_count
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id
    `,
    [
      source,
      sourceKind,
      Number(receivedCount || 0),
      Number(acceptedCount || 0),
      Number(newCount || 0),
      Number(updatedCount || 0),
      Number(closedCount || 0),
      Number(geocodedCount || 0),
      errorText ? String(errorText).slice(0, 2000) : null,
      ip || null,
      userAgent || null,
      Number(skippedCount || 0),
      Number(skippedOlderCount || 0)
    ]
  );
  return r.rows?.[0]?.id || null;
}

export async function getIngestDiagnostics({ limit = 20 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit || 20), 200));

  const logs = await pool.query(
    `
    SELECT id, source, source_kind, received_count, accepted_count, new_count, updated_count,
           closed_count, geocoded_count, skipped_count, skipped_older_count, error_text, ip, user_agent, created_at
    FROM ingest_log
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [lim]
  );

  const latestEvent = await pool.query(
    `
    SELECT id, title, city_text, place_text, pub_date, start_time_iso, created_at, last_seen_at
    FROM events
    ORDER BY created_at DESC
    LIMIT 1
    `
  );

  const latestIngest = await pool.query(
    `SELECT created_at FROM ingest_log ORDER BY created_at DESC LIMIT 1`
  );

  const last24 = await pool.query(
    `
    SELECT COUNT(*)::int AS c
    FROM events
    WHERE created_at >= NOW() - interval '24 hours'
    `
  );

  const last6 = await pool.query(
    `
    SELECT COUNT(*)::int AS c
    FROM events
    WHERE created_at >= NOW() - interval '6 hours'
    `
  );

  const last1 = await pool.query(
    `
    SELECT COUNT(*)::int AS c
    FROM events
    WHERE created_at >= NOW() - interval '1 hour'
    `
  );

  return {
    logs: logs.rows || [],
    latestEvent: latestEvent.rows?.[0] || null,
    latestIngestAt: latestIngest.rows?.[0]?.created_at || null,
    counts: {
      last1h: last1.rows?.[0]?.c || 0,
      last6h: last6.rows?.[0]?.c || 0,
      last24h: last24.rows?.[0]?.c || 0
    }
  };
}

export async function searchEventsAdmin({ q = "", limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit || 50), 200));
  const query = String(q || "").trim();

  const params = [];
  let where = "TRUE";

  if (query) {
    params.push(`%${query}%`);
    where = `(title ILIKE $1 OR city_text ILIKE $1 OR place_text ILIKE $1 OR id ILIKE $1 OR event_type ILIKE $1)`;
  }

  params.push(lim);

  const r = await pool.query(
    `
    SELECT
      source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, pub_date, city_text, place_text, status_text, event_type,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason,
      source_kind, source_note, lat, lon, created_at, last_seen_at
    FROM events
    WHERE ${where}
    ORDER BY COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) DESC, created_at DESC
    LIMIT $${params.length}
    `,
    params
  );

  return r.rows || [];
}



export async function clearEstimatedDurationsForAlreadyClosedEvents({ maxMinutes = 20 } = {}) {
  const max = Math.max(1, Math.min(Number(maxMinutes || 20), 240));
  const r = await pool.query(
    `
    UPDATE events
    SET
      duration_min = NULL,
      duration_source = NULL,
      end_time_iso = CASE
        WHEN duration_source IS NULL OR duration_source = '' THEN NULL
        ELSE end_time_iso
      END
    WHERE is_closed = TRUE
      AND COALESCE(duration_source, '') NOT IN ('explicit', 'manual', 'estimated_stale_close', 'estimated_close_seen')
      AND duration_min IS NOT NULL
      AND duration_min <= $1
    RETURNING id, title, duration_min
    `,
    [max]
  );
  return r.rows || [];
}



export async function recomputeObservedDurationsForClosedEvents({ limit = 1000 } = {}) {
  // Bez historického záznamu, že událost byla skutečně viděná jako aktivní,
  // není bezpečné zpětně dopočítávat délku. Nové události se počítají při přechodu aktivní -> ukončená.
  return [];
}



export async function clearObservedDurations({ limit = 10000 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit || 10000), 50000));
  const r = await pool.query(
    `
    WITH candidates AS (
      SELECT id
      FROM events
      WHERE duration_source IN ('observed_first_seen_to_close_update', 'estimated_close_seen')
      ORDER BY last_seen_at DESC
      LIMIT $1
    )
    UPDATE events e
    SET duration_min = NULL,
        duration_source = NULL
    FROM candidates c
    WHERE e.id = c.id
    RETURNING e.id, e.title
    `,
    [lim]
  );
  return r.rows || [];
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


function eventTimeSql() {
  // Hlavní datum události musí odpovídat RSS/veřejné tabulce.
  // pub_date je čas události z feedu; start_time_iso používáme až jako fallback.
  return "COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at)";
}

function buildTimeWindowSql(day, params, iStart) {
  const clauses = [];
  let i = iStart;
  const t = eventTimeSql();

  if (day === "today" || day === "yesterday") {
    const offset = day === "yesterday" ? 1 : 0;

    clauses.push(
      `(
        (
          (${t} AT TIME ZONE 'Europe/Prague')::date
          = ((NOW() AT TIME ZONE 'Europe/Prague')::date - $${i}::int)
        )
        OR
        (
          is_closed = FALSE
          AND (${t} AT TIME ZONE 'Europe/Prague')::date
              < ((NOW() AT TIME ZONE 'Europe/Prague')::date - $${i}::int)
        )
      )`
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
        `date_trunc('month', (${eventTimeSql()} AT TIME ZONE 'Europe/Prague')) = date_trunc('month', to_date($${i}, 'YYYY-MM'))`
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
    where.push(`(COALESCE(city_text,'') ILIKE $${i} OR COALESCE(place_text,'') ILIKE $${i} OR COALESCE(title,'') ILIKE $${i} OR COALESCE(description_raw,'') ILIKE $${i})`);
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
      source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, link, pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      manual_detail_text, manual_detail_source, manual_detail_updated_at,
      (
        is_closed = FALSE
        AND (COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date
            < (NOW() AT TIME ZONE 'Europe/Prague')::date
      ) AS is_carryover_active,
      (
        CASE
          WHEN is_closed = FALSE
               AND (COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date
               < (NOW() AT TIME ZONE 'Europe/Prague')::date
          THEN ((NOW() AT TIME ZONE 'Europe/Prague')::date - (COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date)::int
          ELSE 0
        END
      ) AS carryover_days,
      lat, lon, geo_source, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key,
      first_seen_at, last_seen_at, created_at
    FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY
      CASE
        WHEN is_closed = FALSE AND (COALESCE(alarm_level, 0) >= 3 OR COALESCE(is_major_event, FALSE) = TRUE) THEN 0
        WHEN is_closed = FALSE AND COALESCE(alarm_level, 0) >= 2 THEN 1
        WHEN is_closed = FALSE THEN 2
        WHEN COALESCE(alarm_level, 0) >= 3 OR COALESCE(is_major_event, FALSE) = TRUE THEN 3
        ELSE 4
      END ASC,
      COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) DESC,
      created_at DESC
    LIMIT $${i}
    `;

  params.push(limit);

  const res = await pool.query(sql, params);
  return res.rows;
}


export async function countEventsFiltered(filters = {}) {
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
    where.push(`(COALESCE(city_text,'') ILIKE $${i} OR COALESCE(place_text,'') ILIKE $${i} OR COALESCE(title,'') ILIKE $${i} OR COALESCE(description_raw,'') ILIKE $${i})`);
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

  const r = await pool.query(
    `SELECT COUNT(*)::int AS total FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
    params
  );

  return r.rows?.[0]?.total || 0;
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
      to_char(((COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date), 'YYYY-MM-DD') AS day,
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

    whereLongest.push(`(duration_source IN ('rss_end_time','esp_duration','explicit','manual') AND (source_kind IS DISTINCT FROM 'rss' OR duration_source IN ('esp_duration','explicit','manual') OR start_time_source IN ('manual','rss_description','explicit','esp') OR status_source='manual'))`);
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
          WHEN duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${iL} AND (duration_source IN ('rss_end_time','esp_duration','explicit','manual') AND (source_kind IS DISTINCT FROM 'rss' OR duration_source IN ('esp_duration','explicit','manual') OR start_time_source IN ('manual','rss_description','explicit','esp') OR status_source='manual'))
            THEN duration_min
          WHEN (NOT is_closed) AND (source_kind IS DISTINCT FROM 'rss' OR start_time_source IN ('manual','rss_description','explicit','esp') OR status_source='manual') AND NULLIF(start_time_iso,'') IS NOT NULL
            THEN LEAST(
              $${iL},
              GREATEST(
                1,
                FLOOR(
                  EXTRACT(EPOCH FROM (
                    NOW() - COALESCE(NULLIF(start_time_iso,'')::timestamptz, NULLIF(pub_date,'')::timestamptz)
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
          (duration_min IS NOT NULL AND duration_min > 0 AND duration_min <= $${iL} AND (duration_source IN ('rss_end_time','esp_duration','explicit','manual') AND (source_kind IS DISTINCT FROM 'rss' OR duration_source IN ('esp_duration','explicit','manual') OR start_time_source IN ('manual','rss_description','explicit','esp') OR status_source='manual')))
          OR (NOT is_closed AND NULLIF(start_time_iso,'') IS NOT NULL AND (source_kind IS DISTINCT FROM 'rss' OR start_time_source IN ('manual','rss_description','explicit','esp') OR status_source='manual'))
        )
      ORDER BY duration_min DESC NULLS LAST
      LIMIT 10;
      `,
      [...paramsLongest, MAX_DURATION_MINUTES]
    );

    longestRows = longest.rows;
  }


  const majorSummary = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE is_major_event)::int AS major_count,
      COUNT(*) FILTER (WHERE alarm_level >= 3)::int AS alarm_level_3_plus,
      COUNT(*) FILTER (WHERE alarm_level = 4)::int AS special_alarm_level
    FROM events
    ${where30Sql}
    `,
    params30
  );

  return {
    byDay: byDay.rows,
    byType: byType.rows,
    topCities: topCities.rows,
    openVsClosed: openVsClosed.rows[0] || { open: 0, closed: 0 },
    longest: longestRows,
    majorSummary: majorSummary.rows[0] || { major_count: 0, alarm_level_3_plus: 0, special_alarm_level: 0 },
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
    `INSERT INTO users (username, password_hash, role, is_enabled, permissions) VALUES ($1,$2,'public',TRUE,'{}'::jsonb) RETURNING id, username, role, is_enabled, permissions`,
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

export async function getEventsMissingCoords(limit = 50, day = "today") {
  const lim = Math.max(1, Math.min(Number(limit || 50), 200));
  const dayFilter = String(day || "today").toLowerCase();

  const params = [];
  const where = [`(lat IS NULL OR lon IS NULL)`];

  if (dayFilter === "today" || dayFilter === "yesterday") {
    const offset = dayFilter === "yesterday" ? 1 : 0;
    params.push(offset);
    where.push(
      `(COALESCE(NULLIF(start_time_iso,'' )::timestamptz, NULLIF(pub_date,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date
       = ((NOW() AT TIME ZONE 'Europe/Prague')::date - $${params.length}::int)`
    );
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(dayFilter)) {
    params.push(dayFilter);
    where.push(
      `(COALESCE(NULLIF(start_time_iso,'' )::timestamptz, NULLIF(pub_date,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date
       = $${params.length}::date`
    );
  } else if (dayFilter !== "all") {
    // bezpečný default: admin nástroj má být denní, ne historický.
    where.push(
      `(COALESCE(NULLIF(start_time_iso,'' )::timestamptz, NULLIF(pub_date,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date
       = (NOW() AT TIME ZONE 'Europe/Prague')::date`
    );
  }

  params.push(lim);

  const r = await pool.query(
    `SELECT id, title, city_text, place_text, status_text, description_raw,
            pub_date, is_closed, start_time_iso, end_time_iso,
            first_seen_at, last_seen_at, geo_source, geo_note, geo_updated_at, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key
     FROM events
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(NULLIF(start_time_iso,'' )::timestamptz, NULLIF(pub_date,'' )::timestamptz, created_at) DESC,
              last_seen_at DESC
     LIMIT $${params.length}`,
    params
  );
  return r.rows || [];
}


// ======================
// Archived analytical reports
// ======================

export async function upsertArchivedReport(report) {
  const q = `
    INSERT INTO archived_reports (
      period_type, period_key, period_start, period_end, title,
      total_events, open_count, closed_count, missing_coords_count,
      data_json, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())
    ON CONFLICT (period_type, period_key) DO UPDATE SET
      period_start = EXCLUDED.period_start,
      period_end = EXCLUDED.period_end,
      title = EXCLUDED.title,
      total_events = EXCLUDED.total_events,
      open_count = EXCLUDED.open_count,
      closed_count = EXCLUDED.closed_count,
      missing_coords_count = EXCLUDED.missing_coords_count,
      data_json = EXCLUDED.data_json,
      updated_at = NOW()
    RETURNING *
  `;

  const values = [
    report.period_type,
    report.period_key,
    report.period_start,
    report.period_end,
    report.title,
    report.total_events ?? 0,
    report.open_count ?? 0,
    report.closed_count ?? 0,
    report.missing_coords_count ?? 0,
    JSON.stringify(report.data_json || {})
  ];

  const r = await pool.query(q, values);
  return r.rows[0];
}

export async function listArchivedReports(options = {}) {
  const result = await listArchivedReportsPage({ include_empty: true, ...options });
  return result.reports;
}

export async function listArchivedReportsPage(options = {}) {
  const filters = normalizeReportFilters(options);
  const { sql, params } = buildReportWhere(filters);
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM archived_reports ${sql}`, params);
  const groups = await pool.query(`
    SELECT to_char(period_start, 'YYYY-MM') AS month_key,
           COUNT(*)::int AS report_count, SUM(total_events)::int AS event_count
    FROM archived_reports ${sql}
    GROUP BY to_char(period_start, 'YYYY-MM') ORDER BY month_key DESC
  `, params);
  const pageParams = [...params, filters.limit, filters.offset];
  const r = await pool.query(`
    SELECT id, period_type, period_key, to_char(period_start, 'YYYY-MM-DD') AS period_start,
      to_char(period_end, 'YYYY-MM-DD') AS period_end, title,
      total_events, open_count, closed_count, missing_coords_count, created_at, updated_at
    FROM archived_reports ${sql}
    ORDER BY period_start DESC, period_type, id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, pageParams);
  return { reports: r.rows || [], total: count.rows[0]?.total || 0,
    limit: filters.limit, offset: filters.offset, groups: groups.rows || [] };
}

export async function getArchivedReport(periodType, periodKey) {
  const r = await pool.query(
    `
    SELECT *
    FROM archived_reports
    WHERE period_type = $1 AND period_key = $2
    LIMIT 1
    `,
    [periodType, periodKey]
  );
  return r.rows[0] || null;
}

export async function getEventsForPeriod(startIso, endExclusiveIso) {
  const r = await pool.query(
    `
    SELECT
      source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, link, pub_date,
      place_text, city_text,
      status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      manual_detail_text, manual_detail_source, manual_detail_updated_at,
      (
        is_closed = FALSE
        AND (COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date
            < (NOW() AT TIME ZONE 'Europe/Prague')::date
      ) AS is_carryover_active,
      (
        CASE
          WHEN is_closed = FALSE
               AND (COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date
               < (NOW() AT TIME ZONE 'Europe/Prague')::date
          THEN ((NOW() AT TIME ZONE 'Europe/Prague')::date - (COALESCE(NULLIF(pub_date,'' )::timestamptz, NULLIF(start_time_iso,'' )::timestamptz, created_at) AT TIME ZONE 'Europe/Prague')::date)::int
          ELSE 0
        END
      ) AS carryover_days,
      lat, lon, geo_source, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key,
      first_seen_at, last_seen_at, created_at
    FROM events
    WHERE (${eventTimeSql()} AT TIME ZONE 'Europe/Prague')::date >= $1::date
      AND (${eventTimeSql()} AT TIME ZONE 'Europe/Prague')::date < $2::date
    ORDER BY ${eventTimeSql()} DESC
    `,
    [startIso, endExclusiveIso]
  );

  return r.rows || [];
}


export async function getEventById(id) {
  const r = await pool.query(
    `SELECT source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, link, pub_date, place_text, city_text, status_text, event_type,
            description_raw, start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
            alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
            manual_detail_text, manual_detail_source, manual_detail_updated_at,
            lat, lon, first_seen_at, last_seen_at, created_at, geo_source, geo_note, geo_updated_at, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key
     FROM events
     WHERE id=$1
     LIMIT 1`,
    [id]
  );
  return r.rows[0] || null;
}

export async function listEventsWithCoords(limit = 100) {
  const r = await pool.query(
    `SELECT id, title, city_text, place_text, description_raw, status_text, event_type, pub_date,
            alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
            manual_detail_text, manual_detail_source, manual_detail_updated_at,
            lat, lon, geo_source, geo_note, geo_updated_at, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key, last_seen_at
     FROM events
     WHERE lat IS NOT NULL AND lon IS NOT NULL
     ORDER BY COALESCE(geo_updated_at, last_seen_at) DESC
     LIMIT $1`,
    [Math.max(1, Math.min(Number(limit || 100), 500))]
  );
  return r.rows || [];
}


// ---------------- MAJOR EVENTS BACKFILL ----------------
export async function listEventsForMajorBackfill(limit = 5000) {
  const lim = Math.max(1, Math.min(Number(limit || 5000), 20000));
  const r = await pool.query(
    `
    SELECT
      source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      first_seen_at, last_seen_at, created_at
    FROM events
    ORDER BY COALESCE(NULLIF(pub_date,'' )::timestamptz, created_at) DESC, created_at DESC
    LIMIT $1
    `,
    [lim]
  );
  return r.rows || [];
}

export async function updateEventMajorAnalysis(id, patch = {}) {
  await pool.query(
    `
    UPDATE events
    SET
      alarm_level = $2,
      alarm_level_text = $3,
      is_major_event = $4,
      major_reason = $5,
      status_source = COALESCE($6, status_source),
      is_closed = CASE
        WHEN $6 = 'explicit_open' THEN FALSE
        WHEN $6 = 'explicit_closed' THEN TRUE
        ELSE is_closed
      END,
      end_time_iso = CASE
        WHEN $6 = 'explicit_open' THEN NULL
        ELSE end_time_iso
      END,
      duration_min = CASE
        WHEN $6 = 'explicit_open' THEN NULL
        ELSE duration_min
      END,
      last_seen_at = last_seen_at
    WHERE id = $1
    `,
    [
      id,
      Number.isFinite(Number(patch.alarmLevel)) ? Number(patch.alarmLevel) : null,
      patch.alarmLevelText || null,
      !!patch.isMajorEvent,
      patch.majorReason || null,
      patch.statusSource || null
    ]
  );
}

export async function getMajorEventsSummary(limit = 20) {
  const lim = Math.max(1, Math.min(Number(limit || 20), 200));
  const r = await pool.query(
    `
    SELECT
      source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, link, pub_date,
      city_text, place_text, status_text, event_type,
      is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      start_time_iso, end_time_iso, duration_min,
      created_at, last_seen_at
    FROM events
    WHERE is_major_event = TRUE OR alarm_level >= 3
    ORDER BY COALESCE(NULLIF(pub_date,'' )::timestamptz, created_at) DESC, created_at DESC
    LIMIT $1
    `,
    [lim]
  );
  return r.rows || [];
}


// ---------------- MANUAL EVENT EDIT ----------------
export async function getEventForManualEdit(id) {
  const r = await pool.query(
    `
    SELECT
      source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      manual_detail_text, manual_detail_source, manual_detail_updated_at,
      lat, lon, geo_source, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key,
      first_seen_at, last_seen_at, created_at
    FROM events
    WHERE id = $1
    `,
    [id]
  );
  return r.rows?.[0] || null;
}

export async function updateEventManualMeta(id, patch = {}) {
  const hasCoords =
    Number.isFinite(Number(patch.lat)) &&
    Number.isFinite(Number(patch.lon));

  const clearCoords = patch.clearCoords === true;

  await pool.query(
    `
    UPDATE events
    SET
      is_closed = $2,
      status_text = $3,
      status_source = 'manual',
      alarm_level = $4,
      alarm_level_text = $5,
      is_major_event = $6,
      major_reason = $7,
      start_time_iso = $8,
      start_time_source = CASE WHEN $8::text IS NOT NULL THEN 'manual' ELSE NULL END,
      end_time_source = CASE WHEN $9::text IS NOT NULL THEN 'manual' ELSE NULL END,
      time_model_version = 1,
      end_time_iso = $9,
      duration_min = $10,
      lat = CASE
        WHEN $11::boolean = TRUE THEN NULL
        WHEN $12::boolean = TRUE THEN $13
        ELSE lat
      END,
      lon = CASE
        WHEN $11::boolean = TRUE THEN NULL
        WHEN $12::boolean = TRUE THEN $14
        ELSE lon
      END,
      geo_source = CASE
        WHEN $11::boolean = TRUE THEN NULL
        WHEN $12::boolean = TRUE THEN 'manual_event_edit'
        ELSE geo_source
      END,
      geo_note = CASE
        WHEN $11::boolean = TRUE THEN NULL
        WHEN $12::boolean = TRUE THEN 'Ručně nastaveno v editaci výjezdu'
        ELSE geo_note
      END,

      geo_precision = CASE WHEN $11::boolean = TRUE THEN NULL WHEN $12::boolean = TRUE THEN 'manual' ELSE geo_precision END,
      geo_confidence = CASE WHEN $11::boolean = TRUE OR $12::boolean = TRUE THEN NULL ELSE geo_confidence END,
      geo_query = CASE WHEN $11::boolean = TRUE OR $12::boolean = TRUE THEN NULL ELSE geo_query END,
      geo_display_name = CASE WHEN $11::boolean = TRUE OR $12::boolean = TRUE THEN NULL ELSE geo_display_name END,
      geo_context_key = CASE WHEN $11::boolean = TRUE OR $12::boolean = TRUE THEN NULL ELSE geo_context_key END,
      geo_failure_reason = CASE WHEN $11::boolean = TRUE OR $12::boolean = TRUE THEN NULL ELSE geo_failure_reason END,
      geo_verified = CASE WHEN $11::boolean = TRUE OR $12::boolean = TRUE THEN FALSE ELSE geo_verified END,
      geo_updated_at = CASE
        WHEN $11::boolean = TRUE OR $12::boolean = TRUE THEN NOW()
        ELSE geo_updated_at
      END,
      last_seen_at = NOW()
    WHERE id = $1
    `,
    [
      id,
      !!patch.isClosed,
      patch.statusText || null,
      Number.isFinite(Number(patch.alarmLevel)) ? Number(patch.alarmLevel) : null,
      patch.alarmLevelText || null,
      !!patch.isMajorEvent,
      patch.majorReason || null,
      patch.startTimeIso || null,
      patch.endTimeIso || null,
      Number.isFinite(Number(patch.durationMin)) ? Number(patch.durationMin) : null,
      clearCoords,
      hasCoords,
      hasCoords ? Number(patch.lat) : null,
      hasCoords ? Number(patch.lon) : null
    ]
  );
}

// ---------------- OWN EVENT DETAIL / MANUAL NOTES ----------------
export async function getEventDetailById(id) {
  const r = await pool.query(
    `
    SELECT
      source_kind, source_updated_at, start_time_source, end_time_source, time_model_version, id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      manual_detail_text, manual_detail_source, manual_detail_updated_at,
      lat, lon, geo_source, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key,
      first_seen_at, last_seen_at, created_at
    FROM events
    WHERE id = $1
    `,
    [id]
  );
  return r.rows?.[0] || null;
}

export async function updateEventManualDetail(id, patch = {}) {
  const r = await pool.query(
    `
    UPDATE events
    SET
      manual_detail_text = $2,
      manual_detail_source = $3,
      manual_detail_updated_at = NOW(),
      last_seen_at = last_seen_at
    WHERE id = $1
    RETURNING
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, duration_source, is_closed,
      alarm_level, alarm_level_text, is_major_event, major_reason, status_source,
      manual_detail_text, manual_detail_source, manual_detail_updated_at,
      lat, lon, geo_source, geo_precision, geo_confidence, geo_query, geo_display_name, geo_verified, geo_failure_reason, geo_context_key,
      first_seen_at, last_seen_at, created_at
    `,
    [
      id,
      String(patch.manualDetailText || "").trim() || null,
      String(patch.manualDetailSource || "").trim() || null
    ]
  );
  return r.rows?.[0] || null;
}

// Public freshness only; diagnostic payloads and identities stay admin-only.
export async function getPublicDataStatus() {
  const r=await pool.query(`SELECT MAX(created_at) FILTER (WHERE error_text IS NULL OR error_text='') AS last_success, MAX(created_at) AS last_attempt FROM ingest_log`);
  const row=r.rows[0]||{};
  return {last_success:row.last_success||null,last_attempt:row.last_attempt||null};
}

export async function deleteUserSessions(userId){await pool.query('DELETE FROM user_sessions WHERE user_id=$1',[userId]);}


export async function getGeoCache(key) {const result=await pool.query('SELECT result FROM geocode_cache_v2 WHERE context_key=$1 AND expires_at>NOW()',[key]);return result.rows[0]?.result || null;}
export async function setGeoCache(key,result,ttl) {await pool.query(`INSERT INTO geocode_cache_v2(context_key,result,expires_at) VALUES($1,$2,NOW()+$3 * INTERVAL '1 second') ON CONFLICT(context_key) DO UPDATE SET result=EXCLUDED.result,expires_at=EXCLUDED.expires_at`,[key,JSON.stringify(result),ttl]);}
export async function reserveGeocodeRequest() {
  const client=await pool.connect();let delay=0;
  try {await client.query('BEGIN');await client.query(`INSERT INTO geocode_provider_limits(provider,next_request_at) VALUES('nominatim',NOW()) ON CONFLICT DO NOTHING`);
    const result=await client.query(`SELECT next_request_at FROM geocode_provider_limits WHERE provider='nominatim' FOR UPDATE`);
    const now=Date.now(),slot=Math.max(now,new Date(result.rows[0].next_request_at).getTime());delay=slot-now;
    await client.query(`UPDATE geocode_provider_limits SET next_request_at=$1 WHERE provider='nominatim'`,[new Date(slot+15000).toISOString()]);await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
}
export async function getGeoAuditRows(limit=5000) {return (await pool.query('SELECT * FROM events ORDER BY last_seen_at DESC LIMIT $1',[Math.min(5000,limit)])).rows;}
export function geoFingerprint(event) {return JSON.stringify([event.lat,event.lon,event.geo_source,event.geo_precision,event.geo_verified,event.geo_updated_at]);}
export async function applyGeoProposal(id,proposal,{repair=false,expected=null,userId=null}={}) {
  const client=await pool.connect();try {
    await client.query('BEGIN');const current=(await client.query('SELECT * FROM events WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!current || (expected!==null && geoFingerprint(current)!==expected) || !canImprove(current,proposal,repair)){await client.query('ROLLBACK');return false;}
    await client.query(`UPDATE events SET lat=$2,lon=$3,geo_source=$4,geo_precision=$5,geo_confidence=$6,geo_query=$7,geo_display_name=$8,geo_context_key=$9,geo_failure_reason=NULL,geo_verified=FALSE,geo_updated_at=NOW() WHERE id=$1`,[id,proposal.lat,proposal.lon,proposal.source,proposal.precision,proposal.confidence,proposal.query,proposal.display_name,proposal.context_key]);
    await client.query(`INSERT INTO audit_log(user_id,action,details) VALUES($1,'geocode_improved',$2)`,[userId,JSON.stringify({id,previous:{lat:current.lat,lon:current.lon,precision:current.geo_precision},proposal})]);
    await client.query('COMMIT');return true;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function recordGeoFailure(id,proposal) {
  await pool.query(`UPDATE events SET geo_precision='failed',geo_failure_reason=$2,geo_query=$3,geo_context_key=$4,geo_updated_at=NOW() WHERE id=$1 AND lat IS NULL AND lon IS NULL AND geo_verified=FALSE AND COALESCE(geo_source,'') NOT ILIKE '%manual%' AND COALESCE(geo_source,'') NOT ILIKE '%admin%'`,[id,proposal.failure_reason,proposal.query || null,proposal.context_key || null]);
}
