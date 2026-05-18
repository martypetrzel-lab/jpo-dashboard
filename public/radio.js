// FireWatchCZ OPS Radio v0.2
// Frontend pro OPS/admin režim.
// Přenos hlasu: WebSocket + raw PCM 16 kHz mono Int16.
// Důvod: MediaRecorder/WebM chunky se na mobilech a mezi prohlížeči často nepřehrávají spolehlivě.

(function () {
  const STORAGE_CHANNEL = "firewatchcz_radio_channel_v1";
  const AUDIO_SAMPLE_RATE = 16000;
  const PLAYBACK_BUFFER_SEC = 0.08;

  let mount = null;
  let ws = null;
  let micStream = null;
  let captureContext = null;
  let captureSource = null;
  let captureProcessor = null;
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
      playbackContext = new AudioContextClass({ sampleRate: AUDIO_SAMPLE_RATE });
      playbackTime = playbackContext.currentTime;
    }

    if (playbackContext.state === "suspended") {
      try { await playbackContext.resume(); } catch {}
    }

    return playbackContext;
  }

  async function beep(freq = 880, duration = 80) {
    if (window.__fwczRadioNoBeep) return;
    try {
      const ctx = await unlockAudio();
      if (!ctx) return;

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.frequency.value = freq;
      oscillator.type = "sine";
      gain.gain.value = 0.035;

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
      beep(660, 80);
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
        beep(880, 55);
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
      beep(440, 55);
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

      captureContext = new AudioContextClass();
      captureSource = captureContext.createMediaStreamSource(micStream);
      captureProcessor = captureContext.createScriptProcessor(2048, 1, 1);

      captureProcessor.onaudioprocess = (event) => {
        if (!pttActive || !ws || ws.readyState !== WebSocket.OPEN) return;

        const input = event.inputBuffer.getChannelData(0);
        const pcm16 = downsampleFloat32ToInt16(input, captureContext.sampleRate, AUDIO_SAMPLE_RATE);
        if (pcm16 && pcm16.byteLength > 0) {
          ws.send(pcm16.buffer);
        }
      };

      captureSource.connect(captureProcessor);
      captureProcessor.connect(captureContext.destination);

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
    try { if (captureContext && captureContext.state !== "closed") captureContext.close(); } catch {}

    captureProcessor = null;
    captureSource = null;
    captureContext = null;

    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
    }
    micStream = null;
  }

  function downsampleFloat32ToInt16(input, inputSampleRate, outputSampleRate) {
    if (!input || !input.length) return new Int16Array(0);

    if (inputSampleRate === outputSampleRate) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.max(1, Math.round(input.length / ratio));
    const out = new Int16Array(newLength);

    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < out.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;

      for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
        accum += input[i];
        count++;
      }

      const sample = count ? accum / count : 0;
      const s = Math.max(-1, Math.min(1, sample));
      out[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;

      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return out;
  }

  async function handleAudioChunk(data) {
    try {
      const ctx = await unlockAudio();
      if (!ctx) return;

      const arrayBuffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength < 2) return;

      const pcm = new Int16Array(arrayBuffer);
      if (!pcm.length) return;

      const audioBuffer = ctx.createBuffer(1, pcm.length, AUDIO_SAMPLE_RATE);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < pcm.length; i++) {
        channelData[i] = pcm[i] / 32768;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      if (!playbackTime || playbackTime < now + 0.02) {
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
