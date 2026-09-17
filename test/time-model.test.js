import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeFeedTimestamp,annotateEventTime,diagnoseTimes} from '../time-model.js';
import {pragueLocalToUtcIso,parseTimesFromDescription} from '../server.js';
import {buildGatewayPayload,buildRssPayload} from '../scripts/rss-push.js';
import {rssDateKeyInPrague} from '../rss-worker.js';import '../public/event-utils.js';
const iso='2026-09-17T14:30:00.000Z';
test('RFC UTC, gateway bare UTC and ISO converge without a second shift',()=>{
 for(const raw of ['Thu, 17 Sep 2026 14:30:00 +0000','2026-09-17 14:30:00',iso])assert.equal(normalizeFeedTimestamp(raw),iso);
 const parts=new Intl.DateTimeFormat('cs-CZ',{timeZone:'Europe/Prague',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso));assert.equal(parts,'16:30');
});
test('RSS and RSS2JSON payload normalize the same instant and keep the GUID',()=>{
 const gateway=buildGatewayPayload({status:'ok',items:[{guid:'RSS_FEED_203353',title:'Modletice',pubDate:'2026-09-17 14:30:00'}]});
 const rss=buildRssPayload('<rss><channel><item><guid>RSS_FEED_203353</guid><title>Modletice</title><pubDate>Thu, 17 Sep 2026 14:30:00 +0000</pubDate></item></channel></rss>');
 assert.equal(gateway.items[0].pubDate,iso);assert.equal(rss.items[0].pubDate,iso);assert.equal(gateway.items[0].id,rss.items[0].id);
});
test('Czech start/end wall times use winter and summer Prague offsets',()=>{
 assert.equal(parseTimesFromDescription('ukončení: 17. září 2026, 16:40').endIso,'2026-09-17T14:40:00.000Z');
 assert.equal(parseTimesFromDescription('ukončení: 15. ledna 2026, 16:40').endIso,'2026-01-15T15:40:00.000Z');
 assert.equal(parseTimesFromDescription('zahájení: 17. září 2026, 16:30').startIso,iso);
});
test('DST spring gap is rejected and repeated autumn time uses first legal occurrence',()=>{
 assert.equal(pragueLocalToUtcIso(2026,2,29,2,30),null);
 assert.equal(pragueLocalToUtcIso(2026,2,29,3,30),'2026-03-29T01:30:00.000Z');
 assert.equal(pragueLocalToUtcIso(2026,9,25,2,30),'2026-10-25T00:30:00.000Z');
});
test('today remains a Prague calendar day including UTC gateway times across midnight',()=>{
 assert.equal(rssDateKeyInPrague('2026-09-16 22:30:00'),'2026-09-17');assert.equal(rssDateKeyInPrague('2026-01-14 23:30:00'),'2026-01-15');
});
test('unproven RSS starts and closed durations are hidden while explicit/manual starts survive',()=>{
 const old={source_kind:'rss',pub_date:iso,start_time_iso:iso,duration_source:'rss_end_time',duration_min:10,is_closed:true};const e=annotateEventTime(old);
 assert.equal(e.start_time_iso,null);assert.equal(e.duration_min,null);assert.equal(FireWatchData.duration(e),null);
 assert.equal(FireWatchData.duration(annotateEventTime({...old,is_closed:false}),Date.parse(iso)+3600000),null);
 assert.equal(FireWatchData.duration(annotateEventTime({...old,start_time_source:'rss_description'})),10);
 assert.equal(annotateEventTime({...old,start_time_source:'manual'}).start_time_iso,iso);
});
test('time dry run skips ambiguous and already shifted ISO without source evidence',()=>{
 for(const pub_date of ['2026-09-17 14:30:00','2026-09-17T12:30:00Z']){const result=diagnoseTimes({id:'x',pub_date});assert.equal(result.proposed,null);assert.equal(result.dry_run,true);}
 assert.equal(diagnoseTimes({id:'x',pub_date:'2026-09-17T12:30:00Z'},{pubDate:'2026-09-17 14:30:00'}).proposed,iso);
});

test('uncertain legacy manual start remains unknown even if a manual status is present',()=>{
 const e=annotateEventTime({source_kind:'rss',status_source:'manual',start_time_iso:iso,start_time_source:'legacy_manual_unverified',is_closed:false});assert.equal(e.start_time_iso,null);assert.equal(e.start_time_trusted,false);assert.equal(FireWatchData.duration(e),null);
});
