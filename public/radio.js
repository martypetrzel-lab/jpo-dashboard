// FireWatch Talk v0.8
// Soukromý týmový hlasový chat FireWatchCZ.
// Přenos hlasu: server-relay PCM přes WebSocket.
// Vlastní zvuk PTT: nahraj soubor do /public/sounds/ptt-press.mp3.
// Nově: poslední hlasová zpráva od každého uživatele v místnosti, pouze v paměti serveru.

(function () {
  const STORAGE_ROOM = "firewatch_talk_room_v3";
  const TARGET_SAMPLE_RATE = 16000;
  const PROCESSOR_BUFFER_SIZE = 2048;
  const PACKET_HEADER_SIZE = 12;
  const MAGIC = [0x46, 0x57, 0x52, 0x37]; // FWR7
  const DEFAULT_ROOM = "HLAVNÍ";
  const PTT_SOUND_URL = "/sounds/ptt-press.mp3";
  const PTT_SOUND_VOLUME = 0.42;
  const RECONNECT_DELAY_MS = 1800;
  const KEEPALIVE_MS = 20000;

  let mount = null;
  let ws = null;
  let audioContext = null;
  let localStream = null;
  let micSource = null;
  let processor = null;
  let zeroGain = null;
  let authenticated = false;
  let pttActive = false;
  let visible = false;
  let clientId = null;
  let room = normalizeRoom(localStorage.getItem(STORAGE_ROOM) || DEFAULT_ROOM);
  let rooms = [];
  let myName = "Uživatel";
  let myRole = "public";
  let packetSeq = 0;
  let nextPlaybackTime = 0;
  let manualCloseRequested = false;
  let reconnectTimer = null;
  let keepAliveTimer = null;
  let pttSoundFailed = false;
  let voiceMessages = [];
  let replayActive = false;

  function wsUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ops-radio`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function cleanLabel(value) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeRoom(value) {
    const raw = cleanLabel(value).toUpperCase();
    if (["OPS", "JEDNOTKA", "VELITEL", "TECHNICKY", "HLAVNI", "HLAVNÍ"].includes(raw)) return DEFAULT_ROOM;
    if (["ADMIN", "SPRAVA", "SPRÁVA"].includes(raw)) return "SPRÁVA";
    if (raw === "TEST") return "TEST";
    return raw || DEFAULT_ROOM;
  }

  function roomLabel(value) {
    const meta = getRoomMeta(value);
    if (meta?.label) return meta.label;

    const normalized = normalizeRoom(value);
    if (normalized === "HLAVNÍ") return "Hlavní";
    if (normalized === "SPRÁVA") return "Správa";
    if (normalized === "TEST") return "Test";
    return normalized;
  }

  function getRoomMeta(value) {
    const normalized = normalizeRoom(value);
    return rooms.find((item) => normalizeRoom(item.room) === normalized) || null;
  }

  function roomOptions() {
    return rooms
      .map((item) => {
        const value = normalizeRoom(item.room);
        const lock = item.locked ? "🔒 " : "";
        const custom = item.isCustom ? " • vlastní" : "";
        const count = Number.isFinite(Number(item.count)) ? ` (${item.count})` : "";
        const label = `${lock}${item.label || roomLabel(value)}${count}${custom}`;
        return `<option value="${escapeHtml(value)}" ${value === room ? "selected" : ""}>${escapeHtml(label)}</option>`;
      })
      .join("");
  }

  function getAudioContextClass() {
    return window.AudioContext || window.webkitAudioContext;
  }

  async function unlockAudio() {
    try {
      const AudioContextClass = getAudioContextClass();
      if (!AudioContextClass) return null;

      if (!audioContext || audioContext.state === "closed") {
        audioContext = new AudioContextClass();
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      return audioContext;
    } catch (error) {
      console.warn("[FW TALK] audio unlock error", error);
      return null;
    }
  }

  function fallbackBeep(freq = 700, duration = 60) {
    try {
      const ctx = audioContext;
      if (!ctx || ctx.state === "closed") return;

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.frequency.value = freq;
      oscillator.type = "sine";
      gain.gain.value = 0.035;
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      setTimeout(() => {
        try { oscillator.stop(); } catch {}
        try { oscillator.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      }, duration);
    } catch {}
  }

  function playPttSound() {
    if (pttSoundFailed) {
      fallbackBeep(720, 45);
      return;
    }

    try {
      const audio = new Audio(PTT_SOUND_URL);
      audio.volume = PTT_SOUND_VOLUME;
      audio.play().catch(() => {
        pttSoundFailed = true;
        fallbackBeep(720, 45);
      });
    } catch {
      pttSoundFailed = true;
      fallbackBeep(720, 45);
    }
  }

  function setStatus(text, type = "idle") {
    const el = mount?.querySelector("[data-radio-status]");
    if (!el) return;
    el.textContent = text;
    el.dataset.state = type;
  }

  function setTx(text) {
    const el = mount?.querySelector("[data-radio-tx]");
    if (!el) return;
    el.textContent = text;
  }

  function setConnectButton(isConnected) {
    const btn = mount?.querySelector("#opsRadioConnect");
    if (!btn) return;
    btn.textContent = isConnected ? "Odpojit Talk" : "Připojit Talk";
    btn.dataset.connected = isConnected ? "1" : "0";
  }

  function render() {
    if (!mount) return;

    mount.innerHTML = `
      <div class="ops-radio-card">
        <div class="ops-radio-head">
          <div>
            <h2>FireWatch Talk <span class="ops-radio-version">v0.8</span></h2>
            <p>Soukromý hlasový chat FireWatchCZ pro testování a týmovou komunikaci.</p>
            <p class="ops-radio-disclaimer">Není určen pro komunikaci složek IZS ani pro řízení zásahů.</p>
          </div>
          <div class="ops-radio-live" data-radio-status data-state="idle">Odpojeno</div>
        </div>

        <div class="ops-radio-panel">
          <div class="ops-radio-row ops-radio-row-main">
            <label>
              Místnost
              <select id="opsRadioRoomLive" disabled></select>
            </label>

            <div class="ops-radio-tx">
              <span>Právě mluví</span>
              <strong data-radio-tx>Nikdo</strong>
            </div>

            <button class="ops-radio-connect" id="opsRadioConnect">Připojit Talk</button>
          </div>

          <button class="ops-radio-ptt" id="opsRadioPtt" disabled>
            DRŽ PRO MLUVENÍ
          </button>

          <details class="ops-radio-create">
            <summary>Vytvořit vlastní místnost</summary>
            <div class="ops-radio-create-grid">
              <label>
                Název místnosti
                <input id="fwTalkNewRoomName" type="text" maxlength="32" placeholder="Např. Tým, Cvičení, Test 2">
              </label>
              <label>
                Heslo místnosti <span>volitelné</span>
                <input id="fwTalkNewRoomPassword" type="password" maxlength="64" placeholder="Prázdné = bez hesla">
              </label>
              <button id="fwTalkCreateRoom" type="button">Vytvořit</button>
            </div>
            <p class="ops-radio-hint">Používej neutrální názvy. Nevytvářej místnosti, které působí jako oficiální kanály IZS.</p>
          </details>

          <div class="ops-radio-users">
            <div class="ops-radio-users-head">
              <h3>Připojeni v místnosti</h3>
              <button id="fwTalkDeleteRoom" class="ops-radio-danger" type="button" hidden>Odstranit místnost</button>
            </div>
            <ul data-radio-users>
              <li>Zatím nikdo</li>
            </ul>
          </div>

          <div class="ops-radio-history">
            <div class="ops-radio-history-head">
              <h3>Poslední hlasové zprávy</h3>
              <span>vždy jen poslední od každého uživatele</span>
            </div>
            <ul data-radio-history>
              <li>Zatím žádná zpráva</li>
            </ul>
            <p class="ops-radio-hint">Zprávy jsou pouze dočasně v paměti serveru, neukládají se do databáze.</p>
          </div>
        </div>
      </div>
    `;

    mount.querySelector("#opsRadioConnect")?.addEventListener("click", toggleConnection);
    mount.querySelector("#opsRadioRoomLive")?.addEventListener("change", changeRoom);
    mount.querySelector("#fwTalkCreateRoom")?.addEventListener("click", createRoom);
    mount.querySelector("#fwTalkDeleteRoom")?.addEventListener("click", deleteCurrentRoom);
    setupPttButton();
    refreshRoomSelect();
  }

  function setupPttButton() {
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (!ptt) return;

    const down = (event) => {
      event.preventDefault();
      requestPtt();
    };

    const up = (event) => {
      event.preventDefault();
      releasePtt();
    };

    ptt.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    ptt.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  async function ensureMic() {
    await unlockAudio();

    if (localStream) return true;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      return true;
    } catch (error) {
      console.warn("[FW TALK] mic error", error);
      setStatus("Mikrofon není povolený", "error");
      return false;
    }
  }

  async function toggleConnection() {
    const connected = authenticated && ws && ws.readyState === WebSocket.OPEN;
    if (connected) {
      manualCloseRequested = true;
      closeRadio();
      return;
    }

    manualCloseRequested = false;
    await connectRadio();
  }

  async function connectRadio() {
    if (!visible) return;

    await unlockAudio();

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    try {
      ws = new WebSocket(wsUrl());
      ws.binaryType = "arraybuffer";
      setStatus("Připojuji…", "connecting");

      ws.addEventListener("open", async () => {
        authenticated = false;
        await ensureMic();
      });

      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") handleControlMessage(event.data);
        else handleAudioPacket(event.data);
      });

      ws.addEventListener("close", () => {
        authenticated = false;
        stopTransmit();
        stopKeepAlive();
        setConnectButton(false);
        const select = mount?.querySelector("#opsRadioRoomLive");
        const ptt = mount?.querySelector("#opsRadioPtt");
        if (select) select.disabled = true;
        if (ptt) ptt.disabled = true;

        if (manualCloseRequested || !visible) {
          setStatus("Odpojeno", "idle");
          return;
        }

        setStatus("Spojení spadlo, obnovuji…", "connecting");
        scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        setStatus("Chyba spojení", "error");
      });
    } catch (error) {
      console.warn("[FW TALK] connect error", error);
      setStatus("Nejde připojit", "error");
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!manualCloseRequested && visible) connectRadio();
    }, RECONNECT_DELAY_MS);
  }

  function closeRadio() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopKeepAlive();
    releasePtt();
    stopTransmit();
    stopMic();

    try { ws?.close(1000, "manual close"); } catch {}
    ws = null;
    authenticated = false;
    setConnectButton(false);
    setStatus("Odpojeno", "idle");
    setTx("Nikdo");
    updateVoiceMessages([]);

    const select = mount?.querySelector("#opsRadioRoomLive");
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (select) select.disabled = true;
    if (ptt) ptt.disabled = true;
  }

  function stopMic() {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    localStream = null;
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    }, KEEPALIVE_MS);
  }

  function stopKeepAlive() {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  function handleControlMessage(raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "ping") {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }

    if (data.type === "pong") return;

    if (data.type === "auth_ok") {
      authenticated = true;
      clientId = data.clientId;
      myName = data.name || myName;
      myRole = data.role || myRole;
      updateRooms(data.rooms || data.roomCounts || data.channels || []);
      updateVoiceMessages(data.voiceMessages || []);
      room = normalizeRoom(data.currentRoom || data.room || data.channel || room);
      if (!getRoomMeta(room) && rooms[0]) room = normalizeRoom(rooms[0].room);
      localStorage.setItem(STORAGE_ROOM, room);

      refreshRoomSelect();

      const select = mount?.querySelector("#opsRadioRoomLive");
      const ptt = mount?.querySelector("#opsRadioPtt");
      if (select) select.disabled = false;
      if (ptt) ptt.disabled = false;

      setConnectButton(true);
      setStatus(`Připojeno: ${roomLabel(room)}`, "ok");
      startKeepAlive();
      fallbackBeep(620, 45);
      return;
    }

    if (data.type === "auth_error") {
      setStatus(data.message || "Nemáš oprávnění", "error");
      manualCloseRequested = true;
      closeRadio();
      return;
    }

    if (data.type === "error" || data.type === "room_create_error") {
      setStatus(data.message || "Chyba", "error");
      return;
    }

    if (data.type === "room_password_required") {
      askRoomPasswordAndJoin(data.room, data.label);
      return;
    }

    if (data.type === "room_created") {
      setStatus(`Místnost vytvořena: ${data.label || data.room}`, "ok");
      const nameInput = mount?.querySelector("#fwTalkNewRoomName");
      const passInput = mount?.querySelector("#fwTalkNewRoomPassword");
      if (nameInput) nameInput.value = "";
      if (passInput) passInput.value = "";
      if (data.room) joinRoom(data.room, "");
      return;
    }

    if (data.type === "room_joined") {
      room = normalizeRoom(data.room || room);
      localStorage.setItem(STORAGE_ROOM, room);
      resetPlaybackClock();
      updateVoiceMessages([]);
      refreshRoomSelect();
      setStatus(`Připojeno: ${roomLabel(room)}`, "ok");
      return;
    }

    if (data.type === "room_deleted_current") {
      if (data.room) room = normalizeRoom(data.room);
      localStorage.setItem(STORAGE_ROOM, room);
      setStatus(data.message || "Místnost byla odstraněna", "error");
      refreshRoomSelect();
      return;
    }

    if (data.type === "radio_state") {
      updateRooms(data.rooms || data.roomCounts || data.channels || []);
      const current = normalizeRoom(data.currentRoom || room);
      if (current && current !== room && getRoomMeta(current)) {
        room = current;
        localStorage.setItem(STORAGE_ROOM, room);
      }
      refreshRoomSelect();
      updateVoiceMessages(data.voiceMessages || []);

      const isMe = data.txClientId && data.txClientId === clientId;
      setStatus(`Připojeno: ${roomLabel(room)}`, data.transmitting ? (isMe ? "tx" : "rx") : "ok");
      setTx(data.transmitting ? (data.txName || "Někdo") : "Nikdo");
      renderUsers(Array.isArray(data.clients) ? data.clients : []);
      return;
    }

    if (data.type === "voice_replay_start") {
      replayActive = true;
      resetPlaybackClock();
      setStatus(`Přehrávám: ${data.name || "zprávu"}`, "rx");
      return;
    }

    if (data.type === "voice_replay_end") {
      replayActive = false;
      setStatus(`Připojeno: ${roomLabel(room)}`, "ok");
      return;
    }

    if (data.type === "voice_replay_error") {
      replayActive = false;
      setStatus(data.message || "Zpráva nejde přehrát", "error");
      return;
    }

    if (data.type === "ptt_granted") {
      if (data.self) {
        pttActive = true;
        startTransmit();
        setStatus("Mluvíš", "tx");
      } else {
        setStatus(`Příjem: ${data.by || "někdo"}`, "rx");
        fallbackBeep(880, 30);
        resetPlaybackClock();
      }
      return;
    }

    if (data.type === "ptt_denied") {
      pttActive = false;
      stopTransmit();
      setStatus(data.message || "Místnost je obsazená", "error");
      mount?.querySelector("#opsRadioPtt")?.classList.remove("is-transmitting");
      return;
    }

    if (data.type === "ptt_released") {
      if (pttActive) {
        pttActive = false;
        stopTransmit();
      }
      setStatus(`Připojeno: ${roomLabel(room)}`, "ok");
      setTx("Nikdo");
      fallbackBeep(430, 30);
    }
  }

  function updateRooms(payload) {
    if (!Array.isArray(payload)) return;

    rooms = payload.map((item) => {
      if (typeof item === "string") {
        return { room: normalizeRoom(item), label: roomLabel(item), count: null, locked: false, hasPassword: false };
      }
      return {
        room: normalizeRoom(item.room || item.channel || item.label),
        label: item.label || roomLabel(item.room || item.channel),
        count: Number.isFinite(Number(item.count)) ? Number(item.count) : null,
        transmitting: Boolean(item.transmitting),
        txName: item.txName || null,
        hasPassword: Boolean(item.hasPassword),
        locked: Boolean(item.locked),
        isSystem: Boolean(item.isSystem),
        isCustom: Boolean(item.isCustom),
        adminOnly: Boolean(item.adminOnly),
        createdByName: item.createdByName || null,
        createdByMe: Boolean(item.createdByMe)
      };
    }).filter((item) => item.room);
  }

  function refreshRoomSelect() {
    const select = mount?.querySelector("#opsRadioRoomLive");
    if (!select) return;
    select.innerHTML = roomOptions();
    if (rooms.some((item) => normalizeRoom(item.room) === room)) select.value = room;
    else if (rooms[0]) {
      room = normalizeRoom(rooms[0].room);
      select.value = room;
    }
    updateDeleteButton();
  }

  function updateDeleteButton() {
    const btn = mount?.querySelector("#fwTalkDeleteRoom");
    if (!btn) return;
    const meta = getRoomMeta(room);
    const canDelete = meta?.isCustom && (meta.createdByMe || myRole === "admin");
    btn.hidden = !canDelete;
  }

  function renderUsers(users) {
    const ul = mount?.querySelector("[data-radio-users]");
    if (!ul) return;

    if (!users.length) {
      ul.innerHTML = "<li>Zatím nikdo</li>";
      return;
    }

    ul.innerHTML = users
      .map((user) => `<li>${escapeHtml(user.name)} <span class="ops-radio-role">${escapeHtml(user.role || "")}</span>${user.transmitting ? " <strong>mluví</strong>" : ""}</li>`)
      .join("");
  }

  function updateVoiceMessages(payload) {
    if (!Array.isArray(payload)) return;

    voiceMessages = payload.map((item) => ({
      id: String(item.id || ""),
      userId: String(item.userId || ""),
      name: item.name || "Uživatel",
      role: item.role || "",
      room: normalizeRoom(item.room || room),
      durationMs: Math.max(0, Number(item.durationMs || 0)),
      bytes: Math.max(0, Number(item.bytes || 0)),
      endedAt: Number(item.endedAt || 0),
      timeLabel: item.timeLabel || ""
    })).filter((item) => item.userId);

    renderVoiceMessages();
  }

  function formatDuration(ms) {
    const seconds = Math.max(1, Math.round(Number(ms || 0) / 1000));
    return `${seconds} s`;
  }

  function renderVoiceMessages() {
    const ul = mount?.querySelector("[data-radio-history]");
    if (!ul) return;

    if (!voiceMessages.length) {
      ul.innerHTML = "<li>Zatím žádná zpráva</li>";
      return;
    }

    ul.innerHTML = voiceMessages
      .map((msg) => `
        <li class="ops-radio-history-item">
          <div>
            <strong>${escapeHtml(msg.name)}</strong>
            <span>${escapeHtml(msg.timeLabel || "")}${msg.timeLabel ? " • " : ""}${escapeHtml(formatDuration(msg.durationMs))}</span>
          </div>
          <button type="button" data-replay-user="${escapeHtml(msg.userId)}">▶ Přehrát</button>
        </li>
      `)
      .join("");

    ul.querySelectorAll("[data-replay-user]").forEach((button) => {
      button.addEventListener("click", () => replayVoiceMessage(button.getAttribute("data-replay-user")));
    });
  }

  function replayVoiceMessage(userId) {
    if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("Nejdřív připoj Talk", "error");
      return;
    }

    if (!userId) return;
    replayActive = true;
    resetPlaybackClock();
    ws.send(JSON.stringify({ type: "replay_voice_message", room, userId }));
  }

  function changeRoom(event) {
    const nextRoom = normalizeRoom(event.target.value || DEFAULT_ROOM);
    const meta = getRoomMeta(nextRoom);
    if (!meta) return;

    if (meta.locked) {
      askRoomPasswordAndJoin(nextRoom, meta.label || nextRoom);
      event.target.value = room;
      return;
    }

    joinRoom(nextRoom, "");
  }

  function askRoomPasswordAndJoin(targetRoom, label) {
    const password = window.prompt(`Místnost „${label || targetRoom}“ je chráněná heslem. Zadej heslo:`);
    if (password === null) {
      refreshRoomSelect();
      return;
    }
    joinRoom(targetRoom, password);
  }

  function joinRoom(targetRoom, password = "") {
    const nextRoom = normalizeRoom(targetRoom);
    resetPlaybackClock();

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join_room", room: nextRoom, password }));
      setStatus(`Přepínám na ${roomLabel(nextRoom)}…`, "connecting");
    }
  }

  function createRoom() {
    if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("Nejdřív připoj Talk", "error");
      return;
    }

    const name = cleanLabel(mount?.querySelector("#fwTalkNewRoomName")?.value || "");
    const password = String(mount?.querySelector("#fwTalkNewRoomPassword")?.value || "");

    if (name.length < 2) {
      setStatus("Zadej název místnosti", "error");
      return;
    }

    ws.send(JSON.stringify({ type: "create_room", name, password }));
    setStatus("Vytvářím místnost…", "connecting");
  }

  function deleteCurrentRoom() {
    const meta = getRoomMeta(room);
    if (!meta?.isCustom) return;

    const ok = window.confirm(`Opravdu odstranit místnost „${meta.label || room}“? Připojení uživatelé budou přesunuti do hlavní místnosti.`);
    if (!ok) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "delete_room", room }));
    }
  }

  function requestPtt() {
    if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) return;

    const ptt = mount?.querySelector("#opsRadioPtt");
    if (ptt) ptt.classList.add("is-transmitting");

    playPttSound();
    ws.send(JSON.stringify({ type: "ptt_request", room }));
  }

  function releasePtt() {
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (ptt) ptt.classList.remove("is-transmitting");

    if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ type: "ptt_release", room }));
    pttActive = false;
    stopTransmit();
  }

  function startTransmit() {
    if (!localStream || !audioContext || processor) return;

    try {
      packetSeq = 0;
      micSource = audioContext.createMediaStreamSource(localStream);
      processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      zeroGain = audioContext.createGain();
      zeroGain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (!pttActive || !ws || ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleToInt16(input, audioContext.sampleRate, TARGET_SAMPLE_RATE);
        if (downsampled.length > 0) {
          ws.send(makeAudioPacket(downsampled, TARGET_SAMPLE_RATE));
        }
      };

      micSource.connect(processor);
      processor.connect(zeroGain);
      zeroGain.connect(audioContext.destination);
    } catch (error) {
      console.warn("[FW TALK] start transmit error", error);
      setStatus("Mikrofon nejde spustit", "error");
    }
  }

  function stopTransmit() {
    try { if (processor) processor.onaudioprocess = null; } catch {}
    try { micSource?.disconnect(); } catch {}
    try { processor?.disconnect(); } catch {}
    try { zeroGain?.disconnect(); } catch {}
    micSource = null;
    processor = null;
    zeroGain = null;
  }

  function downsampleToInt16(input, inputRate, outputRate) {
    if (!input || !input.length) return new Int16Array(0);

    if (!inputRate || inputRate === outputRate) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) out[i] = floatToInt16(input[i]);
      return out;
    }

    const ratio = inputRate / outputRate;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    const out = new Int16Array(outLength);

    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += input[j];
        count++;
      }
      out[i] = floatToInt16(count ? sum / count : input[start] || 0);
    }

    return out;
  }

  function floatToInt16(value) {
    const clamped = Math.max(-1, Math.min(1, value || 0));
    return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  function makeAudioPacket(samples, sampleRate) {
    const bytes = new Uint8Array(PACKET_HEADER_SIZE + samples.byteLength);
    bytes[0] = MAGIC[0];
    bytes[1] = MAGIC[1];
    bytes[2] = MAGIC[2];
    bytes[3] = MAGIC[3];

    const view = new DataView(bytes.buffer);
    view.setUint16(4, sampleRate, true);
    view.setUint16(6, samples.length, true);
    view.setUint32(8, packetSeq++, true);
    bytes.set(new Uint8Array(samples.buffer), PACKET_HEADER_SIZE);
    return bytes.buffer;
  }

  function resetPlaybackClock() {
    if (!audioContext) return;
    nextPlaybackTime = audioContext.currentTime + 0.05;
  }

  async function handleAudioPacket(data) {
    const ctx = await unlockAudio();
    if (!ctx) return;

    const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer?.();
    if (!buffer || buffer.byteLength <= PACKET_HEADER_SIZE) return;

    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) return;

    const view = new DataView(buffer);
    const sampleRate = view.getUint16(4, true) || TARGET_SAMPLE_RATE;
    const sampleCount = view.getUint16(6, true);
    if (!sampleCount) return;

    const pcm = new Int16Array(buffer, PACKET_HEADER_SIZE, sampleCount);
    const audioBuffer = ctx.createBuffer(1, sampleCount, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = Math.max(-1, Math.min(1, pcm[i] / 32768));
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.02, nextPlaybackTime || ctx.currentTime + 0.02);
    source.start(startAt);
    nextPlaybackTime = startAt + audioBuffer.duration;
  }

  function init() {
    mount = document.getElementById("opsRadioMount");
    if (!mount) return;

    render();

    window.firewatchOpsRadioSetVisible = function (nextVisible) {
      visible = Boolean(nextVisible);
      mount.style.display = visible ? "" : "none";
      if (!visible) {
        manualCloseRequested = true;
        closeRadio();
      }
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
