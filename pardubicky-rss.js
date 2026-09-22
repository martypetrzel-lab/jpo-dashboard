import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";

export const PARDUBICKY_RSS_URL = "https://www.hzspa.cz/vyjezdy/rss-aktualni-vyjezdy.php";
export const PARDUBICKY_REGION = "Pardubický kraj";

const arrayify = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => value == null ? "" : typeof value === "object" ? text(value["#text"] ?? value.__cdata ?? "") : String(value).trim();
const clean = value => String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
const norm = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function pardubickyExternalId(value) {
  try { return new URL(String(value || "").replace(/^http:/i, "https:")).searchParams.get("id")?.match(/^\d+$/)?.[0] || null; }
  catch { return String(value || "").match(/[?&]id=(\d+)/)?.[1] || null; }
}

export function canonicalPardubickyUrl(value) {
  const id = pardubickyExternalId(value);
  return id ? `https://www.hzspa.cz/vyjezdy/udalost.php?id=${id}` : null;
}

export function mapPardubickyType(value) {
  const n = norm(value);
  if (n.includes("pozar")) return "fire";
  if (n.includes("dopravni nehoda")) return "traffic";
  if (n.includes("technicka pomoc")) return "tech";
  if (n.includes("plany poplach")) return "false_alarm";
  if (n.includes("zachrana osob") || n.includes("zachrana zvirat")) return "rescue";
  if (n.includes("unik nebezpecnych latek")) return "hazmat";
  if (n.includes("ostatni mimoradna udalost")) return "crisis_other";
  return "other";
}

function rssDescription(value) {
  const root = parseHtml(String(value || ""));
  const img = root.querySelector("img");
  const typeHint = clean(img?.getAttribute("alt") || img?.getAttribute("src")?.split("/").at(-1)?.replace(/\.png$/i, "").replace(/-/g, " "));
  root.querySelectorAll("img,script,style").forEach(node => node.remove());
  const description = clean(root.textContent.replace(/&nbsp;/gi, " "));
  return { typeHint, description: description || null };
}

export function parsePardubickyRss(xml, { maxItems = 100 } = {}) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", trimValues: true, processEntities: true });
  const parsed = parser.parse(xml);
  const items = arrayify(parsed?.rss?.channel?.item);
  return items.slice(0, maxItems).map(item => {
    const guid = text(item.guid);
    const sourceUrl = canonicalPardubickyUrl(guid || text(item.link));
    const externalId = pardubickyExternalId(sourceUrl);
    const reported = new Date(text(item.pubDate));
    const desc = rssDescription(text(item.description));
    const rawTitle = clean(text(item.title));
    const [city, ...parts] = rawTitle.split(/\s+-\s+/);
    return {
      id: externalId ? `pardubicky:${externalId}` : null,
      source: "pardubicky", externalId, sourceUrl, link: sourceUrl,
      title: rawTitle, cityText: clean(city), cityPart: clean(parts.join(" - ")) || null,
      reportedAt: Number.isFinite(reported.getTime()) ? reported.toISOString() : null,
      pubDate: Number.isFinite(reported.getTime()) ? reported.toISOString() : null,
      typeHint: desc.typeHint || null, eventType: mapPardubickyType(desc.typeHint),
      description: desc.description,
    };
  }).filter(item => item.externalId && item.sourceUrl && item.reportedAt);
}

export function parsePardubickyDetail(html) {
  const root = parseHtml(String(html || ""), { lowerCaseTagName: true, comment: false });
  const fields = {};
  for (const paragraph of root.querySelectorAll("p")) {
    const labelNode = paragraph.querySelector("strong");
    if (!labelNode) continue;
    const label = norm(labelNode.textContent).replace(/:$/, "");
    const clone = parseHtml(paragraph.toString());
    clone.querySelectorAll("strong,img,script,style").forEach(node => node.remove());
    fields[label] = clean(clone.textContent.replace(/&nbsp;/gi, " ")) || null;
  }
  const headingType = clean(root.querySelector("h1 img")?.getAttribute("alt"));
  const statusRaw = fields.stav || null;
  const statusNorm = norm(statusRaw);
  return {
    description: fields.popis && norm(fields.popis) !== "nezadan" ? fields.popis : null,
    reportedLabel: fields.ohlasena || null,
    type: fields.typ || headingType || null,
    subtype: fields.podtyp || null,
    district: fields.okres || null,
    city: fields.obec || null,
    street: fields.ulice || null,
    respondingUnits: fields.jednotky ? fields.jednotky.split(/[,;]+/).map(clean).filter(Boolean) : [],
    status: statusRaw,
    isClosed: /ukoncen/.test(statusNorm),
    isOpen: /probihajic|probiha|aktivni/.test(statusNorm),
  };
}

export function buildPardubickyEvent(feedItem, detail, { observedAt = new Date().toISOString() } = {}) {
  const typeName = detail?.type || feedItem.typeHint;
  const city = clean(detail?.city || feedItem.cityText);
  const cityPart = feedItem.cityPart || null;
  const titleParts = [typeName || "Událost HZS", detail?.subtype, cityPart ? `${city} - ${cityPart}` : city].filter(Boolean);
  const normalized = {
    externalId: feedItem.externalId, sourceUrl: feedItem.sourceUrl, reportedAt: feedItem.reportedAt,
    type: typeName || null, subtype: detail?.subtype || null,
    description: detail?.description || feedItem.description || null, status: detail?.status || null,
    district: detail?.district || null, city, cityPart, street: detail?.street || null,
    respondingUnits: detail?.respondingUnits || [], isClosed: detail?.isClosed === true, isOpen: detail?.isOpen === true,
  };
  return {
    id: `pardubicky:${feedItem.externalId}`, source: "pardubicky", externalId: feedItem.externalId,
    sourceUrl: feedItem.sourceUrl, link: feedItem.sourceUrl, region: PARDUBICKY_REGION,
    reportedAt: feedItem.reportedAt, pubDate: feedItem.reportedAt, sourceUpdatedAt: observedAt,
    title: titleParts.join(" – "), description: normalized.description || "",
    eventType: mapPardubickyType(typeName), subtype: normalized.subtype,
    district: normalized.district, cityText: city, cityPart, street: normalized.street,
    placeText: [normalized.street, cityPart].filter(Boolean).join(", ") || city,
    respondingUnits: normalized.respondingUnits,
    statusText: normalized.status || "stav neupřesněn",
    statusSource: normalized.isClosed ? "explicit_closed" : normalized.isOpen ? "explicit_open" : "source_unknown",
    isClosed: normalized.isClosed, isJpoEvent: true,
    contentHash: crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
    rawPayload: normalized,
  };
}

export function pragueDay(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" }).format(date) : null;
}

export function pardubickyAgeClass(item, now = new Date()) {
  const today = pragueDay(now), day = pragueDay(item?.reportedAt);
  if (!today || !day) return "older";
  if (day === today) return "today";
  const yesterday = new Date(now); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return day === pragueDay(yesterday) ? "yesterday" : "older";
}
