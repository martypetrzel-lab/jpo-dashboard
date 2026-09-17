import crypto from "crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fetch as undiciFetch, Agent, ProxyAgent } from "undici";

export const DEFAULT_RSS_URL = "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml";
export const MIN_INTERVAL_MS = 30_000;
export const MAX_ITEMS_LIMIT = 200;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const RSS_RETRY_DELAY_MS = 1_500;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: true,
  trimValues: true,
  parseTagValue: false,
  cdataPropName: "#cdata"
});

function envFlag(value, fallback) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function readRssConfig(env = process.env) {
  return {
    enabled: envFlag(env.RSS_ENABLED, true),
    url: String(env.RSS_URL || "").trim() || DEFAULT_RSS_URL,
    intervalMs: boundedInt(env.RSS_INTERVAL_MS, 60_000, MIN_INTERVAL_MS, 24 * 60 * 60 * 1000),
    maxItems: boundedInt(env.RSS_MAX_ITEMS, 35, 1, MAX_ITEMS_LIMIT),
    runOnStart: envFlag(env.RSS_RUN_ON_START, true),
    proxyUrl: String(env.RSS_PROXY_URL || "").trim(),
    connectTimeoutMs: boundedInt(env.RSS_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS, 5_000, 120_000),
    timeoutMs: boundedInt(env.RSS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000),
    maxResponseBytes: boundedInt(env.RSS_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES, 64 * 1024, 10 * 1024 * 1024)
  };
}

function textValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return textValue(value[0]);
  if (typeof value === "object") return textValue(value["#cdata"] ?? value["#text"] ?? "");
  return decodeHtmlEntities(String(value)).trim();
}

export function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

export function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function descriptionLines(description) {
  return String(description || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => stripHtml(line).trim())
    .filter(Boolean);
}

export function extractStatus(description) {
  const line = descriptionLines(description).find((entry) => /^stav\s*:/i.test(entry));
  return line ? line.replace(/^stav\s*:/i, "").trim() : "";
}

export function extractCity(description) {
  return descriptionLines(description).find((line) =>
    !/^stav\s*:/i.test(line) &&
    !/^ukon(?:čení|ceni)\s*:/i.test(line) &&
    !/^okres\s+/i.test(line)
  ) || "";
}

export function classifyEventType(title) {
  const value = String(title || "").toLocaleLowerCase("cs");
  if (value.includes("požár") || value.includes("pozar")) return "fire";
  if (value.includes("doprav") || value.includes("nehoda")) return "traffic";
  if (value.includes("technick") || value.includes("nebezpeč") || value.includes("nebezpec")) return "tech";
  if (value.includes("záchrana") || value.includes("zachrana") || value.includes("transport")) return "rescue";
  if (value.includes("planý poplach") || value.includes("plany poplach")) return "false_alarm";
  return "other";
}

export function stableEventId({ guid, link, title, pubDate }) {
  const guidText = textValue(guid);
  if (guidText) return guidText;
  const linkText = textValue(link);
  const digits = linkText.replace(/\D/g, "");
  if (digits) return `RSS_FEED_${digits}`;
  const hash = crypto.createHash("sha256").update(`${linkText}\n${textValue(title)}\n${textValue(pubDate)}`).digest("hex").slice(0, 24);
  return `RSS_FEED_${hash}`;
}

export function rssItemToEvent(item = {}) {
  const title = textValue(item.title);
  const link = textValue(item.link);
  const pubDate = textValue(item.pubDate);
  const descriptionRaw = textValue(item.description);
  const cityText = extractCity(descriptionRaw);
  return {
    id: stableEventId({ guid: item.guid, link, title, pubDate }),
    title,
    link,
    pubDate,
    descriptionRaw,
    descriptionText: stripHtml(descriptionRaw),
    statusText: extractStatus(descriptionRaw),
    placeText: cityText,
    cityText,
    eventType: classifyEventType(title)
  };
}

function pragueDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function rssDateKeyInPrague(value) {
  const raw = textValue(value);
  if (!raw) return null;
  // rss2json returns a local timestamp without a timezone. Preserve its calendar day.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : pragueDateKey(parsed);
}

export function shouldIngestRssItemForToday(item = {}, { previouslyKnown = false, now = new Date() } = {}) {
  const itemDay = rssDateKeyInPrague(item.pubDate || item.pub_date || item.startTimeIso || item.start_time_iso);
  const today = pragueDateKey(now instanceof Date ? now : new Date(now));
  if (!itemDay) return previouslyKnown;
  if (itemDay === today) return true;
  if (itemDay > today) return false;
  if (previouslyKnown) return true; // allow an older carry-over event to receive its closing update

  const status = `${item.statusText || item.status_text || ""} ${item.descriptionRaw || item.description || ""}`
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const explicitlyClosed = /ukoncen|likvidace\s+ukoncena/.test(status);
  const explicitlyOpen = /stav\s*:\s*(nova|novy|neupresnen)|probiha(?:jici)?(?:\s+zasah)?/.test(status);
  return !explicitlyClosed && explicitlyOpen;
}

export function parseRssXml(xml, { maxItems = 35 } = {}) {
  const input = String(xml || "");
  const validation = XMLValidator.validate(input);
  if (validation !== true) throw rssError("invalid_xml");
  const document = parser.parse(input);
  const channel = document?.rss?.channel;
  if (!channel) throw rssError("invalid_xml");
  const rawItems = channel.item == null ? [] : (Array.isArray(channel.item) ? channel.item : [channel.item]);
  return rawItems.slice(0, Math.max(0, maxItems)).map(rssItemToEvent);
}

function errorCodes(error) {
  const codes = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code) codes.push(String(current.code).toUpperCase());
    current = current.cause;
  }
  return codes;
}

export function sanitizeRssError(error, durationMs = null) {
  const codes = errorCodes(error);
  const httpStatus = Number.isFinite(Number(error?.rssHttpStatus)) ? Number(error.rssHttpStatus) : null;
  let type = error?.rssType || "network_error";
  if (httpStatus === 407) type = "proxy_authentication";
  else if (error?.rssType === "http_status") type = "http_status";
  else if (error?.rssType) type = error.rssType;
  else if (error?.name === "AbortError" || codes.includes("ABORT_ERR") || codes.includes("UND_ERR_ABORTED")) type = "timeout";
  else if (codes.some((code) => ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code))) type = "dns";
  else if (codes.includes("UND_ERR_CONNECT_TIMEOUT")) type = "connect_timeout";
  else if (codes.includes("ECONNREFUSED")) type = "connection_refused";
  else if (codes.some((code) => code.includes("CERT") || code.includes("TLS") || code.includes("SSL"))) type = "tls";

  const messages = {
    dns: "DNS lookup failed",
    timeout: "RSS request timed out (overall timeout)",
    connect_timeout: "RSS connection timed out",
    connection_refused: "Connection refused",
    tls: "TLS connection failed",
    http_status: "RSS server returned an HTTP error",
    proxy_authentication: "Proxy authentication failed",
    invalid_xml: "RSS response is not valid XML",
    response_too_large: "RSS response exceeded the size limit",
    invalid_proxy: "Proxy configuration is invalid",
    network_error: "RSS network request failed"
  };
  return {
    type,
    httpStatus,
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    message: messages[type] || messages.network_error
  };
}

function rssError(type, httpStatus = null) {
  const error = new Error(type);
  error.rssType = type;
  if (httpStatus != null) error.rssHttpStatus = httpStatus;
  return error;
}

export async function fetchRssDetailed(url, options = {}) {
  const started = Date.now();
  const sleepImpl = options.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fetchRssAttempt(url, options);
      return { ...result, durationMs: Date.now() - started };
    } catch (error) {
      const safe = sanitizeRssError(error);
      const retryable = ["network_error", "dns", "connection_refused", "connect_timeout", "timeout"].includes(safe.type)
        || (safe.type === "http_status" && safe.httpStatus >= 500 && safe.httpStatus <= 599);
      if (attempt === 2 || !retryable) throw error;
      await sleepImpl(RSS_RETRY_DELAY_MS);
    }
  }
}

async function fetchRssAttempt(url, {
  fetchImpl = undiciFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  agentFactory = (options) => new Agent(options),
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  userAgent = "FirewatchCZ-RSS-Worker/1.0 (+https://firewatchcz.cz)",
  proxyUrl = "",
  proxyAgentFactory = (uri) => new ProxyAgent(uri)
} = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher = null;
  let response = null;
  let reader = null;
  try {
    if (proxyUrl) {
      try {
        dispatcher = proxyAgentFactory(proxyUrl);
      } catch {
        throw rssError("invalid_proxy");
      }
    } else {
      dispatcher = agentFactory({ connectTimeout: boundedInt(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 5_000, 120_000) });
    }
    const requestOptions = {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8", "User-Agent": userAgent }
    };
    if (dispatcher) requestOptions.dispatcher = dispatcher;
    response = await fetchImpl(url, requestOptions);
    if (!response?.ok) throw rssError(response?.status === 407 ? "proxy_authentication" : "http_status", response?.status ?? null);
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > maxResponseBytes) throw rssError("response_too_large", response.status);

    if (!response.body?.getReader) {
      const text = await response.text();
      const responseBytes = Buffer.byteLength(text);
      if (responseBytes > maxResponseBytes) throw rssError("response_too_large", response.status);
      return { xml: text, httpStatus: response.status, responseBytes, durationMs: Date.now() - started };
    }

    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw rssError("response_too_large", response.status);
      }
      chunks.push(Buffer.from(value));
    }
    return { xml: Buffer.concat(chunks).toString("utf8"), httpStatus: response.status, responseBytes: bytes, durationMs: Date.now() - started };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = rssError("timeout");
      timeoutError.name = "AbortError";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    // Cancel unread bodies before closing: graceful close otherwise waits for them.
    try {
      if (reader) await reader.cancel();
      else await response?.body?.cancel?.();
    } catch {}
    try { await dispatcher?.close?.(); } catch {}
  }
}

export async function fetchRss(url, options = {}) {
  const result = await fetchRssDetailed(url, options);
  return result.xml;
}

export async function testRssConnection(config = readRssConfig(), options = {}) {
  const started = Date.now();
  try {
    const result = await fetchRssDetailed(config.url, {
      fetchImpl: options.fetchImpl,
      agentFactory: options.agentFactory,
      sleepImpl: options.sleepImpl,
      connectTimeoutMs: config.connectTimeoutMs,
      proxyAgentFactory: options.proxyAgentFactory,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      proxyUrl: config.proxyUrl
    });
    let items;
    try {
      items = parseRssXml(result.xml, { maxItems: config.maxItems });
    } catch {
      throw rssError("invalid_xml", result.httpStatus);
    }
    return {
      success: true,
      httpStatus: result.httpStatus,
      responseBytes: result.responseBytes,
      itemCount: items.length,
      durationMs: result.durationMs,
      error: null
    };
  } catch (error) {
    const safeError = sanitizeRssError(error, Date.now() - started);
    return {
      success: false,
      httpStatus: safeError.httpStatus,
      responseBytes: 0,
      itemCount: 0,
      durationMs: safeError.durationMs,
      error: safeError
    };
  }
}

export function createRssWorker({ config = readRssConfig(), ingestItems, acquireLock, fetchImpl, logger = console } = {}) {
  if (typeof ingestItems !== "function") throw new TypeError("ingestItems must be a function");
  let timer = null;
  let stopped = true;
  let inFlight = false;
  const state = {
    enabled: config.enabled,
    proxyEnabled: !!config.proxyUrl,
    running: false,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastFetchedItems: 0,
    lastInsertedOrUpdated: 0,
    lastSkipped: 0,
    lastHttpStatus: null,
    lastResponseBytes: 0,
    lastDurationMs: null,
    totalRuns: 0
  };

  const snapshot = () => ({ ...state });
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!stopped && config.enabled) timer = setTimeout(runOnce, config.intervalMs);
  };

  async function runOnce() {
    if (stopped || !config.enabled || inFlight) return snapshot();
    inFlight = true;
    state.running = true;
    state.lastRunStartedAt = new Date().toISOString();
    state.totalRuns++;
    const started = Date.now();
    let releaseLock = null;
    try {
      releaseLock = acquireLock ? await acquireLock() : async () => {};
      if (!releaseLock) {
        state.lastSkipped = 1;
        logger.info?.("[rss-worker] cycle skipped: advisory lock held by another instance");
        return snapshot();
      }
      const fetchResult = await fetchRssDetailed(config.url, { fetchImpl, connectTimeoutMs: config.connectTimeoutMs, timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes, proxyUrl: config.proxyUrl });
      const xml = fetchResult.xml;
      const items = parseRssXml(xml, { maxItems: config.maxItems });
      const result = await ingestItems(items, "server_rss_worker");
      state.lastFetchedItems = items.length;
      state.lastHttpStatus = fetchResult.httpStatus;
      state.lastResponseBytes = fetchResult.responseBytes;
      state.lastDurationMs = Date.now() - started;
      state.lastInsertedOrUpdated = Number(result?.inserted || 0) + Number(result?.updated || 0);
      state.lastSkipped = Math.max(0, items.length - Number(result?.accepted || 0));
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      logger.info?.(`[rss-worker] cycle OK in ${Date.now() - started}ms; http=${fetchResult.httpStatus}; bytes=${fetchResult.responseBytes}; fetched=${items.length}; upserted=${state.lastInsertedOrUpdated}; skipped=${state.lastSkipped}`);
    } catch (error) {
      state.lastError = sanitizeRssError(error, Date.now() - started);
      state.lastHttpStatus = state.lastError.httpStatus;
      state.lastResponseBytes = 0;
      state.lastDurationMs = state.lastError.durationMs;
      logger.error?.(`[rss-worker] cycle failed; type=${state.lastError.type}; http=${state.lastError.httpStatus ?? "none"}; durationMs=${state.lastError.durationMs}`);
    } finally {
      try { await releaseLock?.(); } catch (error) { logger.error?.("[rss-worker] advisory unlock failed:", error?.message || error); }
      state.running = false;
      state.lastRunFinishedAt = new Date().toISOString();
      inFlight = false;
      schedule();
    }
    return snapshot();
  }

  function start() {
    if (!config.enabled) {
      logger.info?.("[rss-worker] disabled by RSS_ENABLED=0");
      return false;
    }
    if (!stopped) return true;
    stopped = false;
    if (config.runOnStart) void runOnce(); else schedule();
    logger.info?.(`[rss-worker] started; interval=${config.intervalMs}ms; maxItems=${config.maxItems}`);
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { start, stop, runOnce, getState: snapshot };
}
