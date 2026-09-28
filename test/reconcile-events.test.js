import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { reconciliationApiUrl, runReconciliation } from "../scripts/reconcile-events.js";

const fixture=fs.readFileSync(fileURLToPath(new URL('./fixtures/stredocesky-history-203416.html',import.meta.url)),'utf8');
const agentFactory=()=>({close:async()=>{}});
const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});

test('reconciliation URL stays on configured FireWatch origin',()=>{
  assert.equal(reconciliationApiUrl('https://firewatchcz.cz/api/ingest','/api/reconciliation/jobs/claim'),'https://firewatchcz.cz/api/reconciliation/jobs/claim');
});

test('worker fetches a historical detail, applies it once and logs no API key',async()=>{
  let candidatePages=0;const calls=[];const logs=[];
  const fetchImpl=async(url,options={})=>{
    calls.push({url:String(url),body:options.body,apiKey:options.headers?.['X-API-Key']});
    if(String(url).includes('pkr.kr-stredocesky.cz'))return new Response(fixture,{status:200});
    const path=new URL(url).pathname;
    if(path.endsWith('/jobs/claim'))return json({ok:true,job:{id:'job-1',source:'stredocesky',scope:'active',dry_run:false}});
    if(path.endsWith('/candidates'))return json({ok:true,items:candidatePages++===0?[{source:'stredocesky',external_id:'RSS_FEED_203416'}]:[]});
    if(path.endsWith('/apply'))return json({ok:true,result:{updated:true,statusChanged:true}});
    if(path.endsWith('/complete'))return json({ok:true,job:{id:'job-1'}});
    throw new Error('unexpected URL '+url);
  };
  const ok=await runReconciliation({env:{FIREWATCH_INGEST_URL:'https://firewatchcz.cz/api/ingest',FIREWATCH_API_KEY:'top-secret-key',RECONCILE_SCOPE:'active',RECONCILE_SOURCE:'stredocesky'},fetchImpl,agentFactory,delayImpl:async()=>{},logger:{info:value=>logs.push(value),error:value=>logs.push(value)}});
  assert.equal(ok,true);assert.equal(calls.filter(call=>call.url.endsWith('/apply')).length,1);
  assert.ok(logs.some(line=>line.includes('status_changes=1')));assert.ok(logs.every(line=>!line.includes('top-secret-key')));
});

test('current Central feed reconciles an event without requesting its blocked historical detail',async()=>{
  const rss=`<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Zásahy</title><item>
      <title>technická pomoc - Ledce</title>
      <link>https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/?id=203974</link>
      <guid>RSS_FEED_203974</guid>
      <pubDate>Sun, 27 Sep 2026 04:02:00 GMT</pubDate>
      <description><![CDATA[Stav: ukončená<br>Ledce<br>okres Mladá Boleslav<br>ukončení: 27. září 2026, 06:02]]></description>
    </item></channel></rss>`;
  let candidatePages=0,historyRequests=0;const observations=[];
  const fetchImpl=async(url,options={})=>{
    const text=String(url);
    if(text.endsWith('/feed.xml'))return new Response(rss,{status:200});
    if(text.includes('/zasahy-jpo/?id=')){historyRequests++;throw new Error('blocked detail');}
    const path=new URL(url).pathname;
    if(path.endsWith('/jobs/claim'))return json({ok:true,job:{id:'job-feed',source:'stredocesky',scope:'active',dry_run:false}});
    if(path.endsWith('/candidates'))return json({ok:true,items:candidatePages++===0?[{source:'stredocesky',external_id:'RSS_FEED_203974'}]:[]});
    if(path.endsWith('/apply')){observations.push(JSON.parse(options.body).observation);return json({ok:true,result:{updated:true,statusChanged:true}});}
    if(path.endsWith('/complete'))return json({ok:true,job:{id:'job-feed'}});
    throw new Error('unexpected URL '+url);
  };
  const ok=await runReconciliation({env:{FIREWATCH_INGEST_URL:'https://firewatchcz.cz/api/ingest',FIREWATCH_API_KEY:'secret',RECONCILE_SCOPE:'active',RECONCILE_SOURCE:'stredocesky'},fetchImpl,agentFactory,delayImpl:async()=>{},logger:{info(){},error(){}}});
  assert.equal(ok,true);
  assert.equal(historyRequests,0);
  assert.equal(observations.length,1);
  assert.equal(observations[0].normalizedStatus,'completed');
  assert.equal(observations[0].reportedAt,null);
  assert.equal(observations[0].endedAt,'2026-09-27T04:02:00.000Z');
});

test('blocked Central feed uses the configured gateway and keeps its key out of logs',async()=>{
  let candidatePages=0,historyRequests=0;const observations=[],logs=[];
  const fetchImpl=async(url,options={})=>{
    const text=String(url);
    if(text.endsWith('/feed.xml'))throw new Error('source connection blocked');
    if(text.startsWith('https://api.rss2json.com/'))return json({status:'ok',items:[{
      title:'technická pomoc - Ledce',link:'https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/?id=203974',guid:'RSS_FEED_203974',
      pubDate:'2026-09-27 04:02:00',description:'Stav: ukončená<br>Ledce<br>ukončení: 27. září 2026, 06:02',
    }]});
    if(text.includes('/zasahy-jpo/?id=')){historyRequests++;throw new Error('blocked detail');}
    const path=new URL(url).pathname;
    if(path.endsWith('/jobs/claim'))return json({ok:true,job:{id:'job-gateway',source:'stredocesky',scope:'active',dry_run:false}});
    if(path.endsWith('/candidates'))return json({ok:true,items:candidatePages++===0?[{source:'stredocesky',external_id:'RSS_FEED_203974'}]:[]});
    if(path.endsWith('/apply')){observations.push(JSON.parse(options.body).observation);return json({ok:true,result:{updated:true,statusChanged:true}});}
    if(path.endsWith('/complete'))return json({ok:true,job:{id:'job-gateway'}});
    throw new Error('unexpected URL '+url);
  };
  const ok=await runReconciliation({env:{FIREWATCH_INGEST_URL:'https://firewatchcz.cz/api/ingest',FIREWATCH_API_KEY:'ingest-secret',RSS2JSON_API_KEY:'gateway-secret',RECONCILE_SCOPE:'active',RECONCILE_SOURCE:'stredocesky'},fetchImpl,agentFactory,sleepImpl:async()=>{},delayImpl:async()=>{},logger:{info:value=>logs.push(value),error:value=>logs.push(value)}});
  assert.equal(ok,true);
  assert.equal(historyRequests,0);
  assert.equal(observations.length,1);
  assert.equal(observations[0].normalizedStatus,'completed');
  assert.equal(observations[0].reportedAt,null);
  assert.ok(logs.every(line=>!line.includes('ingest-secret')&&!line.includes('gateway-secret')));
});

test('permanent source 404 is recorded without applying a completed state',async()=>{
  let candidatePages=0,failures=0,applies=0;
  const fetchImpl=async(url)=>{
    if(String(url).includes('pkr.kr-stredocesky.cz'))return new Response('not found',{status:404});
    const path=new URL(url).pathname;
    if(path.endsWith('/jobs/claim'))return json({ok:true,job:{id:'job-404',source:'stredocesky',scope:'active',dry_run:false}});
    if(path.endsWith('/candidates'))return json({ok:true,items:candidatePages++===0?[{source:'stredocesky',external_id:'404'}]:[]});
    if(path.endsWith('/failure')){failures++;return json({ok:true});}
    if(path.endsWith('/apply')){applies++;return json({ok:true});}
    if(path.endsWith('/complete'))return json({ok:true,job:{id:'job-404'}});
    throw new Error('unexpected URL '+url);
  };
  const ok=await runReconciliation({env:{FIREWATCH_INGEST_URL:'https://firewatchcz.cz/api/ingest',FIREWATCH_API_KEY:'secret',RECONCILE_SCOPE:'active',RECONCILE_SOURCE:'stredocesky'},fetchImpl,agentFactory,delayImpl:async()=>{},logger:{info(){},error(){}}});
  assert.equal(ok,true);assert.equal(failures,1);assert.equal(applies,0);
});

test('repeated detail transport failures stop further source requests and mark older events unverified',async()=>{
  let candidatePages=0,detailRequests=0;const categories=[];
  const fetchImpl=async(url,options={})=>{
    const text=String(url);
    if(text.endsWith('/feed.xml'))return new Response('<?xml version="1.0"?><rss version="2.0"><channel><title>Zásahy</title></channel></rss>',{status:200});
    if(text.includes('/zasahy-jpo/?id=')){detailRequests++;throw new Error('source network unavailable');}
    const path=new URL(url).pathname;
    if(path.endsWith('/jobs/claim'))return json({ok:true,job:{id:'job-blocked',source:'stredocesky',scope:'last7',dry_run:false}});
    if(path.endsWith('/candidates'))return json({ok:true,items:candidatePages++===0?['1','2','3','4'].map(id=>({source:'stredocesky',external_id:id})):[]});
    if(path.endsWith('/failure')){categories.push(JSON.parse(options.body).category);return json({ok:true});}
    if(path.endsWith('/complete'))return json({ok:true,job:{id:'job-blocked'}});
    throw new Error('unexpected URL '+url);
  };
  const ok=await runReconciliation({env:{FIREWATCH_INGEST_URL:'https://firewatchcz.cz/api/ingest',FIREWATCH_API_KEY:'secret',RECONCILE_SCOPE:'last7',RECONCILE_SOURCE:'stredocesky'},fetchImpl,agentFactory,sleepImpl:async()=>{},delayImpl:async()=>{},logger:{info(){},error(){}}});
  assert.equal(ok,true);
  assert.equal(detailRequests,4);
  assert.deepEqual(categories,['network_error','network_error','source_unverified','source_unverified']);
});
