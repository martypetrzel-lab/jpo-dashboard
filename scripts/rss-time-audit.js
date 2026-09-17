import {diagnoseTimes} from '../time-model.js';
const endpoint=new URL('/api/events?day=all&limit=2000',process.env.FIREWATCH_PUBLIC_URL || 'https://firewatchcz.cz');
const response=await fetch(endpoint,{signal:AbortSignal.timeout(20000)});
if(!response.ok)throw Error('public_api_http_'+response.status);
const data=await response.json();const items=data.items.map(event=>diagnoseTimes(event));
console.log(JSON.stringify({dry_run:true,scanned:items.length,total_matching:data.total_matching,complete:items.length>=data.total_matching,formats:items.reduce((counts,item)=>({...counts,[item.format]:(counts[item.format] || 0)+1}),{}),note:'ISO may already have been shifted. No blanket offset; fresh RSS evidence is required. No database writes.',items},null,2));
