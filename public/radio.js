// FireWatch Talk v0.6
// Soukromý týmový hlasový chat FireWatchCZ.
// Přenos hlasu: server-relay PCM přes WebSocket.
// Vlastní zvuk PTT: nahraj soubor do /public/sounds/ptt-press.mp3.

(function () {
  const STORAGE_ROOM = "firewatch_talk_room_v2";
  const TARGET_SAMPLE_RATE = 16000;
  const PROCESSOR_BUFFER_SIZE = 2048;
  const PACKET_HEADER_SIZE = 12;
  const MAGIC = [0x46, 0x57, 0x52, 0x35]; // FWR5
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
  let rooms = ["HLAVNÍ", "SPRÁVA", "TEST"];
  let roomCounts = [];
  let myName = "Uživatel";
  let packetSeq = 0;
  let nextPlaybackTime = 0;
  let manualCloseRequested = false;
  let reconnectTimer = null;
  let keepAliveTimer = null;
  let pttSoundReady = false;
  let pttSoundFailed = false;

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

  function normalizeRoom(value) {
    const raw = String(value || DEFAULT_ROOM).trim().toUpperCase();
    if (["OPS", "JEDNOTKA", "VELITEL", "TECHNICKY"].includes(raw)) return DEFAULT_ROOM;
    if (["ADMIN", "SPRAVA", "SPRÁVA"].includes(raw)) return "SPRÁVA";
    if (raw === "TEST") return "TEST";
    if (raw === "HLAVNI" || raw === "HLAVNÍ") return DEFAULT_ROOM;
    return raw || DEFAULT_ROOM;
  }

  function roomLabel(value) {
    const normalized = normalizeRoom(value);
    if (normalized === "HLAVNÍ") return "Hlavní";
    if (normalized === "SPRÁVA") return "Správa";
    if (normalized === "TEST") return "Test";
    return normalized;
  }

  function roomCount(value) {
    const normalized = normalizeRoom(value);
    return roomCounts.find((item) => item.room === normalized)?.count ?? null;
  }

  function roomOptions() {
    return rooms
      .map((item) => normalizeRoom(item))
      .filter(Boolean)
      .map((item) => {
        const count = roomCount(item);
        const label = count === null ? roomLabel(item) : `${roomLabel(item)} (${count})`;
        return `<option value="${escapeHtml(item)}" ${item === room ? "selected" : ""}>${escapeHtml(label)}</option>`;
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
        audioContext = new AudioContextClass({ latencyHint: "interactive" });
      }

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      return audioContext;
    } catch {
      return null;
    }
  }

  function preloadPttSound() {
    if (pttSoundReady || pttSoundFailed) return;

    const audio = new Audio(PTT_SOUND_URL);
    audio.preload = "auto";
    audio.volume = PTT_SOUND_VOLUME;
    audio.addEventListener("canplaythrough", () => { pttSoundReady = true; }, { once: true });
    audio.addEventListener("error", () => { pttSoundFailed = true; }, { once: true });

    // Většina mobilů zvuk stejně dovolí až po dotyku, ale preload nevadí.
    try { audio.load(); } catch {}
  }

  async function playPttPressSound() {
    // Požadavek: vlastní MP3 při stisknutí PTT.
    // Soubor: public/sounds/ptt-press.mp3 -> URL /sounds/ptt-press.mp3
    try {
      const audio = new Audio(PTT_SOUND_URL);
      audio.volume = PTT_SOUND_VOLUME;
      audio.currentTime = 0;
      await audio.play();
      return true;
    } catch {
      pttSoundFailed = true;
      return false;
    }
  }

  async function fallbackBeep(freq = 880, duration = 55) {
    if (window.__fwczRadioNoBeep) return;
    try {
      const ctx = await unlockAudio();
      if (!ctx) return;

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.frequency.value = freq;
      oscillator.type = "sine";
      gain.gain.value = 0.016;

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + duration / 1000);
    } catch {
      // nepovinné
    }
  }

  async function pttCue() {
    const ok = await playPttPressSound();
    if (!ok) await fallbackBeep(760, 45);
  }

  function setStatus(text, state = "idle") {
    const el = mount?.querySelector("[data-radio-status]");
    if (!el) return;
    el.textContent = text;
    el.dataset.state = state;
  }

  function setTx(text) {
    const el = mount?.querySelector("[data-radio-tx]");
    if (!el) return;
    el.textContent = text || "Nikdo";
  }

  function setHiddenByRole(isHidden) {
    if (!mount) return;
    mount.style.display = isHidden ? "none" : "";
  }

  function render() {
    if (!mount) return;

    mount.innerHTML = `
      <div class="ops-radio-card">
        <div class="ops-radio-head">
          <div>
            <h2>FireWatch Talk</h2>
            <p>Soukromý hlasový chat FireWatchCZ pro testování a týmovou komunikaci.</p>
            <p class="ops-radio-disclaimer">Není určen pro komunikaci složek IZS ani pro řízení zásahů.</p>
          </div>
          <div class="ops-radio-live" data-radio-status data-state="idle">Nepřipojeno</div>
        </div>

        <div class="ops-radio-panel">
          <div class="ops-radio-row">
            <label>
              Místnost
              <select id="opsRadioRoomLive">${roomOptions()}</select>
            </label>
            <div class="ops-radio-tx">
              <span>Právě mluví</span>
              <strong data-radio-tx>Nikdo</strong>
            </div>
            <button class="ops-radio-connect" id="opsRadioConnect">Připojit</button>
          </div>

          <button class="ops-radio-ptt" id="opsRadioPtt" disabled>
            DRŽ PRO MLUVENÍ
          </button>

          <div class="ops-radio-users">
            <h3>Připojeni v místnosti</h3>
            <ul data-radio-users>
              <li>Zatím nikdo</li>
            </ul>
          </div>
        </div>
      </div>
    `;

    mount.querySelector("#opsRadioConnect")?.addEventListener("click", toggleRadioConnection);
    mount.querySelector("#opsRadioRoomLive")?.addEventListener("change", changeRoom);
    setupPttButton();
    preloadPttSound();
  }

  function setupPttButton() {
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (!ptt) return;

    const down = async (event) => {
      event.preventDefault();
      await unlockAudio();
      await pttCue();
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

  async function checkOpsAccess() {
    try {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      const role = String(data?.user?.role || "public");
      myName = data?.user?.username || "Uživatel";
      return role === "ops" || role === "admin";
    } catch {
      return false;
    }
  }

  async function setVisibleByAuth(forceValue) {
    if (!mount) return;

    const allowed = typeof forceValue === "boolean" ? forceValue : await checkOpsAccess();
    visible = allowed;
    setHiddenByRole(!allowed);

    if (!allowed) {
      manualCloseRequested = true;
      closeRadio();
      return;
    }

    if (!mount.innerHTML.trim()) render();
  }

  async function prepareLocalAudio() {
    if (localStream) return true;

    try {
      await unlockAudio();
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });
      return true;
    } catch (error) {
      console.warn("[FW TALK] microphone error", error);
      setStatus("Mikrofon není povolený", "error");
      return false;
    }
  }

  function toggleRadioConnection() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      manualCloseRequested = true;
      closeRadio();
      setStatus("Ruční odpojení", "idle");
      return;
    }

    connectRadio(false);
  }

  async function connectRadio(isReconnect = false) {
    if (!visible) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    clearReconnectTimer();
    manualCloseRequested = false;

    await unlockAudio();

    const micOk = await prepareLocalAudio();
    if (!micOk) return;

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    setStatus(isReconnect ? "Obnovuji spojení…" : "Připojuji…", "connecting");

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        handleControlMessage(event.data);
      } else {
        handleAudioPacket(event.data);
      }
    });

    ws.addEventListener("close", () => {
      authenticated = false;
      pttActive = false;
      clientId = null;
      stopTransmit();
      stopKeepAlive();
      setConnectButton(false);

      const ptt = mount?.querySelector("#opsRadioPtt");
      if (ptt) ptt.disabled = true;

      if (manualCloseRequested || !visible) {
        setStatus("Nepřipojeno", "idle");
        return;
      }

      setStatus("Spojení spadlo, obnovuji…", "connecting");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (!manualCloseRequested) setStatus("Chyba spojení", "error");
    });
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectRadio(true);
    }, RECONNECT_DELAY_MS);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = window.setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }, KEEPALIVE_MS);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) window.clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  function closeRadio() {
    clearReconnectTimer();
    stopKeepAlive();
    try { ws?.close(); } catch {}
    ws = null;
    authenticated = false;
    pttActive = false;
    clientId = null;
    stopTransmit();
    stopLocalAudio();
    setConnectButton(false);
    setTx("Nikdo");
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (ptt) ptt.disabled = true;
  }

  function stopLocalAudio() {
    stopTransmit();
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    localStream = null;
  }

  function setConnectButton(connected) {
    const btn = mount?.querySelector("#opsRadioConnect");
    if (!btn) return;
    btn.textContent = connected ? "Odpojit" : "Připojit";
  }

  function handleControlMessage(raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "ping") {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }

    if (data.type === "pong") return;

    if (data.type === "auth_ok") {
      authenticated = true;
      clientId = data.clientId;
      myName = data.name || myName;
      if (Array.isArray(data.rooms)) rooms = data.rooms.map(normalizeRoom);
      else if (Array.isArray(data.channels)) rooms = data.channels.map(normalizeRoom);
      if (Array.isArray(data.roomCounts)) roomCounts = data.roomCounts;

      room = normalizeRoom(data.room || data.channel || room);
      if (!rooms.includes(room)) room = rooms[0] || DEFAULT_ROOM;
      localStorage.setItem(STORAGE_ROOM, room);

      refreshRoomSelect();

      const ptt = mount?.querySelector("#opsRadioPtt");
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

    if (data.type === "error") {
      setStatus(data.message || "Chyba", "error");
      refreshRoomSelect();
      return;
    }

    if (data.type === "radio_state") {
      if (Array.isArray(data.rooms)) rooms = data.rooms.map(normalizeRoom);
      else if (Array.isArray(data.channels)) rooms = data.channels.map(normalizeRoom);
      if (Array.isArray(data.roomCounts)) roomCounts = data.roomCounts;
      refreshRoomSelect();

      const stateRoom = normalizeRoom(data.room || data.channel);
      if (stateRoom === room) {
        const isMe = data.txClientId && data.txClientId === clientId;
        setStatus(`Připojeno: ${roomLabel(room)}`, data.transmitting ? (isMe ? "tx" : "rx") : "ok");
        setTx(data.transmitting ? (data.txName || "Někdo") : "Nikdo");
        renderUsers(Array.isArray(data.clients) ? data.clients : []);
      }
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

  function refreshRoomSelect() {
    const select = mount?.querySelector("#opsRadioRoomLive");
    if (!select) return;
    const oldValue = select.value;
    select.innerHTML = roomOptions();
    select.value = rooms.includes(room) ? room : (rooms[0] || DEFAULT_ROOM);
    if (select.value !== oldValue && oldValue === room) select.value = room;
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

  function changeRoom(event) {
    room = normalizeRoom(event.target.value || DEFAULT_ROOM);
    localStorage.setItem(STORAGE_ROOM, room);
    resetPlaybackClock();

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join_room", room }));
      setStatus(`Přepínám na ${roomLabel(room)}…`, "connecting");
    }
  }

  function requestPtt() {
    if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) return;

    const ptt = mount?.querySelector("#opsRadioPtt");
    if (ptt) ptt.classList.add("is-transmitting");

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
      const src = i * ratio;
      const left = Math.floor(src);
      const right = Math.min(left + 1, input.length - 1);
      const weight = src - left;
      const sample = input[left] * (1 - weight) + input[right] * weight;
      out[i] = floatToInt16(sample);
    }

    return out;
  }

  function floatToInt16(sample) {
    const s = Math.max(-1, Math.min(1, sample || 0));
    return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }

  function makeAudioPacket(samples, sampleRate) {
    const packet = new ArrayBuffer(PACKET_HEADER_SIZE + samples.byteLength);
    const bytes = new Uint8Array(packet);
    bytes[0] = MAGIC[0];
    bytes[1] = MAGIC[1];
    bytes[2] = MAGIC[2];
    bytes[3] = MAGIC[3];

    const view = new DataView(packet);
    view.setUint16(4, sampleRate, true);
    view.setUint16(6, 1, true);
    view.setUint32(8, packetSeq++, true);
    bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), PACKET_HEADER_SIZE);
    return packet;
  }

  async function handleAudioPacket(packet) {
    if (!packet || packet.byteLength <= PACKET_HEADER_SIZE) return;

    const ctx = await unlockAudio();
    if (!ctx) return;

    const bytes = new Uint8Array(packet);
    if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2] || bytes[3] !== MAGIC[3]) {
      return;
    }

    const view = new DataView(packet);
    const sampleRate = view.getUint16(4, true) || TARGET_SAMPLE_RATE;
    const payloadBytes = packet.byteLength - PACKET_HEADER_SIZE;
    if (payloadBytes < 2) return;

    const samples = new Int16Array(packet, PACKET_HEADER_SIZE, Math.floor(payloadBytes / 2));
    const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
    const channelData = audioBuffer.getChannelData(0);

    for (let i = 0; i < samples.length; i++) {
      channelData[i] = samples[i] / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (!nextPlaybackTime || nextPlaybackTime < now || nextPlaybackTime > now + 0.8) {
      nextPlaybackTime = now + 0.045;
    }

    source.start(nextPlaybackTime);
    nextPlaybackTime += audioBuffer.duration;
  }

  function resetPlaybackClock() {
    nextPlaybackTime = 0;
  }

  window.firewatchOpsRadioSetVisible = async function firewatchOpsRadioSetVisible(isOpsAllowed) {
    await setVisibleByAuth(Boolean(isOpsAllowed));
  };

  document.addEventListener("visibilitychange", () => {
    // Neodpojovat při přepnutí aplikace/záložky. Jen uvolnit PTT, pokud právě drží.
    if (document.hidden && pttActive) releasePtt();
  });

  document.addEventListener("DOMContentLoaded", async () => {
    mount = document.getElementById("opsRadioMount");
    if (!mount) return;
    mount.style.display = "none";
    render();
    await setVisibleByAuth();
  });
})();
