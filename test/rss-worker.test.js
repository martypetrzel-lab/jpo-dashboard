import test from "node:test";
import { Agent, Pool, ProxyAgent } from "undici";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
import {
  createRssWorker,
  fetchRss,
  fetchRssDetailed,
  parseRssXml,
  readRssConfig,
  rssDateKeyInPrague,
  rssItemToEvent,
  sanitizeRssError,
  shouldIngestRssItemForToday,
  stableEventId,
  testRssConnection
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

test("current-day RSS policy keeps today and open carry-over but rejects old unknown closed events", () => {
  const now = new Date("2026-09-17T10:00:00Z");
  assert.equal(rssDateKeyInPrague("2026-09-17 00:05:00"), "2026-09-17");
  assert.equal(rssDateKeyInPrague("2026-09-16T22:30:00Z"), "2026-09-17");
  assert.equal(shouldIngestRssItemForToday({ pubDate: "2026-09-17 08:00:00", statusText: "ukončená" }, { now }), true);
  assert.equal(shouldIngestRssItemForToday({ pubDate: "2026-09-16 23:50:00", statusText: "probíhá zásah" }, { now }), true);
  assert.equal(shouldIngestRssItemForToday({ pubDate: "2026-09-16 20:00:00", descriptionRaw: "stav: nová<br>Kladno" }, { now }), true);
  assert.equal(shouldIngestRssItemForToday({ pubDate: "2026-09-16 20:00:00", statusText: "ukončená" }, { now }), false);
  assert.equal(shouldIngestRssItemForToday({ pubDate: "2026-09-16 20:00:00", statusText: "ukončená" }, { now, previouslyKnownOpen: true }), true);
  assert.equal(shouldIngestRssItemForToday({ pubDate: "2026-09-18 08:00:00", statusText: "nová" }, { now }), false);
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
  assert.throws(() => parseRssXml("<rss><channel><item>"), /invalid_xml/);
});

test("direct mode installs and closes its own Agent", async () => {
  let optionsSeen;
  const fetchImpl = async (_url, options) => {
    optionsSeen = options;
    return new Response(RSS, { status: 200 });
  };
  const result = await fetchRssDetailed("https://example.test/rss", { fetchImpl, proxyUrl: "" });
  assert.equal(result.httpStatus, 200);
  assert.ok(optionsSeen.dispatcher instanceof Agent);
  assert.equal(optionsSeen.dispatcher.closed, true);
});

test("proxy mode routes RSS through a proxy dispatcher without exposing credentials", async () => {
  const dispatcher = { close: async () => {} };
  let factoryInput;
  let optionsSeen;
  const fetchImpl = async (_url, options) => {
    optionsSeen = options;
    return new Response(RSS, { status: 200 });
  };
  const result = await fetchRssDetailed("https://example.test/rss", {
    fetchImpl,
    proxyUrl: "http://proxy-user:proxy-password@proxy.example:8080",
    proxyAgentFactory: (uri) => { factoryInput = uri; return dispatcher; }
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(optionsSeen.dispatcher, dispatcher);
  assert.match(factoryInput, /^http:\/\/proxy-user:/);
  assert.equal(JSON.stringify(result).includes("proxy-password"), false);
});

test("admin connection test safely classifies invalid XML", async () => {
  const result = await testRssConnection(readRssConfig({ RSS_PROXY_URL: "http://user:secret@proxy.test" }), {
    fetchImpl: async () => new Response("not xml", { status: 200 }),
    proxyAgentFactory: () => ({ close: async () => {} })
  });
  assert.equal(result.success, false);
  assert.equal(result.error.type, "invalid_xml");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("safe diagnostics distinguish network and HTTP error categories", () => {
  const cases = [
    [{ cause: { code: "ENOTFOUND" } }, "dns"],
    [{ cause: { code: "ECONNREFUSED" } }, "connection_refused"],
    [{ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }, "connect_timeout"],
    [{ cause: { code: "CERT_HAS_EXPIRED" } }, "tls"],
    [Object.assign(new Error("status"), { rssType: "http_status", rssHttpStatus: 503 }), "http_status"],
    [Object.assign(new Error("proxy"), { rssType: "proxy_authentication", rssHttpStatus: 407 }), "proxy_authentication"],
    [Object.assign(new Error("xml"), { rssType: "invalid_xml", rssHttpStatus: 200 }), "invalid_xml"]
  ];
  for (const [error, expected] of cases) {
    const safe = sanitizeRssError(error, 12);
    assert.equal(safe.type, expected);
    assert.equal(Object.keys(safe).sort().join(","), "durationMs,httpStatus,message,type");
  }
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


test("connect timeout configuration is independent and bounded", () => {
  assert.equal(readRssConfig({}).connectTimeoutMs, 30000);
  assert.equal(readRssConfig({ RSS_CONNECT_TIMEOUT_MS: "bad" }).connectTimeoutMs, 30000);
  assert.equal(readRssConfig({ RSS_CONNECT_TIMEOUT_MS: "1" }).connectTimeoutMs, 5000);
  assert.equal(readRssConfig({ RSS_CONNECT_TIMEOUT_MS: "999999" }).connectTimeoutMs, 120000);
  const config = readRssConfig({ RSS_CONNECT_TIMEOUT_MS: "45000", RSS_TIMEOUT_MS: "30000" });
  assert.equal(config.connectTimeoutMs, 45000);
  assert.equal(config.timeoutMs, 30000);
});

test("real direct Agent forwards connectTimeout to its connection pool and closes", async () => {
  const server = createServer((_req, res) => res.end(RSS));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let agent;
  let timeoutSeen;
  try {
    const result = await testRssConnection(readRssConfig({ RSS_URL: "http://127.0.0.1:" + server.address().port, RSS_CONNECT_TIMEOUT_MS: "45000" }), {
      agentFactory: (options) => agent = new Agent({ ...options, factory: (origin, poolOptions) => {
        timeoutSeen = poolOptions.connectTimeout;
        return new Pool(origin, poolOptions);
      } })
    });
    assert.equal(result.success, true);
    assert.equal(timeoutSeen, 45000);
    assert.equal(agent.closed, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const mode of ["direct", "proxy"]) {
  test(mode + " retries connect timeout once, closes each dispatcher and waits 1500ms", async () => {
    let calls = 0;
    let closed = 0;
    const delays = [];
    const factory = () => ({ close: async () => { closed++; } });
    const result = await fetchRssDetailed("https://example.test/rss", {
      proxyUrl: mode === "proxy" ? "http://user:secret@proxy.test" : "",
      agentFactory: factory, proxyAgentFactory: factory,
      sleepImpl: async (ms) => { assert.equal(closed, 1); delays.push(ms); },
      fetchImpl: async () => {
        if (++calls === 1) throw Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
        return new Response(RSS);
      }
    });
    assert.equal(result.httpStatus, 200);
    assert.equal(calls, 2);
    assert.equal(closed, 2);
    assert.deepEqual(delays, [1500]);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  });
}

test("persistent connect timeout stops after two attempts with safe diagnostics", async () => {
  let calls = 0;
  const result = await testRssConnection(readRssConfig({}), {
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls++;
      throw Object.assign(new Error("http://user:secret@proxy.test"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.error.type, "connect_timeout");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

for (const status of [400, 401, 403, 404, 407, 429]) {
  test("HTTP " + status + " does not retry and cancels unread response before close", async () => {
    let calls = 0;
    let cancelled = false;
    await assert.rejects(fetchRssDetailed("https://example.test/rss", {
      fetchImpl: async () => {
        calls++;
        return { ok: false, status, body: { cancel: async () => { cancelled = true; } } };
      },
      agentFactory: () => ({ close: async () => { assert.equal(cancelled, true); } }),
      sleepImpl: async () => assert.fail("unexpected retry")
    }));
    assert.equal(calls, 1);
  });
}

test("HTTP 503 retries once and invalid XML does not retry", async () => {
  let calls = 0;
  const result = await testRssConnection(readRssConfig({}), {
    sleepImpl: async () => {},
    fetchImpl: async () => new Response(++calls === 1 ? "unavailable" : "invalid xml", { status: calls === 1 ? 503 : 200 })
  });
  assert.equal(calls, 2);
  assert.equal(result.error.type, "invalid_xml");
});

test("overall timeout covers response body, retries with fresh signals and closes", async () => {
  let calls = 0;
  let closed = 0;
  const signals = [];
  await assert.rejects(fetchRssDetailed("https://example.test/rss", {
    timeoutMs: 5, connectTimeoutMs: 45000,
    sleepImpl: async () => {},
    agentFactory: () => ({ close: async () => { closed++; } }),
    fetchImpl: async (_url, { signal }) => {
      calls++; signals.push(signal);
      return { ok: true, status: 200, text: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
      }) };
    }
  }), error => sanitizeRssError(error).type === "timeout");
  assert.equal(calls, 2);
  assert.equal(closed, 2);
  assert.notEqual(signals[0], signals[1]);
});

test("dispatcher close failures do not replace the original error", async () => {
  await assert.rejects(fetchRssDetailed("https://example.test/rss", {
    agentFactory: () => ({ close: async () => { throw new Error("close failed"); } }),
    fetchImpl: async () => new Response("forbidden", { status: 403 })
  }), error => error.rssHttpStatus === 403);
});

test("real ProxyAgent tunnels the RSS request and closes", async () => {
  const source = createServer((_req, res) => res.end(RSS));
  const proxy = createServer();
  let tunnels = 0;
  proxy.on("connect", (req, client, head) => {
    tunnels++;
    const upstream = connect(source.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  source.listen(0, "127.0.0.1"); proxy.listen(0, "127.0.0.1");
  await Promise.all([once(source, "listening"), once(proxy, "listening")]);
  let agent;
  try {
    const result = await fetchRssDetailed("http://127.0.0.1:" + source.address().port, {
      proxyUrl: "http://127.0.0.1:" + proxy.address().port,
      proxyAgentFactory: uri => agent = new ProxyAgent(uri),
      agentFactory: () => assert.fail("direct Agent used in proxy mode")
    });
    assert.equal(result.xml, RSS);
    assert.equal(tunnels, 1);
    assert.equal(agent.closed, true);
  } finally {
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  }
});


test("invalid XML on the first response does not retry", async () => {
  let calls = 0;
  const result = await testRssConnection(readRssConfig({}), {
    fetchImpl: async () => { calls++; return new Response("invalid xml"); },
    sleepImpl: async () => assert.fail("unexpected retry")
  });
  assert.equal(calls, 1);
  assert.equal(result.error.type, "invalid_xml");
});

test("invalid proxy is sanitized and does not retry", async () => {
  let calls = 0;
  const result = await testRssConnection(readRssConfig({ RSS_PROXY_URL: "http://user:secret@proxy.test" }), {
    proxyAgentFactory: () => { calls++; throw new Error("secret"); },
    sleepImpl: async () => assert.fail("unexpected retry")
  });
  assert.equal(calls, 1);
  assert.equal(result.error.type, "invalid_proxy");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
