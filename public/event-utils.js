/* Shared, DOM-free rules used by the dashboard and tested in Node. */
(function (scope) {
  function coordinate(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(String(value).replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }
  function hasCoords(event) {
    const lat = coordinate(event?.lat), lon = coordinate(event?.lon);
    return event?.geo_reliable !== false && lat !== null && lon !== null && lat >= 48.5 && lat <= 51.1 && lon >= 12 && lon <= 18.9;
  }
  function groupMapEvents(items) {
    const groups=new Map();
    for(const event of normalizeEvents(items)) {if(!hasCoords(event))continue;const key=event.lat+'|'+event.lon;const group=groups.get(key)||[];group.push(event);groups.set(key,group);}
    return [...groups.values()];
  }
  function normalizeEvents(items) {
    const rows = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.id == null || !String(item.id).trim()) continue;
      rows.set(String(item.id), {...item, lat:coordinate(item.lat ?? item.latitude), lon:coordinate(item.lon ?? item.lng ?? item.longitude)});
    }
    return [...rows.values()];
  }
  function sortEvents(items, order = 'active') {
    const time = row => {const t = Date.parse(row.start_time_iso || row.pub_date || '');return Number.isFinite(t) ? t : 0;};
    return [...items].sort((a,b) => (order === 'active' ? Number(!!a.is_closed)-Number(!!b.is_closed) : 0) || (order === 'oldest' ? time(a)-time(b) : time(b)-time(a)) || String(a.id).localeCompare(String(b.id)));
  }
  function duration(event, now = Date.now()) {
    if (!event) return null;
    const estimated=event.duration_is_estimate===true || event.duration_is_estimate==='true';
    if(estimated){
      if(event.first_seen_was_open!==true && event.first_seen_was_open!=='true')return null;
      if(event.duration_source==='first_seen_open_estimate'&&!event.is_closed){const start=Date.parse(event.first_seen_at||'');if(!Number.isFinite(start)||start>=now)return null;const minutes=Math.floor((now-start)/60000);return minutes>0&&minutes<=4320?minutes:null;}
      if(event.duration_source==='first_seen_to_rss_end_estimate'&&event.is_closed){const start=Date.parse(event.first_seen_at||''),end=Date.parse(event.end_time_iso||'');if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)return null;const minutes=Math.floor((end-start)/60000);return minutes>0&&minutes<=4320?minutes:null;}
      return null;
    }
    if(event.start_time_trusted===false && !["esp_duration","explicit","manual"].includes(event.duration_source))return null;
    if(event.source_kind==='rss' && !['rss_description','explicit','manual','esp'].includes(event.start_time_source) && event.status_source!=='manual' && event.duration_source!=='manual')return null;
    if (event.is_closed) {
      if (!['rss_start_and_end','manual_start_rss_end','trusted_start_rss_end','rss_end_time','esp_duration','explicit','manual'].includes(event.duration_source)) return null;
      const n = Number(event.duration_min);
      return event.duration_min != null && Number.isFinite(n) && n > 0 && n <= 4320 ? n : null;
    }
    const start = Date.parse(event.start_time_iso || (event.source_kind==='rss' ? '' : event.pub_date) || '');
    if (!Number.isFinite(start) || start > now) return null;
    const minutes=Math.floor((now-start)/60000);return minutes>0 && minutes<=4320 ? minutes : null;
  }
  function durationInfo(event,now=Date.now()){
    const minutes=duration(event,now),estimate=minutes!=null&&(event?.duration_is_estimate===true||event?.duration_is_estimate==='true');
    return {minutes,estimate,tooltip:minutes==null?'Délku nelze určit – zdroj neposkytuje čas zahájení.':estimate?'Orientační doba od prvního zachycení události FireWatch. Skutečný začátek zásahu zdroj neposkytuje.':'Délka ze skutečného nebo ručně ověřeného začátku a konce zásahu.'};
  }
  function durationText(event,now=Date.now()){
    const info=durationInfo(event,now);if(info.minutes==null)return '—';
    const h=Math.floor(info.minutes/60),m=Math.round(info.minutes%60),value=h>0?h+' h '+m+' min':m+' min';
    return (info.estimate?'≈ ':'')+value;
  }
  function safeLink(value) {
    try {const url = new URL(value);return ['http:','https:'].includes(url.protocol) ? url.href : '';} catch {return '';}
  }
  function reconnectDelay(attempt, closeCode) {
    if (attempt >= 6 || [1008,4001,4003].includes(closeCode)) return null;
    return Math.min(30000,1800 * 2 ** attempt);
  }
  function pragueInput(value) {
    if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
    return parts.year+'-'+parts.month+'-'+parts.day+'T'+parts.hour+':'+parts.minute+':'+parts.second;
  }
  function pragueIso(value) {
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value||''))return null;
    const normalized=value.length===16?value+':00':value;
    const wall=Date.parse(normalized+'Z');if(!Number.isFinite(wall))return null;
    for(const offset of [120,60]){const date=new Date(wall-offset*60000);if(pragueInput(date.toISOString())===normalized)return date.toISOString();}
    return null;
  }
  scope.FireWatchData = Object.freeze({coordinate,hasCoords,groupMapEvents,normalizeEvents,sortEvents,duration,durationInfo,durationText,safeLink,reconnectDelay,pragueInput,pragueIso});
})(globalThis);
