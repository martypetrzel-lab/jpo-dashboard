import pg from "pg";
const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing DATABASE_URL env var");
    pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function ensureColumn(client, table, col, typeSql) {
  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${typeSql};`);
}

function normPlace(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectKind(title = "") {
  const t = String(title).toLowerCase();
  if (t.includes("požár") || t.includes("pozar")) return "pozar";
  if (t.includes("doprav") || t.includes("nehod")) return "nehoda";
  if (t.includes("techn")) return "technicka";
  if (t.includes("zachran") || t.includes("záchran")) return "zachrana";
  return "jine";
}

// --------------------
// Geocoding (Nominatim) + DB cache
// --------------------
async function nominatimGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "jpo-dashboard/1.0 (Railway)" },
      signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return null;
    const lat = Number(j[0].lat);
    const lon = Number(j[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getOrGeocode(client, placeText) {
  const placeNorm = normPlace(placeText);
  if (!placeNorm) return { placeNorm, lat: null, lon: null };

  // cache
  try {
    const c = await client.query(
      `SELECT lat, lon FROM geocode_cache WHERE place_norm=$1 LIMIT 1`,
      [placeNorm]
    );
    if (c.rows?.length) {
      return { placeNorm, lat: c.rows[0].lat, lon: c.rows[0].lon };
    }
  } catch {
    // kdyby cache tabulka ještě nebyla, initDb ji vytvoří; tady jen nepadneme
  }

  const geo = await nominatimGeocode(`${placeText}, Czechia`);

  try {
    await client.query(
      `INSERT INTO geocode_cache(place_norm, place_text, lat, lon, updated_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(place_norm) DO UPDATE
         SET place_text=EXCLUDED.place_text, lat=EXCLUDED.lat, lon=EXCLUDED.lon, updated_at=NOW()`,
      [placeNorm, placeText, geo ? geo.lat : null, geo ? geo.lon : null]
    );
  } catch {
    // nic — cache není kritická
  }

  return { placeNorm, lat: geo ? geo.lat : null, lon: geo ? geo.lon : null };
}

export async function initDb() {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source TEXT DEFAULT 'unknown',
        title TEXT,
        link TEXT,
        place_text TEXT,
        place_norm TEXT,
        status_text TEXT,
        description_raw TEXT,
        kind TEXT DEFAULT 'jine',
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        is_active BOOLEAN DEFAULT true,
        started_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_min INTEGER,
        first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS geocode_cache (
        place_norm TEXT PRIMARY KEY,
        place_text TEXT,
        lat DOUBLE PRECISION,
        lon DOUBLE PRECISION,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // migrations
    await ensureColumn(client, "events", "place_norm", "TEXT");
    await ensureColumn(client, "events", "kind", "TEXT DEFAULT 'jine'");
    await ensureColumn(client, "events", "lat", "DOUBLE PRECISION");
    await ensureColumn(client, "events", "lon", "DOUBLE PRECISION");
    await ensureColumn(client, "events", "is_active", "BOOLEAN DEFAULT true");
    await ensureColumn(client, "events", "started_at", "TIMESTAMPTZ");
    await ensureColumn(client, "events", "ended_at", "TIMESTAMPTZ");
    await ensureColumn(client, "events", "duration_min", "INTEGER");
    await ensureColumn(client, "events", "last_seen_at", "TIMESTAMPTZ DEFAULT NOW()");

    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_active ON events(is_active);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_place_norm ON events(place_norm);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_last_seen_at ON events(last_seen_at);`);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertBatch({ source = "unknown", items = [] }) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query("BEGIN");

    let accepted = 0;
    let updatedClosed = 0;

    for (const it of items) {
      const id = String(it.id || "").trim();
      if (!id) continue;

      const title = it.title ?? "";
      const link = it.link ?? "";
      const placeText = it.placeText ?? it.place_text ?? "";
      const statusText = it.statusText ?? it.status_text ?? "";
      const descRaw = it.descriptionRaw ?? it.description_raw ?? "";

      const st = String(statusText).toLowerCase();
      const active =
        st.includes("stav: nova") || st.includes("stav: nová") ||
        st.includes(" nova") || st.includes(" nová");

      const kind = (it.kind || detectKind(title));
      const placeNorm = normPlace(placeText);

      let lat = Number(it.lat);
      let lon = Number(it.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const geo = await getOrGeocode(client, placeText);
        lat = geo.lat;
        lon = geo.lon;
      }

      const q = `
        INSERT INTO events (
          id, source, title, link, place_text, place_norm, status_text, description_raw,
          kind, lat, lon, is_active, started_at, ended_at, duration_min, first_seen_at, last_seen_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,
          CASE WHEN $12=true THEN COALESCE($13, NOW()) ELSE $13 END,
          CASE WHEN $12=false THEN COALESCE($14, NOW()) ELSE NULL END,
          $15,
          COALESCE($16, NOW()),
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          source = EXCLUDED.source,
          title = EXCLUDED.title,
          link = EXCLUDED.link,
          place_text = EXCLUDED.place_text,
          place_norm = EXCLUDED.place_norm,
          status_text = EXCLUDED.status_text,
          description_raw = EXCLUDED.description_raw,
          kind = EXCLUDED.kind,
          lat = COALESCE(EXCLUDED.lat, events.lat),
          lon = COALESCE(EXCLUDED.lon, events.lon),
          last_seen_at = NOW(),
          is_active = EXCLUDED.is_active,
          ended_at = CASE
            WHEN events.is_active = true AND EXCLUDED.is_active = false THEN NOW()
            WHEN EXCLUDED.is_active = true THEN NULL
            ELSE events.ended_at
          END
        RETURNING (events.is_active = true AND EXCLUDED.is_active = false) AS just_closed;
      `;

      const res = await client.query(q, [
        id, source, title, link, placeText, placeNorm, statusText, descRaw,
        kind,
        (Number.isFinite(lat) ? lat : null),
        (Number.isFinite(lon) ? lon : null),
        active,
        null, null, null,
        null
      ]);

      accepted += 1;
      if (res.rows?.[0]?.just_closed) updatedClosed += 1;
    }

    // duration after close
    await client.query(`
      UPDATE events
      SET duration_min = FLOOR(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)
      WHERE ended_at IS NOT NULL AND started_at IS NOT NULL AND duration_min IS NULL;
    `);

    await client.query("COMMIT");
    return { accepted, updatedClosed };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getEvents({ limit = 200, active = null } = {}) {
  const p = getPool();

  const where = [];
  if (active === true) where.push(`is_active = true`);
  if (active === false) where.push(`is_active = false`);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const r = await p.query(
    `
    SELECT
      id, title, link,
      place_text, kind,
      is_active,
      started_at, ended_at, duration_min,
      lat, lon,
      last_seen_at
    FROM events
    ${w}
    ORDER BY last_seen_at DESC
    LIMIT $1
    `,
    [Math.min(Number(limit) || 200, 1000)]
  );

  return r.rows;
}

export async function getStats({ days = 30 } = {}) {
  const p = getPool();
  const d = Math.max(1, Math.min(365, Number(days) || 30));

  const r1 = await p.query(`
    SELECT
      (SELECT COUNT(*) FROM events WHERE is_active = true) AS active_count,
      (SELECT COUNT(*) FROM events WHERE is_active = false AND last_seen_at > NOW() - ($1::int || ' days')::interval) AS closed_count
  `, [d]);

  const rTop = await p.query(`
    SELECT place_text AS city, COUNT(*)::int AS cnt
    FROM events
    WHERE place_text IS NOT NULL AND place_text <> ''
      AND last_seen_at > NOW() - ($1::int || ' days')::interval
    GROUP BY place_text
    ORDER BY cnt DESC
    LIMIT 1
  `, [d]);

  const top = rTop.rows[0] || null;

  return {
    days: d,
    active_count: Number(r1.rows[0].active_count || 0),
    closed_count: Number(r1.rows[0].closed_count || 0),
    top_city: top ? { city: top.city, cnt: top.cnt } : null
  };
}
