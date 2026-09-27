import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeSourceStatus, canonicalCentralUrl, parseCentralHistoricalDetail,
  stableSourceContentHash, buildSourceAdapters,
} from "../reconciliation.js";

const fixture = fs.readFileSync(fileURLToPath(new URL("./fixtures/stredocesky-history-203416.html", import.meta.url)), "utf8");

test("regional status mappings tolerate case, whitespace and Czech Unicode", () => {
  for (const value of [" probíhá zásah ", "AKTIVNÍ", "Probíhající", "SaP na místě", "nová", "neupřesněno"])
    assert.equal(normalizeSourceStatus(value), "active");
  for (const value of ["ukončená", "Ukončená", "zásah ukončen", "uhašeno", "likvidace ukončena"])
    assert.equal(normalizeSourceStatus(value), "completed");
  assert.equal(normalizeSourceStatus("bez strukturovaného stavu"), "unknown");
});

test("Central Bohemian historical detail uses canonical stable ID and authoritative status", () => {
  assert.equal(canonicalCentralUrl("RSS_FEED_203416"), "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/?id=203416");
  const event = parseCentralHistoricalDetail(fixture, { externalId: "RSS_FEED_203416" });
  assert.equal(event.externalId, "RSS_FEED_203416");
  assert.equal(event.normalizedStatus, "completed");
  assert.equal(event.city, "Rynholec");
  assert.equal(event.district, "Rakovník");
  assert.equal(event.alarmLevel, 3);
  assert.equal(event.sourceUpdatedAt, "2026-09-21T14:00:00.000Z");
});

test("source content hashes are stable, field-sensitive and ignore unrelated values", () => {
  const base = { sourceStatus: "aktivní", normalizedStatus: "active", title: "A", city: "Kladno" };
  assert.equal(stableSourceContentHash(base), stableSourceContentHash({ ...base, adminNote: "preserve" }));
  assert.notEqual(stableSourceContentHash(base), stableSourceContentHash({ ...base, title: "B" }));
});

test("adapters expose historical capability without treating feed disappearance as completion", async () => {
  const adapters = buildSourceAdapters({ fetchText: async () => ({ body: fixture, status: 200 }) });
  assert.equal(adapters.stredocesky.canFetchHistoricalEvent(), true);
  assert.equal(adapters.pardubicky.canFetchHistoricalEvent(), true);
  assert.equal(adapters.praha.canFetchHistoricalEvent(), false);
  const event = await adapters.stredocesky.fetchEventByExternalId("203416");
  assert.equal(event.normalizedStatus, "completed");
});
