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
export const MAX_EVENT_DURATION_MINUTES=4320;
const EXACT_DURATION_SOURCES=new Set(['rss_start_and_end','manual_start_rss_end','trusted_start_rss_end','rss_end_time','esp_duration','explicit','manual']);
const ESTIMATED_DURATION_SOURCES=new Set(['first_seen_open_estimate','first_seen_to_rss_end_estimate']);
function positiveMinutes(from,to) {
  const start=Date.parse(from || ''),end=Date.parse(to || '');
  if(!Number.isFinite(start)||!Number.isFinite(end))return null;
  const value=Math.floor((end-start)/60000);
  return value>0&&value<=MAX_EVENT_DURATION_MINUTES?value:null;
}
export function durationForEvent(event={},now=Date.now()) {
  const source=event.duration_source;
  const estimated=event.duration_is_estimate===true || event.duration_is_estimate==='true';
  if(estimated && ESTIMATED_DURATION_SOURCES.has(source)) {
    if(event.first_seen_was_open!==true && event.first_seen_was_open!=='true')return null;
    if(source==='first_seen_open_estimate' && !event.is_closed)return positiveMinutes(event.first_seen_at,new Date(now).toISOString());
    if(source==='first_seen_to_rss_end_estimate' && event.is_closed)return positiveMinutes(event.first_seen_at,event.end_time_iso);
    return null;
  }
  if(!EXACT_DURATION_SOURCES.has(source))return null;
  if(event.source_kind==='rss' && !hasTrustedStart(event) && !['esp_duration','explicit','manual'].includes(source))return null;
  const value=Number(event.duration_min);
  return event.duration_min!=null&&Number.isFinite(value)&&value>0&&value<=MAX_EVENT_DURATION_MINUTES?value:null;
}
export function annotateEventTime(event={},now=Date.now()) {
  const trusted=hasTrustedStart(event);
  const source=event.source_kind==='rss' || event.source_updated_at;
  const normalized={...event,source_updated_at:event.source_updated_at || (source ? event.pub_date : null),start_time_iso:trusted ? event.start_time_iso : null,start_time_trusted:trusted,time_label:source ? 'Poslední aktualizace zdroje' : 'Čas události'};
  const duration=durationForEvent(normalized,now);
  return {...normalized,duration_min:duration,duration_source:duration==null?null:event.duration_source,duration_is_estimate:duration==null?false:!!event.duration_is_estimate};
}
export function diagnoseTimes(event={},incoming=null) {
  const original=event.pub_date;const raw=String(original || '');
  const format=/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)?'without_zone':/Z$/i.test(raw)?'iso_utc':/[+-]\d{4}|GMT|UTC/i.test(raw)?'explicit_zone':'unknown';
  const proposed=incoming ? normalizeFeedTimestamp(incoming.pubDate || incoming.pub_date) : format==='explicit_zone' ? normalizeFeedTimestamp(original) : null;
  return {id:event.id,original,format,assumed_zone:incoming ? 'UTC (fresh RSS/RSS2JSON)' : format==='explicit_zone'?'explicit':'ambiguous',proposed,reason:incoming?'authoritative fresh source; original preserved before update':format==='explicit_zone'?'unambiguous normalization':'no source evidence; skip',protected_start:hasTrustedStart(event),preserved_original_values:event.time_original_values || null,time_model_version:event.time_model_version || 0,dry_run:true};
}
