import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export const PRAHA_ATOM_URL = "https://bezpecnost.praha.eu/Intens.CrisisPortalInfrastructureApp/events/rss";
export const DEFAULT_PRAHA_MAX_AGE_HOURS = 24;

function arrayify(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") return textValue(value["#text"] ?? value.__cdata ?? "");
  return "";
}

function normalizeAtomTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const compatible = raw.replace(/(\.\d{3})\d+(?=[+-]\d{2}:\d{2}$|Z$)/, "$1");
  const parsed = new Date(compatible);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeForMatch(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function classifyPrahaEvent(title, summary) {
  const value = normalizeForMatch(`${title} ${summary}`);
  if (/\b(hzs|hasic|hasici|jednotk[ay] pozarni ochrany)\b/.test(value)) return "hzs";
  if (/\b(pozar|hori|horeni|zakoureni)\b/.test(value)) return "fire";
  if (/\b(doprav|nehod|komunikac|uzavir|provoz|silnic)\b/.test(value)) return "traffic";
  if (/\b(vodovod|vodar|kanaliz|dodavk[ay]? vody|bez vody)/.test(value)) return "water";
  if (/\b(elektr|proud|napeti|energie)/.test(value)) return "electricity";
  if (/\b(mhd|tramvaj|metro|autobus|vlak|dopravy)\b/.test(value)) return "transport";
  return "crisis_other";
}

function derivePrahaStatus(title, summary) {
  const value = normalizeForMatch(`${title} ${summary}`);
  const closed = [
    /\bukonceno\b/, /\bopatreni ukonceno\b/, /\bprovoz obnoven\b/,
    /\bporucha odstranena\b/, /\bpozar uhasen\b/, /\bzasah ukoncen\b/,
  ].some((pattern) => pattern.test(value));
  if (closed) return { statusText: "pravděpodobně ukončeno", statusSource: "source_estimated_closed", isClosed: true };

  const open = [
    /\bprobiha\b/, /\bzasah probiha\b/, /\bnahradni zasobovani\b/,
    /\bpredpoklad ukonceni\b/, /\bomezeni potrva\b/, /\bna miste zasahuji\b/,
  ].some((pattern) => pattern.test(value));
  if (open) return { statusText: "pravděpodobně probíhá", statusSource: "source_estimated_open", isClosed: false };
  return { statusText: "stav neupřesněn", statusSource: "source_estimated_unknown", isClosed: false };
}

function extractPrahaLocation(title, summary) {
  const combined = `${title || ""} ${summary || ""}`;
  const districtMatch = combined.match(/Pra(?:ha|ze)\s+(2[0-2]|1\d|[1-9])\b/i);
  const district = districtMatch ? `Praha ${districtMatch[1]}` : "Praha";
  const titleParts = String(title || "").split(",").map((part) => part.trim()).filter(Boolean);
  let address = titleParts.length > 1 ? titleParts.slice(1).join(", ") : "";
  address = address.replace(/\s+v\s+Praze\s+(?:2[0-2]|1\d|[1-9])\b/gi, "").trim();
  const neighborhoodMatch = combined.match(/(?:v|na)\s+(?:městské části\s+)?(?:Praze\s+\d+[,\s-]*)?([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}-]+)(?=[,.]|\s+do\b)/u);
  return { cityText: district, placeText: address || district, addressText: address || null, neighborhoodText: neighborhoodMatch?.[1] || null };
}

function atomLink(entry) {
  for (const link of arrayify(entry?.link)) {
    if (typeof link === "string") return link.trim();
    if (link?.href && (!link.rel || link.rel === "alternate")) return String(link.href).trim();
  }
  return "";
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parsePrahaAtomXml(xml, { maxItems = 100 } = {}) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", trimValues: true, processEntities: true });
  const parsed = parser.parse(xml);
  const feed = parsed?.feed || parsed?.["atom:feed"];
  const entries = arrayify(feed?.entry || feed?.["atom:entry"]);
  return entries.slice(0, maxItems).map((entry) => {
    const title = textValue(entry.title);
    const summary = textValue(entry.summary || entry.content);
    const externalId = textValue(entry.id);
    const sourceUrl = atomLink(entry);
    const sourceUpdatedAt = normalizeAtomTimestamp(textValue(entry.updated || entry.published));
    const authorName = textValue(entry.author?.name);
    const status = derivePrahaStatus(title, summary);
    const eventType = classifyPrahaEvent(title, summary);
    const location = extractPrahaLocation(title, summary);
    const stablePayload = { externalId, title, summary, sourceUrl, sourceUpdatedAt, authorName, status, eventType, location };
    return {
      id: `praha:${externalId}`, source: "praha", externalId, sourceUrl, link: sourceUrl,
      sourceUpdatedAt, pubDate: sourceUpdatedAt, title, description: summary, authorName: authorName || null,
      region: "Hlavní město Praha", eventType,
      isJpoEvent: /\b(hzs|hasič|hasiči|jednotka požární ochrany)\b/i.test(`${title} ${summary}`),
      ...status, ...location, contentHash: canonicalHash(stablePayload),
      rawPayload: { id: externalId, title, summary, link: sourceUrl, updated: textValue(entry.updated || entry.published), author: authorName || null },
    };
  }).filter((item) => item.externalId && item.sourceUpdatedAt);
}

export function normalizeMaxAgeHours(value, fallback = DEFAULT_PRAHA_MAX_AGE_HOURS) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 168)) : fallback;
}

export function isPrahaItemFresh(item, { now = new Date(), maxAgeHours = DEFAULT_PRAHA_MAX_AGE_HOURS } = {}) {
  const updated = new Date(item?.sourceUpdatedAt || item?.pubDate || "");
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(updated.getTime()) || !Number.isFinite(nowDate.getTime())) return false;
  const ageMs = nowDate.getTime() - updated.getTime();
  return ageMs >= 0 && ageMs <= normalizeMaxAgeHours(maxAgeHours) * 60 * 60 * 1000;
}

export function shouldIngestPrahaItem(item, { previouslyKnown = false, now = new Date(), maxAgeHours } = {}) {
  return Boolean(previouslyKnown) || isPrahaItemFresh(item, { now, maxAgeHours });
}

export function planPrahaImport(items, { now = new Date(), maxAgeHours, knownExternalIds = [] } = {}) {
  const known = new Set(knownExternalIds);
  const eligible = [];
  const skippedOld = [];
  for (const item of items || []) {
    if (shouldIngestPrahaItem(item, { previouslyKnown: known.has(item.externalId), now, maxAgeHours })) eligible.push(item);
    else skippedOld.push(item);
  }
  return { found: (items || []).length, eligible, skippedOld };
}

export { derivePrahaStatus, classifyPrahaEvent, extractPrahaLocation, normalizeAtomTimestamp };
