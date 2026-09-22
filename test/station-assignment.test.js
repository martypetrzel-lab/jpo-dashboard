import test from "node:test";
import assert from "node:assert/strict";
import { canAutomaticallyAssignStation, normalizeStationAssignment, isExplicitCrossRegionAssistance } from "../station-assignment.js";

const station = { id: "sc-benesov", region: "Středočeský kraj" };

test("Praha and Pardubice never receive an automatic Central Bohemian station", () => {
  for (const source of ["praha", "pardubicky"]) {
    const event = { source, geo_verified: true, station_id: station.id, assignment_method: "regional_match" };
    assert.equal(canAutomaticallyAssignStation(event, station), false);
    assert.equal(normalizeStationAssignment(event, station).station_id, null);
  }
});

test("verified Central Bohemian event can use a station in the same region", () => {
  const event = { source: "stredocesky", geo_verified: true, station_id: station.id, assignment_method: "regional_match", assignment_confidence: 0.9 };
  assert.equal(canAutomaticallyAssignStation(event, station), true);
  assert.equal(normalizeStationAssignment(event, station).station_id, station.id);
});

test("missing station data never blocks an event or invents an assignment", () => {
  const event = { source: "pardubicky", responding_units: ["Letohrad"] };
  assert.deepEqual(normalizeStationAssignment(event), { station_id: null, station_region: null, assignment_method: "none", assignment_confidence: null });
  assert.deepEqual(event.responding_units, ["Letohrad"]);
});

test("cross-region assistance exists only with explicit or manual evidence", () => {
  const base = { source: "pardubicky", station_region: "Středočeský kraj", cross_region_assistance: true };
  assert.equal(isExplicitCrossRegionAssistance({ ...base, assignment_method: "regional_match" }), false);
  assert.equal(isExplicitCrossRegionAssistance({ ...base, assignment_method: "source_explicit" }), true);
  assert.equal(isExplicitCrossRegionAssistance({ ...base, assignment_method: "manual" }), true);
});
