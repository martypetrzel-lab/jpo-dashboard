import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runPardubickyPush, sourceStateUrl } from "../scripts/pardubicky-push.js";

const rss=fs.readFileSync(fileURLToPath(new URL('./fixtures/pardubicky-rss.xml',import.meta.url)),'utf8');
const detail=fs.readFileSync(fileURLToPath(new URL('./fixtures/pardubicky-detail.html',import.meta.url)),'utf8');
const env={FIREWATCH_INGEST_URL:'https://firewatchcz.cz/api/ingest',FIREWATCH_API_KEY:'secret-never-log',PARDUBICKY_DETAIL_DELAY_MS:'0'};
const harness=()=>{const logs=[];return {logs,logger:{info:x=>logs.push(x),error:x=>logs.push(x)}};};

test('Pardubice source state URL stays on configured HTTPS origin',()=>assert.equal(sourceStateUrl(env.FIREWATCH_INGEST_URL),'https://firewatchcz.cz/api/ingest/source-state'));

test('Pardubice importer enriches new RSS item from detail and posts source payload',async()=>{
 const h=harness();let posted;
 const ok=await runPardubickyPush({env,logger:h.logger,now:new Date('2026-09-22T12:00:00+02:00'),delayImpl:async()=>{},
  rssFetchImpl:async()=>new Response(rss),
  stateFetchImpl:async()=>Response.json({ok:true,known:[],open:[]}),
  detailFetchImpl:async url=>new Response(detail.replace('Ukončená',url.includes('251813053')?'Probíhající':'Ukončená')),
  ingestFetchImpl:async(_url,options)=>{posted=JSON.parse(options.body);return Response.json({ok:true,accepted:2,inserted:2,updated:0,unchanged:0,status_changed:0,skipped_older:0});}
 });
 assert.equal(ok,true);assert.equal(posted.source,'github_actions_pardubicky_rss');assert.equal(posted.items.length,2);
 assert.equal(posted.items[0].subtype,'Otevření uzavřených prostor');assert.deepEqual(posted.items[0].respondingUnits,['Letohrad','JSDH Žamberk']);
 assert.match(h.logs.join('\n'),/new=2; updated=0; status_changed=0; unchanged=0/);assert.equal(h.logs.join('\n').includes(env.FIREWATCH_API_KEY),false);
});

test('one unavailable Pardubice detail does not block other detail or ingest',async()=>{
 const h=harness();let detailCalls=0,posted;
 const ok=await runPardubickyPush({env,logger:h.logger,now:new Date('2026-09-22T12:00:00+02:00'),sleepImpl:async()=>{},delayImpl:async()=>{},
  rssFetchImpl:async()=>new Response(rss),stateFetchImpl:async()=>Response.json({ok:true,known:[],open:[]}),
  detailFetchImpl:async()=>{if(++detailCalls<=2)throw Object.assign(new Error('down'),{cause:{code:'ECONNREFUSED'}});return new Response(detail.replace('Ukončená','Probíhající'));},
  ingestFetchImpl:async(_url,options)=>{posted=JSON.parse(options.body);return Response.json({ok:true,accepted:1,inserted:1,updated:0,unchanged:0,status_changed:0,skipped_older:0});}
 });
 assert.equal(ok,true);assert.equal(posted.items.length,1);assert.match(h.logs.join('\n'),/detail_errors=1/);
});

test('Pardubice dry-run never needs Secrets or writes ingest',async()=>{
 const h=harness();const ok=await runPardubickyPush({env:{PARDUBICKY_DRY_RUN:'1',PARDUBICKY_DETAIL_DELAY_MS:'0'},logger:h.logger,now:new Date('2026-09-22T12:00:00+02:00'),delayImpl:async()=>{},
  rssFetchImpl:async()=>new Response(rss),detailFetchImpl:async()=>new Response(detail),stateFetchImpl:async()=>assert.fail('no state write/read'),ingestFetchImpl:async()=>assert.fail('no ingest')});
 assert.equal(ok,true);assert.match(h.logs.join('\n'),/dry-run; found=2; details=1; new=1; updated_candidates=0; skipped_old=1/);
});
