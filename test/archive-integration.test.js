import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {createTestDatabase} from '../test-support/database.js';
import {pool,createUser,createSession,upsertArchivedReport} from '../db.js';
import {normalizeReportFilters,buildReportWhere} from '../report-query.js';
const {app,reportPeriodFromKey,buildAnalyticalReport}=await import('../server.js');
let database,server,base,cookie;
before(async()=>{
 database=await createTestDatabase();server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 const user=await createUser({username:'audit.editor',passwordHash:'unused-test-hash',role:'editor'});const token=crypto.randomUUID();await createSession({userId:user.id,tokenSha256:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString(),ip:'127.0.0.1',userAgent:'integration-test'});cookie='FWSESS='+token;
 for(let day=1;day<=45;day++){const d=new Date(Date.UTC(2026,0,day));const key=d.toISOString().slice(0,10);await upsertArchivedReport({period_type:'day',period_key:key,period_start:key,period_end:key,title:'Denní souhrn '+key,total_events:day%4?day:0,open_count:1,data_json:{test:true}});}
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await database.close();});
const get=async route=>{const r=await fetch(base+route);return{status:r.status,data:await r.json()};};
const generate=async(key,cookieValue=cookie)=>{const r=await fetch(base+'/api/reports/generate',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookieValue},body:JSON.stringify({type:'day',key,force:true})});return{status:r.status,data:await r.json()};};
test('report filter validation is bounded and parameterized',()=>{
 assert.equal(normalizeReportFilters({limit:'900'}).limit,100);
 for(const input of [{type:'bad'},{month:'13'},{offset:'-1'},{from:'2026-02-30'},{from:'2026-03-01',to:'2026-01-01'},{include_empty:'yes'}])assert.throws(()=>normalizeReportFilters(input));
 const where=buildReportWhere(normalizeReportFilters({q:"x%' OR 1=1--"}));assert.ok(!where.sql.includes('OR 1=1--'));assert.ok(where.params[0].includes('\\%'));
});
test('archive pages are compact, stable, bounded and include total/group counts',async()=>{
 const first=await get('/api/reports?type=day&include_empty=true&limit=10');assert.equal(first.status,200);assert.equal(first.data.total,45);assert.equal(first.data.reports.length,10);assert.equal(first.data.groups.length,2);assert.equal(first.data.reports[0].period_start,'2026-02-14');assert.ok(!('data_json' in first.data.reports[0]));
 const second=await get('/api/reports?type=day&include_empty=true&limit=10&offset=10');assert.equal(new Set([...first.data.reports,...second.data.reports].map(r=>r.id)).size,20);
 const last=await get('/api/reports?include_empty=true&offset=100');assert.equal(last.data.total,45);assert.equal(last.data.reports.length,0);
});
test('archive API applies year/month/date/search/empty filters and rejects invalid values',async()=>{
 const filtered=await get('/api/reports?type=day&year=2026&month=2&include_empty=true&from=2026-02-01&to=2026-02-03');assert.equal(filtered.data.total,3);
 const search=await get('/api/reports?q=2026-02-02&include_empty=true');assert.equal(search.data.total,1);
 const visible=await get('/api/reports?type=day');assert.equal(visible.data.total,34);
 for(const route of ['/api/reports?month=13','/api/reports?offset=-1','/api/reports?from=2026-02-30'])assert.equal((await get(route)).status,400);
});
test('report generation requires permission and safely upserts one period',async()=>{
 assert.equal((await generate('2026-01-01','')).status,401);
 const first=await generate('2026-01-01');assert.equal(first.status,200);const second=await generate('2026-01-01');assert.equal(second.status,200);assert.equal(first.data.report.id,second.data.report.id);
 assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM archived_reports WHERE period_type='day' AND period_key='2026-01-01'")).rows[0].count,1);
 assert.equal((await generate('2099-01-01')).status,400);assert.equal((await generate('2026-02-30')).status,400);
});
test('read-only report detail never creates missing or future reports',async()=>{
 const beforeCount=(await pool.query('SELECT COUNT(*)::int AS count FROM archived_reports')).rows[0].count;
 assert.equal((await get('/api/reports/day/2099-01-01')).status,404);assert.equal((await fetch(base+'/api/reports/day/2099-01-01.pdf')).status,404);
 assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM archived_reports')).rows[0].count,beforeCount);
});
test('report calendar validates ISO weeks and counts empty calendar days in average',()=>{
 assert.throws(()=>reportPeriodFromKey('week','2025-W53'));assert.throws(()=>reportPeriodFromKey('month','2026-13'));assert.equal(reportPeriodFromKey('week','2026-W01').startIso,'2025-12-29');
 const report=buildAnalyticalReport('week','2026-W38',[]);assert.equal(report.data_json.avg_per_day,0);
});
test('analytics use Prague day boundaries, full calendar periods and only trusted durations',()=>{
 const rows=Array.from({length:7},(_,i)=>({id:'time-'+i,pub_date:'2025-12-31T23:30:00Z',start_time:'2025-12-31T23:30:00Z',is_closed:true,duration_min:i?30:999,duration_source:i?'rss_end_time':'observed',event_type:'fire',city_text:'Kladno',lat:50,lon:14}));
 const report=buildAnalyticalReport('week','2026-W01',rows);
 assert.equal(report.data_json.avg_per_day,1);
 assert.deepEqual(report.data_json.by_day,[{day:'2026-01-01',count:7}]);
 assert.equal(report.data_json.longest.length,6);
 assert.ok(report.data_json.longest.every(r=>r.duration_min===30));
 assert.equal(buildAnalyticalReport('month','2026-01',rows).data_json.avg_per_day,0.2);
});

