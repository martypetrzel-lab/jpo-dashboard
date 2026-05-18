import crypto from "crypto";
import { WebSocketServer } from "ws";
import {
  getSessionUserByTokenSha,
  deleteSessionByTokenSha
} from "./db.js";

// FireWatch Talk v0.9
// Soukromý týmový hlasový chat FireWatchCZ.
// Není určen pro komunikaci složek IZS ani pro řízení zásahů.
// Přenos hlasu: server-relay PCM přes WebSocket.
// Nově: stavy uživatelů, rychlé reakce/statusy, textový chat, Nerušit a admin nástroje.

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
const MAX_STORED_VOICE_MESSAGE_BYTES = Math.max(256000, Number(process.env.FIREWATCH_TALK_MAX_VOICE_MESSAGE_BYTES || 3_000_000));
const MAX_STORED_VOICE_MESSAGE_MS = Math.max(5000, Number(process.env.FIREWATCH_TALK_MAX_VOICE_MESSAGE_MS || 90000));
const MAX_CHAT_MESSAGES_PER_ROOM = Math.max(10, Number(process.env.FIREWATCH_TALK_MAX_CHAT_MESSAGES_PER_ROOM || 30));
const MAX_CHAT_MESSAGE_LENGTH = Math.max(80, Number(process.env.FIREWATCH_TALK_MAX_CHAT_MESSAGE_LENGTH || 500));

const USER_STATUSES = new Set(["online", "ready", "busy", "away", "listening"]);
const QUICK_REACTIONS = {
  understood: "✅ Rozumím",
  seen: "👀 Vidím",
  wait: "⏳ Počkej",
  cannot: "❌ Nemůžu",
  ok: "👌 OK",
  test: "🧪 Test"
};


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

function normalizeUserStatus(value) {
  const status = String(value || "online").trim().toLowerCase();
  return USER_STATUSES.has(status) ? status : "online";
}

function cleanChatMessage(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

function publicChatMessage(message) {
  return {
    id: message.id,
    room: message.room,
    userId: message.userId,
    name: message.name,
    role: message.role,
    kind: message.kind,
    text: message.text,
    createdAt: message.createdAt,
    timeLabel: formatVoiceTime(message.createdAt),
    system: Boolean(message.system)
  };
}


function formatVoiceTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function attachOpsRadio(server, options = {}) {
  const enabled = String(process.env.RADIO_ENABLED || options.enabled || "true").toLowerCase() !== "false";

  const rooms = new Map();
  const roomState = new Map();
  const clients = new Map();
  // Dočasná historie: v každé místnosti držíme jen poslední zprávu od každého uživatele.
  // Neukládá se do databáze ani na disk; po restartu serveru zmizí.
  const lastVoiceMessages = new Map();
  const chatMessages = new Map();

  for (const room of SYSTEM_ROOMS) {
    rooms.set(room.room, { ...room, createdAt: Date.now(), createdByUserId: null, createdByName: "FireWatch" });
    roomState.set(room.room, { txClientId: null, txName: null });
    lastVoiceMessages.set(room.room, new Map());
    chatMessages.set(room.room, []);
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
        status: client.status || "online",
        dnd: Boolean(client.dnd),
        muted: Boolean(client.muted),
        device: client.device || "web",
        lastReaction: client.lastReaction || null,
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

  function getVoiceSummaryForRoom(room) {
    const map = lastVoiceMessages.get(room);
    if (!map) return [];

    return [...map.values()]
      .sort((a, b) => b.endedAt - a.endedAt)
      .map((msg) => ({
        id: msg.id,
        userId: msg.userId,
        name: msg.name,
        role: msg.role,
        room: msg.room,
        durationMs: msg.durationMs,
        bytes: msg.bytes,
        endedAt: msg.endedAt,
        timeLabel: formatVoiceTime(msg.endedAt)
      }));
  }

  function getChatSummaryForRoom(room) {
    return (chatMessages.get(room) || []).map(publicChatMessage);
  }

  function addRoomChatMessage(room, client, text, kind = "chat", system = false) {
    const cleanText = cleanChatMessage(text);
    if (!cleanText) return null;

    if (!chatMessages.has(room)) chatMessages.set(room, []);
    const list = chatMessages.get(room);

    const message = {
      id: crypto.randomUUID(),
      room,
      userId: client ? String(client.userId) : "system",
      name: client ? publicClientName(client) : "FireWatch Talk",
      role: client?.role || "system",
      kind,
      text: cleanText,
      createdAt: Date.now(),
      system
    };

    list.push(message);
    while (list.length > MAX_CHAT_MESSAGES_PER_ROOM) list.shift();

    broadcastRoomState(room);
    return message;
  }

  function clearRoomChatMessages(room) {
    chatMessages.set(room, []);
    broadcastRoomState(room);
  }

  function saveLastVoiceMessage(client, reason = "release") {
    const rec = client.currentVoiceMessage;
    client.currentVoiceMessage = null;

    if (!rec || !rec.chunks?.length || rec.bytes <= 0) return;

    const endedAt = Date.now();
    const durationMs = Math.max(0, endedAt - rec.startedAt);
    if (durationMs < 250) return;

    const room = rec.room;
    if (!lastVoiceMessages.has(room)) lastVoiceMessages.set(room, new Map());

    const map = lastVoiceMessages.get(room);
    map.set(String(client.userId), {
      id: crypto.randomUUID(),
      userId: String(client.userId),
      name: publicClientName(client),
      role: client.role,
      room,
      startedAt: rec.startedAt,
      endedAt,
      durationMs,
      bytes: rec.bytes,
      reason,
      chunks: rec.chunks
    });
  }

  function clearRoomVoiceMessages(room) {
    lastVoiceMessages.delete(room);
  }

  function sendVoiceMessageReplay(client, targetUserId) {
    const roomMap = lastVoiceMessages.get(client.room);
    const message = roomMap?.get(String(targetUserId));

    if (!message) {
      sendJson(client.ws, { type: "voice_replay_error", message: "Hlasová zpráva už není dostupná." });
      return;
    }

    sendJson(client.ws, {
      type: "voice_replay_start",
      id: message.id,
      userId: message.userId,
      name: message.name,
      room: message.room,
      durationMs: message.durationMs,
      endedAt: message.endedAt,
      timeLabel: formatVoiceTime(message.endedAt)
    });

    for (const chunk of message.chunks) {
      if (client.ws.readyState !== client.ws.OPEN) break;
      client.ws.send(chunk, { binary: true });
    }

    sendJson(client.ws, { type: "voice_replay_end", id: message.id, userId: message.userId });
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
      clients: currentRoomMeta ? getClientsInRoom(client.room) : [],
      voiceMessages: currentRoomMeta ? getVoiceSummaryForRoom(client.room) : [],
      chatMessages: currentRoomMeta ? getChatSummaryForRoom(client.room) : [],
      currentUserStatus: client.status || "online",
      currentUserDnd: Boolean(client.dnd),
      currentUserMuted: Boolean(client.muted)
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
      saveLastVoiceMessage(client, reason);
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
      currentVoiceMessage: null,
      status: "online",
      dnd: false,
      muted: false,
      lastReaction: null,
      device: /mobile|android|iphone|ipad/i.test(String(req.headers["user-agent"] || "")) ? "mobile" : "desktop",
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
      roomCounts: getRoomListForClient(client),
      voiceMessages: getVoiceSummaryForRoom(client.room),
      chatMessages: getChatSummaryForRoom(client.room),
      currentUserStatus: client.status,
      currentUserDnd: client.dnd,
      currentUserMuted: client.muted
    });

    broadcastAllRoomStates();

    ws.on("message", (message, isBinary) => {
      client.lastSeenAt = Date.now();

      if (isBinary) {
        const st = roomState.get(client.room);
        if (!st || st.txClientId !== client.id) return;

        if (client.currentVoiceMessage && client.currentVoiceMessage.room === client.room) {
          const chunk = Buffer.isBuffer(message) ? Buffer.from(message) : Buffer.from(message);
          const nextBytes = client.currentVoiceMessage.bytes + chunk.byteLength;
          const nextDuration = Date.now() - client.currentVoiceMessage.startedAt;
          if (nextBytes <= MAX_STORED_VOICE_MESSAGE_BYTES && nextDuration <= MAX_STORED_VOICE_MESSAGE_MS) {
            client.currentVoiceMessage.chunks.push(chunk);
            client.currentVoiceMessage.bytes = nextBytes;
          }
        }

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
        lastVoiceMessages.set(nextRoom, new Map());
        chatMessages.set(nextRoom, []);
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
        clearRoomVoiceMessages(targetRoom);
        chatMessages.delete(targetRoom);
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


      if (data.type === "set_presence") {
        client.status = normalizeUserStatus(data.status);
        client.dnd = Boolean(data.dnd);
        broadcastRoomState(client.room);
        return;
      }

      if (data.type === "send_reaction") {
        const key = String(data.reaction || "").trim();
        const text = QUICK_REACTIONS[key] || cleanChatMessage(data.text || "");
        if (!text) {
          sendJson(ws, { type: "error", message: "Neplatný status / reakce." });
          return;
        }

        client.lastReaction = text;
        addRoomChatMessage(client.room, client, text, "reaction", false);
        return;
      }

      if (data.type === "send_chat_message") {
        const text = cleanChatMessage(data.text || "");
        if (!text) {
          sendJson(ws, { type: "error", message: "Zpráva je prázdná." });
          return;
        }

        addRoomChatMessage(client.room, client, text, "chat", false);
        return;
      }

      if (data.type === "admin_clear_chat") {
        if (client.role !== "admin") {
          sendJson(ws, { type: "error", message: "Tuto akci může provést jen admin." });
          return;
        }

        clearRoomChatMessages(client.room);
        addRoomChatMessage(client.room, null, "Admin vyčistil textový chat místnosti.", "system", true);
        return;
      }

      if (data.type === "admin_clear_voice") {
        if (client.role !== "admin") {
          sendJson(ws, { type: "error", message: "Tuto akci může provést jen admin." });
          return;
        }

        lastVoiceMessages.set(client.room, new Map());
        addRoomChatMessage(client.room, null, "Admin vyčistil poslední hlasové zprávy místnosti.", "system", true);
        broadcastRoomState(client.room);
        return;
      }

      if (data.type === "admin_kick_user") {
        if (client.role !== "admin") {
          sendJson(ws, { type: "error", message: "Tuto akci může provést jen admin." });
          return;
        }

        const targetId = String(data.clientId || "");
        const target = clients.get(targetId);
        if (!target || target.room !== client.room) {
          sendJson(ws, { type: "error", message: "Uživatel není v této místnosti." });
          return;
        }

        if (target.id === client.id) {
          sendJson(ws, { type: "error", message: "Sám sebe takto odpojit nejde." });
          return;
        }

        releaseTx(target, "admin_kick");
        sendJson(target.ws, { type: "admin_notice", message: "Byl jsi odpojen správcem." });
        try { target.ws.close(4001, "admin kick"); } catch {}
        addRoomChatMessage(client.room, null, `Admin odpojil uživatele ${publicClientName(target)}.`, "system", true);
        return;
      }

      if (data.type === "admin_mute_user") {
        if (client.role !== "admin") {
          sendJson(ws, { type: "error", message: "Tuto akci může provést jen admin." });
          return;
        }

        const targetId = String(data.clientId || "");
        const target = clients.get(targetId);
        if (!target || target.room !== client.room) {
          sendJson(ws, { type: "error", message: "Uživatel není v této místnosti." });
          return;
        }

        target.muted = Boolean(data.muted);
        if (target.muted) releaseTx(target, "admin_mute");
        sendJson(target.ws, { type: "admin_notice", message: target.muted ? "Správce ti dočasně vypnul možnost mluvit." : "Správce ti znovu povolil mluvení." });
        addRoomChatMessage(client.room, null, `${publicClientName(target)}: ${target.muted ? "mluvení vypnuto správcem" : "mluvení znovu povoleno"}.`, "system", true);
        broadcastRoomState(client.room);
        return;
      }

      if (data.type === "ptt_request") {
        if (client.muted) {
          sendJson(ws, { type: "ptt_denied", message: "Správce ti dočasně vypnul možnost mluvit v Talku." });
          return;
        }

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
        client.currentVoiceMessage = {
          room: client.room,
          startedAt: Date.now(),
          chunks: [],
          bytes: 0
        };

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

      if (data.type === "replay_voice_message") {
        sendVoiceMessageReplay(client, data.userId);
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

  console.log(`[FW TALK] v0.9 WebSocket/PCM relay běží na /ops-radio | enabled=${enabled} | customRooms=true | lastVoicePerUser=memory`);
  return { wss };
}
