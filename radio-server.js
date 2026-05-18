import crypto from "crypto";
import { WebSocketServer } from "ws";
import {
  getSessionUserByTokenSha,
  deleteSessionByTokenSha
} from "./db.js";

// FireWatch Talk v0.7
// Soukromý týmový hlasový chat FireWatchCZ.
// Není určen pro komunikaci složek IZS ani pro řízení zásahů.
// Přenos hlasu: server-relay PCM přes WebSocket.
// Nově: vlastní místnosti pro přihlášené uživatele, volitelně s heslem.

const DEFAULT_ROOM = "HLAVNÍ";
const SYSTEM_ROOMS = [
  { room: "HLAVNÍ", label: "Hlavní", isSystem: true, adminOnly: false },
  { room: "SPRÁVA", label: "Správa", isSystem: true, adminOnly: true },
  { room: "TEST", label: "Test", isSystem: true, adminOnly: false }
];

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "FWSESS";
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_GRACE_MS = 70000;
const MAX_CUSTOM_ROOMS = Math.max(5, Number(process.env.FIREWATCH_TALK_MAX_CUSTOM_ROOMS || 50));
const MAX_ROOM_NAME_LENGTH = 32;
const ROOM_PASSWORD_SALT = process.env.FIREWATCH_TALK_ROOM_PASSWORD_SALT || "firewatch-talk-v07";

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

    return {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        username: row.username,
        role: String(row.role || "public")
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

function sendJson(ws, data) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(data));
}

function removeDiacritics(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanRoomLabel(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ROOM_NAME_LENGTH);
}

function normalizeRoom(value) {
  const raw = cleanRoomLabel(value).toUpperCase();
  const ascii = removeDiacritics(raw);

  if (["OPS", "JEDNOTKA", "VELITEL", "TECHNICKY", "HLAVNI", "HLAVNÍ"].includes(ascii)) return DEFAULT_ROOM;
  if (["ADMIN", "SPRAVA", "SPRÁVA"].includes(ascii)) return "SPRÁVA";
  if (ascii === "TEST") return "TEST";

  const normalized = raw
    .replace(/[<>"'`\\/|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || DEFAULT_ROOM;
}

function roomAllowedForRole(roomMeta, role) {
  if (!roomMeta) return false;
  if (roomMeta.adminOnly) return role === "admin";
  return true;
}

function hashRoomPassword(room, password) {
  return sha256Hex(`${ROOM_PASSWORD_SALT}:${room}:${String(password || "")}`);
}

function isStrongEnoughRoomName(room) {
  if (!room || room.length < 2) return false;
  if (["OPS", "IZS", "HZS", "JPO", "ZZS", "PCR", "PČR", "KOPIS", "OPIS"].includes(removeDiacritics(room).toUpperCase())) return false;
  return true;
}

function isProtectedRoomUnlockedForClient(roomMeta, client, password) {
  if (!roomMeta?.hasPassword) return true;
  if (client.unlockedRooms.has(roomMeta.room)) return true;
  if (!password) return false;
  return hashRoomPassword(roomMeta.room, password) === roomMeta.passwordHash;
}

function publicClientName(client) {
  return client?.name || "Uživatel";
}

export function attachOpsRadio(server, options = {}) {
  const enabled = String(process.env.RADIO_ENABLED || options.enabled || "true").toLowerCase() !== "false";

  const rooms = new Map();
  const roomState = new Map();
  const clients = new Map();

  for (const room of SYSTEM_ROOMS) {
    rooms.set(room.room, { ...room, createdAt: Date.now(), createdByUserId: null, createdByName: "FireWatch" });
    roomState.set(room.room, { txClientId: null, txName: null });
  }

  const wss = new WebSocketServer({
    server,
    path: "/ops-radio"
  });

  function getRoomMeta(room) {
    return rooms.get(normalizeRoom(room));
  }

  function getRoomMetaListForRole(role) {
    return [...rooms.values()].filter((roomMeta) => roomAllowedForRole(roomMeta, role));
  }

  function firstAllowedRoom(role, preferredRoom = DEFAULT_ROOM) {
    const preferred = getRoomMeta(preferredRoom);
    if (preferred && roomAllowedForRole(preferred, role)) return preferred.room;

    const fallback = getRoomMeta(DEFAULT_ROOM);
    if (fallback && roomAllowedForRole(fallback, role)) return fallback.room;

    return getRoomMetaListForRole(role)[0]?.room || DEFAULT_ROOM;
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

  function roomDescriptorForClient(roomMeta, client) {
    const state = roomState.get(roomMeta.room) || { txClientId: null, txName: null };
    return {
      room: roomMeta.room,
      label: roomMeta.label || roomMeta.room,
      count: [...clients.values()].filter((item) => item.room === roomMeta.room).length,
      transmitting: Boolean(state.txClientId),
      txName: state.txName || null,
      hasPassword: Boolean(roomMeta.hasPassword),
      locked: Boolean(roomMeta.hasPassword && !client.unlockedRooms.has(roomMeta.room) && client.room !== roomMeta.room),
      isSystem: Boolean(roomMeta.isSystem),
      isCustom: !roomMeta.isSystem,
      adminOnly: Boolean(roomMeta.adminOnly),
      createdByName: roomMeta.createdByName || null,
      createdByMe: Boolean(roomMeta.createdByUserId && String(roomMeta.createdByUserId) === String(client.userId))
    };
  }

  function getRoomListForClient(client) {
    return getRoomMetaListForRole(client.role)
      .map((roomMeta) => roomDescriptorForClient(roomMeta, client));
  }

  function sendClientState(client, onlyRoom = null) {
    const currentRoomMeta = getRoomMeta(client.room);
    const st = roomState.get(client.room) || { txClientId: null, txName: null };

    sendJson(client.ws, {
      type: "radio_state",
      enabled,
      room: onlyRoom || client.room,
      channel: onlyRoom || client.room,
      currentRoom: client.room,
      rooms: getRoomListForClient(client),
      channels: getRoomListForClient(client).map((item) => item.room),
      roomCounts: getRoomListForClient(client),
      transmitting: Boolean(st.txClientId),
      txClientId: st.txClientId,
      txName: st.txName,
      clients: currentRoomMeta ? getClientsInRoom(client.room) : []
    });
  }

  function broadcastRoomState(room) {
    for (const client of clients.values()) {
      if (!roomAllowedForRole(getRoomMeta(room), client.role)) continue;
      sendClientState(client, room);
    }
  }

  function broadcastAllRoomStates() {
    for (const room of rooms.keys()) broadcastRoomState(room);
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

  function moveClientsOutOfRoom(room) {
    for (const client of clients.values()) {
      if (client.room !== room) continue;
      releaseTx(client, "room_deleted");
      client.room = firstAllowedRoom(client.role, DEFAULT_ROOM);
      client.unlockedRooms.add(client.room);
      sendJson(client.ws, {
        type: "room_deleted_current",
        message: "Místnost byla odstraněna. Byl jsi přesunut do hlavní místnosti.",
        room: client.room
      });
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
      ws.close(1008, "talk disabled");
      return;
    }

    const auth = await authFromWsRequest(req);
    if (!auth?.user) {
      sendJson(ws, { type: "auth_error", message: "FireWatch Talk je dostupný jen pro přihlášené uživatele." });
      ws.close(1008, "unauthorized");
      return;
    }

    const id = crypto.randomUUID();
    const initialRoom = firstAllowedRoom(auth.user.role, DEFAULT_ROOM);

    const client = {
      id,
      ws,
      userId: auth.user.id,
      name: auth.user.username || "Uživatel",
      role: auth.user.role,
      room: initialRoom,
      unlockedRooms: new Set([initialRoom, DEFAULT_ROOM, "TEST"]),
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    };

    if (client.role === "admin") client.unlockedRooms.add("SPRÁVA");

    clients.set(id, client);

    sendJson(ws, {
      type: "auth_ok",
      enabled,
      clientId: id,
      name: client.name,
      role: client.role,
      room: client.room,
      channel: client.room,
      currentRoom: client.room,
      rooms: getRoomListForClient(client),
      channels: getRoomListForClient(client).map((item) => item.room),
      roomCounts: getRoomListForClient(client)
    });

    broadcastAllRoomStates();

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

      if (data.type === "create_room") {
        const label = cleanRoomLabel(data.name || data.label || "");
        const nextRoom = normalizeRoom(label);
        const password = String(data.password || "");

        if (!isStrongEnoughRoomName(nextRoom)) {
          sendJson(ws, { type: "room_create_error", message: "Zadej neutrální název místnosti alespoň 2 znaky. Nepoužívej názvy složek IZS." });
          return;
        }

        if (rooms.has(nextRoom)) {
          sendJson(ws, { type: "room_create_error", message: "Taková místnost už existuje." });
          return;
        }

        const customCount = [...rooms.values()].filter((roomMeta) => !roomMeta.isSystem).length;
        if (customCount >= MAX_CUSTOM_ROOMS) {
          sendJson(ws, { type: "room_create_error", message: "Limit vlastních místností je vyčerpaný." });
          return;
        }

        const roomMeta = {
          room: nextRoom,
          label: label || nextRoom,
          isSystem: false,
          adminOnly: false,
          createdAt: Date.now(),
          createdByUserId: client.userId,
          createdByName: client.name,
          hasPassword: password.length > 0,
          passwordHash: password.length > 0 ? hashRoomPassword(nextRoom, password) : null
        };

        rooms.set(nextRoom, roomMeta);
        roomState.set(nextRoom, { txClientId: null, txName: null });
        client.unlockedRooms.add(nextRoom);

        sendJson(ws, { type: "room_created", room: nextRoom, label: roomMeta.label, hasPassword: roomMeta.hasPassword });
        broadcastAllRoomStates();
        return;
      }

      if (data.type === "delete_room") {
        const targetRoom = normalizeRoom(data.room);
        const roomMeta = getRoomMeta(targetRoom);

        if (!roomMeta || roomMeta.isSystem) {
          sendJson(ws, { type: "error", message: "Systémovou místnost nejde odstranit." });
          return;
        }

        const isOwner = String(roomMeta.createdByUserId) === String(client.userId);
        if (!isOwner && client.role !== "admin") {
          sendJson(ws, { type: "error", message: "Místnost může odstranit jen autor nebo admin." });
          return;
        }

        moveClientsOutOfRoom(targetRoom);
        rooms.delete(targetRoom);
        roomState.delete(targetRoom);
        for (const c of clients.values()) c.unlockedRooms.delete(targetRoom);
        broadcastAllRoomStates();
        return;
      }

      if (data.type === "join_channel" || data.type === "join_room") {
        const nextRoom = normalizeRoom(data.room || data.channel);
        const roomMeta = getRoomMeta(nextRoom);

        if (!roomMeta || !roomAllowedForRole(roomMeta, client.role)) {
          sendJson(ws, { type: "error", message: "Do této místnosti nemáš přístup." });
          return;
        }

        if (!isProtectedRoomUnlockedForClient(roomMeta, client, data.password)) {
          sendJson(ws, {
            type: "room_password_required",
            room: nextRoom,
            label: roomMeta.label || nextRoom,
            message: "Tato místnost je chráněná heslem."
          });
          return;
        }

        client.unlockedRooms.add(nextRoom);

        const oldRoom = client.room;
        releaseTx(client, "room_change");
        client.room = nextRoom;

        sendJson(ws, { type: "room_joined", room: client.room, label: roomMeta.label || client.room });
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
        st.txName = publicClientName(client);

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
      broadcastAllRoomStates();
    });

    ws.on("error", () => {
      releaseTx(client, "socket_error");
      const oldRoom = client.room;
      clients.delete(id);
      broadcastRoomState(oldRoom);
      broadcastAllRoomStates();
    });
  });

  console.log(`[FW TALK] v0.7 WebSocket/PCM relay běží na /ops-radio | enabled=${enabled} | customRooms=true`);
  return { wss };
}
