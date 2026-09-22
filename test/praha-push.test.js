import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PRAHA_ATOM_URL } from "../prague-atom.js";
import { buildPrahaPayload, runPrahaPush } from "../scripts/praha-push.js";

const xml = fs.readFileSync(fileURLToPath(new URL("./fixtures/praha-atom.xml", import.meta.url)), "utf8");
const env = { FIREWATCH_INGEST_URL: "https://firewatchcz.cz/api/ingest", FIREWATCH_API_KEY: "never-log-this", PRAHA_MAX_AGE_HOURS: "24" };
const harness = () => { const logs = []; return { logs, logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) } }; };

test("Praha push builds source-specific payload and safely logs ingest counters", async () => {
  const h = harness();
  let posted;
  const ok = await runPrahaPush({ env, logger: h.logger, now: new Date("2026-09-22T10:00:00+02:00"),
    atomFetchImpl: async (url) => { assert.equal(url, PRAHA_ATOM_URL); return new Response(xml); },
    ingestFetchImpl: async (_url, options) => {
      assert.equal(options.headers["X-API-Key"], env.FIREWATCH_API_KEY);
      posted = JSON.parse(options.body);
      return Response.json({ ok: true, accepted: 1, inserted: 1, updated: 0, unchanged: 0, skipped_older: 2 });
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(posted, buildPrahaPayload(xml));
  assert.equal(posted.items.length, 3);
  assert.match(h.logs.join("\n"), /found=3; HTTP status=200; new=1; updated=0; unchanged=0; skipped_old=2; errors=0/);
  assert.equal(h.logs.join("\n").includes(env.FIREWATCH_API_KEY), false);
});

test("Praha dry-run performs no write and reports old initial entries", async () => {
  const h = harness();
  const ok = await runPrahaPush({ env: { PRAHA_DRY_RUN: "1", PRAHA_MAX_AGE_HOURS: "24" }, logger: h.logger,
    now: new Date("2026-09-22T10:00:00+02:00"), atomFetchImpl: async () => new Response(xml),
    ingestFetchImpl: async () => assert.fail("dry-run must not call ingest"),
  });
  assert.equal(ok, true);
  assert.match(h.logs.join("\n"), /dry-run; found=3; eligible=1; skipped_old=2/);
});

test("Praha download retries once and reports a safe error category", async () => {
  const h = harness();
  let attempts = 0;
  const ok = await runPrahaPush({ env, logger: h.logger, sleepImpl: async () => {},
    atomFetchImpl: async () => { attempts++; throw Object.assign(new Error(env.FIREWATCH_API_KEY), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); },
    ingestFetchImpl: async () => assert.fail("unexpected ingest"),
  });
  assert.equal(ok, false);
  assert.equal(attempts, 2);
  assert.match(h.logs.join("\n"), /category=connect_timeout/);
  assert.equal(h.logs.join("\n").includes(env.FIREWATCH_API_KEY), false);
});

test("workflow runs both sources independently before evaluating failures", () => {
  const workflow = fs.readFileSync(fileURLToPath(new URL("../.github/workflows/rss-ingest.yml", import.meta.url)), "utf8");
  assert.match(workflow, /id: stredocesky\s+continue-on-error: true[\s\S]+node scripts\/rss-push\.js/);
  assert.match(workflow, /id: praha\s+continue-on-error: true[\s\S]+node scripts\/praha-push\.js/);
  assert.match(workflow, /id: pardubicky\s+continue-on-error: true[\s\S]+node scripts\/pardubicky-push\.js/);
  assert.match(workflow, /name: Check independent source imports\s+if: always\(\)/);
});
