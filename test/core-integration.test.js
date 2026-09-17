import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createTestDatabase } from "../test-support/database.js";
import { pool, getEventMeta, autoCloseStaleOpenEvents, setCachedGeocode, initDb } from "../db.js";

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

test("isolated health/static/API smoke and protected diagnostics", async () => {
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/api/admin/ingest-diagnostics")).status, 401);
  assert.equal((await fetch(base + "/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
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
  assert.equal(normalizeFeedTimestamp("2026-09-17 12:23:47"), "2026-09-17T10:23:47.000Z");
  assert.equal(normalizeFeedTimestamp("2026-01-17 12:23:47"), "2026-01-17T11:23:47.000Z");
  assert.equal(normalizeFeedTimestamp("2026-03-29 01:30:00"), "2026-03-29T00:30:00.000Z");
  assert.equal(normalizeFeedTimestamp("2026-03-29 03:30:00"), "2026-03-29T01:30:00.000Z");
  assert.equal(normalizeFeedTimestamp("2026-03-29 02:30:00"), null);
  assert.equal(normalizeFeedTimestamp("2026-02-30 10:00:00"), null);
  assert.equal(pragueLocalToUtcIso(2026, 8, 17, 10, 15), "2026-09-17T08:15:00.000Z");
  assert.equal(parseTimesFromDescription("stav: probíhá zásah<br>ukončení: <br>Kladno").isClosed, false);
  assert.equal(parseTimesFromDescription("ukončení: 16. září 2026, 23:55").endIso, "2026-09-16T21:55:00.000Z");
  assert.equal(safeDurationFromStartEnd("2026-09-16T21:55:00Z", "2026-09-16T22:15:00Z"), 20);
  assert.equal(safeDurationFromStartEnd("2026-09-16T22:15:00Z", "2026-09-16T21:55:00Z"), null);
});

test("ingest deduplicates a batch and updates a stable ID without changing its start", async () => {
  const first = event("audit-stable");
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
  assert.equal(afterUpdate.pub_date, stored.pub_date);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM events WHERE id=$1", [first.id])).rows[0].count, 1);
});

test("RSS carry-over stays open and receives exact closing time/duration across midnight", async () => {
  const first = event("audit-carry", "2026-01-15 23:50:17");
  assert.equal((await ingest([first])).data.inserted, 1);
  const item = { ...first, pubDate: "2026-01-16 00:00:00", statusText: "ukončená", endTimeIso: "2026-01-16 00:15:17", descriptionRaw: "stav: ukončená<br>Kladno" };
  const next = await ingest([item]);
  assert.equal(next.data.updated, 1);
  const stored = await getEventMeta(first.id);
  assert.equal(stored.is_closed, true);
  assert.equal(stored.start_time_iso, "2026-01-15T22:50:17.000Z");
  assert.equal(stored.end_time_iso, "2026-01-15T23:15:17.000Z");
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
  const before = (await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count;
  await initDb();
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM events")).rows[0].count, before);
  assert.ok((await pool.query("SELECT skipped_count, skipped_older_count FROM ingest_log LIMIT 1")).rows.length);
});
