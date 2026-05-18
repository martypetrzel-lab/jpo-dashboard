// FireWatchCZ OPS Radio v0.3
// Frontend pro OPS/admin režim.
// Přenos hlasu: WebSocket + nativní PCM Int16 mono s hlavičkou vzorkovací frekvence.
// Oprava proti chrčení: neposíláme přepočítané 16 kHz chunky, ale nativní sample-rate zařízení.

(function () {
  const STORAGE_CHANNEL = "firewatchcz_radio_channel_v1";
  const PLAYBACK_BUFFER_SEC = 0.18;
  const CAPTURE_BUFFER_SIZE = 4096;
  const PACKET_HEADER_BYTES = 12;
  const MAGIC_0 = 0x46; // F
  const MAGIC_1 = 0x57; // W
  const MAGIC_2 = 0x52; // R
  const MAGIC_3 = 0x33; // 3

  let mount = null;
  let ws = null;
  let micStream = null;
  let captureContext = null;
  let captureSource = null;
  let captureProcessor = null;
  let captureSilentGain = null;
  let playbackContext = null;
  let playbackTime = 0;
  let authenticated = false;
  let pttActive = false;
  let visible = false;
  let channel = localStorage.getItem(STORAGE_CHANNEL) || "OPS";
  let channels = ["OPS", "JEDNOTKA", "VELITEL", "TECHNICKY", "TEST"];
  let myName = "OPS";

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
    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) return null;

    if (!playbackContext || playbackContext.state === "closed") {
      playbackContext = new AudioContextClass({ latencyHint: "interactive" });
      playbackTime = playbackContext.currentTime;
    }

    if (playbackContext.state === "suspended") {
      try { await playbackContext.resume(); } catch {}
    }

    return playbackContext;
  }

  async function beep(freq = 880, duration = 70) {
    if (window.__fwczRadioNoBeep) return;
    try {
      const ctx = await unlockAudio();
      if (!ctx) return;

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.frequency.value = freq;
      oscillator.type = "sine";
      gain.gain.value = 0.025;

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
              Kanál
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
      closeRadio();
      return;
    }

    if (!mount.innerHTML.trim()) render();
  }

  async function connectRadio() {
    if (!visible) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      closeRadio();
      return;
    }

    await unlockAudio();

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    setStatus("Připojuji…", "connecting");

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        handleControlMessage(event.data);
      } else {
        handleAudioChunk(event.data);
      }
    });

    ws.addEventListener("close", () => {
      authenticated = false;
      pttActive = false;
      stopRecording();
      setStatus("Odpojeno", "error");
      setConnectButton(false);
      const ptt = mount?.querySelector("#opsRadioPtt");
      if (ptt) ptt.disabled = true;
    });

    ws.addEventListener("error", () => {
      setStatus("Chyba spojení", "error");
    });
  }

  function closeRadio() {
    try { ws?.close(); } catch {}
    ws = null;
    authenticated = false;
    pttActive = false;
    stopRecording();
    setConnectButton(false);
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

      setConnectButton(true);
      setStatus(`Připojeno: ${channel}`, "ok");
      beep(660, 70);
      return;
    }

    if (data.type === "auth_error") {
      setStatus(data.message || "Nemáš OPS oprávnění", "error");
      closeRadio();
      return;
    }

    if (data.type === "error") {
      setStatus(data.message || "Chyba rádia", "error");
      return;
    }

    if (data.type === "radio_state") {
      if (data.channel === channel) {
        const isMe = data.txName && data.txName === myName;
        setStatus(`Připojeno: ${channel}`, data.transmitting ? (isMe ? "tx" : "rx") : "ok");
        setTx(data.transmitting ? (data.txName || "Někdo") : "Nikdo");
        renderUsers(data.clients || []);
      }
      return;
    }

    if (data.type === "ptt_granted") {
      if (data.self) {
        pttActive = true;
        setStatus("Vysíláš", "tx");
        startRecording();
      } else {
        setStatus(`Příjem: ${data.by || "někdo"}`, "rx");
        beep(880, 45);
      }
      return;
    }

    if (data.type === "ptt_denied") {
      pttActive = false;
      setStatus(data.message || "Kanál je obsazený", "error");
      mount?.querySelector("#opsRadioPtt")?.classList.remove("is-transmitting");
      stopRecording();
      return;
    }

    if (data.type === "ptt_released") {
      if (pttActive) {
        pttActive = false;
        stopRecording();
      }
      setStatus(`Připojeno: ${channel}`, "ok");
      setTx("Nikdo");
      beep(440, 45);
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

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join_channel", channel }));
      setStatus(`Přepínám na ${channel}…`, "connecting");
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
    stopRecording();
  }

  async function startRecording() {
    if (!pttActive || captureContext || captureProcessor) return;

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });

      const AudioContextClass = getAudioContextClass();
      if (!AudioContextClass) throw new Error("AudioContext není dostupný.");

      captureContext = new AudioContextClass({ latencyHint: "interactive" });
      captureSource = captureContext.createMediaStreamSource(micStream);
      captureProcessor = captureContext.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
      captureSilentGain = captureContext.createGain();
      captureSilentGain.gain.value = 0;

      captureProcessor.onaudioprocess = (event) => {
        if (!pttActive || !ws || ws.readyState !== WebSocket.OPEN || !captureContext) return;

        const input = event.inputBuffer.getChannelData(0);
        const packet = createPcmPacket(input, captureContext.sampleRate);
        if (packet && packet.byteLength > PACKET_HEADER_BYTES) {
          ws.send(packet);
        }
      };

      captureSource.connect(captureProcessor);
      captureProcessor.connect(captureSilentGain);
      captureSilentGain.connect(captureContext.destination);

      if (captureContext.state === "suspended") {
        try { await captureContext.resume(); } catch {}
      }
    } catch (error) {
      console.warn("[OPS RADIO] microphone error", error);
      setStatus("Mikrofon není povolený", "error");
      releasePtt();
    }
  }

  function stopRecording() {
    try { if (captureProcessor) captureProcessor.disconnect(); } catch {}
    try { if (captureSource) captureSource.disconnect(); } catch {}
    try { if (captureSilentGain) captureSilentGain.disconnect(); } catch {}
    try { if (captureContext && captureContext.state !== "closed") captureContext.close(); } catch {}

    captureProcessor = null;
    captureSource = null;
    captureSilentGain = null;
    captureContext = null;

    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
    }
    micStream = null;
  }

  function createPcmPacket(floatSamples, sampleRate) {
    if (!floatSamples || !floatSamples.length) return null;

    const sampleCount = floatSamples.length;
    const buffer = new ArrayBuffer(PACKET_HEADER_BYTES + sampleCount * 2);
    const view = new DataView(buffer);

    view.setUint8(0, MAGIC_0);
    view.setUint8(1, MAGIC_1);
    view.setUint8(2, MAGIC_2);
    view.setUint8(3, MAGIC_3);
    view.setUint32(4, Math.round(sampleRate || 48000), true);
    view.setUint16(8, 1, true);
    view.setUint16(10, sampleCount, true);

    let offset = PACKET_HEADER_BYTES;
    for (let i = 0; i < sampleCount; i++) {
      // Lehké omezení zisku, aby mobilní mikrofony nelezly do tvrdé saturace.
      let sample = floatSamples[i] * 0.85;
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;

      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }

    return buffer;
  }

  function decodePcmPacket(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 2) return null;

    const view = new DataView(arrayBuffer);
    let sampleRate = 16000;
    let payloadOffset = 0;
    let sampleCount = Math.floor(arrayBuffer.byteLength / 2);

    const hasHeader = arrayBuffer.byteLength >= PACKET_HEADER_BYTES &&
      view.getUint8(0) === MAGIC_0 &&
      view.getUint8(1) === MAGIC_1 &&
      view.getUint8(2) === MAGIC_2 &&
      view.getUint8(3) === MAGIC_3;

    if (hasHeader) {
      sampleRate = view.getUint32(4, true) || 48000;
      payloadOffset = PACKET_HEADER_BYTES;
      sampleCount = view.getUint16(10, true) || Math.floor((arrayBuffer.byteLength - payloadOffset) / 2);
    }

    const maxSamples = Math.floor((arrayBuffer.byteLength - payloadOffset) / 2);
    sampleCount = Math.min(sampleCount, maxSamples);

    return { view, sampleRate, payloadOffset, sampleCount };
  }

  async function handleAudioChunk(data) {
    try {
      const ctx = await unlockAudio();
      if (!ctx) return;

      const arrayBuffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
      const decoded = decodePcmPacket(arrayBuffer);
      if (!decoded || decoded.sampleCount <= 0) return;

      const audioBuffer = ctx.createBuffer(1, decoded.sampleCount, decoded.sampleRate);
      const channelData = audioBuffer.getChannelData(0);

      let offset = decoded.payloadOffset;
      for (let i = 0; i < decoded.sampleCount; i++) {
        channelData[i] = decoded.view.getInt16(offset, true) / 32768;
        offset += 2;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      if (!playbackTime || playbackTime < now + 0.03 || playbackTime > now + 1.0) {
        playbackTime = now + PLAYBACK_BUFFER_SEC;
      }

      source.start(playbackTime);
      playbackTime += audioBuffer.duration;
    } catch (error) {
      console.warn("[OPS RADIO] playback error", error);
    }
  }

  window.firewatchOpsRadioSetVisible = async function firewatchOpsRadioSetVisible(isOpsAllowed) {
    await setVisibleByAuth(Boolean(isOpsAllowed));
  };

  document.addEventListener("DOMContentLoaded", async () => {
    mount = document.getElementById("opsRadioMount");
    if (!mount) return;
    mount.style.display = "none";
    render();
    await setVisibleByAuth();
  });
})();
