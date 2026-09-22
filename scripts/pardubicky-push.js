import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetch as undiciFetch } from "undici";
import { fetchRssDetailed, sanitizeRssError } from "../rss-worker.js";
import {
  PARDUBICKY_RSS_URL, parsePardubickyRss, parsePardubickyDetail,
  buildPardubickyEvent, pardubickyAgeClass,
} from "../pardubicky-rss.js";
import { pushRssItems, readPushConfig } from "./rss-push.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const boundedDelay = value => Math.max(0, Math.min(Number.parseInt(String(value ?? "250"), 10) || 250, 2000));

async function postJson(url, body, config, { fetchImpl = undiciFetch, sleepImpl, agentFactory } = {}) {
  const result = await fetchRssDetailed(url, {
    fetchImpl: (target, options) => fetchImpl(target, { ...options, method: "POST", redirect: "manual", headers: { ...options.headers, Accept: "application/json", "Content-Type": "application/json", "X-API-Key": config.apiKey }, body: JSON.stringify(body) }),
    timeoutMs: 30_000, connectTimeoutMs: 20_000, maxResponseBytes: 256 * 1024, sleepImpl, agentFactory,
  });
  try { return JSON.parse(result.xml); } catch { throw Object.assign(new Error("invalid_source_state"), { rssType: "invalid_ingest_response" }); }
}

export function sourceStateUrl(ingestUrl) {
  const url = new URL(ingestUrl);
  url.pathname = url.pathname.replace(/\/$/, "") + "/source-state";
  return url.href;
}

export async function runPardubickyPush({
  env = process.env, logger = console, rssFetchImpl = undiciFetch, detailFetchImpl = undiciFetch,
  stateFetchImpl = undiciFetch, ingestFetchImpl = undiciFetch, sleepImpl, delayImpl = pause,
  agentFactory, now = new Date(), startedAt = Date.now(),
} = {}) {
  const dryRun = String(env.PARDUBICKY_DRY_RUN || "") === "1";
  let stage = "configuration", found = 0, detailErrors = 0;
  try {
    const config = dryRun ? null : readPushConfig(env);
    stage = "rss";
    const feedResult = await fetchRssDetailed(PARDUBICKY_RSS_URL, { fetchImpl: rssFetchImpl, timeoutMs: 30_000, connectTimeoutMs: 20_000, sleepImpl, agentFactory });
    const feedItems = parsePardubickyRss(feedResult.xml, { maxItems: 100 });
    found = feedItems.length;

    let state = { known: [], open: [] };
    if (!dryRun) {
      stage = "source_state";
      state = await postJson(sourceStateUrl(config.ingestUrl), { source: "pardubicky", external_ids: feedItems.map(item => item.externalId) }, config, { fetchImpl: stateFetchImpl, sleepImpl, agentFactory });
      if (state?.ok !== true || !Array.isArray(state.known) || !Array.isArray(state.open)) throw Object.assign(new Error("invalid_source_state"), { rssType: "invalid_ingest_response" });
    }

    const known = new Map(state.known.map(item => [String(item.external_id), item]));
    const feedById = new Map(feedItems.map(item => [item.externalId, item]));
    const candidates = new Map();
    for (const item of feedItems) {
      const age = pardubickyAgeClass(item, now);
      if (!known.has(item.externalId) && (age === "today" || age === "yesterday")) candidates.set(item.externalId, item);
    }
    for (const stored of state.open) {
      const id = String(stored.external_id);
      candidates.set(id, feedById.get(id) || {
        id: stored.id, source: "pardubicky", externalId: id, sourceUrl: stored.source_url,
        link: stored.source_url, title: stored.title || stored.city_text || `Událost ${id}`,
        cityText: stored.city_text || "", cityPart: null,
        reportedAt: stored.reported_at || stored.pub_date, pubDate: stored.reported_at || stored.pub_date,
        typeHint: null, eventType: "other", description: null,
      });
    }

    stage = "details";
    const events = [];
    let skippedOld = feedItems.filter(item => pardubickyAgeClass(item, now) === "older" && !known.has(item.externalId)).length;
    const delayMs = boundedDelay(env.PARDUBICKY_DETAIL_DELAY_MS);
    let position = 0;
    for (const item of candidates.values()) {
      if (position++ > 0 && delayMs) await delayImpl(delayMs);
      try {
        const detailResult = await fetchRssDetailed(item.sourceUrl, { fetchImpl: detailFetchImpl, timeoutMs: 20_000, connectTimeoutMs: 15_000, maxResponseBytes: 512 * 1024, sleepImpl, agentFactory });
        const detail = parsePardubickyDetail(detailResult.xml);
        const age = pardubickyAgeClass(item, now);
        if (!known.has(item.externalId) && age === "yesterday" && !detail.isOpen) { skippedOld++; continue; }
        events.push(buildPardubickyEvent(item, detail, { observedAt: new Date().toISOString() }));
      } catch (error) {
        detailErrors++;
        logger.error(`[pardubicky-push] detail failed; id=${item.externalId}; category=${sanitizeRssError(error).type}`);
      }
    }

    const newCandidates = events.filter(item => !known.has(item.externalId)).length;
    const updatedCandidates = events.length - newCandidates;
    if (dryRun) {
      logger.info(`[pardubicky-push] dry-run; found=${found}; details=${events.length}; new=${newCandidates}; updated_candidates=${updatedCandidates}; skipped_old=${skippedOld}; detail_errors=${detailErrors}; duration_ms=${Date.now()-startedAt}`);
      return true;
    }
    if (!events.length) {
      logger.info(`[pardubicky-push] found=${found}; new=0; updated=0; status_changed=0; unchanged=0; skipped_old=${skippedOld}; detail_errors=${detailErrors}; geocode_errors=0; duration_ms=${Date.now()-startedAt}`);
      return detailErrors === 0;
    }
    stage = "ingest";
    const result = await pushRssItems({ source: "github_actions_pardubicky_rss", items: events }, config, { fetchImpl: ingestFetchImpl, sleepImpl, agentFactory, timeoutMs: 60_000 });
    const data = JSON.parse(result.xml);
    if (data?.ok !== true) throw Object.assign(new Error("invalid_ingest_response"), { rssType: "invalid_ingest_response", rssHttpStatus: result.httpStatus });
    logger.info(`[pardubicky-push] found=${found}; HTTP status=${result.httpStatus}; new=${data.inserted||0}; updated=${data.updated||0}; status_changed=${data.status_changed||0}; unchanged=${data.unchanged||0}; skipped_old=${Number(data.skipped_older||0)+skippedOld}; detail_errors=${detailErrors}; geocode_errors=${data.geocode_errors||0}; duration_ms=${Date.now()-startedAt}`);
    return true;
  } catch (error) {
    const safe = sanitizeRssError(error);
    logger.error(`[pardubicky-push] failed; stage=${stage}; found=${found}; category=${safe.type}; HTTP status=${safe.httpStatus??"none"}; detail_errors=${detailErrors}; duration_ms=${Date.now()-startedAt}`);
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!await runPardubickyPush()) process.exitCode = 1;
}
