import crypto from "crypto";
import { WebSocketServer } from "ws";
import {
  getSessionUserByTokenSha,
  deleteSessionByTokenSha
} from "./db.js";

// FireWatch Talk v0.6
// Soukromý týmový hlasový chat FireWatchCZ pro testování a týmovou komunikaci.
// Není určen pro komunikaci složek IZS ani pro řízení zásahů.
// Přenos hlasu: server-relay PCM přes WebSocket.

const DEFAULT_ROOMS = ["HLAVNÍ", "SPRÁVA", "TEST"];
const DEFAULT_ROOM = "HLAVNÍ";
const ADMIN_ONLY_ROOMS = new Set(["SPRÁVA"]);
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "FWSESS";
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_GRACE_MS = 70000;

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
    console.error("[FW TALK] auth error:", error?.message || error);
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

function normalizeRoom(room) {
  const value = String(room || DEFAULT_ROOM).trim().toUpperCase();

  // Zpětná kompatibilita se starými uloženými názvy v prohlížeči.
  if (["OPS", "JEDNOTKA", "VELITEL", "TECHNICKY"].includes(value)) return DEFAULT_ROOM;
  if (["ADMIN", "SPRAVA", "SPRÁVA"].includes(value)) return "SPRÁVA";
  if (value === "TEST") return "TEST";

  return value || DEFAULT_ROOM;
}

function roomAllowedForRole(room, role) {
  if (ADMIN_ONLY_ROOMS.has(room)) return role === "admin";
  return true;
}

function publicRoomsForRole(rooms, role) {
  return rooms.filter((room) => roomAllowedForRole(room, role));
}

function firstAllowedRoom(rooms, role, preferredRoom = DEFAULT_ROOM) {
  const normalized = normalizeRoom(preferredRoom);
  if (rooms.includes(normalized) && roomAllowedForRole(normalized, role)) return normalized;

  if (rooms.includes(DEFAULT_ROOM) && roomAllowedForRole(DEFAULT_ROOM, role)) return DEFAULT_ROOM;

  return publicRoomsForRole(rooms, role)[0] || rooms[0];
}

function sendJson(ws, data) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(data));
}

export function attachOpsRadio(server, options = {}) {
  const enabled = String(process.env.RADIO_ENABLED || options.enabled || "true").toLowerCase() !== "false";
  const rooms = Array.isArray(options.rooms) && options.rooms.length
    ? options.rooms.map(normalizeRoom)
    : DEFAULT_ROOMS;

  const wss = new WebSocketServer({
    server,
    path: "/ops-radio"
  });

  const clients = new Map();
  const roomState = new Map();

  for (const room of rooms) {
    roomState.set(room, {
      txClientId: null,
      txName: null
    });
  }

  function getClientsInRoom(room) {
    return [...clients.values()]
      .filter((client) => client.room === room)
      .map((client) => ({
        id: client.id,
        name: client.name,
        role: client.role,
        room: client.room,
        transmitting: roomState.get(room)?.txClientId === client.id
      }));
  }

  function getRoomCounts() {
    return rooms.map((room) => ({
      room,
      count: [...clients.values()].filter((client) => client.room === room).length,
      transmitting: Boolean(roomState.get(room)?.txClientId),
      txName: roomState.get(room)?.txName || null
    }));
  }

  function broadcastRoomState(room) {
    const st = roomState.get(room) || { txClientId: null, txName: null };

    for (const client of clients.values()) {
      const clientRooms = publicRoomsForRole(rooms, client.role);
      const payload = {
        type: "radio_state",
        enabled,
        room,
        channel: room,
        rooms: clientRooms,
        channels: clientRooms,
        roomCounts: getRoomCounts().filter((item) => clientRooms.includes(item.room)),
        transmitting: Boolean(st.txClientId),
        txClientId: st.txClientId,
        txName: st.txName,
        clients: getClientsInRoom(client.room)
      };

      if (client.room === room) sendJson(client.ws, payload);
    }
  }

  function broadcastAllRoomCounts() {
    for (const room of rooms) broadcastRoomState(room);
  }

  function releaseTx(client, reason = "release") {
    const st = roomState.get(client.room);
    if (!st) return;

    if (st.txClientId === client.id) {
      st.txClientId = null;
      st.txName = null;

      for (const other of clients.values()) {
        if (other.room === client.room) {
          sendJson(other.ws, {
            type: "ptt_released",
            room: client.room,
            channel: client.room,
            by: client.name,
            reason
          });
        }
      }

      broadcastRoomState(client.room);
    }
  }

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of clients.values()) {
      if (now - client.lastSeenAt > HEARTBEAT_GRACE_MS) {
        try { client.ws.close(4000, "heartbeat timeout"); } catch {}
        continue;
      }
      sendJson(client.ws, { type: "ping", ts: now });
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", async (ws, req) => {
    if (!enabled) {
      sendJson(ws, { type: "error", message: "FireWatch Talk je na serveru vypnutý." });
      ws.close(1008, "radio disabled");
      return;
    }

    const auth = await authFromWsRequest(req);
    if (!auth?.user) {
      sendJson(ws, { type: "auth_error", message: "FireWatch Talk je dostupný jen po přihlášení jako ops/admin." });
      ws.close(1008, "unauthorized");
      return;
    }

    const id = crypto.randomUUID();
    const userRooms = publicRoomsForRole(rooms, auth.user.role);
    const initialRoom = firstAllowedRoom(rooms, auth.user.role, DEFAULT_ROOM);

    const client = {
      id,
      ws,
      name: auth.user.username || "Uživatel",
      role: auth.user.role,
      room: initialRoom,
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    };

    clients.set(id, client);

    sendJson(ws, {
      type: "auth_ok",
      enabled,
      clientId: id,
      name: client.name,
      role: client.role,
      room: client.room,
      channel: client.room,
      rooms: userRooms,
      channels: userRooms,
      roomCounts: getRoomCounts().filter((item) => userRooms.includes(item.room))
    });

    broadcastAllRoomCounts();

    ws.on("message", (message, isBinary) => {
      client.lastSeenAt = Date.now();

      if (isBinary) {
        const st = roomState.get(client.room);
        if (!st || st.txClientId !== client.id) return;

        for (const other of clients.values()) {
          if (
            other.id !== client.id &&
            other.room === client.room &&
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

      if (data.type === "pong" || data.type === "ping") {
        sendJson(ws, { type: "pong", ts: Date.now() });
        return;
      }

      if (data.type === "join_channel" || data.type === "join_room") {
        const nextRoom = normalizeRoom(data.room || data.channel);
        if (!rooms.includes(nextRoom) || !roomAllowedForRole(nextRoom, client.role)) {
          sendJson(ws, { type: "error", message: "Do této místnosti nemáš přístup." });
          return;
        }

        const oldRoom = client.room;
        releaseTx(client, "room_change");
        client.room = nextRoom;

        broadcastRoomState(oldRoom);
        broadcastRoomState(nextRoom);
        return;
      }

      if (data.type === "ptt_request") {
        const st = roomState.get(client.room);
        if (!st) {
          sendJson(ws, { type: "ptt_denied", message: "Místnost neexistuje." });
          return;
        }

        if (st.txClientId && st.txClientId !== client.id) {
          sendJson(ws, {
            type: "ptt_denied",
            message: `Právě mluví ${st.txName || "jiný uživatel"}.`
          });
          return;
        }

        st.txClientId = client.id;
        st.txName = client.name;

        for (const other of clients.values()) {
          if (other.room === client.room) {
            sendJson(other.ws, {
              type: "ptt_granted",
              room: client.room,
              channel: client.room,
              by: client.name,
              self: other.id === client.id
            });
          }
        }

        broadcastRoomState(client.room);
        return;
      }

      if (data.type === "ptt_release") {
        releaseTx(client, "button_release");
        return;
      }
    });

    ws.on("close", () => {
      releaseTx(client, "disconnect");
      const oldRoom = client.room;
      clients.delete(id);
      broadcastRoomState(oldRoom);
    });

    ws.on("error", () => {
      releaseTx(client, "socket_error");
      const oldRoom = client.room;
      clients.delete(id);
      broadcastRoomState(oldRoom);
    });
  });

  console.log(`[FW TALK] WebSocket/PCM relay běží na /ops-radio | enabled=${enabled} | rooms=${rooms.join(", ")}`);
  return { wss };
}
