import {eventLocation, normalizeName, normalizeDistrict} from './location.js';
export {eventLocation};
const ranks = {failed:0,region:0,district:0,municipality:2,locality:3,exact:4,manual:5};
export const insideCz = (lat,lon) => lat != null && lon != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && lat>=48.5 && lat<=51.1 && lon>=12 && lon<=18.9;
export const insideStc = (lat,lon) => insideCz(lat,lon) && lat>=49.3 && lat<=50.71 && lon>=13.25 && lon<=15.65;
export function cacheKey(context) {return ['v2',context.municipality,context.locality,context.district,context.state,context.country,context.detail].map(normalizeName).join('|');}
export function buildQueries(context) {
  if (!context.municipality || /^(okres|kraj)\b/i.test(context.municipality)) return [];
  const district = context.district ? 'okres '+normalizeDistrict(context.district) : '';
  const make = (...parts)=>parts.filter(Boolean).join(', ');
  return [...new Set([
    make(context.detail || context.locality,context.municipality,district,context.state,context.country),
    make(context.locality || context.detail,context.municipality,district,context.country),
    make(context.municipality,district,context.state,context.country),
    make(context.municipality,district,context.country)
  ])]; // A known district is never discarded by a fallback.
}
const centers = [
  ['Kladno','Kladno',50.1431,14.1052],['Mladá Boleslav','Mladá Boleslav',50.4114,14.9032],
  ['Kolín','Kolín',50.0281,15.2016],['Příbram','Příbram',49.6899,14.0104],
  ['Benešov','Benešov',49.7823,14.6869],['Beroun','Beroun',49.9638,14.072],
  ['Nymburk','Nymburk',50.1856,15.0433],['Mělník','Mělník',50.3513,14.4741],
  ['Rakovník','Rakovník',50.1037,13.7334],['Kutná Hora','Kutná Hora',49.9484,15.2682],
  ['Nehvizdy','Praha-východ',50.1306,14.7296],['Jirny','Praha-východ',50.1159,14.6971],
  ['Zápy','Praha-východ',50.1656,14.6811],['Čelákovice','Praha-východ',50.1605,14.7501]
];
export function localCenter(context) {
  const row=centers.find(([city,district])=>normalizeName(city)===normalizeName(context.municipality) && (!context.district || normalizeName(district)===normalizeName(context.district)));
  return row ? {lat:row[2],lon:row[3],precision:'municipality',confidence:70,source:'local-municipality',display_name:row[0]+', okres '+row[1],query:buildQueries(context).at(-1),context_key:cacheKey(context)} : null;
}
export function evaluateCandidate(candidate, context) {
  const address=candidate.address || {}, lat=Number(candidate.lat),lon=Number(candidate.lon);
  const reject=reason=>({accepted:false,reason});
  if(String(address.country_code || '').toLowerCase() !== 'cz')return reject('country_mismatch');
  if(!insideStc(lat,lon))return reject('outside_expected_area');
  if(!/^(stredocesky kraj|central bohemia|central bohemian region)$/.test(normalizeName(address.state || address.region)))return reject('state_mismatch');
  if(context.district && normalizeName(normalizeDistrict(address.county || address.state_district))!==normalizeName(context.district))return reject('district_mismatch');
  const type=candidate.addresstype || candidate.type;
  if(['county','state','region','country','state_district'].includes(type))return reject('administrative_result');
  const municipality=[address.city,address.town,address.village,address.municipality];
  if(!municipality.some(value=>normalizeName(value)===normalizeName(context.municipality)))return reject('municipality_mismatch');
  let precision='municipality', confidence=70;
  const locality=context.locality || context.detail;
  if(locality && [address.suburb,address.hamlet,address.neighbourhood,candidate.name].some(value=>value && normalizeName(value)===normalizeName(locality)) && ['suburb','hamlet','neighbourhood','quarter'].includes(type)){precision='locality';confidence=85;}
  else if(context.detail && !/\b(km|d\d+)\b/i.test(context.detail) &&
    ((candidate.name && normalizeName(candidate.name)===normalizeName(context.detail)) ||
      (address.road && address.house_number && normalizeName(address.road+' '+address.house_number)===normalizeName(context.detail))) &&
    !['city','town','village','municipality','administrative','road'].includes(type)){precision='exact';confidence=95;}
  else if(!['city','town','village','municipality'].includes(type))return reject('detail_not_matched');
  return {accepted:true,lat,lon,precision,confidence,source:'nominatim',display_name:String(candidate.display_name || ''),context_key:cacheKey(context)};
}
export function selectCandidate(candidates,context) {
  const results=candidates.map(c=>evaluateCandidate(c,context)), accepted=results.filter(c=>c.accepted).sort((a,b)=>b.confidence-a.confidence);
  if(!accepted.length)return {precision:'failed',failure_reason:results[0]?.reason || 'not_found',lat:null,lon:null};
  if(accepted.some(c=>c.confidence===accepted[0].confidence && (c.lat!==accepted[0].lat || c.lon!==accepted[0].lon)))return {precision:'failed',failure_reason:'ambiguous_result',lat:null,lon:null};
  return accepted[0];
}
export function protectedCoordinates(event) {return event.geo_verified===true || /manual|admin/i.test(event.geo_source || '');}
export function canImprove(event, proposal, repair=false) {
  if(protectedCoordinates(event) || !insideStc(proposal?.lat,proposal?.lon) || !ranks[proposal?.precision])return false;
  if(proposal.context_key && proposal.context_key!==cacheKey(eventLocation(event)))return false;
  if(event.lat==null || event.lon==null)return true;
  if(repair && ['district_fallback','outside_expected_area'].includes(annotateEventGeo(event).geo_failure_reason))return true;
  return !!event.geo_precision && (ranks[proposal.precision] || 0)>(ranks[event.geo_precision] || 0);
}
export function annotateEventGeo(event) {
  const context=eventLocation(event), center=localCenter(context);
  let precision=event.geo_precision, reason=event.geo_failure_reason || '';
  const fallback=(Number(event.lat)===50.1073 && Number(event.lon)===14.725) || (Number(event.lat)===49.9833 && Number(event.lon)===14.3333);
  if(!insideStc(event.lat,event.lon))reason=event.lat==null || event.lon==null ? (reason || 'missing_coordinates') : 'outside_expected_area';
  else if(fallback && !event.geo_verified)reason='district_fallback';
  else if(precision && precision!=='manual' && event.geo_context_key && event.geo_context_key!==cacheKey(context))reason='context_mismatch';
  else if(precision && precision!=='manual' && event.geo_confidence!=null && Number(event.geo_confidence)<60)reason='low_confidence';
  else if(!precision && /^manual_event_(create|edit)$/.test(event.geo_source || '')){precision='manual';reason='';}
  else if(!precision && center && Number(event.lat)===center.lat && Number(event.lon)===center.lon){precision='municipality';reason='';}
  else if(!precision)reason='unverified_legacy';
  const reliable=insideStc(event.lat,event.lon) && !reason && !!ranks[precision];
  return {...event,district_text:context.district,geo_municipality:context.municipality,geo_locality:context.locality,geo_detail:context.detail,geo_precision:precision || 'failed',geo_reliable:reliable,geo_failure_reason:reason,
    geo_label:reliable ? (precision==='municipality'?'Přibližná poloha – střed obce':precision==='locality'?'Přibližná poloha – část obce':precision==='manual'?'Ručně určená poloha':'Přesná poloha') : 'Poloha na mapě nebyla spolehlivě určena.'};
}
export function diagnoseCoordinates(events) {
  const groups=new Map();
  for(const event of events){if(event.lat==null || event.lon==null)continue;const key=event.lat+'|'+event.lon;const group=groups.get(key)||[];group.push(event);groups.set(key,group);}
  return events.map(event=>{const row=annotateEventGeo(event),group=groups.get(event.lat+'|'+event.lon)||[];
    const contexts=new Set(group.map(e=>{const c=eventLocation(e);return normalizeName(c.municipality)+'|'+normalizeName(c.district);}));
    const reasons=[...(row.geo_reliable?[]:[row.geo_failure_reason || 'low_precision']),...(!event.geo_source && event.lat!=null?['missing_source']:[]),...(/fallback/i.test(event.geo_source || '')?['fallback_source']:[]),...(contexts.size>1?['shared_point_different_places']:[])];
    return {...row,geo_diagnostic_reasons:reasons,geo_protected:protectedCoordinates(event)};
  }).filter(row=>row.geo_diagnostic_reasons.length);
}
export function createGeocoder({fetchImpl=fetch,getCache=async()=>null,setCache=async()=>{},reserve=async()=>{},endpoint='https://nominatim.openstreetmap.org/search',userAgent='FireWatchCZ/1.1 (https://firewatchcz.cz/)'}={}) {
  let queue=Promise.resolve();const inFlight=new Map();
  async function lookup(event,{remote=false,refresh=false}={}) {
    const context=eventLocation(event),key=cacheKey(context),queries=buildQueries(context);
    if(!queries.length)return {lat:null,lon:null,precision:'failed',failure_reason:'missing_municipality',query:'',context_key:key};
    if(!refresh){const cached=await getCache(key);if(cached && cached.context_key===key && (cached.precision==='failed' || insideStc(cached.lat,cached.lon)))return cached;}
    const local=localCenter(context);if(!remote)return local || {lat:null,lon:null,precision:'failed',failure_reason:'lookup_required',query:queries[0],context_key:key};
    if(inFlight.has(key))return inFlight.get(key);
    const task=queue.then(async()=>{
      let result={lat:null,lon:null,precision:'failed',failure_reason:'not_found'};
      for(const query of queries){
        for(let attempt=0;attempt<2;attempt++){
          await reserve();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),9000);
          try{
            const url=new URL(endpoint);Object.entries({q:query,format:'jsonv2',limit:'10',countrycodes:'cz',addressdetails:'1',bounded:'1',viewbox:'13.25,50.71,15.65,49.30'}).forEach(([k,v])=>url.searchParams.set(k,v));
            const response=await fetchImpl(url,{signal:controller.signal,headers:{'User-Agent':userAgent,'Accept-Language':'cs,en;q=0.8'}});
            if(!response.ok){result={lat:null,lon:null,precision:'failed',failure_reason:response.status===429?'rate_limited':response.status>=500?'provider_unavailable':'provider_rejected'};if(attempt===0 && (response.status===429 || response.status>=500))continue;break;}
            const data=await response.json();result={...selectCandidate(Array.isArray(data)?data:[],context),query};break;
          }catch{result={lat:null,lon:null,precision:'failed',failure_reason:'provider_unavailable'};if(attempt===0)continue;}
          finally{clearTimeout(timer);}
        }
        if(result.precision!=='failed' || ['rate_limited','provider_unavailable','provider_rejected'].includes(result.failure_reason))break;
      }
      if(result.precision==='failed' && local)result=local;
      result={...result,query:result.query || queries[0],context_key:key};await setCache(key,result,result.precision==='failed'?(['rate_limited','provider_unavailable'].includes(result.failure_reason)?300:86400):30*86400);return result;
    });
    queue=task.catch(()=>{});inFlight.set(key,task);try{return await task;}finally{inFlight.delete(key);}
  }
  return {lookup};
}
// Feed ingestion remains fast. Only events with no stored coordinates enter this
// bounded queue; historical points require an administrator's individual preview.
export function createGeocodeJobs({lookup,getEvent,apply,recordFailure,onError=()=>{},limit=200}) {
  const pending=new Map();let running=false,stopped=false;
  async function drain(){
    if(running || stopped)return;running=true;
    try{while(pending.size && !stopped){const [id]=pending.keys();
      try{const event=await getEvent(id);
        if(event && event.lat==null && event.lon==null && !protectedCoordinates(event)){
          const proposal=await lookup(event,{remote:true});
          if(!stopped){if(proposal.precision==='failed')await recordFailure(id,proposal);else await apply(id,proposal);}
        }
      }catch(error){onError(error);}finally{pending.delete(id);}
    }}finally{running=false;}
  }
  return {enqueue(id){if(stopped || pending.size>=limit || pending.has(id))return false;pending.set(id,true);void drain();return true;},stop(){stopped=true;pending.clear();},get size(){return pending.size;}};
}
