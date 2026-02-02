// server.js (ESM)
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { initDb, upsertEvent, getEvents, getStats, exportCsv } from "./db.js";

const app = express();

// ===== CORS (bez balíčku) =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "2mb" }));

// ===== Static public =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const API_KEY = process.env.API_KEY || "JPO_KEY_123456";

function requireKey(req, res, next) {
  const key = req.header("X-API-Key") || "";
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => res.send("OK"));

// Ingest (ESP nebo jiný zdroj)
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const source = req.body?.source || "unknown";
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    let accepted = 0;
    let closedSeen = 0;

    for (const it of items) {
      const r = await upsertEvent(it);
      if (r?.upserted) {
        accepted++;
        if (r.row?.is_closed) closedSeen++;
      }
    }

    res.json({
      ok: true,
      source,
      accepted,
      closed_seen_in_batch: closedSeen
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Events (filtry)
app.get("/api/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 500), 2000);

  let active = null;
  if (req.query.active === "1" || req.query.active === "true") active = true;
  if (req.query.active === "0" || req.query.active === "false") active = false;

  const kind = req.query.kind ? String(req.query.kind) : null;

  const rows = await getEvents({ limit, active, kind });
  res.json({ ok: true, items: rows });
});

// Stats
app.get("/api/stats", async (req, res) => {
  const days = Math.min(Number(req.query.days || 30), 365);
  const stats = await getStats(days);
  res.json({ ok: true, ...stats });
});

// Export CSV
app.get("/api/export.csv", async (req, res) => {
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;

  const csv = await exportCsv({ from, to });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jpo_export.csv"`);
  res.send(csv);
});

const port = process.env.PORT || 3000;

await initDb();
app.listen(port, () => console.log(`listening on ${port}`));
