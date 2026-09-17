import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetch as undiciFetch } from "undici";
import { DEFAULT_RSS_URL, fetchRssDetailed, parseRssXml, sanitizeRssError } from "../rss-worker.js";

export function buildRssPayload(xml) {
  return { source: "github_actions_rss", items: parseRssXml(xml, { maxItems: 100 }) };
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
  if (!ingestUrl || !apiKey) throw safeFailure("missing_configuration");
  let parsed;
  try { parsed = new URL(ingestUrl); } catch { throw safeFailure("invalid_ingest_url"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw safeFailure("invalid_ingest_url");
  }
  return { ingestUrl, apiKey };
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
  ingestFetchImpl = undiciFetch, sleepImpl, agentFactory, ingestTimeoutMs = 60_000
} = {}) {
  let stage = "configuration";
  try {
    const config = readPushConfig(env);
    stage = "rss";
    const rss = await fetchRssDetailed(DEFAULT_RSS_URL, {
      fetchImpl: rssFetchImpl, timeoutMs: 30_000, connectTimeoutMs: 30_000,
      sleepImpl, agentFactory
    });
    const payload = buildRssPayload(rss.xml);
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
    const counters = [data?.accepted, data?.inserted, data?.updated];
    if (data?.ok !== true || counters.some(n => !Number.isSafeInteger(n) || n < 0)) {
      throw safeFailure("invalid_ingest_response", result.httpStatus);
    }
    logger.info(`[rss-push] accepted=${data.accepted}; inserted=${data.inserted}; updated=${data.updated}`);
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
