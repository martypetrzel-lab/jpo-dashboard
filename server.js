import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { initDb, upsertBatch, getEvents, getStats } from "./db.js";

const app = express();

app.use(cors());

// JSON payload limit (klidně navýšíme, ale 200kb je OK pro RSS batch)
app.use(express.json({ limit: "200kb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Static web
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/health", (req, res) => res.send("OK"));

// API KEY middleware
function requireKey(req, res, next) {
  const expected = process.env.JPO_API_KEY || "";
  if (!expected) {
    return res.status(500).json({ ok: false, error: "missing_server_api_key" });
  }
  const got = req.header("X-API-Key") || "";
  if (got !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// Ingest endpoint
app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const body = req.body || {};
    const source = body.source || "unknown";
    const items = Array.isArray(body.items) ? body.items : [];

    console.log(`[ingest] source=${source} items=${items.length} bytes=${JSON.stringify(body).length}`);

    const { accepted, updatedClosed } = await upsertBatch({ source, items });

    res.json({
      ok: true,
      source,
      accepted,
      closed_seen_in_batch: updatedClosed
    });
  } catch (e) {
    // Tohle je klíčové: v Railway logu uvidíš přesnou chybu
    console.error("[ingest] ERROR:", e?.message || e);
    console.error(e?.stack || "");

    res.status(500).json({
      ok: false,
      error: "server_error",
      details: e?.message || String(e)
    });
  }
});

// Read events
app.get("/api/events", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const activeParam = req.query.active;
    const active = activeParam === "true" ? true : activeParam === "false" ? false : null;

    const rows = await getEvents({ limit, active });
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("[events] ERROR:", e?.message || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const stats = await getStats({ days });
    res.json({ ok: true, ...stats });
  } catch (e) {
    console.error("[stats] ERROR:", e?.message || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Fallback: root -> index.html (když by express.static nestačil)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;

await initDb();

app.listen(port, () => {
  console.log(`listening on ${port}`);
});
