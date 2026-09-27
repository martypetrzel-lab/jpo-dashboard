import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetch as undiciFetch } from "undici";
import { fetchRssDetailed, sanitizeRssError } from "../rss-worker.js";
import { buildSourceAdapters } from "../reconciliation.js";
import { PRAHA_ATOM_URL } from "../prague-atom.js";

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function runPublicReconciliationAudit({baseUrl=process.env.FIREWATCH_PUBLIC_URL||'https://firewatchcz.cz',fetchImpl=undiciFetch,logger=console,delayImpl=pause}={}){
  const origin=new URL(baseUrl).origin;
  const response=await fetchImpl(`${origin}/api/events?day=all&status=all&limit=2000`,{headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(`firewatch_http_${response.status}`);
  const payload=await response.json();const events=Array.isArray(payload.items)?payload.items:[];
  const identities=new Map(),duplicates=[],missingExternal=[],invalidDurations=[],regionMismatch=[];
  for(const event of events){
    if(!event.external_id)missingExternal.push(event.id);
    else{const key=`${event.source}\u0000${event.external_id}`;if(identities.has(key))duplicates.push([identities.get(key),event.id]);else identities.set(key,event.id);}
    if(event.duration_min!=null&&Number(event.duration_min)<=0)invalidDurations.push(event.id);
    if(event.region&&event.event_region&&event.region!==event.event_region)regionMismatch.push(event.id);
  }
  const active=events.filter(event=>event.is_closed===false&&event.external_id&&['stredocesky','pardubicky','praha'].includes(event.source));
  const fetchText=async url=>{const result=await fetchRssDetailed(url,{fetchImpl,timeoutMs:30000,connectTimeoutMs:20000,maxResponseBytes:1024*1024});return{body:result.xml,status:result.httpStatus};};
  const adapters=buildSourceAdapters({fetchText});let prahaById=null;const proposed=[],unverified=[];
  for(const [index,event] of active.entries()){
    if(index)await delayImpl(300);
    try{
      let observation;
      if(event.source==='praha'){
        if(!prahaById)prahaById=new Map((await adapters.praha.fetchCurrentEvents(PRAHA_ATOM_URL)).map(item=>[String(item.externalId),item]));
        observation=prahaById.get(String(event.external_id));
        if(!observation){unverified.push({id:event.id,source:event.source,category:'not_in_current_feed'});continue;}
      }else observation=await adapters[event.source].fetchEventByExternalId(event.external_id,event);
      if(!observation){unverified.push({id:event.id,source:event.source,category:'not_parsed'});continue;}
      const current=event.is_closed?'completed':'active';
      if(observation.normalizedStatus!==current&&observation.normalizedStatus!=='unknown')proposed.push({id:event.id,source:event.source,external_id:event.external_id,current,proposed:observation.normalizedStatus,source_status:observation.sourceStatus});
    }catch(error){const safe=sanitizeRssError(error);unverified.push({id:event.id,source:event.source,category:safe.httpStatus===404?'source_record_unavailable':safe.type,http_status:safe.httpStatus});}
  }
  const report={dry_run:true,scanned:events.length,active_checked:active.length,proposed,unverified,duplicates,missing_external_id:missingExternal,invalid_duration:invalidDurations,region_mismatch:regionMismatch};
  logger.log(JSON.stringify(report,null,2));return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runPublicReconciliationAudit().catch(error=>{console.error(JSON.stringify({dry_run:true,error:String(error?.message||error)}));process.exitCode=1;});
}
