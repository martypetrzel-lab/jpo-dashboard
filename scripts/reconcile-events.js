import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetch as undiciFetch } from "undici";
import { fetchRssDetailed, sanitizeRssError } from "../rss-worker.js";
import { buildSourceAdapters } from "../reconciliation.js";
import { PRAHA_ATOM_URL } from "../prague-atom.js";
import { readPushConfig } from "./rss-push.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validScopes = new Set(["active", "recent48", "last7", "last30", "full"]);
const validSources = new Set(["all", "stredocesky", "pardubicky", "praha"]);

export function reconciliationApiUrl(ingestUrl, path) {
  const url = new URL(ingestUrl);
  url.pathname = url.pathname.replace(/\/api\/ingest\/?$/, "") + path;
  url.search = "";
  return url.href;
}

async function postApi(config, path, body, { fetchImpl = undiciFetch, sleepImpl, agentFactory } = {}) {
  const result = await fetchRssDetailed(reconciliationApiUrl(config.ingestUrl, path), {
    timeoutMs: 60_000, connectTimeoutMs: 30_000, maxResponseBytes: 1024 * 1024,
    sleepImpl, agentFactory,
    fetchImpl: (url, options) => fetchImpl(url, {
      ...options, method: "POST", redirect: "manual",
      headers: { ...options.headers, Accept: "application/json", "Content-Type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify(body),
    }),
  });
  try { return JSON.parse(result.xml); }
  catch { throw Object.assign(new Error("invalid_reconciliation_response"), { rssType: "invalid_ingest_response" }); }
}

export function createSourceTextFetcher({ fetchImpl = undiciFetch, sleepImpl, agentFactory } = {}) {
  return async url => {
    const result = await fetchRssDetailed(url, {
      fetchImpl, sleepImpl, agentFactory, timeoutMs: 30_000, connectTimeoutMs: 20_000,
      maxResponseBytes: 1024 * 1024,
    });
    return { body: result.xml, status: result.httpStatus };
  };
}

export async function runReconciliation({
  env = process.env, logger = console, fetchImpl = undiciFetch, sleepImpl, delayImpl = pause,
  agentFactory, startedAt = Date.now(),
} = {}) {
  let job = null;
  const counters = { fetched: 0, checked: 0, updated: 0, status_changes: 0, unchanged: 0, stale: 0, skipped: 0, failed: 0, missing: 0 };
  try {
    const config = readPushConfig(env);
    const scope = validScopes.has(String(env.RECONCILE_SCOPE || "")) ? String(env.RECONCILE_SCOPE) : "active";
    const source = validSources.has(String(env.RECONCILE_SOURCE || "")) ? String(env.RECONCILE_SOURCE) : "all";
    const dryRun = String(env.RECONCILE_DRY_RUN || "") === "1";
    const batchSize = Math.max(1, Math.min(100, Number.parseInt(String(env.RECONCILE_BATCH_SIZE || "40"), 10) || 40));
    const delayMs = Math.max(100, Math.min(2000, Number.parseInt(String(env.RECONCILE_DELAY_MS || "250"), 10) || 250));
    const claimed = await postApi(config, "/api/reconciliation/jobs/claim", { job_id: env.RECONCILE_JOB_ID || null, source, scope, dry_run: dryRun }, { fetchImpl, sleepImpl, agentFactory });
    if (claimed?.ok !== true || !claimed.job?.id) throw Object.assign(new Error("job_claim_failed"), { rssType: "invalid_ingest_response" });
    job = claimed.job;
    const fetchText = createSourceTextFetcher({ fetchImpl, sleepImpl, agentFactory });
    const adapters = buildSourceAdapters({ fetchText });
    let prahaById = null;
    while (true) {
      const page = await postApi(config, "/api/reconciliation/candidates", { job_id: job.id, limit: batchSize }, { fetchImpl, sleepImpl, agentFactory });
      if (page?.error === "job_paused") {
        logger.info(`[reconciliation] source=${job.source}; job_type=${job.scope}; paused=true; checked=${counters.checked}`);
        return true;
      }
      if (page?.ok !== true || !Array.isArray(page.items)) throw Object.assign(new Error("candidate_fetch_failed"), { rssType: "invalid_ingest_response" });
      if (!page.items.length) break;
      for (const candidate of page.items) {
        const adapter = adapters[candidate.source];
        if (!adapter) { counters.skipped++; continue; }
        if (counters.checked > 0) await delayImpl(delayMs);
        try {
          let observation = null;
          if (candidate.source === "praha") {
            if (!prahaById) {
              const current = await adapter.fetchCurrentEvents(PRAHA_ATOM_URL);
              counters.fetched += current.length;
              prahaById = new Map(current.map(item => [String(item.externalId), item]));
            }
            observation = prahaById.get(String(candidate.external_id)) || null;
            if (!observation) throw Object.assign(new Error("not_in_current_feed"), { rssType: "source_unverified" });
          } else {
            observation = await adapter.fetchEventByExternalId(candidate.external_id, candidate);
            counters.fetched++;
            if (!observation) throw Object.assign(new Error("source_record_not_parsed"), { rssType: "invalid_xml" });
          }
          const applied = await postApi(config, "/api/reconciliation/apply", { job_id: job.id, observation }, { fetchImpl, sleepImpl, agentFactory });
          if (applied?.ok !== true) throw Object.assign(new Error("apply_failed"), { rssType: "invalid_ingest_response" });
          counters.checked++;
          if (applied.result?.updated) counters.updated++;
          if (applied.result?.unchanged) counters.unchanged++;
          if (applied.result?.statusChanged) counters.status_changes++;
        } catch (error) {
          const safe = sanitizeRssError(error);
          const permanent = safe.httpStatus === 404;
          const category = permanent ? "source_record_unavailable" : safe.type;
          const recorded = await postApi(config, "/api/reconciliation/failure", { job_id: job.id, source: candidate.source, external_id: candidate.external_id, category, permanent }, { fetchImpl, sleepImpl, agentFactory });
          if (recorded?.ok !== true) throw error;
          counters.checked++;
          if (permanent) counters.missing++;
          else if (category === "source_unverified") counters.stale++;
          else counters.failed++;
        }
      }
    }
    const completed = await postApi(config, `/api/reconciliation/jobs/${encodeURIComponent(job.id)}/complete`, {}, { fetchImpl, sleepImpl, agentFactory });
    if (completed?.ok !== true) throw Object.assign(new Error("job_complete_failed"), { rssType: "invalid_ingest_response" });
    logger.info(`[reconciliation] source=${job.source}; job_type=${job.scope}; dry_run=${job.dry_run}; fetched=${counters.fetched}; checked=${counters.checked}; inserted=0; updated=${counters.updated}; status_changes=${counters.status_changes}; unchanged=${counters.unchanged}; stale=${counters.stale}; skipped=${counters.skipped}; failed=${counters.failed}; missing=${counters.missing}; duration_ms=${Date.now()-startedAt}`);
    return true;
  } catch (error) {
    const safe = sanitizeRssError(error);
    logger.error(`[reconciliation] source=${job?.source || "unknown"}; job_type=${job?.scope || "unknown"}; failed=1; category=${safe.type}; HTTP status=${safe.httpStatus ?? "none"}; duration_ms=${Date.now()-startedAt}`);
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!await runReconciliation()) process.exitCode = 1;
}
