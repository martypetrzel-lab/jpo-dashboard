import express from "express";
import cors from "cors";
import { initDb, upsertBatch, getEvents, getStats } from "./db.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.API_KEY || "";

function requireKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ ok: false, error: "missing_api_key" });
  }
  const k = req.header("X-API-Key") || "";
  if (k !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => res.send("OK"));

app.post("/api/ingest", requireKey, async (req, res) => {
  try {
    const { source, items } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: "bad_payload_items" });
    }

    const result = await upsertBatch({ source, items });

    res.json({
      ok: true,
      source: source || "unknown",
      accepted: result.accepted,
      closed_seen_in_batch: result.updatedClosed
    });
  } catch (e) {
    console.error("[INGEST] server_error:", e?.message || e, e?.stack || "");
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const activeQ = req.query.active;
    let active = null;
    if (activeQ === "1" || activeQ === "true") active = true;
    if (activeQ === "0" || activeQ === "false") active = false;

    const rows = await getEvents({ limit, active });
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("[EVENTS] error:", e?.message || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days || 30), 365);
    const stats = await getStats({ days });
    res.json({ ok: true, ...stats });
  } catch (e) {
    console.error("[STATS] error:", e?.message || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// jednoduché statické UI (pokud máš public složku)
app.use(express.static("public"));

app.get("*", (req, res) => {
  // když nemáš public/index.html, tak aspoň něco smysluplného
  res.status(404).send("Not found");
});

const port = process.env.PORT || 3000;

await initDb();
app.listen(port, () => console.log(`listening on :${port}`));
