import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetch as undiciFetch } from "undici";
import { fetchRssDetailed, sanitizeRssError } from "../rss-worker.js";
import {
  PRAHA_ATOM_URL, parsePrahaAtomXml, planPrahaImport, normalizeMaxAgeHours,
} from "../prague-atom.js";
import { pushRssItems, readPushConfig } from "./rss-push.js";

function safeFailure(type, httpStatus = null) {
  const error = new Error(type);
  error.rssType = type;
  if (httpStatus != null) error.rssHttpStatus = httpStatus;
  return error;
}

export function buildPrahaPayload(xml) {
  return { source: "github_actions_praha_atom", items: parsePrahaAtomXml(xml, { maxItems: 100 }) };
}

export async function runPrahaPush({
  env = process.env, logger = console, atomFetchImpl = undiciFetch, ingestFetchImpl = undiciFetch,
  sleepImpl, agentFactory, now = new Date(), startedAt = Date.now(), ingestTimeoutMs = 60_000,
} = {}) {
  let stage = "configuration";
  let found = 0;
  try {
    const dryRun = String(env.PRAHA_DRY_RUN || "") === "1";
    const config = dryRun ? null : readPushConfig(env);
    const maxAgeHours = normalizeMaxAgeHours(env.PRAHA_MAX_AGE_HOURS);
    stage = "atom";
    const feed = await fetchRssDetailed(PRAHA_ATOM_URL, {
      fetchImpl: atomFetchImpl, timeoutMs: 30_000, connectTimeoutMs: 30_000,
      sleepImpl, agentFactory,
    });
    const payload = buildPrahaPayload(feed.xml);
    found = payload.items.length;
    const plan = planPrahaImport(payload.items, { now, maxAgeHours });

    if (dryRun) {
      logger.info(`[praha-push] dry-run; found=${found}; eligible=${plan.eligible.length}; skipped_old=${plan.skippedOld.length}; errors=0; duration_ms=${Date.now() - startedAt}`);
      return true;
    }

    // Send all current entries. The API admits fresh unknown entries and known
    // identities independently, so an older known event can still be updated.
    stage = "ingest";
    const result = await pushRssItems(payload, config, {
      fetchImpl: ingestFetchImpl, sleepImpl, agentFactory, timeoutMs: ingestTimeoutMs,
    });
    let data;
    try { data = JSON.parse(result.xml); } catch { throw safeFailure("invalid_ingest_response", result.httpStatus); }
    const counters = [data?.accepted, data?.inserted, data?.updated, data?.unchanged ?? 0, data?.skipped_older ?? 0];
    if (data?.ok !== true || counters.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw safeFailure("invalid_ingest_response", result.httpStatus);
    }
    logger.info(`[praha-push] found=${found}; HTTP status=${result.httpStatus}; new=${data.inserted}; updated=${data.updated}; unchanged=${data.unchanged ?? 0}; skipped_old=${data.skipped_older ?? 0}; errors=0; duration_ms=${Date.now() - startedAt}`);
    return true;
  } catch (error) {
    const safe = sanitizeRssError(error);
    logger.error(`[praha-push] failed; stage=${stage}; found=${found}; category=${safe.type}; HTTP status=${safe.httpStatus ?? "none"}; errors=1; duration_ms=${Date.now() - startedAt}`);
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!await runPrahaPush()) process.exitCode = 1;
}
