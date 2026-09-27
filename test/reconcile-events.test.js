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
