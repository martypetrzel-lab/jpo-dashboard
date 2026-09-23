import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createTestDatabase } from "../test-support/database.js";
import { pool, getEventMeta, autoCloseStaleOpenEvents, setCachedGeocode, initDb, getStatsFiltered, setSetting, auditCrossRegionStationAssignments } from "../db.js";
import { parsePrahaAtomXml } from "../prague-atom.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

process.env.API_KEY = crypto.randomUUID();
const { app, normalizeFeedTimestamp, pragueLocalToUtcIso, parseTimesFromDescription, safeDurationFromStartEnd } = await import("../server.js");
let database, server, base;
let localCookie;
before(async () => {
  database = await createTestDatabase();
  await setCachedGeocode("Kladno", 50.147, 14.1);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await database?.close(); });
const jsonRequest = async (route, body, cookie = "") => {
  const res = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY, Cookie: cookie }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] };
};
const dateKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const event = (id, pubDate = dateKey() + " 00:00:13") => ({ id, title: "Technická pomoc - Kladno", link: "https://example.test/" + id, pubDate, cityText: "Kladno", statusText: "probíhá zásah", descriptionRaw: "stav: probíhá zásah<br>ukončení: <br>Kladno" });
const ingest = items => jsonRequest("/api/ingest", { source: "github_actions_rss", items });
const ingestPraha = items => jsonRequest("/api/ingest", { source: "github_actions_praha_atom", items });
const ingestPardubicky = items => jsonRequest("/api/ingest", { source: "github_actions_pardubicky_rss", items });

test("isolated health/static/API smoke and protected diagnostics", async () => {
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/api/admin/ingest-diagnostics")).status, 401);
  assert.equal((await fetch(base + "/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
});
test("longest statistics include trusted closed durations and exclude inferred measurements",async()=>{
 await setSetting('longest_cutoff_v2_iso','2000-01-01T00:00:00Z');
 for(const [id,source,duration] of [['stats-trusted','rss_end_time',42],['stats-inferred','observed',999]])await pool.query("INSERT INTO events(id,title,link,city_text,pub_date,is_closed,duration_min,duration_source) VALUES($1,'Test','https://example.test','Stats fixture',$2,true,$3,$4)",[id,new Date().toISOString(),duration,source]);
 for(const filters of [{city:'Stats fixture'}, {city:'Stats fixture',month:dateKey().slice(0,7)}]){
  const stats=await getStatsFiltered(filters);assert.deepEqual(stats.longest.map(r=>r.id),['stats-trusted']);assert.equal(stats.longest[0].duration_min,42);
 }
});
test("CSV and PDF exports preserve filters, Prague time and safe trusted duration",async()=>{
 await pool.query("UPDATE events SET title='=2+2',pub_date='2026-09-17T10:23:47Z' WHERE id='stats-trusted'");
 const csv=await fetch(base+'/api/export.csv?day=all&city=Stats%20fixture&status=closed&limit=10');assert.equal(csv.status,200);
 const text=await csv.text();assert.ok(text.includes("'"+'=2+2'));assert.ok(text.includes('17. 9. 2026 12:23:47'));assert.ok(text.includes('42 min'));assert.ok(!text.includes('999 min'));assert.ok(text.includes('pocet;2'));
 const pdf=await fetch(base+'/api/export.pdf?day=all&city=Stats%20fixture&limit=10');assert.equal(pdf.status,200);assert.ok((await pdf.text()).startsWith('%PDF'));
 assert.equal((await fetch(base+'/api/export.csv?limit=invalid')).status,400);assert.equal((await fetch(base+'/api/export.pdf?limit=-1')).status,400);
});

test("registration creates a working session and logout invalidates it", async () => {
  const result = await jsonRequest("/api/auth/register", { username: "audit.public", password: crypto.randomUUID() });
  assert.equal(result.status, 200);
  assert.ok(result.cookie);
  localCookie = result.cookie;
  const me = await (await fetch(base + "/api/auth/me", { headers: { Cookie: localCookie } })).json();
  assert.equal(me.user.username, "audit.public");
  assert.equal(me.user.role, "public");
  assert.equal((await fetch(base + "/api/admin/users", { headers: { Cookie: localCookie } })).status, 403);
  assert.equal((await jsonRequest("/api/auth/logout", {}, localCookie)).status, 200);
  const afterLogout = await (await fetch(base + "/api/auth/me", { headers: { Cookie: localCookie } })).json();
  assert.equal(afterLogout.user, null);
});

test("Prague timestamps preserve seconds, winter/summer offsets and DST boundaries", () => {
  assert.equal(normalizeFeedTimestamp("2026-09-17 12:23:47"), "2026-09-17T12:23:47.000Z");
  assert.equal(normalizeFeedTimestamp("2026-01-17 12:23:47"), "2026-01-17T12:23:47.000Z");
  assert.equal(normalizeFeedTimestamp("2026-03-29 01:30:00"), "2026-03-29T01:30:00.000Z");
  assert.equal(normalizeFeedTimestamp("2026-03-29 03:30:00"), "2026-03-29T03:30:00.000Z");
  assert.equal(normalizeFeedTimestamp("2026-03-29 02:30:00"), "2026-03-29T02:30:00.000Z");
  assert.equal(normalizeFeedTimestamp("2026-02-30 10:00:00"), null);
  assert.equal(pragueLocalToUtcIso(2026, 8, 17, 10, 15), "2026-09-17T08:15:00.000Z");
  assert.equal(parseTimesFromDescription("stav: probíhá zásah<br>ukončení: <br>Kladno").isClosed, false);
  assert.equal(parseTimesFromDescription("ukončení: 16. září 2026, 23:55").endIso, "2026-09-16T21:55:00.000Z");
  assert.equal(safeDurationFromStartEnd("2026-09-16T21:55:00Z", "2026-09-16T22:15:00Z"), 20);
  assert.equal(safeDurationFromStartEnd("2026-09-16T22:15:00Z", "2026-09-16T21:55:00Z"), null);
});

test("ingest deduplicates a batch and updates a stable ID without changing its start", async () => {
  const first = {...event("audit-stable"),startTimeIso:dateKey()+"T00:00:13Z"};
  const result = await ingest([first, first]);
  assert.equal(result.status, 200);
  assert.equal(result.data.inserted, 1);
  assert.equal(result.data.accepted, 1);
  assert.equal(result.data.skipped, 1);
  const stored = await getEventMeta(first.id);
  assert.equal(stored.status_source, "explicit_open");
  assert.equal(stored.source_kind, "rss");
  const changed = { ...first, pubDate: dateKey() + " 00:05:59", startTimeIso: dateKey() + " 00:05:59", title: "Opravený název" };
  const next = await ingest([changed]);
  assert.equal(next.data.inserted, 0);
  assert.equal(next.data.updated, 1);
  const afterUpdate = await getEventMeta(first.id);
  assert.equal(afterUpdate.start_time_iso, stored.start_time_iso);
  assert.equal(afterUpdate.pub_date, normalizeFeedTimestamp(changed.pubDate));
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE id=$1", [first.id])).rows[0].count, 1);
});

test("RSS carry-over stays open and receives exact closing time/duration across midnight", async () => {
  const first = {...event("audit-carry", "2026-01-15 23:50:17"),startTimeIso:"2026-01-15T23:50:17Z"};
  assert.equal((await ingest([first])).data.inserted, 1);
  const item = { ...first, pubDate: "2026-01-16 00:00:00", statusText: "ukončená", endTimeIso: "2026-01-16 00:15:17", descriptionRaw: "stav: ukončená<br>Kladno" };
  const next = await ingest([item]);
  assert.equal(next.data.updated, 1);
  const stored = await getEventMeta(first.id);
  assert.equal(stored.is_closed, true);
  assert.equal(stored.start_time_iso, "2026-01-15T23:50:17.000Z");
  assert.equal(stored.end_time_iso, "2026-01-16T00:15:17.000Z");
  assert.equal(stored.duration_min, 25);
});

test("unknown old closed RSS item is skipped and diagnosed without insertion", async () => {
  const item = { ...event("audit-old", "2026-01-15 10:00:00"), statusText: "ukončená", descriptionRaw: "stav: ukončená<br>Kladno" };
  const result = await ingest([item]);
  assert.equal(result.data.accepted, 0);
  assert.equal(result.data.skipped_older, 1);
  assert.equal(await getEventMeta(item.id), null);
  const log = (await pool.query("SELECT * FROM ingest_log ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(log.skipped_older_count, 1);
  assert.equal(log.source_kind, "rss");
});

test("stale closer preserves explicitly open carry-over, RSS and manual data", async () => {
  await pool.query("UPDATE events SET last_seen_at = NOW() - interval '2 days' WHERE id='audit-stable'");
  assert.deepEqual(await autoCloseStaleOpenEvents(), []);
  assert.equal((await getEventMeta("audit-stable")).is_closed, false);
});

test("today API includes old open carry-over, filters status/type/city and returns unique IDs", async () => {
  await ingest([event("audit-open-old", "2026-01-14 23:00:00")]);
  const result = await (await fetch(base + "/api/events?day=today&status=open&city=Kladno&type=tech&limit=100")).json();
  assert.ok(result.items.some(item => item.id === "audit-open-old"));
  assert.ok(result.items.every(item => item.is_closed === false));
  assert.equal(new Set(result.items.map(item => item.id)).size, result.items.length);
});

test("ingest preserves manual coordinates and rejects oversized batches", async () => {
  await pool.query("UPDATE events SET lat=50.2, lon=14.2, geo_source='manual' WHERE id='audit-stable'");
  await ingest([event("audit-stable")]);
  const meta = await getEventMeta("audit-stable");
  assert.equal(meta.lat, 50.2);
  assert.equal(meta.geo_source, "manual");
  assert.equal((await ingest(Array.from({ length: 201 }, () => event("too-many")))).status, 400);
});

test("repeatable additive migration preserves rows and report unique constraint", async () => {
  await pool.query("UPDATE events SET source='unknown',event_region=NULL WHERE id='audit-stable'");
  const before = (await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count;
  await initDb();
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count, before);
  assert.ok((await pool.query("SELECT skipped_count, skipped_older_count, unchanged_count FROM ingest_log LIMIT 1")).rows.length);
  const migrated=await pool.query("SELECT source,external_id,source_url,region,event_region,is_jpo_event FROM events WHERE id='audit-stable'");
  assert.equal(migrated.rows[0].source,'stredocesky');assert.equal(migrated.rows[0].external_id,'audit-stable');assert.equal(migrated.rows[0].event_region,'Středočeský kraj');assert.equal(migrated.rows[0].is_jpo_event,true);
});
test("Praha Atom ingest uses source identity, skips old history and updates changed summaries only",async()=>{
 const xml=fs.readFileSync(fileURLToPath(new URL('./fixtures/praha-atom.xml',import.meta.url)),'utf8');
 const parsed=parsePrahaAtomXml(xml),fresh={...parsed[0],sourceUpdatedAt:new Date().toISOString(),pubDate:new Date().toISOString(),contentHash:'a'.repeat(64)};
 let result=await ingestPraha([fresh]);assert.equal(result.data.inserted,1);assert.equal(result.data.updated,0);assert.equal(result.data.unchanged,0);
 let row=await getEventMeta(fresh.id);assert.equal(row.source,'praha');assert.equal(row.external_id,fresh.externalId);assert.equal(row.duration_min,null);assert.equal(row.first_seen_was_open,null);const firstSeen=new Date(row.first_seen_at).toISOString();
 result=await ingestPraha([fresh]);assert.equal(result.data.inserted,0);assert.equal(result.data.updated,0);assert.equal(result.data.unchanged,1);row=await getEventMeta(fresh.id);assert.equal(new Date(row.first_seen_at).toISOString(),firstSeen);
 const changed={...fresh,description:'Aktualizovaný popis s diakritikou.',rawPayload:{...fresh.rawPayload,summary:'Aktualizovaný popis s diakritikou.'},contentHash:'b'.repeat(64)};
 result=await ingestPraha([changed]);assert.equal(result.data.updated,1);row=await getEventMeta(fresh.id);assert.match(row.description_raw,/Aktualizovaný/);assert.equal(new Date(row.first_seen_at).toISOString(),firstSeen);
 result=await ingestPraha([parsed[1]]);assert.equal(result.data.accepted,0);assert.equal(result.data.skipped_older,1);assert.equal(await getEventMeta(parsed[1].id),null);
 assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE source='praha' AND external_id=$1",[fresh.externalId])).rows[0].count,1);
 const filtered=await fetch(base+'/api/events?day=all&source=praha&limit=100').then(r=>r.json());assert.ok(filtered.items.some(item=>item.id===fresh.id));assert.ok(filtered.items.every(item=>item.source==='praha'));
 const stats=await fetch(base+'/api/stats?day=all&source=praha').then(r=>r.json());assert.equal(stats.categorySplit.other_crisis_count,1);assert.equal(stats.categorySplit.jpo_count,0);
});
test("Pardubice detail stays deduplicated, preserves source fields and synchronizes status",async()=>{
 const reported=new Date().toISOString(), externalId='251817053';
 const open={id:`pardubicky:${externalId}`,source:'pardubicky',externalId,sourceUrl:`https://www.hzspa.cz/vyjezdy/udalost.php?id=${externalId}`,link:`https://www.hzspa.cz/vyjezdy/udalost.php?id=${externalId}`,title:'Technická pomoc – Otevření uzavřených prostor – Letohrad',reportedAt:reported,pubDate:reported,sourceUpdatedAt:reported,eventType:'tech',subtype:'Otevření uzavřených prostor',district:'Ústí nad Orlicí',cityText:'Letohrad',street:'Spořilov III',respondingUnits:['Letohrad'],statusText:'Probíhající',statusSource:'explicit_open',isClosed:false,contentHash:'c'.repeat(64),rawPayload:{detail:{status:'Probíhající'}}};
 let result=await ingestPardubicky([open]);assert.equal(result.status,200);assert.equal(result.data.inserted,1);
 let row=await getEventMeta(open.id);const firstSeen=new Date(row.first_seen_at).toISOString();assert.equal(row.source,'pardubicky');assert.equal(row.first_seen_was_open,true);assert.equal(row.duration_source,'first_seen_open_estimate');
 let detail=await fetch(base+`/api/events/${encodeURIComponent(open.id)}/detail`).then(r=>r.json());assert.equal(detail.event.subtype,'Otevření uzavřených prostor');assert.equal(detail.event.street,'Spořilov III');assert.deepEqual(detail.event.responding_units,['Letohrad']);assert.equal(detail.event.station_id,null);
 result=await ingestPardubicky([open]);assert.equal(result.data.unchanged,1);assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM events WHERE id=$1',[open.id])).rows[0].count,1);
 const closed={...open,statusText:'Ukončená',statusSource:'explicit_closed',isClosed:true,contentHash:'d'.repeat(64),rawPayload:{detail:{status:'Ukončená'}}};
 result=await ingestPardubicky([closed]);assert.equal(result.data.updated,1);assert.equal(result.data.status_changed,1);row=await getEventMeta(open.id);assert.equal(row.is_closed,true);assert.equal(row.duration_min,null);assert.equal(new Date(row.first_seen_at).toISOString(),firstSeen);
 const state=await jsonRequest('/api/ingest/source-state',{source:'pardubicky',external_ids:[externalId]});assert.equal(state.data.known.length,1);assert.equal(state.data.open.length,0);
});
test("station audit dry-run preserves data and apply clears only automatic cross-region mistakes",async()=>{
 await pool.query(`INSERT INTO events(id,title,link,event_region,station_id,station_region,assignment_method,cross_region_assistance) VALUES
 ('station-auto-wrong','Test','https://example.test','Hlavní město Praha','sc-test','Středočeský kraj','regional_match',FALSE),
 ('station-explicit-cross','Test','https://example.test','Pardubický kraj','sc-explicit','Středočeský kraj','source_explicit',TRUE)`);
 let audit=await auditCrossRegionStationAssignments();assert.equal(audit.dry_run,true);assert.ok(audit.ids.includes('station-auto-wrong'));assert.equal(audit.preserved_explicit,1);
 assert.equal((await getEventMeta('station-auto-wrong')).station_id,'sc-test');
 audit=await auditCrossRegionStationAssignments({apply:true});assert.equal(audit.automatically_incorrect,1);
 assert.equal((await getEventMeta('station-auto-wrong')).station_id,null);assert.equal((await getEventMeta('station-explicit-cross')).station_id,'sc-explicit');
});
// Failure paths use the isolated database and never production credentials.
test('API validates limits/filters, handles malformed cookies and rejects foreign origins',async()=>{
 for(const route of ['/api/events?limit=-1','/api/events?limit=not-a-number','/api/events?status=bad','/api/stats?month=2026-13'])assert.equal((await fetch(base+route)).status,400);
 const today=dateKey();
 for(const route of [`/api/events?day=last7`,`/api/events?day=last30`,`/api/events?day=custom&from=${today}&to=${today}`,`/api/stats?day=custom&from=${today}&to=${today}`])assert.equal((await fetch(base+route)).status,200);
 for(const route of ['/api/events?day=custom','/api/events?day=custom&from=2026-01-02&to=2026-01-01','/api/events?day=custom&from=2026-02-30&to=2026-03-01','/api/events?day=custom&from=2025-01-01&to=2026-12-31'])assert.equal((await fetch(base+route)).status,400);
 assert.equal((await fetch(base+'/api/auth/me',{headers:{Cookie:'FWSESS=%ZZ'}})).status,200);
 assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers:{Origin:'https://foreign.test'}})).status,403);
 assert.equal((await fetch(base+'/api/admin/fix-geocode',{method:'POST',headers:{'X-API-Key':process.env.API_KEY}})).status,401);
 const data=await(await fetch(base+'/api/events')).json();assert.deepEqual(Object.keys(data.data_status).sort(),['last_attempt','last_success']);
});
test('public failures return safe categories and cannot crash async Express routes',async()=>{
 const query=pool.query;pool.query=async()=>{const error=new Error('sensitive-database-example');error.code='TEST_DB_FAILURE';throw error;};
 try{for(const route of ['/api/events','/api/stats','/api/export.csv','/api/events/audit-stable/detail']){const response=await fetch(base+route);assert.equal(response.status,500);assert.ok(!(await response.text()).includes('sensitive-database-example'));}}
 finally{pool.query=query;}
});
// Admin checks protect the shape used by the real UI, not invented mock fields.
test('admin user enable/role changes match database fields and reset role permissions',async()=>{
 const {createUser,createSession}=await import('../db.js');const admin=await createUser({username:'audit.admin',passwordHash:'unused-test-hash',role:'admin'});const token=crypto.randomUUID();await createSession({userId:admin.id,tokenSha256:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:new Date(Date.now()+3600000).toISOString(),ip:'127.0.0.1'});const cookie='FWSESS='+token;
 const created=await jsonRequest('/api/admin/users',{username:'audit.disabled',password:crypto.randomUUID(),role:'editor',is_enabled:false},cookie);assert.equal(created.status,200);assert.equal(created.data.user.is_enabled,false);assert.equal(created.data.user.role,'editor');
 const patch=async body=>{const r=await fetch(base+'/api/admin/users/'+created.data.user.id,{method:'PATCH',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});assert.equal(r.status,200);return(await r.json()).user;};
 assert.equal((await patch({is_enabled:true})).is_enabled,true);const changed=await patch({role:'ops'});assert.equal(changed.permissions.canCreateReports,false);assert.equal(changed.role,'ops');assert.equal((await patch({enabled:false})).is_enabled,false);
});

test('fresh RSS corrects an evidenced source timestamp, backs up original values once and leaves start unknown',async()=>{
 const first=event('time-evidenced',new Date().toISOString());await ingest([first]);
 await pool.query("UPDATE events SET pub_date='2026-09-17T12:30:00Z',start_time_iso='2026-09-17T12:30:00Z',time_model_version=0 WHERE id=$1",[first.id]);
 const update={...first,pubDate:'2026-09-17 14:30:00'};const result=await ingest([update]);assert.equal(result.data.updated,1);
 let row=(await pool.query('SELECT * FROM events WHERE id=$1',[first.id])).rows[0];assert.equal(row.pub_date,'2026-09-17T14:30:00.000Z');assert.equal(row.start_time_iso,null);assert.equal(row.duration_min,null);assert.equal(row.time_original_values.pub_date,'2026-09-17T12:30:00Z');
 const original=JSON.stringify(row.time_original_values);await ingest([update]);row=(await pool.query('SELECT * FROM events WHERE id=$1',[first.id])).rows[0];assert.equal(JSON.stringify(row.time_original_values),original);
});
test('RSS description proves a start and end, while a later update cannot replace the established start',async()=>{
 const first={...event('time-proven'),statusText:'ukončená',descriptionRaw:'stav: ukončená<br>zahájení: 17. září 2026, 16:30<br>ukončení: 17. září 2026, 16:40<br>Kladno'};
 await ingest([first]);let row=await getEventMeta(first.id);assert.equal(row.start_time_iso,'2026-09-17T14:30:00.000Z');assert.equal(row.end_time_iso,'2026-09-17T14:40:00.000Z');assert.equal(row.duration_min,10);assert.equal(row.duration_source,'rss_start_and_end');assert.equal(row.duration_is_estimate,false);
 await ingest([{...first,startTimeIso:'2026-09-17T14:35:00Z',pubDate:new Date().toISOString()}]);row=await getEventMeta(first.id);assert.equal(row.start_time_iso,'2026-09-17T14:30:00.000Z');assert.equal(row.duration_min,10);
});
test('first explicitly open observation drives live and closed estimates without moving first_seen_at',async()=>{
 const id='duration-first-open';const open=event(id,new Date().toISOString());
 assert.equal((await ingest([open])).data.inserted,1);
 const end=new Date(Math.floor(Date.now()/1000)*1000);const first=new Date(end.getTime()-70*60000);
 await pool.query('UPDATE events SET first_seen_at=$2 WHERE id=$1',[id,first.toISOString()]);
 let row=await getEventMeta(id);assert.equal(row.first_seen_was_open,true);assert.equal(row.first_seen_status,'probíhá zásah');assert.equal(row.duration_source,'first_seen_open_estimate');assert.equal(row.duration_is_estimate,true);
 const originalFirst=new Date(row.first_seen_at).toISOString();
 const active=await fetch(base+'/api/events/'+id+'/detail').then(r=>r.json());assert.equal(active.event.duration_is_estimate,true);assert.ok(active.event.duration_min>=69&&active.event.duration_min<=70);
 await ingest([{...open,pubDate:new Date().toISOString()}]);row=await getEventMeta(id);assert.equal(new Date(row.first_seen_at).toISOString(),originalFirst);
 const closed={...open,pubDate:new Date().toISOString(),statusText:'ukončená',endTimeIso:end.toISOString(),descriptionRaw:'stav: ukončená<br>Kladno'};
 assert.equal((await ingest([closed])).data.updated,1);row=await getEventMeta(id);assert.equal(row.duration_min,70);assert.equal(row.duration_source,'first_seen_to_rss_end_estimate');assert.equal(row.duration_is_estimate,true);assert.equal(new Date(row.first_seen_at).toISOString(),originalFirst);
 assert.equal((await ingest([closed])).data.inserted,0);assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM events WHERE id=$1',[id])).rows[0].count,1);
});
test('an event first seen closed and an invalid first-seen interval never receive estimates',async()=>{
 const direct={...event('duration-first-closed',new Date().toISOString()),statusText:'ukončená',endTimeIso:new Date().toISOString(),descriptionRaw:'stav: ukončená<br>Kladno'};
 await ingest([direct]);let row=await getEventMeta(direct.id);assert.equal(row.first_seen_was_open,false);assert.equal(row.duration_min,null);assert.equal(row.duration_source,null);assert.equal(row.duration_is_estimate,false);
 const id='duration-invalid-order',open=event(id,new Date().toISOString());await ingest([open]);
 const end=new Date();await pool.query('UPDATE events SET first_seen_at=$2 WHERE id=$1',[id,new Date(end.getTime()+60000).toISOString()]);
 await ingest([{...open,statusText:'ukončená',endTimeIso:end.toISOString(),descriptionRaw:'stav: ukončená<br>Kladno'}]);row=await getEventMeta(id);assert.equal(row.duration_min,null);assert.equal(row.duration_source,null);assert.equal(row.duration_is_estimate,false);
});
test('manual verified start and coordinates survive RSS update; exact RSS end uses that start',async()=>{
 const first=event('time-manual');await ingest([first]);await pool.query("UPDATE events SET start_time_iso='2026-09-17T14:30:00Z',start_time_source='manual',lat=50.1,lon=14.1,geo_source='manual' WHERE id=$1",[first.id]);
 await ingest([{...first,statusText:'ukončená',pubDate:new Date().toISOString(),descriptionRaw:'stav: ukončená<br>ukončení: 17. září 2026, 16:40<br>Kladno'}]);const row=await getEventMeta(first.id);assert.equal(row.start_time_iso,'2026-09-17T14:30:00Z');assert.equal(row.duration_min,10);assert.equal(row.lat,50.1);assert.equal(row.lon,14.1);
});

test('legacy manual editing preserves raw possible manual start without presenting it as verified',async()=>{
 const first=event('time-legacy-manual');await ingest([first]);await pool.query("UPDATE events SET start_time_iso='2026-09-17T07:25:00Z',start_time_source=NULL,time_model_version=0,geo_source='manual_event_edit',lat=50.1,lon=14.1 WHERE id=$1",[first.id]);
 await ingest([first]);let row=await getEventMeta(first.id);assert.equal(row.start_time_iso,'2026-09-17T07:25:00Z');assert.equal(row.start_time_source,'legacy_manual_unverified');
 const detail=await fetch(base+'/api/events/'+first.id+'/detail').then(r=>r.json());assert.equal(detail.event.start_time_iso,null);assert.equal(detail.event.duration_min,null);
 await pool.query('UPDATE events SET start_time_iso=NULL,start_time_source=NULL WHERE id=$1',[first.id]);await ingest([first]);row=await getEventMeta(first.id);assert.equal(row.start_time_iso,'2026-09-17T07:25:00Z');assert.equal(row.start_time_source,'legacy_manual_unverified');
});

test('legacy explicit manual status/start is preserved as manual rather than demoted by coordinate history',async()=>{
 const first=event('time-old-proven-manual');await ingest([first]);await pool.query("UPDATE events SET start_time_iso='2026-09-17T14:30:00Z',start_time_source=NULL,status_source='manual',geo_source='manual_event_edit' WHERE id=$1",[first.id]);await ingest([first]);const row=await getEventMeta(first.id);assert.equal(row.start_time_iso,'2026-09-17T14:30:00Z');assert.equal(row.start_time_source,'manual');
});
