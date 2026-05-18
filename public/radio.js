// FireWatchCZ OPS Radio v0.6
// Frontend pro OPS/admin režim.
// Přenos hlasu: server-relay PCM přes WebSocket.
// Cíl: stabilní mobil ↔ PC příjem bez chrčení a bez závislosti na WebRTC/TURN.

(function () {
  const STORAGE_CHANNEL = "firewatchcz_radio_channel_v1";
  const TARGET_SAMPLE_RATE = 16000;
  const PROCESSOR_BUFFER_SIZE = 2048;
  const PACKET_HEADER_SIZE = 12;
  const MAGIC = [0x46, 0x57, 0x52, 0x35]; // FWR5

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
  let channel = localStorage.getItem(STORAGE_CHANNEL) || "OPS";
  let channels = ["OPS", "ADMIN", "TEST"];
  let myName = "OPS";
  let packetSeq = 0;
  let nextPlaybackTime = 0;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let wantConnected = false;
  let reconnectAttempt = 0;

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

  function channelOptions() {
    return channels
      .map((ch) => `<option value="${escapeHtml(ch)}" ${ch === channel ? "selected" : ""}>${escapeHtml(ch)}</option>`)
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

  async function beep(freq = 880, duration = 55) {
    if (window.__fwczRadioNoBeep) return;
    try {
      const ctx = await unlockAudio();
      if (!ctx) return;

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.frequency.value = freq;
      oscillator.type = "sine";
      gain.gain.value = 0.018;

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + duration / 1000);
    } catch {
      // nepovinné
    }
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
    if (!channels.includes(channel)) {
      channel = channels.includes("OPS") ? "OPS" : channels[0];
      localStorage.setItem(STORAGE_CHANNEL, channel);
    }

    mount.innerHTML = `
      <div class="ops-radio-card">
        <div class="ops-radio-head">
          <div>
            <h2>OPS Rádio</h2>
            <p>Interní internetová vysílačka FireWatchCZ. Dostupné pouze pro OPS/admin.</p>
          </div>
          <div class="ops-radio-live" data-radio-status data-state="idle">Nepřipojeno</div>
        </div>

        <div class="ops-radio-panel">
          <div class="ops-radio-row">
            <label>
              Místnost
              <select id="opsRadioChannelLive">${channelOptions()}</select>
            </label>
            <div class="ops-radio-tx">
              <span>Právě vysílá</span>
              <strong data-radio-tx>Nikdo</strong>
            </div>
          </div>

          <button class="ops-radio-connect" id="opsRadioConnect">Připojit rádio</button>

          <button class="ops-radio-ptt" id="opsRadioPtt" disabled>
            DRŽ PRO VYSÍLÁNÍ
          </button>

          <div class="ops-radio-users">
            <h3>Připojeni</h3>
            <ul data-radio-users>
              <li>Zatím nikdo</li>
            </ul>
          </div>
        </div>
      </div>
    `;

    mount.querySelector("#opsRadioConnect")?.addEventListener("click", connectRadio);
    mount.querySelector("#opsRadioChannelLive")?.addEventListener("change", changeChannel);
    setupPttButton();
  }

  function setupPttButton() {
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (!ptt) return;

    const down = async (event) => {
      event.preventDefault();
      await unlockAudio();
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
      myName = data?.user?.username || "OPS";
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
      // Neodpojujeme rádio automaticky při krátkém výpadku auth dotazu nebo skrytí OPS prvků.
      // Samotný server při novém spojení stále ověřuje roli ops/admin.
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
      console.warn("[OPS RADIO] microphone error", error);
      setStatus("Mikrofon není povolený", "error");
      return false;
    }
  }

  async function connectRadio() {
    if (!visible && !wantConnected) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      closeRadio({ manual: true });
      return;
    }

    wantConnected = true;
    clearReconnectTimer();

    await unlockAudio();

    const micOk = await prepareLocalAudio();
    if (!micOk) {
      wantConnected = false;
      return;
    }

    openSocket();
  }

  function openSocket() {
    if (!wantConnected) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    setStatus(reconnectAttempt > 0 ? "Obnovuji spojení…" : "Připojuji…", "connecting");

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
      stopHeartbeat();
      stopTransmit();
      const ptt = mount?.querySelector("#opsRadioPtt");
      if (ptt) ptt.disabled = true;

      if (wantConnected) {
        setStatus("Spojení spadlo, obnovuji…", "connecting");
        scheduleReconnect();
      } else {
        setStatus("Odpojeno", "error");
        setConnectButton(false);
      }
    });

    ws.addEventListener("error", () => {
      setStatus("Chyba spojení", "error");
    });
  }

  function closeRadio(options = {}) {
    const manual = Boolean(options.manual);
    if (manual) wantConnected = false;
    clearReconnectTimer();
    stopHeartbeat();
    try { ws?.close(); } catch {}
    ws = null;
    authenticated = false;
    pttActive = false;
    clientId = null;
    stopTransmit();
    stopLocalAudio();
    setConnectButton(false);
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (ptt) ptt.disabled = true;
  }

  function scheduleReconnect() {
    if (!wantConnected) return;
    clearReconnectTimer();
    reconnectAttempt += 1;
    const delay = Math.min(12000, 1200 + reconnectAttempt * 900);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch {}
      }
    }, 20000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
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
    btn.textContent = connected ? "Odpojit rádio" : "Připojit rádio";
  }

  function handleControlMessage(raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === "auth_ok") {
      authenticated = true;
      clientId = data.clientId;
      myName = data.name || myName;
      if (Array.isArray(data.channels)) channels = data.channels;
      channel = data.channel || channel;
      localStorage.setItem(STORAGE_CHANNEL, channel);

      const select = mount?.querySelector("#opsRadioChannelLive");
      if (select) {
        select.innerHTML = channelOptions();
        select.value = channel;
      }

      const ptt = mount?.querySelector("#opsRadioPtt");
      if (ptt) ptt.disabled = false;

      reconnectAttempt = 0;
      startHeartbeat();
      setConnectButton(true);
      setStatus(`Místnost: ${channel}`, "ok");
      beep(660, 55);
      return;
    }

    if (data.type === "auth_error") {
      setStatus(data.message || "Nemáš OPS oprávnění", "error");
      wantConnected = false;
      closeRadio({ manual: true });
      return;
    }

    if (data.type === "error") {
      setStatus(data.message || "Chyba rádia", "error");
      return;
    }

    if (data.type === "radio_state") {
      if (data.channel === channel) {
        const isMe = data.txClientId && data.txClientId === clientId;
        setStatus(`Místnost: ${channel}`, data.transmitting ? (isMe ? "tx" : "rx") : "ok");
        setTx(data.transmitting ? (data.txName || "Někdo") : "Nikdo");
        renderUsers(Array.isArray(data.clients) ? data.clients : []);
      }
      return;
    }

    if (data.type === "ptt_granted") {
      if (data.self) {
        pttActive = true;
        startTransmit();
        setStatus("Vysíláš", "tx");
      } else {
        setStatus(`Příjem: ${data.by || "někdo"}`, "rx");
        beep(880, 35);
        resetPlaybackClock();
      }
      return;
    }

    if (data.type === "ptt_denied") {
      pttActive = false;
      stopTransmit();
      setStatus(data.message || "Kanál je obsazený", "error");
      mount?.querySelector("#opsRadioPtt")?.classList.remove("is-transmitting");
      return;
    }

    if (data.type === "ptt_released") {
      if (pttActive) {
        pttActive = false;
        stopTransmit();
      }
      setStatus(`Místnost: ${channel}`, "ok");
      setTx("Nikdo");
      beep(440, 35);
    }
  }

  function renderUsers(users) {
    const ul = mount?.querySelector("[data-radio-users]");
    if (!ul) return;

    if (!users.length) {
      ul.innerHTML = "<li>Zatím nikdo</li>";
      return;
    }

    ul.innerHTML = users
      .map((user) => `<li>${escapeHtml(user.name)} <span class="ops-radio-role">${escapeHtml(user.role || "")}</span>${user.transmitting ? " <strong>vysílá</strong>" : ""}</li>`)
      .join("");
  }

  function changeChannel(event) {
    channel = event.target.value || "OPS";
    localStorage.setItem(STORAGE_CHANNEL, channel);
    resetPlaybackClock();

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join_channel", channel }));
      setStatus(`Přepínám místnost na ${channel}…`, "connecting");
    }
  }

  function requestPtt() {
    if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) return;

    const ptt = mount?.querySelector("#opsRadioPtt");
    if (ptt) ptt.classList.add("is-transmitting");

    ws.send(JSON.stringify({ type: "ptt_request", channel }));
  }

  function releasePtt() {
    const ptt = mount?.querySelector("#opsRadioPtt");
    if (ptt) ptt.classList.remove("is-transmitting");

    if (!authenticated || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ type: "ptt_release", channel }));
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
      console.warn("[OPS RADIO] start transmit error", error);
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
    if (document.visibilityState === "visible" && wantConnected) {
      unlockAudio();
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        scheduleReconnect();
      } else if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch {}
      }
    }
  });

  document.addEventListener("DOMContentLoaded", async () => {
    mount = document.getElementById("opsRadioMount");
    if (!mount) return;
    mount.style.display = "none";
    render();
    await setVisibleByAuth();
  });
})();
