// FireWatchCZ OPS Radio v0.4
// Frontend pro OPS/admin režim.
// Přenos hlasu: WebRTC audio. WebSocket slouží jen pro autorizaci, PTT zámek,
// kanály a WebRTC signalizaci. Tím se odstraní chrčení/praskání z PCM chunků.

(function () {
  const STORAGE_CHANNEL = "firewatchcz_radio_channel_v1";

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  };

  let mount = null;
  let ws = null;
  let localStream = null;
  let localAudioTrack = null;
  let playbackContext = null;
  let authenticated = false;
  let pttActive = false;
  let visible = false;
  let clientId = null;
  let channel = localStorage.getItem(STORAGE_CHANNEL) || "OPS";
  let channels = ["OPS", "JEDNOTKA", "VELITEL", "TECHNICKY", "TEST"];
  let myName = "OPS";
  let peerClients = [];
  let peerConnections = new Map();
  let remoteAudios = new Map();

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

      if (!playbackContext || playbackContext.state === "closed") {
        playbackContext = new AudioContextClass({ latencyHint: "interactive" });
      }

      if (playbackContext.state === "suspended") {
        await playbackContext.resume();
      }

      return playbackContext;
    } catch {
      return null;
    }
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

          <div id="opsRadioAudioMount" aria-hidden="true"></div>
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

  async function prepareLocalAudio() {
    if (localStream && localAudioTrack) return true;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });

      localAudioTrack = localStream.getAudioTracks()[0] || null;
      if (localAudioTrack) {
        localAudioTrack.enabled = false;
      }

      return Boolean(localAudioTrack);
    } catch (error) {
      console.warn("[OPS RADIO] microphone error", error);
      setStatus("Mikrofon není povolený", "error");
      return false;
    }
  }

  async function connectRadio() {
    if (!visible) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      closeRadio();
      return;
    }

    await unlockAudio();

    const micOk = await prepareLocalAudio();
    if (!micOk) return;

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    setStatus("Připojuji…", "connecting");

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        handleControlMessage(event.data);
      }
    });

    ws.addEventListener("close", () => {
      authenticated = false;
      pttActive = false;
      clientId = null;
      stopTransmit();
      closeAllPeers();
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
    clientId = null;
    stopTransmit();
    closeAllPeers();
    stopLocalAudio();
    setConnectButton(false);
  }

  function stopLocalAudio() {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    localStream = null;
    localAudioTrack = null;
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
        const isMe = data.txClientId && data.txClientId === clientId;
        setStatus(`Připojeno: ${channel}`, data.transmitting ? (isMe ? "tx" : "rx") : "ok");
        setTx(data.transmitting ? (data.txName || "Někdo") : "Nikdo");
        peerClients = Array.isArray(data.clients) ? data.clients : [];
        renderUsers(peerClients);
        syncPeers(peerClients);
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
        beep(880, 45);
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
      setStatus(`Připojeno: ${channel}`, "ok");
      setTx("Nikdo");
      beep(440, 45);
      return;
    }

    if (data.type === "webrtc_signal") {
      handleRtcSignal(data.from, data.signal);
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
    closeAllPeers();

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
    stopTransmit();
  }

  function startTransmit() {
    if (localAudioTrack) {
      localAudioTrack.enabled = true;
    }
  }

  function stopTransmit() {
    if (localAudioTrack) {
      localAudioTrack.enabled = false;
    }
  }

  function syncPeers(users) {
    if (!authenticated || !clientId || !localStream) return;

    const wanted = new Set(
      users
        .filter((user) => user.id && user.id !== clientId)
        .map((user) => user.id)
    );

    for (const peerId of [...peerConnections.keys()]) {
      if (!wanted.has(peerId)) closePeer(peerId);
    }

    for (const user of users) {
      if (!user.id || user.id === clientId) continue;
      ensurePeer(user.id, { makeOffer: shouldCreateOffer(user.id) });
    }
  }

  function shouldCreateOffer(peerId) {
    // Jednoduché zabránění offer-glare: nabídku vytvoří klient s lexikograficky menším ID.
    return String(clientId) < String(peerId);
  }

  async function ensurePeer(peerId, options = {}) {
    if (!peerId || peerId === clientId) return null;

    let entry = peerConnections.get(peerId);
    if (entry) return entry.pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    entry = {
      pc,
      makingOffer: false,
      remoteDescriptionSet: false,
      pendingCandidates: []
    };
    peerConnections.set(peerId, entry);

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendSignal(peerId, {
        kind: "candidate",
        candidate: event.candidate
      });
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) attachRemoteAudio(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        if (pc.connectionState === "failed") {
          try { pc.restartIce(); } catch {}
        }
      }
    };

    if (options.makeOffer) {
      await createAndSendOffer(peerId);
    }

    return pc;
  }

  async function createAndSendOffer(peerId) {
    const entry = peerConnections.get(peerId);
    if (!entry || entry.makingOffer) return;

    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer({ offerToReceiveAudio: true });
      await entry.pc.setLocalDescription(offer);
      sendSignal(peerId, {
        kind: "description",
        description: entry.pc.localDescription
      });
    } catch (error) {
      console.warn("[OPS RADIO] offer error", error);
    } finally {
      entry.makingOffer = false;
    }
  }

  async function handleRtcSignal(fromPeerId, signal) {
    if (!fromPeerId || !signal || fromPeerId === clientId) return;

    const pc = await ensurePeer(fromPeerId, { makeOffer: false });
    const entry = peerConnections.get(fromPeerId);
    if (!pc || !entry) return;

    try {
      if (signal.kind === "description" && signal.description) {
        const description = signal.description;
        await pc.setRemoteDescription(description);
        entry.remoteDescriptionSet = true;

        if (description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(fromPeerId, {
            kind: "description",
            description: pc.localDescription
          });
        }

        while (entry.pendingCandidates.length) {
          const candidate = entry.pendingCandidates.shift();
          try { await pc.addIceCandidate(candidate); } catch {}
        }
        return;
      }

      if (signal.kind === "candidate" && signal.candidate) {
        if (!entry.remoteDescriptionSet) {
          entry.pendingCandidates.push(signal.candidate);
          return;
        }
        await pc.addIceCandidate(signal.candidate);
      }
    } catch (error) {
      console.warn("[OPS RADIO] signal error", error);
    }
  }

  function sendSignal(to, signal) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !to || !signal) return;
    ws.send(JSON.stringify({
      type: "webrtc_signal",
      to,
      signal
    }));
  }

  function attachRemoteAudio(peerId, stream) {
    let audio = remoteAudios.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.controls = false;
      audio.dataset.peerId = peerId;
      audio.style.display = "none";
      remoteAudios.set(peerId, audio);
      mount?.querySelector("#opsRadioAudioMount")?.appendChild(audio);
    }

    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }

    audio.play().catch(() => {
      // Některé mobily pustí audio až po dalším dotyku. Connect/PTT volá unlockAudio,
      // takže se to po uživatelské akci většinou samo rozběhne.
    });
  }

  function closePeer(peerId) {
    const entry = peerConnections.get(peerId);
    if (entry) {
      try { entry.pc.close(); } catch {}
      peerConnections.delete(peerId);
    }

    const audio = remoteAudios.get(peerId);
    if (audio) {
      try { audio.pause(); } catch {}
      audio.srcObject = null;
      audio.remove();
      remoteAudios.delete(peerId);
    }
  }

  function closeAllPeers() {
    for (const peerId of [...peerConnections.keys()]) {
      closePeer(peerId);
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
