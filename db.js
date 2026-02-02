// db.js (ESM)
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  // 1) základní tabulka
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id              text PRIMARY KEY,
      title           text,
      link            text,
      place_text      text,
      status_text     text,
      description_raw text
    );
  `);

  // 2) migrace starších DB (doplnění nových sloupců)
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS place_norm text;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS status_norm text;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS pub_date timestamptz;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS opened_at timestamptz;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS closed_at timestamptz;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS duration_sec integer;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS is_closed boolean DEFAULT false;`);
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();`);

  // 3) indexy (IF NOT EXISTS je u indexů ok)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_is_closed ON events (is_closed);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_opened_at ON events (opened_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_place_norm ON events (place_norm);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_updated_at ON events (updated_at DESC);`);
}

export function normText(s = "") {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // pryč diakritika
    .replace(/\s+/g, " ")
    .trim();
}

export async function upsertEvent(e) {
  const id = String(e.id || "").trim();
  if (!id) return { upserted: false, reason: "missing id" };

  const title = e.title ?? null;
  const link = e.link ?? null;
  const placeText = e.placeText ?? null;
  const statusText = e.statusText ?? null;
  const descRaw = e.descriptionRaw ?? null;

  const placeNorm = normText(placeText);
  const statusNorm = normText(statusText);

  // pubDate může být null; pokud přijde RSS pubDate string, dáme ho do timestamptz přes Date
  let pubDate = null;
  if (e.pubDate) {
    const d = new Date(e.pubDate);
    if (!isNaN(d.getTime())) pubDate = d.toISOString();
  }

  // Heuristika aktivní/ukončené:
  // - pokud statusText obsahuje "ukonc" nebo "ukoncen" => closed
  // - pokud obsahuje "nova" => aktivní
  const st = statusNorm;
  const isClosed = st.includes("ukonc") || st.includes("ukoncen") || st.includes("ukoncena") || st.includes("ukoncená");

  // opened_at:
  // - když záznam neexistuje, nastavíme opened_at = COALESCE(pub_date, now())
  // - když existuje, opened_at neměníme
  // closed_at:
  // - pokud jeClosed a closed_at je null => nastav na now()
  // duration:
  // - pokud closed_at i opened_at => duration_sec = EXTRACT(EPOCH...)
  const q = `
    INSERT INTO events (
      id, title, link, place_text, status_text, description_raw,
      place_norm, status_norm, pub_date,
      opened_at, closed_at, is_closed, duration_sec, updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,
      COALESCE($9, now()), NULL, $10, NULL, now()
    )
    ON CONFLICT (id) DO UPDATE SET
      title           = EXCLUDED.title,
      link            = EXCLUDED.link,
      place_text      = EXCLUDED.place_text,
      status_text     = EXCLUDED.status_text,
      description_raw = EXCLUDED.description_raw,
      place_norm      = EXCLUDED.place_norm,
      status_norm     = EXCLUDED.status_norm,
      pub_date        = COALESCE(events.pub_date, EXCLUDED.pub_date),
      is_closed       = EXCLUDED.is_closed,
      closed_at       = CASE
                        WHEN EXCLUDED.is_closed = true AND events.closed_at IS NULL THEN now()
                        ELSE events.closed_at
                       END,
      duration_sec    = CASE
                        WHEN (CASE
                              WHEN EXCLUDED.is_closed = true AND events.closed_at IS NULL THEN now()
                              ELSE events.closed_at
                             END) IS NOT NULL
                             AND events.opened_at IS NOT NULL
                        THEN EXTRACT(EPOCH FROM (
                          (CASE
                            WHEN EXCLUDED.is_closed = true AND events.closed_at IS NULL THEN now()
                            ELSE events.closed_at
                           END) - events.opened_at
                        ))::int
                        ELSE events.duration_sec
                       END,
      updated_at      = now()
    RETURNING id, is_closed, opened_at, closed_at, duration_sec;
  `;

  const r = await pool.query(q, [
    id, title, link, placeText, statusText, descRaw,
    placeNorm, statusNorm, pubDate,
    isClosed
  ]);

  return { upserted: true, row: r.rows[0] };
}

export async function getEvents(limit = 500) {
  const l = Math.max(1, Math.min(Number(limit) || 200, 2000));
  const r = await pool.query(
    `SELECT *
     FROM events
     ORDER BY opened_at DESC NULLS LAST, updated_at DESC
     LIMIT $1`,
    [l]
  );
  return r.rows;
}

export async function getStats(days = 30) {
  const d = Math.max(1, Math.min(Number(days) || 30, 365));

  const r = await pool.query(
    `
    WITH base AS (
      SELECT *
      FROM events
      WHERE opened_at >= now() - ($1::int || ' days')::interval
    ),
    by_day AS (
      SELECT to_char(date_trunc('day', opened_at), 'YYYY-MM-DD') AS day,
             count(*)::int AS cnt
      FROM base
      GROUP BY 1
      ORDER BY 1
    ),
    by_city AS (
      SELECT COALESCE(NULLIF(place_text,''), 'Neznámé') AS city,
             count(*)::int AS cnt
      FROM base
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    ),
    top_city AS (
      SELECT COALESCE(NULLIF(place_text,''), 'Neznámé') AS city, count(*)::int AS cnt
      FROM base
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 1
    ),
    longest AS (
      SELECT id, title, link, place_text, status_text, opened_at, closed_at, duration_sec
      FROM events
      WHERE duration_sec IS NOT NULL
      ORDER BY duration_sec DESC
      LIMIT 10
    ),
    active_cnt AS (
      SELECT count(*)::int AS cnt
      FROM events
      WHERE is_closed = false
    ),
    closed_cnt AS (
      SELECT count(*)::int AS cnt
      FROM events
      WHERE is_closed = true
    )
    SELECT
      (SELECT json_agg(by_day) FROM by_day) AS by_day,
      (SELECT json_agg(by_city) FROM by_city) AS top_cities,
      (SELECT row_to_json(top_city) FROM top_city) AS top_city,
      (SELECT json_agg(longest) FROM longest) AS longest,
      (SELECT cnt FROM active_cnt) AS active_count,
      (SELECT cnt FROM closed_cnt) AS closed_count
    `,
    [d]
  );

  return r.rows[0] || {};
}
