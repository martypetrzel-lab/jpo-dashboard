import pg from "pg";

const { Pool } = pg;

// Railway/Render typicky dávají DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) throw new Error("DATABASE_URL not set");

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });

  return pool;
}

export async function initDb() {
  const p = getPool();

  // Základní tabulka (kompatibilní a stabilní)
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

      duration_min INTEGER NULL,
      is_closed BOOLEAN NOT NULL DEFAULT FALSE,
      closed_detected_at TIMESTAMPTZ NULL,

      lat DOUBLE PRECISION NULL,
      lon DOUBLE PRECISION NULL,

      -- tyhle sloupce máš podle logu používané:
      first_seen_at TIMESTAMPTZ NULL,
      last_seen_at TIMESTAMPTZ NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ✅ Pokud tabulka existovala ze starší verze, doplň chybějící sloupce bezpečně
  await p.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NULL;`);
  await p.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;`);
  await p.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await p.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);

  // Indexy
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_pub_date ON events(pub_date);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time_iso);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_closed ON events(is_closed);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_city ON events(city_text);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen_at);`);

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

  const id = String(ev.id || "").trim();
  if (!id) return;

  const title = ev.title ?? null;
  const link = ev.link ?? null;

  const pubDate = ev.pubDate ? new Date(ev.pubDate) : null;
  const pubDateTs = pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate.toISOString() : null;

  const placeText = ev.placeText ?? null;
  const cityText = ev.cityText ?? null;
  const statusText = ev.statusText ?? null;
  const eventType = ev.eventType ?? null;
  const descriptionRaw = ev.descriptionRaw ?? null;

  const startD = ev.startTimeIso ? new Date(ev.startTimeIso) : null;
  const startTs = startD && !Number.isNaN(startD.getTime()) ? startD.toISOString() : null;

  const endD = ev.endTimeIso ? new Date(ev.endTimeIso) : null;
  const endTs = endD && !Number.isNaN(endD.getTime()) ? endD.toISOString() : null;

  const durationMin = Number.isFinite(ev.durationMin) ? Math.round(ev.durationMin) : null;
  const isClosed = !!ev.isClosed;

  // ✅ DŮLEŽITÉ: používáme jen tyhle správné názvy:
  // first_seen_at, last_seen_at (žádný "ß" nesmysl)
  await p.query(
    `
    INSERT INTO events (
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type,
      description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed,
      closed_detected_at,
      first_seen_at, last_seen_at,
      created_at, updated_at
    )
    VALUES (
      $1,$2,$3,$4,
      $5,$6,$7,$8,
      $9,
      $10,$11,$12,$13,
      CASE WHEN $13 = TRUE THEN NOW() ELSE NULL END,
      NOW(), NOW(),
      NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, events.title),
      link = COALESCE(EXCLUDED.link, events.link),
      pub_date = COALESCE(EXCLUDED.pub_date, events.pub_date),

      place_text = COALESCE(EXCLUDED.place_text, events.place_text),
      city_text  = COALESCE(EXCLUDED.city_text,  events.city_text),
      status_text = COALESCE(EXCLUDED.status_text, events.status_text),
      event_type  = COALESCE(EXCLUDED.event_type, events.event_type),
      description_raw = COALESCE(EXCLUDED.description_raw, events.description_raw),

      start_time_iso = COALESCE(EXCLUDED.start_time_iso, events.start_time_iso),

      -- end_time_iso jen při prvním uzavření
      end_time_iso = CASE
        WHEN events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE THEN COALESCE(EXCLUDED.end_time_iso, NOW())
        ELSE events.end_time_iso
      END,

      is_closed = (events.is_closed OR EXCLUDED.is_closed),

      closed_detected_at = CASE
        WHEN events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE THEN NOW()
        ELSE events.closed_detected_at
      END,

      -- duration_min ulož jen při prvním uzavření, pokud přišlo spočítané
      duration_min = CASE
        WHEN events.is_closed = FALSE AND EXCLUDED.is_closed = TRUE AND EXCLUDED.duration_min IS NOT NULL THEN EXCLUDED.duration_min
        ELSE events.duration_min
      END,

      -- ✅ tady je fix: správný sloupec
      last_seen_at = NOW(),
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
      durationMin,
      isClosed,
    ]
  );
}

export async function getEventFirstSeen(id) {
  const p = getPool();
  const r = await p.query(`SELECT first_seen_at FROM events WHERE id=$1`, [id]);
  return r.rows?.[0]?.first_seen_at || null;
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

// ---------------- FILTERED READS (ponechávám kompatibilní – pokud je máš jinde, klidně smaž) ----------------
// Pokud máš getEventsFiltered/getStatsFiltered definované v jiné verzi db.js,
// tak si nech ty své – ale pak sem doplň minimálně initDb + upsertEvent fix.
export async function getEventsFiltered(filters, limit = 400) {
  const p = getPool();

  const params = [];
  const where = [];

  // status
  if (filters?.status === "open") where.push(`is_closed = FALSE`);
  else if (filters?.status === "closed") where.push(`is_closed = TRUE`);

  // type
  if (filters?.types?.length) {
    params.push(filters.types[0]);
    where.push(`event_type = $${params.length}`);
  }

  // city substring
  if (filters?.city) {
    params.push(`%${filters.city}%`);
    where.push(`(COALESCE(city_text,'') ILIKE $${params.length} OR COALESCE(place_text,'') ILIKE $${params.length})`);
  }

  // month YYYY-MM
  if (filters?.month) {
    params.push(filters.month);
    where.push(`to_char((COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date, 'YYYY-MM') = $${params.length}`);
  }

  // day today/yesterday/all
  if (filters?.day === "today") {
    where.push(`((COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date = (NOW() AT TIME ZONE 'Europe/Prague')::date)`);
  } else if (filters?.day === "yesterday") {
    where.push(`((COALESCE(start_time_iso, pub_date, created_at) AT TIME ZONE 'Europe/Prague')::date = ((NOW() AT TIME ZONE 'Europe/Prague')::date - INTERVAL '1 day')::date)`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  params.push(limit);

  const r = await p.query(
    `
    SELECT
      id, title, link, pub_date,
      place_text, city_text, status_text, event_type, description_raw,
      start_time_iso, end_time_iso, duration_min, is_closed, closed_detected_at,
      lat, lon,
      first_seen_at, last_seen_at,
      created_at, updated_at
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

  // jednoduchý kompat režim: jen počty + topCities + longest
  const rows = await getEventsFiltered(filters, 5000);

  const openCount = rows.filter((r) => !r.is_closed).length;
  const closedCount = rows.filter((r) => r.is_closed).length;

  const cityMap = new Map();
  for (const r of rows) {
    const c = String(r.city_text || r.place_text || "").trim();
    if (!c) continue;
    cityMap.set(c, (cityMap.get(c) || 0) + 1);
  }
  const topCities = [...cityMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([city, count]) => ({ city, count }));

  const longest = rows
    .filter((r) => r.is_closed && r.closed_detected_at && Number.isFinite(r.duration_min) && r.duration_min > 0)
    .sort((a, b) => b.duration_min - a.duration_min)
    .slice(0, 10);

  // byDay nechám prázdné (pokud ho počítáš jinde ve své verzi, klidně si to vrať)
  const byDay = [];

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