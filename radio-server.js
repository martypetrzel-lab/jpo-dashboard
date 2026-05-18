import crypto from "crypto";
import { WebSocketServer } from "ws";
import {
  getSessionUserByTokenSha,
  deleteSessionByTokenSha
} from "./db.js";

// FireWatchCZ OPS Radio v0.5
// Interní internetová PTT vysílačka pro přihlášené role ops/admin.
// Přenos hlasu je server-relay PCM přes WebSocket. WebSocket řeší i OPS autorizaci,
// kanály a PTT zámek. Tohle je stabilnější pro mobil ↔ PC než krátké WebM chunky.

const DEFAULT_CHANNELS = ["OPS", "JEDNOTKA", "VELITEL", "TECHNICKY", "TEST"];
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "FWSESS";

function parseCookiesFromHeader(headerValue) {
  const out = {};
  const h = String(headerValue || "");
  h.split(";").map((s) => s.trim()).filter(Boolean).forEach((pair) => {
    const i = pair.indexOf("=");
    if (i < 0) return;
    const k = pair.substring(0, i).trim();
    const v = pair.substring(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function authFromWsRequest(req) {
  try {
    const cookies = parseCookiesFromHeader(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;

    const tokenSha = sha256Hex(token);
    const row = await getSessionUserByTokenSha(tokenSha);
    if (!row) return null;

    const expMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expMs) || expMs <= Date.now()) {
      await deleteSessionByTokenSha(tokenSha);
      return null;
    }

    if (!row.is_enabled) return null;

    const role = String(row.role || "public");
    if (!["ops", "admin"].includes(role)) return null;

    return {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        username: row.username,
        role
      }
    };
  } catch (error) {
    console.error("[OPS RADIO] auth error:", error?.message || error);
    return null;
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeChannel(channel) {
  const value = String(channel || "OPS").trim().toUpperCase();
  return value || "OPS";
}

function sendJson(ws, data) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(data));
}

export function attachOpsRadio(server, options = {}) {
  const enabled = String(process.env.RADIO_ENABLED || options.enabled || "true").toLowerCase() !== "false";
  const channels = Array.isArray(options.channels) && options.channels.length
    ? options.channels.map(normalizeChannel)
    : DEFAULT_CHANNELS;

  const wss = new WebSocketServer({
    server,
    path: "/ops-radio"
  });

  const clients = new Map();
  const channelState = new Map();

  for (const channel of channels) {
    channelState.set(channel, {
      txClientId: null,
      txName: null
    });
  }

  function getClientsInChannel(channel) {
    return [...clients.values()]
      .filter((client) => client.channel === channel)
      .map((client) => ({
        id: client.id,
        name: client.name,
        role: client.role,
        channel: client.channel,
        transmitting: channelState.get(channel)?.txClientId === client.id
      }));
  }

  function broadcastChannelState(channel) {
    const st = channelState.get(channel) || { txClientId: null, txName: null };
    const payload = {
      type: "radio_state",
      enabled,
      channel,
      channels,
      transmitting: Boolean(st.txClientId),
      txClientId: st.txClientId,
      txName: st.txName,
      clients: getClientsInChannel(channel)
    };

    for (const client of clients.values()) {
      if (client.channel === channel) sendJson(client.ws, payload);
    }
  }

  function releaseTx(client, reason = "release") {
    const st = channelState.get(client.channel);
    if (!st) return;

    if (st.txClientId === client.id) {
      st.txClientId = null;
      st.txName = null;

      for (const other of clients.values()) {
        if (other.channel === client.channel) {
          sendJson(other.ws, {
            type: "ptt_released",
            channel: client.channel,
            by: client.name,
            reason
          });
        }
      }

      broadcastChannelState(client.channel);
    }
  }

  wss.on("connection", async (ws, req) => {
    if (!enabled) {
      sendJson(ws, { type: "error", message: "OPS rádio je na serveru vypnuté." });
      ws.close(1008, "radio disabled");
      return;
    }

    const auth = await authFromWsRequest(req);
    if (!auth?.user) {
      sendJson(ws, { type: "auth_error", message: "OPS rádio je dostupné jen po přihlášení jako ops/admin." });
      ws.close(1008, "unauthorized");
      return;
    }

    const id = crypto.randomUUID();
    const initialChannel = channels.includes("OPS") ? "OPS" : channels[0];

    const client = {
      id,
      ws,
      name: auth.user.username || "OPS",
      role: auth.user.role,
      channel: initialChannel,
      createdAt: Date.now()
    };

    clients.set(id, client);

    sendJson(ws, {
      type: "auth_ok",
      enabled,
      clientId: id,
      name: client.name,
      role: client.role,
      channel: client.channel,
      channels
    });

    broadcastChannelState(client.channel);

    ws.on("message", (message, isBinary) => {
      if (isBinary) {
        const st = channelState.get(client.channel);
        if (!st || st.txClientId !== client.id) return;

        for (const other of clients.values()) {
          if (
            other.id !== client.id &&
            other.channel === client.channel &&
            other.ws.readyState === other.ws.OPEN
          ) {
            other.ws.send(message, { binary: true });
          }
        }
        return;
      }

      const data = safeJsonParse(String(message));
      if (!data?.type) {
        sendJson(ws, { type: "error", message: "Neplatná zpráva." });
        return;
      }

      if (data.type === "join_channel") {
        const nextChannel = normalizeChannel(data.channel);
        if (!channels.includes(nextChannel)) {
          sendJson(ws, { type: "error", message: "Neplatný kanál." });
          return;
        }

        const oldChannel = client.channel;
        releaseTx(client, "channel_change");
        client.channel = nextChannel;

        broadcastChannelState(oldChannel);
        broadcastChannelState(nextChannel);
        return;
      }

      if (data.type === "ptt_request") {
        const st = channelState.get(client.channel);
        if (!st) {
          sendJson(ws, { type: "ptt_denied", message: "Kanál neexistuje." });
          return;
        }

        if (st.txClientId && st.txClientId !== client.id) {
          sendJson(ws, {
            type: "ptt_denied",
            message: `Kanál právě používá ${st.txName || "jiný uživatel"}.`
          });
          return;
        }

        st.txClientId = client.id;
        st.txName = client.name;

        for (const other of clients.values()) {
          if (other.channel === client.channel) {
            sendJson(other.ws, {
              type: "ptt_granted",
              channel: client.channel,
              by: client.name,
              self: other.id === client.id
            });
          }
        }

        broadcastChannelState(client.channel);
        return;
      }

      if (data.type === "ptt_release") {
        releaseTx(client, "button_release");
        return;
      }

      if (data.type === "ping") {
        sendJson(ws, { type: "pong", ts: Date.now() });
      }
    });

    ws.on("close", () => {
      releaseTx(client, "disconnect");
      const oldChannel = client.channel;
      clients.delete(id);
      broadcastChannelState(oldChannel);
    });

    ws.on("error", () => {
      releaseTx(client, "socket_error");
      const oldChannel = client.channel;
      clients.delete(id);
      broadcastChannelState(oldChannel);
    });
  });

  console.log(`[OPS RADIO] WebSocket/PCM relay běží na /ops-radio | enabled=${enabled} | channels=${channels.join(", ")}`);
  return { wss };
}
