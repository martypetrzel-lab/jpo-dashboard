// RSS and RSS2JSON pubDate represent a source timestamp, never an implicit Prague wall time.
export function normalizeFeedTimestamp(value) {
  const raw=String(value || '').trim();if(!raw)return null;
  const bare=raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  const input=bare ? bare[1]+'T'+bare[2]+':'+(bare[3] || '00')+'Z' : raw;
  const date=new Date(input);if(!Number.isFinite(date.getTime()))return null;
  if(bare && date.toISOString().slice(0,10)!==bare[1])return null;
  return date.toISOString();
}
export function hasTrustedStart(event={}) {
  if(!event.start_time_iso || event.start_time_source==='legacy_manual_unverified')return false;
  return ['rss_description','explicit','manual','esp'].includes(event.start_time_source) || event.source_kind==='manual' || event.status_source==='manual' || event.duration_source==='manual' || event.source_kind!=='rss';
}
export function annotateEventTime(event={}) {
  const trusted=hasTrustedStart(event);
  const source=event.source_kind==='rss' || event.source_updated_at;
  return {...event,source_updated_at:event.source_updated_at || (source ? event.pub_date : null),start_time_iso:trusted ? event.start_time_iso : null,start_time_trusted:trusted,time_label:source ? 'Poslední aktualizace zdroje' : 'Čas události',duration_min:event.source_kind!=='rss' || trusted || ['esp_duration','explicit','manual'].includes(event.duration_source) ? event.duration_min : null,duration_source:event.source_kind!=='rss' || trusted || ['esp_duration','explicit','manual'].includes(event.duration_source) ? event.duration_source : null};
}
export function diagnoseTimes(event={},incoming=null) {
  const original=event.pub_date;const raw=String(original || '');
  const format=/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)?'without_zone':/Z$/i.test(raw)?'iso_utc':/[+-]\d{4}|GMT|UTC/i.test(raw)?'explicit_zone':'unknown';
  const proposed=incoming ? normalizeFeedTimestamp(incoming.pubDate || incoming.pub_date) : format==='explicit_zone' ? normalizeFeedTimestamp(original) : null;
  return {id:event.id,original,format,assumed_zone:incoming ? 'UTC (fresh RSS/RSS2JSON)' : format==='explicit_zone'?'explicit':'ambiguous',proposed,reason:incoming?'authoritative fresh source; original preserved before update':format==='explicit_zone'?'unambiguous normalization':'no source evidence; skip',protected_start:hasTrustedStart(event),preserved_original_values:event.time_original_values || null,time_model_version:event.time_model_version || 0,dry_run:true};
}
