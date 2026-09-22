import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parsePardubickyRss, parsePardubickyDetail, buildPardubickyEvent,
  canonicalPardubickyUrl, pardubickyExternalId, pardubickyAgeClass,
} from "../pardubicky-rss.js";

const fixture = name => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

test("Pardubice RSS extracts stable numeric ID, canonical HTTPS URL, GMT instant and image type", () => {
  const items=parsePardubickyRss(fixture("pardubicky-rss.xml"));assert.equal(items.length,2);
  assert.equal(items[0].externalId,"251817053");assert.equal(items[0].id,"pardubicky:251817053");
  assert.equal(items[0].sourceUrl,"https://www.hzspa.cz/vyjezdy/udalost.php?id=251817053");assert.ok(!items[0].sourceUrl.includes("utm_"));
  assert.equal(items[0].reportedAt,"2026-09-22T05:43:56.000Z");assert.equal(items[0].eventType,"tech");assert.equal(items[0].description,null);
  assert.equal(items[1].cityText,"Česká Třebová");assert.equal(items[1].cityPart,"Lhotka");assert.equal(items[1].eventType,"fire");assert.equal(items[1].description,"kouř v objektu");
  assert.equal(pardubickyExternalId(items[0].sourceUrl),"251817053");assert.equal(canonicalPardubickyUrl("http://www.hzspa.cz/vyjezdy/udalost.php?id=251817053#utm_source=x"),items[0].sourceUrl);
});

test("Pardubice detail finds labeled fields structurally and keeps explicit units/status",()=>{
  const detail=parsePardubickyDetail(fixture("pardubicky-detail.html"));
  assert.equal(detail.type,"Technická pomoc");assert.equal(detail.subtype,"Otevření uzavřených prostor");assert.equal(detail.district,"Ústí nad Orlicí");
  assert.equal(detail.city,"Letohrad");assert.equal(detail.street,"Spořilov III");assert.deepEqual(detail.respondingUnits,["Letohrad","JSDH Žamberk"]);assert.equal(detail.isClosed,true);assert.equal(detail.description,null);
});

test("Pardubice event contains detail hash and authoritative status without invented end",()=>{
  const item=parsePardubickyRss(fixture("pardubicky-rss.xml"))[0],detail=parsePardubickyDetail(fixture("pardubicky-detail.html"));
  const event=buildPardubickyEvent(item,detail,{observedAt:"2026-09-22T06:00:00Z"});assert.equal(event.title,"Technická pomoc – Otevření uzavřených prostor – Letohrad");
  assert.equal(event.statusSource,"explicit_closed");assert.equal(event.isClosed,true);assert.equal(event.endTimeIso,undefined);assert.equal(event.district,"Ústí nad Orlicí");assert.match(event.contentHash,/^[a-f0-9]{64}$/);
});

test("Pardubice parser tolerates missing optional fields and invalid HTML",()=>{
  const detail=parsePardubickyDetail("<html><p><strong>Obec:</strong> Letohrad</p><p><strong>Stav:</strong> Probíhající</p>");
  assert.equal(detail.city,"Letohrad");assert.equal(detail.street,null);assert.deepEqual(detail.respondingUnits,[]);assert.equal(detail.isOpen,true);
  assert.deepEqual(parsePardubickyDetail("not html").respondingUnits,[]);
});

test("Pardubice age policy uses Europe/Prague calendar across UTC midnight",()=>{
  const now=new Date("2026-09-22T00:30:00+02:00");
  assert.equal(pardubickyAgeClass({reportedAt:"2026-09-21T22:15:00Z"},now),"today");
  assert.equal(pardubickyAgeClass({reportedAt:"2026-09-20T22:15:00Z"},now),"yesterday");
});
