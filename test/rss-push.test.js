import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DEFAULT_RSS_URL } from "../rss-worker.js";
import { buildGatewayPayload, buildRssPayload, gatewayUrl, readPushConfig, runRssPush } from "../scripts/rss-push.js";

const item = n => `<item><guid>event-${n}</guid><title>Požár &amp; kouř</title><link>https://example.test/${n}</link><description><![CDATA[stav: probíhá zásah<br>Kladno]]></description></item>`;
const rss = count => `<rss><channel><title>Zásahy JPO</title>${Array.from({ length: count }, (_, n) => item(n)).join("")}</channel></rss>`;
const env = {
  FIREWATCH_INGEST_URL: "https://firewatchcz.cz/api/ingest",
  FIREWATCH_API_KEY: "test-secret-key",
  RSS2JSON_API_KEY: "test-rss2json-key"
};
const sleepImpl = async () => {};
const harness = () => {
  const logs = [];
  return { logs, logger: { info: line => logs.push(line), error: line => logs.push(line) } };
};
const response = () => Response.json({ ok: true, accepted: 2, inserted: 1, updated: 1, skipped: 5, skipped_older: 4 });

test("RSS payload caps 105 items at 100 and preserves stable IDs and ingest fields", () => {
  const payload = buildRssPayload(rss(105));
  assert.equal(payload.source, "github_actions_rss");
  assert.equal(payload.items.length, 100);
  assert.equal(payload.items[0].id, "event-0");
  assert.equal(payload.items[0].title, "Požár & kouř");
  assert.equal(payload.items[0].cityText, "Kladno");
  assert.equal(payload.items[0].statusText, "probíhá zásah");
  assert.deepEqual(buildRssPayload(rss(105)), payload);
  assert.throws(() => buildRssPayload("broken xml"));
});

test("rss2json fallback payload preserves backend-compatible fields", () => {
  const payload = buildGatewayPayload({ status: "ok", items: [{
    guid: "event-gateway", title: "Požár - Kladno", link: "https://example.test/gateway",
    pubDate: "2026-09-17 11:25:00", description: "stav: nová<br>Kladno<br>okres Kladno"
  }] });
  assert.equal(payload.source, "github_actions_rss2json");
  assert.equal(payload.items[0].id, "event-gateway");
  assert.equal(payload.items[0].cityText, "Kladno");
  assert.equal(payload.items[0].eventType, "fire");
});

test("rss2json API key requests up to 100 newest items without putting the key in logs", () => {
  const url = new URL(gatewayUrl(1_800_000, env.RSS2JSON_API_KEY));
  assert.equal(url.origin + url.pathname, "https://api.rss2json.com/v1/api.json");
  assert.equal(url.searchParams.get("api_key"), env.RSS2JSON_API_KEY);
  assert.equal(url.searchParams.get("count"), "100");
  assert.equal(url.searchParams.get("order_by"), "pubDate");
  assert.equal(url.searchParams.get("order_dir"), "desc");
  assert.match(url.searchParams.get("rss_url"), /fw_bucket=6$/);
  assert.equal(new URL(gatewayUrl(1_800_000)).searchParams.has("count"), false);
});

test("direct RSS failure falls back to rss2json and ingests the result", async () => {
  const h = harness();
  let posted;
  let gatewayRequestUrl;
  const success = await runRssPush({ env, logger: h.logger, sleepImpl,
    rssFetchImpl: async () => { throw Object.assign(new Error("blocked"), { cause: { code: "ECONNREFUSED" } }); },
    gatewayFetchImpl: async (url) => { gatewayRequestUrl = url; return Response.json({ status: "ok", items: [{
      guid: "gateway-1", title: "Technická pomoc - Kladno", link: "https://example.test/gateway-1",
      pubDate: "2026-09-17 11:25:00", description: "stav: nová<br>Kladno"
    }] }); },
    ingestFetchImpl: async (_url, options) => { posted = JSON.parse(options.body); return Response.json({ ok: true, accepted: 1, inserted: 1, updated: 0 }); }
  });
  assert.equal(success, true);
  assert.equal(posted.source, "github_actions_rss2json");
  assert.equal(new URL(gatewayRequestUrl).searchParams.get("count"), "100");
  assert.match(h.logs.join("\n"), /fallback=rss2json/);
  assert.equal(h.logs.join("\n").includes(env.RSS2JSON_API_KEY), false);
});

test("script posts expected JSON and API key and logs only safe counts", async () => {
  const h = harness();
  let calls = 0;
  const success = await runRssPush({ env, logger: h.logger,
    rssFetchImpl: async (url) => { assert.equal(url, DEFAULT_RSS_URL); return new Response(rss(2)); },
    ingestFetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, env.FIREWATCH_INGEST_URL);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers["X-API-Key"], env.FIREWATCH_API_KEY);
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), buildRssPayload(rss(2)));
      return response();
    }
  });
  assert.equal(success, true);
  assert.equal(calls, 1);
  assert.match(h.logs.join("\n"), /RSS items=2/);
  assert.match(h.logs.join("\n"), /HTTP status=200/);
  assert.match(h.logs.join("\n"), /accepted=2; inserted=1; updated=1/);
  assert.match(h.logs.join("\n"), /skipped=5; skipped_older=4/);
  assert.equal(h.logs.join("\n").includes(env.FIREWATCH_API_KEY), false);
});

for (const failure of ["network", "503", "timeout"]) {
  test("ingest retries " + failure + " once using identical payload", async () => {
    let calls = 0;
    const bodies = [];
    const delays = [];
    const h = harness();
    const success = await runRssPush({ env, logger: h.logger, ingestTimeoutMs: 5,
      sleepImpl: async ms => delays.push(ms),
      rssFetchImpl: async () => new Response(rss(2)),
      ingestFetchImpl: async (_url, options) => {
        bodies.push(options.body);
        if (++calls === 1) {
          if (failure === "503") return new Response("secret response", { status: 503 });
          if (failure === "network") throw new Error(env.FIREWATCH_API_KEY);
          return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(env.FIREWATCH_API_KEY))));
        }
        return response();
      }
    });
    assert.equal(success, true);
    assert.equal(calls, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(delays, [1500]);
    assert.equal(h.logs.join("\n").includes(env.FIREWATCH_API_KEY), false);
  });
}

for (const status of [401, 403, 429, 302, 503]) {
  test("ingest HTTP " + status + " has safe diagnostics and bounded attempts", async () => {
    let calls = 0;
    const h = harness();
    const success = await runRssPush({ env, logger: h.logger, sleepImpl,
      rssFetchImpl: async () => new Response(rss(2)),
      ingestFetchImpl: async () => { calls++; return new Response(env.FIREWATCH_API_KEY, { status }); }
    });
    assert.equal(success, false);
    assert.equal(calls, status === 503 ? 2 : 1);
    assert.match(h.logs.join("\n"), /stage=ingest; category=http_status/);
    assert.match(h.logs.join("\n"), new RegExp("HTTP status=" + status));
    assert.equal(h.logs.join("\n").includes(env.FIREWATCH_API_KEY), false);
  });
}

test("RSS connect failure makes two attempts and never calls ingest", async () => {
  let calls = 0;
  const h = harness();
  const success = await runRssPush({ env, logger: h.logger, sleepImpl,
    rssFetchImpl: async () => { calls++; throw Object.assign(new Error(env.FIREWATCH_API_KEY), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); },
    gatewayFetchImpl: async () => { throw Object.assign(new Error("gateway down"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); },
    ingestFetchImpl: async () => assert.fail("unexpected ingest")
  });
  assert.equal(success, false);
  assert.equal(calls, 2);
  assert.match(h.logs.join("\n"), /stage=rss_gateway; category=connect_timeout/);
  assert.equal(h.logs.join("\n").includes(env.FIREWATCH_API_KEY), false);
});

test("invalid XML is not retried or sent to ingest", async () => {
  let calls = 0;
  const h = harness();
  assert.equal(await runRssPush({ env, logger: h.logger,
    rssFetchImpl: async () => { calls++; return new Response("invalid xml"); },
    gatewayFetchImpl: async () => Response.json({ status: "error" }),
    ingestFetchImpl: async () => assert.fail("unexpected ingest")
  }), false);
  assert.equal(calls, 1);
  assert.match(h.logs.join("\n"), /category=invalid_xml/);
});

test("empty RSS skips ingest because existing endpoint requires nonempty items", async () => {
  const h = harness();
  assert.equal(await runRssPush({ env, logger: h.logger,
    rssFetchImpl: async () => new Response(rss(0)),
    ingestFetchImpl: async () => assert.fail("unexpected ingest")
  }), true);
  assert.match(h.logs.join("\n"), /RSS items=0/);
  assert.match(h.logs.join("\n"), /ingest skipped/);
});

for (const body of ["invalid json", '{"ok":false}', '{"ok":true,"accepted":"test-secret-key","inserted":0,"updated":0}']) {
  test("invalid ingest response is safe and is not retried: " + body.slice(0, 15), async () => {
    let calls = 0;
    const h = harness();
    assert.equal(await runRssPush({ env, logger: h.logger,
      rssFetchImpl: async () => new Response(rss(2)),
      ingestFetchImpl: async () => { calls++; return new Response(body); }
    }), false);
    assert.equal(calls, 1);
    assert.match(h.logs.join("\n"), /category=invalid_ingest_response/);
    assert.equal(h.logs.join("\n").includes(env.FIREWATCH_API_KEY), false);
  });
}

test("configuration is validated before downloading RSS", async () => {
  assert.throws(() => readPushConfig({}), /missing_configuration/);
  for (const url of ["invalid", "http://firewatchcz.cz/api/ingest", "https://user:secret@firewatchcz.cz/api/ingest"]) {
    assert.throws(() => readPushConfig({ ...env, FIREWATCH_INGEST_URL: url }), /invalid_ingest_url/);
  }
  const h = harness();
  assert.equal(await runRssPush({ env: {}, logger: h.logger,
    rssFetchImpl: async () => assert.fail("unexpected download")
  }), false);
  assert.match(h.logs.join("\n"), /category=missing_configuration/);
});

test("CLI exits with status 1 and safe error when Secrets are missing", () => {
  const result = spawnSync(process.execPath, ["scripts/rss-push.js"], {
    env: { ...process.env, FIREWATCH_API_KEY: "", FIREWATCH_INGEST_URL: "" }, encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /category=missing_configuration/);
});
