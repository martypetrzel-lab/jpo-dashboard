import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetch as undiciFetch } from "undici";
import { DEFAULT_RSS_URL, fetchRssDetailed, parseRssXml, rssItemToEvent, sanitizeRssError } from "../rss-worker.js";

export const RSS2JSON_URL = "https://api.rss2json.com/v1/api.json";

export function buildRssPayload(xml) {
  return { source: "github_actions_rss", items: parseRssXml(xml, { maxItems: 100 }) };
}

export function buildGatewayPayload(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  if (data?.status !== "ok" || !Array.isArray(data?.items)) throw safeFailure("invalid_gateway_response");
  return {
    source: "github_actions_rss2json",
    // The unauthenticated rss2json endpoint returns the newest 10 entries.
    items: data.items.slice(0, 100).map((item) => rssItemToEvent({
      title: item?.title,
      link: item?.link,
      guid: item?.guid,
      pubDate: item?.pubDate,
      description: item?.description || item?.content || ""
    }))
  };
}

export function gatewayUrl(nowMs = Date.now(), rss2jsonApiKey = "") {
  // A five-minute bucket keeps the fallback fresh without creating a unique
  // upstream URL on every retry.
  const bucket = Math.floor(nowMs / 300_000);
  const source = `${DEFAULT_RSS_URL}?fw_bucket=${bucket}`;
  const params = new URLSearchParams({ rss_url: source });
  if (rss2jsonApiKey) {
    params.set("api_key", rss2jsonApiKey);
    params.set("count", "100");
    params.set("order_by", "pubDate");
    params.set("order_dir", "desc");
  }
  return `${RSS2JSON_URL}?${params.toString()}`;
}

function safeFailure(type, httpStatus = null) {
  const error = new Error(type);
  error.rssType = type;
  if (httpStatus != null) error.rssHttpStatus = httpStatus;
  return error;
}

export function readPushConfig(env = process.env) {
  const ingestUrl = String(env.FIREWATCH_INGEST_URL || "").trim();
  const apiKey = String(env.FIREWATCH_API_KEY || "").trim();
  const rss2jsonApiKey = String(env.RSS2JSON_API_KEY || "").trim();
  if (!ingestUrl || !apiKey) throw safeFailure("missing_configuration");
  let parsed;
  try { parsed = new URL(ingestUrl); } catch { throw safeFailure("invalid_ingest_url"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw safeFailure("invalid_ingest_url");
  }
  return { ingestUrl, apiKey, rss2jsonApiKey };
}

export async function pushRssItems(payload, config, {
  fetchImpl = undiciFetch, sleepImpl, agentFactory, timeoutMs = 60_000
} = {}) {
  // Reuse bounded downloads, per-attempt timeout, two attempts and Agent cleanup.
  // Do not follow redirects carrying the API key to another destination.
  const result = await fetchRssDetailed(config.ingestUrl, {
    timeoutMs, connectTimeoutMs: 30_000, maxResponseBytes: 64 * 1024,
    sleepImpl, agentFactory,
    fetchImpl: (url, options) => fetchImpl(url, {
      ...options, method: "POST", redirect: "manual",
      headers: {
        ...options.headers, Accept: "application/json", "Content-Type": "application/json",
        "X-API-Key": config.apiKey
      },
      body: JSON.stringify(payload)
    })
  });
  return result;
}

export async function runRssPush({
  env = process.env, logger = console, rssFetchImpl = undiciFetch,
  gatewayFetchImpl = undiciFetch, ingestFetchImpl = undiciFetch, sleepImpl,
  agentFactory, ingestTimeoutMs = 60_000, nowMs = Date.now()
} = {}) {
  let stage = "configuration";
  try {
    const config = readPushConfig(env);
    stage = "rss";
    let payload;
    try {
      const rss = await fetchRssDetailed(DEFAULT_RSS_URL, {
        fetchImpl: rssFetchImpl, timeoutMs: 30_000, connectTimeoutMs: 30_000,
        sleepImpl, agentFactory
      });
      payload = buildRssPayload(rss.xml);
    } catch (directError) {
      const safe = sanitizeRssError(directError);
      logger.info(`[rss-push] direct RSS unavailable; fallback=rss2json; category=${safe.type}`);
      stage = "rss_gateway";
      const gateway = await fetchRssDetailed(gatewayUrl(nowMs, config.rss2jsonApiKey), {
        fetchImpl: gatewayFetchImpl, timeoutMs: 30_000, connectTimeoutMs: 30_000,
        sleepImpl, agentFactory
      });
      payload = buildGatewayPayload(gateway.xml);
    }
    logger.info(`[rss-push] RSS items=${payload.items.length}`);
    if (payload.items.length === 0) {
      logger.info("[rss-push] ingest skipped: empty feed; accepted=0; inserted=0; updated=0");
      return true;
    }
    stage = "ingest";
    const result = await pushRssItems(payload, config, {
      fetchImpl: ingestFetchImpl, sleepImpl, agentFactory, timeoutMs: ingestTimeoutMs
    });
    logger.info(`[rss-push] ingest HTTP status=${result.httpStatus}`);
    let data;
    try { data = JSON.parse(result.xml); } catch { throw safeFailure("invalid_ingest_response", result.httpStatus); }
    const counters = [data?.accepted, data?.inserted, data?.updated, data?.skipped ?? 0, data?.skipped_older ?? 0];
    if (data?.ok !== true || counters.some(n => !Number.isSafeInteger(n) || n < 0)) {
      throw safeFailure("invalid_ingest_response", result.httpStatus);
    }
    logger.info(`[rss-push] accepted=${data.accepted}; inserted=${data.inserted}; updated=${data.updated}; skipped=${data.skipped ?? 0}; skipped_older=${data.skipped_older ?? 0}`);
    return true;
  } catch (error) {
    const safe = sanitizeRssError(error);
    logger.error(`[rss-push] failed; stage=${stage}; category=${safe.type}; HTTP status=${safe.httpStatus ?? "none"}`);
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!await runRssPush()) process.exitCode = 1;
}
