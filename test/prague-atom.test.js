import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parsePrahaAtomXml, planPrahaImport, shouldIngestPrahaItem,
} from "../prague-atom.js";

const fixture = fs.readFileSync(fileURLToPath(new URL("./fixtures/praha-atom.xml", import.meta.url)), "utf8");

test("Praha Atom parser preserves UUID, link, diacritics and source identity", () => {
  const items = parsePrahaAtomXml(fixture);
  assert.equal(items.length, 3);
  assert.equal(items[0].externalId, "urn:uuid:2a261795-615c-40d0-a347-8a092bde31a8");
  assert.equal(items[0].id, `praha:${items[0].externalId}`);
  assert.equal(items[0].source, "praha");
  assert.equal(items[0].sourceUrl, "https://bezpecnost.praha.eu/udalosti/udalost_22_9_2026");
  assert.match(items[0].title, /řadu/);
  assert.equal(items[0].sourceUpdatedAt, "2026-09-21T22:31:18.028Z");
  assert.equal(items[0].eventType, "water");
  assert.equal(items[0].cityText, "Praha 11");
  assert.equal(items[0].statusSource, "source_estimated_open");
  assert.equal(items[0].isJpoEvent, false);
  assert.match(items[0].contentHash, /^[a-f0-9]{64}$/);
});

test("Praha status is conservative and HZS closed text is only an estimate", () => {
  const items = parsePrahaAtomXml(fixture);
  assert.equal(items[2].eventType, "hzs");
  assert.equal(items[2].isJpoEvent, true);
  assert.equal(items[2].isClosed, true);
  assert.equal(items[2].statusSource, "source_estimated_closed");
});

test("initial Praha import accepts only fresh entries and later rechecks known old IDs", () => {
  const items = parsePrahaAtomXml(fixture);
  const now = new Date("2026-09-22T10:00:00+02:00");
  const initial = planPrahaImport(items, { now, maxAgeHours: 24 });
  assert.equal(initial.found, 3);
  assert.deepEqual(initial.eligible.map((item) => item.externalId), [items[0].externalId]);
  assert.equal(initial.skippedOld.length, 2);
  assert.equal(shouldIngestPrahaItem(items[1], { previouslyKnown: true, now, maxAgeHours: 24 }), true);
});

test("changed summary changes content hash while stable Atom is deterministic", () => {
  const first = parsePrahaAtomXml(fixture)[0];
  assert.equal(parsePrahaAtomXml(fixture)[0].contentHash, first.contentHash);
  const changed = parsePrahaAtomXml(fixture.replace("Předpoklad ukončení opravy", "Oprava byla prodloužena"))[0];
  assert.notEqual(changed.contentHash, first.contentHash);
  assert.equal(changed.id, first.id);
});
