import test from "node:test";
import assert from "node:assert/strict";
import { buildRegionComparison } from "../server.js";

const row = (source, patch={}) => ({
  source, region: source === "praha" ? "Hlavní město Praha" : source === "pardubicky" ? "Pardubický kraj" : "Středočeský kraj",
  event_region: source === "praha" ? "Hlavní město Praha" : source === "pardubicky" ? "Pardubický kraj" : "Středočeský kraj",
  pub_date: "2026-09-21T10:00:00Z", event_type: "fire", is_jpo_event: true,
  is_closed: false, status_source: "explicit_open", city_text: "Test", lat: null, lon: null,
  ...patch
});

test("regional comparison keeps JPO incidents separate from Prague utilities", () => {
  const rows = [
    row("stredocesky"),
    row("praha", {event_type:"utility_water", is_jpo_event:false}),
    row("praha", {event_type:"traffic", is_jpo_event:true}),
    row("pardubicky", {is_closed:true,status_source:"explicit_closed",district_text:"Ústí nad Orlicí"})
  ];
  const result = buildRegionComparison(rows, [], {start:"2026-09-21",end:"2026-09-22T00:00:00Z",sourceStatus:{}});
  assert.equal(result.period.end,"2026-09-21");
  assert.equal(result.period.end_exclusive,"2026-09-22T00:00:00Z");
  const praha = result.regions.find(r=>r.source==="praha");
  assert.equal(praha.all.total,2);
  assert.equal(praha.all.other,1);
  assert.equal(praha.jpo.total,1);
  assert.equal(praha.station_data_available,false);
});

test("regional comparison reports unknown state and avoids fake station zeroes", () => {
  const result=buildRegionComparison([row("pardubicky",{status_source:"unknown"})],[],{start:"2026-09-21",end:"2026-09-22T00:00:00Z",sourceStatus:{pardubicky:"2026-09-21T11:00:00Z"}});
  const region=result.regions.find(r=>r.source==="pardubicky");
  assert.equal(region.all.unknown,1);
  assert.equal(region.station_data_available,false);
  assert.equal("station_count" in region,false);
  assert.equal(region.last_successful_import,"2026-09-21T11:00:00Z");
});
