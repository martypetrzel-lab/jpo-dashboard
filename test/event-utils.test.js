import test from 'node:test';import assert from 'node:assert/strict';
import '../public/event-utils.js';const data=globalThis.FireWatchData;
test('map coordinates reject absent/invalid/zero pairs without inventing a position',()=>{
 for(const event of [{lat:null,lon:null},{lat:'',lon:''},{lat:0,lon:0},{lat:91,lon:14},{lat:'bad',lon:14}])assert.equal(data.hasCoords(event),false);
 assert.equal(data.hasCoords({lat:'50,1',lon:'14.2'}),true);
 const rows=data.normalizeEvents([{id:'a',lat:null,lon:null},{id:'b',lat:'50,1',lon:'14.2'},{id:'b',lat:50.2,lon:14.3},null]);assert.equal(rows.length,2);assert.equal(rows[0].lat,null);assert.equal(rows[1].lat,50.2);
});
test('event ordering prioritizes active and supports deterministic chronological ordering',()=>{
 const rows=[{id:'closed',is_closed:true,pub_date:'2026-09-17T10:00:00Z'},{id:'open',is_closed:false,pub_date:'2026-09-17T09:00:00Z'}];assert.equal(data.sortEvents(rows)[0].id,'open');assert.equal(data.sortEvents(rows,'newest')[0].id,'closed');assert.equal(data.sortEvents(rows,'oldest')[0].id,'open');assert.equal(rows[0].id,'closed');
});
test('display durations require trusted timestamps or explicit/manual measurements',()=>{
 const now=Date.parse('2026-09-17T12:00:00Z');assert.equal(data.duration({is_closed:false,start_time_iso:'2026-09-17T11:00:17Z'},now),59);assert.equal(data.duration({is_closed:false,first_seen_at:'2026-09-17T11:00:00Z'},now),null);
 assert.equal(data.duration({is_closed:true,duration_min:25,duration_source:'rss_end_time'}),25);for(const source of ['close_update','estimated_stale_close','observed_first_seen',null])assert.equal(data.duration({is_closed:true,duration_min:25,duration_source:source}),null);
});
test('RSS source links allow only HTTP(S), including in map popups',()=>{assert.equal(data.safeLink('javascript:alert(1)'), '');assert.equal(data.safeLink('data:text/html,hello'),'');assert.equal(data.safeLink('https://example.test/'), 'https://example.test/');});
test('reconnect backoff is bounded and permission failures never loop',()=>{assert.deepEqual([0,1,2,3,4,5,6].map(x=>data.reconnectDelay(x,1006)),[1800,3600,7200,14400,28800,30000,null]);assert.equal(data.reconnectDelay(0,1008),null);assert.equal(data.reconnectDelay(0,4001),null);});
