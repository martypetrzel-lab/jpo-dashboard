import crypto from "node:crypto";
import { parse as parseHtml } from "node-html-parser";
import { parsePardubickyDetail, parsePardubickyRss, buildPardubickyEvent, canonicalPardubickyUrl, PARDUBICKY_RSS_URL } from "./pardubicky-rss.js";
import { parsePrahaAtomXml } from "./prague-atom.js";
import { parseRssXml } from "./rss-worker.js";

export const RECONCILIATION_SOURCES = Object.freeze(["stredocesky", "pardubicky", "praha"]);
export const CENTRAL_FEED_URL = "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml";
export const CENTRAL_HISTORY_URL = "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/";

export function normalizeStatusText(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeSourceStatus(value, { source = "" } = {}) {
  const text = normalizeStatusText(value);
  if (!text) return "unknown";
  if (/\b(ukoncen\w*|uhasen\w*|likvidace ukoncen\w*|zasah skoncil|dokonceno|uzavreno)\b/.test(text)) return "completed";
  if (/\b(probiha\w*|aktivni|sap na miste|nova|neupresneno|zasahuj\w*)\b/.test(text)) return "active";
  if (/\b(informac|upozornen|omezeni|preventiv)\b/.test(text)) return "informational";
  if (source === "praha" && /\b(obnoven|odstranena)\b/.test(text)) return "completed";
  return "unknown";
}

function clean(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function centralExternalId(value) {
  const raw = String(value || "");
  const direct = raw.match(/(?:RSS_FEED_|[?&]id=)(\d+)/i)?.[1];
  if (direct) return direct;
  return /^\d+$/.test(raw.trim()) ? raw.trim() : null;
}

export function canonicalCentralUrl(value) {
  const id = centralExternalId(value);
  return id ? `${CENTRAL_HISTORY_URL}?id=${encodeURIComponent(id)}` : null;
}

const MONTHS = new Map([
  ["ledna", 1], ["unora", 2], ["brezna", 3], ["dubna", 4], ["kvetna", 5], ["cervna", 6],
  ["cervence", 7], ["srpna", 8], ["zari", 9], ["rijna", 10], ["listopadu", 11], ["prosince", 12],
]);

function pragueOffsetMinutes(year, month, day, hour, minute) {
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).formatToParts(probe).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === 24 ? 0 : parts.hour, parts.minute);
  return Math.round((represented - probe.getTime()) / 60000);
}

export function parseCzechSourceTime(value) {
  const normalized = normalizeStatusText(value);
  const match = normalized.match(/(\d{1,2})\.\s*([a-z]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const month = MONTHS.get(match[2]);
  if (!month) return null;
  const [day, year, hour, minute] = [Number(match[1]), Number(match[3]), Number(match[4]), Number(match[5])];
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  utc -= pragueOffsetMinutes(year, month, day, hour, minute) * 60000;
  const date = new Date(utc);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function splitPlace(cell) {
  const html = String(cell?.innerHTML || "");
  const parts = html.split(/<br\s*\/?\s*>/i).map(part => clean(parseHtml(part).textContent)).filter(Boolean);
  return { city: parts[0] || null, district: clean((parts[1] || "").replace(/^okres\s+/i, "")) || null };
}

function mapCentralType(value) {
  const text = normalizeStatusText(value);
  if (text.includes("pozar")) return "fire";
  if (text.includes("dopravni nehoda")) return "traffic";
  if (text.includes("technicka pomoc")) return "tech";
  if (text.includes("unik nebezpecnych latek")) return "hazmat";
  if (text.includes("plany poplach")) return "false_alarm";
  if (text.includes("zachrana")) return "rescue";
  return "other";
}

export function stableSourceContentHash(value) {
  const ordered = {};
  for (const key of [
    "sourceStatus", "normalizedStatus", "title", "description", "eventType", "subtype", "alarmLevel",
    "region", "district", "city", "cityPart", "street", "respondingUnits", "sourceUrl", "sourceUpdatedAt",
    "reportedAt", "endedAt", "endedAtAccuracy", "lat", "lon"
  ]) ordered[key] = value?.[key] ?? null;
  return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function normalizeCentralFeedEvent(item) {
  const sourceStatus = clean(item?.statusText);
  const normalizedStatus = normalizeSourceStatus(sourceStatus, { source: "stredocesky" });
  const description = String(item?.descriptionRaw || item?.descriptionText || "");
  const endLabel = description.match(/ukončen[ií]\s*:\s*([^<\n]+)/i)?.[1] || null;
  const endedAt = normalizedStatus === "completed" ? parseCzechSourceTime(endLabel) : null;
  const district = clean(description.match(/okres\s+([^<\n]+)/i)?.[1]) || null;
  const normalized = {
    source: "stredocesky", externalId: String(item?.id || ""), sourceUrl: canonicalCentralUrl(item?.id) || item?.link || null,
    sourceStatus, normalizedStatus, title: clean(item?.title), description: item?.descriptionRaw || null,
    eventType: item?.eventType || mapCentralType(item?.title), subtype: null, alarmLevel: null,
    region: "Středočeský kraj", district, city: item?.cityText || item?.placeText || null,
    cityPart: null, street: null, respondingUnits: [], sourceUpdatedAt: item?.pubDate || null, reportedAt: null,
    endedAt, endedAtAccuracy: endedAt ? "official" : "unknown", lat: null, lon: null,
  };
  return { ...normalized, contentHash: stableSourceContentHash(normalized) };
}

export function parseCentralHistoricalDetail(html, { externalId } = {}) {
  const root = parseHtml(String(html || ""));
  const rows = root.querySelectorAll("#result_list tbody tr, table tbody tr");
  const requestedId = String(externalId || "").trim() || null;
  const expected = centralExternalId(externalId);
  for (const row of rows) {
    const link = row.querySelector("a")?.getAttribute("href") || "";
    const rowId = centralExternalId(link) || expected;
    if (expected && rowId && rowId !== expected) continue;
    const cells = row.querySelectorAll("th, td");
    if (cells.length < 5) continue;
    const title = clean(cells[0].textContent);
    const sourceStatus = clean(cells[2]?.textContent);
    if (!title || !sourceStatus) continue;
    const location = splitPlace(cells[3]);
    const sourceUpdatedAt = parseCzechSourceTime(cells.at(-1)?.textContent);
    const alarmText = clean(cells[4]?.textContent);
    const alarmLevel = ({ "i.": 1, "ii.": 2, "iii.": 3, "iv.": 4 })[alarmText.toLowerCase()] || null;
    const normalized = {
      source: "stredocesky", externalId: requestedId || rowId, sourceUrl: canonicalCentralUrl(expected || rowId),
      sourceStatus, normalizedStatus: normalizeSourceStatus(sourceStatus, { source: "stredocesky" }),
      title, description: null, eventType: mapCentralType(title), subtype: null, alarmLevel,
      region: "Středočeský kraj", district: location.district, city: location.city,
      cityPart: null, street: null, respondingUnits: [], sourceUpdatedAt, reportedAt: null,
      endedAt: null, endedAtAccuracy: "unknown", lat: null, lon: null,
    };
    return { ...normalized, contentHash: stableSourceContentHash(normalized) };
  }
  return null;
}

export function normalizePardubickyObservation(feedItem, detail, options = {}) {
  const event = buildPardubickyEvent(feedItem, detail, options);
  const normalized = {
    source: "pardubicky", externalId: event.externalId, sourceUrl: canonicalPardubickyUrl(event.externalId),
    sourceStatus: event.statusText, normalizedStatus: normalizeSourceStatus(event.statusText, { source: "pardubicky" }),
    title: event.title, description: event.description, eventType: event.eventType, subtype: event.subtype,
    alarmLevel: event.alarmLevel ?? null, region: event.region, district: event.district,
    city: event.cityText, cityPart: event.cityPart, street: event.street,
    respondingUnits: event.respondingUnits || [], sourceUpdatedAt: event.sourceUpdatedAt,
    reportedAt: event.reportedAt, endedAt: event.endTimeIso || null,
    endedAtAccuracy: event.endTimeIso ? "official" : "unknown", lat: event.lat ?? null, lon: event.lon ?? null,
  };
  return { ...normalized, contentHash: stableSourceContentHash(normalized) };
}

export function buildSourceAdapters({ fetchText, now = () => new Date().toISOString() } = {}) {
  if (typeof fetchText !== "function") throw new TypeError("fetchText is required");
  return {
    stredocesky: {
      canFetchHistoricalEvent: () => true,
      getCanonicalUrl: canonicalCentralUrl,
      normalizeStatus: value => normalizeSourceStatus(value, { source: "stredocesky" }),
      normalizeEvent: value => value,
      async fetchCurrentEvents(url = CENTRAL_FEED_URL) {
        const response = await fetchText(url);
        return parseRssXml(response.body, { maxItems: 100 }).map(normalizeCentralFeedEvent);
      },
      async fetchEventByExternalId(id) {
        const response = await fetchText(canonicalCentralUrl(id));
        return parseCentralHistoricalDetail(response.body, { externalId: id });
      },
    },
    pardubicky: {
      canFetchHistoricalEvent: () => true,
      getCanonicalUrl: canonicalPardubickyUrl,
      normalizeStatus: value => normalizeSourceStatus(value, { source: "pardubicky" }),
      normalizeEvent: value => value,
      async fetchCurrentEvents(url = PARDUBICKY_RSS_URL) {
        const response = await fetchText(url);
        return parsePardubickyRss(response.body, { maxItems: 100 });
      },
      async fetchEventByExternalId(id, stored = {}) {
        const sourceUrl = canonicalPardubickyUrl(id);
        const response = await fetchText(sourceUrl);
        const detail = parsePardubickyDetail(response.body);
        const feedItem = {
          externalId: String(id), sourceUrl, reportedAt: stored.reported_at || stored.pub_date || null,
          cityText: stored.city_text || "", cityPart: stored.city_part || null,
          typeHint: stored.event_type || null, description: stored.description_raw || null,
        };
        return normalizePardubickyObservation(feedItem, detail, { observedAt: now() });
      },
    },
    praha: {
      canFetchHistoricalEvent: () => false,
      getCanonicalUrl: value => String(value || "") || null,
      normalizeStatus: value => normalizeSourceStatus(value, { source: "praha" }),
      normalizeEvent: value => value,
      async fetchEventByExternalId() { return null; },
      async fetchCurrentEvents(url) {
        const response = await fetchText(url);
        return parsePrahaAtomXml(response.body).map(event => {
          const normalized = {
            source: "praha", externalId: event.externalId, sourceUrl: event.sourceUrl,
            sourceStatus: event.statusText, normalizedStatus: normalizeSourceStatus(event.statusText, { source: "praha" }),
            title: event.title, description: event.description, eventType: event.eventType, subtype: null,
            alarmLevel: null, region: event.region, district: null, city: event.cityText, cityPart: null,
            street: event.addressText, respondingUnits: [], sourceUpdatedAt: event.sourceUpdatedAt,
            reportedAt: null, endedAt: null, endedAtAccuracy: "unknown", lat: null, lon: null,
          };
          return { ...normalized, contentHash: stableSourceContentHash(normalized) };
        });
      },
    },
  };
}
