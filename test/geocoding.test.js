import test from 'node:test';
import assert from 'node:assert/strict';
import {eventLocation,normalizeName,normalizeDistrict} from '../location.js';
import {buildQueries,buildPrahaQueries,cacheKey,evaluateCandidate,evaluatePrahaCandidate,selectCandidate,localCenter,annotateEventGeo,canImprove,diagnoseCoordinates,createGeocoder,createGeocodeJobs,insidePraha} from '../geocoding.js';
import {rssItemToEvent} from '../rss-worker.js';
import '../public/event-utils.js';
const event={city_text:'Dobřejovice',description_raw:'stav: probíhá zásah<br>Dobřejovice<br>okres Praha Východ'};
const context=eventLocation(event);
const candidate=(patch={})=>({lat:'49.981',lon:'14.581',addresstype:'village',display_name:'Dobřejovice, okres Praha-východ',address:{country_code:'cz',state:'Středočeský kraj',county:'okres Praha-východ',village:'Dobřejovice'},...patch});
test('RSS separates a motorway kilometre from its municipality and preserves location meaning',()=>{
 const item=rssItemToEvent({title:'Dopravní nehoda',description:'stav: probíhá zásah<br>D8 PRAHA - ÚSTÍ (Teplice), km: 9.0<br>Postřižín<br>okres Mělník'});
 assert.equal(item.cityText,'Postřižín');assert.equal(item.placeText,'D8 PRAHA - ÚSTÍ (Teplice), km: 9.0');
 assert.equal(normalizeName('Brandýs nad Labem-Stará Boleslav'),'brandys nad labem stara boleslav');
});
test('queries retain known district on every fallback and start with specific location',()=>{
 const c={...context,detail:'Hlavní 12',locality:'Dolní část'};const queries=buildQueries(c);
 assert.match(queries[0],/^Hlavní 12, Dobřejovice, okres Praha-východ/);
 assert.ok(queries.every(q=>q.includes('okres Praha-východ') && q.includes('Česko')));
 assert.match(queries[1],/^Dolní část,/);
});
test('district aliases and diacritics normalize without changing meaning',()=>{
 assert.equal(normalizeDistrict('okres Praha Východ'),'Praha-východ');assert.equal(normalizeDistrict('Praha západ'),'Praha-západ');
 assert.equal(evaluateCandidate(candidate({address:{...candidate().address,village:'Dobrejovice'}}),context).accepted,true);
});
test('unique municipality is accepted with explicit approximate precision',()=>{
 const result=evaluateCandidate(candidate(),context);assert.equal(result.precision,'municipality');assert.equal(result.confidence,70);
});
test('duplicate municipality in a different district is rejected',()=>{
 const c={...context,municipality:'Petrovice',district:'Příbram'};
 assert.equal(evaluateCandidate(candidate({address:{...candidate().address,village:'Petrovice',county:'okres Benešov'}}),c).reason,'district_mismatch');
 assert.notEqual(cacheKey(c),cacheKey({...c,district:'Benešov'}));
});
test('Praha-západ is distinct from Praha-východ and never a local fallback',()=>{
 const c={...context,district:'Praha-západ'};assert.equal(evaluateCandidate(candidate(),c).reason,'district_mismatch');
 assert.equal(localCenter(c),null);assert.equal(localCenter({...c,municipality:'Praha-západ'}),null);
});
test('matching locality is scored above municipality and exact named place above locality',()=>{
 const c={...context,locality:'Dolní část',detail:'Hasičská zbrojnice'};
 assert.equal(evaluateCandidate(candidate({addresstype:'suburb',name:'Dolní část'}),c).precision,'locality');
 assert.equal(evaluateCandidate(candidate({addresstype:'amenity',name:'Hasičská zbrojnice'}),c).precision,'exact');
 assert.equal(evaluateCandidate(candidate({addresstype:'house',address:{...candidate().address,road:'Hlavní',house_number:'12'}}),{...c,detail:'Hlavní 12'}).precision,'exact');
 assert.equal(evaluateCandidate(candidate({addresstype:'road',name:'D8 km 9'}),{...c,detail:'D8 km 9'}).accepted,false);
});
for(const [name,patch,reason] of [
 ['district',{addresstype:'county'},'administrative_result'],['region',{addresstype:'state'},'administrative_result'],
 ['foreign country',{address:{...candidate().address,country_code:'de'}},'country_mismatch'],
 ['wrong region',{address:{...candidate().address,state:'Jihočeský kraj'}},'state_mismatch'],
 ['wrong municipality',{address:{...candidate().address,village:'Nupaky'}},'municipality_mismatch'],
 ['outside Czechia',{lat:45,lon:7},'outside_expected_area']
])test('rejects '+name+' without a marker',()=>{
 const result=selectCandidate([candidate(patch)],context);assert.equal(result.failure_reason,reason);assert.equal(result.lat,null);assert.equal(result.lon,null);
});
test('missing municipality, district-only and empty result never invent coordinates',async()=>{
 assert.deepEqual(buildQueries({...context,municipality:''}),[]);assert.deepEqual(buildQueries({...context,municipality:'okres Praha-východ'}),[]);
 let requests=0;const service=createGeocoder({fetchImpl:async()=>{requests++;return {ok:true,json:async()=>[]};}});
 assert.equal((await service.lookup({},{remote:true})).failure_reason,'missing_municipality');assert.equal(requests,0);
 assert.equal((await service.lookup(event,{remote:true})).lat,null);assert.ok(requests<=4);
});
test('selection evaluates all candidates and refuses ambiguous equal-quality places',()=>{
 const valid=candidate(),wrong=candidate({address:{...candidate().address,village:'Wrong'}});
 assert.equal(selectCandidate([wrong,valid],context).lat,49.981);
 assert.equal(selectCandidate([valid,candidate({lat:50.1})],context).failure_reason,'ambiguous_result');
});
test('manual and administrator-verified coordinates survive all automatic improvements',()=>{
 const proposal={lat:50,lon:14,precision:'exact'};
 assert.equal(canImprove({lat:50,lon:14,geo_source:'manual'},proposal,true),false);
 assert.equal(canImprove({lat:50,lon:14,geo_verified:true},proposal,true),false);
 assert.equal(canImprove({lat:50,lon:14,geo_precision:'exact'}, {...proposal,precision:'municipality'}),false);
 assert.equal(canImprove({lat:50,lon:14,geo_precision:'exact'},{lat:null,lon:null,precision:'failed'}),false);
 assert.equal(canImprove({lat:50,lon:14,geo_precision:'municipality'},proposal),true);
});
test('old district points remain stored but are visibly excluded from map; known town centre is approximate',()=>{
 const row=annotateEventGeo({...event,lat:50.1073,lon:14.725,geo_source:'manual'});
 assert.equal(row.geo_reliable,false);assert.equal(row.lat,50.1073);assert.equal(row.geo_failure_reason,'district_fallback');assert.equal(FireWatchData.hasCoords(row),false);
 const centre=annotateEventGeo({city_text:'Kladno',lat:50.1431,lon:14.1052});assert.equal(centre.geo_reliable,true);assert.equal(centre.geo_label,'Přibližná poloha – střed obce');
 assert.equal(annotateEventGeo({city_text:'Nupaky',lat:50.1431,lon:14.1052}).geo_reliable,false);
});
test('context cache includes locality, detail, district, region and country',()=>{
 for(const field of ['municipality','locality','detail','district','state','country'])assert.notEqual(cacheKey(context),cacheKey({...context,[field]:'different'}));
});
test('same legitimate coordinates form one marker group containing all distinct IDs without jitter',()=>{
 const rows=[{id:'a',lat:50.1431,lon:14.1052,geo_reliable:true},{id:'b',lat:50.1431,lon:14.1052,geo_reliable:true},{id:'c',lat:50.1073,lon:14.725,geo_reliable:false}];
 const groups=FireWatchData.groupMapEvents(rows);assert.equal(groups.length,1);assert.deepEqual(groups[0].map(e=>e.id),['a','b']);assert.equal(groups[0][0].lat,rows[0].lat);
});
test('diagnostics distinguish same town from different places sharing a point',()=>{
 const center={lat:50.1431,lon:14.1052,geo_source:'local-municipality'};
 assert.equal(diagnoseCoordinates([{id:'a',city_text:'Kladno',...center},{id:'b',city_text:'Kladno',...center}]).length,0);
 assert.ok(diagnoseCoordinates([{id:'a',city_text:'Kladno',...center},{id:'b',city_text:'Nupaky',...center}]).every(e=>e.geo_diagnostic_reasons.includes('shared_point_different_places')));
});
test('mock provider cache avoids new requests; negative results have finite TTL',async()=>{
 const cache=new Map();let requests=0,ttl;
 const service=createGeocoder({fetchImpl:async()=>{requests++;return {ok:true,json:async()=>[]};},getCache:async key=>cache.get(key),setCache:async(key,value,seconds)=>{cache.set(key,value);ttl=seconds;}});
 await service.lookup(event,{remote:true});const count=requests;await service.lookup(event,{remote:true});assert.equal(requests,count);assert.equal(ttl,86400);
});
test('provider retries transient errors twice, never retries permanent HTTP errors',async()=>{
 for(const status of [429,503,400]){let count=0,slots=0;const service=createGeocoder({reserve:async()=>{slots++;},fetchImpl:async()=>{count++;return {ok:false,status};}});
 const result=await service.lookup(event,{remote:true});assert.equal(count,status===400?1:2);assert.equal(slots,count);assert.equal(result.lat,null);}
});
test('provider calls are serial and concurrent same-context lookups share one request',async()=>{
 let active=0,maximum=0,count=0;const service=createGeocoder({fetchImpl:async()=>{count++;maximum=Math.max(maximum,++active);await Promise.resolve();active--;return {ok:true,json:async()=>[candidate()]};}});
 await Promise.all([service.lookup(event,{remote:true}),service.lookup(event,{remote:true})]);assert.equal(count,1);assert.equal(maximum,1);
});
test('background queue never geocodes known or manual points and stops accepting jobs',async()=>{
 let calls=0;const jobs=createGeocodeJobs({lookup:async()=>{calls++;return {precision:'failed'};},getEvent:async id=>id==='manual'?{geo_source:'manual'}:{lat:50,lon:14},apply:async()=>{},recordFailure:async()=>{}});
 jobs.enqueue('manual');jobs.enqueue('known');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);jobs.stop();assert.equal(jobs.enqueue('later'),false);
});
test('background queue applies validated missing location once and safely records failed lookup',async()=>{
 const applied=[],failed=[];let resolveDone;
 const done=new Promise(resolve=>{resolveDone=resolve;});
 const jobs=createGeocodeJobs({getEvent:async id=>({id,lat:null,lon:null}),lookup:async ev=>ev.id==='found'?{lat:50,lon:14,precision:'municipality'}:{lat:null,lon:null,precision:'failed',failure_reason:'not_found'},apply:async(id,p)=>applied.push([id,p]),recordFailure:async(id,p)=>{failed.push([id,p]);resolveDone();}});
 assert.equal(jobs.enqueue('found'),true);assert.equal(jobs.enqueue('found'),false);jobs.enqueue('missing');await done;
 assert.equal(applied.length,1);assert.equal(failed.length,1);assert.equal(failed[0][1].lat,null);jobs.stop();
});
test('context mismatch and low confidence hide points without changing stored coordinates',()=>{
 const row={...event,lat:49.981,lon:14.581,geo_precision:'exact',geo_confidence:95,geo_context_key:'different'};
 assert.equal(annotateEventGeo(row).geo_failure_reason,'context_mismatch');
 assert.equal(annotateEventGeo({...row,geo_context_key:cacheKey(context),geo_confidence:30}).geo_failure_reason,'low_confidence');
});
test('Praha queries fall back from full address to district and remain bounded to Prague',()=>{
 const c=eventLocation({source:'praha',region:'Hlavní město Praha',city_text:'Praha 11',place_text:'Tererova 1356/6a'});
 const queries=buildPrahaQueries(c);assert.match(queries[0],/^Tererova 1356\/6a, Praha 11/);assert.match(queries.at(-1),/^Praha 11,/);
 assert.ok(queries.every(q=>q.includes('Praha') && q.includes('Česko')));assert.notEqual(cacheKey(c),cacheKey(context));
});
test('Praha geocoding accepts matching address and rejects outside or wrong district coordinates',()=>{
 const c=eventLocation({source:'praha',city_text:'Praha 11',place_text:'Tererova 1356/6a'});
 const valid={lat:'50.0301',lon:'14.4921',addresstype:'house',name:'Tererova',display_name:'Tererova 1356/6a, Praha 11',address:{country_code:'cz',state:'Hlavní město Praha',city:'Praha',city_district:'Praha 11',road:'Tererova',house_number:'1356/6a'}};
 assert.equal(evaluatePrahaCandidate(valid,c).precision,'exact');assert.equal(insidePraha(valid.lat,valid.lon),true);
 assert.equal(evaluatePrahaCandidate({...valid,lat:'50.2'},c).reason,'outside_expected_area');
 assert.equal(evaluatePrahaCandidate({...valid,address:{...valid.address,city_district:'Praha 10'}},c).reason,'district_mismatch');
 assert.equal(annotateEventGeo({source:'praha',city_text:'Praha 11',place_text:'Tererova 1356/6a',lat:50.2,lon:14.49,geo_precision:'exact'}).geo_reliable,false);
});
