import crypto from "crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const DEFAULT_RSS_URL = "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml";
export const MIN_INTERVAL_MS = 30_000;
export const MAX_ITEMS_LIMIT = 200;
export const DEFAULT_TIMEOUT_MS = 20_000;
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

export function parseRssXml(xml, { maxItems = 35 } = {}) {
  const input = String(xml || "");
  const validation = XMLValidator.validate(input);
  if (validation !== true) throw new Error(`Invalid RSS XML: ${validation.err?.msg || "validation failed"}`);
  const document = parser.parse(input);
  const channel = document?.rss?.channel;
  if (!channel) throw new Error("Invalid RSS XML: rss/channel missing");
  const rawItems = channel.item == null ? [] : (Array.isArray(channel.item) ? channel.item : [channel.item]);
  return rawItems.slice(0, Math.max(0, maxItems)).map(rssItemToEvent);
}

export async function fetchRss(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  userAgent = "FirewatchCZ-RSS-Worker/1.0 (+https://firewatchcz.cz)"
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("RSS request timeout")), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8", "User-Agent": userAgent }
    });
    if (!response?.ok) throw new Error(`RSS HTTP ${response?.status ?? "unknown"}`);
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > maxResponseBytes) throw new Error(`RSS response too large (${declaredLength} bytes)`);

    if (!response.body?.getReader) {
      const text = await response.text();
      if (Buffer.byteLength(text) > maxResponseBytes) throw new Error("RSS response too large");
      return text;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error("RSS response too large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) throw new Error("RSS request timeout");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createRssWorker({ config = readRssConfig(), ingestItems, acquireLock, fetchImpl, logger = console } = {}) {
  if (typeof ingestItems !== "function") throw new TypeError("ingestItems must be a function");
  let timer = null;
  let stopped = true;
  let inFlight = false;
  const state = {
    enabled: config.enabled,
    running: false,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastFetchedItems: 0,
    lastInsertedOrUpdated: 0,
    lastSkipped: 0,
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
      const xml = await fetchRss(config.url, { fetchImpl, timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes });
      const items = parseRssXml(xml, { maxItems: config.maxItems });
      const result = await ingestItems(items, "server_rss_worker");
      state.lastFetchedItems = items.length;
      state.lastInsertedOrUpdated = Number(result?.inserted || 0) + Number(result?.updated || 0);
      state.lastSkipped = Math.max(0, items.length - Number(result?.accepted || 0));
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      logger.info?.(`[rss-worker] cycle OK in ${Date.now() - started}ms; fetched=${items.length}; upserted=${state.lastInsertedOrUpdated}; skipped=${state.lastSkipped}`);
    } catch (error) {
      state.lastError = String(error?.message || error).slice(0, 1000);
      logger.error?.(`[rss-worker] cycle failed in ${Date.now() - started}ms: ${state.lastError}`);
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
