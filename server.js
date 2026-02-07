import express from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import {
  initDb,
  upsertEvent,
  getEventsFiltered,
  getStatsFiltered,
  getCachedGeocode,
  setCachedGeocode,
  updateEventCoords,
  clearEventCoords,
  deleteCachedGeocode,
  getEventsOutsideCz,
  getEventFirstSeen,
  getEventMeta,
  updateEventDuration,
  getDurationCutoffIso,
  getLongestCutoffIso,
  autoCloseStaleOpenEvents,

  // auth
  getUsersCount,
  getUserByUsername,
  getUserById,
  createUser,
  listUsers,
  updateUserById,
  createSession,
  deleteSessionByTokenSha,
  deleteExpiredSessions,
  getSessionUserByTokenSha,
  insertAudit,
  setSetting,
  getSetting,
  incPageVisit,
  getVisitStats
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------------- CONFIG ----------------
const API_KEY = process.env.API_KEY || "JPO_KEY_123456";
const GEOCODE_UA = process.env.GEOCODE_UA || "firewatchcz/1.0 (contact: admin@firewatchcz.local)";

// omez geo na Středočeský kraj (bounding box)
const STC_VIEWBOX = process.env.STC_VIEWBOX || "13.25,50.71,15.65,49.30"; // left,top,right,bottom
const STC_STATE_ALLOW = /stredocesky|central bohemia/i;


// ---------------- ESP-only auto-close (stale open events) ----------------
// Pokud ESP přestane posílat aktivní událost, po určité době ji uzavřeme:
// end_time = last_seen_at, duration se dopočítá z startu.
// (Žádné externí ověřování – jediný zdroj je ESP.)
const STALE_CLOSE_MINUTES = Math.max(5, Number(process.env.STALE_CLOSE_MINUTES || 20)); // doporučeno 15–30
const STALE_CLOSE_INTERVAL_MS = Math.max(30_000, Number(process.env.STALE_CLOSE_INTERVAL_MS || 60_000));
const STALE_CLOSE_BATCH = Math.max(1, Math.min(2000, Number(process.env.STALE_CLOSE_BATCH || 200)));

// ---------------- AUTH (OPS/ADMIN) ----------------
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "FWSESS";
const SESSION_TTL_SECONDS = Math.max(300, Number(process.env.SESSION_TTL_SECONDS || 7200)); // 2h default
const LOGIN_MAX_ATTEMPTS = Math.max(3, Number(process.env.LOGIN_MAX_ATTEMPTS || 8));
const LOGIN_WINDOW_MS = Math.max(60_000, Number(process.env.LOGIN_WINDOW_MS || 10 * 60_000));

// In-memory rate limiter for login (good enough for single-instance Railway)
const loginAttempts = new Map(); // key: ip, value: { count, firstTs }

function getClientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "";
}

function parseCookies(req) {
  const h = String(req.headers.cookie || "");
  const out = {};
  h.split(";").map(s => s.trim()).filter(Boolean).forEach(pair => {
    const i = pair.indexOf("=");
    if (i < 0) return;
    const k = pair.substring(0, i).trim();
    const v = pair.substring(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function isHttps(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  if (proto) return proto.includes("https");
  return !!req.secure;
}

function setSessionCookie(res, token, req) {
  const parts = [];
  parts.push(`${SESSION_COOKIE}=${encodeURIComponent(token)}`);
  parts.push(`Max-Age=${SESSION_TTL_SECONDS}`);
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (isHttps(req) || process.env.FORCE_SECURE_COOKIE === "1") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res, req) {
  const parts = [];
  parts.push(`${SESSION_COOKIE}=`);
  parts.push("Max-Age=0");
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (isHttps(req) || process.env.FORCE_SECURE_COOKIE === "1") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

async function authFromRequest(req) {
  try {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const tokenSha = sha256Hex(token);
    const row = await getSessionUserByTokenSha(tokenSha);
    if (!row) return null;
    const expMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      await deleteSessionByTokenSha(tokenSha);
      return null;
    }
    if (!row.is_enabled) return null;

    return {
      sessionId: row.session_id,
      user: { id: row.user_id, username: row.username, role: row.role }
    };
  } catch {
    return null;
  }
}

function requireAuthAny(req, res, next) {
  authFromRequest(req).then((auth) => {
    if (!auth?.user) return res.status(401).json({ ok: false, error: "unauthorized" });
    req.auth = auth;
    next();
  });
}

function requireOps(req, res, next) {
  authFromRequest(req).then((auth) => {
    if (!auth?.user) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!["ops", "admin"].includes(String(auth.user.role))) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    req.auth = auth;
    next();
  });
}

function requireAdmin(req, res, next) {
  authFromRequest(req).then((auth) => {
    if (!auth?.user) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (String(auth.user.role) !== "admin") {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    req.auth = auth;
    next();
  });
}

// ---------------- AUTH (ESP ingest key) ----------------
function requireKey(req, res, next) {
  const key = req.header("X-API-Key") || "";
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "bad key" });
  next();
}

// ---------------- HELPERS ----------------
function safeText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function typeLabel(t) {
  const m = {
    fire: "Požár",
    traffic: "Dopravní nehoda",
    tech: "Technická pomoc",
    rescue: "Záchrana",
    false_alarm: "Planý poplach",
    other: "Ostatní"
  };
  return m[t] || "Ostatní";
}

function classifyType(title) {
  const t = String(title || "").toLowerCase();
  if (t.includes("požár") || t.includes("pozar")) return "fire";
  if (t.includes("doprav") || t.includes("nehoda")) return "traffic";
  if (t.includes("technick") || t.includes("nebezpeč") || t.includes("nebezpec")) return "tech";
  if (t.includes("záchrana") || t.includes("zachrana") || t.includes("transport")) return "rescue";
  if (t.includes("planý poplach") || t.includes("plany poplach")) return "false_alarm";
  return "other";
}

// popis v RSS bývá: "stav: ...<br>ukončení: ...<br>Město<br>okres ..."
function parseTimesFromDescription(descRaw) {
  const desc = String(descRaw || "");
  const out = { isClosed: false, startIso: null, endIso: null };

  const lower = desc.toLowerCase();

  // stav: ukončená / ukončeno / ukončení
  if (lower.includes("stav:") && lower.includes("ukon")) out.isClosed = true;
  if (lower.includes("ukončení:")) out.isClosed = true;

  // ukončení: 31. ledna 2026, 15:07
  const mEnd = desc.match(/ukončen[íi]\s*:\s*([0-9]{1,2})\.\s*([^\n,<]+?)\s*([0-9]{4}),?\s*([0-9]{1,2})\s*:\s*([0-9]{2})/i);
  if (mEnd) {
    const day = Number(mEnd[1]);
    const monthName = String(mEnd[2]).trim().toLowerCase();
    const year = Number(mEnd[3]);
    const hh = Number(mEnd[4]);
    const mm = Number(mEnd[5]);

    const months = {
      ledna: 0, února: 1, brezna: 2, března: 2, dubna: 3, května: 4, kvetna: 4,
      června: 5, cervna: 5, července: 6, cervence: 6, srpna: 7, září: 8, zari: 8,
      října: 9, rijna: 9, listopadu: 10, prosince: 11
    };
    const mo = months[monthName];
    if (Number.isFinite(mo)) {
      const d = new Date(Date.UTC(year, mo, day, hh - 1, mm, 0)); // Prague ~ UTC+1/2 (hrubé, pro pořadí stačí)
      out.endIso = d.toISOString();
    }
  }

  // zahájení: (když by někdy bylo)
  const mStart = desc.match(/zahájen[íi]\s*:\s*([0-9]{1,2})\.\s*([^\n,<]+?)\s*([0-9]{4}),?\s*([0-9]{1,2})\s*:\s*([0-9]{2})/i);
  if (mStart) {
    const day = Number(mStart[1]);
    const monthName = String(mStart[2]).trim().toLowerCase();
    const year = Number(mStart[3]);
    const hh = Number(mStart[4]);
    const mm = Number(mStart[5]);

    const months = {
      ledna: 0, února: 1, brezna: 2, března: 2, dubna: 3, května: 4, kvetna: 4,
      června: 5, cervna: 5, července: 6, cervence: 6, srpna: 7, září: 8, zari: 8,
      října: 9, rijna: 9, listopadu: 10, prosince: 11
    };
    const mo = months[monthName];
    if (Number.isFinite(mo)) {
      const d = new Date(Date.UTC(year, mo, day, hh - 1, mm, 0));
      out.startIso = d.toISOString();
    }
  }

  return out;
}


function todayPragueISO() {
  // returns YYYY-MM-DD in Europe/Prague
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

function extractCityFromTitle(title) {
  const t = String(title || "");
  const parts = t.split(" - ").map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return null;
}

function extractCityFromDescription(descRaw) {
  const desc = String(descRaw || "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const lines = desc.split(/<br\s*\/?>|\n/g).map(s => s.trim()).filter(Boolean);
  // typicky: ["stav: ...", "ukončení: ...", "Město", "okres ..."]
  const city = lines.find(l => !/^stav\s*:/i.test(l) && !/^ukončen/i.test(l) && !/^okres\s+/i.test(l));
  return city || null;
}

function extractDistrictFromDescription(descRaw) {
  const desc = String(descRaw || "");
  const m = desc.match(/okres\s+([^<\n\r]+)/i);
  if (!m) return null;
  return String(m[1]).trim();
}

function isDistrictPlace(placeText) {
  const p = String(placeText || "").toLowerCase();
  return p.includes("okres ");
}

const MAX_DURATION_MINUTES = Math.max(60, Number(process.env.DURATION_MAX_MINUTES || 4320));
const FUTURE_END_TOLERANCE_MS = 2 * 60 * 1000;

async function computeDurationMin(id, startIso, endIso, firstSeen, cutoffIso) {
  const startMs = startIso ? new Date(startIso).getTime() : NaN;
  const nowMs = Date.now();

  // only new durations from cutoff
  if (cutoffIso) {
    const cutoffMs = new Date(cutoffIso).getTime();
    const firstSeenMs = firstSeen ? new Date(firstSeen).getTime() : NaN;

    if (Number.isFinite(cutoffMs) && Number.isFinite(firstSeenMs) && firstSeenMs < cutoffMs) {
      return null;
    }

    if (!firstSeen) {
      const dbFirstSeen = await getEventFirstSeen(id);
      const cMs = cutoffMs;
      const fMs = new Date(dbFirstSeen).getTime();
      if (Number.isFinite(cMs) && Number.isFinite(fMs) && fMs < cMs) return null;
    }
  }

  const endMs = new Date(endIso).getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (endMs > nowMs + FUTURE_END_TOLERANCE_MS) return null;

  const dur = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  if (dur > MAX_DURATION_MINUTES) return null;

  return dur;
}

function normalizePlaceQuery(placeText) {
  const raw = String(placeText || "").trim();
  if (!raw) return "";
  return raw.replace(/^okres\s+/i, "").replace(/^ok\.\s*/i, "").trim();
}

// ---------------- GEOCODE (CZ ONLY) ----------------
async function geocodePlace(placeText) {
  if (!placeText || placeText.trim().length < 2) return null;

  const cached = await getCachedGeocode(placeText);
  if (cached && typeof cached.lat === "number" && typeof cached.lon === "number") {
    return { lat: cached.lat, lon: cached.lon, cached: true };
  }

  const cleaned = normalizePlaceQuery(placeText);

  const candidates = [];
  candidates.push(String(placeText).trim());
  if (cleaned && cleaned !== String(placeText).trim()) candidates.push(cleaned);

  if (cleaned) candidates.push(`${cleaned}, Středočeský kraj`);
  if (cleaned) candidates.push(`${cleaned}, Stredocesky kraj`);
  if (cleaned) candidates.push(`${cleaned}, Central Bohemia`);
  if (cleaned) candidates.push(`${cleaned}, Czechia`);
  if (cleaned) candidates.push(`${cleaned}, Středočeský kraj, Czechia`);
  if (cleaned) candidates.push(`${cleaned}, Central Bohemia, Czechia`);

  candidates.push(`${String(placeText).trim()}, Czechia`);

  const CZ_VIEWBOX = STC_VIEWBOX;

  for (const q of candidates) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "3");
    url.searchParams.set("q", q);

    url.searchParams.set("countrycodes", "cz");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("bounded", "1");
    url.searchParams.set("viewbox", CZ_VIEWBOX);

    const r = await fetch(url.toString(), {
      headers: { "User-Agent": GEOCODE_UA, "Accept-Language": "cs,en;q=0.8" }
    });
    if (!r.ok) continue;

    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) continue;

    for (const cand of data) {
      const lat = Number(cand.lat);
      const lon = Number(cand.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const cc = String(cand?.address?.country_code || "").toLowerCase();
      if (cc && cc !== "cz") continue;

      const state = String(cand?.address?.state || cand?.address?.region || "");
      if (state && !STC_STATE_ALLOW.test(state)) continue;

      const vb = String(STC_VIEWBOX).split(",").map(x => Number(x));
      if (vb.length === 4 && vb.every(n => Number.isFinite(n))) {
        const [left, top, right, bottom] = vb;
        if (lon < left || lon > right || lat < bottom || lat > top) continue;
      }

      await setCachedGeocode(placeText, lat, lon);
      return { lat, lon, cached: false, qUsed: q };
    }
  }

  return null;
}

function parseFilters(req) {
  const typeQ = String(req.query.type || "").trim();
  const types = typeQ ? typeQ.split(",").map(s => s.trim()).filter(Boolean) : [];
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").trim();
  const day = String(req.query.day || "all").trim();
  const month = String(req.query.month || "").trim();
  return { types, city, status, day, month };
}

// ---------------- STATIC ----------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------- ROUTES ----------------

// --- auth ---
app.get("/api/auth/me", async (req, res) => {
  const auth = await authFromRequest(req);
  if (!auth?.user) return res.json({ ok: true, user: null });
  return res.json({ ok: true, user: auth.user, expires_in_s: SESSION_TTL_SECONDS });
});

app.post("/api/auth/login", async (req, res) => {
  try {
    await deleteExpiredSessions();

    const ip = getClientIp(req);
    const key = ip || "unknown";
    const now = Date.now();
    const row = loginAttempts.get(key) || { count: 0, firstTs: now };
    if (now - row.firstTs > LOGIN_WINDOW_MS) {
      row.count = 0;
      row.firstTs = now;
    }
    row.count += 1;
    loginAttempts.set(key, row);
    if (row.count > LOGIN_MAX_ATTEMPTS) {
      return res.status(429).json({ ok: false, error: "too_many_attempts" });
    }

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (username.length < 2 || password.length < 4) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    const u = await getUserByUsername(username);
    if (!u || !u.is_enabled) {
      await insertAudit({ userId: u?.id ?? null, username, action: "login_fail", details: "user_missing_or_disabled", ip });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const ok = await bcrypt.compare(password, String(u.password_hash || ""));
    if (!ok) {
      await insertAudit({ userId: u.id, username: u.username, action: "login_fail", details: "bad_password", ip });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenSha = sha256Hex(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    await createSession({ userId: u.id, tokenSha256: tokenSha, expiresAt, ip, userAgent: String(req.headers["user-agent"] || "") });
    await updateUserById(u.id, { lastLoginAtNow: true });
    await insertAudit({ userId: u.id, username: u.username, action: "login_ok", details: `role=${u.role}`, ip });

    setSessionCookie(res, token, req);
    return res.json({ ok: true, user: { id: u.id, username: u.username, role: u.role }, expires_at: expiresAt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const tokenSha = sha256Hex(token);
      await deleteSessionByTokenSha(tokenSha);
    }
    clearSessionCookie(res, req);
    return res.json({ ok: true });
  } catch {
    clearSessionCookie(res, req);
    return res.json({ ok: true });
  }
});

// --- admin: users ---
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const users = await listUsers(300);
  res.json({ ok: true, users });
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "ops").trim();
    const isEnabled = req.body?.is_enabled !== false;

    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username)) {
      return res.status(400).json({ ok: false, error: "invalid_username" });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: "weak_password" });
    }
    if (!["ops", "admin"].includes(role)) {
      return res.status(400).json({ ok: false, error: "invalid_role" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await createUser({ username, passwordHash, role, isEnabled });
    await insertAudit({ userId: req.auth.user.id, username: req.auth.user.username, action: "user_create", details: `${username} role=${role}`, ip: getClientIp(req) });
    return res.json({ ok: true, user: created });
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return res.status(409).json({ ok: false, error: "username_taken" });
    }
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });

    const patch = {};
    if (req.body?.role != null) {
      const role = String(req.body.role);
      if (!["ops", "admin"].includes(role)) return res.status(400).json({ ok: false, error: "invalid_role" });
      patch.role = role;
    }
    if (req.body?.is_enabled != null) patch.isEnabled = !!req.body.is_enabled;
    if (req.body?.password != null) {
      const pw = String(req.body.password);
      if (pw.length < 6) return res.status(400).json({ ok: false, error: "weak_password" });
      patch.passwordHash = await bcrypt.hash(pw, 12);
    }
    const updated = await updateUserById(id, patch);
    if (!updated) return res.status(404).json({ ok: false, error: "not_found" });

    await insertAudit({ userId: req.auth.user.id, username: req.auth.user.username, action: "user_update", details: `${updated.username}`, ip: getClientIp(req) });
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ingest (data z ESP)
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const { source, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items missing" });
    }

    let accepted = 0;
    let updatedClosed = 0;
    let geocoded = 0;

    for (const it of items) {
      if (!it?.id || !it?.title || !it?.link) continue;

      const prev = await getEventMeta(it.id);

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const times = parseTimesFromDescription(desc);

// --- ESP is the only source ---
// We must respect explicit flags from ESP, but also keep legacy parsing from description.
const statusLower = String(it.statusText || "").toLowerCase();
const isClosed = !!(
  it.isClosed === true ||
  it.is_closed === true ||
  (statusLower.includes("ukon") && statusLower.includes("stav")) ||
  statusLower.includes("ukončen") ||
  statusLower.includes("ukonc") ||
  times.isClosed
);

// start / end timestamps (prefer payload, then parsed, then previous DB values)
const startIso =
  it.startTimeIso ||
  times.startIso ||
  prev?.start_time_iso ||
  null;

let endIso =
  it.endTimeIso ||
  times.endIso ||
  prev?.end_time_iso ||
  null;

// When we see the event transition to closed for the first time and we don't have end time,
// set end time to "now" (we only know it ended sometime before we noticed – best available).
const closingNow = isClosed && (!prev || !prev.is_closed);
if (closingNow && !endIso) {
  endIso = new Date().toISOString();
}

let durationMin = null;

// If ESP provided duration explicitly, trust it (within sanity bounds).
if (Number.isFinite(it.durationMin)) {
  const candidate = Math.round(it.durationMin);
  durationMin = (candidate > 0 && candidate <= MAX_DURATION_MINUTES) ? candidate : null;
} else if (isClosed && endIso) {
  // Compute only for "new" events (cutoff to avoid insane historical durations)
  const cutoffIso = await getDurationCutoffIso();
  durationMin = await computeDurationMin(it.id, startIso, endIso, prev?.first_seen_at || null, cutoffIso);
}

      const placeText = it.placeText || null;
      const cityFromDesc = extractCityFromDescription(desc);
      const cityFromTitle = extractCityFromTitle(it.title);
      const districtFromDesc = extractDistrictFromDescription(desc);

      const cityText =
        it.cityText ||
        cityFromDesc ||
        (!placeText ? cityFromTitle : (isDistrictPlace(placeText) ? cityFromTitle : placeText)) ||
        null;

      const ev = {
        id: it.id,
        title: it.title,
        link: it.link,
        pubDate: it.pubDate || null,
        placeText,
        cityText,
        statusText: it.statusText || null,
        eventType,
        descriptionRaw: desc || null,
        startTimeIso: startIso,
        endTimeIso: endIso,
        durationMin,
        isClosed
      };

      await upsertEvent(ev);
      accepted++;

      if (ev.isClosed) updatedClosed++;

      const geoQueries = [];
      if (ev.cityText && districtFromDesc) geoQueries.push(`${ev.cityText}, okres ${districtFromDesc}`);
      if (ev.cityText) geoQueries.push(ev.cityText);
      if (ev.placeText && ev.placeText !== ev.cityText) geoQueries.push(ev.placeText);

      let fixed = false;
      for (const q of geoQueries) {
        const g = await geocodePlace(q);
        if (g) {
          await updateEventCoords(ev.id, g.lat, g.lon);
          geocoded++;
          fixed = true;
          break;
        }
      }
      if (!fixed && (ev.cityText || ev.placeText)) {
        // nic
      }
    }

    res.json({
      ok: true,
      source: source || "unknown",
      accepted,
      closed_seen_in_batch: updatedClosed,
      geocoded
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

// ---------------- VISITS (no cookies, no identifiers; admin-only viewing) ----------------

// ---------------- SETTINGS ----------------
app.get("/api/settings", async (req, res) => {
  try {
    const v = await getSetting("default_shift_mode");
    const mode = (v === "HZSP" || v === "HZS") ? v : "HZS";
    return res.json({ ok: true, default_shift_mode: mode });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "settings_failed" });
  }
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const v = await getSetting("default_shift_mode");
    const mode = (v === "HZSP" || v === "HZS") ? v : "HZS";
    return res.json({ ok: true, default_shift_mode: mode });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "settings_failed" });
  }
});

app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const mode = String(req.body?.default_shift_mode || "").toUpperCase();
    if (mode !== "HZS" && mode !== "HZSP") {
      return res.status(400).json({ ok: false, error: "invalid_default_shift_mode" });
    }
    await setSetting("default_shift_mode", mode);
    try {
      await insertAudit(req.auth?.user?.id, "admin_settings_update", JSON.stringify({ default_shift_mode: mode }));
    } catch {}
    return res.json({ ok: true, default_shift_mode: mode });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "save_failed" });
  }
});

app.post("/api/visit", async (req, res) => {
  try {
    const auth = await authFromRequest(req);
    const role = String(auth?.user?.role || "");
    const mode = role === "admin" ? "admin" : (role === "ops" ? "ops" : "public");
    await incPageVisit(mode, todayPragueISO());
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: true }); // fail-open; never break UI
  }
});

app.get("/api/admin/visits/stats", requireAdmin, async (req, res) => {
  const stats30 = await getVisitStats(30);

  const sumDays = (n) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (n - 1));
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const totals = {};
    let grand = 0;
    for (const row of stats30.rows) {
      if (row.day < cutoffIso) continue;
      const h = Number(row.hits || 0);
      totals[row.mode] = (totals[row.mode] || 0) + h;
      grand += h;
    }
    return { totals, grand };
  };

  const today = sumDays(1);
  const last7 = sumDays(7);
  const last30 = sumDays(30);

  return res.json({ ok: true, today, last7, last30 });
});


// events (filters) + backfill coords + backfill duration
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 400), 2000);
  const filters = parseFilters(req);

  const rows = await getEventsFiltered(filters, limit);

  res.json({ ok: true, filters, backfilled_coords: 0, backfilled_durations: 0, items: rows });
});

// ✅ stats (30 dní) – vždy ze všech dnů (ignoruje filtr "Den")
app.get("/api/stats", async (req, res) => {
  const filters = parseFilters(req);
  const statsFilters = { ...filters, day: "all" };

  const stats = await getStatsFiltered(statsFilters);

  const openCount = stats?.openVsClosed?.open ?? 0;
  const closedCount = stats?.openVsClosed?.closed ?? 0;

  res.json({ ok: true, filters: statsFilters, ...stats, openCount, closedCount });
});

// export CSV
app.get("/api/export.csv", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  const rows = await getEventsFiltered(filters, limit);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.csv"`);

  const csvEscape = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r;]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };

  const formatDateForCsv = (v) => {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toISOString();
  };

  const header = [
    "time_iso",
    "state",
    "type",
    "title",
    "city",
    "place_text",
    "status_text",
    "duration_min",
    "link"
  ].join(";");

  const lines = rows.map(r => {
    const timeIso = formatDateForCsv(r.pub_date || r.created_at);
    const state = r.is_closed ? "UKONCENO" : "AKTIVNI";
    const typ = typeLabel(r.event_type || "other");
    return [
      csvEscape(timeIso),
      csvEscape(state),
      csvEscape(typ),
      csvEscape(r.title || ""),
      csvEscape(r.city_text || ""),
      csvEscape(r.place_text || ""),
      csvEscape(r.status_text || ""),
      csvEscape(Number.isFinite(r.duration_min) ? r.duration_min : ""),
      csvEscape(r.link || "")
    ].join(";");
  });

  res.send([header, ...lines].join("\n"));
});

// export PDF
function tryApplyPdfFont(doc) {
  try {
    // Prefer bundled font inside repo (works on Railway / Docker)
    const bundled = path.join(__dirname, "public", "fonts", "DejaVuSans.ttf");
    if (fs.existsSync(bundled)) {
      doc.font(bundled);
      return;
    }

    // Fallback for some Linux environments (local dev, etc.)
    const linuxPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    if (fs.existsSync(linuxPath)) {
      doc.font(linuxPath);
      return;
    }
  } catch {
    // ignore
  }
}

app.get("/api/export.pdf", async (req, res) => {
  const filters = parseFilters(req);
  const limit = Math.min(Number(req.query.limit || 800), 2000);
  const rows = await getEventsFiltered(filters, limit);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  doc.pipe(res);

  tryApplyPdfFont(doc);

  const now = new Date();
  doc.fontSize(18).fillColor("#000").text("JPO výjezdy – export");
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#333").text(`Vygenerováno: ${now.toLocaleString("cs-CZ")}`);
  doc.moveDown(0.8);

  const col = {
    time: 24,
    state: 155,
    type: 240,
    city: 330,
    dur: 470,
    title: 555
  };

  doc.fontSize(10).fillColor("#000");
  doc.text("Čas", col.time, doc.y);
  doc.text("Stav", col.state, doc.y);
  doc.text("Typ", col.type, doc.y);
  doc.text("Město", col.city, doc.y);
  doc.text("Délka", col.dur, doc.y);
  doc.text("Název", col.title, doc.y);
  doc.moveDown(0.5);
  doc.moveTo(24, doc.y).lineTo(820, doc.y).strokeColor("#ddd").stroke();
  doc.moveDown(0.3);

  const fmt = (v) => {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString("cs-CZ");
  };

  const fmtDur = (m) => {
    if (!Number.isFinite(m) || m <= 0) return "—";
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h <= 0) return `${mm} min`;
    return `${h} h ${mm} min`;
  };

  for (const r of rows) {
    const y = doc.y;

    const time = fmt(r.pub_date || r.created_at);
    const state = r.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const typ = typeLabel(r.event_type || "other");
    const city = r.city_text || r.place_text || "";
    const dur = fmtDur(r.duration_min);
    const title = r.title || "";

    doc.fillColor("#000").text(time, col.time, y, { width: 120 });
    doc.fillColor("#000").text(state, col.state, y, { width: 80 });
    doc.fillColor("#000").text(typ, col.type, y, { width: 85 });
    doc.fillColor("#000").text(city, col.city, y, { width: 130 });
    doc.fillColor("#000").text(dur, col.dur, y, { width: 70 });
    doc.fillColor("#000").text(title, col.title, y, { width: 260 });

    doc.moveDown(0.35);
    doc.moveTo(24, doc.y).lineTo(820, doc.y).strokeColor("#f0f0f0").stroke();
    doc.moveDown(0.25);

    if (doc.y > 560) doc.addPage();
  }

  doc.end();
});

// admin: geocode cache purge + re-geocode (ponecháno na API key)
app.post("/api/admin/fix-geocode", requireKey, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "preview");
    const bad = await getEventsOutsideCz(300);

    let cacheDeleted = 0;
    let coordsCleared = 0;
    let reGeocoded = 0;
    let failed = 0;

    for (const r of bad) {
      const q = r.city_text || r.place_text;
      if (!q) continue;

      if (mode !== "preview") {
        await deleteCachedGeocode(q);
        cacheDeleted++;
        await clearEventCoords(r.id);
        coordsCleared++;
      }

      const g = await geocodePlace(q);
      if (g && mode !== "preview") {
        await updateEventCoords(r.id, g.lat, g.lon);
        reGeocoded++;
      } else if (!g) {
        failed++;
      }
    }

    res.json({
      ok: true,
      mode,
      processed: bad.length,
      cache_deleted: cacheDeleted,
      coords_cleared: coordsCleared,
      re_geocoded: reGeocoded,
      failed
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server error" });
  }
});

app.get("/health", (req, res) => res.send("OK"));

async function ensureInitialAdmin() {
  // optional bootstrap via env vars
  const initUser = String(process.env.INIT_ADMIN_USERNAME || "").trim();
  const initPass = String(process.env.INIT_ADMIN_PASSWORD || "");
  if (!initUser || !initPass) return;

  const count = await getUsersCount();
  if (count > 0) return;

  const passwordHash = await bcrypt.hash(initPass, 12);
  await createUser({ username: initUser, passwordHash, role: "admin", isEnabled: true });
  await insertAudit({ userId: null, username: initUser, action: "bootstrap_admin", details: "created initial admin from env" });
  console.log(`[auth] Initial admin created: ${initUser}`);
}


let staleCloserInFlight = false;

async function runStaleAutoClose() {
  if (staleCloserInFlight) return;
  staleCloserInFlight = true;
  try {
    const closed = await autoCloseStaleOpenEvents({
      staleMinutes: STALE_CLOSE_MINUTES,
      limit: STALE_CLOSE_BATCH
    });

    if (closed?.length) {
      console.log(`[stale-close] auto-closed ${closed.length} events (>${STALE_CLOSE_MINUTES} min since last_seen)`);
    }
  } catch (e) {
    console.error("[stale-close] error:", e?.message || e);
  } finally {
    staleCloserInFlight = false;
  }
}

const port = process.env.PORT || 3000;
await initDb();
await ensureInitialAdmin();

// start stale closer loop (ESP-only)
await runStaleAutoClose();
setInterval(runStaleAutoClose, STALE_CLOSE_INTERVAL_MS);

app.listen(port, () => console.log(`listening on ${port}`));
