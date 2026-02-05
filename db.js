// db.js
// Postgres helper: schema bootstrap + safe upsert for events

import pg from "pg";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("[db] Missing DATABASE_URL env");
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.PGSSL === "false"
      ? false
      : {
          rejectUnauthorized: false,
        },
});

export async function dbPing() {
  const r = await pool.query("SELECT NOW() AS now");
  return r.rows?.[0]?.now;
}

export async function ensureSchema() {
  // vytvoření tabulky + indexy
  const sql = `
  CREATE TABLE IF NOT EXISTS events (
    id               TEXT PRIMARY KEY,

    title            TEXT,
    link             TEXT,
    pub_date         TIMESTAMPTZ,

    place_text       TEXT,
    city_text        TEXT,
    status_text      TEXT,
    event_type       TEXT,
    description_raw  TEXT,

    -- ISO stringy z RSS/ESP (drž jako TEXT, ať se nikdy nehádá typově)
    start_time_iso   TEXT,
    end_time_iso     TEXT,

    duration_min     INTEGER,
    is_closed        BOOLEAN NOT NULL DEFAULT FALSE,

    closed_detected_at TIMESTAMPTZ,

    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_events_pub_date ON events (pub_date DESC);
  CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events (last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_is_closed ON events (is_closed);
  `;
  await pool.query(sql);
}

/**
 * Upsert event.
 *
 * event = {
 *  id: string,
 *  title?: string,
 *  link?: string,
 *  pubDate?: Date|string|null,
 *  placeText?: string|null,
 *  cityText?: string|null,
 *  statusText?: string|null,
 *  eventType?: string|null,
 *  descriptionRaw?: string|null,
 *  startTimeIso?: string|null,
 *  endTimeIso?: string|null,
 *  durationMin?: number|null,
 *  isClosed?: boolean,
 * }
 *
 * options = { maxDurationMin?: number }
 */
export async function upsertEvent(event, options = {}) {
  const maxDurationMin =
    Number.isFinite(options.maxDurationMin) ? options.maxDurationMin : 4320; // 3 dny (pojistka)

  // typová normalizace
  const id = String(event.id || "").trim();
  if (!id) throw new Error("upsertEvent: missing id");

  const isClosed = !!event.isClosed;

  // pub_date: ukládej jako timestamptz
  let pubDate = null;
  if (event.pubDate instanceof Date) pubDate = event.pubDate.toISOString();
  else if (typeof event.pubDate === "string" && event.pubDate.trim()) pubDate = event.pubDate.trim();

  const nowIso = new Date().toISOString(); // pro fallback end_time_iso (TEXT)

  // durationMin: jen číslo nebo null
  const durationMin =
    event.durationMin === 0
      ? 0
      : Number.isFinite(Number(event.durationMin))
      ? Number(event.durationMin)
      : null;

  const q = `
  INSERT INTO events (
    id, title, link, pub_date,
    place_text, city_text, status_text, event_type,
    description_raw,
    start_time_iso, end_time_iso,
    duration_min, is_closed,
    closed_detected_at,
    first_seen_at, last_seen_at, updated_at
  ) VALUES (
    $1,$2,$3,$4,
    $5,$6,$7,$8,
    $9,
    $10::text,$11::text,
    $12::int,$13::boolean,
    CASE WHEN $13 = TRUE THEN NOW() ELSE NULL END,
    NOW(), NOW(), NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    link  = EXCLUDED.link,
    pub_date = COALESCE(EXCLUDED.pub_date, events.pub_date),

    place_text = COALESCE(EXCLUDED.place_text, events.place_text),
    city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),
    status_text = COALESCE(EXCLUDED.status_text, events.status_text),
    event_type  = COALESCE(EXCLUDED.event_type,  events.event_type),
    description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

    start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),

    -- end_time_iso (TEXT):
    -- 1) pokud přijde z RSS, vezmi ho
    -- 2) jinak při prvním uzavření nastav fallback ISO string (posíláme $15)
    -- 3) jinak nech původní
    end_time_iso = CASE
      WHEN EXCLUDED.end_time_iso IS NOT NULL THEN EXCLUDED.end_time_iso
      WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN $15::text
      ELSE events.end_time_iso
    END,

    -- duration:
    -- 1) když nový dur přijde, vezmi ho
    -- 2) když starý je extrémní, smaž ho (NULL)
    -- 3) jinak nech původní
    duration_min = CASE
      WHEN EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min
      WHEN events.duration_min IS NOT NULL AND events.duration_min > $14 THEN NULL
      ELSE events.duration_min
    END,

    -- uzavření je sticky (už jednou zavřený = zavřený)
    is_closed = (events.is_closed OR EXCLUDED.is_closed),

    -- closed_detected_at jen při prvním uzavření
    closed_detected_at = CASE
      WHEN (events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE) THEN NOW()
      ELSE events.closed_detected_at
    END,

    last_seen_at = NOW(),
    updated_at = NOW()
  RETURNING id;
  `;

  const params = [
    id,
    event.title ?? null,
    event.link ?? null,
    pubDate, // $4

    event.placeText ?? null,
    event.cityText ?? null,
    event.statusText ?? null,
    event.eventType ?? null,

    event.descriptionRaw ?? null,

    event.startTimeIso ?? null, // $10
    event.endTimeIso ?? null,   // $11

    durationMin, // $12
    isClosed,    // $13

    maxDurationMin, // $14
    nowIso,         // $15 (fallback end_time_iso)
  ];

  const res = await pool.query(q, params);
  return res.rows?.[0]?.id;
}

export async function listEvents({ limit = 200, onlyOpen = false } = {}) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  const where = onlyOpen ? "WHERE is_closed = FALSE" : "";
  const q = `
    SELECT *
    FROM events
    ${where}
    ORDER BY last_seen_at DESC
    LIMIT $1
  `;
  const r = await pool.query(q, [lim]);
  return r.rows;
}

export async function close() {
  await pool.end();
}