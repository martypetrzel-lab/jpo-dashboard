// FireWatchCZ OPS Radio v0.1
// Frontend pro OPS/admin režim. Přenos hlasu: WebSocket + MediaRecorder Opus chunk.

(function () {
  const STORAGE_CHANNEL = "firewatchcz_radio_channel_v1";

  let mount = null;
  let ws = null;
  let mediaRecorder = null;
  let micStream = null;
  let audioQueue = [];
  let playing = false;
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

  function beep(freq = 880, duration = 80) {
    if (window.__fwczRadioNoBeep) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContextClass();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.frequency.value = freq;
      oscillator.type = "sine";
      gain.gain.value = 0.045;

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();

      setTimeout(() => {
        oscillator.stop();
        ctx.close();
      }, duration);
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

  function connectRadio() {
    if (!visible) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      closeRadio();
      return;
    }

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
        setStatus(`Připojeno: ${channel}`, data.transmitting ? "rx" : "ok");
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
        beep(880, 70);
      }
      return;
    }

    if (data.type === "ptt_denied") {
      pttActive = false;
      setStatus(data.message || "Kanál je obsazený", "error");
      mount?.querySelector("#opsRadioPtt")?.classList.remove("is-transmitting");
      return;
    }

    if (data.type === "ptt_released") {
      if (pttActive) {
        pttActive = false;
        stopRecording();
      }
      setStatus(`Připojeno: ${channel}`, "ok");
      setTx("Nikdo");
      beep(440, 70);
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
    if (!pttActive || mediaRecorder) return;

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      mediaRecorder = new MediaRecorder(micStream, {
        mimeType,
        audioBitsPerSecond: 24000
      });

      mediaRecorder.addEventListener("dataavailable", async (event) => {
        if (!event.data || event.data.size === 0) return;
        if (!pttActive || !ws || ws.readyState !== WebSocket.OPEN) return;

        const buffer = await event.data.arrayBuffer();
        ws.send(buffer);
      });

      mediaRecorder.start(180);
    } catch {
      setStatus("Mikrofon není povolený", "error");
      releasePtt();
    }
  }

  function stopRecording() {
    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch {}

    mediaRecorder = null;

    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
    }
    micStream = null;
  }

  function handleAudioChunk(data) {
    audioQueue.push(data);
    if (!playing) playNextChunk();
  }

  function playNextChunk() {
    if (!audioQueue.length) {
      playing = false;
      return;
    }

    playing = true;
    const chunk = audioQueue.shift();
    const blob = new Blob([chunk], { type: "audio/webm;codecs=opus" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      playNextChunk();
    });

    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      playNextChunk();
    });

    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      playNextChunk();
    });
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
