import {normalizeFeedTimestamp,hasTrustedStart,annotateEventTime,diagnoseTimes} from './time-model.js';
import {createGeocoder, createGeocodeJobs, buildQueries, eventLocation, annotateEventGeo, diagnoseCoordinates, canImprove, insideCz} from './geocoding.js';
import {getGeoCache,setGeoCache,reserveGeocodeRequest,getGeoAuditRows,applyGeoProposal,geoFingerprint,recordGeoFailure} from './db.js';
import express from "express";
import {createRateLimiter} from "./security.js";
import http from "http";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { attachOpsRadio } from "./radio-server.js";
import { createRssWorker, readRssConfig, shouldIngestRssItemForToday, testRssConnection } from "./rss-worker.js";
import { shouldIngestPrahaItem } from "./prague-atom.js";
import { pardubickyAgeClass } from "./pardubicky-rss.js";


// ======================
// Geocoding: timeout + circuit breaker (prevents spam when provider is down)
// ======================


async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}


import {
  pool,
  initDb,
  upsertEvent,
  getEventsFiltered,
  getPublicDataStatus,
  getPublicSourceStatus,
  countEventsFiltered,
  getStatsFiltered,
  updateEventCoords,
  clearEventCoords,
  getEventFirstSeen,
  getEventMeta,
  getEventMetaBySourceExternal,
  touchEventLastSeen,
  getSourceIdentityState,
  updateEventSourceDetails,
  auditCrossRegionStationAssignments,
  updateEventDuration,
  getDurationCutoffIso,
  getLongestCutoffIso,
  autoCloseStaleOpenEvents,
  repairClosedEventsMissingEndTime,
  clearEstimatedDurationsForAlreadyClosedEvents,
  clearObservedDurations,
  recomputeObservedDurationsForClosedEvents,
  listEventsForMajorBackfill,
  updateEventMajorAnalysis,
  updateEventStatusFromRecheck,
  getMajorEventsSummary,
  getEventForManualEdit,
  updateEventManualMeta,
  getEventDetailById,
  updateEventManualDetail,

  // auth
  getUsersCount,
  getUserByUsername,
  getUserById,
  createUser,
  listUsers,
  updateUserById,
  createSession,
  deleteSessionByTokenSha,
  deleteUserSessions,
  deleteExpiredSessions,
  getSessionUserByTokenSha,
  insertAudit,
  searchEventsAdmin,
  getIngestDiagnostics,
  insertIngestLog,
  insertManualEvent,
  setSetting,
  getSetting,
  incPageVisit,
  getVisitStats,
  createUserPublic,
  createOpsRequest,
  listPendingOpsRequests,
  decideOpsRequest,
  getEventsMissingCoords,
  getEventById,
  listEventsWithCoords,
  upsertArchivedReport,
  listArchivedReports,
  listArchivedReportsPage,
  getArchivedReport,
  getEventsForPeriod,
  acquireRssWorkerLock

} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeRoute(handler) {return(req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next);}
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy',Math.max(0,Math.min(5,Number(process.env.TRUST_PROXY_HOPS ?? 1)||0)));
app.use(express.json({limit:'2mb'}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)&&req.headers.origin){
    try {if(new URL(req.headers.origin).host!==req.headers.host)return res.status(403).json({ok:false,error:'forbidden_origin'});}catch{return res.status(403).json({ok:false,error:'forbidden_origin'});}
  }
  next();
});
let rssWorker = null;

// ---------------- CONFIG ----------------
const API_KEY = process.env.API_KEY || "";
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

const loginLimiter=createRateLimiter({max:LOGIN_MAX_ATTEMPTS,windowMs:LOGIN_WINDOW_MS});
const registerLimiter=createRateLimiter({max:5,windowMs:LOGIN_WINDOW_MS});
function getClientIp(req) {return req.ip || req.socket?.remoteAddress || '';}

function parseCookies(req) {
  const h = String(req.headers.cookie || "");
  const out = {};
  h.split(";").map(s => s.trim()).filter(Boolean).forEach(pair => {
    const i = pair.indexOf("=");
    if (i < 0) return;
    const k = pair.substring(0, i).trim();
    const v = pair.substring(i + 1).trim();
    try {out[k]=decodeURIComponent(v);} catch {}
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
      user: { id: row.user_id, username: row.username, role: row.role, permissions: normalizePermissions(row.role, row.permissions || {}) }
    };
  } catch {
    return null;
  }
}

const FW_ROLE_DEFAULT_PERMISSIONS = {
  public: { canViewOps: false, canUseAudio: false, canUseTalk: false, canEditIncidents: false, canFixGps: false, canCreateReports: false, canManageUsers: false, canViewDiagnostics: false },
  ops: { canViewOps: true, canUseAudio: true, canUseTalk: true, canEditIncidents: false, canFixGps: false, canCreateReports: false, canManageUsers: false, canViewDiagnostics: false },
  editor: { canViewOps: true, canUseAudio: false, canUseTalk: true, canEditIncidents: true, canFixGps: true, canCreateReports: true, canManageUsers: false, canViewDiagnostics: false },
  admin: { canViewOps: true, canUseAudio: true, canUseTalk: true, canEditIncidents: true, canFixGps: true, canCreateReports: true, canManageUsers: true, canViewDiagnostics: true },
  custom: {}
};

function normalizePermissions(role, permissions = {}) {
  const base = FW_ROLE_DEFAULT_PERMISSIONS[String(role || "public").toLowerCase()] || FW_ROLE_DEFAULT_PERMISSIONS.public;
  return { ...base, ...(permissions || {}) };
}

function userHasPermission(user, permission) {
  const role = String(user?.role || "public").toLowerCase();
  if (role === "admin") return true;
  const permissions = normalizePermissions(role, user?.permissions || {});
  return !!permissions[permission];
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
    if (!["ops", "editor", "admin"].includes(String(auth.user.role)) && !userHasPermission(auth.user, "canViewOps")) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    req.auth = auth;
    next();
  });
}

function requireReportAuthor(req, res, next) {
  authFromRequest(req).then(auth => {
    if (!auth?.user) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!userHasPermission(auth.user, "canCreateReports")) return res.status(403).json({ ok: false, error: "forbidden" });
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
  if(!API_KEY)return res.status(503).json({ok:false,error:'ingest_not_configured'});
  const expected=crypto.createHash('sha256').update(API_KEY).digest(),supplied=crypto.createHash('sha256').update(String(key)).digest();
  if(!crypto.timingSafeEqual(expected,supplied))return res.status(401).json({ok:false,error:'bad key'});
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
    hazmat: "Únik nebezpečných látek",
    false_alarm: "Planý poplach",
    hzs: "Událost HZS",
    water: "Voda",
    electricity: "Elektřina",
    transport: "Veřejná doprava",
    crisis_other: "Jiná krizová událost",
    other: "Ostatní"
  };
  return m[t] || "Ostatní";
}

function eventSourceLabel(event) {
  if (event?.source === "praha") return "Praha";
  if (event?.source === "pardubicky") return "Pardubický kraj";
  return "Středočeský kraj";
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


function pragueLocalToUtcIso(year, monthIndex, day, hour, minute, second = 0) {
  const wanted = Date.UTC(year, monthIndex, day, hour, minute, second);
  const calendar = new Date(wanted);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== monthIndex || calendar.getUTCDate() !== day
      || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  // Check both legal Prague offsets, including DST boundaries. Ambiguous autumn
  // times use the first occurrence; nonexistent spring times are rejected.
  for (const offset of [120, 60]) {
    const candidate = new Date(wanted - offset * 60000);
    const parts = Object.fromEntries(fmt.formatToParts(candidate).map(p => [p.type, p.value]));
    if (Number(parts.year) === year && Number(parts.month) === monthIndex + 1 && Number(parts.day) === day
        && Number(parts.hour) === hour && Number(parts.minute) === minute && Number(parts.second) === second) return candidate.toISOString();
  }
  return null;
}

// popis v RSS bývá: "stav: ...<br>ukončení: ...<br>Město<br>okres ..."
function parseTimesFromDescription(descRaw) {
  const desc = String(descRaw || "");
  const out = { isClosed: false, startIso: null, endIso: null };

  const lower = desc.toLowerCase();

  // stav: ukončená / ukončeno / ukončení
  if (/stav\s*:\s*ukon(?:čen|cen)/i.test(desc)) out.isClosed = true;
  // An empty ukončení field is present even on active RSS items.

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
      out.endIso = pragueLocalToUtcIso(year, mo, day, hh, mm);
      if (out.endIso) out.isClosed = true;
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
      out.startIso = pragueLocalToUtcIso(year, mo, day, hh, mm);
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

function extractCityFromDescription(descRaw) {return eventLocation({descriptionRaw:descRaw}).municipality || null;}

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


function safeDurationFromStartEnd(startIso, endIso) {
  const startMs = startIso ? new Date(startIso).getTime() : NaN;
  const endMs = endIso ? new Date(endIso).getTime() : NaN;
  const nowMs = Date.now();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (endMs > nowMs + FUTURE_END_TOLERANCE_MS) return null;

  const dur = Math.round((endMs - startMs) / 60000);
  if (!Number.isFinite(dur) || dur <= 0 || dur > MAX_DURATION_MINUTES) return null;
  return dur;
}

function eventStartIsoFromEspRss(it = {}, times = {}) {
  // Legacy ESP compatibility only; RSS uses a separately proven start.
  return normalizeFeedTimestamp(it.pubDate || it.pub_date || it.startTimeIso || it.start_time_iso || times?.startIso);
}




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



export const geocoder=createGeocoder({getCache:getGeoCache,setCache:setGeoCache,reserve:reserveGeocodeRequest,endpoint:process.env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search',userAgent:process.env.GEOCODE_UA || 'FireWatchCZ/1.1 (https://firewatchcz.cz/)'});
let geocodeJobsActive=false;
const geocodeJobs=createGeocodeJobs({lookup:(...args)=>geocoder.lookup(...args),getEvent:getEventById,apply:applyGeoProposal,recordFailure:recordGeoFailure,onError:()=>console.warn('[geocode] background_lookup_failed')});


function parseFilters(req) {
  const typeQ = String(req.query.type || "").trim();
  const types = typeQ ? typeQ.split(",").map(s => s.trim()).filter(Boolean) : [];
  const city = String(req.query.city || "").trim();
  const status = String(req.query.status || "all").trim();
  const day = String(req.query.day || "all").trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const month = String(req.query.month || "").trim();
  const source = String(req.query.source || "all").trim();
  const validDate = value => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  const customInvalid = day === 'custom' && (!from || !to || from > to || (Date.parse(to)-Date.parse(from)) > 366*86400000);
  if(types.length>10||types.some(value=>value.length>64)||city.length>120||!['all','open','closed'].includes(status)||!['all','today','yesterday','last7','last30','custom'].includes(day)||!validDate(from)||!validDate(to)||customInvalid||!['all','stredocesky','praha','pardubicky'].includes(source)|| (month && (!/^\d{4}-\d{2}$/.test(month)||Number(month.slice(5))<1||Number(month.slice(5))>12))) {const error=new Error('bad_filters');error.status=400;throw error;}
  return { types, city, status, day, from, to, month, source };
}

function exportFiltersLabel(filters) {
  const dayLabel = filters.day === "today"
    ? "dnes"
    : filters.day === "yesterday"
      ? "včera"
      : filters.day === "last7" ? "posledních 7 dní"
      : filters.day === "last30" ? "posledních 30 dní"
      : filters.day === "custom" ? `${filters.from} až ${filters.to}` : "vše";

  const statusLabel = filters.status === "open"
    ? "aktivní"
    : filters.status === "closed"
      ? "ukončené"
      : "vše";

  const typeLabelText = filters.types?.length
    ? filters.types.map(t => typeLabel(t)).join(", ")
    : "vše";

  const cityLabel = filters.city || "vše";

  const sourceLabel = filters.source === 'praha' ? 'Praha' : filters.source === 'pardubicky' ? 'Pardubický kraj' : filters.source === 'stredocesky' ? 'Středočeský kraj' : 'vše';
  return `Den: ${dayLabel} | Typ: ${typeLabelText} | Město: ${cityLabel} | Stav: ${statusLabel} | Zdroj: ${sourceLabel}`;
}


// ======================
// Archived analytical reports
// ======================

function isoDateOnly(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function startOfIsoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d;
}

function reportPeriodFromKey(type, key) {
  const t = String(type || "").trim();
  const k = String(key || "").trim();

  if (t === "month") {
    if (!/^\d{4}-\d{2}$/.test(k)) throw new Error("bad_period");
    const [y, m] = k.split("-").map(Number);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) throw new Error("bad_period");
    const start = new Date(Date.UTC(y, m - 1, 1));
    const endExclusive = new Date(Date.UTC(y, m, 1));
    return {
      type: t,
      key: k,
      start,
      endExclusive,
      startIso: isoDateOnly(start),
      endIso: isoDateOnly(addDays(endExclusive, -1)),
      endExclusiveIso: isoDateOnly(endExclusive)
    };
  }

  if (t === "week") {
    if (!/^\d{4}-W\d{2}$/.test(k)) throw new Error("bad_period");
    const [yStr, wStr] = k.split("-W");
    const y = Number(yStr);
    const w = Number(wStr);
    if (y < 2000 || y > 2100 || w < 1 || w > 53) throw new Error("bad_period");
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const week1 = startOfIsoWeek(jan4);
    const start = addDays(week1, (w - 1) * 7);
    if (isoWeekKey(start) !== k) throw new Error("bad_period");
    const endExclusive = addDays(start, 7);
    return {
      type: t,
      key: k,
      start,
      endExclusive,
      startIso: isoDateOnly(start),
      endIso: isoDateOnly(addDays(endExclusive, -1)),
      endExclusiveIso: isoDateOnly(endExclusive)
    };
  }

  if (t === "day") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) throw new Error("bad_period");
    const start = new Date(`${k}T00:00:00.000Z`);
    if (!Number.isFinite(start.getTime()) || isoDateOnly(start) !== k || start.getUTCFullYear() < 2000 || start.getUTCFullYear() > 2100) throw new Error("bad_period");
    const endExclusive = addDays(start, 1);
    return {
      type: t,
      key: k,
      start,
      endExclusive,
      startIso: isoDateOnly(start),
      endIso: isoDateOnly(start),
      endExclusiveIso: isoDateOnly(endExclusive)
    };
  }

  throw new Error("bad_period_type");
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function reportPeriodLabel(type, key) {
  try {
    const p = reportPeriodFromKey(type, key);
    if (type === "month") {
      const [y, m] = key.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("cs-CZ", { month: "long", year: "numeric", timeZone: "UTC" });
    }
    if (type === "week") return `${new Date(p.startIso).toLocaleDateString("cs-CZ", { timeZone: "UTC" })}–${new Date(p.endIso).toLocaleDateString("cs-CZ", { timeZone: "UTC" })}`;
    if (type === "day") return new Date(`${key}T00:00:00Z`).toLocaleDateString("cs-CZ", { timeZone: "UTC" });
  } catch {}
  return key;
}

function reportTypeLabel(type) {
  return typeLabel(type || "other");
}

function safePercent(part, total) {
  if (!total) return 0;
  return Math.round((Number(part || 0) / Number(total || 1)) * 1000) / 10;
}

function eventDayKey(ev) {
  const d = new Date(ev.pub_date || ev.created_at || Date.now());
  if (Number.isNaN(d.getTime())) return "neznámé datum";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function formatMinutesLong(min) {
  const n = Number(min || 0);
  if (!n) return "0 min";
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  if (!h) return `${m} min`;
  return `${h} h ${m} min`;
}

function buildAnalyticalReport(type, key, rows) {
  const p = reportPeriodFromKey(type, key);
  rows=rows.map(annotateEventTime).map(row=>({...row,duration_min:row.duration_is_estimate?null:row.duration_min}));
  const total = rows.length;
  const open = rows.filter(r => !r.is_closed).length;
  const closed = rows.filter(r => !!r.is_closed).length;
  const missingCoords = rows.filter(r => !annotateEventGeo(r).geo_reliable).length;
  const jpoEvents = rows.filter(r => r.is_jpo_event !== false).length;
  const otherCrisisEvents = rows.filter(r => r.is_jpo_event === false).length;

  const byType = new Map();
  const byCity = new Map();
  const byDay = new Map();
  const byStatusType = new Map();

  for (const r of rows) {
    const typ = reportTypeLabel(r.event_type || "other");
    byType.set(typ, (byType.get(typ) || 0) + 1);

    if (!byStatusType.has(typ)) byStatusType.set(typ, { active: 0, closed: 0 });
    if (r.is_closed) byStatusType.get(typ).closed++;
    else byStatusType.get(typ).active++;

    const city = String(r.city_text || r.place_text || "Neznámé místo").trim() || "Neznámé místo";
    byCity.set(city, (byCity.get(city) || 0) + 1);

    const day = eventDayKey(r);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  const sortDesc = (a, b) => Number(b.count || 0) - Number(a.count || 0);

  const typeStats = [...byType.entries()].map(([name, count]) => ({
    name,
    count,
    percent: safePercent(count, total),
    active: byStatusType.get(name)?.active || 0,
    closed: byStatusType.get(name)?.closed || 0
  })).sort(sortDesc);

  const topCities = [...byCity.entries()].map(([name, count]) => ({
    name,
    count,
    percent: safePercent(count, total)
  })).sort(sortDesc).slice(0, 25);

  const byDayArr = [...byDay.entries()].map(([day, count]) => ({ day, count }))
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));

  const busiestDays = [...byDayArr].sort(sortDesc).slice(0, 10);

  const longest = rows
    .filter(r => Number(r.duration_min || 0) > 0)
    .sort((a, b) => Number(b.duration_min || 0) - Number(a.duration_min || 0))
    .slice(0, 20)
    .map(r => ({
      id: r.id,
      title: r.title || "",
      city: r.city_text || r.place_text || "",
      type: reportTypeLabel(r.event_type || "other"),
      duration_min: Number(r.duration_min || 0),
      duration_text: formatMinutesLong(r.duration_min),
      date: eventDayKey(r),
      link: r.link || ""
    }));

  const importantEvents = rows
    .filter(r => !r.is_closed || Number(r.duration_min || 0) >= 120)
    .slice(0, 30)
    .map(r => ({
      id: r.id,
      title: r.title || "",
      city: r.city_text || r.place_text || "",
      type: reportTypeLabel(r.event_type || "other"),
      is_closed: !!r.is_closed,
      duration_min: Number(r.duration_min || 0),
      duration_text: formatMinutesLong(r.duration_min),
      date: eventDayKey(r),
      link: r.link || ""
    }));

  const periodDays = Math.max(1, Math.round((p.endExclusive - p.start) / 86400000));
  const avgPerDay = Math.round((total / periodDays) * 10) / 10;

  let summary = "Za vybrané období nebyly nalezeny žádné události.";
  if (total > 0) {
    const topType = typeStats[0];
    const topCity = topCities[0];
    const busiest = busiestDays[0];
    summary = `Za období bylo evidováno ${total} událostí. Nejčastější typ: ${topType?.name || "—"} (${topType?.count || 0}). Nejvíce událostí bylo v lokalitě ${topCity?.name || "—"} (${topCity?.count || 0}). Nejvytíženější den: ${busiest?.day ? new Date(busiest.day+"T00:00:00Z").toLocaleDateString("cs-CZ",{timeZone:"UTC"}) : "—"} (${busiest?.count || 0}).`;
  }

  const titlePrefix = type === "month" ? "Měsíční" : type === "week" ? "Týdenní" : "Denní";
  const regionalComparison = buildRegionComparison(rows, [], { start: p.startIso, end: p.endExclusiveIso, sourceStatus: {} });

  return {
    period_type: type,
    period_key: key,
    period_start: p.startIso,
    period_end: p.endIso,
    title: `${titlePrefix} analytický souhrn – ${reportPeriodLabel(type, key)}`,
    total_events: total,
    open_count: open,
    closed_count: closed,
    missing_coords_count: missingCoords,
    data_json: {
      period_type: type,
      period_key: key,
      period_label: reportPeriodLabel(type, key),
      generated_at: new Date().toISOString(),
      summary,
      total_events: total,
      open_count: open,
      closed_count: closed,
      missing_coords_count: missingCoords,
      jpo_events: jpoEvents,
      other_crisis_events: otherCrisisEvents,
      avg_per_day: avgPerDay,
      type_stats: typeStats,
      top_cities: topCities,
      by_day: byDayArr,
      busiest_days: busiestDays,
      longest,
      important_events: importantEvents,
      region_comparison: regionalComparison,
      notes: [
        "Souhrn je archivní snapshot vytvořený z dat dostupných v době generování.",
        "Údaje mají orientační a analytický charakter."
      ]
    }
  };
}

async function generateArchivedReport(type, key, { force = false } = {}) {
  const p = reportPeriodFromKey(type, key);
  if (p.startIso > todayPragueISO()) throw new Error("future_period");
  const existing = await getArchivedReport(type, key);
  if (existing && !force) return existing;

  const rows = await getEventsForPeriod(p.startIso, p.endExclusiveIso);
  const report = buildAnalyticalReport(type, key, rows);
  return await upsertArchivedReport(report);
}

function reportJson(row) {
  const data = row?.data_json || {};
  return {
    id: row.id,
    period_type: row.period_type,
    period_key: row.period_key,
    period_start: isoDateOnly(row.period_start),
    period_end: isoDateOnly(row.period_end),
    title: row.title,
    total_events: row.total_events,
    open_count: row.open_count,
    closed_count: row.closed_count,
    missing_coords_count: row.missing_coords_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    data
  };
}

function reportKeysToEnsure(date = new Date()) {
  const today = pragueTodayUtcMidnight(date);

  const yesterday = addDays(today, -1);
  const lastWeekDate = addDays(startOfIsoWeek(today), -1);
  const lastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));

  return [
    { type: "day", key: isoDateOnly(yesterday) },
    { type: "week", key: isoWeekKey(lastWeekDate) },
    { type: "month", key: `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, "0")}` }
  ];
}

let archivedReportsAutomationRunning = false;

async function runArchivedReportsAutomation(reason = "interval") {
  if (archivedReportsAutomationRunning) return;
  archivedReportsAutomationRunning = true;

  try {
    for (const item of reportKeysToEnsure()) {
      const existing = await getArchivedReport(item.type, item.key);
      if (!existing) {
        const rep = await generateArchivedReport(item.type, item.key, { force: false });
        console.log(`[report-archive] generated ${rep.period_type}:${rep.period_key} (${reason})`);
      }
    }
  } catch (e) {
    console.warn("[report-archive] automation failed:", e?.message || e);
  } finally {
    archivedReportsAutomationRunning = false;
  }
}



function pragueTodayUtcMidnight(date = new Date()) {
  const key = pragueDateKey(date);
  return new Date(`${key}T00:00:00.000Z`);
}

function formatReportDateCs(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || "");
  return d.toLocaleDateString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Prague"
  });
}

function formatReportDateTimeCs(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || "");
  return d.toLocaleString("cs-CZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Prague"
  });
}

function pdfSafeText(value, fallback = "—") {
  const clean = String(value ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return clean || fallback;
}

function drawProfessionalReportPdf(doc, row) {
  const report = reportJson(row), data = report.data || {};
  tryApplyPdfFont(doc);
  const colors = {navy:"#0b1f33",blue:"#2563a8",orange:"#d97706",ink:"#172033",muted:"#596579",line:"#d9e0e8",soft:"#f4f7fa",white:"#ffffff"};
  const left=42, right=doc.page.width-42, width=right-left, contentBottom=doc.page.height-82;
  const generated=formatReportDateTimeCs(data.generated_at || report.created_at || Date.now());
  const period=report.period_start===report.period_end?formatReportDateCs(report.period_start):`${formatReportDateCs(report.period_start)} – ${formatReportDateCs(report.period_end)}`;
  const reportKind=report.period_type==="month"?"Měsíční":report.period_type==="week"?"Týdenní":"Denní";
  let y=42;
  const setY=value=>{y=value;doc.y=value;};
  const addPage=()=>{doc.addPage();doc.rect(0,0,doc.page.width,7).fill(colors.blue);doc.fontSize(9).fillColor(colors.muted).text(`FIREWATCH CZ · ${reportKind} analytický souhrn`,left,28,{width,lineBreak:false});setY(55);};
  const ensure=height=>{if(y+height>contentBottom)addPage();};
  const heading=title=>{ensure(35);doc.fontSize(13).fillColor(colors.navy).text(pdfSafeText(title),left,y,{width});y=doc.y+8;doc.moveTo(left,y-3).lineTo(right,y-3).strokeColor(colors.line).lineWidth(.7).stroke();};
  const empty=text=>{ensure(28);doc.fontSize(9).fillColor(colors.muted).text(text,left,y,{width});y=doc.y+10;};
  const table=(rows,columns,{maxRows=50}={})=>{
    const list=(Array.isArray(rows)?rows:[]).slice(0,maxRows);
    const headerH=22;
    const drawHeader=()=>{ensure(headerH+20);doc.rect(left,y,width,headerH).fill(colors.navy);for(const c of columns)doc.fontSize(7.5).fillColor(colors.white).text(c.label,left+c.x,y+7,{width:c.w,align:c.align||"left",lineBreak:false});y+=headerH;};
    if(!list.length){empty("Pro tuto část nejsou dostupná data.");return;}
    drawHeader();
    list.forEach((row,index)=>{
      const values=columns.map(c=>pdfSafeText(typeof c.value==="function"?c.value(row):row[c.value]));
      const heights=columns.map((c,i)=>doc.fontSize(7.5).heightOfString(values[i],{width:c.w,lineGap:1}));
      const rowH=Math.max(21,Math.min(46,Math.max(...heights)+10));
      if(y+rowH>contentBottom){addPage();drawHeader();}
      if(index%2===0)doc.rect(left,y,width,rowH).fill(colors.soft);
      columns.forEach((c,i)=>doc.fontSize(7.5).fillColor(colors.ink).text(values[i],left+c.x,y+5,{width:c.w,height:rowH-8,ellipsis:true,lineGap:1,align:c.align||"left"}));
      doc.moveTo(left,y+rowH).lineTo(right,y+rowH).strokeColor(colors.line).lineWidth(.35).stroke();y+=rowH;
    });
    y+=12;
  };
  const barChart=(title,items)=>{
    heading(title);const list=(items||[]).slice(0,8),max=Math.max(1,...list.map(v=>Number(v.count||0)));
    if(!list.length){empty("Bez dat pro graf.");return;}
    for(const item of list){ensure(25);doc.fontSize(7.5).fillColor(colors.ink).text(pdfSafeText(item.name||item.day),left,y,{width:165,height:12,ellipsis:true});doc.rect(left+170,y+1,width-205,9).fill(colors.soft);doc.rect(left+170,y+1,(width-205)*(Number(item.count||0)/max),9).fill(colors.blue);doc.fontSize(7.5).fillColor(colors.ink).text(String(Number(item.count||0)),right-28,y,{width:28,align:"right",lineBreak:false});y+=20;}y+=5;
  };

  doc.rect(0,0,doc.page.width,10).fill(colors.orange);
  doc.rect(0,10,doc.page.width,112).fill(colors.navy);
  const logo=path.join(__dirname,"public","logo-firewatch-cz.png");
  if(fs.existsSync(logo)){try{doc.image(logo,left,28,{fit:[55,55]});}catch{}}
  doc.fontSize(23).fillColor(colors.white).text("FireWatch CZ",left+68,30,{width:width-68});
  doc.fontSize(14).fillColor("#d9e9f8").text("Analytický souhrn zásahů JPO",left+68,61,{width:width-68});
  doc.fontSize(8.5).fillColor(colors.white).text(`${reportKind} report · ${period} · vytvořeno ${generated}`,left+68,86,{width:width-68});
  doc.roundedRect(right-160,28,160,34,4).strokeColor("#7aa2c8").lineWidth(.8).stroke();
  doc.fontSize(7.5).fillColor("#f4c078").text("NEOFICIÁLNÍ ANALYTICKÝ VÝSTUP",right-153,37,{width:146,align:"center"});
  doc.fontSize(6.5).fillColor("#c8d8e8").text("VYGENEROVÁNO SYSTÉMEM FIREWATCH CZ",right-153,50,{width:146,align:"center"});
  setY(142);
  doc.fontSize(10).fillColor(colors.ink).text(pdfSafeText(data.summary,"Za vybrané období nejsou dostupná data."),left,y,{width,lineGap:3});y=doc.y+16;
  doc.fontSize(8.5).fillColor(colors.muted).text(`Zásahy HZS/JPO: ${Number(data.jpo_events ?? report.total_events ?? 0)} · ostatní krizové události: ${Number(data.other_crisis_events||0)}`,left,y,{width});y=doc.y+14;

  const cards=[{label:"Celkem",value:report.total_events},{label:"Aktivní",value:report.open_count},{label:"Ukončené",value:report.closed_count},{label:"Bez ověřené GPS",value:report.missing_coords_count}];
  const gap=9,cardW=(width-gap*3)/4,cardH=57;ensure(cardH+16);
  cards.forEach((card,i)=>{const x=left+i*(cardW+gap);doc.roundedRect(x,y,cardW,cardH,6).fillAndStroke(i===0?"#eef5fc":colors.soft,colors.line);doc.fontSize(7.5).fillColor(colors.muted).text(card.label,x+10,y+10,{width:cardW-20});doc.fontSize(20).fillColor(i===0?colors.blue:colors.navy).text(String(Number(card.value||0)),x+10,y+27,{width:cardW-20});});y+=cardH+18;
  barChart("Rozdělení podle typů",data.type_stats);
  heading("Nejčastější lokality");
  table((data.top_cities||[]).slice(0,10),[{label:"Lokalita",x:0,w:width-100,value:"name"},{label:"Počet",x:width-90,w:45,value:"count",align:"right"},{label:"Podíl",x:width-42,w:42,value:r=>`${Number(r.percent||0)} %`,align:"right"}],{maxRows:10});
  heading("Nejvytíženější období");
  table((data.busiest_days||[]).slice(0,10),[{label:"Datum",x:0,w:180,value:r=>formatReportDateCs(r.day)},{label:"Počet událostí",x:190,w:120,value:"count",align:"right"}],{maxRows:10});
  heading("Nejdelší ověřené ukončené zásahy");
  table(data.longest,[{label:"Datum",x:0,w:66,value:r=>formatReportDateCs(r.date)},{label:"Délka",x:72,w:62,value:"duration_text"},{label:"Typ",x:140,w:95,value:"type"},{label:"Lokalita",x:241,w:90,value:"city"},{label:"Událost",x:337,w:width-337,value:"title"}],{maxRows:15});
  heading("Významné nebo otevřené události");
  table(data.important_events,[{label:"Datum",x:0,w:66,value:r=>formatReportDateCs(r.date)},{label:"Stav",x:72,w:58,value:r=>r.is_closed?"ukončená":"probíhá"},{label:"Typ",x:136,w:92,value:"type"},{label:"Lokalita",x:234,w:88,value:"city"},{label:"Událost",x:328,w:width-328,value:"title"}],{maxRows:20});

  const regional=data.region_comparison;
  if(regional?.regions?.length){ensure(215);heading("Porovnání krajů");empty(regional.disclaimer);table(regional.regions,[{label:"Kraj",x:0,w:145,value:"name"},{label:"Události",x:151,w:55,value:r=>r.all.total,align:"right"},{label:"HZS/JPO",x:212,w:55,value:r=>r.jpo.total,align:"right"},{label:"Aktivní",x:273,w:52,value:r=>r.all.open,align:"right"},{label:"Ověřená GPS",x:331,w:72,value:r=>`${r.all.verified_gps_percent} %`,align:"right"},{label:"Stanice",x:409,w:width-409,value:r=>r.station_data_available?"data dostupná":"Databáze stanic pro tento kraj není v systému zatím dostupná."}],{maxRows:3});}

  ensure(50);doc.roundedRect(left,y,width,38,5).strokeColor(colors.orange).lineWidth(.8).stroke();doc.fontSize(8).fillColor(colors.navy).text("NEOFICIÁLNÍ ANALYTICKÝ VÝSTUP · VYGENEROVÁNO SYSTÉMEM FIREWATCH CZ",left+10,y+9,{width:width-20,align:"center"});doc.fontSize(7).fillColor(colors.muted).text("Výstup slouží pouze k informativním a analytickým účelům.",left+10,y+23,{width:width-20,align:"center"});

  const range=doc.bufferedPageRange(),total=range.count,disclaimer="FireWatch CZ není oficiální systém HZS ČR, JPO ani IZS. Údaje mají informativní a analytický charakter.";
  for(let index=range.start;index<range.start+range.count;index++){
    doc.switchToPage(index);const oldBottom=doc.page.margins.bottom;doc.page.margins.bottom=0;
    doc.save();doc.fillColor(colors.navy).opacity(.04).fontSize(48).rotate(-32,{origin:[doc.page.width/2,doc.page.height/2]}).text("FIREWATCH CZ",95,doc.page.height/2-25,{width:405,align:"center",lineBreak:false});doc.restore();
    const footerTop=doc.page.height-67;doc.moveTo(left,footerTop).lineTo(right,footerTop).strokeColor(colors.line).lineWidth(.6).stroke();
    doc.fontSize(6.2).fillColor(colors.muted).text(disclaimer,left,footerTop+7,{width,align:"center",lineBreak:false});
    doc.fontSize(6.5).fillColor(colors.muted).text(`firewatchcz.cz · ${reportKind.toLowerCase()} report ${pdfSafeText(report.period_key)} · ${generated} · ID ${report.id}`,left,footerTop+22,{width:width-85,lineBreak:false});
    doc.text(`Strana ${index-range.start+1} / ${total}`,right-80,footerTop+22,{width:80,align:"right",lineBreak:false});doc.page.margins.bottom=oldBottom;
  }
}

const REGION_COMPARISON = Object.freeze([
  { source: "stredocesky", name: "Středočeský kraj" },
  { source: "praha", name: "Hlavní město Praha" },
  { source: "pardubicky", name: "Pardubický kraj" }
]);

function comparisonEventTime(row) {
  return row.source_updated_at || row.pub_date || row.start_time_iso || row.first_seen_at || row.created_at;
}

function aggregateRegionRows(rows, source, periodDays) {
  const selected = rows.filter(row => row.source === source);
  const byType = new Map(), byDay = new Map(), byHour = new Map(), byLocation = new Map();
  let open = 0, closed = 0, unknown = 0, verifiedGps = 0, jpo = 0;
  for (const row of selected) {
    if (row.is_jpo_event !== false) jpo++;
    if (["unknown", "source_estimated_unknown", null, undefined, ""].includes(row.status_source)) unknown++;
    else if (row.is_closed) closed++;
    else open++;
    if (annotateEventGeo(row).geo_reliable) verifiedGps++;
    const type = reportTypeLabel(row.event_type || "other");
    byType.set(type, (byType.get(type) || 0) + 1);
    const instant = new Date(comparisonEventTime(row));
    if (!Number.isNaN(instant.getTime())) {
      const day = pragueDateKey(instant);
      const hour = new Intl.DateTimeFormat("cs-CZ", { timeZone: "Europe/Prague", hour: "2-digit", hourCycle: "h23" }).format(instant);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      byHour.set(hour, (byHour.get(hour) || 0) + 1);
    }
    const location = String(row.district_text || row.city_text || row.place_text || "Neznámá lokalita").trim();
    byLocation.set(location || "Neznámá lokalita", (byLocation.get(location || "Neznámá lokalita") || 0) + 1);
  }
  const descending = map => [...map.entries()].map(([name, count]) => ({ name, count })).sort((a,b) => b.count-a.count || a.name.localeCompare(b.name, "cs"));
  const types = descending(byType);
  const days = [...byDay.entries()].map(([day,count]) => ({day,count})).sort((a,b)=>a.day.localeCompare(b.day));
  const busiest = [...days].sort((a,b)=>b.count-a.count || a.day.localeCompare(b.day))[0] || null;
  return {
    total: selected.length, jpo, other: selected.length-jpo, open, closed, unknown,
    verified_gps: verifiedGps, missing_gps: selected.length-verifiedGps,
    verified_gps_percent: safePercent(verifiedGps, selected.length),
    avg_per_day: Math.round((selected.length / Math.max(1, periodDays))*10)/10,
    top_type: types[0] || null, types, days,
    hours: [...byHour.entries()].map(([hour,count])=>({hour,count})).sort((a,b)=>a.hour.localeCompare(b.hour)),
    busiest_day: busiest,
    top_locations: descending(byLocation).slice(0,8)
  };
}

function buildRegionComparison(currentRows, previousRows, { start, end, sourceStatus = {} } = {}) {
  const endExclusive = new Date(end);
  const periodMs = Math.max(86400000, endExclusive.getTime() - new Date(start).getTime());
  const periodDays = Math.max(1, Math.round(periodMs / 86400000));
  const endInclusive = new Date(endExclusive.getTime() - 86400000).toISOString().slice(0, 10);
  const regions = REGION_COMPARISON.map(region => {
    const all = aggregateRegionRows(currentRows, region.source, periodDays);
    const previousAll = aggregateRegionRows(previousRows, region.source, periodDays);
    const currentJpoRows = currentRows.filter(row => row.source === region.source && row.is_jpo_event !== false);
    const previousJpoRows = previousRows.filter(row => row.source === region.source && row.is_jpo_event !== false);
    const jpo = aggregateRegionRows(currentJpoRows, region.source, periodDays);
    const previousJpo = aggregateRegionRows(previousJpoRows, region.source, periodDays);
    const change = (value, previous) => previous ? Math.round(((value-previous)/previous)*1000)/10 : (value ? null : 0);
    all.change_percent = change(all.total, previousAll.total);
    jpo.change_percent = change(jpo.total, previousJpo.total);
    return { ...region, all, jpo, last_successful_import: sourceStatus[region.source] || null, station_data_available: region.source === "stredocesky" };
  });
  return {
    period: { start, end: endInclusive, end_exclusive: end, days: periodDays }, regions,
    disclaimer: "Jednotlivé kraje používají rozdílné zdroje a rozsah zveřejňovaných údajů. Hodnoty proto představují evidované události ve FireWatch CZ, nikoliv úplnou oficiální statistiku HZS ČR."
  };
}


// ======================
// FireWatchCZ Web v1.5 – Statistiky PRO
// ======================

function startOfMonthUtc(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonthsUtc(date, months) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function startOfWeekUtc(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d;
}

function addDaysUtc(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function periodPresetRange(preset) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (preset === "week") {
    const currentStart = startOfWeekUtc(today);
    const currentEnd = addDaysUtc(currentStart, 7);
    const previousStart = addDaysUtc(currentStart, -7);
    const previousEnd = currentStart;
    return { currentStart, currentEnd, previousStart, previousEnd, label: "tento týden vs minulý týden" };
  }

  if (preset === "lastMonth") {
    const currentStart = addMonthsUtc(startOfMonthUtc(today), -1);
    const currentEnd = startOfMonthUtc(today);
    const previousStart = addMonthsUtc(currentStart, -1);
    const previousEnd = currentStart;
    return { currentStart, currentEnd, previousStart, previousEnd, label: "minulý měsíc vs předchozí měsíc" };
  }

  const currentStart = startOfMonthUtc(today);
  const currentEnd = addMonthsUtc(currentStart, 1);
  const previousStart = addMonthsUtc(currentStart, -1);
  const previousEnd = currentStart;
  return { currentStart, currentEnd, previousStart, previousEnd, label: "tento měsíc vs minulý měsíc" };
}

function dateOnlyIso(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function eventTimeValue(ev, fallback = Date.now()) {
  return ev?.pub_date || ev?.start_time_iso || ev?.created_at || ev?.first_seen_at || fallback;
}

function pragueDateKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;
  return y && m && day ? `${y}-${m}-${day}` : d.toISOString().slice(0, 10);
}

function pragueHour(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 0;
  const h = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    hour12: false
  }).format(d);
  const n = Number(String(h).replace(/\D/g, ""));
  return Number.isFinite(n) ? Math.max(0, Math.min(23, n)) : 0;
}

function eventDayKeyForStats(ev) {
  return pragueDateKey(eventTimeValue(ev));
}

function hourFromEvent(ev) {
  return pragueHour(eventTimeValue(ev));
}

function typeNameForStats(ev) {
  return typeLabel(ev.event_type || "other");
}

function cityNameForStats(ev) {
  return String(ev.city_text || ev.place_text || "Neznámé místo").trim() || "Neznámé místo";
}

function countBy(items, fn) {
  const map = new Map();
  for (const item of items) {
    const key = fn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function mapToSortedList(map, limit = 20) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), "cs"))
    .slice(0, limit);
}

function compareCounts(currentMap, previousMap, limit = 20) {
  const names = new Set([...currentMap.keys(), ...previousMap.keys()]);
  return [...names].map(name => {
    const current = currentMap.get(name) || 0;
    const previous = previousMap.get(name) || 0;
    const diff = current - previous;
    const percent = previous > 0 ? Math.round((diff / previous) * 1000) / 10 : (current > 0 ? 100 : 0);
    return { name, current, previous, diff, percent };
  }).sort((a, b) => b.diff - a.diff || b.current - a.current).slice(0, limit);
}

function buildHourStats(items) {
  const arr = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const ev of items) arr[hourFromEvent(ev)].count++;
  return arr;
}

function buildHeatmap(items, start, end) {
  const dayMap = countBy(items, ev => eventDayKeyForStats(ev) || dateOnlyIso(start));
  const out = [];
  let d = new Date(start);
  while (d < end) {
    const day = dateOnlyIso(d);
    out.push({ day, count: dayMap.get(day) || 0 });
    d = addDaysUtc(d, 1);
  }
  return out;
}

function buildStatsProPayload({ preset, currentRows, previousRows, range }) {
  const currentTotal = currentRows.length;
  const previousTotal = previousRows.length;
  const diff = currentTotal - previousTotal;
  const diffPercent = previousTotal > 0 ? Math.round((diff / previousTotal) * 1000) / 10 : (currentTotal > 0 ? 100 : 0);

  const currentTypes = countBy(currentRows, typeNameForStats);
  const previousTypes = countBy(previousRows, typeNameForStats);

  const currentCities = countBy(currentRows, cityNameForStats);
  const previousCities = countBy(previousRows, cityNameForStats);

  const open = currentRows.filter(r => !r.is_closed).length;
  const closed = currentRows.filter(r => !!r.is_closed).length;
  const missingCoords = currentRows.filter(r => !annotateEventGeo(r).geo_reliable).length;

  const hourStats = buildHourStats(currentRows);
  const busiestHour = [...hourStats].sort((a, b) => b.count - a.count)[0] || { hour: 0, count: 0 };

  const busiestDays = mapToSortedList(countBy(currentRows, ev => eventDayKeyForStats(ev)), 10)
    .map(x => ({ day: x.name, count: x.count }));

  return {
    preset,
    label: range.label,
    current: {
      start: dateOnlyIso(range.currentStart),
      end: dateOnlyIso(addDaysUtc(range.currentEnd, -1)),
      total: currentTotal,
      open,
      closed,
      missingCoords
    },
    previous: {
      start: dateOnlyIso(range.previousStart),
      end: dateOnlyIso(addDaysUtc(range.previousEnd, -1)),
      total: previousTotal
    },
    comparison: {
      diff,
      diffPercent
    },
    typeTrend: compareCounts(currentTypes, previousTypes, 12),
    cityGrowth: compareCounts(currentCities, previousCities, 15),
    topTypes: mapToSortedList(currentTypes, 12),
    topCities: mapToSortedList(currentCities, 15),
    hourStats,
    busiestHour,
    busiestDays,
    heatmap: buildHeatmap(currentRows, range.currentStart, range.currentEnd)
  };
}


// ======================
// FireWatchCZ Web v2.1 – Regionální počasí × události
// Zdroj počasí: Open-Meteo, regionální zóny Středočeského kraje
// ======================

const WEATHER_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.FIREWATCH_WEATHER_CACHE_TTL_MS || 45 * 60 * 1000));
const regionalWeatherCache = new Map();

const FIREWATCH_WEATHER_ZONES = [
  {
    id: "praha-vychod",
    name: "Praha-východ",
    lat: 50.1333,
    lon: 14.6667,
    aliases: ["praha-východ", "praha vychod", "brandýs nad labem", "brandys nad labem", "stará boleslav", "stara boleslav", "čelákovice", "celakovice", "nehvizdy", "říčany", "ricany", "úvaly", "uvaly", "klecany", "odolená voda", "odolena voda"]
  },
  {
    id: "praha-zapad",
    name: "Praha-západ",
    lat: 49.9833,
    lon: 14.3333,
    aliases: ["praha-západ", "praha zapad", "černošice", "cernosice", "hostivice", "roztoky", "dobřichovice", "dobrichovice", "mníšek pod brdy", "mnisek pod brdy", "rudná", "rudna", "jesenice"]
  },
  {
    id: "kladensko",
    name: "Kladensko",
    lat: 50.1431,
    lon: 14.1052,
    aliases: ["kladno", "slaný", "slany", "buštěhrad", "bustehrad", "velvary", "stochov", "unhošť", "unhost", "velké přílepy", "velke prilepy"]
  },
  {
    id: "melnik",
    name: "Mělnicko",
    lat: 50.3512,
    lon: 14.4746,
    aliases: ["mělník", "melnik", "kralupy nad vltavou", "neratovice", "mělnicko", "melniksko", "mšeno", "mseno", "veltrusy", "liběchov", "libechov"]
  },
  {
    id: "mlada-boleslav",
    name: "Mladoboleslavsko",
    lat: 50.4114,
    lon: 14.9032,
    aliases: ["mladá boleslav", "mlada boleslav", "kosmonosy", "mnichovo hradiště", "mnichovo hradiste", "dobrovice", "benátky nad jizerou", "benatky nad jizerou", "bělá pod bezdězem", "bela pod bezdezem"]
  },
  {
    id: "nymburk",
    name: "Nymbursko",
    lat: 50.1861,
    lon: 15.0417,
    aliases: ["nymburk", "poděbrady", "podebrady", "lysá nad labem", "lysa nad labem", "milovice", "sadská", "sadska", "libice nad cidlinou"]
  },
  {
    id: "kolin",
    name: "Kolínsko",
    lat: 50.0281,
    lon: 15.2016,
    aliases: ["kolín", "kolin", "český brod", "cesky brod", "pečky", "pecky", "kouřim", "kourim", "týnec nad labem", "tynec nad labem", "velim"]
  },
  {
    id: "kutna-hora",
    name: "Kutnohorsko",
    lat: 49.9484,
    lon: 15.2682,
    aliases: ["kutná hora", "kutna hora", "čáslav", "caslav", "zruč nad sázavou", "zruc nad sazavou", "uhlířské janovice", "uhlirske janovice", "nové dvory", "nove dvory"]
  },
  {
    id: "benesov",
    name: "Benešovsko",
    lat: 49.7816,
    lon: 14.6869,
    aliases: ["benešov", "benesov", "vlašim", "vlasim", "týnec nad sázavou", "tynec nad sazavou", "sázava", "sazava", "votice", "bystrice"]
  },
  {
    id: "pribram",
    name: "Příbramsko",
    lat: 49.6854,
    lon: 14.0104,
    aliases: ["příbram", "pribram", "dobříš", "dobris", "sedlčany", "sedlcany", "rožmitál pod třemšínem", "rozmital pod tremsinem", "nový knín", "novy knin"]
  },
  {
    id: "beroun",
    name: "Berounsko",
    lat: 49.9638,
    lon: 14.0720,
    aliases: ["beroun", "hořovice", "horovice", "králův dvůr", "kraluv dvur", "zruč", "zruc", "loděnice", "lodenice", "tetín", "tetin"]
  },
  {
    id: "rakovnik",
    name: "Rakovnicko",
    lat: 50.1037,
    lon: 13.7334,
    aliases: ["rakovník", "rakovnik", "nové strašecí", "nove straseci", "jesenice u rakovníka", "jesenice u rakovnika", "křivoklát", "krivoklat", "kněževes", "knezeves"]
  }
];

function fwRemoveDiacritics(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function fwWeatherNorm(value) {
  return fwRemoveDiacritics(String(value || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fwDistanceKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const toRad = (d) => Number(d) * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function weatherCodeLabel(code) {
  const c = Number(code);
  if ([0].includes(c)) return "jasno";
  if ([1, 2, 3].includes(c)) return "oblačno";
  if ([45, 48].includes(c)) return "mlha";
  if ([51, 53, 55, 56, 57].includes(c)) return "mrholení";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return "déšť";
  if ([71, 73, 75, 77, 85, 86].includes(c)) return "sněžení";
  if ([95, 96, 99].includes(c)) return "bouřky";
  return "neznámé";
}

function weatherEmoji(code) {
  const label = weatherCodeLabel(code);
  if (label === "jasno") return "☀️";
  if (label === "oblačno") return "⛅";
  if (label === "mlha") return "🌫️";
  if (label === "mrholení") return "🌦️";
  if (label === "déšť") return "🌧️";
  if (label === "sněžení") return "❄️";
  if (label === "bouřky") return "⛈️";
  return "🌡️";
}

function clampWeatherNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function assignEventToWeatherZone(ev) {
  const lat = Number(ev.lat);
  const lon = Number(ev.lon);

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    let best = FIREWATCH_WEATHER_ZONES[0];
    let bestDist = Infinity;
    for (const zone of FIREWATCH_WEATHER_ZONES) {
      const d = fwDistanceKm(lat, lon, zone.lat, zone.lon);
      if (d < bestDist) {
        best = zone;
        bestDist = d;
      }
    }
    return { zone: best, method: "gps", distanceKm: Math.round(bestDist * 10) / 10 };
  }

  const hay = fwWeatherNorm(`${ev.city_text || ""} ${ev.place_text || ""} ${ev.title || ""} ${ev.description_raw || ""}`);
  for (const zone of FIREWATCH_WEATHER_ZONES) {
    for (const alias of zone.aliases || []) {
      const a = fwWeatherNorm(alias);
      if (a && hay.includes(a)) return { zone, method: "alias", distanceKm: null };
    }
  }

  return { zone: FIREWATCH_WEATHER_ZONES[0], method: "fallback", distanceKm: null };
}

function weatherEventDateKey(ev) {
  const d = new Date(ev.pub_date || ev.created_at || ev.first_seen_at || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function weatherEventHour(ev) {
  const d = new Date(ev.pub_date || ev.created_at || ev.first_seen_at || Date.now());
  if (Number.isNaN(d.getTime())) return 12;
  return d.getHours();
}

function eventTypeBucketForWeather(ev) {
  const t = fwWeatherNorm(ev.event_type || "");
  const title = fwWeatherNorm(ev.title || "");

  if (t.includes("fire") || title.includes("pozar")) return "fire";
  if (t.includes("traffic") || title.includes("doprav") || title.includes("nehod")) return "traffic";
  if (t.includes("tech") || title.includes("technick") || title.includes("strom") || title.includes("voda")) return "tech";
  if (t.includes("rescue") || title.includes("zachran")) return "rescue";
  if (t.includes("false") || title.includes("plany")) return "false_alarm";
  return "other";
}

function avgOf(items, key) {
  const vals = items.map(x => Number(x?.[key])).filter(Number.isFinite);
  if (!vals.length) return 0;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function maxOf(items, key) {
  const vals = items.map(x => Number(x?.[key])).filter(Number.isFinite);
  if (!vals.length) return 0;
  return Math.round(Math.max(...vals) * 10) / 10;
}

function sumOf(items, key) {
  const vals = items.map(x => Number(x?.[key])).filter(Number.isFinite);
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) * 10) / 10;
}

function ratioText(current, base) {
  if (!base) return current > 0 ? "bez běžného srovnání" : "bez nárůstu";
  const pct = Math.round(((current - base) / base) * 100);
  if (pct > 0) return `+${pct} %`;
  return `${pct} %`;
}

function modeWeatherCode(items) {
  const m = new Map();
  for (const x of items) {
    const code = Number(x.weather_code);
    if (!Number.isFinite(code)) continue;
    m.set(code, (m.get(code) || 0) + 1);
  }
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : null;
}

function hourWindowLabel(hour) {
  const h = Number(hour);
  if (h >= 6 && h < 10) return "ráno";
  if (h >= 10 && h < 12) return "dopoledne";
  if (h >= 12 && h < 18) return "odpoledne";
  if (h >= 18 && h < 22) return "večer";
  return "noc";
}

function analyzeHourlyRisk(hourlyItems = []) {
  const windows = new Map();

  for (const item of hourlyItems) {
    const hour = Number(String(item.time || "").slice(11, 13));
    const win = hourWindowLabel(hour);
    if (!windows.has(win)) windows.set(win, []);
    windows.get(win).push(item);
  }

  const out = [];
  for (const [window, items] of windows.entries()) {
    const maxGust = maxOf(items, "wind_gusts_10m");
    const maxWind = maxOf(items, "wind_speed_10m");
    const rain = sumOf(items, "precipitation");
    const maxTemp = maxOf(items, "temperature_2m");
    const code = modeWeatherCode(items);
    const storm = items.some(x => [95, 96, 99].includes(Number(x.weather_code)));

    let score = 0;
    const impacts = [];
    const factors = [];

    if (maxGust >= 70) { score += 60; factors.push("velmi silné nárazy větru"); impacts.push("technické pomoci"); }
    else if (maxGust >= 50) { score += 40; factors.push("silné nárazy větru"); impacts.push("technické pomoci"); }
    else if (maxGust >= 40 || maxWind >= 30) { score += 20; factors.push("zvýšený vítr"); impacts.push("technické pomoci"); }

    if (rain >= 12) { score += 35; factors.push("výraznější srážky"); impacts.push("dopravní nehody"); }
    else if (rain >= 5) { score += 25; factors.push("déšť"); impacts.push("dopravní nehody"); }
    else if (rain >= 2) { score += 12; factors.push("slabší déšť"); impacts.push("doprava"); }

    if (storm) { score += 50; factors.push("bouřkový charakter"); impacts.push("technické pomoci"); }

    if (maxTemp >= 28 && rain <= 0.2 && maxGust >= 25) { score += 30; factors.push("teplo/sucho/vítr"); impacts.push("požáry porostu"); }
    else if (maxTemp >= 25 && rain <= 0.2) { score += 15; factors.push("teplo a minimum srážek"); impacts.push("požáry porostu"); }

    const uniqueImpacts = [...new Set(impacts)];
    const uniqueFactors = [...new Set(factors)];

    out.push({
      window,
      score: Math.min(100, score),
      level: score >= 76 ? "vysoké" : score >= 51 ? "střední" : score >= 26 ? "zvýšené" : "běžné",
      factors: uniqueFactors,
      impacts: uniqueImpacts,
      maxGustKmh: maxGust,
      maxWindKmh: maxWind,
      rainMm: Math.round(rain * 10) / 10,
      maxTemp: Math.round(maxTemp * 10) / 10,
      weatherCode: code,
      weatherLabel: weatherCodeLabel(code),
      weatherEmoji: weatherEmoji(code)
    });
  }

  const order = { "ráno": 1, "dopoledne": 2, "odpoledne": 3, "večer": 4, "noc": 5 };
  return out.sort((a, b) => (order[a.window] || 99) - (order[b.window] || 99));
}

function buildWeatherDayRows(hourly = {}) {
  const grouped = new Map();
  const times = hourly.time || [];

  for (let i = 0; i < times.length; i++) {
    const time = String(times[i] || "");
    const day = time.slice(0, 10);
    if (!day) continue;
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push({
      time,
      temperature_2m: hourly.temperature_2m?.[i],
      precipitation: hourly.precipitation?.[i],
      wind_speed_10m: hourly.wind_speed_10m?.[i],
      wind_gusts_10m: hourly.wind_gusts_10m?.[i],
      weather_code: hourly.weather_code?.[i],
      relative_humidity_2m: hourly.relative_humidity_2m?.[i]
    });
  }

  return [...grouped.entries()].map(([day, items]) => {
    const code = modeWeatherCode(items);
    const rain = sumOf(items, "precipitation");
    const wind = maxOf(items, "wind_speed_10m");
    const gust = maxOf(items, "wind_gusts_10m");
    const temp = avgOf(items, "temperature_2m");
    const humidity = avgOf(items, "relative_humidity_2m");
    const hourlyRisk = analyzeHourlyRisk(items);
    const maxRisk = [...hourlyRisk].sort((a, b) => b.score - a.score)[0] || null;

    return {
      day,
      avgTemp: temp,
      avgHumidity: humidity,
      rainMm: rain,
      maxWindKmh: wind,
      maxGustKmh: gust,
      weatherCode: code,
      weatherLabel: weatherCodeLabel(code),
      weatherEmoji: weatherEmoji(code),
      windy: gust >= 50 || wind >= 35,
      rainy: rain >= 3,
      storm: items.some(x => [95, 96, 99].includes(Number(x.weather_code))),
      dryWarm: rain <= 0.2 && temp >= 25,
      hourlyRisk,
      maxRisk
    };
  }).sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

function aggregateRegionalEvents(rows) {
  const zoneMap = new Map(FIREWATCH_WEATHER_ZONES.map(z => [z.id, {
    zoneId: z.id,
    zoneName: z.name,
    total: 0,
    fire: 0,
    traffic: 0,
    tech: 0,
    rescue: 0,
    false_alarm: 0,
    other: 0,
    assignedByGps: 0,
    assignedByAlias: 0,
    assignedByFallback: 0,
    byDay: new Map()
  }]));

  for (const ev of rows) {
    const assigned = assignEventToWeatherZone(ev);
    const zone = zoneMap.get(assigned.zone.id);
    if (!zone) continue;

    const bucket = eventTypeBucketForWeather(ev);
    const day = weatherEventDateKey(ev);

    zone.total++;
    zone[bucket] = (zone[bucket] || 0) + 1;

    if (assigned.method === "gps") zone.assignedByGps++;
    else if (assigned.method === "alias") zone.assignedByAlias++;
    else zone.assignedByFallback++;

    if (!zone.byDay.has(day)) {
      zone.byDay.set(day, {
        day,
        total: 0,
        fire: 0,
        traffic: 0,
        tech: 0,
        rescue: 0,
        false_alarm: 0,
        other: 0
      });
    }

    const d = zone.byDay.get(day);
    d.total++;
    d[bucket] = (d[bucket] || 0) + 1;
  }

  return zoneMap;
}

async function fetchOpenMeteoZoneWeather(zone) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(zone.lat));
  url.searchParams.set("longitude", String(zone.lon));
  url.searchParams.set("timezone", "Europe/Prague");
  url.searchParams.set("past_days", "31");
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m");
  url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m");

  const r = await fetchWithTimeout(url.toString(), {
    headers: { "User-Agent": "FireWatchCZ/2.1 regional-weather" }
  }, 12000);

  if (!r.ok) throw new Error(`weather_provider_http_${r.status}`);
  return await r.json();
}

async function fetchCachedZoneWeather(zone) {
  const key = `zone:${zone.id}`;
  const cached = regionalWeatherCache.get(key);
  if (cached && (Date.now() - cached.at) < WEATHER_CACHE_TTL_MS) {
    return { ...cached.data, _cached: true };
  }

  const data = await fetchOpenMeteoZoneWeather(zone);
  regionalWeatherCache.set(key, { at: Date.now(), data });
  return { ...data, _cached: false };
}

function buildZoneWeatherInsight(zone, weather, eventAgg) {
  const dailyWeather = buildWeatherDayRows(weather.hourly || {});
  const todayIso = new Date().toISOString().slice(0, 10);
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowIso = tomorrowDate.toISOString().slice(0, 10);

  const today = dailyWeather.find(x => x.day === todayIso) || dailyWeather[dailyWeather.length - 1] || null;
  const tomorrow = dailyWeather.find(x => x.day === tomorrowIso) || null;

  const eventDays = [...eventAgg.byDay.values()];
  const avgTotal = avgOf(eventDays, "total");
  const avgTech = avgOf(eventDays, "tech");
  const avgTraffic = avgOf(eventDays, "traffic");
  const avgFire = avgOf(eventDays, "fire");

  const windyDays = dailyWeather.filter(x => x.windy).map(x => ({ ...x, events: eventAgg.byDay.get(x.day) || {} }));
  const rainyDays = dailyWeather.filter(x => x.rainy).map(x => ({ ...x, events: eventAgg.byDay.get(x.day) || {} }));
  const dryDays = dailyWeather.filter(x => x.dryWarm).map(x => ({ ...x, events: eventAgg.byDay.get(x.day) || {} }));

  const current = weather.current || {};
  const currentCode = Number(current.weather_code || 0);
  const currentRisk = {
    score: 0,
    factors: [],
    impacts: []
  };

  const currentGust = Number(current.wind_gusts_10m || 0);
  const currentWind = Number(current.wind_speed_10m || 0);
  const currentRain = Number(current.precipitation || 0);
  const currentTemp = Number(current.temperature_2m || 0);

  if (currentGust >= 50 || currentWind >= 35) { currentRisk.score += 40; currentRisk.factors.push("vítr"); currentRisk.impacts.push("technické pomoci"); }
  else if (currentGust >= 40 || currentWind >= 30) { currentRisk.score += 20; currentRisk.factors.push("zvýšený vítr"); currentRisk.impacts.push("technické pomoci"); }

  if (currentRain >= 3) { currentRisk.score += 25; currentRisk.factors.push("déšť"); currentRisk.impacts.push("dopravní nehody"); }
  if ([95, 96, 99].includes(currentCode)) { currentRisk.score += 50; currentRisk.factors.push("bouřky"); currentRisk.impacts.push("technické pomoci"); }
  if (currentTemp >= 28 && currentRain <= 0.1 && currentWind >= 20) { currentRisk.score += 30; currentRisk.factors.push("teplo/sucho"); currentRisk.impacts.push("požáry porostu"); }

  currentRisk.score = Math.min(100, currentRisk.score);
  currentRisk.level = currentRisk.score >= 76 ? "vysoké" : currentRisk.score >= 51 ? "střední" : currentRisk.score >= 26 ? "zvýšené" : "běžné";
  currentRisk.factors = [...new Set(currentRisk.factors)];
  currentRisk.impacts = [...new Set(currentRisk.impacts)];

  const insights = [];

  if (windyDays.length) {
    const techAvg = avgOf(windyDays.map(x => x.events), "tech");
    insights.push({
      icon: "💨",
      title: "Vítr vs technické pomoci",
      text: `Ve větrných dnech: ${techAvg} technických pomocí/den. Běžný průměr v regionu: ${avgTech}. Změna: ${ratioText(techAvg, avgTech)}.`,
      level: techAvg > avgTech ? "warning" : "info"
    });
  }

  if (rainyDays.length) {
    const trafficAvg = avgOf(rainyDays.map(x => x.events), "traffic");
    insights.push({
      icon: "🌧️",
      title: "Déšť vs dopravní nehody",
      text: `V deštivých dnech: ${trafficAvg} dopravních nehod/den. Běžný průměr v regionu: ${avgTraffic}. Změna: ${ratioText(trafficAvg, avgTraffic)}.`,
      level: trafficAvg > avgTraffic ? "warning" : "info"
    });
  }

  if (dryDays.length) {
    const fireAvg = avgOf(dryDays.map(x => x.events), "fire");
    insights.push({
      icon: "🔥",
      title: "Sucho/teplo vs požáry",
      text: `V suchých teplejších dnech: ${fireAvg} požárů/den. Běžný průměr v regionu: ${avgFire}. Změna: ${ratioText(fireAvg, avgFire)}.`,
      level: fireAvg > avgFire ? "warning" : "info"
    });
  }

  if (!insights.length) {
    insights.push({
      icon: "🌡️",
      title: "Bez výrazné vazby",
      text: "V tomto regionu se zatím neukazuje výrazná vazba mezi počasím a počtem událostí.",
      level: "info"
    });
  }

  const todayRisk = today?.maxRisk || null;
  const tomorrowRisk = tomorrow?.maxRisk || null;

  return {
    zoneId: zone.id,
    zoneName: zone.name,
    lat: zone.lat,
    lon: zone.lon,
    cached: Boolean(weather._cached),
    current: {
      temp: Number(current.temperature_2m || 0),
      apparentTemp: Number(current.apparent_temperature || 0),
      humidity: Number(current.relative_humidity_2m || 0),
      rainMm: Number(current.precipitation || 0),
      windKmh: Number(current.wind_speed_10m || 0),
      gustKmh: Number(current.wind_gusts_10m || 0),
      weatherCode: currentCode,
      weatherLabel: weatherCodeLabel(currentCode),
      weatherEmoji: weatherEmoji(currentCode),
      risk: currentRisk
    },
    events: {
      total: eventAgg.total,
      fire: eventAgg.fire,
      traffic: eventAgg.traffic,
      tech: eventAgg.tech,
      rescue: eventAgg.rescue,
      false_alarm: eventAgg.false_alarm,
      other: eventAgg.other,
      assignedByGps: eventAgg.assignedByGps,
      assignedByAlias: eventAgg.assignedByAlias,
      assignedByFallback: eventAgg.assignedByFallback,
      avgTotal,
      avgTech,
      avgTraffic,
      avgFire
    },
    today: today ? {
      day: today.day,
      weatherEmoji: today.weatherEmoji,
      weatherLabel: today.weatherLabel,
      rainMm: today.rainMm,
      maxGustKmh: today.maxGustKmh,
      avgTemp: today.avgTemp,
      risk: todayRisk,
      hourlyRisk: today.hourlyRisk
    } : null,
    tomorrow: tomorrow ? {
      day: tomorrow.day,
      weatherEmoji: tomorrow.weatherEmoji,
      weatherLabel: tomorrow.weatherLabel,
      rainMm: tomorrow.rainMm,
      maxGustKmh: tomorrow.maxGustKmh,
      avgTemp: tomorrow.avgTemp,
      risk: tomorrowRisk,
      hourlyRisk: tomorrow.hourlyRisk
    } : null,
    insights,
    daily: dailyWeather.slice(-32).map(day => ({
      day: day.day,
      weatherEmoji: day.weatherEmoji,
      weatherLabel: day.weatherLabel,
      rainMm: day.rainMm,
      maxGustKmh: day.maxGustKmh,
      avgTemp: day.avgTemp,
      risk: day.maxRisk,
      events: eventAgg.byDay.get(day.day) || {
        total: 0,
        fire: 0,
        traffic: 0,
        tech: 0,
        rescue: 0,
        false_alarm: 0,
        other: 0
      }
    }))
  };
}

function buildRegionalWeatherSummary(zones) {
  const byWind = [...zones].sort((a, b) => Number(b.current?.gustKmh || 0) - Number(a.current?.gustKmh || 0))[0] || null;
  const byRain = [...zones].sort((a, b) => Number(b.current?.rainMm || 0) - Number(a.current?.rainMm || 0))[0] || null;
  const byEvents = [...zones].sort((a, b) => Number(b.events?.total || 0) - Number(a.events?.total || 0))[0] || null;
  const byRisk = [...zones].sort((a, b) => Number(b.current?.risk?.score || 0) - Number(a.current?.risk?.score || 0))[0] || null;
  const tomorrowRisk = [...zones].sort((a, b) => Number(b.tomorrow?.risk?.score || 0) - Number(a.tomorrow?.risk?.score || 0))[0] || null;

  const highRiskZones = zones.filter(z => Number(z.current?.risk?.score || 0) >= 51);

  let text = "V regionech Středočeského kraje není aktuálně výrazná meteorologická anomálie.";
  if (highRiskZones.length) {
    text = `Aktuálně je zvýšené/střední riziko v ${highRiskZones.length} regionech. Nejvýraznější oblast: ${byRisk?.zoneName || "—"}.`;
  } else if (byWind && Number(byWind.current?.gustKmh || 0) >= 40) {
    text = `Nejvýraznějším faktorem je vítr v oblasti ${byWind.zoneName}, nárazy okolo ${Math.round(byWind.current.gustKmh)} km/h.`;
  } else if (byRain && Number(byRain.current?.rainMm || 0) >= 1) {
    text = `Nejvýraznějším faktorem jsou srážky v oblasti ${byRain.zoneName}.`;
  }

  return {
    text,
    strongestWind: byWind,
    strongestRain: byRain,
    mostEvents: byEvents,
    highestRisk: byRisk,
    tomorrowHighestRisk: tomorrowRisk,
    highRiskZones: highRiskZones.map(z => z.zoneName)
  };
}

async function buildRegionalWeatherPayload(days = 30) {
  const now = new Date();
  const endIso=todayPragueISO();
  const start=new Date(endIso+"T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - days + 1);
  const startIso = start.toISOString().slice(0, 10);

  const events = await getEventsForPeriod(startIso, new Date(new Date(endIso+"T00:00:00Z").getTime()+86400000).toISOString().slice(0,10));
  const eventAggMap = aggregateRegionalEvents(events);

  const zonePayloads = [];
  const errors = [];

  // Open-Meteo calls are intentionally sequential to avoid spiking the provider.
  for (const zone of FIREWATCH_WEATHER_ZONES) {
    try {
      const weather = await fetchCachedZoneWeather(zone);
      const eventAgg = eventAggMap.get(zone.id);
      zonePayloads.push(buildZoneWeatherInsight(zone, weather, eventAgg));
    } catch (e) {
      console.warn("[regional-weather] zone failed", zone.id, e?.message || e);
      errors.push({ zoneId: zone.id, zoneName: zone.name, error: String(e?.message || e) });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "Open-Meteo forecast API + FireWatchCZ events",
    period: {
      start: startIso,
      end: endIso,
      days
    },
    zones: zonePayloads,
    summary: buildRegionalWeatherSummary(zonePayloads),
    errors
  };
}

// ---------------- STATIC ----------------
app.use(express.static(path.join(__dirname, "public")));

// ---------------- ROUTES ----------------

// --- auth ---
app.get("/api/auth/me", safeRoute(async (req, res) => {
  const auth = await authFromRequest(req);
  if (!auth?.user) return res.json({ ok: true, user: null });
  return res.json({ ok: true, user: auth.user, expires_in_s: SESSION_TTL_SECONDS });
}));
app.post("/api/auth/login", loginLimiter, safeRoute(async (req, res) => {
  try {
    await deleteExpiredSessions();

    const ip=getClientIp(req);

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (username.length < 2 || username.length>32 || password.length < 4 || password.length>128) {
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
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));

// ---------------- AUTH: Registration + OPS request ----------------
function isValidUsername(u) {
  return /^[A-Za-z0-9._-]{3,32}$/.test(String(u || ""));
}

app.post("/api/auth/register", registerLimiter, safeRoute(async (req, res) => {
  try {
    await deleteExpiredSessions();

    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const requestOps = !!req.body?.request_ops;

    if (!isValidUsername(username)) {
      return res.status(400).json({ ok: false, error: "bad_username" });
    }
    if (password.length < 6 || password.length>128) {
      return res.status(400).json({ ok: false, error: "bad_password" });
    }

    const exists = await getUserByUsername(username);
    if (exists) {
      return res.status(409).json({ ok: false, error: "username_taken" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const u = await createUserPublic({ username, passwordHash });
    if (!u) return res.status(500).json({ ok: false, error: "server_error" });

    // auto-create OPS request if user wants
    if (requestOps) {
      try { await createOpsRequest(u.id); } catch {}
    }

    // auto-login as PUBLIC (user stays in PUBLIC mode until admin approves OPS)
    const token = crypto.randomBytes(32).toString("hex");
    const tokenSha = sha256Hex(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    await createSession({ userId: u.id, tokenSha256: tokenSha, expiresAt, ip: getClientIp(req), userAgent: req.get("user-agent") });

    setSessionCookie(res, token, req);
    return res.json({ ok: true, user: { id: u.id, username: u.username, role: "public" }, request_ops: requestOps });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.post("/api/auth/request-ops", requireAuthAny, safeRoute(async (req, res) => {
  try {
    if (String(req.auth?.user?.role) !== "public") {
      return res.status(400).json({ ok: false, error: "not_public" });
    }
    const created = await createOpsRequest(req.auth.user.id);
    return res.json({ ok: true, created: !!created });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.get("/api/admin/ops-requests", requireAdmin, safeRoute(async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const rows = await listPendingOpsRequests(limit);
    return res.json({ ok: true, rows });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.post("/api/admin/ops-requests/:id/approve", requireAdmin, safeRoute(async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });
    const out = await decideOpsRequest({ requestId: id, adminUserId: req.auth.user.id, approve: true });
    if (!out.ok) return res.status(400).json(out);
    await insertAudit({ userId: req.auth.user.id, action: "ops_request_approved", details: JSON.stringify({ request_id: id, user_id: out.user_id }) });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.post("/api/admin/ops-requests/:id/reject", requireAdmin, safeRoute(async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });
    const out = await decideOpsRequest({ requestId: id, adminUserId: req.auth.user.id, approve: false });
    if (!out.ok) return res.status(400).json(out);
    await insertAudit({ userId: req.auth.user.id, action: "ops_request_rejected", details: JSON.stringify({ request_id: id, user_id: out.user_id }) });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));


app.get('/api/admin/geocode-suggestions/:id',requireAdmin,safeRoute(async(req,res)=>{
  const event=await getEventById(req.params.id);if(!event)return res.status(404).json({ok:false,error:'not_found'});
  const proposal=await geocoder.lookup(event,{remote:true,refresh:req.query.refresh==='1'});
  res.json({ok:true,event:annotateEventGeo(event),queries:buildQueries(eventLocation(event)),failure_reason:proposal.failure_reason || '',suggestions:proposal.precision==='failed'?[]:[{...proposal,label:proposal.display_name}]});
}));
app.get('/api/admin/time-diagnostics',requireAdmin,safeRoute(async(req,res)=>{
  const rows=await getGeoAuditRows(5000);const zone=(await pool.query("SHOW timezone")).rows[0];
  res.json({ok:true,dry_run:true,scanned:rows.length,complete:rows.length<5000,session_timezone:zone?.TimeZone || zone?.timezone || null,server_timezone:process.env.TZ || 'unset',items:rows.map(row=>diagnoseTimes(row)).slice(0,200)});
}));
app.get('/api/admin/geocode-diagnostics',requireAdmin,safeRoute(async(req,res)=>{
  const rows=await getGeoAuditRows(),items=diagnoseCoordinates(rows);
  res.json({ok:true,scanned:rows.length,complete:rows.length<5000,suspicious:items.length,without_reliable_coordinates:rows.filter(row=>!annotateEventGeo(row).geo_reliable).length,items:items.slice(0,200)});
}));
app.post('/api/admin/geocode-repair/:id',requireAdmin,safeRoute(async(req,res)=>{
  const event=await getEventById(req.params.id);if(!event)return res.status(404).json({ok:false,error:'not_found'});
  const proposal=await geocoder.lookup(event,{remote:true,refresh:req.body?.refresh===true});
  const can_apply=canImprove(event,proposal,true),expected=geoFingerprint(event),dry_run=req.body?.dry_run!==false;
  const proposal_fingerprint=crypto.createHash('sha256').update(JSON.stringify([proposal.lat,proposal.lon,proposal.precision,proposal.confidence,proposal.source,proposal.query,proposal.display_name,proposal.context_key])).digest('hex');
  if(!dry_run && (!req.body?.expected || req.body.expected!==expected || req.body.proposal_fingerprint!==proposal_fingerprint))return res.status(409).json({ok:false,error:'preview_required_or_changed'});
  const applied=!dry_run && can_apply ? await applyGeoProposal(event.id,proposal,{repair:true,expected,userId:req.auth.user.id}) : false;
  res.json({ok:true,dry_run,can_apply,applied,expected,proposal_fingerprint,event:annotateEventGeo(event),proposal});
}));
app.post("/api/admin/events/:id/coords", requireAdmin, safeRoute(async (req, res) => {
  try {
    const lat = req.body?.lat == null || String(req.body.lat).trim() === "" ? NaN : Number(req.body.lat);
    const lon = req.body?.lon == null || String(req.body.lon).trim() === "" ? NaN : Number(req.body.lon);
    const source = "manual";
    const note = String(req.body?.note || "").slice(0, 500);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "bad_coords" });
    }
    if (!insideCz(lat,lon)) {
      return res.status(400).json({ ok: false, error: "coords_outside_cz" });
    }

    await updateEventCoords(req.params.id, lat, lon, source, note,{precision:"manual",verified:req.body?.verified===true});
    await insertAudit({
      userId: req.auth.user.id,
      action: "event_coords_updated",
      details: JSON.stringify({ id: req.params.id, lat, lon, source, note })
    }).catch(() => {});

    return res.json({ ok: true });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "coords_update_failed" });
  }
}));
app.get("/api/admin/events-with-coords", requireAdmin, safeRoute(async (req, res) => {
  try {
    const rows = (await listEventsWithCoords(Number(req.query.limit || 100))).map(annotateEventGeo);
    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "coords_list_failed" });
  }
}));

app.post('/api/admin/geocode-missing',requireAdmin,safeRoute(async(req,res)=>{
  const rows=await getEventsMissingCoords(Math.max(1,Math.min(10,Number(req.body?.limit)||1)),req.body?.day || 'today');
  const results=[];for(const row of rows){const proposal=await geocoder.lookup(row,{remote:true});const fixed=await applyGeoProposal(row.id,proposal,{userId:req.auth.user.id});results.push({id:row.id,fixed,...proposal});}
  res.json({ok:true,checked:rows.length,fixed:results.filter(row=>row.fixed).length,results});
}));
// ---------------- ADMIN: Missing coordinates management ----------------
app.get("/api/admin/events-missing-coords", requireAdmin, safeRoute(async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const day = String(req.query?.day || "today");
    const rows = (await getEventsFiltered({day},2000)).map(annotateEventGeo).filter(row=>!row.geo_reliable).slice(0,limit);
    return res.json({ ok: true, rows, day });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.put("/api/admin/events/:id/coords", requireAdmin, safeRoute(async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const lat = req.body?.lat == null || String(req.body.lat).trim() === "" ? NaN : Number(req.body.lat);
    const lon = req.body?.lon == null || String(req.body.lon).trim() === "" ? NaN : Number(req.body.lon);
    if (!id) return res.status(400).json({ ok: false, error: "bad_id" });
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ ok: false, error: "bad_coords" });
    if (!insideCz(lat,lon)) return res.status(400).json({ ok: false, error: "bad_coords" });

    await updateEventCoords(id, lat, lon,"manual","",{precision:"manual",verified:req.body?.verified===true});
    await insertAudit({ userId: req.auth.user.id, action: "event_coords_set", details: JSON.stringify({ event_id: id, lat, lon }) });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.delete("/api/admin/events/:id/coords", requireAdmin, safeRoute(async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "bad_id" });
    await clearEventCoords(id);
    await insertAudit({ userId: req.auth.user.id, action: "event_coords_cleared", details: JSON.stringify({ event_id: id }) });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.post("/api/auth/logout", safeRoute(async (req, res) => {
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
}));
// --- admin: users ---
app.get("/api/admin/users", requireAdmin, safeRoute(async (req, res) => {
  const users = await listUsers(300);
  res.json({ ok: true, users });
}));
app.post("/api/admin/users", requireAdmin, safeRoute(async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "ops").trim();
    const isEnabled = (req.body?.is_enabled ?? req.body?.enabled) !== false;
    const permissions = (req.body?.permissions && typeof req.body.permissions === "object") ? req.body.permissions : {};

    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username)) {
      return res.status(400).json({ ok: false, error: "invalid_username" });
    }
    if (password.length < 6 || password.length>128) {
      return res.status(400).json({ ok: false, error: "weak_password" });
    }
    if (!["public", "ops", "editor", "admin", "custom"].includes(role)) {
      return res.status(400).json({ ok: false, error: "invalid_role" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await createUser({ username, passwordHash, role, isEnabled, permissions: normalizePermissions(role, permissions) });
    await insertAudit({ userId: req.auth.user.id, username: req.auth.user.username, action: "user_create", details: `${username} role=${role}`, ip: getClientIp(req) });
    return res.json({ ok: true, user: created });
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return res.status(409).json({ ok: false, error: "username_taken" });
    }
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));
app.patch("/api/admin/users/:id", requireAdmin, safeRoute(async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });

    const patch = {};
    if (req.body?.role != null) {
      const role = String(req.body.role);
      if (!["public", "ops", "editor", "admin", "custom"].includes(role)) return res.status(400).json({ ok: false, error: "invalid_role" });
      patch.role = role;
    }
    if (req.body?.permissions != null) {
      if (!req.body.permissions || typeof req.body.permissions !== "object" || Array.isArray(req.body.permissions)) {
        return res.status(400).json({ ok: false, error: "invalid_permissions" });
      }
      patch.permissions = normalizePermissions(patch.role || "custom", req.body.permissions);
    }
    if(req.body?.is_enabled!=null||req.body?.enabled!=null)patch.isEnabled=!!(req.body.is_enabled ?? req.body.enabled);
    if(patch.role && req.body?.permissions==null)patch.permissions=normalizePermissions(patch.role);
    if (req.body?.password != null) {
      const pw = String(req.body.password);
      if (pw.length < 6 || pw.length>128) return res.status(400).json({ ok: false, error: "weak_password" });
      patch.passwordHash = await bcrypt.hash(pw, 12);
    }
    const updated = await updateUserById(id, patch);
    if (!updated) return res.status(404).json({ ok: false, error: "not_found" });
    if(patch.passwordHash || patch.isEnabled===false)await deleteUserSessions(id);

    await insertAudit({ userId: req.auth.user.id, username: req.auth.user.username, action: "user_update", details: `${updated.username}`, ip: getClientIp(req) });
    return res.json({ ok: true, user: updated });
  } catch (e) {
    console.error(e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}));

// ======================
// FireWatchCZ Web v2.2 – Významné události / stupeň poplachu
// ======================

function majorNormText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}


function parseStandaloneAlarmToken(value) {
  const raw = String(value || "").trim();
  const n = majorNormText(raw);

  if (/^(zvlastni|zvlastni\s+stupen)$/i.test(n)) return { level: 4, text: "Zvláštní stupeň poplachu" };
  if (/^(iv|iv\.|4|4\.|ctvrty)$/i.test(n)) return { level: 4, text: "IV. stupeň poplachu" };
  if (/^(iii|iii\.|3|3\.|treti)$/i.test(n)) return { level: 3, text: "III. stupeň poplachu" };
  if (/^(ii|ii\.|2|2\.|druhy)$/i.test(n)) return { level: 2, text: "II. stupeň poplachu" };
  if (/^(i|i\.|1|1\.|prvni)$/i.test(n)) return { level: 1, text: "I. stupeň poplachu" };

  return { level: null, text: null };
}


function parseAlarmLevelFromText(...parts) {
  const standaloneAlarm = parts.map(parseStandaloneAlarmToken).find(x => x.level);
  if (standaloneAlarm?.level) return standaloneAlarm;

  const raw = parts.filter(Boolean).join(" | ");
  const text = majorNormText(raw);
  if (!text) return { level: null, text: null };

  if (/(zvlastni|zvlastni stupen|zvlastni stupen poplachu|specialni)/i.test(text)) {
    return { level: 4, text: "Zvláštní stupeň poplachu" };
  }

  const candidates = [
    { level: 4, text: "IV. stupeň poplachu", patterns: [/\biv\s*\.?\s*(stupen|sp|poplachovy\s+stupen|poplach)\b/i, /\b(stupen|poplachovy\s+stupen)\s*[:\-]?\s*iv\.?\b/i, /\b4\s*\.?\s*(stupen|sp|poplachovy\s+stupen|poplach)\b/i, /\b(stupen|poplachovy\s+stupen)\s*[:\-]?\s*4\.?\b/i, /\bctvrty\s+stupen\b/i] },
    { level: 3, text: "III. stupeň poplachu", patterns: [/\biii\s*\.?\s*(stupen|sp|poplachovy\s+stupen|poplach)\b/i, /\b(stupen|poplachovy\s+stupen)\s*[:\-]?\s*iii\.?\b/i, /\b3\s*\.?\s*(stupen|sp|poplachovy\s+stupen|poplach)\b/i, /\b(stupen|poplachovy\s+stupen)\s*[:\-]?\s*3\.?\b/i, /\btreti\s+stupen\b/i] },
    { level: 2, text: "II. stupeň poplachu", patterns: [/\bii\s*\.?\s*(stupen|sp)\b/i, /\b2\s*\.?\s*(stupen|sp)\b/i, /\bdruhy\s+stupen\b/i] },
    { level: 1, text: "I. stupeň poplachu", patterns: [/\bi\s*\.?\s*(stupen|sp)\b/i, /\b1\s*\.?\s*(stupen|sp)\b/i, /\bprvni\s+stupen\b/i] }
  ];

  // Speciálně pro tabulkové hodnoty typu "III.".
  if (/\biii\s*\./i.test(text) && /(poplach|stupen|zasah|stav|rss|feed|okres|probih)/i.test(text)) return { level: 3, text: "III. stupeň poplachu" };
  if (/\biv\s*\./i.test(text) && /(poplach|stupen|zasah|stav|rss|feed|okres|probih)/i.test(text)) return { level: 4, text: "IV. stupeň poplachu" };
  if (/\bii\s*\./i.test(text) && /(poplach|stupen|zasah|stav|rss|feed|okres|probih)/i.test(text)) return { level: 2, text: "II. stupeň poplachu" };
  if (/\bi\s*\./i.test(text) && /(poplach|stupen|zasah|stav|rss|feed|okres|probih)/i.test(text)) return { level: 1, text: "I. stupeň poplachu" };

  for (const item of candidates) {
    if (item.patterns.some((p) => p.test(text))) return { level: item.level, text: item.text };
  }

  return { level: null, text: null };
}


function extractStatusLineFromDescription(description = "") {
  const raw = String(description || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

  const lines = raw
    .split(/<br\s*\/?>|\n|\r/g)
    .map(s => s.trim())
    .filter(Boolean);

  const line = lines.find(l => /^stav\s*:/i.test(l));
  return line ? line.replace(/^stav\s*:\s*/i, "").trim() : "";
}

function normalizeStatusValue(value = "") {
  return majorNormText(String(value || "")
    .replace(/^stav\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim());
}

function classifyExplicitStatus({ statusText = "", description = "" } = {}) {
  const direct = normalizeStatusValue(statusText);
  const fromDesc = normalizeStatusValue(extractStatusLineFromDescription(description));
  const candidates = [direct, fromDesc].filter(Boolean);

  for (const s of candidates) {
    // Hodnotíme jen samostatný statusText nebo řádek "stav:" z RSS.
    // Nehodnotíme název události, aby např. "Nová Ves" nebyla omylem aktivní.
    if (
      s === "nova" ||
      s === "novy" ||
      s === "neupresneno" ||
      s === "neupresnena" ||
      s === "neupresneny" ||
      s.includes("probiha zasah") ||
      s.includes("probihajici zasah") ||
      s === "probiha"
    ) {
      return { isClosed: false, source: "explicit_open", label: "probíhá zásah" };
    }

    if (
      s.includes("ukoncena") ||
      s.includes("ukoncen") ||
      s.includes("ukonceno") ||
      s.includes("ukonceny")
    ) {
      return { isClosed: true, source: "explicit_closed", label: "ukončená" };
    }
  }

  const descNorm = majorNormText(description);
  if (descNorm.includes("ukonceni")) {
    return { isClosed: true, source: "explicit_closed", label: "ukončená" };
  }

  return { isClosed: null, source: "unknown", label: "" };
}


function analyzeStatusFromText({ statusText = "", description = "", title = "" } = {}) {
  const explicit = classifyExplicitStatus({ statusText, description });
  if (explicit.source !== "unknown") return explicit;

  // Fallback pro ruční/starší texty bez řádku "stav:".
  // Aktivní fallback nesmí používat samotné slovo "nová", protože to může být město/část názvu.
  const text = majorNormText(`${statusText} ${description} ${title}`);

  if (
    text.includes("probiha zasah") ||
    text.includes("probihajici zasah") ||
    text.includes("probiha")
  ) {
    return { isClosed: false, source: "explicit_open", label: "probíhá zásah" };
  }

  if (
    text.includes("ukoncena") ||
    text.includes("ukoncen") ||
    text.includes("ukonceno") ||
    text.includes("ukonceny") ||
    text.includes("likvidace ukoncena")
  ) {
    return { isClosed: true, source: "explicit_closed", label: "ukončená" };
  }

  return { isClosed: null, source: "unknown", label: "" };
}

function analyzeMajorEvent(it = {}, desc = "") {
  const alarm = parseAlarmLevelFromText(
    it.alarmLevelText,
    it.alarm_level_text,
    it.alarmLevel,
    it.alarm_level,
    it.alarm_degree,
    it.poplachovy_stupen,
    it.grade,
    it.statusText,
    it.status_text,
    it.title,
    it.placeText,
    it.cityText,
    desc
  );

  const reasons = [];

  if (alarm.level >= 3) {
    reasons.push(alarm.level >= 4 ? "Zvláštní/IV. stupeň poplachu" : "III. stupeň poplachu");
  }

  const text = majorNormText(`${it.title || ""} ${it.statusText || ""} ${desc || ""}`);
  if (text.includes("velky rozsah") || text.includes("mimoradna udalost") || text.includes("evakuace")) {
    reasons.push("text události naznačuje větší rozsah");
  }

  const isMajor = reasons.length > 0;

  return {
    alarmLevel: alarm.level,
    alarmLevelText: alarm.text,
    isMajorEvent: isMajor,
    majorReason: reasons.join(", ") || null
  };
}



function makeManualEventId({ startIso, title, city }) {
  const d = startIso ? new Date(startIso) : new Date();
  const stamp = Number.isNaN(d.getTime())
    ? new Date().toISOString()
    : d.toISOString();
  const compact = stamp.replace(/[-:.TZ]/g, "").slice(0, 14);
  const slug = String(`${city || ""}-${title || ""}`)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 44) || "EVENT";
  return `MANUAL_${compact}_${slug}`;
}

function parseManualEventCoords(rawLat, rawLon) {
  if ((rawLat === "" || rawLat == null) && (rawLon === "" || rawLon == null)) {
    return { lat: null, lon: null };
  }

  const lat = Number(String(rawLat ?? "").replace(",", "."));
  const lon = Number(String(rawLon ?? "").replace(",", "."));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const e = new Error("bad_coords");
    e.statusCode = 400;
    throw e;
  }

  if (!insideCz(lat,lon)) {
    const e = new Error("coords_outside_cz");
    e.statusCode = 400;
    throw e;
  }

  return { lat, lon };
}

function publicSafeManualSourceNote() {
  // Záměrně se nikde veřejně nevypisuje, že událost byla zadána ručně.
  // source_kind/source_note slouží jen pro admin diagnostiku.
  return "Ručně doplněno přes admin";
}


// ingest (data z ESP)
app.post("/api/ingest/source-state", requireKey, safeRoute(async (req, res) => {
  const source = String(req.body?.source || "");
  if (!['pardubicky'].includes(source) || !Array.isArray(req.body?.external_ids) || req.body.external_ids.length > 200) return res.status(400).json({ok:false,error:'bad_source_state_request'});
  const state = await getSourceIdentityState(source, req.body.external_ids);
  res.json({ok:true,source,...state});
}));
app.post('/api/admin/station-assignment-audit',requireAdmin,safeRoute(async(req,res)=>{
  const apply=req.body?.apply===true;
  const result=await auditCrossRegionStationAssignments({apply});
  if(apply) await insertAudit({userId:req.auth?.user?.id||null,username:req.auth?.user?.username||null,action:'clear_invalid_cross_region_station_assignments',details:JSON.stringify({count:result.automatically_incorrect,ids:result.ids}),ip:getClientIp(req)});
  res.json({ok:true,...result});
}));

async function handleIngest(req, res) {
  try {
    const { items } = req.body || {};
    const source=String(req.body?.source || "unknown").slice(0,80);
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items missing" });
    }

    if (items.length > 200) return res.status(400).json({ ok: false, error: "too_many_items", maxItems: 200 });
    const prahaSource = source === "github_actions_praha_atom";
    const pardubickySource = source === "github_actions_pardubicky_rss";
    const rssSource = prahaSource || pardubickySource || ["github_actions_rss", "github_actions_rss2json", "server_rss_worker"].includes(source);
    let skippedOlder = 0;
    let skippedInvalid = 0;
    const uniqueItems = new Map();
    for (const item of items) {
      if (!item || typeof item.id !== "string" || item.id.length > 512 || !item.id.trim()
          || typeof item.title !== "string" || !item.title.trim() || item.title.length > 2000
          || [item.descriptionRaw,item.descRaw,item.description].some(value=>value!=null&&(typeof value!=="string"||value.length>65536))
          || typeof item.link !== "string" || item.link.length > 4096 || !/^https?:\/\//i.test(item.link)) { skippedInvalid++; continue; }
      uniqueItems.set(item.id, item);
    }
    const skippedDuplicates = items.length - skippedInvalid - uniqueItems.size;
    let accepted = 0;
    let updatedClosed = 0;
    let geocoded = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let statusChanged = 0;

    for (const it of uniqueItems.values()) {

      if (prahaSource && (it.source !== "praha" || !/^urn:uuid:[0-9a-f-]{36}$/i.test(String(it.externalId || "")))) { skippedInvalid++; continue; }
      if (pardubickySource && (it.source !== "pardubicky" || !/^\d+$/.test(String(it.externalId || "")))) { skippedInvalid++; continue; }
      const eventId = prahaSource ? `praha:${it.externalId}` : pardubickySource ? `pardubicky:${it.externalId}` : it.id;
      const prev = (prahaSource || pardubickySource)
        ? await getEventMetaBySourceExternal(prahaSource ? "praha" : "pardubicky", it.externalId)
        : await getEventMeta(eventId);
      if (prahaSource) {
        if (!shouldIngestPrahaItem(it, { previouslyKnown: !!prev, maxAgeHours: process.env.PRAHA_MAX_AGE_HOURS })) { skippedOlder++; continue; }
      } else if (pardubickySource) {
        const age=pardubickyAgeClass({reportedAt:it.reportedAt || it.pubDate});
        if (!prev && age !== 'today' && !(age === 'yesterday' && it.isClosed === false && it.statusSource === 'explicit_open')) { skippedOlder++; continue; }
      } else if (rssSource && !shouldIngestRssItemForToday(it, { previouslyKnown: !!prev, previouslyKnownOpen: prev?.is_closed === false })) { skippedOlder++; continue; }

      const eventType = it.eventType || classifyType(it.title);
      const desc = it.descriptionRaw || it.descRaw || it.description || "";
      const times = (prahaSource || pardubickySource) ? { startIso: null, endIso: null, isClosed: false } : parseTimesFromDescription(desc);

// --- Server-side status intelligence ---
// ESP zůstává jen zdroj dat; server umí opravit stav podle textu/detailu.
// Explicitní "probíhá zásah" má prioritu a dokáže znovu otevřít dříve mylně ukončenou událost.
const statusAnalysis = prahaSource ? {
  source: ["source_estimated_open","source_estimated_closed","source_estimated_unknown"].includes(it.statusSource) ? it.statusSource : "source_estimated_unknown",
  label: String(it.statusText || "stav neupřesněn").slice(0, 200)
} : pardubickySource ? {
  source: ['explicit_open','explicit_closed'].includes(it.statusSource) ? it.statusSource : 'unknown',
  label: String(it.statusText || 'stav neupřesněn').slice(0,200)
} : analyzeStatusFromText({
  statusText: it.statusText || it.status_text || "",
  description: desc,
  title: it.title || ""
});

let isClosed = false;
if (prahaSource) {
  isClosed = statusAnalysis.source === "source_estimated_closed" && it.isClosed === true;
} else if (pardubickySource) {
  isClosed = statusAnalysis.source === 'explicit_closed' && it.isClosed === true;
} else if (statusAnalysis.source === "explicit_open") {
  isClosed = false;
} else if (statusAnalysis.source === "explicit_closed") {
  isClosed = true;
} else {
  const statusLower = String(it.statusText || it.status_text || "").toLowerCase();
  isClosed = !!(
    it.isClosed === true ||
    it.is_closed === true ||
    (statusLower.includes("ukon") && statusLower.includes("stav")) ||
    statusLower.includes("ukončen") ||
    statusLower.includes("ukonc") ||
    times.isClosed
  );
}

// Source updates and verified starts are separate instants.
const sourceUpdatedAt=normalizeFeedTimestamp(it.sourceUpdatedAt || it.pubDate || it.pub_date);
const startIso=(prahaSource || pardubickySource) ? null : ((hasTrustedStart(prev || {}) ? normalizeFeedTimestamp(prev.start_time_iso) : null) || normalizeFeedTimestamp(it.startTimeIso || it.start_time_iso) || times.startIso || (rssSource ? null : eventStartIsoFromEspRss(it,times)));
const startTimeSource=(hasTrustedStart(prev || {}) ? (prev.start_time_source || (prev.status_source==='manual' || prev.source_kind==='manual' ? 'manual' : 'explicit')) : null) || (times.startIso ? 'rss_description' : startIso ? (rssSource ? 'explicit' : 'esp') : null);

let endIso =
  (prev?.end_time_source === "manual" ? normalizeFeedTimestamp(prev.end_time_iso) : null) ||
  normalizeFeedTimestamp(it.endTimeIso) ||
  times.endIso ||
  (prev?.end_time_source ? normalizeFeedTimestamp(prev.end_time_iso) : null) ||
  null;

let durationMin = null;
let durationSource = null;
let durationIsEstimate = false;
const firstSeenWasOpen = prev ? prev.first_seen_was_open : (prahaSource ? null : statusAnalysis.source === "explicit_open");
const firstSeenStatus = prev ? prev.first_seen_status : (prahaSource || statusAnalysis.source === "unknown" ? null : statusAnalysis.label);

// 1) Pokud ESP někdy pošle délku explicitně, přijmeme ji.
if (!prahaSource && !pardubickySource && Number.isFinite(it.durationMin)) {
  const candidate = Math.round(it.durationMin);
  durationMin = (candidate > 0 && candidate <= MAX_DURATION_MINUTES) ? candidate : null;
  if (durationMin != null) durationSource = "esp_duration";
}

// 2) Nejlepší přesnost: RSS obsahuje "ukončení:".
// Délka = ukončení z RSS - doložený začátek.
if (durationMin == null && isClosed && endIso) {
  durationMin = safeDurationFromStartEnd(startIso, endIso);
  if (durationMin != null) {
    durationSource = startTimeSource === "rss_description" ? "rss_start_and_end" : startTimeSource === "manual" ? "manual_start_rss_end" : "trusted_start_rss_end";
  }
}

// Bez doloženého začátku lze odhadovat pouze od neměnného prvního zachycení,
// a jen pokud byl první pozorovaný stav výslovně otevřený.
if (durationMin == null && firstSeenWasOpen === true) {
  if (!isClosed) {
    durationSource = "first_seen_open_estimate";
    durationIsEstimate = true;
  } else if (endIso && prev?.first_seen_at) {
    durationMin = safeDurationFromStartEnd(prev.first_seen_at, endIso);
    if (durationMin != null) {
      durationSource = "first_seen_to_rss_end_estimate";
      durationIsEstimate = true;
    }
  }
}

// Otevřená událost nemá konec; průběžnou délku dopočítá API/UI z first_seen_at.
if (!isClosed) {
  endIso = null;
  if (!durationIsEstimate) {
    durationMin = null;
    durationSource = null;
  }
}

      const placeText = it.placeText || null;
      const cityFromDesc = extractCityFromDescription(desc);
      const cityFromTitle = extractCityFromTitle(it.title);
      const districtFromDesc = extractDistrictFromDescription(desc);

      const major = analyzeMajorEvent(it, desc);

      const cityText =
        ((prahaSource || pardubickySource) ? it.cityText : (rssSource ? cityFromDesc : it.cityText)) ||
        it.cityText ||
        cityFromDesc ||
        (!placeText ? cityFromTitle : (isDistrictPlace(placeText) ? cityFromTitle : placeText)) ||
        null;

      const ev = {
        id: eventId,
        title: it.title,
        link: it.link,
        pubDate: sourceUpdatedAt || it.pubDate || null,
        sourceUpdatedAt: rssSource ? sourceUpdatedAt : null,
        startTimeSource,
        endTimeSource: times.endIso ? "rss_description" : endIso ? "explicit" : null,
        placeText,
        cityText,
        district: pardubickySource ? it.district : districtFromDesc,
        street: pardubickySource ? it.street : null,
        cityPart: pardubickySource ? it.cityPart : null,
        statusText: statusAnalysis.label || it.statusText || null,
        eventType,
        descriptionRaw: desc || null,
        startTimeIso: startIso,
        endTimeIso: endIso,
        durationMin,
        durationSource,
        durationIsEstimate,
        firstSeenStatus,
        firstSeenWasOpen,
        isClosed,
        alarmLevel: major.alarmLevel,
        alarmLevelText: major.alarmLevelText,
        isMajorEvent: major.isMajorEvent,
        majorReason: major.majorReason,
        statusSource: statusAnalysis.source,
        sourceKind: rssSource ? "rss" : "esp",
        source: prahaSource ? "praha" : pardubickySource ? "pardubicky" : "stredocesky",
        externalId: (prahaSource || pardubickySource) ? it.externalId : eventId,
        sourceUrl: (prahaSource || pardubickySource) ? it.sourceUrl : it.link,
        region: prahaSource ? "Hlavní město Praha" : pardubickySource ? "Pardubický kraj" : "Středočeský kraj",
        contentHash: (prahaSource || pardubickySource) ? it.contentHash : null,
        rawPayload: (prahaSource || pardubickySource) ? it.rawPayload : null,
        isJpoEvent: prahaSource ? it.isJpoEvent === true : true
      };

      if ((prahaSource || pardubickySource) && prev && prev.content_hash && prev.content_hash === it.contentHash) {
        await touchEventLastSeen(prev.id);
        accepted++;
        unchanged++;
        continue;
      }

      await upsertEvent(ev);
      if (pardubickySource) await updateEventSourceDetails(ev.id, {
        reportedAt: it.reportedAt || it.pubDate, subtype: it.subtype, district: it.district,
        cityPart: it.cityPart, street: it.street, respondingUnits: it.respondingUnits,
        statusObserved: !!prev && prev.is_closed === false && ev.isClosed === true,
        eventRegion: 'Pardubický kraj', assignmentMethod: 'none'
      });
      accepted++;
      if (prev) updated++; else inserted++;
      if (prev && prev.is_closed !== ev.isClosed) statusChanged++;

      if (ev.isClosed) updatedClosed++;

      // Retain existing coordinates, especially manual corrections.
      if (prev?.lat != null && prev?.lon != null) continue;
      const proposal=await geocoder.lookup(ev);
      if(await applyGeoProposal(ev.id,proposal))geocoded++;
      else if(proposal.precision==='failed'){await recordGeoFailure(ev.id,proposal);if(geocodeJobsActive)geocodeJobs.enqueue(ev.id);}

    }

    await insertIngestLog({
      source: source || "unknown",
      sourceKind: rssSource ? "rss" : "esp",
      skippedCount: skippedOlder + skippedInvalid + skippedDuplicates,
      skippedOlderCount: skippedOlder,
      receivedCount: items.length,
      acceptedCount: accepted,
      newCount: inserted,
      updatedCount: updated,
      unchangedCount: unchanged,
      closedCount: updatedClosed,
      geocodedCount: geocoded,
      ip: getClientIp(req),
      userAgent: req.get("user-agent") || null
    });

    res.json({
      ok: true,
      source: source || "unknown",
      accepted,
      inserted,
      updated,
      unchanged,
      status_changed: statusChanged,
      closed_seen_in_batch: updatedClosed,
      geocoded,
      skipped: skippedOlder + skippedInvalid + skippedDuplicates,
      skipped_older: skippedOlder
    });
  } catch (e) {
    console.error(e.code || "operation_failed");
    try {
      await insertIngestLog({
        source: String(req.body?.source || "unknown").slice(0,80),
        sourceKind: ["server_rss_worker", "github_actions_rss", "github_actions_rss2json", "github_actions_praha_atom", "github_actions_pardubicky_rss"].includes(req.body?.source) ? "rss" : "esp",
        receivedCount: Array.isArray(req.body?.items) ? req.body.items.length : 0,
        errorText: "ingest_failed",
        ip: getClientIp(req),
        userAgent: req.get("user-agent") || null
      });
    } catch {}
    res.status(500).json({ ok: false, error: "server error" });
  }
}

app.post("/api/ingest", requireKey, handleIngest);



function alarmLevelTextFromManual(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n === 1) return "I. stupeň poplachu";
  if (n === 2) return "II. stupeň poplachu";
  if (n === 3) return "III. stupeň poplachu";
  if (n === 4) return "IV. / zvláštní stupeň poplachu";
  return `${n}. stupeň poplachu`;
}

function parseManualIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function computeManualDurationMin(startIso, endIso, isClosed) {
  if (!startIso) return null;
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;

  if (!isClosed) {
    // Aktivní zásah: délka se nechává průběžná pro UI/reporty; end_time zůstává NULL.
    const now = new Date();
    const min = Math.max(0, Math.round((now - start) / 60000));
    return min;
  }

  if (!endIso) return null;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime()) || end < start) return null;
  return Math.max(0, Math.round((end - start) / 60000));
}


// ---------------- MAJOR EVENTS BACKFILL ----------------

app.post("/api/admin/recheck-event-statuses", requireAdmin, safeRoute(async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit || req.query?.limit || 5000), 20000));
    const rows = await listEventsForMajorBackfill(limit);

    let scanned = 0;
    let changed = 0;
    let reopened = 0;
    let closed = 0;

    for (const row of rows) {
      scanned++;
      const status = analyzeStatusFromText({
        statusText: row.status_text || "",
        description: row.description_raw || "",
        title: row.title || ""
      });

      if (status.source === "unknown") continue;

      const shouldClosed = status.isClosed === true;
      const oldClosed = row.is_closed === true;
      const oldSource = String(row.status_source || "");

      if (oldClosed !== shouldClosed || oldSource !== status.source || String(row.status_text || "") !== String(status.label || "")) {
        await updateEventStatusFromRecheck(row.id, {
          isClosed: shouldClosed,
          statusSource: status.source,
          statusText: status.label || null
        });
        changed++;
        if (!shouldClosed) reopened++;
        if (shouldClosed) closed++;
      }
    }

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "recheck_event_statuses",
      details: `scanned=${scanned}; changed=${changed}; reopened=${reopened}; closed=${closed}`,
      ip: getClientIp(req)
    });

    return res.json({ ok: true, scanned, changed, reopened, closed });
  } catch (e) {
    console.error("[recheck-event-statuses]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "recheck_event_statuses_failed" });
  }
}));

app.post("/api/admin/major-events/backfill", requireAdmin, safeRoute(async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.body?.limit || req.query?.limit || 5000), 20000));
    const rows = await listEventsForMajorBackfill(limit);

    let scanned = 0;
    let updated = 0;
    let major = 0;
    let reopened = 0;
    let closedByText = 0;
    const examples = [];

    for (const row of rows) {
      scanned++;

      const desc = row.description_raw || "";
      const analysis = analyzeMajorEvent({
        alarmLevelText: row.alarm_level_text,
        alarmLevel: row.alarm_level,
        statusText: row.status_text,
        title: row.title,
        placeText: row.place_text,
        cityText: row.city_text
      }, desc);

      const statusAnalysis = analyzeStatusFromText({
        statusText: row.status_text || "",
        description: desc,
        title: row.title || ""
      });

      const statusSource = statusAnalysis.source === "unknown" ? null : statusAnalysis.source;

      const patch = {
        alarmLevel: analysis.alarmLevel,
        alarmLevelText: analysis.alarmLevelText,
        isMajorEvent: analysis.isMajorEvent,
        majorReason: analysis.majorReason,
        statusSource
      };

      const changed =
        Number(row.alarm_level || 0) !== Number(patch.alarmLevel || 0) ||
        String(row.alarm_level_text || "") !== String(patch.alarmLevelText || "") ||
        Boolean(row.is_major_event) !== Boolean(patch.isMajorEvent) ||
        String(row.major_reason || "") !== String(patch.majorReason || "") ||
        (statusSource && String(row.status_source || "") !== String(statusSource)) ||
        (statusSource === "explicit_open" && row.is_closed === true) ||
        (statusSource === "explicit_closed" && row.is_closed === false);

      if (!changed) continue;

      await updateEventMajorAnalysis(row.id, patch);
      updated++;

      if (patch.isMajorEvent) {
        major++;
        if (examples.length < 10) {
          examples.push({
            id: row.id,
            title: row.title,
            city: row.city_text || row.place_text || "",
            alarmLevel: patch.alarmLevel,
            alarmLevelText: patch.alarmLevelText,
            reason: patch.majorReason
          });
        }
      }

      if (statusSource === "explicit_open" && row.is_closed === true) reopened++;
      if (statusSource === "explicit_closed" && row.is_closed === false) closedByText++;
    }

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "major_events_backfill",
      details: `scanned=${scanned}; updated=${updated}; major=${major}; reopened=${reopened}; closedByText=${closedByText}`,
      ip: getClientIp(req)
    });

    return res.json({
      ok: true,
      scanned,
      updated,
      major,
      reopened,
      closedByText,
      examples
    });
  } catch (e) {
    console.error("[major-events-backfill]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "major_events_backfill_failed" });
  }
}));
app.get("/api/admin/major-events", requireAdmin, safeRoute(async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query?.limit || 50), 200));
    const rows = await getMajorEventsSummary(limit);
    return res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("[major-events-list]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "major_events_list_failed" });
  }
}));




app.post("/api/admin/repair-closed-times", requireAdmin, safeRoute(async (req, res) => {
  try {
    const rows = await repairClosedEventsMissingEndTime({ limit: Number(req.body?.limit || req.query?.limit || 1000) });
    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "repair_closed_times",
      details: `repaired=${rows.length}`,
      ip: getClientIp(req)
    });
    return res.json({ ok: true, repaired: rows.length, rows });
  } catch (e) {
    console.error("[repair-closed-times]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "repair_closed_times_failed" });
  }
}));




app.post("/api/admin/clear-observed-durations", requireAdmin, safeRoute(async (req, res) => {
  try {
    const rows = await clearObservedDurations({
      limit: Number(req.body?.limit || req.query?.limit || 10000)
    });

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "clear_observed_durations",
      details: `cleared=${rows.length}`,
      ip: getClientIp(req)
    });

    return res.json({ ok: true, cleared: rows.length, rows });
  } catch (e) {
    console.error("[clear-observed-durations]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "clear_observed_durations_failed" });
  }
}));

app.post("/api/admin/recompute-observed-durations", requireAdmin, safeRoute(async (req, res) => {
  try {
    const rows = await recomputeObservedDurationsForClosedEvents({
      limit: Number(req.body?.limit || req.query?.limit || 1000)
    });

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "recompute_observed_durations",
      details: `recomputed=${rows.length}`,
      ip: getClientIp(req)
    });

    return res.json({ ok: true, recomputed: rows.length, rows });
  } catch (e) {
    console.error("[recompute-observed-durations]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "recompute_observed_durations_failed" });
  }
}));

app.post("/api/admin/clear-bogus-durations", requireAdmin, safeRoute(async (req, res) => {
  try {
    const rows = await clearEstimatedDurationsForAlreadyClosedEvents({
      maxMinutes: Number(req.body?.maxMinutes || req.query?.maxMinutes || 20)
    });

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "clear_bogus_durations",
      details: `cleared=${rows.length}`,
      ip: getClientIp(req)
    });

    return res.json({ ok: true, cleared: rows.length, rows });
  } catch (e) {
    console.error("[clear-bogus-durations]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "clear_bogus_durations_failed" });
  }
}));

// ---------------- OWN EVENT DETAIL / MANUAL NOTES ----------------
app.get("/api/events/:id/detail", safeRoute(async (req, res) => {
  try {
    const row = await getEventDetailById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "event_not_found" });
    return res.json({ ok: true, event: annotateEventGeo(annotateEventTime(row)) });
  } catch (e) {
    console.error("[event-detail-get]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "event_detail_get_failed" });
  }
}));
app.post("/api/admin/events/:id/detail", requireAdmin, safeRoute(async (req, res) => {
  try {
    const updated = await updateEventManualDetail(req.params.id, {
      manualDetailText: req.body?.manualDetailText || "",
      manualDetailSource: req.body?.manualDetailSource || ""
    });

    if (!updated) return res.status(404).json({ ok: false, error: "event_not_found" });

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "manual_event_detail_update",
      details: `event=${req.params.id}; detailLength=${String(req.body?.manualDetailText || "").length}`,
      ip: getClientIp(req)
    });

    return res.json({ ok: true, event: updated });
  } catch (e) {
    console.error("[event-detail-save]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "event_detail_save_failed" });
  }
}));


// ---------------- MANUAL EVENT CREATE + INGEST DIAGNOSTICS ----------------
app.post("/api/admin/events/manual-create", requireAdmin, safeRoute(async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    if (!title) return res.status(400).json({ ok: false, error: "title_required" });

    const cityText = String(req.body?.cityText || req.body?.city_text || "").trim() || null;
    const placeText = String(req.body?.placeText || req.body?.place_text || "").trim() || cityText;
    const eventType = String(req.body?.eventType || req.body?.event_type || classifyType(title) || "other").trim();

    const statusMode = String(req.body?.statusMode || "open").toLowerCase();
    const isClosed = statusMode === "closed";
    const statusText = isClosed ? "ukončená" : "probíhá zásah";

    const startTimeIso = parseManualIso(req.body?.startTimeIso || req.body?.pubDate) || new Date().toISOString();
    const endTimeIso = isClosed
      ? (parseManualIso(req.body?.endTimeIso) || new Date().toISOString())
      : null;

    const alarmLevelRaw = req.body?.alarmLevel;
    const alarmLevel = alarmLevelRaw === "" || alarmLevelRaw == null ? null : Number(alarmLevelRaw);
    const alarmLevelText = alarmLevelTextFromManual(alarmLevel);

    const isMajorEvent =
      req.body?.isMajorEvent === true ||
      req.body?.isMajorEvent === "true" ||
      Number(alarmLevel || 0) >= 3;

    const majorReason = String(req.body?.majorReason || "").trim()
      || (Number(alarmLevel || 0) >= 3 ? alarmLevelText : null);

    const durationMin = computeManualDurationMin(startTimeIso, endTimeIso, isClosed);
    const { lat, lon } = parseManualEventCoords(req.body?.lat, req.body?.lon);

    const manualDetailText = String(req.body?.manualDetailText || "").trim();
    const id = makeManualEventId({ startIso: startTimeIso, title, city: cityText || placeText });

    await insertManualEvent({
      id,
      title,
      link: `manual:${id}`,
      pubDate: startTimeIso,
      placeText,
      cityText,
      statusText,
      eventType,
      descriptionRaw: manualDetailText || null,
      startTimeIso,
      endTimeIso,
      durationMin,
      isClosed,
      alarmLevel,
      alarmLevelText,
      isMajorEvent,
      majorReason,
      statusSource: "manual",
      sourceNote: publicSafeManualSourceNote(),
      lat,
      lon
    });

    if (manualDetailText) {
      await updateEventManualDetail(id, {
        manualDetailText,
        manualDetailSource: "Ručně doplněno administrátorem"
      });
    }

    await insertIngestLog({
      source: "manual_create",
      sourceKind: "manual",
      receivedCount: 1,
      acceptedCount: 1,
      newCount: 1,
      updatedCount: 0,
      closedCount: isClosed ? 1 : 0,
      geocodedCount: lat != null && lon != null ? 1 : 0,
      ip: getClientIp(req),
      userAgent: req.get("user-agent") || null
    });

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "manual_event_create",
      details: `event=${id}; title=${title}; city=${cityText || placeText || ""}`,
      ip: getClientIp(req)
    });

    return res.json({ ok: true, id });
  } catch (e) {
    console.error("[manual-event-create]", e.code || "operation_failed");
    return res.status(e.statusCode || 500).json({
      ok: false,
      error: e?.message || "manual_event_create_failed"
    });
  }
}));
app.get("/api/admin/ingest-diagnostics", requireAdmin, safeRoute(async (req, res) => {
  try {
    const data = await getIngestDiagnostics({ limit: Number(req.query?.limit || 20) });
    return res.json({ ok: true, ...data, rssWorker: rssWorker?.getState() || { enabled: readRssConfig().enabled, running: false } });
  } catch (e) {
    console.error("[ingest-diagnostics]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "ingest_diagnostics_failed" });
  }
}));
app.post("/api/admin/rss-test", requireAdmin, async (_req, res) => {
  const result = await testRssConnection(readRssConfig());
  return res.status(result.success ? 200 : 502).json({ ok: result.success, ...result });
});

app.get("/api/admin/events/search", requireAdmin, safeRoute(async (req, res) => {
  try {
    const items = await searchEventsAdmin({
      q: req.query?.q || "",
      limit: Number(req.query?.limit || 50)
    });

    let visibleIds = new Set();
    try {
      const filters = parseFilters(req);
      const visibleRows = await getEventsFiltered(filters, 2000);
      visibleIds = new Set((visibleRows || []).map((x) => String(x.id)));
      for (const it of items) {
        it.visible_in_current_overview = visibleIds.has(String(it.id));
      }
    } catch {}

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("[admin-events-search]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "admin_events_search_failed" });
  }
}));

// ---------------- MANUAL EVENT EDIT ----------------
app.get("/api/admin/events/:id/manual", requireAdmin, safeRoute(async (req, res) => {
  try {
    const row = await getEventForManualEdit(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "event_not_found" });
    return res.json({ ok: true, event: annotateEventGeo(annotateEventTime(row)) });
  } catch (e) {
    console.error("[manual-event-get]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "manual_event_get_failed" });
  }
}));
app.post("/api/admin/events/:id/manual", requireAdmin, safeRoute(async (req, res) => {
  try {
    const current = await getEventForManualEdit(req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: "event_not_found" });

    const mode = String(req.body?.statusMode || "").toLowerCase();
    const isClosed = mode === "closed" ? true : mode === "open" ? false : !!current.is_closed;
    const statusText = mode === "open" ? "probíhá zásah" : mode === "closed" ? "ukončená" : (current.status_text || null);

    const startTimeIso = parseManualIso(req.body?.startTimeIso) || (hasTrustedStart(current) ? current.start_time_iso : null);
    const endTimeIso = isClosed
      ? (parseManualIso(req.body?.endTimeIso) || (current.end_time_source || current.duration_source === "manual" ? current.end_time_iso : null))
      : null;

    const alarmLevelRaw = req.body?.alarmLevel;
    const alarmLevel = alarmLevelRaw === "" || alarmLevelRaw === null || alarmLevelRaw === undefined
      ? null
      : Number(alarmLevelRaw);

    const alarmLevelText = alarmLevelTextFromManual(alarmLevel);
    const manualMajor = req.body?.isMajorEvent === true || req.body?.isMajorEvent === "true";
    const isMajorEvent = manualMajor || Number(alarmLevel || 0) >= 3;
    const majorReason = String(req.body?.majorReason || "").trim()
      || (Number(alarmLevel || 0) >= 3 ? alarmLevelText : null);

    const manualLatRaw = req.body?.lat;
    const manualLonRaw = req.body?.lon;
    const clearCoords = req.body?.clearCoords === true || req.body?.clearCoords === "true";

    let manualLat = null;
    let manualLon = null;

    if (manualLatRaw !== "" && manualLatRaw !== null && manualLatRaw !== undefined &&
        manualLonRaw !== "" && manualLonRaw !== null && manualLonRaw !== undefined) {
      manualLat = Number(manualLatRaw);
      manualLon = Number(manualLonRaw);

      if (!Number.isFinite(manualLat) || !Number.isFinite(manualLon)) {
        return res.status(400).json({ ok: false, error: "bad_coords" });
      }

      if (manualLat < 48 || manualLat > 52 || manualLon < 12 || manualLon > 19) {
        return res.status(400).json({ ok: false, error: "coords_outside_cz" });
      }
    }

    const durationMin = computeManualDurationMin(startTimeIso, endTimeIso, isClosed);

    await updateEventManualMeta(req.params.id, {
      isClosed,
      statusText,
      alarmLevel,
      alarmLevelText,
      isMajorEvent,
      majorReason,
      startTimeIso,
      endTimeIso,
      durationMin,
      lat: manualLat,
      lon: manualLon,
      clearCoords
    });

    await insertAudit({
      userId: req.auth?.user?.id || null,
      username: req.auth?.user?.username || null,
      action: "manual_event_edit",
      details: `event=${req.params.id}; status=${statusText}; alarm=${alarmLevelText || "none"}; major=${isMajorEvent}; duration=${durationMin}; coords=${manualLat},${manualLon}; clearCoords=${clearCoords}`,
      ip: getClientIp(req)
    });

    const updated = await getEventForManualEdit(req.params.id);
    return res.json({ ok: true, event: updated });
  } catch (e) {
    console.error("[manual-event-post]", e.code || "operation_failed");
    return res.status(500).json({ ok: false, error: "manual_event_update_failed" });
  }
}));

// ---------------- VISITS (no cookies, no identifiers; admin-only viewing) ----------------

// ---------------- SETTINGS ----------------
app.get("/api/settings", safeRoute(async (req, res) => {
  try {
    const v = await getSetting("default_shift_mode");
    const mode = (v === "HZSP" || v === "HZS") ? v : "HZS";
    return res.json({ ok: true, default_shift_mode: mode });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "settings_failed" });
  }
}));
app.get("/api/admin/settings", requireAdmin, safeRoute(async (req, res) => {
  try {
    const v = await getSetting("default_shift_mode");
    const mode = (v === "HZSP" || v === "HZS") ? v : "HZS";
    return res.json({ ok: true, default_shift_mode: mode });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "settings_failed" });
  }
}));
app.put("/api/admin/settings", requireAdmin, safeRoute(async (req, res) => {
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
}));
app.post("/api/visit", safeRoute(async (req, res) => {
  try {
    const auth = await authFromRequest(req);
    const role = String(auth?.user?.role || "");
    const mode = role === "admin" ? "admin" : (role === "ops" ? "ops" : "public");
    await incPageVisit(mode, todayPragueISO());
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: true }); // fail-open; never break UI
  }
}));
app.get("/api/admin/visits/stats", requireAdmin, safeRoute(async (req, res) => {
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
}));

// events (filters) + backfill coords + backfill duration
app.get('/api/events', async (req,res) => {
  try {
    const raw=String(req.query.limit||'2000');
    if(!/^\d+$/.test(raw)||Number(raw)<1)return res.status(400).json({ok:false,error:'bad_limit'});
    const limit=Math.min(Number(raw),2000),filters=parseFilters(req);
    const [rows,totalMatching,dataStatus]=await Promise.all([getEventsFiltered(filters,limit),countEventsFiltered(filters),getPublicDataStatus()]);
    res.json({ok:true,filters,limit,total_matching:totalMatching,backfilled_coords:0,backfilled_durations:0,data_status:dataStatus,items:rows.map(row=>annotateEventGeo(annotateEventTime(row)))});
  }catch(e){if(e.status!==400)console.error('[events]',e.code||'database_error');res.status(e.status===400?400:500).json({ok:false,error:e.status===400?'bad_filters':'events_failed'});}
});
// Statistics use the same validated period and source filters as the event list.
app.get('/api/stats',async(req,res)=>{
  try {
    const filters=parseFilters(req),statsFilters={...filters};
    const stats=await getStatsFiltered(statsFilters);
    res.json({ok:true,filters:statsFilters,...stats,openCount:stats?.openVsClosed?.open??0,closedCount:stats?.openVsClosed?.closed??0});
  }catch(e){if(e.status!==400)console.error('[stats]',e.code||'database_error');res.status(e.status===400?400:500).json({ok:false,error:e.status===400?'bad_filters':'stats_failed'});}
});

// export CSV
function csvEscape(value) {
  let text=String(value??"");
  // RSS titles are untrusted text, never spreadsheet formulas.
  if (/^[=+@-]/.test(text)) text="'"+text;
  return /[;"\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
}
function exportEventDuration(event) {
  event=annotateEventTime(event);
  if(event.is_closed)return event.duration_min;
  if(event.duration_is_estimate)return event.duration_min;
  const start=Date.parse(event.start_time_iso||"");
  const minutes=Number.isFinite(start)?Math.floor((Date.now()-start)/60000):null;
  return minutes>0 && minutes<=MAX_DURATION_MINUTES ? minutes : null;
}
function fmtDuration(minutes,estimate=false) {
  return Number.isFinite(minutes)&&minutes>=0?formatMinutesLong(minutes):"—";
}
function fmtDate(value) {
  if(!value)return "—";
  const date=new Date(value);
  return Number.isNaN(date.getTime())?"—":date.toLocaleString("cs-CZ",{timeZone:"Europe/Prague"});
}
function exportLimit(raw,fallback,max) {
  const value=String(raw??fallback);
  if(!/^\d+$/.test(value)||Number(value)<1)throw Object.assign(new Error('bad_limit'),{status:400});
  return Math.min(Number(value),max);
}
app.get("/api/export.csv", safeRoute(async (req, res) => {
  const filters = parseFilters(req);
  const limit = exportLimit(req.query.limit,2000,5000);

  // Export musí respektovat přesně aktuální filtry z UI.
  // Žádný fallback bez filtrů – jinak uživatel dostane jiná data než vidí v tabulce.
  const rows = await getEventsFiltered(filters, limit);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.csv"`);

  const out = [];
  // BOM pro Excel
  out.push("\ufeff");
  out.push("filtry;" + csvEscape(exportFiltersLabel(filters)));
  out.push("pocet;" + csvEscape(String(rows.length)));
  out.push("");
  out.push("cas;stav;zdroj;typ;kategorie;mesto;delka;nazev;link");

  for (const r of rows) {
    const cas = csvEscape(fmtDate(r.source_updated_at || r.pub_date || r.created_at));
    const stav = csvEscape(r.status_text || (r.is_closed ? "ukoncena" : "aktivni"));
    const zdroj = csvEscape(eventSourceLabel(r));
    const typ = csvEscape(typeLabel(r.event_type || "other"));
    const mesto = csvEscape(r.city_text || r.place_text || "");
    const exportDuration=exportEventDuration(r);
    const delka = csvEscape((r.duration_is_estimate&&exportDuration!=null?'≈ ':'')+fmtDuration(exportDuration));
    const nazev = csvEscape(r.title || "");
    const link = csvEscape(r.link || "");
    const kategorie = csvEscape(r.is_jpo_event === false ? "ostatni krizova udalost" : "JPO/HZS");
    out.push([cas, stav, zdroj, typ, kategorie, mesto, delka, nazev, link].join(";"));
  }

  res.send(out.join("\n"));
}));

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

app.get("/api/export.pdf", safeRoute(async (req, res) => {
  const filters = parseFilters(req);
  const limit = exportLimit(req.query.limit,800,2000);

  // Export PDF musí respektovat přesně aktuální filtry z UI.
  // Žádný fallback bez filtrů – jinak PDF neodpovídá tabulce na webu.
  const rows = await getEventsFiltered(filters, limit);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_vyjezdy_export.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  doc.pipe(res);

  tryApplyPdfFont(doc);

  const now = new Date();
  doc.fontSize(18).fillColor("#000").text("JPO výjezdy – export");
  doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#333").text(`Vygenerováno: ${fmtDate(now)}`);
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#333").text(`Filtry: ${exportFiltersLabel(filters)}`);
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor("#333").text(`Počet záznamů v exportu: ${rows.length}`);
  doc.moveDown(0.8);

  if (rows.length === 0) {
    doc.fontSize(13).fillColor("#b45309").text("Pro aktuální filtry nebyly nalezeny žádné záznamy.");
    doc.end();
    return;
  }

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

  for (const r of rows) {
    const y = doc.y;

    const time = fmtDate(r.source_updated_at || r.pub_date || r.created_at);
    const state = r.status_text || (r.is_closed ? "UKONČENO" : "AKTIVNÍ");
    const typ = `${typeLabel(r.event_type || "other")} · ${eventSourceLabel(r)} · ${r.is_jpo_event === false ? "ostatní krizová" : "JPO/HZS"}`;
    const city = r.city_text || r.place_text || "";
    const exportDuration=exportEventDuration(r);
    const dur = (r.duration_is_estimate&&exportDuration!=null?'≈ ':'')+fmtDuration(exportDuration);
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
}));
// Legacy endpoint is read-only; individual repairs require a matching preview.
app.post('/api/admin/fix-geocode',requireAdmin,safeRoute(async(req,res)=>{
  if(req.body?.mode && req.body.mode!=='preview')return res.status(400).json({ok:false,error:'per_event_preview_required'});
  const rows=await getGeoAuditRows();res.json({ok:true,mode:'preview',processed:rows.length,cache_deleted:0,coords_cleared:0,re_geocoded:0,items:diagnoseCoordinates(rows).slice(0,200)});
}));

// Archived reports API


app.get("/api/weather/regions/anomalies", safeRoute(async (req, res) => {
  try {
    const days = Math.max(7, Math.min(Number(req.query.days || 30), 31));
    const data = await buildRegionalWeatherPayload(days);
    res.json({ ok: true, weather: data });
  } catch (e) {
    console.error("[regional-weather]", e.code || "operation_failed");
    res.status(500).json({ ok: false, error: "regional_weather_failed" });
  }
}));
app.get("/api/weather/regions/:zoneId", safeRoute(async (req, res) => {
  try {
    const days = Math.max(7, Math.min(Number(req.query.days || 30), 31));
    const data = await buildRegionalWeatherPayload(days);
    const zone = data.zones.find(z => z.zoneId === String(req.params.zoneId));
    if (!zone) return res.status(404).json({ ok: false, error: "zone_not_found" });
    res.json({ ok: true, zone, summary: data.summary, period: data.period, source: data.source });
  } catch (e) {
    console.error("[regional-weather-detail]", e.code || "operation_failed");
    res.status(500).json({ ok: false, error: "regional_weather_detail_failed" });
  }
}));

app.get("/api/analytics/regions", safeRoute(async (req, res) => {
  const end = String(req.query.end || todayPragueISO());
  const start = String(req.query.start || new Date(`${end}T00:00:00Z`).toISOString().slice(0,10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return res.status(400).json({ok:false,error:"invalid_period"});
  const startDate = new Date(`${start}T00:00:00Z`), endInclusive = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endInclusive.getTime()) || startDate > endInclusive) return res.status(400).json({ok:false,error:"invalid_period"});
  const endExclusive = new Date(endInclusive.getTime()+86400000);
  const span = endExclusive.getTime()-startDate.getTime();
  if (span > 366*86400000) return res.status(400).json({ok:false,error:"period_too_large"});
  const previousStart = new Date(startDate.getTime()-span);
  const [currentRows, previousRows, sourceStatus] = await Promise.all([
    getEventsForPeriod(start, endExclusive.toISOString().slice(0,10)),
    getEventsForPeriod(previousStart.toISOString().slice(0,10), start),
    getPublicSourceStatus()
  ]);
  res.json({ok:true,...buildRegionComparison(currentRows, previousRows, {start, end:endExclusive.toISOString(), sourceStatus})});
}));

app.get("/api/stats/pro", safeRoute(async (req, res) => {
  try {
    const preset = String(req.query.preset || "month").trim();
    const allowed = new Set(["month", "lastMonth", "week"]);
    const chosen = allowed.has(preset) ? preset : "month";
    const range = periodPresetRange(chosen);

    const [currentRows, previousRows] = await Promise.all([
      getEventsForPeriod(dateOnlyIso(range.currentStart), dateOnlyIso(range.currentEnd)),
      getEventsForPeriod(dateOnlyIso(range.previousStart), dateOnlyIso(range.previousEnd))
    ]);

    const payload = buildStatsProPayload({ preset: chosen, currentRows, previousRows, range });
    res.json({ ok: true, stats: payload });
  } catch (e) {
    console.error("[stats-pro]", e.code || "operation_failed");
    res.status(500).json({ ok: false, error: "stats_pro_failed" });
  }
}));

app.get("/api/reports", safeRoute(async (req, res) => {
  try {
    const page = await listArchivedReportsPage(req.query);
    res.json({ ok: true, ...page });
  } catch (e) {
    if(e.statusCode!==400)console.error('[reports]',e.code||'database_error');
    res.status(e.statusCode || 500).json({ ok: false, error: e.statusCode === 400 ? "bad_report_filters" : "reports_list_failed" });
  }
}));
app.post("/api/reports/generate", requireReportAuthor, safeRoute(async (req, res) => {
  try {
    const type = String(req.body?.type || req.query.type || "").trim();
    const key = String(req.body?.key || req.query.key || "").trim();
    const force = String(req.body?.force || req.query.force || "") === "1" || req.body?.force === true;

    const report = await generateArchivedReport(type, key, { force });
    res.json({ ok: true, report: reportJson(report) });
  } catch (e) {
    res.status(400).json({ ok: false, error: ['bad_period','bad_period_type','future_period'].includes(e.message) ? e.message : 'report_generate_failed' });
  }
}));
app.post("/api/reports/automation/run", requireReportAuthor, safeRoute(async (req, res) => {
  try {
    await runArchivedReportsAutomation("manual");
    const reports = await listArchivedReports({ limit: 20 });
    res.json({ ok: true, reports });
  } catch (e) {
    console.error(e.code || "operation_failed");
    res.status(500).json({ ok: false, error: "report_automation_failed" });
  }
}));

app.get(/^\/api\/reports\/([^/]+)\/(.+)\.pdf$/, safeRoute(async (req, res) => {
  try {
    const type = decodeURIComponent(req.params[0] || "");
    const key = decodeURIComponent(req.params[1] || "");

    let row = await getArchivedReport(type, key);
    if (!row) return res.status(404).json({ ok: false, error: "report_not_found" });

    res.setHeader("Content-Type", "application/pdf");
    const typeName = type === "month" ? "mesicni" : type === "week" ? "tydenni" : "denni";
    res.setHeader("Content-Disposition", `attachment; filename="firewatch-${typeName}-souhrn-${String(key).replace(/[^0-9A-Za-z-]/g,"-")}.pdf"`);

    const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: 40, bufferPages: true });
    doc.pipe(res);
    drawProfessionalReportPdf(doc, row);
    doc.end();
  } catch (e) {
    console.error(e.code || "operation_failed");
    res.status(500).send("PDF report failed");
  }
}));
app.get("/api/reports/:type/:key", safeRoute(async (req, res) => {
  try {
    if (String(req.params.key || "").endsWith(".pdf")) {
      return res.redirect(302, `/api/reports/${encodeURIComponent(req.params.type)}/${encodeURIComponent(String(req.params.key).replace(/\.pdf$/, ""))}.pdf`);
    }

    let row = await getArchivedReport(req.params.type, req.params.key);
    if (!row) return res.status(404).json({ ok: false, error: "report_not_found" });
    res.json({ ok: true, report: reportJson(row) });
  } catch (e) {
    console.error(e.code || "operation_failed");
    res.status(404).json({ ok: false, error: e?.message || "report_not_found" });
  }
}));


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

app.use((error,req,res,next)=>{
  if(res.headersSent)return next(error);
  const status=error.status===413?413:error.status===400?400:500;
  if(status===500)console.error('[api]',error.code||'request_failed');
  res.status(status).json({ok:false,error:status===413?'payload_too_large':status===400?'bad_request':'request_failed'});
});

async function initDbWithRetry() {
  let attempt = 0;
  while (true) {
    try {
      await initDb();
      const dbTimeZone=(await pool.query("SHOW timezone")).rows[0];
      console.info("[time]",JSON.stringify({storage_timezone:dbTimeZone?.TimeZone || dbTimeZone?.timezone,display_timezone:"Europe/Prague",server_timezone:process.env.TZ || "unset"}));
      return;
    } catch (e) {
      attempt++;
      const waitMs = Math.min(30000, Math.round(1000 * Math.pow(1.6, attempt)));
      console.error(`[db] init failed (attempt ${attempt}) - retry in ${Math.round(waitMs / 1000)}s:`, e?.message || e);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}


export async function startServer() {
  geocodeJobsActive=true;
await initDbWithRetry();
await ensureInitialAdmin();

// start stale closer loop (ESP-only)
await runStaleAutoClose();
const staleCloseTimer = setInterval(runStaleAutoClose, STALE_CLOSE_INTERVAL_MS);

// archived analytical reports automation
await runArchivedReportsAutomation("startup");
const reportsTimer = setInterval(() => runArchivedReportsAutomation("interval"), 6 * 60 * 60 * 1000);

const server = http.createServer(app);
attachOpsRadio(server);

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, () => {
    server.off("error", reject);
    console.log(`listening on ${port}`);
    resolve();
  });
});

// Reuse the exact ESP ingest pipeline without making an HTTP request back to
// this application. This keeps status, duration, geocoding and deduplication
// behavior identical for both sources.
async function ingestRssItems(items, source = "server_rss_worker") {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const req = {
      body: { source, items },
      headers: {},
      socket: { remoteAddress: "internal" },
      get: () => "FirewatchCZ-RSS-Worker/1.0"
    };
    const res = {
      status(code) { statusCode = code; return this; },
      json(payload) {
        if (statusCode >= 400 || payload?.ok === false) {
          reject(new Error(payload?.detail || payload?.error || `Internal ingest failed (${statusCode})`));
        } else {
          resolve(payload);
        }
        return this;
      }
    };
    Promise.resolve(handleIngest(req, res)).catch(reject);
  });
}

rssWorker = createRssWorker({
  config: readRssConfig(),
  ingestItems: ingestRssItems,
  acquireLock: acquireRssWorkerLock
});
rssWorker.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}; stopping scheduled work`);
  rssWorker?.stop();
  geocodeJobs.stop();
  clearInterval(staleCloseTimer);
  clearInterval(reportsTimer);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(forceExit);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

return { server, rssWorker };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startServer();
}

export { normalizeFeedTimestamp, pragueLocalToUtcIso, parseTimesFromDescription, safeDurationFromStartEnd, reportPeriodFromKey, buildAnalyticalReport, buildRegionComparison, drawProfessionalReportPdf };
