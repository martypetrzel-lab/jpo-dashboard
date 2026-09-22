const SOURCE_REGIONS = Object.freeze({
  stredocesky: "Středočeský kraj",
  praha: "Hlavní město Praha",
  pardubicky: "Pardubický kraj"
});

export function eventRegion(event = {}) {
  return event.event_region || event.region || SOURCE_REGIONS[event.source] || null;
}

export function canAutomaticallyAssignStation(event, station, method = "regional_match") {
  if (!event || !station || method !== "regional_match") return false;
  const region = eventRegion(event);
  return !!region && station.region === region && event.geo_verified === true;
}

export function normalizeStationAssignment(event = {}, station = null) {
  const method = ["source_explicit", "regional_match", "manual", "none"].includes(event.assignment_method)
    ? event.assignment_method : "none";
  if (!event.station_id || method === "none") {
    return { station_id: null, station_region: null, assignment_method: "none", assignment_confidence: null };
  }
  if (["source_explicit", "manual"].includes(method)) {
    return { station_id: event.station_id, station_region: event.station_region || station?.region || null, assignment_method: method, assignment_confidence: event.assignment_confidence ?? null };
  }
  if (!canAutomaticallyAssignStation(event, station, method)) {
    return { station_id: null, station_region: null, assignment_method: "none", assignment_confidence: null };
  }
  return { station_id: event.station_id, station_region: station.region, assignment_method: method, assignment_confidence: event.assignment_confidence ?? null };
}

export function isExplicitCrossRegionAssistance(event = {}) {
  const region = eventRegion(event);
  return event.cross_region_assistance === true && ["source_explicit", "manual"].includes(event.assignment_method) &&
    !!event.station_region && !!region && event.station_region !== region;
}

export { SOURCE_REGIONS };
