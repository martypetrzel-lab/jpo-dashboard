import test from "node:test";
import assert from "node:assert/strict";
import {
  createRssWorker,
  fetchRss,
  parseRssXml,
  readRssConfig,
  rssItemToEvent,
  stableEventId
} from "../rss-worker.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Zásahy JPO</title>
  <item>
    <title>Požár &amp; kouř - Kladno</title>
    <link>https://example.test/detail/12345</link>
    <guid>event-12345</guid>
    <pubDate>Mon, 03 Aug 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[stav: probíhá zásah<br>ukončení: <br>Kladno<br>okres Kladno]]></description>
  </item>
</channel></rss>`;

test("parses a normal RSS item and preserves backend-compatible fields", () => {
  const [event] = parseRssXml(RSS);
  assert.equal(event.id, "event-12345");
  assert.equal(event.title, "Požár & kouř - Kladno");
  assert.equal(event.cityText, "Kladno");
  assert.equal(event.placeText, "Kladno");
  assert.equal(event.statusText, "probíhá zásah");
  assert.equal(event.eventType, "fire");
  assert.match(event.descriptionText, /okres Kladno/);
});

test("decodes XML/HTML entities", () => {
  const [event] = parseRssXml(RSS.replace("Kladno<br>", "Mladá &amp; Boleslav<br>"));
  assert.equal(event.cityText, "Mladá & Boleslav");
});

test("handles missing optional values", () => {
  const event = rssItemToEvent({ title: "Technická pomoc", link: "https://example.test/99" });
  assert.equal(event.statusText, "");
  assert.equal(event.cityText, "");
  assert.equal(event.pubDate, "");
  assert.equal(event.eventType, "tech");
});

test("stable ID is deterministic with and without guid", () => {
  assert.equal(stableEventId({ guid: "abc" }), "abc");
  assert.equal(stableEventId({ link: "https://example.test/123" }), "RSS_FEED_123");
  const input = { title: "Událost", pubDate: "today" };
  assert.equal(stableEventId(input), stableEventId(input));
});

test("duplicate item is upserted under the same ID", async () => {
  const stored = new Map();
  const ingestItems = async (items) => {
    let inserted = 0;
    let updated = 0;
    for (const item of items) {
      if (stored.has(item.id)) updated++; else inserted++;
      stored.set(item.id, item);
    }
    return { accepted: items.length, inserted, updated };
  };
  const fetchImpl = async () => new Response(RSS, { status: 200 });
  const worker = createRssWorker({
    config: { ...readRssConfig({}), enabled: true, runOnStart: false },
    ingestItems,
    acquireLock: async () => async () => {},
    fetchImpl,
    logger: { info() {}, error() {} }
  });
  worker.start();
  await worker.runOnce();
  await worker.runOnce();
  worker.stop();
  assert.equal(stored.size, 1);
  assert.equal(worker.getState().lastInsertedOrUpdated, 1);
});

test("rejects invalid XML", () => {
  assert.throws(() => parseRssXml("<rss><channel><item>"), /Invalid RSS XML/);
});

test("aborts a timed out request", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(fetchRss("https://example.test/rss", { fetchImpl, timeoutMs: 5 }), /timeout/);
});

test("RSS_ENABLED=0 prevents worker startup", () => {
  let called = false;
  const worker = createRssWorker({
    config: readRssConfig({ RSS_ENABLED: "0" }),
    ingestItems: async () => { called = true; },
    logger: { info() {}, error() {} }
  });
  assert.equal(worker.start(), false);
  assert.equal(worker.getState().enabled, false);
  assert.equal(called, false);
});
