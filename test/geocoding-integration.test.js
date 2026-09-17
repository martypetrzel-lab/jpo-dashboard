import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {createTestDatabase} from '../test-support/database.js';
import {pool,initDb,updateEventCoords,applyGeoProposal,getEventById,geoFingerprint,getGeoCache,setGeoCache,recordGeoFailure,insertManualEvent,updateEventManualMeta} from '../db.js';
import {eventLocation,cacheKey} from '../geocoding.js';
process.env.API_KEY=crypto.randomUUID();
const {app,geocoder}=await import('../server.js');
let database,server,base,cookie;const originalLookup=geocoder.lookup;
const request=async(route,body,method='POST')=>{
 const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie || ''},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
};
const proposal=event=>({lat:49.981,lon:14.581,precision:'municipality',confidence:70,query:'Dobřejovice, okres Praha-východ, Česko',source:'mock-provider',display_name:'Dobřejovice',context_key:cacheKey(eventLocation(event))});
before(async()=>{
 database=await createTestDatabase();server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 const registration=await request('/api/auth/register',{username:'geo.audit',password:crypto.randomUUID()});cookie=registration.cookie;
 await pool.query("UPDATE users SET role='admin' WHERE username='geo.audit'");
 geocoder.lookup=async event=>proposal(event);
});
after(async()=>{geocoder.lookup=originalLookup;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await database.close();});
const insert=async(id,lat=null,lon=null)=>pool.query("INSERT INTO events(id,title,link,city_text,description_raw,pub_date,lat,lon,geo_source) VALUES($1,'Geocoding fixture','https://example.test/geo','Dobřejovice','stav: probíhá zásah<br>Dobřejovice<br>okres Praha-východ',$2,$3,$4,'auto')",[id,new Date().toISOString(),lat,lon]);
test('additive metadata migrations preserve all old coordinates and can run twice',async()=>{
 await insert('legacy-preserved',50.1073,14.725);await initDb();await initDb();const row=await getEventById('legacy-preserved');assert.equal(row.lat,50.1073);assert.equal(row.lon,14.725);assert.equal(row.geo_verified,false);
});
test('versioned cache persists context and honors negative expiration without deleting legacy cache',async()=>{
 const key='test|district';const result={lat:null,lon:null,precision:'failed',failure_reason:'not_found',context_key:key};
 await setGeoCache(key,result,60);assert.deepEqual(await getGeoCache(key),result);
 await pool.query("UPDATE geocode_cache_v2 SET expires_at=NOW()-INTERVAL '1 second' WHERE context_key=$1",[key]);assert.equal(await getGeoCache(key),null);
});
test('public events and detail expose safe reliability while retaining raw historical coordinates',async()=>{
 const response=await request('/api/events?day=all',undefined,'GET');const row=response.data.items.find(e=>e.id==='legacy-preserved');assert.equal(row.geo_reliable,false);assert.equal(row.lat,50.1073);assert.equal(row.geo_failure_reason,'district_fallback');
 const detail=await request('/api/events/legacy-preserved/detail',undefined,'GET');assert.equal(detail.data.event.geo_reliable,false);assert.match(detail.data.event.geo_label,/nebyla spolehlivě/);
});
test('administrator repair defaults to dry-run; explicit matching preview updates one row and audits transaction',async()=>{
 const before=await getEventById('legacy-preserved');const preview=await request('/api/admin/geocode-repair/legacy-preserved',{});assert.equal(preview.status,200);assert.equal(preview.data.can_apply,true);assert.equal(preview.data.applied,false);assert.equal(geoFingerprint(await getEventById('legacy-preserved')),geoFingerprint(before));
 assert.equal((await request('/api/admin/geocode-repair/legacy-preserved',{dry_run:false})).status,409);
 const result=await request('/api/admin/geocode-repair/legacy-preserved',{dry_run:false,expected:preview.data.expected,proposal_fingerprint:preview.data.proposal_fingerprint});assert.equal(result.data.applied,true);
 assert.equal((await getEventById('legacy-preserved')).geo_precision,'municipality');assert.equal((await pool.query("SELECT * FROM audit_log WHERE action='geocode_improved'")).rows.length,1);
});
test('repair cannot overwrite manual/verified points; stale preview and changed context are rejected',async()=>{
 await insert('manual');await updateEventCoords('manual',50,14,'manual','protected',{verified:true});const current=await getEventById('manual');assert.equal(await applyGeoProposal('manual',proposal(current),{repair:true}),false);
 const preview=await request('/api/admin/geocode-repair/manual',{});assert.equal(preview.data.can_apply,false);
 await insert('race');const row=await getEventById('race');await updateEventCoords('race',50.1,14.1);assert.equal(await applyGeoProposal('race',proposal(row),{expected:geoFingerprint(row)}),false);
 await recordGeoFailure('manual',{failure_reason:'not_found',query:'new'});assert.equal((await getEventById('manual')).lat,50);
});
test('proposal fingerprint survives JSONB key reordering but rejects a different suggested point',async()=>{
 await insert('proposal-race');const preview=await request('/api/admin/geocode-repair/proposal-race',{});
 geocoder.lookup=async event=>({...proposal(event),lat:50.2});
 const body={dry_run:false,expected:preview.data.expected,proposal_fingerprint:preview.data.proposal_fingerprint};
 assert.equal((await request('/api/admin/geocode-repair/proposal-race',body)).status,409);
 geocoder.lookup=async event=>Object.fromEntries(Object.entries(proposal(event)).reverse());
 assert.equal((await request('/api/admin/geocode-repair/proposal-race',body)).data.applied,true);
 geocoder.lookup=async event=>proposal(event);
});
test('coordinate editor rejects empty/foreign coordinates, forces manual provenance and records verification',async()=>{
 await insert('editor');assert.equal((await request('/api/admin/events/editor/coords',{lat:'',lon:''},'PUT')).status,400);
 assert.equal((await request('/api/admin/events/editor/coords',{lat:45,lon:7})).status,400);
 assert.equal((await request('/api/admin/events/editor/coords',{lat:50,lon:14,source:'auto',verified:true})).status,200);
 const row=await getEventById('editor');assert.equal(row.geo_source,'manual');assert.equal(row.geo_verified,true);assert.equal(row.geo_precision,'manual');
});
test('legacy bulk endpoint is strictly read-only and diagnostics requires administrator permissions',async()=>{
 assert.equal((await request('/api/admin/fix-geocode',{mode:'apply'})).status,400);
 const preview=await request('/api/admin/fix-geocode',{mode:'preview'});assert.equal(preview.data.coords_cleared,0);assert.equal(preview.data.cache_deleted,0);
 const diagnostics=await request('/api/admin/geocode-diagnostics',undefined,'GET');assert.equal(diagnostics.status,200);assert.ok(diagnostics.data.scanned>=4);
 const response=await fetch(base+'/api/admin/geocode-diagnostics');assert.equal(response.status,401);
});
test('explicit manual creation/edit stores proper precision and NULL coordinates never become zero',async()=>{
 const id=await insertManualEvent({id:'manual-create',title:'Local fixture',cityText:'Kladno',isClosed:true,durationMin:42,lat:50.1,lon:14.1});
 let row=await getEventById(id);assert.equal(row.geo_precision,'manual');assert.equal(row.duration_source,'manual');assert.equal(row.duration_min,42);
 assert.equal((await request('/api/events/'+id+'/detail',undefined,'GET')).data.event.geo_reliable,true);
 await updateEventManualMeta(id,{isClosed:true,coordsProvided:true,lat:50.2,lon:14.2});row=await getEventById(id);assert.equal(row.geo_precision,'manual');assert.equal(row.lat,50.2);
 await insertManualEvent({id:'manual-no-coords',title:'Local fixture',cityText:'Kladno',lat:null,lon:null});row=await getEventById('manual-no-coords');assert.equal(row.lat,null);assert.equal(row.lon,null);
});

test('time diagnostics is authorized, read-only and preserves ambiguous rows',async()=>{
 await insert('time-diagnostic');await pool.query("UPDATE events SET pub_date='2026-09-17 14:30:00' WHERE id='time-diagnostic'");
 const before=(await pool.query("SELECT * FROM events WHERE id='time-diagnostic'")).rows[0];const response=await request('/api/admin/time-diagnostics',undefined,'GET');assert.equal(response.status,200);assert.equal(response.data.dry_run,true);assert.equal(response.data.items.find(e=>e.id==='time-diagnostic').proposed,null);
 assert.deepEqual((await pool.query("SELECT * FROM events WHERE id='time-diagnostic'")).rows[0],before);
 assert.equal((await fetch(base+'/api/admin/time-diagnostics')).status,401);
});
