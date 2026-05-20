let map, markersLayer, chart;
let hzsLayer, hzsStationsToggleEl;
let routesLayer, vehiclesLayer;

// OPS auth state (musí být nahoře kvůli TTS, které může běžet už při prvním loadu)
let currentUser = null; // {id, username, role}
const LS_GUEST_HERO_DISMISSED = "fwcz_guestHeroDismissed";
const LS_TALK_PANEL_OPEN = "fwcz_talkPanelOpen";
let talkPanelOpen = localStorage.getItem(LS_TALK_PANEL_OPEN) === "1";

// ✅ simulace – jen NOVÉ a AKTIVNÍ události (od načtení stránky)
const seenEventIds = new Set();
const runningSims = new Map(); // eventId -> { marker, route, raf, stop }

// ✅ HZS stanice – geokódování (cache v localStorage)
let stationsReadyPromise = null;
let hzsStations = [];

// Routing (ETA) – veřejné OSRM
const OSRM_BASE = "https://router.project-osrm.org";
const MAX_STATION_AIR_KM = 20; // vzdušnou čarou

// Animace: zrychlené zobrazení (ETA se počítá reálně, animace je jen simulace)
const ANIM_MIN_MS = 25000;  // min 25 s
const ANIM_MAX_MS = 240000; // max 4 min
const ANIM_SPEEDUP = 12;
let inFlight = false;

// Simulace: fronta, aby se nové události neblokovaly (více nových událostí po sobě)
let simQueue = Promise.resolve();
function queueSimulation(ev) {
  simQueue = simQueue.then(() => startSimulationForEvent(ev)).catch(() => {});
  return simQueue;
}

// ==============================
// OPS AUDIO (gong + hlas)
// ==============================

const LS_AUDIO = "fwcz_audio_v1";
const LS_AUDIO_NEXT_SUMMARY_AT = "fwcz_audio_nextSummaryAt";
const LS_AUDIO_LAST_SHIFT_KEY = "fwcz_audio_lastShiftKey";

// ==============================
// MASTER MUTE (vypnout veškerý zvuk)
// ==============================
const LS_MASTER_MUTE = "fwcz_master_mute_v1";
let masterMute = false;

function loadMasterMute() {
  try { masterMute = (localStorage.getItem(LS_MASTER_MUTE) === "1"); } catch { masterMute = false; }
}

function saveMasterMute() {
  try { localStorage.setItem(LS_MASTER_MUTE, masterMute ? "1" : "0"); } catch {}
}

function setMuteUi() {
  const btn = document.getElementById("muteBtn");
  if (!btn) return;
  if (masterMute) {
    btn.textContent = "🔇";
    btn.classList.add("isMuted");
    btn.title = "Zvuk vypnut (klikni pro zapnutí)";
  } else {
    btn.textContent = "🔈";
    btn.classList.remove("isMuted");
    btn.title = "Ztlumit vše (FireWatch)";
  }
}

function applyMasterMute() {
  // okamžitě zastav vše, co právě hraje
  if (masterMute) {
    try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch {}
    try {
      if (gongAudio) {
        gongAudio.pause();
        gongAudio.currentTime = 0;
      }
    } catch {}
  }
  setMuteUi();
}

function toggleMasterMute() {
  masterMute = !masterMute;
  saveMasterMute();
  applyMasterMute();
}

let latestItemsSnapshot = [];
let latestEventsTotalMatching = 0;
let lastGoodItemsSnapshot = [];
let lastGoodStatsSnapshot = null;
let lastGoodLoadAt = 0;
let latestStatsSnapshot = null;

const audioState = {
  enabled: false,
  gongOnShift: true,
  volume: 0.7,
  rate: 1.05,
  quiet: false, // 22:00–06:00
  unlocked: false
};

let gongAudio = null;
let audioQueue = Promise.resolve();

// Preferovaný hlas pro TTS (pokoušíme se najít ženský cs-CZ, když existuje)
let preferredVoice = null;
let voicesReady = false;

function scoreVoiceForCzFemale(v) {
  const lang = String(v?.lang || "").toLowerCase();
  const name = String(v?.name || "").toLowerCase();
  const uri = String(v?.voiceURI || "").toLowerCase();

  let score = 0;

  // jazyk
  if (lang === "cs-cz") score += 100;
  else if (lang.startsWith("cs")) score += 70;

  // kvalita / natural
  if (v?.localService === false) score += 5; // často kvalitnější (Google/Microsoft online), ale ne vždy

  // heuristika "ženský" – WebSpeech API neobsahuje gender, proto odhad z názvu
  const femaleHints = [
    "female", "woman", "žensk", "zens", "žena", "zena",
    "eva", "tereza", "zuzana", "jana", "anna", "lenka", "katka", "katerina",
    "alena", "veronika", "monika", "petra", "lucie", "iveta", "gabriela"
  ];
  const maleHints = ["male", "man", "muž", "muz", "pavel", "jan", "petr", "ondrej", "andrej", "milan", "tomáš", "tomas"];

  if (femaleHints.some(h => name.includes(h) || uri.includes(h))) score += 30;
  if (maleHints.some(h => name.includes(h) || uri.includes(h))) score -= 10;

  // preferuj hlasy s jasným názvem jazyka/regionu
  if (name.includes("czech") || name.includes("češt") || name.includes("cest")) score += 10;

  // lehce preferuj Microsoft/Google CZ, často mají lepší výslovnost
  if (name.includes("microsoft") || name.includes("google")) score += 6;

  return score;
}

function refreshPreferredVoice() {
  if (!("speechSynthesis" in window)) return;
  const voices = window.speechSynthesis.getVoices?.() || [];
  if (!voices.length) return;

  voicesReady = true;

  // vyber nejlépe skórovaný hlas
  let best = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const sc = scoreVoiceForCzFemale(v);
    if (sc > bestScore) {
      bestScore = sc;
      best = v;
    }
  }
  preferredVoice = best || null;
}

function ensureVoicesHooked() {
  if (!("speechSynthesis" in window)) return;
  // vyvolá načtení hlasů
  try { window.speechSynthesis.getVoices(); } catch {}
  // některé prohlížeče naplní voices až po onvoiceschanged
  if (!window.__fwczVoicesHooked) {
    window.__fwczVoicesHooked = true;
    window.speechSynthesis.onvoiceschanged = () => {
      refreshPreferredVoice();
    };
  }
  // pokus o immediate refresh
  refreshPreferredVoice();
}

// OPS briefing (ručně)
let briefingCooldownUntil = 0;

function loadAudioPrefs() {
  try {
    const raw = localStorage.getItem(LS_AUDIO);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (typeof j.enabled === "boolean") audioState.enabled = j.enabled;
    if (typeof j.gongOnShift === "boolean") audioState.gongOnShift = j.gongOnShift;
    if (typeof j.volume === "number") audioState.volume = clamp(j.volume, 0, 1);
    if (typeof j.rate === "number") audioState.rate = clamp(j.rate, 0.8, 1.4);
    if (typeof j.quiet === "boolean") audioState.quiet = j.quiet;
  } catch {
    // ignore
  }
}

function saveAudioPrefs() {
  try {
    localStorage.setItem(LS_AUDIO, JSON.stringify({
      enabled: audioState.enabled,
      gongOnShift: audioState.gongOnShift,
      volume: audioState.volume,
      rate: audioState.rate,
      quiet: audioState.quiet
    }));
  } catch {
    // ignore
  }
}

function isOps() {
  return !!currentUser; // ops i admin
}

function inQuietHours(now = new Date()) {
  if (!audioState.quiet) return false;
  const h = now.getHours();
  return (h >= 22 || h < 6);
}

function setAudioMsg(text, ok = true) {
  const el = document.getElementById("audioMsg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = ok ? "rgba(120,255,180,0.9)" : "rgba(255,140,140,0.95)";
}

function ensureGong() {
  if (gongAudio) return gongAudio;
  gongAudio = new Audio("gong.mp3");
  gongAudio.preload = "auto";
  return gongAudio;
}

async function unlockAudio() {
  if (masterMute) {
    audioState.unlocked = false;
    setAudioMsg("Zvuk je vypnutý (🔇). Nejprve zapni zvuk.", false);
    return;
  }
  try {
    const a = ensureGong();
    a.volume = 0;
    // některé prohlížeče vyžadují přehrání v rámci kliknutí
    await a.play();
    a.pause();
    a.currentTime = 0;
    a.volume = audioState.volume;
    audioState.unlocked = true;
    setAudioMsg("Audio odemčeno ✅", true);
  } catch {
    // TTS může fungovat i bez toho, ale gong ne
    audioState.unlocked = false;
    setAudioMsg("Nepodařilo se odemknout (zkus znovu).", false);
  }
}

function queueTask(fn) {
  audioQueue = audioQueue.then(() => fn()).catch(() => {}).then(() => new Promise(r => setTimeout(r, 250)));
  return audioQueue;
}

async function speak(text) {
  if (!text) return;
  if (masterMute) return;
  if (!("speechSynthesis" in window)) {
    setAudioMsg("TTS není v prohlížeči podporované.", false);
    return;
  }

  // některé prohlížeče potřebují, aby se voices načetly
  ensureVoicesHooked();

  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "cs-CZ";
    u.rate = clamp(audioState.rate, 0.8, 1.4);

    // preferuj ženský cs-CZ hlas, když je dostupný
    if (preferredVoice) {
      u.voice = preferredVoice;
    } else {
      const voices = window.speechSynthesis.getVoices?.() || [];
      const cz = voices.find(v => (v.lang || "").toLowerCase() === "cs-cz")
        || voices.find(v => (v.lang || "").toLowerCase().startsWith("cs"));
      if (cz) u.voice = cz;
    }

    u.onend = () => resolve();
    u.onerror = () => resolve();

    try {
      window.speechSynthesis.cancel();
    } catch {}

    window.speechSynthesis.speak(u);
  });
}

async function playGongOnce() {
  if (masterMute) return;
  if (!audioState.gongOnShift) return;
  const a = ensureGong();
  a.volume = clamp(audioState.volume, 0, 1);
  try {
    await a.play();
    await new Promise(r => {
      a.onended = () => r();
      // fallback
      setTimeout(r, 2500);
    });
  } catch {
    // ignore
  }
}

function canAnnounceNow() {
  if (masterMute) return false;
  if (!isOps()) return false;
  if (!audioState.enabled) return false;
  if (inQuietHours()) return false;
  return true;
}

function formatDurationSpeechFromMinutes(min) {
  if (!Number.isFinite(min) || min <= 0) return "0 minut";
  const totalMin = Math.round(min);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;

  const parts = [];
  if (days > 0) parts.push(days === 1 ? "1 den" : `${days} dny`);
  if (hours > 0) parts.push(hours === 1 ? "1 hodina" : `${hours} hodin`);
  if (days === 0 && mins > 0) parts.push(`${mins} minut`);
  return parts.join(" ");
}

function pickLastByPubDate(items) {
  let best = null;
  let bestT = -Infinity;
  for (const it of items || []) {
    const t = Date.parse(it.pub_date || "");
    const tt = Number.isFinite(t) ? t : -Infinity;
    if (tt > bestT) {
      bestT = tt;
      best = it;
    }
  }
  return best;
}

function pickLongestActive(items) {
  let best = null;
  let bestMin = -Infinity;
  for (const it of items || []) {
    if (it.is_closed) continue;
    const dm = Number(it.duration_min);
    if (!Number.isFinite(dm)) continue;
    if (dm > bestMin) {
      bestMin = dm;
      best = it;
    }
  }
  return best;
}

function buildBriefingText() {
  const items = latestItemsSnapshot || [];
  const open = Number.isFinite(latestStatsSnapshot?.openCount)
    ? Number(latestStatsSnapshot.openCount)
    : items.filter(x => !x.is_closed).length;

  const parts = ["OPS briefing."];

  if (open <= 0) {
    parts.push("Aktuálně bez aktivních událostí.");
  } else {
    parts.push(`Aktivní události: ${open}.`);
    const longest = pickLongestActive(items);
    if (longest) {
      const meta = typeMeta(longest.event_type);
      const city = (longest.city_text || longest.place_text || "").trim();
      const dur = formatDurationSpeechFromMinutes(Number(longest.duration_min));
      const base = city ? `${meta.label} v ${city}` : meta.label;
      parts.push(`Nejdéle trvá: ${base}, ${dur}.`);
    }
  }

  const last = pickLastByPubDate(items);
  if (last) {
    const meta = typeMeta(last.event_type);
    const city = (last.city_text || last.place_text || "").trim();
    const base = city ? `${meta.label} — ${city}` : meta.label;
    parts.push(`Poslední nová: ${base}.`);
  }

  // směna (krátce, vždy na konec)
  const mode = getShiftModeFromUi?.() || "HZS";
  const s = computeShiftFor(new Date(), mode);
  const modeTxt = mode === "HZSP" ? "HZSP" : "HZS";
  if (s?.cur) parts.push(`Směna ${modeTxt}: ${s.cur}.`);

  return parts.join(" ");
}

async function speakNow(text) {
  // briefing je ruční "na povel" – jde hned, nepřidává se do fronty
  try { audioQueue = Promise.resolve(); } catch { /* ignore */ }
  return speak(text);
}

async function runBriefing() {
  if (!isOps()) return;

  const btn = document.getElementById("briefingBtn");
  const now = Date.now();
  if (now < briefingCooldownUntil) {
    // tiché odmítnutí (anti double-tap)
    return;
  }

  // cooldown 20 s
  briefingCooldownUntil = now + 20000;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("isBusy");
  }

  const text = buildBriefingText();
  if (!text) {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("isBusy");
    }
    return;
  }

  try {
    await speakNow(text);
  } finally {
    // odemkni tlačítko až po cooldownu
    const wait = Math.max(0, briefingCooldownUntil - Date.now());
    setTimeout(() => {
      if (!btn) return;
      btn.disabled = false;
      btn.classList.remove("isBusy");
    }, wait);
  }
}

function buildNewEventText(ev) {
  const meta = typeMeta(ev.event_type);
  const city = ev.city_text || ev.place_text || "";
  const title = (ev.title || "").trim();

  // zkus z titulku vynechat část " - město" když je město už zvlášť
  let shortTitle = title;
  if (city && title.toLowerCase().endsWith((" - " + city).toLowerCase())) {
    shortTitle = title.slice(0, title.length - (3 + city.length));
  }

  const parts = ["Nová událost.", meta.label + "."];
  if (city) parts.push("Místo: " + city + ".");
  if (shortTitle) parts.push(shortTitle + ".");
  return parts.join(" ");
}

function buildSummaryText() {
  const open = latestStatsSnapshot?.openCount;
  const closed = latestStatsSnapshot?.closedCount;
  const top = latestStatsSnapshot?.topCities?.[0]?.city;
  const topCount = latestStatsSnapshot?.topCities?.[0]?.count;

  const parts = ["Souhrn přehledu."];
  if (Number.isFinite(open) && Number.isFinite(closed)) {
    parts.push(`Aktivní ${open}. Ukončené ${closed}.`);
  } else {
    const active = (latestItemsSnapshot || []).filter(x => !x.is_closed).length;
    parts.push(`Aktivní ${active}.`);
  }
  if (top && Number.isFinite(topCount)) {
    parts.push(`Nejvíc událostí má ${top}: ${topCount}.`);
  }
  return parts.join(" ");
}

function buildShiftText(mode) {
  const now = new Date();
  const s = computeShiftFor(now, mode);
  const modeTxt = mode === "HZSP" ? "HZSP" : "HZS";
  return `Střídání směn. Režim ${modeTxt}. Nyní směna ${s.cur}.`;
}

function audioOnNewEvent(ev) {
  if (!canAnnounceNow()) return;
  // nové události: BEZ gongu (podle domluvy)
  const text = buildNewEventText(ev);
  queueTask(() => speak(text));
}

function ensureSummarySchedule() {
  try {
    const raw = localStorage.getItem(LS_AUDIO_NEXT_SUMMARY_AT);
    const t = raw ? Number(raw) : 0;
    if (Number.isFinite(t) && t > Date.now()) return;
  } catch {}

  // naplánuj další souhrn za 3h od teď
  const next = Date.now() + 3 * 60 * 60 * 1000;
  try { localStorage.setItem(LS_AUDIO_NEXT_SUMMARY_AT, String(next)); } catch {}
}

function audioTickSummary() {
  if (!canAnnounceNow()) return;
  ensureSummarySchedule();

  let nextAt = 0;
  try { nextAt = Number(localStorage.getItem(LS_AUDIO_NEXT_SUMMARY_AT) || 0); } catch {}
  if (!Number.isFinite(nextAt) || nextAt <= 0) return;

  if (Date.now() < nextAt) return;

  // po 3 hodinách: jen hlas (bez gongu)
  const text = buildSummaryText();
  queueTask(() => speak(text));

  // další za 3h
  const next = Date.now() + 3 * 60 * 60 * 1000;
  try { localStorage.setItem(LS_AUDIO_NEXT_SUMMARY_AT, String(next)); } catch {}
}

function audioTickShift() {
  // směna: gong + hlas (ale jen v OPS a když není tichý režim)
  if (!canAnnounceNow()) return;

  const mode = getShiftModeFromUi();
  const boundary = shiftBoundaryHour(mode);
  const now = new Date();

  // pokud jsme přesně kolem boundary (±20 s), zkontroluj a ohlas jednou
  const hh = now.getHours();
  const mm = now.getMinutes();
  const ss = now.getSeconds();
  if (!(hh === boundary && mm === 0 && ss <= 20)) return;

  // klíč pro "už hlášeno" (mode + local date)
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const key = `${mode}-${y}-${m}-${d}`;

  try {
    const last = localStorage.getItem(LS_AUDIO_LAST_SHIFT_KEY);
    if (last === key) return;
    localStorage.setItem(LS_AUDIO_LAST_SHIFT_KEY, key);
  } catch {
    // ignore
  }

  const text = buildShiftText(mode);
  queueTask(async () => {
    // gong jen u směny (lze vypnout v UI)
    await playGongOnce();
    await speak(text);
  });
}

const TYPE = {
  fire: { emoji: "🔥", label: "požár", cls: "marker-fire" },
  traffic: { emoji: "🚗", label: "nehoda", cls: "marker-traffic" },
  tech: { emoji: "🛠️", label: "technická", cls: "marker-tech" },
  rescue: { emoji: "🚑", label: "záchrana", cls: "marker-rescue" },
  false_alarm: { emoji: "🚫", label: "planý poplach", cls: "marker-false" },
  other: { emoji: "❓", label: "jiné", cls: "marker-other" }
};

function typeMeta(t) {
  return TYPE[t] || TYPE.other;
}

function statusEmoji(isClosed) {
  return isClosed ? "✅" : "🔴";
}

function setStatus(text, ok = true) {
  const pill = document.getElementById("statusPill");
  pill.textContent = text;
  pill.style.background = ok ? "rgba(60, 180, 120, 0.20)" : "rgba(220, 80, 80, 0.20)";
  pill.style.borderColor = ok ? "rgba(60, 180, 120, 0.35)" : "rgba(220, 80, 80, 0.35)";
}


function normalizeEventCoords(ev) {
  if (!ev || typeof ev !== "object") return ev;

  const latRaw = ev.lat ?? ev.latitude;
  const lonRaw = ev.lon ?? ev.lng ?? ev.longitude;

  const lat = typeof latRaw === "number" ? latRaw : Number(String(latRaw ?? "").replace(",", "."));
  const lon = typeof lonRaw === "number" ? lonRaw : Number(String(lonRaw ?? "").replace(",", "."));

  return {
    ...ev,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null
  };
}

function normalizeEventsCoords(items) {
  return Array.isArray(items) ? items.map(normalizeEventCoords) : [];
}

function hasValidCoords(ev) {
  const lat = Number(ev?.lat);
  const lon = Number(ev?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}


function initMap() {
  map = L.map("map").setView([49.8, 15.3], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);

  // vrstvy: HZS stanice (statické), trasy a vozidla (simulace)
  hzsLayer = L.layerGroup();
  routesLayer = L.layerGroup().addTo(map);
  vehiclesLayer = L.layerGroup().addTo(map);

  // admin pick coords (klik do mapy)
  map.on("click", (e) => {
    if (!pickingCoords) return;
    const id = document.getElementById("coordsEventId")?.value?.trim();
    if (!id) return;
    const lat = Number(e.latlng.lat);
    const lon = Number(e.latlng.lng);
    const latEl = document.getElementById("coordsLat");
    const lonEl = document.getElementById("coordsLon");
    if (latEl) latEl.value = lat.toFixed(6);
    if (lonEl) lonEl.value = lon.toFixed(6);

    try {
      if (tempPickMarker) map.removeLayer(tempPickMarker);
      tempPickMarker = L.circleMarker([lat, lon], { radius: 7, weight: 2 }).addTo(map);
    } catch {}
    msg("coordsMsg", `Vybráno: ${lat.toFixed(6)}, ${lon.toFixed(6)} (událost ${id})`, true);
    setPickMode(false);
  });

}

// ==============================
// HZS STANICE (statická vrstva)
// ==============================

const HZS_STATIONS_SRC = [
  // ÚO Benešov
  { name: "Centrální hasičská stanice Benešov", address: "Pod Lihovarem 2152, Benešov" },
  { name: "Hasičská stanice Vlašim", address: "Blanická 468, Vlašim" },

  // ÚO Beroun
  { name: "Centrální hasičská stanice Beroun", address: "Pod Studánkou 1258, Beroun" },
  { name: "Hasičská stanice Hořovice", address: "Nám. B. Němcové 811, Hořovice" },

  // ÚO Kladno
  { name: "Centrální hasičská stanice Kladno", address: "Jana Palacha 1970, Kladno" },
  { name: "Hasičská stanice Rakovník", address: "Dukelských hrdinů 2502, Rakovník" },
  { name: "Hasičská stanice Roztoky", address: "Máchova 449, Roztoky" },
  { name: "Hasičská stanice Řevnice", address: "Havlíčkova 174, Řevnice" },
  { name: "Hasičská stanice Slaný", address: "Lázeňská 286, Slaný" },
  { name: "Hasičská stanice Stochov", address: "U Stadionu 527, Stochov" },
  { name: "Hasičská stanice Jílové u Prahy", address: "Rudných dolů 460, Jílové u Prahy" },

  // ÚO Kolín
  { name: "Centrální hasičská stanice Kolín", address: "Polepská 634, Kolín" },
  { name: "Hasičská stanice Český Brod", address: "Tyršova 73, Český Brod" },
  { name: "Hasičská stanice Ovčáry", address: "Průmyslová zóna Ovčáry, Ovčáry" },
  { name: "Hasičská stanice Říčany", address: "Černokostelecká 447, Říčany" },

  // ÚO Kutná Hora
  { name: "Centrální hasičská stanice Kutná Hora", address: "U Zastávky 280, Kutná Hora" },
  { name: "Hasičská stanice Čáslav", address: "Vrchovská 2015, Čáslav" },
  { name: "Hasičská stanice Uhlířské Janovice", address: "Hasičská 778, Uhlířské Janovice" },
  { name: "Hasičská stanice Zruč nad Sázavou", address: "Jiřická 77, Zruč nad Sázavou" },

  // ÚO Mělník
  { name: "Centrální hasičská stanice Mělník", address: "Bezručova 3341, Mělník" },
  { name: "Hasičská stanice Neratovice", address: "Kostomlatského sady 24, Neratovice" },
  { name: "Hasičská stanice Kralupy nad Vltavou", address: "Přemyslova 935, Kralupy nad Vltavou" },

  // ÚO Mladá Boleslav
  { name: "Centrální hasičská stanice Mladá Boleslav", address: "Laurinova 1370, Mladá Boleslav" },
  { name: "Hasičská stanice Benátky nad Jizerou", address: "Jiráskova 362, Benátky nad Jizerou" },
  { name: "Hasičská stanice Bělá pod Bezdězem", address: "Máchova 504, Bělá pod Bezdězem" },
  { name: "Hasičská stanice Mnichovo Hradiště", address: "Hřbitovní 29, Mnichovo Hradiště" },
  { name: "Hasičská stanice Stará Boleslav", address: "Svatopluka Čecha 960, Brandýs nad Labem-Stará Boleslav" },

  // ÚO Nymburk
  { name: "Centrální hasičská stanice Nymburk", address: "Tyršova 11, Nymburk" },
  { name: "Hasičská stanice Poděbrady", address: "Krátká 1000, Poděbrady" },
  { name: "Hasičská stanice Milovice", address: "Armádní 866, Milovice" },

  // ÚO Příbram
  { name: "Centrální hasičská stanice Příbram", address: "Školní 70, Příbram" },
  { name: "Hasičská stanice Dobříš", address: "Plk. Petroviče 601, Dobříš" },
  { name: "Hasičská stanice Sedlčany", address: "Kňovická 330, Sedlčany" }
];

const STATIONS_CACHE_KEY = "fwcz_hzs_stations_v1";

function makeStationIcon() {
  return L.divIcon({
    className: "fw-emoji-wrap",
    html: `<div class="fw-emoji" title="Stanice HZS">🚒</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function renderHzsStations() {
  if (!hzsLayer) return;
  hzsLayer.clearLayers();
  for (const s of hzsStations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const m = L.marker([s.lat, s.lon], { icon: makeStationIcon() });
    m.bindPopup(`<b>${escapeHtml(s.name)}</b><br><span style="opacity:.8">${escapeHtml(s.address || "")}</span>`);
    m.addTo(hzsLayer);
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function geocodeStation(address) {
  // Nominatim – jednoduché geocode, cacheujeme a jedeme pomalu
  const q = `${address}, Středočeský kraj, Czechia`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const it = arr[0];
  const lat = Number(it.lat);
  const lon = Number(it.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function loadStations() {
  try {
    // cache
    const cachedRaw = localStorage.getItem(STATIONS_CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      if (Array.isArray(cached) && cached.length > 0) {
        hzsStations = cached;
        renderHzsStations();
      }
    }

    // spoj zdroj + cache podle názvu
    const byName = new Map((hzsStations || []).map(s => [s.name, s]));
    hzsStations = HZS_STATIONS_SRC.map(s => ({
      name: s.name,
      address: s.address,
      lat: byName.get(s.name)?.lat,
      lon: byName.get(s.name)?.lon
    }));

    // dohledej chybějící souřadnice (pomalu, aby to nebyl spam)
    let changed = false;
    for (const s of hzsStations) {
      if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) continue;
      try {
        const g = await geocodeStation(s.address);
        if (g) {
          s.lat = g.lat;
          s.lon = g.lon;
          changed = true;
          renderHzsStations();
          localStorage.setItem(STATIONS_CACHE_KEY, JSON.stringify(hzsStations));
        }
      } catch {
        // ignore
      }
      await sleep(1100);
    }

    if (changed) {
      localStorage.setItem(STATIONS_CACHE_KEY, JSON.stringify(hzsStations));
    }
  } catch {
    // ignore
  }
}

function formatDate(d) {
  if (!d) return "";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleString("cs-CZ");
  } catch {
    return d;
  }
}

function formatDuration(min) {
  if (!Number.isFinite(min) || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// build query helpers
// Pozn.: month filtr je určený jen pro statistiky měst (topCities) – NESMÍ ovlivnit /api/events ani exporty,
// jinak to vypadá jako "zmizely události" při Obnovit.

function getEventsApiLimit() {
  // Hlavní přehled musí dostat celý vybraný den, jinak se noční události z DB nedostanou do tabulky.
  return 2000;
}

function getEventsTableLimit() {
  const v = Number(document.getElementById("eventsLimitSelect")?.value || 25);
  return Number.isFinite(v) ? Math.max(10, Math.min(v, 200)) : 25;
}

function buildEventsQuery(filters) {
  const params = new URLSearchParams();
  if (filters.day && filters.day !== "all") params.set("day", filters.day);
  if (filters.type) params.set("type", filters.type);
  if (filters.city) params.set("city", filters.city);
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  params.set("limit", String(getEventsTableLimit()));
  params.set("limit", String(getEventsApiLimit()));
  // month zde úmyslně není
  return params.toString();
}

function buildStatsQuery(filters) {
  const params = new URLSearchParams();
  if (filters.day && filters.day !== "all") params.set("day", filters.day);
  if (filters.type) params.set("type", filters.type);
  if (filters.city) params.set("city", filters.city);
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.month) params.set("month", filters.month);
  return params.toString();
}

function buildExportQuery(filters) {
  const params = new URLSearchParams();
  if (filters.day && filters.day !== "all") params.set("day", filters.day);
  if (filters.type) params.set("type", filters.type);
  if (filters.city) params.set("city", filters.city);
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  // month zde úmyslně není (export = tabulka/události podle filtrů)
  return params.toString();
}


function eventLocalDateKey(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;
  return y && m && day ? `${y}-${m}-${day}` : "";
}

function selectedDayDateKey(dayFilter) {
  const now = new Date();
  const prg = new Date(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now));

  const d = new Date(now);
  if (dayFilter === "yesterday") d.setDate(d.getDate() - 1);

  return eventLocalDateKey(d.toISOString());
}

function eventBelongsToSelectedDayStrict(it, dayFilter) {
  if (!["today", "yesterday"].includes(dayFilter)) return true;

  const selected = selectedDayDateKey(dayFilter);
  const started = eventLocalDateKey(it.start_time_iso || it.pub_date || it.created_at);

  if (started === selected) return true;

  // Přenos do vybraného dne pouze pro stále aktivní významné/vyšší zásahy.
  return !!(
    !it.is_closed &&
    started &&
    started < selected &&
    (Number(it.alarm_level || 0) >= 2 || !!it.is_major_event)
  );
}


function getFiltersFromUi() {
  return {
    day: document.getElementById("daySelect").value,
    type: document.getElementById("typeSelect").value,
    city: document.getElementById("cityInput").value.trim(),
    status: document.getElementById("statusSelect").value,
    month: document.getElementById("monthInput")?.value || "",
    majorOnly: !!document.getElementById("majorOnlyCheck")?.checked
  };
}


// ==============================
// FireWatchCZ Web v2.2 – Významné události / stupeň poplachu
// ==============================



function isImportantCarryoverEvent(it) {
  return !!it && !it.is_closed && (Number(it.alarm_level || 0) >= 2 || !!it.is_major_event);
}

function carryoverBadgeHtml(it) {
  if (!isImportantCarryoverEvent(it)) return "";
  const days = Number(it.carryover_days || 0);
  if (!it.is_carryover_active && days <= 0) return "";
  const text = days > 1 ? `aktivní už ${days} dny` : "aktivní od včera";
  return `<span class="carryoverBadge">⏳ ${escapeHtml(text)}</span>`;
}

function liveDurationForEvent(it) {
  if (!it || it.is_closed) return it?.duration_min;

  // Sledovaná délka: od první chvíle, kdy FireWatch událost uviděl,
  // do aktuální chvíle. Po ukončení backend uloží stejný princip do duration_min.
  const start = it.first_seen_at || it.created_at || it.start_time_iso || it.pub_date;
  if (!start) return it.duration_min;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return it.duration_min;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
}

function alarmLevelBadge(it) {
  const level = Number(it?.alarm_level || it?.alarmLevel || 0);
  const text = it?.alarm_level_text || it?.alarmLevelText || "";
  if (!level && !it?.is_major_event) return "";

  const label = text || (level ? `${level}. stupeň poplachu` : "významná událost");
  const cls = level >= 4 ? "alarm-special" : level >= 3 ? "alarm-major" : level >= 2 ? "alarm-medium" : "alarm-low";
  return `<span class="alarmBadge ${cls}">${level >= 3 ? "🚨" : "⚠️"} ${escapeHtml(label)}</span>`;
}

function majorReasonText(it) {
  return it?.major_reason || it?.majorReason || "";
}

function statusLabelForEvent(it) {
  if (it?.status_source === "explicit_open" || it?.statusSource === "explicit_open") return "probíhá zásah";
  if (it?.status_source === "explicit_closed" || it?.statusSource === "explicit_closed") return "ukončená";
  return it?.is_closed ? "ukončená" : "aktivní";
}

function isMajorEventItem(it) {
  return !!it?.is_major_event || Number(it?.alarm_level || 0) >= 3;
}


function bindMajorManualButtons() {
  document.querySelectorAll(".majorManualEditBtn").forEach((btn) => {
    btn.addEventListener("click", () => openManualEventEditor(btn.getAttribute("data-event-id")));
  });
  syncAdminVisibility?.();
}

function renderMajorEvents(items = []) {
  const summary = document.getElementById("majorEventsSummary");
  const list = document.getElementById("majorEventsList");
  if (!summary || !list) return;

  const major = items.filter(isMajorEventItem);
  const level3 = items.filter(x => Number(x.alarm_level || 0) === 3).length;
  const level4 = items.filter(x => Number(x.alarm_level || 0) >= 4).length;
  const activeMajor = major.filter(x => !x.is_closed || x.status_source === "explicit_open").length;

  summary.innerHTML = `
    <div class="majorKpi"><span>Významné</span><b>${major.length}</b></div>
    <div class="majorKpi alarm-major"><span>III. stupeň</span><b>${level3}</b></div>
    <div class="majorKpi alarm-special"><span>Zvláštní / IV.</span><b>${level4}</b></div>
    <div class="majorKpi"><span>Aktivní významné</span><b>${activeMajor}</b></div>
  `;

  if (!major.length) {
    list.innerHTML = `<div class="muted">Zatím bez rozpoznané významné události ve vybraném přehledu.</div>`;
    return;
  }

  list.innerHTML = major.slice(0, 8).map(it => {
    const meta = typeMeta(it.event_type);
    return `
      <div class="majorEventItem ${Number(it.alarm_level || 0) >= 4 ? "alarm-special" : "alarm-major"}">
        <div>
          <b>${meta.emoji} ${escapeHtml(it.title || "")}</b>
          <span>${escapeHtml(it.city_text || it.place_text || "")} • ${statusEmoji(it.is_closed)} ${escapeHtml(statusLabelForEvent(it))} ${carryoverBadgeHtml(it)}</span>
          <small>${escapeHtml(majorReasonText(it) || "významná událost")}</small>
        </div>
        <div>${alarmLevelBadge(it)} <button type="button" class="btn miniBtn adminOnly majorManualEditBtn" data-event-id="${escapeHtml(it.id || "")}">Edit</button></div>
      </div>
    `;
  }).join("");
  bindMajorManualButtons();
}




function bindInlineTableEditButtons() {
  document.querySelectorAll(".tableManualEditBtn").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const id = btn.getAttribute("data-event-id");
      if (id) openManualEventEditor(id);
    });
  });
}




function eventDetailButtonHtml(it) {
  const id = escapeHtml(it?.id || "");
  if (!id) return "";
  return `<button type="button" class="linkBtn eventDetailBtn" data-event-id="${id}">detail</button>`;
}

function detailDateText(value) {
  if (!value) return "—";
  try { return formatDate(value); } catch { return String(value); }
}

function eventDetailLine(label, value) {
  return `<div class="eventDetailLine"><span>${escapeHtml(label)}</span><b>${escapeHtml(value || "—")}</b></div>`;
}

function tableEditButtonHtml(it) {
  if (!isCurrentUserAdmin || !isCurrentUserAdmin()) return "";
  const id = escapeHtml(it?.id || "");
  if (!id) return "";
  return `<button type="button" class="btn miniBtn tableManualEditBtn" data-event-id="${id}">Upravit</button>`;
}


function durationBadgeHtml(it) {
  // Původ délky (RSS / sledováno / odhad) je interní informace.
  // Nezobrazuje se ve veřejném přehledu ani běžně adminovi.
  return "";
}

function renderTable(items) {
  const tbody = document.getElementById("eventsTbody");
  if (!tbody) return;

  tbody.innerHTML = "";

  const safeItems = Array.isArray(items) ? items : [];

  for (const it of safeItems) {
    const meta = typeMeta(it.event_type);
    const tr = document.createElement("tr");

    if (typeof isMajorEventItem === "function" && isMajorEventItem(it)) {
      tr.classList.add("majorEventRow");
    }

    const timeValue = it.pub_date || it.start_time_iso || it.created_at || "";
    const title = it.title || "";
    const city = it.city_text || it.place_text || "";
    const statusText = typeof statusLabelForEvent === "function"
      ? statusLabelForEvent(it)
      : (it.is_closed ? "ukončená" : "aktivní");

    const alarmHtml = typeof alarmLevelBadge === "function" ? (alarmLevelBadge(it) || "") : "";
    const carryHtml = typeof carryoverBadgeHtml === "function" ? (carryoverBadgeHtml(it) || "") : "";
    const durationValue = typeof liveDurationForEvent === "function" ? liveDurationForEvent(it) : it.duration_min;

    tr.innerHTML = `
      <td>${escapeHtml(formatDate(timeValue))}</td>
      <td title="${escapeHtml(meta.label || it.event_type || "")}">${escapeHtml(meta.emoji || "")}</td>
      <td>${escapeHtml(title)}</td>
      <td>${escapeHtml(city)}</td>
      <td>${statusEmoji(it.is_closed)} ${escapeHtml(statusText)} ${carryHtml}</td>
      <td>${alarmHtml}</td>
      <td>${escapeHtml(formatDuration(durationValue))}</td>
      <td>${eventDetailButtonHtml(it)}</td>
      <td>${tableEditButtonHtml(it)}</td>
    `;

    tbody.appendChild(tr);
  }

  const info = document.getElementById("eventsTableCountInfo");
  if (info) {
    const total = Number(latestEventsTotalMatching || safeItems.length || 0);
    const shown = safeItems.length;
    info.textContent = total > shown
      ? `Zobrazeno ${shown} z ${total} událostí podle aktuálních filtrů.`
      : `Zobrazeno ${shown} událostí podle aktuálních filtrů.`;
  }

  bindInlineTableEditButtons();
  syncAdminVisibility?.();
}
function makeEventIcon(eventType, it = null) {
  const meta = typeMeta(eventType);
  return L.divIcon({
    className: `fw-emoji-wrap ${meta.cls} ${isMajorEventItem(it) ? "fw-major-marker" : ""}`,
    html: `<div class="fw-emoji">${isMajorEventItem(it) ? "🚨" : meta.emoji}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function renderMap(items) {
  markersLayer.clearLayers();

  const pts = [];
  for (const it of items) {
    if (!hasValidCoords(it)) continue;
    const marker = L.marker([Number(it.lat), Number(it.lon)], { icon: makeEventIcon(it.event_type, it) });
    marker.bindPopup(`
      <b>${escapeHtml(it.title)}</b><br>
      <span style="opacity:.85">${escapeHtml(it.city_text || it.place_text || "")}</span><br>
      <span style="opacity:.75">${statusEmoji(it.is_closed)} ${it.is_closed ? "ukončená" : "aktivní"}</span><br>
      <a href="${escapeHtml(it.link)}" target="_blank" rel="noopener">detail</a>
    `);
    marker.addTo(markersLayer);
    pts.push([Number(it.lat), Number(it.lon)]);
  }

  if (pts.length > 0) {
    // nezoomuj úplně agresivně (ať to neskáče)
    // map.fitBounds(pts, { padding: [24, 24] });
  }
}

function safeInvalidateMap() {
  try { map.invalidateSize(); } catch { /* ignore */ }
}

function renderChart(byDay) {
  const ctx = document.getElementById("chartByDay");
  if (!ctx) return;

  const labels = (byDay || []).map(x => x.day);
  const data = (byDay || []).map(x => x.count);

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update();
    return;
  }

  chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Výjezdy",
        data
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: "#c8d2e3" } },
        y: { ticks: { color: "#c8d2e3" }, beginAtZero: true }
      }
    }
  });
}

function renderCounts(openCount, closedCount) {
  document.getElementById("openCount").textContent = String(openCount ?? "—");
  document.getElementById("closedCount").textContent = String(closedCount ?? "—");
}

function renderTopCities(list) {
  const wrap = document.getElementById("topCities");
  wrap.innerHTML = "";
  for (const it of list) {
    const div = document.createElement("div");
    div.className = "listItem";
    div.innerHTML = `<b>${escapeHtml(it.city)}</b><span>${escapeHtml(it.count)}×</span>`;
    wrap.appendChild(div);
  }
}

function renderLongest(list) {
  const wrap = document.getElementById("longestList");
  wrap.innerHTML = "";
  for (const it of list) {
    const div = document.createElement("div");
    div.className = "listItem";
    div.innerHTML = `<b>${escapeHtml(it.city || it.place_text || "")}</b><span>${escapeHtml(formatDuration(it.duration_min))}</span>`;
    wrap.appendChild(div);
  }
}

// ==============================
// SIMULACE VÝJEZDU HZS (ETA)
// ==============================

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const aa = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

async function osrmRoute(from, to) {
  const url = `${OSRM_BASE}/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&alternatives=false&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("OSRM failed");
  const j = await res.json();
  const r = j?.routes?.[0];
  if (!r) throw new Error("No route");
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  return { coords, duration_s: r.duration, distance_m: r.distance };
}

function pickStationsWithin20km(eventLat, eventLon) {
  const out = [];
  for (const s of hzsStations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const km = haversineKm(eventLat, eventLon, s.lat, s.lon);
    if (km <= MAX_STATION_AIR_KM) out.push({ station: s, km });
  }
  out.sort((a, b) => a.km - b.km);
  return out;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function pickAnimMsFromEta(eta_s) {
  // ETA reálně, animace zrychleně: (eta / speedup) ohraničená min/max
  const ms = (eta_s * 1000) / ANIM_SPEEDUP;
  return clamp(ms, ANIM_MIN_MS, ANIM_MAX_MS);
}

function makeVehicleIcon() {
  return L.divIcon({
    className: "fw-emoji-wrap",
    html: `<div class="fw-emoji" title="Simulované vozidlo">🚒</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}


// --- Simulation helpers: more realistic movement (slow down on curves) ---
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const lat1 = toRad(a[0]), lon1 = toRad(a[1]);
  const lat2 = toRad(b[0]), lon2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}


function bearingDeg(a, b) {
  // bearing from point a to b (degrees, 0 = north)
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLon = toRad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = Math.atan2(y, x);
  return (toDeg(brng) + 360) % 360;
}


function turnSeverity(prev, cur, next) {
  // returns 0..1 (0 = straight, 1 = sharp turn)
  try {
    const v1x = cur[1] - prev[1];
    const v1y = cur[0] - prev[0];
    const v2x = next[1] - cur[1];
    const v2y = next[0] - cur[0];

    const n1 = Math.hypot(v1x, v1y);
    const n2 = Math.hypot(v2x, v2y);
    if (n1 === 0 || n2 === 0) return 0;

    const dot = (v1x * v2x + v1y * v2y) / (n1 * n2);
    const c = clamp(dot, -1, 1);
    // 1 - cos(theta): 0..2
    const sev = (1 - c) / 2; // normalize to 0..1
    return clamp(sev, 0, 1);
  } catch {
    return 0;
  }
}


function buildRouteTiming(coords) {
  // Builds a per-segment time profile to make motion feel more realistic:
  // - slows down in sharp turns
  // - respects simple accel/decel limits (forward/backward pass)
  //
  // Returns:
  //  - coords: original coords
  //  - cdf: cumulative "time weights" at each point (seconds, relative)
  //  - segW: per-segment time weight (seconds, relative)
  //  - totalW: total time weight
  const pts = Array.isArray(coords) ? coords : [];
  const n = pts.length;
  if (n <= 1) return { coords: pts, cdf: [0], segW: [0], totalW: 1 };

  // --- Tunables (feel) ---
  const BASE_V = 22;        // m/s ~ 80 km/h on straights (relative)
  const MIN_V = 6;          // m/s ~ 22 km/h minimum (tight turns / town)
  const TURN_K = 0.75;      // how much turns reduce vmax (0..1)
  const A = 1.8;            // m/s^2 accel/decel limit (comfort)
  const MIN_DIST = 1;       // meters (avoid zeros)

  // Distances between points
  const dist = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    dist[i] = Math.max(MIN_DIST, haversineMeters(pts[i - 1], pts[i]));
  }

  // Max speed at each point based on local curvature (turn severity)
  const vmax = new Array(n).fill(BASE_V);
  vmax[0] = BASE_V;
  vmax[n - 1] = BASE_V;
  for (let i = 1; i < n - 1; i++) {
    const sev = turnSeverity(pts[i - 1], pts[i], pts[i + 1]); // 0..1
    // Reduce speed in turns. sev=0 => BASE_V, sev=1 => BASE_V*(1-TURN_K)
    const v = BASE_V * (1 - TURN_K * sev);
    vmax[i] = clamp(v, MIN_V, BASE_V);
  }

  // Apply accel constraints: forward + backward pass (classic speed profile)
  const v = vmax.slice();
  // Forward pass (accel)
  for (let i = 1; i < n; i++) {
    const vReach = Math.sqrt(Math.max(0, v[i - 1] * v[i - 1] + 2 * A * dist[i]));
    v[i] = Math.min(v[i], vReach);
  }
  // Backward pass (decel)
  for (let i = n - 2; i >= 0; i--) {
    const vReach = Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * A * dist[i + 1]));
    v[i] = Math.min(v[i], vReach);
  }

  // Segment time weights (seconds, relative). Use trapezoid v_avg.
  const segW = new Array(n).fill(0);
  const cdf = new Array(n).fill(0);
  let sum = 0;
  for (let i = 1; i < n; i++) {
    const vAvg = Math.max(0.5, (v[i - 1] + v[i]) / 2);
    const dt = dist[i] / vAvg;
    segW[i] = dt;
    sum += dt;
    cdf[i] = sum;
  }

  const totalW = sum > 0 ? sum : 1;
  return { coords: pts, cdf, segW, totalW };
}


function binarySearchCdf(cdf, x) {
  // returns index in coords for a given cumulative weight x
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function stopSimulation(eventId) {
  const sim = runningSims.get(eventId);
  if (!sim) return;
  try { sim.stop?.(); } catch {}
  try { vehiclesLayer.removeLayer(sim.vehicleMarker); } catch {}
  try { routesLayer.removeLayer(sim.routeLine); } catch {}
  runningSims.delete(eventId);
}

function stopAllSims() {
  for (const id of [...runningSims.keys()]) stopSimulation(id);
}

function updateSimsFromItems(items) {
  // ukončené už nesimulujeme
  const openIds = new Set(items.filter(x => !x.is_closed).map(x => x.id));

  // stop sims které už nejsou open
  for (const id of [...runningSims.keys()]) {
    if (!openIds.has(id)) stopSimulation(id);
  }

  // start sims pro nové open události (od načtení stránky)
  for (const it of items) {
    if (it.is_closed) continue;
    if (!it.id) continue;
    if (!hasValidCoords(it)) continue;

    // viděli jsme už? (jen nové)
    if (seenEventIds.has(it.id)) continue;

    seenEventIds.add(it.id);

    // 🔊 OPS audio: NOVÁ + AKTIVNÍ událost = jen hlas (bez gongu)
    audioOnNewEvent?.(it);

    queueSimulation(it);
  }
}

async function startSimulationForEvent(ev) {
  if (runningSims.has(ev.id)) return;

  try {
    await stationsReadyPromise; // počkej na stanice (geocoding)
    const candidates = pickStationsWithin20km(ev.lat, ev.lon);
    if (candidates.length === 0) return;

    // vyber nejrychlejší ETA mezi kandidáty (OSRM)
    let best = null;
    for (const c of candidates.slice(0, 10)) { // limit kvůli requestům
      try {
        const r = await osrmRoute([c.station.lat, c.station.lon], [Number(ev.lat), Number(ev.lon)]);
        if (!best || r.duration_s < best.route.duration_s) {
          best = { station: c.station, route: r };
        }
      } catch {
        // ignore
      }
    }

    if (!best) return;

    // route line
    const line = L.polyline(best.route.coords, {
      weight: 4,
      opacity: 0.75
    }).addTo(routesLayer);

    const vehicle = L.marker(best.route.coords[0], { icon: makeVehicleIcon() }).addTo(vehiclesLayer);

    const animMs = pickAnimMsFromEta(best.route.duration_s);

    // build a more realistic time profile (slow down on curves)
    const timing = buildRouteTiming(best.route.coords);

    let start = null;
    let rafId = null;

    const step = (ts) => {
      if (!start) start = ts;
      const p = clamp((ts - start) / animMs, 0, 1);

      // map progress -> route position using timing weights (time profile)
      const target = p * timing.totalW;
      const i = binarySearchCdf(timing.cdf, target);
      if (i <= 0) {
        vehicle.setLatLng(timing.coords[0]);
      } else {
        const t0 = timing.cdf[i - 1];
        const dt = timing.segW[i] || (timing.cdf[i] - t0) || 1;
        const s = clamp((target - t0) / dt, 0, 1);

        // smooth within segment for nicer accel/decel feel
        const ss = s * s * (3 - 2 * s); // smoothstep

        const a = timing.coords[i - 1];
        const b = timing.coords[i];
        const lat = a[0] + (b[0] - a[0]) * ss;
        const lon = a[1] + (b[1] - a[1]) * ss;
        vehicle.setLatLng([lat, lon]);

        // optional: rotate icon to heading (works for divIcon)
        try {
          const brg = bearingDeg(a, b);
          const el = vehicle.getElement && vehicle.getElement();
          const inner = el ? el.querySelector('.fw-emoji') : null;
          if (inner) inner.style.transform = `rotate(${brg}deg)`;
        } catch {}
      }

      if (p < 1) rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);

    const stop = () => {
      if (rafId) cancelAnimationFrame(rafId);
    };

    runningSims.set(ev.id, {
      vehicleMarker: vehicle,
      routeLine: line,
      stop
    });
  } finally {
      }
}

// ==============================
// DATA LOAD
// ==============================

async function loadAll(options = {}) {
  if (inFlight) return;
  inFlight = true;

  const isAutoRefresh = options?.auto === true;

  try {
    if (!isAutoRefresh) setStatus("načítám…", true);

    const filters = getFiltersFromUi();
    const qEvents = buildEventsQuery(filters);
    const qStats = buildStatsQuery(filters);

    const [eventsRes, statsRes] = await Promise.all([
      fetch(`/api/events${qEvents ? `?${qEvents}&_=${Date.now()}` : `?_=${Date.now()}`}`, { cache: "no-store" }),
      fetch(`/api/stats${qStats ? `?${qStats}&_=${Date.now()}` : `?_=${Date.now()}`}`, { cache: "no-store" })
    ]);

    if (!eventsRes.ok || !statsRes.ok) throw new Error("bad http");

    let eventsJson = await eventsRes.json();
    const statsJson = await statsRes.json();

    let usedCityDayFallback = false;
    if ((!eventsJson.items || eventsJson.items.length === 0) && filters.city && (filters.day === "today" || filters.day === "yesterday")) {
      const fallbackFilters = { ...filters, day: "all" };
      const qFallback = buildEventsQuery(fallbackFilters);
      const fallbackRes = await fetch(`/api/events${qFallback ? `?${qFallback}&_=${Date.now()}` : `?_=${Date.now()}`}`, { cache: "no-store" });
      if (fallbackRes.ok) {
        const fallbackJson = await fallbackRes.json();
        if (fallbackJson.items && fallbackJson.items.length > 0) {
          eventsJson = fallbackJson;
          usedCityDayFallback = true;
        }
      }
    }

    const items = Array.isArray(eventsJson.items) ? eventsJson.items : [];
    latestEventsTotalMatching = Number(eventsJson.total_matching || items.length || 0);

    // Ochrana proti „vynulování“ obrazovky:
    // pokud auto-refresh vrátí prázdno, ale předtím jsme měli funkční data,
    // nepřepíšeme mapu/tabulku/grafy prázdným stavem.
    if (isAutoRefresh && items.length === 0 && lastGoodItemsSnapshot.length > 0) {
      const ageMin = Math.round((Date.now() - lastGoodLoadAt) / 60000);
      setStatus(`OK • ponechána poslední data (${lastGoodItemsSnapshot.length} záznamů, ${ageMin} min)`, true);
      return;
    }

    // snapshot pro audio souhrn
    latestItemsSnapshot = items;
    latestStatsSnapshot = statsJson;
    window.latestItemsSnapshot = items;
    window.latestStatsSnapshot = statsJson;

    if (items.length > 0) {
      lastGoodItemsSnapshot = items;
      lastGoodStatsSnapshot = statsJson;
      lastGoodLoadAt = Date.now();
    }

    renderTable(items);
    renderMajorEvents(items);
    updateCommandOverview(items, statsJson);
    renderMap(items);

    // ✅ simulace výjezdu HZS (jen NOVÉ + AKTIVNÍ)
    updateSimsFromItems(items);

    renderChart(statsJson.byDay || []);
    renderCounts(statsJson.openCount, statsJson.closedCount);
    if (typeof renderActiveClosedTypeBreakdown === "function") {
      renderActiveClosedTypeBreakdown(items);
    }
    renderTopCities(statsJson.topCities || []);
    renderLongest(statsJson.longest || []);

    const missing = items.filter(x => !hasValidCoords(x)).length;
    setStatus(`OK • ${items.length} záznamů • bez souřadnic ${missing}${usedCityDayFallback ? " • město zobrazeno ze všech dnů" : ""}`, true);
  } catch (e) {
    console.warn("[loadAll] refresh failed:", e);

    // Při chybě refreshu zachovej poslední dobrá data, ať web nespadne do prázdna.
    if (lastGoodItemsSnapshot.length > 0) {
      const ageMin = Math.round((Date.now() - lastGoodLoadAt) / 60000);
      setStatus(`OK • ponechána poslední data (${lastGoodItemsSnapshot.length} záznamů, ${ageMin} min)`, true);
    } else {
      setStatus("chyba načítání", false);
    }
  } finally {
    inFlight = false;
  }
}

function resetFilters() {
  const dayEl = document.getElementById("daySelect");
  if (dayEl) dayEl.value = "today";
  document.getElementById("typeSelect").value = "";
  document.getElementById("cityInput").value = "";
  document.getElementById("statusSelect").value = "all";
  const monthEl = document.getElementById("monthInput");
  if (monthEl) monthEl.value = "";
}

function exportWithFilters(kind) {
  const filters = getFiltersFromUi();
  const q = buildExportQuery(filters);
  const url = kind === "pdf"
    ? `/api/export.pdf${q ? `?${q}` : ""}`
    : `/api/export.csv${q ? `?${q}` : ""}`;
  window.open(url, "_blank");
}




function setReportsMessage(text, isError = false) {
  const detail = document.getElementById("reportDetail");
  if (!detail) return;
  detail.innerHTML = `<div class="${isError ? "err" : "muted"}">${escapeHtml(String(text || ""))}</div>`;
}

// ==============================
// ARCHIV ANALYTICKÝCH SOUHRNŮ
// ==============================

function defaultReportKey(type) {
  const d = new Date();
  if (type === "day") {
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (type === "week") {
    const tmp = new Date(d);
    tmp.setDate(tmp.getDate() - 7);
    const onejan = new Date(tmp.getFullYear(), 0, 1);
    const week = Math.ceil((((tmp - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return `${tmp.getFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function reportTypeName(type) {
  if (type === "month") return "měsíční";
  if (type === "week") return "týdenní";
  if (type === "day") return "denní";
  return type;
}

async function loadReportsArchive() {
  const box = document.getElementById("reportsList");
  if (!box) return;

  box.innerHTML = `<div class="muted">Načítám archiv…</div>`;

  try {
    const r = await fetch("/api/reports?limit=80", { cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "reports failed");

    const reports = j.reports || [];
    if (!reports.length) {
      box.innerHTML = `<div class="muted">Zatím není uložený žádný souhrn. Klikni na „Doplnit automatiku“ nebo vygeneruj konkrétní období.</div>`;
      return;
    }

    box.innerHTML = reports.map(rep => `
      <button class="reportItem" data-report-type="${escapeHtml(rep.period_type)}" data-report-key="${escapeHtml(rep.period_key)}">
        <span>
          <b>${escapeHtml(rep.title || rep.period_key)}</b>
          <small>${escapeHtml(reportTypeName(rep.period_type))} • ${escapeHtml(rep.period_start || "")} – ${escapeHtml(rep.period_end || "")}</small>
        </span>
        <span class="reportItemNums">${Number(rep.total_events || 0)} událostí</span>
      </button>
    `).join("");

    box.querySelectorAll(".reportItem").forEach(btn => {
      btn.addEventListener("click", () => openReportDetail(btn.dataset.reportType, btn.dataset.reportKey));
    });
  } catch (e) {
    box.innerHTML = `<div class="err">Archiv souhrnů se nepodařilo načíst.</div>`;
  }
}

function renderReportDetail(rep) {
  const box = document.getElementById("reportDetail");
  if (!box || !rep) return;

  const d = rep.data || {};
  box.innerHTML = `
    <div class="reportDetailHead">
      <div>
        <h3>${escapeHtml(rep.title || "Souhrn")}</h3>
        <p>${escapeHtml(rep.period_start || "")} – ${escapeHtml(rep.period_end || "")}</p>
      </div>
      <div class="btnRow">
        <a class="btn primary" target="_blank" href="/api/reports/${encodeURIComponent(rep.period_type)}/${encodeURIComponent(rep.period_key)}.pdf">Export PDF / tisk</a>
        <button class="btn" onclick="window.print()">Tisk stránky</button>
      </div>
    </div>

    <p class="reportSummary">${escapeHtml(d.summary || "")}</p>

    <div class="reportKpis">
      <div><span>Celkem</span><b>${Number(rep.total_events || 0)}</b></div>
      <div><span>Aktivní</span><b>${Number(rep.open_count || 0)}</b></div>
      <div><span>Ukončené</span><b>${Number(rep.closed_count || 0)}</b></div>
      <div><span>Bez GPS</span><b>${Number(rep.missing_coords_count || 0)}</b></div>
      <div><span>Průměr / den</span><b>${Number(d.avg_per_day || 0)}</b></div>
    </div>

    <div class="reportColumns">
      <div class="reportPanel">
        <h4>Typy událostí</h4>
        ${(d.type_stats || []).slice(0, 12).map(x => `<div class="reportRow"><span>${escapeHtml(x.name)}</span><b>${x.count} (${x.percent} %)</b></div>`).join("") || "<p class='muted'>Bez dat</p>"}
      </div>
      <div class="reportPanel">
        <h4>TOP města</h4>
        ${(d.top_cities || []).slice(0, 12).map(x => `<div class="reportRow"><span>${escapeHtml(x.name)}</span><b>${x.count}</b></div>`).join("") || "<p class='muted'>Bez dat</p>"}
      </div>
      <div class="reportPanel">
        <h4>Nejvytíženější dny</h4>
        ${(d.busiest_days || []).slice(0, 10).map(x => `<div class="reportRow"><span>${escapeHtml(x.day)}</span><b>${x.count}</b></div>`).join("") || "<p class='muted'>Bez dat</p>"}
      </div>
      <div class="reportPanel">
        <h4>Nejdelší zásahy</h4>
        ${(d.longest || []).slice(0, 10).map(x => `<div class="reportLong"><b>${escapeHtml(x.duration_text || "")}</b><span>${escapeHtml(x.date || "")} • ${escapeHtml(x.type || "")} • ${escapeHtml(x.city || "")}<br>${escapeHtml(x.title || "")}</span></div>`).join("") || "<p class='muted'>Bez dat</p>"}
      </div>
    </div>
  `;
}

async function openReportDetail(type, key) {
  const box = document.getElementById("reportDetail");
  if (box) box.innerHTML = `<div class="muted">Načítám souhrn…</div>`;

  try {
    const r = await fetch(`/api/reports/${encodeURIComponent(type)}/${encodeURIComponent(key)}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "report detail failed");
    renderReportDetail(j.report);
  } catch (e) {
    if (box) box.innerHTML = `<div class="err">Souhrn se nepodařilo otevřít.</div>`;
  }
}

async function generateSelectedReport() {
  const typeEl = document.getElementById("reportTypeSelect");
  const keyEl = document.getElementById("reportKeyInput");
  if (!typeEl || !keyEl) return;

  const type = typeEl.value;
  const key = keyEl.value.trim() || defaultReportKey(type);
  keyEl.value = key;

  try {
    const r = await fetch("/api/reports/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, key, force: true })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "generate failed");
    await loadReportsArchive();
    renderReportDetail(j.report);
  } catch (e) {
    alert("Souhrn se nepodařilo vygenerovat: " + (e.message || e));
  }
}

async function runReportsAutomationNow() {
  try {
    const r = await fetch("/api/reports/automation/run", { method: "POST" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "automation failed");
    await loadReportsArchive();
  } catch (e) {
    alert("Automatika souhrnů se nepodařila spustit: " + (e.message || e));
  }
}

function wireReportsArchive() {
  const typeEl = document.getElementById("reportTypeSelect");
  const keyEl = document.getElementById("reportKeyInput");

  if (typeEl && keyEl) {
    keyEl.value = keyEl.value || defaultReportKey(typeEl.value);
    typeEl.addEventListener("change", () => {
      keyEl.value = defaultReportKey(typeEl.value);
    });
  }

  document.getElementById("refreshReportsBtn")?.addEventListener("click", loadReportsArchive);
  document.getElementById("generateReportBtn")?.addEventListener("click", generateSelectedReport);
  document.getElementById("runReportsAutomationBtn")?.addEventListener("click", runReportsAutomationNow);

  loadReportsArchive();
}



// ==============================
// LANDING PAGE / PUBLIC PRESENTATION
// ==============================

const LS_LANDING_DISMISSED = "fwcz_landingDismissed";

function setLandingVisible(visible) {
  const landing = document.getElementById("landingPage");
  if (!landing) return;
  landing.style.display = visible ? "" : "none";
  document.body.classList.toggle("landingVisible", visible);
}

function showLandingPage() {
  localStorage.removeItem(LS_LANDING_DISMISSED);
  setLandingVisible(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openDashboardFromLanding() {
  localStorage.setItem(LS_LANDING_DISMISSED, "1");
  setLandingVisible(false);

  const filters = document.querySelector(".filters");
  if (filters) {
    filters.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function initLandingPage() {
  const shouldHide = localStorage.getItem(LS_LANDING_DISMISSED) === "1";
  setLandingVisible(!shouldHide);

  document.getElementById("landingDashboardBtn")?.addEventListener("click", openDashboardFromLanding);
  document.getElementById("landingHomeBtn")?.addEventListener("click", showLandingPage);

  document.getElementById("landingLoginBtn")?.addEventListener("click", () => {
    openDashboardFromLanding();
    document.getElementById("loginBtn")?.click();
  });

  document.getElementById("landingRegisterBtn")?.addEventListener("click", () => {
    openDashboardFromLanding();
    document.getElementById("registerBtn")?.click();
  });
}




// ==============================
// FireWatchCZ Web v1.5 – Statistiky PRO
// ==============================

function signText(n) {
  const num = Number(n || 0);
  if (num > 0) return `+${num}`;
  return String(num);
}

function signClass(n) {
  const num = Number(n || 0);
  if (num > 0) return "up";
  if (num < 0) return "down";
  return "same";
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function renderStatsPro(stats) {
  const summary = document.getElementById("statsProSummary");
  const typeBox = document.getElementById("statsProTypeTrend");
  const cityBox = document.getElementById("statsProCityGrowth");
  const hoursBox = document.getElementById("statsProHours");
  const heatBox = document.getElementById("statsProHeatmap");

  if (summary) {
    summary.innerHTML = `
      <div class="statsProKpi">
        <span>Aktuální období</span>
        <b>${Number(stats.current?.total || 0)}</b>
        <small>${escapeHtml(stats.current?.start || "")} – ${escapeHtml(stats.current?.end || "")}</small>
      </div>
      <div class="statsProKpi">
        <span>Předchozí období</span>
        <b>${Number(stats.previous?.total || 0)}</b>
        <small>${escapeHtml(stats.previous?.start || "")} – ${escapeHtml(stats.previous?.end || "")}</small>
      </div>
      <div class="statsProKpi ${signClass(stats.comparison?.diff)}">
        <span>Rozdíl</span>
        <b>${signText(stats.comparison?.diff || 0)}</b>
        <small>${Number(stats.comparison?.diffPercent || 0)} %</small>
      </div>
      <div class="statsProKpi">
        <span>Aktivní / ukončené</span>
        <b>${Number(stats.current?.open || 0)} / ${Number(stats.current?.closed || 0)}</b>
        <small>Bez GPS: ${Number(stats.current?.missingCoords || 0)}</small>
      </div>
      <div class="statsProKpi">
        <span>Nejaktivnější hodina</span>
        <b>${formatHour(stats.busiestHour?.hour || 0)}</b>
        <small>${Number(stats.busiestHour?.count || 0)} událostí</small>
      </div>
    `;
  }

  if (typeBox) {
    const rows = stats.typeTrend || [];
    typeBox.innerHTML = rows.length ? rows.map(x => `
      <div class="statsProRow">
        <span>${escapeHtml(x.name)}</span>
        <b>${Number(x.current || 0)}</b>
        <em class="${signClass(x.diff)}">${signText(x.diff)} / ${Number(x.percent || 0)} %</em>
      </div>
    `).join("") : `<div class="muted">Bez dat</div>`;
  }

  if (cityBox) {
    const rows = stats.cityGrowth || [];
    cityBox.innerHTML = rows.length ? rows.map(x => `
      <div class="statsProRow">
        <span>${escapeHtml(x.name)}</span>
        <b>${Number(x.current || 0)}</b>
        <em class="${signClass(x.diff)}">${signText(x.diff)}</em>
      </div>
    `).join("") : `<div class="muted">Bez dat</div>`;
  }

  if (hoursBox) {
    const rows = stats.hourStats || [];
    const max = Math.max(1, ...rows.map(x => Number(x.count || 0)));
    hoursBox.innerHTML = rows.map(x => `
      <div class="hourBar" title="${formatHour(x.hour)} – ${Number(x.count || 0)} událostí">
        <span>${String(x.hour).padStart(2, "0")}</span>
        <i style="height:${Math.max(4, Math.round((Number(x.count || 0) / max) * 92))}%"></i>
        <b>${Number(x.count || 0)}</b>
      </div>
    `).join("");
  }

  if (heatBox) {
    const rows = stats.heatmap || [];
    const max = Math.max(1, ...rows.map(x => Number(x.count || 0)));
    heatBox.innerHTML = rows.map(x => {
      const count = Number(x.count || 0);
      const level = count <= 0 ? 0 : Math.max(1, Math.ceil((count / max) * 5));
      return `<div class="heatCell level${level}" title="${escapeHtml(x.day)} – ${count} událostí">
        <span>${escapeHtml(String(x.day || "").slice(8, 10))}</span>
        <b>${count}</b>
      </div>`;
    }).join("");
  }
}

async function loadStatsPro() {
  const preset = document.getElementById("statsProPreset")?.value || "month";
  const btn = document.getElementById("loadStatsProBtn");
  const old = btn?.textContent || "Načíst PRO statistiky";
  const summary = document.getElementById("statsProSummary");
  const typeBox = document.getElementById("statsProTypeTrend");
  const cityBox = document.getElementById("statsProCityGrowth");
  const hoursBox = document.getElementById("statsProHours");
  const heatBox = document.getElementById("statsProHeatmap");

  if (summary) summary.innerHTML = `<div class="statsProLoading">Načítám PRO statistiky…</div>`;
  if (typeBox) typeBox.innerHTML = `<div class="muted">Načítám…</div>`;
  if (cityBox) cityBox.innerHTML = `<div class="muted">Načítám…</div>`;
  if (hoursBox) hoursBox.innerHTML = `<div class="muted">Načítám…</div>`;
  if (heatBox) heatBox.innerHTML = `<div class="muted">Načítám…</div>`;

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Načítám…";
    }

    const r = await fetch(`/api/stats/pro?preset=${encodeURIComponent(preset)}&_=${Date.now()}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "stats pro failed");

    renderStatsPro(j.stats);
  } catch (e) {
    const summary = document.getElementById("statsProSummary");
    if (summary) summary.innerHTML = `<div class="err">Statistiky PRO se nepodařilo načíst: ${escapeHtml(String(e.message || e))}</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

function wireStatsPro() {
  document.getElementById("loadStatsProBtn")?.addEventListener("click", loadStatsPro);
  document.getElementById("statsProPreset")?.addEventListener("change", loadStatsPro);
  loadStatsPro();
}



// ==============================
// FireWatchCZ Web v1.6 – Notifikace a odběry
// ==============================

const FW_WATCH_SETTINGS_KEY = "fwcz_watchSettings_v1";
const FW_WATCH_SEEN_KEY = "fwcz_watchSeenEvents_v1";
const FW_WATCH_HISTORY_KEY = "fwcz_watchHistory_v1";

const FW_TYPE_ALIASES = {
  fire: ["fire", "požár", "pozar"],
  traffic: ["traffic", "dopravní", "nehoda", "dn"],
  tech: ["tech", "technická", "technicka"],
  rescue: ["rescue", "záchrana", "zachrana"],
  false_alarm: ["false_alarm", "planý", "plany", "poplach"],
  other: ["other", "jiné", "jine"]
};

function loadWatchSettings() {
  try {
    return JSON.parse(localStorage.getItem(FW_WATCH_SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveWatchSettings(settings) {
  localStorage.setItem(FW_WATCH_SETTINGS_KEY, JSON.stringify(settings || {}));
}

function loadWatchSeen() {
  try {
    const arr = JSON.parse(localStorage.getItem(FW_WATCH_SEEN_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveWatchSeen(set) {
  const arr = [...set].slice(-500);
  localStorage.setItem(FW_WATCH_SEEN_KEY, JSON.stringify(arr));
}

function loadWatchHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(FW_WATCH_HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveWatchHistory(arr) {
  localStorage.setItem(FW_WATCH_HISTORY_KEY, JSON.stringify((arr || []).slice(0, 30)));
}

function normalizeWatchText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function eventTypeKey(ev) {
  const raw = normalizeWatchText(ev.event_type || ev.type || ev.kind || ev.category || ev.title || "");
  for (const [key, aliases] of Object.entries(FW_TYPE_ALIASES)) {
    if (aliases.some(a => raw.includes(normalizeWatchText(a)))) return key;
  }
  return "other";
}

function eventCityText(ev) {
  return String(ev.city_text || ev.place_text || ev.city || ev.place || ev.title || "");
}

function watchEventMatches(ev, settings) {
  if (!settings || settings.enabled === false) return false;

  const cities = Array.isArray(settings.cities) ? settings.cities : [];
  const types = Array.isArray(settings.types) ? settings.types : [];

  const cityOk = !cities.length || cities.some(city => {
    const wanted = normalizeWatchText(city);
    const hay = normalizeWatchText(`${eventCityText(ev)} ${ev.title || ""}`);
    return wanted && hay.includes(wanted);
  });

  const typeKey = eventTypeKey(ev);
  const typeOk = !types.length || types.includes(typeKey);

  return cityOk && typeOk;
}

function watchNotificationTitle(ev) {
  const type = fwPrettyType?.(ev.event_type || ev.type || "other") || "událost";
  return `Nová událost: ${String(type).replace(/^[^\s]+\s*/, "")}`;
}

function watchNotificationBody(ev) {
  const city = ev.city_text || ev.place_text || "neznámé místo";
  return `${ev.title || "Nová událost"}\n${city}`;
}

async function requestBrowserNotifications() {
  if (!("Notification" in window)) {
    setWatchMsg("Tento prohlížeč nepodporuje webové notifikace.", false);
    return false;
  }

  if (Notification.permission === "granted") {
    setWatchMsg("Notifikace jsou povolené.", true);
    return true;
  }

  if (Notification.permission === "denied") {
    setWatchMsg("Notifikace jsou v prohlížeči zakázané. Povol je v nastavení webu/prohlížeče.", false);
    return false;
  }

  const result = await Notification.requestPermission();
  const ok = result === "granted";
  setWatchMsg(ok ? "Notifikace povoleny." : "Notifikace nebyly povoleny.", ok);
  return ok;
}

function showWatchBrowserNotification(ev) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const n = new Notification(watchNotificationTitle(ev), {
    body: watchNotificationBody(ev),
    tag: `fwcz-event-${ev.id || ev.link || ev.title}`,
    renotify: false,
    icon: "/favicon.ico"
  });

  n.onclick = () => {
    window.focus();
    try {
      document.getElementById("eventsTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {}
    n.close();
  };
}

function setWatchMsg(text, ok = true) {
  const el = document.getElementById("watchMsg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = ok ? "rgba(120,255,180,0.9)" : "rgba(255,140,140,0.95)";
}

function readWatchForm() {
  const citiesRaw = document.getElementById("watchCitiesInput")?.value || "";
  const cities = citiesRaw
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  const types = [...document.querySelectorAll(".watchTypeCheck:checked")]
    .map(x => x.value);

  return {
    enabled: true,
    cities,
    types,
    savedAt: new Date().toISOString()
  };
}

function fillWatchForm(settings) {
  const cityInput = document.getElementById("watchCitiesInput");
  if (cityInput) cityInput.value = (settings.cities || []).join(", ");

  document.querySelectorAll(".watchTypeCheck").forEach(ch => {
    ch.checked = Array.isArray(settings.types) && settings.types.includes(ch.value);
  });
}

function renderWatchSummary() {
  const settings = loadWatchSettings();
  const box = document.getElementById("watchSummary");
  if (!box) return;

  const cities = settings.cities?.length ? settings.cities.join(", ") : "všechna města";
  const types = settings.types?.length
    ? settings.types.map(t => {
        if (t === "fire") return "🔥 požár";
        if (t === "traffic") return "🚗 dopravní nehoda";
        if (t === "tech") return "🛠 technická pomoc";
        if (t === "rescue") return "🚑 záchrana";
        if (t === "false_alarm") return "🚫 planý poplach";
        return "❓ jiné";
      }).join(", ")
    : "všechny typy";

  const perm = ("Notification" in window) ? Notification.permission : "nepodporováno";

  box.innerHTML = `
    <div><b>Města:</b> ${escapeHtml(cities)}</div>
    <div><b>Typy:</b> ${escapeHtml(types)}</div>
    <div><b>Notifikace:</b> ${escapeHtml(perm)}</div>
  `;
}

function renderWatchHistory() {
  const box = document.getElementById("watchHistory");
  if (!box) return;

  const hist = loadWatchHistory();
  if (!hist.length) {
    box.innerHTML = "Zatím žádné upozornění.";
    return;
  }

  box.innerHTML = hist.slice(0, 8).map(item => `
    <div class="watchHistoryItem">
      <b>${escapeHtml(item.title || "Událost")}</b>
      <span>${escapeHtml(item.city || "")} • ${escapeHtml(item.time || "")}</span>
    </div>
  `).join("");
}

function addWatchHistory(ev) {
  const hist = loadWatchHistory();
  const item = {
    id: ev.id || ev.link || ev.title,
    title: ev.title || "Událost",
    city: ev.city_text || ev.place_text || "",
    time: new Date().toLocaleString("cs-CZ")
  };
  hist.unshift(item);
  saveWatchHistory(hist);
  renderWatchHistory();
}

function processWatchNotifications(items, { initial = false } = {}) {
  if (!Array.isArray(items) || !items.length) return;

  const settings = loadWatchSettings();
  if (!settings || settings.enabled === false) return;

  const seen = loadWatchSeen();

  // První načtení: jen si zapamatujeme současné události, aby web neposlal hromadu starých upozornění.
  if (initial && seen.size === 0) {
    items.forEach(ev => seen.add(String(ev.id || ev.link || ev.title || "")));
    saveWatchSeen(seen);
    return;
  }

  for (const ev of items) {
    const id = String(ev.id || ev.link || ev.title || "");
    if (!id || seen.has(id)) continue;

    seen.add(id);

    if (watchEventMatches(ev, settings)) {
      showWatchBrowserNotification(ev);
      addWatchHistory(ev);
    }
  }

  saveWatchSeen(seen);
}

function saveWatchFromUi() {
  const settings = readWatchForm();
  saveWatchSettings(settings);
  renderWatchSummary();
  setWatchMsg("Sledování uloženo. Upozornění se zobrazí u nových odpovídajících událostí.", true);
}

async function testWatchNotification() {
  const ok = await requestBrowserNotifications();
  if (!ok) return;

  showWatchBrowserNotification({
    id: "test-" + Date.now(),
    event_type: "fire",
    title: "Testovací upozornění FireWatch CZ",
    city_text: "Testovací město"
  });

  setWatchMsg("Testovací notifikace odeslána.", true);
}

function wireWatchNotifications() {
  const settings = loadWatchSettings();
  fillWatchForm(settings);
  renderWatchSummary();
  renderWatchHistory();

  document.getElementById("saveWatchBtn")?.addEventListener("click", saveWatchFromUi);
  document.getElementById("enableBrowserNotifBtn")?.addEventListener("click", requestBrowserNotifications);
  document.getElementById("testWatchNotifBtn")?.addEventListener("click", testWatchNotification);
}




// ==============================
// FireWatchCZ Web v2.0 – Professional layout
// ==============================

function wireProfessionalLayout() {
  syncAdminVisibility();
  rerenderCurrentTableForAdminButtons();
  const sidebar = document.getElementById("fwSidebar");
  const toggle = document.getElementById("mobileSidebarToggle");

  function closeMobileSidebar() {
    document.body.classList.remove("fwSidebarOpen");
  }

  toggle?.addEventListener("click", () => {
    document.body.classList.toggle("fwSidebarOpen");
  });

  document.querySelectorAll("[data-scroll-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-scroll-target");
      if (!id) return;

      if (id === "adminBtn") {
        document.getElementById("adminBtn")?.click();
        closeMobileSidebar();
        return;
      }

      const el = document.getElementById(id);
      if (!el) {
        closeMobileSidebar();
        return;
      }

      if (id === "talkLauncherCard" && !document.body.classList.contains("isTalkOpen")) {
        document.getElementById("toggleTalkBtn")?.click();
      }

      el.scrollIntoView({ behavior: "smooth", block: "start" });
      closeMobileSidebar();
    });
  });

  // Zvýraznění sidebar položek podle aktuální pozice
  const buttons = [...document.querySelectorAll(".fwSidebarNav [data-scroll-target]")];
  const targets = buttons
    .map(btn => ({ btn, el: document.getElementById(btn.getAttribute("data-scroll-target")) }))
    .filter(x => x.el);

  if ("IntersectionObserver" in window && targets.length) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

      if (!visible) return;

      buttons.forEach(b => b.classList.remove("is-active"));
      const active = targets.find(x => x.el === visible.target);
      active?.btn?.classList.add("is-active");
    }, {
      root: null,
      threshold: [0.18, 0.35, 0.55],
      rootMargin: "-15% 0px -65% 0px"
    });

    targets.forEach(x => observer.observe(x.el));
  }
}




// ==============================
// FireWatchCZ Web v2.1 – Regionální počasí × události
// ==============================

let __regionalWeatherLastData = null;

function riskLevelClass(level) {
  const l = String(level || "").toLowerCase();
  if (l.includes("vysok")) return "high";
  if (l.includes("střed") || l.includes("stred")) return "medium";
  if (l.includes("zvý") || l.includes("zvys")) return "elevated";
  return "normal";
}

function riskText(risk) {
  if (!risk) return "běžné";
  const impacts = Array.isArray(risk.impacts) && risk.impacts.length ? ` • ${risk.impacts.join(", ")}` : "";
  return `${risk.level || "běžné"} (${Number(risk.score || 0)}/100)${impacts}`;
}

function formatRegionalWeatherDay(day) {
  if (!day) return "—";
  return String(day).split("-").reverse().join(".");
}

function renderRegionalWeather(data) {
  __regionalWeatherLastData = data;
  updateCommandOverview(window.latestItemsSnapshot || [], window.latestStatsSnapshot || null);

  const summaryBox = document.getElementById("regionalWeatherSummary");
  const highlightsBox = document.getElementById("regionalWeatherHighlights");
  const zonesBox = document.getElementById("regionalWeatherZones");
  const detailBox = document.getElementById("regionalWeatherDetail");

  const summary = data.summary || {};
  const zones = data.zones || [];

  if (summaryBox) {
    summaryBox.innerHTML = `
      <div class="regionalWeatherLead">
        <b>${escapeHtml(summary.text || "Regionální počasí načteno.")}</b>
        <span>Zdroj: ${escapeHtml(data.source || "Open‑Meteo")} • období ${escapeHtml(data.period?.start || "")} – ${escapeHtml(data.period?.end || "")}</span>
      </div>
    `;
  }

  if (highlightsBox) {
    const strongestWind = summary.strongestWind;
    const strongestRain = summary.strongestRain;
    const mostEvents = summary.mostEvents;
    const highestRisk = summary.highestRisk;
    const tomorrowRisk = summary.tomorrowHighestRisk;

    highlightsBox.innerHTML = `
      <div class="regionalWeatherKpi">
        <span>💨 Nejvyšší vítr</span>
        <b>${escapeHtml(strongestWind?.zoneName || "—")}</b>
        <small>${Math.round(Number(strongestWind?.current?.gustKmh || 0))} km/h nárazy</small>
      </div>
      <div class="regionalWeatherKpi">
        <span>🌧️ Nejvíce srážek teď</span>
        <b>${escapeHtml(strongestRain?.zoneName || "—")}</b>
        <small>${Number(strongestRain?.current?.rainMm || 0).toFixed(1)} mm</small>
      </div>
      <div class="regionalWeatherKpi">
        <span>📍 Nejvíce událostí</span>
        <b>${escapeHtml(mostEvents?.zoneName || "—")}</b>
        <small>${Number(mostEvents?.events?.total || 0)} za období</small>
      </div>
      <div class="regionalWeatherKpi ${riskLevelClass(highestRisk?.current?.risk?.level)}">
        <span>⚠️ Aktuální riziko</span>
        <b>${escapeHtml(highestRisk?.zoneName || "—")}</b>
        <small>${escapeHtml(riskText(highestRisk?.current?.risk))}</small>
      </div>
      <div class="regionalWeatherKpi ${riskLevelClass(tomorrowRisk?.tomorrow?.risk?.level)}">
        <span>🔮 Zítra / 24 h</span>
        <b>${escapeHtml(tomorrowRisk?.zoneName || "—")}</b>
        <small>${escapeHtml(riskText(tomorrowRisk?.tomorrow?.risk))}</small>
      </div>
    `;
  }

  if (zonesBox) {
    zonesBox.innerHTML = zones.map(zone => {
      const risk = zone.current?.risk || {};
      const todayRisk = zone.today?.risk || null;
      const tomorrowRisk = zone.tomorrow?.risk || null;
      return `
        <button type="button" class="regionalZoneCard ${riskLevelClass(risk.level)}" data-weather-zone="${escapeHtml(zone.zoneId)}">
          <div class="regionalZoneHead">
            <strong>${escapeHtml(zone.zoneName)}</strong>
            <span>${escapeHtml(zone.current?.weatherEmoji || "🌡️")} ${escapeHtml(zone.current?.weatherLabel || "")}</span>
          </div>
          <div class="regionalZoneMetrics">
            <span>🌡️ ${Number(zone.current?.temp || 0).toFixed(1)} °C</span>
            <span>💨 ${Math.round(Number(zone.current?.gustKmh || 0))} km/h</span>
            <span>🌧️ ${Number(zone.current?.rainMm || 0).toFixed(1)} mm</span>
            <span>📍 ${Number(zone.events?.total || 0)} událostí</span>
          </div>
          <div class="regionalZoneRisk">
            Dnes: ${escapeHtml(riskText(todayRisk || risk))}
          </div>
          <div class="regionalZoneTomorrow">
            Zítra: ${escapeHtml(riskText(tomorrowRisk))}
          </div>
        </button>
      `;
    }).join("");

    zonesBox.querySelectorAll("[data-weather-zone]").forEach(btn => {
      btn.addEventListener("click", () => {
        const zone = zones.find(z => z.zoneId === btn.getAttribute("data-weather-zone"));
        if (zone) renderRegionalWeatherDetail(zone);
      });
    });
  }

  if (detailBox && zones.length && !detailBox.innerHTML.trim()) {
    renderRegionalWeatherDetail(zones[0], { scroll: false });
  }
}

function renderRegionalWeatherDetail(zone, opts = {}) {
  const box = document.getElementById("regionalWeatherDetail");
  if (!box || !zone) return;

  const insights = zone.insights || [];
  const todayWindows = zone.today?.hourlyRisk || [];
  const tomorrowWindows = zone.tomorrow?.hourlyRisk || [];
  const daily = zone.daily || [];

  box.innerHTML = `
    <div class="regionalDetailHead">
      <div>
        <h3>${escapeHtml(zone.zoneName)}</h3>
        <p>Detail počasí, dnešního rizika, zítřejšího výhledu a vazby na události.</p>
      </div>
      <div class="regionalDetailBadge ${riskLevelClass(zone.current?.risk?.level)}">
        ${escapeHtml(riskText(zone.current?.risk))}
      </div>
    </div>

    <div class="regionalDetailGrid">
      <div class="regionalDetailPanel">
        <h4>Dnešní vývoj</h4>
        ${todayWindows.length ? todayWindows.map(w => `
          <div class="regionalWeatherWindow ${riskLevelClass(w.level)}">
            <b>${escapeHtml(w.window)}</b>
            <span>${escapeHtml(w.weatherEmoji || "")} ${escapeHtml(w.weatherLabel || "")} • ${escapeHtml(riskText(w))}</span>
            <small>nárazy ${Math.round(Number(w.maxGustKmh || 0))} km/h • déšť ${Number(w.rainMm || 0).toFixed(1)} mm</small>
          </div>
        `).join("") : `<div class="muted">Bez hodinové analýzy.</div>`}
      </div>

      <div class="regionalDetailPanel">
        <h4>Následující den</h4>
        ${tomorrowWindows.length ? tomorrowWindows.map(w => `
          <div class="regionalWeatherWindow ${riskLevelClass(w.level)}">
            <b>${escapeHtml(w.window)}</b>
            <span>${escapeHtml(w.weatherEmoji || "")} ${escapeHtml(w.weatherLabel || "")} • ${escapeHtml(riskText(w))}</span>
            <small>nárazy ${Math.round(Number(w.maxGustKmh || 0))} km/h • déšť ${Number(w.rainMm || 0).toFixed(1)} mm</small>
          </div>
        `).join("") : `<div class="muted">Bez výhledu.</div>`}
      </div>
    </div>

    <div class="regionalDetailGrid">
      <div class="regionalDetailPanel">
        <h4>Self analytika regionu</h4>
        ${insights.map(item => `
          <div class="regionalWeatherInsight ${escapeHtml(item.level || "info")}">
            <span>${escapeHtml(item.icon || "🌡️")}</span>
            <div>
              <b>${escapeHtml(item.title || "")}</b>
              <p>${escapeHtml(item.text || "")}</p>
            </div>
          </div>
        `).join("")}
      </div>

      <div class="regionalDetailPanel">
        <h4>Události v regionu</h4>
        <div class="regionalEventStats">
          <div><span>Celkem</span><b>${Number(zone.events?.total || 0)}</b></div>
          <div><span>Technická</span><b>${Number(zone.events?.tech || 0)}</b></div>
          <div><span>Dopravní</span><b>${Number(zone.events?.traffic || 0)}</b></div>
          <div><span>Požár</span><b>${Number(zone.events?.fire || 0)}</b></div>
          <div><span>GPS</span><b>${Number(zone.events?.assignedByGps || 0)}</b></div>
          <div><span>Alias</span><b>${Number(zone.events?.assignedByAlias || 0)}</b></div>
        </div>
      </div>
    </div>

    <div class="regionalDetailPanel">
      <h4>Denní přehled počasí × události</h4>
      <div class="regionalDailyRows">
        ${daily.slice(-14).reverse().map(day => `
          <div class="regionalDailyRow ${riskLevelClass(day.risk?.level)}">
            <span><b>${escapeHtml(formatRegionalWeatherDay(day.day))}</b><small>${escapeHtml(day.weatherEmoji || "")} ${escapeHtml(day.weatherLabel || "")}</small></span>
            <span>🌡️ ${Number(day.avgTemp || 0).toFixed(1)} °C</span>
            <span>💨 ${Math.round(Number(day.maxGustKmh || 0))} km/h</span>
            <span>🌧️ ${Number(day.rainMm || 0).toFixed(1)} mm</span>
            <span>📍 ${Number(day.events?.total || 0)} událostí</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  if (opts.scroll !== false) { try { box.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch {} }
}

async function loadRegionalWeather() {
  const btn = document.getElementById("loadRegionalWeatherBtn");
  const old = btn?.textContent || "Načíst regionální počasí";
  const days = document.getElementById("regionalWeatherDays")?.value || "30";
  const summary = document.getElementById("regionalWeatherSummary");
  const zones = document.getElementById("regionalWeatherZones");
  const detail = document.getElementById("regionalWeatherDetail");

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Načítám…";
    }

    if (summary) summary.innerHTML = `<div class="regionalWeatherLoading">Načítám počasí pro regiony Středočeského kraje…</div>`;
    if (zones) zones.innerHTML = "";
    if (detail) detail.innerHTML = "";

    const r = await fetch(`/api/weather/regions/anomalies?days=${encodeURIComponent(days)}&_=${Date.now()}`, { cache: "no-store" });
    const j = await r.json();

    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "regional weather failed");

    renderRegionalWeather(j.weather);
  } catch (e) {
    if (summary) summary.innerHTML = `<div class="err">Regionální počasí se nepodařilo načíst: ${escapeHtml(String(e.message || e))}</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

function wireRegionalWeather() {
  document.getElementById("loadRegionalWeatherBtn")?.addEventListener("click", loadRegionalWeather);
  document.getElementById("regionalWeatherDays")?.addEventListener("change", loadRegionalWeather);
  loadRegionalWeather();
}




// ==============================
// FireWatchCZ Web v2.2 – zpětný přepočet významných událostí
// ==============================


function setMajorBackfillStatus(text) {
  ["majorBackfillStatus", "adminMajorBackfillStatus"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text || "";
  });
}

async function runMajorEventsBackfill() {
  const btn = document.getElementById("majorBackfillBtn");
  const status = document.getElementById("majorBackfillStatus");
  const adminStatus = document.getElementById("adminMajorBackfillStatus");
  const old = btn?.textContent || "Přepočítat významné události";

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Přepočítávám…";
    }
    setMajorBackfillStatus("Procházím uložené události v databázi…");

    const r = await fetch("/api/admin/major-events/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ limit: 10000 })
    });
    const j = await r.json();

    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "backfill failed");

    setMajorBackfillStatus(`Hotovo: zkontrolováno ${j.scanned}, upraveno ${j.updated}, významné ${j.major}, znovu otevřeno ${j.reopened}.`);

    await loadAll();
  } catch (e) {
    setMajorBackfillStatus(`Nepodařilo se přepočítat: ${String(e.message || e)}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

async function reloadMajorEventsFromServer() {
  const status = document.getElementById("majorBackfillStatus");
  try {
    setMajorBackfillStatus("Načítám významné události…");
    const r = await fetch("/api/admin/major-events?limit=50", { credentials: "include", cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "major list failed");
    renderMajorEvents(j.items || []);
    setMajorBackfillStatus(`Načteno ${Number(j.items?.length || 0)} významných událostí.`);
  } catch (e) {
    setMajorBackfillStatus(`Nepodařilo se načíst významné události: ${String(e.message || e)}`);
  }
}

function wireMajorEventsBackfill() {
  document.getElementById("majorBackfillBtn")?.addEventListener("click", runMajorEventsBackfill);
  document.getElementById("adminMajorBackfillBtn")?.addEventListener("click", runMajorEventsBackfill);
  document.getElementById("majorReloadBtn")?.addEventListener("click", reloadMajorEventsFromServer);
  document.getElementById("adminMajorReloadBtn")?.addEventListener("click", reloadMajorEventsFromServer);
}




// ==============================
// FireWatchCZ v2.3 – přehlednější hlavní stránka
// ==============================

function updateCommandOverview(items = [], stats = null) {
  const status = document.getElementById("commandOverviewStatus");
  const lastUpdate = document.getElementById("overviewLastUpdate");
  const mapCount = document.getElementById("overviewMapCount");
  const majorCount = document.getElementById("overviewMajorCount");
  const openCount = document.getElementById("overviewOpenCount");
  const totalCount = document.getElementById("overviewTotalCount");
  const missingCount = document.getElementById("overviewMissingCount");
  const weatherRisk = document.getElementById("overviewWeatherRisk");
  const primary = document.getElementById("overviewPrimaryIncident");
  const filterLabel = document.getElementById("overviewFilterLabel");
  const dataHealth = document.getElementById("overviewDataHealth");

  const safeItems = Array.isArray(items) ? items : [];
  const mapped = safeItems.filter(x => typeof hasValidCoords === "function" ? hasValidCoords(x) : (Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lon)))).length;
  const missing = Math.max(0, safeItems.length - mapped);
  const major = safeItems.filter(x => typeof isMajorEventItem === "function" ? isMajorEventItem(x) : false).length;
  const open = safeItems.filter(x => !x.is_closed).length;
  const closed = safeItems.filter(x => !!x.is_closed).length;
  const carryover = safeItems.filter(x => typeof isImportantCarryoverEvent === "function" && isImportantCarryoverEvent(x) && (x.is_carryover_active || Number(x.carryover_days || 0) > 0)).length;

  if (mapCount) mapCount.textContent = `${mapped}`;
  if (majorCount) majorCount.textContent = `${major}`;
  if (openCount) openCount.textContent = `${open}`;
  if (totalCount) totalCount.textContent = `${safeItems.length}`;
  if (missingCount) missingCount.textContent = `${missing}`;

  if (status) {
    const state = open > 0 ? "AKTIVNÍ PROVOZ" : "KLIDOVÝ PŘEHLED";
    status.textContent = `${state} • ${safeItems.length} záznamů`;
  }

  if (lastUpdate) {
    try {
      lastUpdate.textContent = `aktualizováno ${new Intl.DateTimeFormat("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
    } catch {
      lastUpdate.textContent = "aktualizováno nyní";
    }
  }

  if (filterLabel) {
    const f = typeof getFiltersFromUi === "function" ? getFiltersFromUi() : {};
    const dayMap = { today: "dnes", yesterday: "včera", all: "vše" };
    const statusMap = { all: "vše", open: "aktivní", closed: "ukončené" };
    filterLabel.textContent = `Filtr: ${dayMap[f.day] || f.day || "—"} • ${f.type || "vše"} • ${statusMap[f.status] || f.status || "vše"}${f.city ? ` • ${f.city}` : ""}`;
  }

  if (dataHealth) {
    if (safeItems.length === 0) {
      dataHealth.textContent = "Stav dat: bez záznamů pro filtr";
      dataHealth.className = "warn";
    } else if (missing > 0) {
      dataHealth.textContent = `Stav dat: ${missing} bez GPS`;
      dataHealth.className = "warn";
    } else {
      dataHealth.textContent = "Stav dat: GPS kompletní";
      dataHealth.className = "ok";
    }
  }

  if (primary) {
    const openSorted = safeItems
      .filter(x => !x.is_closed)
      .map(x => ({ ...x, __duration: typeof liveDurationForEvent === "function" ? Number(liveDurationForEvent(x) || 0) : Number(x.duration_min || 0) }))
      .sort((a, b) => b.__duration - a.__duration);

    if (openSorted.length) {
      const it = openSorted[0];
      const meta = typeof typeMeta === "function" ? typeMeta(it.event_type) : { emoji: "•" };
      primary.innerHTML = `<strong>${meta.emoji || "•"} ${escapeHtml(it.title || "Aktivní zásah")}</strong><span>${escapeHtml(it.city_text || it.place_text || "")} • ${escapeHtml(formatDuration(it.__duration))}${carryover ? ` • přesah ${carryover}` : ""}</span>`;
    } else {
      primary.innerHTML = `<strong>✅ Bez aktivního zásahu</strong><span>${closed} ukončených v aktuálním filtru</span>`;
    }
  }

  if (weatherRisk && __regionalWeatherLastData?.summary?.highestRisk) {
    const z = __regionalWeatherLastData.summary.highestRisk;
    weatherRisk.textContent = `Počasí: ${z.zoneName || "bez zvýšeného rizika"}`;
  } else if (weatherRisk) {
    weatherRisk.textContent = "Počasí: načítá se";
  }
}

function wireCommandOverviewNav() {
  document.querySelectorAll(".commandTile[data-scroll-target], .v28KpiTile[data-scroll-target], .quickJump[data-scroll-target], .fwSidebarNav [data-scroll-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-scroll-target");
      const el = id ? document.getElementById(id) : null;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}





let __manualMapPickMode = false;
let __manualMapPickMarker = null;

function setManualCoords(lat, lon) {
  const latInput = document.getElementById("manualEventLat");
  const lonInput = document.getElementById("manualEventLon");
  if (latInput) latInput.value = Number(lat).toFixed(6);
  if (lonInput) lonInput.value = Number(lon).toFixed(6);

  const hint = document.getElementById("manualCoordsHint");
  if (hint) hint.textContent = `Vybraná pozice: ${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;

  if (map && window.L) {
    if (__manualMapPickMarker) {
      __manualMapPickMarker.setLatLng([Number(lat), Number(lon)]);
    } else {
      __manualMapPickMarker = L.marker([Number(lat), Number(lon)], {
        title: "Ručně vybraná poloha výjezdu"
      }).addTo(map);
    }
  }
}

function clearManualCoordsInputs() {
  const latInput = document.getElementById("manualEventLat");
  const lonInput = document.getElementById("manualEventLon");
  if (latInput) latInput.value = "";
  if (lonInput) lonInput.value = "";

  const hint = document.getElementById("manualCoordsHint");
  if (hint) hint.textContent = "Souřadnice budou ponechané prázdné / smažou se po uložení.";

  if (__manualMapPickMarker && map) {
    try { map.removeLayer(__manualMapPickMarker); } catch {}
    __manualMapPickMarker = null;
  }
}

function startManualMapPick() {
  __manualMapPickMode = true;

  const back = document.getElementById("manualEventModalBackdrop");
  if (back) back.style.display = "none";

  const restore = document.getElementById("restoreAdminPanelBtn");
  if (restore) {
    restore.style.display = "";
    restore.textContent = "Zpět k úpravě výjezdu";
  }

  const hint = document.getElementById("manualCoordsHint");
  if (hint) hint.textContent = "Režim výběru na mapě aktivní. Klikni do mapy na místo výjezdu.";

  if (map) {
    try {
      map.getContainer().classList.add("mapPickMode");
      map.once("click", (ev) => {
        __manualMapPickMode = false;
        try { map.getContainer().classList.remove("mapPickMode"); } catch {}
        setManualCoords(ev.latlng.lat, ev.latlng.lng);

        const modal = document.getElementById("manualEventModalBackdrop");
        if (modal) modal.style.display = "flex";
        if (restore) restore.style.display = "none";
      });
    } catch {}
  } else {
    alert("Mapa zatím není připravená.");
    if (back) back.style.display = "flex";
  }
}

function restoreManualModalAfterMapPick() {
  __manualMapPickMode = false;
  try { if (map) map.getContainer().classList.remove("mapPickMode"); } catch {}
  const modal = document.getElementById("manualEventModalBackdrop");
  if (modal) modal.style.display = "flex";
  const restore = document.getElementById("restoreAdminPanelBtn");
  if (restore) restore.style.display = "none";
}


// ==============================
// FireWatchCZ Web v2.4 – ruční editace události
// ==============================

let __manualEventCurrentId = null;

function toLocalDateTimeInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDateTimeInput(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function syncManualEndInput() {
  const mode = document.getElementById("manualEventStatusMode")?.value || "auto";
  const end = document.getElementById("manualEventEnd");
  const endLabel = document.getElementById("manualEventEndLabel");
  const endHint = document.getElementById("manualEventEndHint");

  if (!end) return;

  if (mode === "open") {
    end.value = "";
    end.disabled = true;
    endLabel?.classList.add("is-disabled");
    if (endHint) endHint.textContent = "Aktivní zásah nemá konec. Délka se počítá průběžně od začátku do aktuálního času.";
  } else {
    end.disabled = false;
    endLabel?.classList.remove("is-disabled");
    if (endHint) endHint.textContent = "U aktivního zásahu se konec nevyplňuje. Doplní se až po ukončení.";
  }
}

function updateManualEventComputed() {
  syncManualEndInput();

  const box = document.getElementById("manualEventComputed");
  if (!box) return;

  const mode = document.getElementById("manualEventStatusMode")?.value || "auto";
  const startValue = document.getElementById("manualEventStart")?.value || "";
  const endValue = document.getElementById("manualEventEnd")?.value || "";

  const start = startValue ? new Date(startValue) : null;
  const end = endValue ? new Date(endValue) : null;

  if (!start || Number.isNaN(start.getTime())) {
    box.textContent = "Délka se spočítá po zadání začátku zásahu.";
    return;
  }

  if (mode === "open") {
    const minutes = Math.max(0, Math.round((new Date() - start) / 60000));
    box.textContent = `Zásah je nastavený jako AKTIVNÍ. Konec není potřeba zadávat. Průběžná délka: ${formatDuration(minutes)}.`;
    return;
  }

  if (mode === "closed") {
    if (!end || Number.isNaN(end.getTime())) {
      box.textContent = "U ukončeného zásahu můžeš zadat konec. Když ho necháš prázdný, při uložení se použije aktuální čas.";
      return;
    }
    if (end < start) {
      box.textContent = "Pozor: konec zásahu je před začátkem.";
      return;
    }
    const minutes = Math.max(0, Math.round((end - start) / 60000));
    box.textContent = `Nová délka zásahu: ${formatDuration(minutes)}.`;
    return;
  }

  box.textContent = "Automatika ponechá aktuální stav, ručně se uloží hlavně stupeň poplachu a významnost.";
}

async function openManualEventEditor(id) {
  if (!id) return;
  __manualEventCurrentId = id;

  const back = document.getElementById("manualEventModalBackdrop");
  const status = document.getElementById("manualEventStatus");
  const info = document.getElementById("manualEventInfo");

  try {
    if (back) back.style.display = "flex";
    if (status) status.textContent = "Načítám událost…";

    const r = await fetch(`/api/admin/events/${encodeURIComponent(id)}/manual`, {
      credentials: "include",
      cache: "no-store"
    });
    const j = await r.json();

    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "manual event load failed");

    const ev = j.event;

    if (info) {
      info.innerHTML = `
        <b>${escapeHtml(ev.title || "")}</b>
        <span>${escapeHtml(ev.city_text || ev.place_text || "")} • ${escapeHtml(ev.status_text || "")}</span>
        <small>ID: ${escapeHtml(ev.id || "")}</small>
      `;
    }

    const mode = ev.status_source === "manual"
      ? (ev.is_closed ? "closed" : "open")
      : "auto";

    document.getElementById("manualEventStatusMode").value = mode;
    document.getElementById("manualEventAlarmLevel").value = ev.alarm_level ? String(ev.alarm_level) : "";
    document.getElementById("manualEventIsMajor").checked = !!ev.is_major_event;
    document.getElementById("manualEventMajorReason").value = ev.major_reason || "";
    document.getElementById("manualEventStart").value = toLocalDateTimeInput(ev.start_time_iso || ev.pub_date || ev.first_seen_at || ev.created_at);
    document.getElementById("manualEventEnd").value = toLocalDateTimeInput(ev.end_time_iso);

    const latInput = document.getElementById("manualEventLat");
    const lonInput = document.getElementById("manualEventLon");
    const lat = Number(String(ev.lat ?? "").replace(",", "."));
    const lon = Number(String(ev.lon ?? "").replace(",", "."));
    if (latInput) latInput.value = Number.isFinite(lat) ? lat.toFixed(6) : "";
    if (lonInput) lonInput.value = Number.isFinite(lon) ? lon.toFixed(6) : "";

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      setManualCoords(lat, lon);
    } else {
      const hint = document.getElementById("manualCoordsHint");
      if (hint) hint.textContent = "Tento výjezd zatím nemá uloženou pozici. Zadej souřadnice nebo klikni na mapu.";
      if (__manualMapPickMarker && map) {
        try { map.removeLayer(__manualMapPickMarker); } catch {}
        __manualMapPickMarker = null;
      }
    }

    if (status) status.textContent = "";
    syncManualEndInput();
    updateManualEventComputed();
  } catch (e) {
    if (status) status.textContent = `Nepodařilo se načíst událost: ${String(e.message || e)}`;
  }
}

function closeManualEventEditor() {
  const back = document.getElementById("manualEventModalBackdrop");
  if (back) back.style.display = "none";
  __manualEventCurrentId = null;
}

async function saveManualEventEditor() {
  if (!__manualEventCurrentId) return;

  const status = document.getElementById("manualEventStatus");
  const btn = document.getElementById("manualEventSaveBtn");
  const old = btn?.textContent || "Uložit a přepočítat";

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Ukládám…";
    }
    if (status) status.textContent = "Ukládám ruční úpravu…";

    const manualStatusMode = document.getElementById("manualEventStatusMode")?.value || "auto";
    const payload = {
      statusMode: manualStatusMode,
      alarmLevel: document.getElementById("manualEventAlarmLevel")?.value || "",
      isMajorEvent: !!document.getElementById("manualEventIsMajor")?.checked,
      majorReason: document.getElementById("manualEventMajorReason")?.value || "",
      startTimeIso: fromLocalDateTimeInput(document.getElementById("manualEventStart")?.value || ""),
      endTimeIso: manualStatusMode === "open" ? null : fromLocalDateTimeInput(document.getElementById("manualEventEnd")?.value || ""),
      lat: document.getElementById("manualEventLat")?.value || "",
      lon: document.getElementById("manualEventLon")?.value || "",
      clearCoords: !document.getElementById("manualEventLat")?.value && !document.getElementById("manualEventLon")?.value
    };

    const r = await fetch(`/api/admin/events/${encodeURIComponent(__manualEventCurrentId)}/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload)
    });
    const j = await r.json();

    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "manual event save failed");

    if (status) status.textContent = "Uloženo. Přepočítávám přehled…";
    await loadAll(true);
    closeManualEventEditor();
  } catch (e) {
    if (status) status.textContent = `Nepodařilo se uložit: ${String(e.message || e)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}



function wireManualEventEditorDelegated() {
  if (window.__manualEventDelegatedBound) return;
  window.__manualEventDelegatedBound = true;

  document.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!target) return;

    if (target.closest?.("#manualEventCloseBtn") || target.closest?.("#manualEventCancelBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      closeManualEventEditor();
      return;
    }

    if (target.closest?.("#manualEventSaveBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      saveManualEventEditor();
      return;
    }

    if (target.closest?.("#manualPickOnMapBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      startManualMapPick();
      return;
    }

    if (target.closest?.("#manualClearCoordsBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      clearManualCoordsInputs();
      return;
    }

    if (target.closest?.("#restoreAdminPanelBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      restoreManualModalAfterMapPick();
      return;
    }
  });

  document.addEventListener("change", (ev) => {
    const id = ev.target?.id;
    if (["manualEventStatusMode", "manualEventStart", "manualEventEnd"].includes(id)) {
      updateManualEventComputed();
    }
  });

  document.addEventListener("input", (ev) => {
    const id = ev.target?.id;
    if (["manualEventStart", "manualEventEnd"].includes(id)) {
      updateManualEventComputed();
    }
  });
}


function wireManualEventEditor() {
  wireManualEventEditorDelegated();
  document.getElementById("manualEventCloseBtn")?.addEventListener("click", (ev) => { ev.preventDefault(); closeManualEventEditor(); });
  document.getElementById("manualEventCancelBtn")?.addEventListener("click", (ev) => { ev.preventDefault(); closeManualEventEditor(); });
  document.getElementById("manualEventSaveBtn")?.addEventListener("click", (ev) => { ev.preventDefault(); saveManualEventEditor(); });
  document.getElementById("manualPickOnMapBtn")?.addEventListener("click", (ev) => { ev.preventDefault(); startManualMapPick(); });
  document.getElementById("manualClearCoordsBtn")?.addEventListener("click", (ev) => { ev.preventDefault(); clearManualCoordsInputs(); });
  document.getElementById("restoreAdminPanelBtn")?.addEventListener("click", (ev) => { ev.preventDefault(); restoreManualModalAfterMapPick(); });

  ["manualEventStatusMode", "manualEventStart", "manualEventEnd"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", updateManualEventComputed);
    document.getElementById(id)?.addEventListener("input", updateManualEventComputed);
  });

  document.getElementById("manualEventAlarmLevel")?.addEventListener("change", () => {
    const level = Number(document.getElementById("manualEventAlarmLevel")?.value || 0);
    const isMajor = document.getElementById("manualEventIsMajor");
    const reason = document.getElementById("manualEventMajorReason");
    if (isMajor && level >= 3) isMajor.checked = true;
    if (reason && level >= 3 && !reason.value.trim()) {
      reason.value = level >= 4 ? "IV. / zvláštní stupeň poplachu" : "III. stupeň poplachu";
    }
  });
}




// ==============================
// FireWatchCZ v2.4 fix – viditelný admin seznam pro ruční úpravy
// ==============================

let __manualQuickItems = [];


function renderManualQuickListTarget(listId, statusId, searchId, items = __manualQuickItems) {
  const list = document.getElementById(listId);
  const status = document.getElementById(statusId);
  if (!list) return;

  const q = String(document.getElementById(searchId)?.value || "").toLowerCase().trim();
  const filtered = items.filter((it) => {
    if (!q) return true;
    return `${it.title || ""} ${it.city_text || ""} ${it.place_text || ""} ${it.status_text || ""}`.toLowerCase().includes(q);
  });

  if (status) status.textContent = `${filtered.length} / ${items.length} událostí`;

  if (!filtered.length) {
    list.innerHTML = `<div class="muted">Žádná událost pro zadaný filtr.</div>`;
    return;
  }

  list.innerHTML = filtered.slice(0, 80).map((it) => {
    const meta = typeMeta(it.event_type);
    const alarm = alarmLevelBadge(it);
    return `
      <div class="manualQuickItem ${isMajorEventItem(it) ? "is-major" : ""}">
        <div>
          <b>${meta.emoji} ${escapeHtml(it.title || "")}</b>
          <span>${escapeHtml(it.city_text || it.place_text || "")} • ${statusEmoji(it.is_closed)} ${escapeHtml(statusLabelForEvent(it))}</span>
          <small>${escapeHtml(formatDate(it.pub_date))} ${alarm ? " • " : ""}${alarm}</small>
        </div>
        <button type="button" class="btn primary miniBtn manualQuickEditBtn" data-event-id="${escapeHtml(it.id || "")}">Upravit stav / stupeň</button>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".manualQuickEditBtn").forEach((btn) => {
    btn.addEventListener("click", () => openManualEventEditor(btn.getAttribute("data-event-id")));
  });
}


function renderManualQuickList(items = __manualQuickItems) {
  renderManualQuickListTarget("manualQuickList", "manualQuickStatus", "manualQuickSearch", items);
  renderManualQuickListTarget("adminManualQuickList", "adminManualQuickStatus", "adminManualQuickSearch", items);
}

async function loadManualQuickEvents() {
  const btns = [
    document.getElementById("manualQuickLoadBtn"),
    document.getElementById("adminManualQuickLoadBtn")
  ].filter(Boolean);
  const old = btns.map((b) => b.textContent);
  const status = document.getElementById("manualQuickStatus");

  try {
    btns.forEach((b) => {
      b.disabled = true;
      b.textContent = "Načítám…";
    });
    if (status) status.textContent = "Načítám poslední události…";

    // Použijeme aktuální veřejný endpoint s limitem; admin edit je stále chráněný vlastním endpointem.
    const params = new URLSearchParams({
      day: "all",
      type: "all",
      status: "all",
      limit: "300",
      _: String(Date.now())
    });

    const r = await fetch(`/api/events?${params.toString()}`, { credentials: "include", cache: "no-store" });
    const j = await r.json();

    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "events load failed");

    __manualQuickItems = Array.isArray(j.items) ? j.items : [];
    renderManualQuickList(__manualQuickItems);

    const adminList = document.getElementById("adminManualQuickList");
    const adminModalVisible = document.getElementById("modalBackdrop")?.style.display !== "none" && adminList;
    if (!adminModalVisible) {
      const card = document.getElementById("manualEventQuickCard");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (e) {
    if (status) status.textContent = `Nepodařilo se načíst: ${String(e.message || e)}`;
  } finally {
    btns.forEach((b, i) => {
      b.disabled = false;
      b.textContent = old[i] || "Načíst";
    });
  }
}

function wireManualQuickEditList() {
  document.getElementById("manualQuickLoadBtn")?.addEventListener("click", loadManualQuickEvents);
  document.getElementById("adminManualQuickLoadBtn")?.addEventListener("click", loadManualQuickEvents);
  document.getElementById("manualQuickSearch")?.addEventListener("input", () => renderManualQuickList());
  document.getElementById("adminManualQuickSearch")?.addEventListener("input", () => renderManualQuickList());
}




// ==============================
// FireWatchCZ v2.5 – vlastní detail události a poznámky
// ==============================

let __eventDetailCurrentId = null;
let __eventDetailCurrentEvent = null;

async function openEventDetailModal(id) {
  if (!id) return;
  __eventDetailCurrentId = id;

  const back = document.getElementById("eventDetailModalBackdrop");
  const status = document.getElementById("eventDetailStatus");
  const header = document.getElementById("eventDetailHeader");
  const summary = document.getElementById("eventDetailSummary");
  const publicText = document.getElementById("eventDetailPublicText");

  try {
    if (back) back.style.display = "flex";
    if (status) status.textContent = "Načítám detail…";
    if (header) header.innerHTML = "";
    if (summary) summary.innerHTML = "";
    if (publicText) publicText.innerHTML = `<div class="muted">Načítám…</div>`;

    const r = await fetch(`/api/events/${encodeURIComponent(id)}/detail`, {
      credentials: "include",
      cache: "no-store"
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "detail load failed");

    const ev = j.event;
    __eventDetailCurrentEvent = ev;

    const meta = typeMeta(ev.event_type);
    if (header) {
      header.innerHTML = `
        <div>
          <h3>${meta.emoji} ${escapeHtml(ev.title || "")}</h3>
          <p>${escapeHtml(ev.city_text || ev.place_text || "")} • ${statusEmoji(ev.is_closed)} ${escapeHtml(statusLabelForEvent(ev))}</p>
        </div>
        <div>${alarmLevelBadge(ev)}</div>
      `;
    }

    if (summary) {
      summary.innerHTML = `
        ${eventDetailLine("Čas", detailDateText(ev.pub_date || ev.start_time_iso || ev.created_at))}
        ${eventDetailLine("Město / místo", ev.city_text || ev.place_text || "")}
        ${eventDetailLine("Typ", `${meta.emoji} ${meta.label || ev.event_type || ""}`)}
        ${eventDetailLine("Stav", statusLabelForEvent(ev))}
        ${eventDetailLine("Délka", formatDuration(liveDurationForEvent(ev)))}
        ${eventDetailLine("Stupeň", ev.alarm_level_text || "")}
        ${eventDetailLine("Význam", ev.major_reason || (ev.is_major_event ? "významná událost" : ""))}
      `;
    }

    const savedText = ev.manual_detail_text || "";
    const savedSource = ev.manual_detail_source || "";
    if (publicText) {
      publicText.innerHTML = savedText
        ? `<div class="manualPublicText">${escapeHtml(savedText).replace(/\n/g, "<br>")}</div>${savedSource ? `<div class="manualPublicSource">Zdroj/poznámka: ${escapeHtml(savedSource)}</div>` : ""}${ev.manual_detail_updated_at ? `<div class="manualPublicUpdated">Upraveno: ${escapeHtml(detailDateText(ev.manual_detail_updated_at))}</div>` : ""}`
        : `<div class="muted">Zatím není uložený vlastní detail. Admin ho může doplnit z veřejně dostupných informací.</div>`;
    }

    const textInput = document.getElementById("eventDetailTextInput");
    const sourceInput = document.getElementById("eventDetailSourceInput");
    if (textInput) textInput.value = savedText;
    if (sourceInput) sourceInput.value = savedSource;

    const sourceLink = document.getElementById("eventDetailSourceLink");
    if (sourceLink && ev.link) {
      sourceLink.href = ev.link;
      sourceLink.style.display = "";
    } else if (sourceLink) {
      sourceLink.removeAttribute("href");
      sourceLink.style.display = "none";
    }

    syncAdminVisibility?.();
    if (status) status.textContent = "";
  } catch (e) {
    if (publicText) publicText.innerHTML = `<div class="err">Detail se nepodařilo načíst: ${escapeHtml(String(e.message || e))}</div>`;
    if (status) status.textContent = "";
  }
}

function closeEventDetailModal() {
  const back = document.getElementById("eventDetailModalBackdrop");
  if (back) back.style.display = "none";
  __eventDetailCurrentId = null;
  __eventDetailCurrentEvent = null;
}

async function saveEventDetailText() {
  if (!__eventDetailCurrentId) return;

  const btn = document.getElementById("eventDetailSaveBtn");
  const status = document.getElementById("eventDetailStatus");
  const old = btn?.textContent || "Uložit detail";

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Ukládám…";
    }
    if (status) status.textContent = "Ukládám vlastní detail…";

    const payload = {
      manualDetailText: document.getElementById("eventDetailTextInput")?.value || "",
      manualDetailSource: document.getElementById("eventDetailSourceInput")?.value || ""
    };

    const r = await fetch(`/api/admin/events/${encodeURIComponent(__eventDetailCurrentId)}/detail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "detail save failed");

    if (status) status.textContent = "Uloženo.";
    await openEventDetailModal(__eventDetailCurrentId);
    await loadAll();
  } catch (e) {
    if (status) status.textContent = `Nepodařilo se uložit: ${String(e.message || e)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

function findEventIdFromDetailRow(el) {
  const direct = el?.getAttribute?.("data-event-id");
  if (direct) return direct;

  const tr = el?.closest?.("tr");
  if (!tr) return null;

  const editBtn = tr.querySelector?.(".tableManualEditBtn, .manualEditEventBtn");
  if (editBtn?.getAttribute("data-event-id")) return editBtn.getAttribute("data-event-id");

  const allRows = Array.from(document.querySelectorAll("#eventsTbody tr"));
  const idx = allRows.indexOf(tr);
  const items = window.latestItemsSnapshot || [];
  return idx >= 0 && items[idx]?.id ? items[idx].id : null;
}

function wireEventDetailModal() {
  if (window.__eventDetailModalBound) return;
  window.__eventDetailModalBound = true;

  document.addEventListener("click", (ev) => {
    const detailBtn = ev.target?.closest?.(".eventDetailBtn");
    if (detailBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      openEventDetailModal(detailBtn.getAttribute("data-event-id"));
      return;
    }

    const oldDetailAnchor = ev.target?.closest?.("a");
    if (oldDetailAnchor && oldDetailAnchor.textContent?.trim()?.toLowerCase() === "detail" && oldDetailAnchor.closest?.("#eventsTbody")) {
      ev.preventDefault();
      ev.stopPropagation();
      const id = findEventIdFromDetailRow(oldDetailAnchor);
      if (id) openEventDetailModal(id);
      return;
    }


    if (ev.target?.closest?.("#eventDetailCloseBtn") || ev.target?.closest?.("#eventDetailCancelBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      closeEventDetailModal();
      return;
    }

    if (ev.target?.closest?.("#eventDetailSaveBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      saveEventDetailText();
      return;
    }

    if (ev.target?.closest?.("#eventDetailEditEventBtn")) {
      ev.preventDefault();
      ev.stopPropagation();
      if (__eventDetailCurrentId) openManualEventEditor(__eventDetailCurrentId);
      return;
    }
  });
}










async function recheckEventStatusesAdmin() {
  const status = document.getElementById("adminMajorBackfillStatus") || document.getElementById("adminDurationRecomputeStatus");
  const btn = document.getElementById("adminRecheckStatusesBtn");
  const old = btn?.textContent || "Překontrolovat stavy z RSS";

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Kontroluji…";
    }
    if (status) status.textContent = "Překontrolovávám stavy podle uloženého RSS textu…";

    const r = await fetch("/api/admin/recheck-event-statuses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ limit: 10000 })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "recheck failed");

    if (status) {
      status.textContent = `Hotovo: zkontrolováno ${Number(j.scanned || 0)}, opraveno ${Number(j.changed || 0)}, znovu otevřeno ${Number(j.reopened || 0)}.`;
    }
    await loadAll(true);
  } catch (e) {
    if (status) status.textContent = `Kontrola stavů selhala: ${String(e.message || e)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

function wireStatusRecheckAdminButton() {
  document.getElementById("adminRecheckStatusesBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    recheckEventStatusesAdmin();
  });
}

async function recomputeObservedDurationsAdmin() {
  const status = document.getElementById("adminDurationRecomputeStatus");
  const btn = document.getElementById("adminRecomputeDurationsBtn");
  const old = btn?.textContent || "Přepočítat sledované délky";

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Přepočítávám…";
    }
    if (status) status.textContent = "Přepočítávám sledované délky zásahů…";

    const r = await fetch("/api/admin/recompute-observed-durations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ limit: 5000 })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "recompute failed");

    if (status) status.textContent = `Hotovo: zpětný bezpečný přepočet ${Number(j.recomputed || 0)} událostí. Nové délky se budou počítat při přechodu aktivní → ukončená.`;
    await loadAll(true);
  } catch (e) {
    if (status) status.textContent = `Přepočet se nepodařil: ${String(e.message || e)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

async function clearBogusDurationsAdmin() {
  const status = document.getElementById("adminDurationRecomputeStatus");
  const btn = document.getElementById("adminClearBogusDurationsBtn");
  const old = btn?.textContent || "Vyčistit krátké falešné délky";

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Čistím…";
    }
    if (status) status.textContent = "Mažu chybně dopočítané sledované délky z předchozí verze…";

    const r = await fetch("/api/admin/clear-observed-durations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ maxMinutes: 20 })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "clear failed");

    if (status) status.textContent = `Hotovo: vyčištěno ${Number(j.cleared || 0)} událostí.`;
    await loadAll(true);
  } catch (e) {
    if (status) status.textContent = `Čištění se nepodařilo: ${String(e.message || e)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

function wireDurationAdminButtons() {
  document.getElementById("adminRecomputeDurationsBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    recomputeObservedDurationsAdmin();
  });

  document.getElementById("adminClearBogusDurationsBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    clearBogusDurationsAdmin();
  });
}

// ==============================
// FireWatchCZ – ruční doplnění výjezdu + diagnostika příjmu
// ==============================

let __manualCreatePickMode = false;
let __manualCreatePickMarker = null;

function manualCreateToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function setManualCreateCoords(lat, lon) {
  const latInput = document.getElementById("manualCreateLat");
  const lonInput = document.getElementById("manualCreateLon");
  if (latInput) latInput.value = Number(lat).toFixed(6);
  if (lonInput) lonInput.value = Number(lon).toFixed(6);
  const msg = document.getElementById("manualCreateMsg");
  if (msg) msg.textContent = `Vybraná poloha: ${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;

  if (map && window.L) {
    if (__manualCreatePickMarker) {
      __manualCreatePickMarker.setLatLng([Number(lat), Number(lon)]);
    } else {
      __manualCreatePickMarker = L.marker([Number(lat), Number(lon)], { title: "Ručně přidávaný výjezd" }).addTo(map);
    }
  }
}

function startManualCreateMapPick() {
  const adminModal = document.getElementById("adminModal");
  if (adminModal) adminModal.style.display = "none";

  const msg = document.getElementById("manualCreateMsg");
  if (msg) msg.textContent = "Klikni na mapě na místo výjezdu.";

  if (!map) {
    if (adminModal) adminModal.style.display = "";
    if (msg) msg.textContent = "Mapa zatím není připravená.";
    return;
  }

  try {
    map.getContainer().classList.add("mapPickMode");
    map.once("click", (ev) => {
      try { map.getContainer().classList.remove("mapPickMode"); } catch {}
      setManualCreateCoords(ev.latlng.lat, ev.latlng.lng);
      if (adminModal) adminModal.style.display = "";
    });
  } catch {
    if (adminModal) adminModal.style.display = "";
  }
}

function fillManualCreateStartDefault() {
  const start = document.getElementById("manualCreateStart");
  if (!start || start.value) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  start.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function submitManualCreateEvent() {
  const btn = document.getElementById("manualCreateSubmitBtn");
  const msg = document.getElementById("manualCreateMsg");
  const old = btn?.textContent || "Přidat výjezd";

  try {
    const title = document.getElementById("manualCreateTitle")?.value?.trim() || "";
    if (!title) {
      if (msg) msg.textContent = "Vyplň název události.";
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Ukládám…";
    }
    if (msg) msg.textContent = "Ukládám ručně doplněný výjezd…";

    const payload = {
      title,
      cityText: document.getElementById("manualCreateCity")?.value || "",
      placeText: document.getElementById("manualCreatePlace")?.value || "",
      eventType: document.getElementById("manualCreateType")?.value || "other",
      statusMode: document.getElementById("manualCreateStatus")?.value || "open",
      alarmLevel: document.getElementById("manualCreateAlarm")?.value || "",
      isMajorEvent: !!document.getElementById("manualCreateMajor")?.checked,
      startTimeIso: manualCreateToIso(document.getElementById("manualCreateStart")?.value || ""),
      endTimeIso: manualCreateToIso(document.getElementById("manualCreateEnd")?.value || ""),
      lat: document.getElementById("manualCreateLat")?.value || "",
      lon: document.getElementById("manualCreateLon")?.value || "",
      manualDetailText: document.getElementById("manualCreateDetail")?.value || ""
    };

    const r = await fetch("/api/admin/events/manual-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || j.detail || "manual create failed");

    if (msg) msg.textContent = `Výjezd uložen. ID: ${j.id}`;
    ["manualCreateTitle", "manualCreateCity", "manualCreatePlace", "manualCreateLat", "manualCreateLon", "manualCreateDetail"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    await loadAll(true);
    await loadIngestDiagnostics();
  } catch (e) {
    if (msg) msg.textContent = `Nepodařilo se uložit: ${String(e.message || e)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

function formatDiagTime(value) {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat("cs-CZ", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); }
  catch { return String(value); }
}

async function loadIngestDiagnostics() {
  const summary = document.getElementById("ingestDiagnosticsSummary");
  const log = document.getElementById("ingestDiagnosticsLog");

  try {
    if (summary) summary.textContent = "Načítám diagnostiku…";

    const r = await fetch("/api/admin/ingest-diagnostics?limit=20", { credentials: "include", cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "diagnostics failed");

    const latestEvent = j.latestEvent;
    const latestIngestAt = j.latestIngestAt;
    const counts = j.counts || {};

    const lastEventTime = latestEvent?.created_at || latestEvent?.last_seen_at || latestEvent?.pub_date || null;
    let gapText = "";
    if (lastEventTime) {
      const diffMin = Math.round((Date.now() - new Date(lastEventTime).getTime()) / 60000);
      if (Number.isFinite(diffMin)) {
        gapText = diffMin > 120 ? `⚠ možná mezera ${Math.floor(diffMin/60)} h ${diffMin%60} min` : `OK • poslední data před ${diffMin} min`;
      }
    }

    if (summary) {
      summary.innerHTML = `
        <div><b>Poslední ingest:</b> ${escapeHtml(formatDiagTime(latestIngestAt))}</div>
        <div><b>Poslední událost v DB:</b> ${escapeHtml(latestEvent?.title || "—")}</div>
        <div><b>Čas poslední události:</b> ${escapeHtml(formatDiagTime(lastEventTime))}</div>
        <div><b>Počty:</b> 1 h: ${Number(counts.last1h || 0)} • 6 h: ${Number(counts.last6h || 0)} • 24 h: ${Number(counts.last24h || 0)}</div>
        <div><b>Stav:</b> ${escapeHtml(gapText || "—")}</div>
      `;
    }

    if (log) {
      const rows = Array.isArray(j.logs) ? j.logs : [];
      log.innerHTML = rows.length
        ? rows.map((x) => `
          <div class="ingestLogItem">
            <b>${escapeHtml(formatDiagTime(x.created_at))}</b>
            <span>${escapeHtml(x.source || "unknown")} • přijato ${Number(x.received_count || 0)} • přijato do DB ${Number(x.accepted_count || 0)} • nové ${Number(x.new_count || 0)} • aktualizace ${Number(x.updated_count || 0)}${x.error_text ? ` • chyba: ${escapeHtml(x.error_text)}` : ""}</span>
          </div>
        `).join("")
        : `<div class="muted">Zatím není žádný ingest log. Začne se plnit po nasazení této verze.</div>`;
    }
  } catch (e) {
    if (summary) summary.textContent = `Diagnostiku se nepodařilo načíst: ${String(e.message || e)}`;
  }
}

async function searchAdminEventsDb() {
  const box = document.getElementById("adminEventSearchInput");
  const results = document.getElementById("adminEventSearchResults");
  const q = box?.value?.trim() || "";

  if (!q) {
    if (results) results.innerHTML = `<div class="muted">Zadej název, město nebo ID.</div>`;
    return;
  }

  try {
    if (results) results.innerHTML = `<div class="muted">Hledám…</div>`;
    const filters = getFiltersFromUi?.() || {};
    const current = buildEventsQuery(filters);
    const r = await fetch(`/api/admin/events/search?q=${encodeURIComponent(q)}&limit=50${current ? `&${current}` : ""}`, {
      credentials: "include",
      cache: "no-store"
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.detail || j.error || "search failed");

    const items = Array.isArray(j.items) ? j.items : [];
    if (!items.length) {
      if (results) results.innerHTML = `<div class="muted">Nic nenalezeno.</div>`;
      return;
    }

    if (results) {
      results.innerHTML = items.map((it) => `
        <div class="adminSearchItem">
          <b>${escapeHtml(it.title || "")}</b>
          <span>${escapeHtml(it.city_text || it.place_text || "")} • ${escapeHtml(formatDate(it.pub_date || it.start_time_iso || it.created_at))} • ${it.is_closed ? "ukončená" : "aktivní"} • GPS: ${it.lat != null && it.lon != null ? "ano" : "ne"} • v hlavním přehledu: ${it.visible_in_current_overview ? "ano" : "ne"}</span>
          <small>ID: ${escapeHtml(it.id || "")}${it.source_kind === "manual" ? " • admin: ručně doplněno" : ""}</small>
        </div>
      `).join("");
    }
  } catch (e) {
    if (results) results.innerHTML = `<div class="err">Vyhledávání selhalo: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

function wireManualCreateAndDiagnostics() {
  document.getElementById("manualCreatePickMapBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    startManualCreateMapPick();
  });
  document.getElementById("manualCreateSubmitBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    submitManualCreateEvent();
  });
  document.getElementById("loadIngestDiagnosticsBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    loadIngestDiagnostics();
  });
  document.getElementById("adminEventSearchBtn")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    searchAdminEventsDb();
  });
  document.getElementById("adminEventSearchInput")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      searchAdminEventsDb();
    }
  });
  document.getElementById("adminBtn")?.addEventListener("click", () => {
    fillManualCreateStartDefault();
    setTimeout(() => loadIngestDiagnostics(), 150);
  });
}

// UI events
document.getElementById("refreshBtn").addEventListener("click", () => { resetFilters(); loadAll(); });
document.getElementById("applyBtn").addEventListener("click", loadAll);
document.getElementById("resetBtn").addEventListener("click", () => { resetFilters(); loadAll(); });
document.getElementById("exportCsvBtn").addEventListener("click", () => exportWithFilters("csv"));
document.getElementById("exportPdfBtn").addEventListener("click", () => exportWithFilters("pdf"));

// map resize on responsive changes
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => safeInvalidateMap(), 120);
});
window.addEventListener("orientationchange", () => safeInvalidateMap());

initMap();
initLandingPage();
wireProfessionalLayout();
wireCommandOverviewNav();
wireManualEventEditor();
wireManualCreateAndDiagnostics();
wireDurationAdminButtons();
wireStatusRecheckAdminButton();
wireEventDetailModal();
wireManualQuickEditList();
wireRegionalWeather();
wireMajorEventsBackfill();
wireWatchNotifications();



// FireWatchCZ v1.5 fix – safe initialization for Statistiky PRO
(function fwStatsProSafeInit() {
  function start() {
    const card = document.getElementById("statsProCard");
    if (!card || typeof wireStatsPro !== "function") return;

    if (card.dataset.fwStatsProWired === "1") {
      if (typeof loadStatsPro === "function") loadStatsPro();
      return;
    }

    card.dataset.fwStatsProWired = "1";
    wireStatsPro();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

// HZS stanice toggle (statická vrstva)
hzsStationsToggleEl = document.getElementById("hzsStationsToggle");
if (hzsStationsToggleEl) {
  if (hzsStationsToggleEl.checked) {
    hzsLayer.addTo(map);
  }
  hzsStationsToggleEl.addEventListener("change", () => {
    if (hzsStationsToggleEl.checked) {
      hzsLayer.addTo(map);
      renderHzsStations();
    } else {
      try { map.removeLayer(hzsLayer); } catch { /* ignore */ }
    }
  });
}

stationsReadyPromise = loadStations();

loadAll();

// AUTO REFRESH každých 5 minut (stabilní 1.02 – beze změny)
setInterval(() => {
  loadAll({ auto: true });
}, 5 * 60 * 1000);

// ==============================
// OPS / ADMIN + SHIFT UI (frontend)
// ==============================

const LS_SHIFT_MODE = "fwcz_shiftMode"; // lokální preference pro device
let serverDefaultShiftMode = "HZS";
// currentUser je definovaný nahoře

function apiFetch(url, opt = {}) {
  const o = { ...opt };
  o.credentials = "include";
  o.headers = { "Content-Type": "application/json", ...(o.headers || {}) };
  return fetch(url, o);
}


async function loadServerSettings() {
  try {
    const r = await fetch("/api/settings", { credentials: "include", cache: "no-store" });
    const j = await r.json();
    if (r.ok && j.ok && (j.default_shift_mode === "HZS" || j.default_shift_mode === "HZSP")) {
      serverDefaultShiftMode = j.default_shift_mode;
      const sel = document.getElementById("shiftModeSelect");
      if (sel && !localStorage.getItem(LS_SHIFT_MODE)) {
        sel.value = serverDefaultShiftMode;
      }
    }
  } catch {
    // ignore
  }
}


async function sendVisitPing() {
  try {
    // server si sám určí mode (public/ops/admin) podle session cookie
    await fetch("/api/visit", { method: "POST", credentials: "include" });
  } catch {
    // ignore
  }
}

function setModePill(modeText, roleText = "") {
  const el = document.getElementById("modePill");
  if (!el) return;
  el.textContent = roleText ? `${modeText} • ${roleText}` : modeText;

  if (modeText === "OPS") {
    el.style.background = "rgba(60, 180, 120, 0.20)";
    el.style.borderColor = "rgba(60, 180, 120, 0.35)";
  } else if (modeText === "HOST") {
    el.style.background = "rgba(90, 160, 255, 0.16)";
    el.style.borderColor = "rgba(90, 160, 255, 0.34)";
  } else {
    el.style.background = "rgba(255,255,255,0.06)";
    el.style.borderColor = "rgba(255,255,255,0.12)";
  }
}



// FireWatchCZ security/UI fix – admin menu only for admin role
function isCurrentUserAdmin() {
  return String(currentUser?.role || "").toLowerCase() === "admin";
}

function syncAdminVisibility() {
  const isAdmin = isCurrentUserAdmin();

  // Horní tlačítko Admin
  showEl("adminBtn", isAdmin);

  // Levé sidebar menu Admin
  document.querySelectorAll(".adminOnlyNav, [data-admin-only='true']").forEach((el) => {
    el.style.display = isAdmin ? "" : "none";
    el.setAttribute("aria-hidden", isAdmin ? "false" : "true");
  });

  // Admin-only ovládací prvky uvnitř karet
  document.querySelectorAll(".adminOnly").forEach((el) => {
    el.style.display = isAdmin ? "" : "none";
    el.setAttribute("aria-hidden", isAdmin ? "false" : "true");
  });
}


function showEl(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = on ? "" : "none";
}


let fwLastTypeBreakdownRows = [];

function fwPrettyType(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("fire") || t.includes("pož")) return "🔥 požár";
  if (t.includes("traffic") || t.includes("nehod") || t.includes("doprav")) return "🚗 dopravní nehoda";
  if (t.includes("rescue") || t.includes("zách")) return "🚑 záchrana";
  if (t.includes("false") || t.includes("plan") || t.includes("poplach")) return "🚫 planý poplach";
  if (t.includes("tech") || t.includes("techn")) return "🛠 technická pomoc";
  return "❓ jiné";
}

function fwIsClosedEvent(ev) {
  if (ev?.is_closed === true) return true;
  if (ev?.is_closed === false) return false;

  const status = String(ev?.status || ev?.state || ev?.stav || "").toLowerCase();
  if (status.includes("ukon") || status.includes("closed") || status.includes("done") || status.includes("resolved")) return true;
  if (ev?.ended_at || ev?.closed_at || ev?.end_at || ev?.finished_at || ev?.resolved_at) return true;
  return false;
}

function renderActiveClosedTypeBreakdown(rows) {
  const box = document.getElementById("activeClosedTypeBreakdown");
  if (!box || !Array.isArray(rows)) return;

  // Důležité: po refreshi se někdy zavolal záložní render s prázdným polem
  // a smazal správně vykreslená data. Prázdná data tedy ignorujeme,
  // pokud už máme poslední platný stav.
  if (rows.length > 0) {
    fwLastTypeBreakdownRows = rows;
  } else if (fwLastTypeBreakdownRows.length > 0) {
    rows = fwLastTypeBreakdownRows;
  } else {
    box.innerHTML = "";
    return;
  }

  const map = new Map();

  rows.forEach((ev) => {
    const type = fwPrettyType(ev.event_type || ev.type || ev.kind || ev.category);
    if (!map.has(type)) map.set(type, { active: 0, closed: 0 });
    if (fwIsClosedEvent(ev)) map.get(type).closed += 1;
    else map.get(type).active += 1;
  });

  const items = [...map.entries()]
    .sort((a, b) => ((b[1].active + b[1].closed) - (a[1].active + a[1].closed)));

  if (!items.length) return;

  box.innerHTML = items.map(([type, stats]) => `
    <div class="typeBreakdownItem">
      <div class="typeBreakdownTitle">${type}</div>
      <div class="typeBreakdownNums">
        <span><b>${stats.active}</b> aktivní</span>
        <span><b>${stats.closed}</b> ukončené</span>
      </div>
    </div>
  `).join("");
}

function syncPublicGuestUi() {
  const isLogged = !!currentUser;
  const isGuest = !isLogged;
  const hero = document.getElementById("publicGuestHero");
  const talkLocked = document.getElementById("talkLockedCard");
  const talkMount = document.getElementById("opsRadioMount");
  const talkLauncher = document.getElementById("talkLauncherCard");
  const toggleTalkBtn = document.getElementById("toggleTalkBtn");

  if (hero) {
    const dismissed = localStorage.getItem(LS_GUEST_HERO_DISMISSED) === "1";
    hero.style.display = (isGuest && !dismissed) ? "" : "none";
  }

  if (talkLauncher) {
    talkLauncher.style.display = "";
  }

  if (talkMount) {
    talkMount.style.display = (isLogged && talkPanelOpen) ? "" : "none";
  }

  if (talkLocked) {
    talkLocked.style.display = (isGuest && talkPanelOpen) ? "" : "none";
  }

  if (toggleTalkBtn) {
    if (talkPanelOpen) {
      toggleTalkBtn.textContent = "Skrýt FireWatch Talk 2.0";
      toggleTalkBtn.classList.add("active");
    } else {
      toggleTalkBtn.textContent = "Otevřít FireWatch Talk 2.0";
      toggleTalkBtn.classList.remove("active");
    }
  }

  document.body.classList.toggle("isGuestMode", isGuest);
  document.body.classList.toggle("isLoggedMode", isLogged);
  document.body.classList.toggle("isTalkOpen", talkPanelOpen);
}



function rerenderCurrentTableForAdminButtons() {
  if (Array.isArray(window.latestItemsSnapshot)) {
    try {
      renderTable(window.latestItemsSnapshot);
    } catch {}
  }
}

async function refreshMe() {
  try {
    const r = await apiFetch("/api/auth/me", { method: "GET" });
    if (!r.ok) throw new Error("no auth");
    const j = await r.json();
    if (!j.ok || !j.user) throw new Error("no user");
    currentUser = j.user;
  } catch {
    currentUser = null;
  }

  if (currentUser) {
    const role = String(currentUser.role || "public");
    const isOps = (role === "ops" || role === "admin");

    setModePill(isOps ? "OPS" : "ÚČET", role);

    showEl("loginBtn", false);
    showEl("registerBtn", false);
    showEl("logoutBtn", true);
    showEl("requestOpsBtn", !isOps && role === "public");
    showEl("audioBtn", isOps);
    showEl("briefingBtn", isOps);
    window.firewatchOpsRadioSetVisible?.(talkPanelOpen);
  } else {
    setModePill("HOST");
    showEl("loginBtn", true);
    showEl("registerBtn", true);
    showEl("logoutBtn", false);
    showEl("requestOpsBtn", false);
    showEl("audioBtn", false);
    showEl("briefingBtn", false);
    window.firewatchOpsRadioSetVisible?.(false);
  }

  syncAdminVisibility();
  syncPublicGuestUi();
}

function openModal(which) {
  syncAdminVisibility?.();
  if (which === "admin" && !isCurrentUserAdmin()) {
    alert("Admin panel je dostupný pouze pro uživatele s rolí admin.");
    return;
  }

  const back = document.getElementById("modalBackdrop");
  const login = document.getElementById("loginModal");
  const reg = document.getElementById("registerModal");
  const admin = document.getElementById("adminModal");
  const audio = document.getElementById("audioModal");
  if (!back || !login || !admin) return;

  back.style.display = "";
  login.style.display = which === "login" ? "" : "none";
  if (reg) reg.style.display = which === "register" ? "" : "none";
  admin.style.display = which === "admin" ? "" : "none";
  if (audio) audio.style.display = which === "audio" ? "" : "none";

  if (which === "login") {
    document.getElementById("loginMsg").textContent = "";
    setTimeout(() => document.getElementById("loginUser")?.focus(), 30);
  } else if (which === "register") {
    document.getElementById("regMsg").textContent = "";
    setTimeout(() => document.getElementById("regUser")?.focus(), 30);
  } else if (which === "admin") {
    // load extra admin widgets
    loadOpsRequests();
    loadMissingCoords();
  } else if (which === "audio") {
    syncAudioUi();
    setAudioMsg(audioState.unlocked ? "Audio připraveno." : "Tip: na mobilu/tabletu klikni na „Odemknout“.");
  }
}

function closeModals() {
  const back = document.getElementById("modalBackdrop");
  const login = document.getElementById("loginModal");
  const reg = document.getElementById("registerModal");
  const admin = document.getElementById("adminModal");
  const audio = document.getElementById("audioModal");
  if (back) back.style.display = "none";
  if (login) login.style.display = "none";
  if (reg) reg.style.display = "none";
  if (admin) admin.style.display = "none";
  if (audio) audio.style.display = "none";
}

function msg(id, text, ok = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.color = ok ? "rgba(120,255,180,0.9)" : "rgba(255,140,140,0.95)";
}

// ---------- Audio UI (OPS) ----------
function syncAudioUi() {
  const en = document.getElementById("audioEnabled");
  const vol = document.getElementById("audioVolume");
  const rate = document.getElementById("audioRate");
  const gongSel = document.getElementById("audioGongOnShift");
  const quietSel = document.getElementById("audioQuiet");

  if (en) en.checked = !!audioState.enabled;
  if (vol) vol.value = String(Math.round(clamp(audioState.volume, 0, 1) * 100));
  if (rate) rate.value = String(Math.round(clamp(audioState.rate, 0.8, 1.4) * 100));
  if (gongSel) gongSel.value = audioState.gongOnShift ? "on" : "off";
  if (quietSel) quietSel.value = audioState.quiet ? "on" : "off";
}

function wireAudioUiOnce() {
  const en = document.getElementById("audioEnabled");
  const unlockBtn = document.getElementById("audioUnlockBtn");
  const closeBtn = document.getElementById("audioCloseBtn");
  const vol = document.getElementById("audioVolume");
  const rate = document.getElementById("audioRate");
  const gongSel = document.getElementById("audioGongOnShift");
  const quietSel = document.getElementById("audioQuiet");

  if (closeBtn) closeBtn.addEventListener("click", closeModals);

  if (en) en.addEventListener("change", () => {
    audioState.enabled = !!en.checked;
    saveAudioPrefs();
    ensureSummarySchedule();
    setAudioMsg(audioState.enabled ? "Audio zapnuto." : "Audio vypnuto.");
  });

  if (unlockBtn) unlockBtn.addEventListener("click", () => unlockAudio());

  if (vol) vol.addEventListener("input", () => {
    audioState.volume = clamp((Number(vol.value) || 0) / 100, 0, 1);
    saveAudioPrefs();
  });

  if (rate) rate.addEventListener("input", () => {
    audioState.rate = clamp((Number(rate.value) || 100) / 100, 0.8, 1.4);
    saveAudioPrefs();
  });

  if (gongSel) gongSel.addEventListener("change", () => {
    audioState.gongOnShift = (gongSel.value === "on");
    saveAudioPrefs();
  });

  if (quietSel) quietSel.addEventListener("change", () => {
    audioState.quiet = (quietSel.value === "on");
    saveAudioPrefs();
  });

  document.getElementById("audioTestNew")?.addEventListener("click", () => {
    queueTask(() => speak("Test. Nová událost. Technická. Místo: Nehvizdy."));
  });
  document.getElementById("audioTestSummary")?.addEventListener("click", () => {
    queueTask(() => speak("Test. Souhrn přehledu. Aktivní tři. Ukončené deset."));
  });
  document.getElementById("audioTestShift")?.addEventListener("click", () => {
    queueTask(async () => {
      await playGongOnce();
      await speak("Test. Střídání směn. Nyní směna A.");
    });
  });
}


async function doRegister() {
  msg("regMsg", "Registruji…", true);
  const u = (document.getElementById("regUser")?.value || "").trim();
  const p = (document.getElementById("regPass")?.value || "");
  const requestOps = !!document.getElementById("regRequestOps")?.checked;

  if (!u || !p) return msg("regMsg", "Doplň uživatelské jméno a heslo.", false);
  if (p.length < 6) return msg("regMsg", "Heslo musí mít aspoň 6 znaků.", false);

  try {
    const r = await apiFetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p, request_ops: requestOps })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "register failed");

    msg("regMsg", requestOps ? "Hotovo. Účet vytvořen a žádost o OPS odeslána (čeká na schválení adminem)." : "Hotovo. Účet vytvořen (PUBLIC).", true);
    await refreshMe();
    closeModals();
    await loadAll();
  } catch (e) {
    const em = String(e.message || e);
    const map = {
      username_taken: "Toto uživatelské jméno už existuje.",
      bad_username: "Neplatné uživatelské jméno (povoleno: 3–32 znaků, písmena/čísla/._-).",
      bad_password: "Neplatné heslo (min. 6 znaků)."
    };
    msg("regMsg", map[em] || em, false);
  }
}

async function requestOpsAccess() {
  if (!currentUser || String(currentUser.role) !== "public") return;
  const btn = document.getElementById("requestOpsBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch("/api/auth/request-ops", { method: "POST" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "request failed");
    // jednoduchá feedback hláška přes status pill
    setStatus("Žádost o OPS odeslána (čeká na schválení).", true);
  } catch (e) {
    setStatus("Žádost o OPS se nepodařila.", false);
  } finally {
    if (btn) btn.disabled = false;
  }
}


async function doLogin() {
  msg("loginMsg", "Přihlašuji…", true);
  const u = (document.getElementById("loginUser")?.value || "").trim();
  const p = (document.getElementById("loginPass")?.value || "").trim();

  if (!u || !p) {
    msg("loginMsg", "Doplň username + heslo.", false);
    return;
  }

  try {
    const r = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: u, password: p })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "login failed");

    msg("loginMsg", "OK ✅", true);
    closeModals();
    await refreshMe();
  await sendVisitPing();
  } catch (e) {
    msg("loginMsg", `Chyba: ${String(e.message || e)}`, false);
  }
}

async function doLogout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {}
  await refreshMe();
  await sendVisitPing();
  closeModals();
}

// ---------- Admin ----------
function renderUsersTable(users) {
  const tbody = document.getElementById("usersTbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const u of users) {
    const tr = document.createElement("tr");

    const roleSelect = `
      <select data-role-user="${u.id}" class="miniSelect" style="min-width:110px;">
        <option value="ops" ${u.role === "ops" ? "selected" : ""}>ops</option>
        <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
      </select>
    `;

    const enabledBox = `<input type="checkbox" data-enabled-user="${u.id}" ${u.enabled ? "checked" : ""} />`;

    const lastLogin = u.last_login_at ? new Date(u.last_login_at).toLocaleString("cs-CZ") : "—";

    tr.innerHTML = `
      <td>${escapeHtml(u.id)}</td>
      <td>${escapeHtml(u.username)}</td>
      <td>${roleSelect}</td>
      <td style="text-align:center;">${enabledBox}</td>
      <td>${escapeHtml(lastLogin)}</td>
      <td>
        <button class="btn" data-reset-user="${u.id}">Reset hesla</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // wire events
  tbody.querySelectorAll("[data-role-user]").forEach(sel => {
    sel.addEventListener("change", async (e) => {
      const id = e.target.getAttribute("data-role-user");
      const role = e.target.value;
      await adminPatchUser(id, { role });
    });
  });
  tbody.querySelectorAll("[data-enabled-user]").forEach(ch => {
    ch.addEventListener("change", async (e) => {
      const id = e.target.getAttribute("data-enabled-user");
      const enabled = !!e.target.checked;
      await adminPatchUser(id, { enabled });
    });
  });
  tbody.querySelectorAll("[data-reset-user]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.getAttribute("data-reset-user");
      const newPass = prompt("Nové heslo (min 6 znaků):");
      if (!newPass) return;
      await adminPatchUser(id, { password: newPass });
    });
  });
}

async function adminLoadAll() {
  if (!currentUser || currentUser.role !== "admin") {
    msg("adminUsersMsg", "Nemáš admin oprávnění.", false);
    return;
  }

  msg("adminUsersMsg", "Načítám…", true);
  try {
    // users
    const r = await apiFetch("/api/admin/users", { method: "GET" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "load users failed");
    renderUsersTable(j.users || []);
    msg("adminUsersMsg", `OK • ${j.users?.length || 0} uživatelů`, true);
  } catch (e) {
    msg("adminUsersMsg", `Chyba: ${String(e.message || e)}`, false);
  }

  // settings
  try {
    const r2 = await apiFetch("/api/admin/settings", { method: "GET" });
    const j2 = await r2.json();
    if (r2.ok && j2.ok && j2.default_shift_mode) {
      document.getElementById("adminDefaultShift").value = j2.default_shift_mode;
    }
  } catch {
    // ignore
  }
}

async function adminLoadVisitsStats() {
  if (!currentUser || currentUser.role !== "admin") return;

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };

  try {
    const r = await apiFetch("/api/admin/visits/stats", { method: "GET" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "load visits failed");

    setVal("visitsToday", String(j.today?.grand ?? "0"));
    setVal("visits7", String(j.last7?.grand ?? "0"));
    setVal("visits30", String(j.last30?.grand ?? "0"));

    const hint = (obj) => {
      const t = obj?.totals || {};
      const p = Number(t.public || 0);
      const o = Number(t.ops || 0);
      const a = Number(t.admin || 0);
      return `Public ${p} • OPS ${o} • Admin ${a}`;
    };
    msg("visitsMsg", `${hint(j.last30)}`, true);
  } catch (e) {
    msg("visitsMsg", `Chyba: ${String(e.message || e)}`, false);
  }
}


async function adminCreateUser() {
  msg("adminCreateMsg", "", true);
  const username = (document.getElementById("newUser")?.value || "").trim();
  const password = (document.getElementById("newPass")?.value || "").trim();
  const role = document.getElementById("newRole")?.value || "ops";
  const enabled = !!document.getElementById("newEnabled")?.checked;

  if (!username || !password || password.length < 6) {
    msg("adminCreateMsg", "Vyplň username + heslo (min 6).", false);
    return;
  }

  try {
    const r = await apiFetch("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username, password, role, enabled })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "create failed");
    msg("adminCreateMsg", "Uživatel vytvořen ✅", true);
    document.getElementById("newPass").value = "";
    await adminLoadAll();
    await adminLoadVisitsStats();
  } catch (e) {
    msg("adminCreateMsg", `Chyba: ${String(e.message || e)}`, false);
  }
}

async function adminPatchUser(id, patch) {
  msg("adminUsersMsg", "Ukládám…", true);
  try {
    const r = await apiFetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "update failed");
    msg("adminUsersMsg", "Uloženo ✅", true);
    await adminLoadAll();
    await adminLoadVisitsStats();
  } catch (e) {
    msg("adminUsersMsg", `Chyba: ${String(e.message || e)}`, false);
  }
}

async function adminSaveSettings() {
  const val = document.getElementById("adminDefaultShift")?.value || "HZS";
  msg("adminSettingsMsg", "Ukládám…", true);
  try {
    const r = await apiFetch("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ default_shift_mode: val })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "save failed");
    msg("adminSettingsMsg", "Uloženo ✅", true);

    serverDefaultShiftMode = val;
    const sel = document.getElementById("shiftModeSelect");
    if (sel && !localStorage.getItem(LS_SHIFT_MODE)) {
      sel.value = val;
    }
  } catch (e) {
    msg("adminSettingsMsg", `Chyba: ${String(e.message || e)}`, false);
  }
}

// ---------- Shift logic ----------
// Reference: 2026-02-06 je směna C, další den A, další B.
const SHIFT_ORDER = ["A", "B", "C"]; // index 0..2
const REF_DATE_YYYY_MM_DD = "2026-02-06";
const REF_SHIFT = "C";

function parseYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}

function shiftBoundaryHour(mode) {
  return mode === "HZSP" ? 6 : 7;
}

function floorToShiftDayLocal(now, boundaryHour) {
  // "Shift day" začíná v boundaryHour:00 místního času.
  const d = new Date(now);
  const h = d.getHours();
  const res = new Date(d);
  if (h < boundaryHour) {
    res.setDate(res.getDate() - 1);
  }
  res.setHours(0, 0, 0, 0);
  return res;
}

function diffDaysLocal(a, b) {
  // rozdíl dnů mezi local dates (midnight)
  const aa = new Date(a); aa.setHours(0,0,0,0);
  const bb = new Date(b); bb.setHours(0,0,0,0);
  const ms = aa.getTime() - bb.getTime();
  return Math.round(ms / 86400000);
}

function computeShiftFor(now, mode) {
  const boundary = shiftBoundaryHour(mode);
  const shiftDay = floorToShiftDayLocal(now, boundary);

  // reference date as local midnight of same day
  const refUtc = parseYmd(REF_DATE_YYYY_MM_DD);
  const refLocal = new Date(refUtc.getUTCFullYear(), refUtc.getUTCMonth(), refUtc.getUTCDate(), 0,0,0,0);

  const dDays = diffDaysLocal(shiftDay, refLocal);
  const refIdx = SHIFT_ORDER.indexOf(REF_SHIFT);
  const idx = ((refIdx + dDays) % 3 + 3) % 3;
  const cur = SHIFT_ORDER[idx];
  const next1 = SHIFT_ORDER[(idx + 1) % 3];
  const next2 = SHIFT_ORDER[(idx + 2) % 3];

  // countdown to next boundary
  const nextBoundary = new Date(shiftDay);
  nextBoundary.setDate(nextBoundary.getDate() + 1);
  nextBoundary.setHours(boundary, 0, 0, 0);

  return { cur, next1, next2, nextBoundary };
}

function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (v) => (v < 10 ? `0${v}` : String(v));
  return `${hh}h ${two(mm)}m ${two(ss)}s`;
}

function getShiftModeFromUi() {
  const sel = document.getElementById("shiftModeSelect");
  return sel?.value || "HZS";
}

function tickShiftUi() {
  const now = new Date();
  const mode = getShiftModeFromUi();
  const s = computeShiftFor(now, mode);

  const elNow = document.getElementById("shiftNow");
  const elCd = document.getElementById("shiftCountdown");
  const elN3 = document.getElementById("shiftNext3");

  if (elNow) elNow.textContent = s.cur;
  if (elCd) elCd.textContent = `Předání za ${fmtCountdown(s.nextBoundary.getTime() - now.getTime())}`;
  if (elN3) elN3.textContent = `Dnes ${s.cur} • Zítra ${s.next1} • Pozítří ${s.next2}`;

  // 🔊 předání směny (OPS): gong + hlas (lze vypnout)
  audioTickShift();
}

async function loadPublicSettings() {
  try {
    const r = await fetch("/api/settings", { credentials: "include", cache: "no-store" });
    const j = await r.json();
    if (j.ok && j.default_shift_mode) serverDefaultShiftMode = j.default_shift_mode;
  } catch {
    // ignore
  }

  const sel = document.getElementById("shiftModeSelect");
  if (!sel) return;
  const local = localStorage.getItem(LS_SHIFT_MODE);
  sel.value = local || serverDefaultShiftMode;
  sel.addEventListener("change", () => {
    localStorage.setItem(LS_SHIFT_MODE, sel.value);
    tickShiftUi();
  });
}

// ---------- Fullscreen + TV ----------

// ---------- Admin: OPS requests ----------
async function loadOpsRequests() {
  if (!currentUser || currentUser.role !== "admin") return;
  const tbody = document.getElementById("opsReqTbody");
  if (!tbody) return;

  msg("opsReqMsg", "Načítám…", true);
  try {
    const r = await apiFetch("/api/admin/ops-requests?limit=100", { method: "GET" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "load failed");
    const rows = j.rows || [];
    tbody.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(row.id);
      tr.appendChild(tdId);

      const tdUser = document.createElement("td");
      tdUser.textContent = row.username || String(row.user_id);
      tr.appendChild(tdUser);

      const tdTs = document.createElement("td");
      tdTs.textContent = row.requested_at ? new Date(row.requested_at).toLocaleString("cs-CZ") : "—";
      tr.appendChild(tdTs);

      const tdAct = document.createElement("td");
      const okBtn = document.createElement("button");
      okBtn.className = "btn primary";
      okBtn.textContent = "Schválit OPS";
      okBtn.addEventListener("click", async () => {
        okBtn.disabled = true;
        try {
          const rr = await apiFetch(`/api/admin/ops-requests/${row.id}/approve`, { method: "POST" });
          const jj = await rr.json();
          if (!rr.ok || !jj.ok) throw new Error(jj.error || "approve failed");
          msg("opsReqMsg", "Schváleno.", true);
          await refreshMe();
          await adminLoadAll();
          await loadOpsRequests();
        } catch (e) {
          msg("opsReqMsg", String(e.message || e), false);
        } finally {
          okBtn.disabled = false;
        }
      });

      const noBtn = document.createElement("button");
      noBtn.className = "btn";
      noBtn.textContent = "Zamítnout";
      noBtn.style.marginLeft = "8px";
      noBtn.addEventListener("click", async () => {
        noBtn.disabled = true;
        try {
          const rr = await apiFetch(`/api/admin/ops-requests/${row.id}/reject`, { method: "POST" });
          const jj = await rr.json();
          if (!rr.ok || !jj.ok) throw new Error(jj.error || "reject failed");
          msg("opsReqMsg", "Zamítnuto.", true);
          await loadOpsRequests();
        } catch (e) {
          msg("opsReqMsg", String(e.message || e), false);
        } finally {
          noBtn.disabled = false;
        }
      });

      tdAct.appendChild(okBtn);
      tdAct.appendChild(noBtn);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    }

    msg("opsReqMsg", rows.length ? `Čeká ${rows.length} žádostí.` : "Žádné čekající žádosti.", true);
  } catch (e) {
    msg("opsReqMsg", String(e.message || e), false);
    tbody.innerHTML = "";
  }
}

// ---------- Admin: Missing coordinates ----------
let pickingCoords = false;
let tempPickMarker = null;

// while picking, we temporarily close modals so Leaflet receives clicks
let pickReturnModal = null;
let pickOverlayEl = null;

function ensurePickOverlay() {
  if (pickOverlayEl) return pickOverlayEl;
  const el = document.createElement("div");
  el.id = "pickOverlay";
  el.style.position = "fixed";
  el.style.left = "14px";
  el.style.bottom = "14px";
  el.style.zIndex = "99999";
  el.style.background = "rgba(15, 20, 28, 0.92)";
  el.style.border = "1px solid rgba(255,255,255,0.12)";
  el.style.borderRadius = "12px";
  el.style.padding = "10px 12px";
  el.style.backdropFilter = "blur(8px)";
  el.style.display = "none";
  el.style.maxWidth = "360px";
  el.innerHTML = `
    <div style="font-weight:600; margin-bottom:6px;">Výběr souřadnic</div>
    <div id="pickOverlayText" style="opacity:.9; font-size:13px; line-height:1.25;">
      Klikni do mapy pro výběr bodu.
    </div>
    <div style="display:flex; gap:8px; margin-top:8px; justify-content:flex-end;">
      <button id="pickOverlayCancel" class="btn">Zrušit</button>
    </div>
  `;
  document.body.appendChild(el);

  // cancel pick
  el.querySelector("#pickOverlayCancel")?.addEventListener("click", () => {
    stopPickMode(true);
    msg("coordsMsg", "Výběr zrušen.", true);
  });

  pickOverlayEl = el;
  return el;
}

function startPickMode() {
  const id = document.getElementById("coordsEventId")?.value?.trim();
  if (!id) return msg("coordsMsg", "Nejdřív vyber událost.", false);

  pickingCoords = true;
  pickReturnModal = "admin";

  // close modals so map can receive click
  closeModals();

  const btn = document.getElementById("pickOnMapBtn");
  if (btn) btn.textContent = "Klikni do mapy…";

  const ov = ensurePickOverlay();
  const t = ov.querySelector("#pickOverlayText");
  if (t) t.textContent = `Klikni do mapy pro výběr bodu (událost ${id}).`;
  ov.style.display = "";

  msg("coordsMsg", "Klikni do mapy pro výběr bodu.", true);
}

function stopPickMode(reopen = false) {
  pickingCoords = false;

  const btn = document.getElementById("pickOnMapBtn");
  if (btn) btn.textContent = "Vybrat na mapě";

  if (pickOverlayEl) pickOverlayEl.style.display = "none";

  if (reopen && pickReturnModal) {
    openModal(pickReturnModal);
  }
  pickReturnModal = null;
}

function setPickMode(on) {
  if (on) startPickMode();
  else stopPickMode(true);
}


function showCoordsEditorForEvent(ev) {
  const card = document.getElementById("coordsEditorCard");
  const title = document.getElementById("coordsSelectedTitle");
  const meta = document.getElementById("coordsSelectedMeta");

  if (card) card.style.display = "";
  if (title) title.textContent = ev?.title || ev?.id || "Vybraná událost";
  if (meta) {
    const city = ev?.city_text || ev?.place_text || "bez města";
    const status = ev?.status_text || (ev?.is_closed ? "ukončená" : "aktivní");
    meta.textContent = `${ev?.id || ""} • ${city} • ${status}`;
  }

  document.getElementById("coordsEventId").value = String(ev?.id || "");
  document.getElementById("coordsLat").value = "";
  document.getElementById("coordsLon").value = "";

  setPickMode(false);
  msg("coordsMsg", `Vybrána událost: ${ev?.id || ""}. Můžeš zadat GPS, načíst návrhy nebo vybrat bod v mapě.`, true);

  try { card?.scrollIntoView({ behavior: "smooth", block: "center" }); } catch {}
}

function minimizeAdminForMapPick() {
  const back = document.getElementById("modalBackdrop");
  const admin = document.getElementById("adminModal");
  const restore = document.getElementById("restoreAdminPanelBtn");

  if (!document.getElementById("coordsEventId")?.value?.trim()) {
    msg("coordsMsg", "Nejdřív vyber událost.", false);
    return;
  }

  if (back) back.style.display = "none";
  if (admin) admin.style.display = "none";
  if (restore) restore.style.display = "";

  setPickMode(true);
  msg("coordsMsg", "Klikni do mapy na místo události. Potom se vrať tlačítkem „Zpět do adminu“.", true);
}

function restoreAdminPanelAfterMapPick() {
  const back = document.getElementById("modalBackdrop");
  const admin = document.getElementById("adminModal");
  const restore = document.getElementById("restoreAdminPanelBtn");

  if (back) back.style.display = "";
  if (admin) admin.style.display = "";
  if (restore) restore.style.display = "none";

  try {
    document.getElementById("coordsEditorCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {}
}

async function loadMissingCoords() {
  if (!currentUser || currentUser.role !== "admin") return;
  const tbody = document.getElementById("missingCoordsTbody");
  const info = document.getElementById("missingCoordsInfo");
  if (!tbody) return;

  if (info) info.textContent = "Načítám…";
  try {
    const r = await apiFetch("/api/admin/events-missing-coords?limit=80", { method: "GET" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "load failed");
    const rows = j.rows || [];
    tbody.innerHTML = "";
    for (const ev of rows) {
      const tr = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(ev.id);
      tr.appendChild(tdId);

      const tdTitle = document.createElement("td");
      tdTitle.textContent = String(ev.title || "—");
      tr.appendChild(tdTitle);

      const tdCity = document.createElement("td");
      tdCity.textContent = String(ev.city_text || ev.place_text || "—");
      tr.appendChild(tdCity);

      const tdSt = document.createElement("td");
      tdSt.textContent = String(ev.status_text || (ev.is_closed ? "ukončená" : "aktivní") || "—");
      tr.appendChild(tdSt);

      const tdAct = document.createElement("td");
      const pickBtn = document.createElement("button");
      pickBtn.className = "btn";
      pickBtn.textContent = "Vybrat / edit";
      pickBtn.addEventListener("click", () => {
        showCoordsEditorForEvent(ev);
        // posuň mapu aspoň na Středočeský kraj, ať se kliká pohodlně
        try { map?.setView([49.9, 15.0], 9); } catch {}
      });
      tdAct.appendChild(pickBtn);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    }
    if (info) info.textContent = rows.length ? `Nalezeno ${rows.length} událostí bez souřadnic pro vybraný den.` : "Pro vybraný den nejsou žádné události bez souřadnic.";
  } catch (e) {
    if (info) info.textContent = "Chyba načítání.";
    tbody.innerHTML = "";
    msg("coordsMsg", String(e.message || e), false);
  }
}

async function autoGeocodeMissingCoords() {
  if (!currentUser || currentUser.role !== "admin") return;
  const btn = document.getElementById("autoGeocodeMissingBtn");
  const oldText = btn?.textContent || "Auto doplnit GPS";

  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Doplňuji…";
    }

    const day = document.getElementById("daySelect")?.value || "today";

    msg("coordsMsg", `Zkouším automaticky dohledat souřadnice pro prvních 10 chybějících událostí ve vybraném dni (${day})…`, true);

    const r = await apiFetch(`/api/admin/geocode-missing?limit=10&day=${encodeURIComponent(day)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 10, day })
    });

    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "auto geocode failed");

    msg("coordsMsg", `Hotovo. Zkontrolováno ${j.checked}, doplněno ${j.fixed}.`, true);

    await loadMissingCoords();
    await loadAll(true);
  } catch (e) {
    msg("coordsMsg", `Auto doplnění GPS selhalo: ${String(e.message || e)}`, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}




async function loadGeoSuggestionsForSelected() {
  const id = document.getElementById("coordsEventId")?.value?.trim();
  const box = document.getElementById("geoSuggestionsBox");
  if (!id) {
    msg("coordsMsg", "Nejprve vyber událost bez souřadnic.", false);
    return;
  }
  if (box) box.innerHTML = `<div class="hint">Načítám návrhy GPS…</div>`;

  try {
    const r = await apiFetch(`/api/admin/geocode-suggestions/${encodeURIComponent(id)}`);
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "suggestions failed");

    const suggestions = j.suggestions || [];
    if (!suggestions.length) {
      if (box) box.innerHTML = `<div class="hint">Žádný návrh GPS se nepodařilo najít. Zkus vybrat bod ručně v mapě.</div>`;
      return;
    }

    if (box) {
      box.innerHTML = suggestions.map((s, idx) => `
        <button class="geoSuggestionItem" data-lat="${escapeHtml(String(s.lat))}" data-lon="${escapeHtml(String(s.lon))}" data-source="${escapeHtml(s.source || "suggestion")}" data-note="${escapeHtml(s.query || "")}">
          <span>
            <b>Návrh ${idx + 1}</b>
            <small>${escapeHtml(s.label || s.query || "")}</small>
            <small>${escapeHtml(s.source || "suggestion")} • jistota ${Number(s.confidence || 0)} %</small>
          </span>
          <span>${Number(s.lat).toFixed(5)}, ${Number(s.lon).toFixed(5)}</span>
        </button>
      `).join("");

      box.querySelectorAll(".geoSuggestionItem").forEach(btn => {
        btn.addEventListener("click", () => {
          document.getElementById("coordsLat").value = btn.dataset.lat || "";
          document.getElementById("coordsLon").value = btn.dataset.lon || "";
          msg("coordsMsg", `Návrh vložen do polí. Potvrď tlačítkem Uložit.`, true);
          try {
            map?.setView([Number(btn.dataset.lat), Number(btn.dataset.lon)], 13);
          } catch {}
        });
      });
    }
  } catch (e) {
    if (box) box.innerHTML = "";
    msg("coordsMsg", `Návrhy GPS se nepodařilo načíst: ${String(e.message || e)}`, false);
  }
}


async function saveCoordsForSelected() {
  const id = document.getElementById("coordsEventId")?.value?.trim();
  const lat = Number(document.getElementById("coordsLat")?.value);
  const lon = Number(document.getElementById("coordsLon")?.value);
  if (!id) return msg("coordsMsg", "Nejdřív vyber událost.", false);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return msg("coordsMsg", "Zadej platné lat/lon.", false);

  try {
    const r = await apiFetch(`/api/admin/events/${encodeURIComponent(id)}/coords`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "save failed");
    msg("coordsMsg", "Uloženo.", true);
    setPickMode(false);
    if (tempPickMarker) { try { map.removeLayer(tempPickMarker); } catch {} tempPickMarker = null; }
    await loadMissingCoords();
    await loadAll(); // refresh map + lists
  } catch (e) {
    msg("coordsMsg", String(e.message || e), false);
  }
}

async function clearCoordsForSelected() {
  const id = document.getElementById("coordsEventId")?.value?.trim();
  if (!id) return msg("coordsMsg", "Nejdřív vyber událost.", false);
  try {
    const r = await apiFetch(`/api/admin/events/${encodeURIComponent(id)}/coords`, { method: "DELETE" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "clear failed");
    msg("coordsMsg", "Souřadnice smazány.", true);
    setPickMode(false);
    if (tempPickMarker) { try { map.removeLayer(tempPickMarker); } catch {} tempPickMarker = null; }
    await loadMissingCoords();
    await loadAll();
  } catch (e) {
    msg("coordsMsg", String(e.message || e), false);
  }
}

function wireMissingCoordsUiOnce() {
  document.getElementById("reloadMissingCoordsBtn")?.addEventListener("click", loadMissingCoords);
  document.getElementById("autoGeocodeMissingBtn")?.addEventListener("click", autoGeocodeMissingCoords);
  document.getElementById("pickOnMapBtn")?.addEventListener("click", () => {
    if (pickingCoords) return setPickMode(false);
    setPickMode(true);
  });
  document.getElementById("saveCoordsBtn")?.addEventListener("click", saveCoordsForSelected);
  document.getElementById("loadGeoSuggestionsBtn")?.addEventListener("click", loadGeoSuggestionsForSelected);
  document.getElementById("minimizeAdminForMapBtn")?.addEventListener("click", minimizeAdminForMapPick);
  document.getElementById("scrollToCoordsEditorBtn")?.addEventListener("click", () => document.getElementById("coordsEventId")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  document.getElementById("restoreAdminPanelBtn")?.addEventListener("click", restoreAdminPanelAfterMapPick);
  document.getElementById("clearCoordsBtn")?.addEventListener("click", clearCoordsForSelected);
}

function toggleFullscreen() {
  const doc = document;
  const el = document.documentElement;
  if (!doc.fullscreenElement) {
    el.requestFullscreen?.();
  } else {
    doc.exitFullscreen?.();
  }
}

function toggleTvMode() {
  document.body.classList.toggle("tvMode");
  safeInvalidateMap();
}

// Wire UI
(async function initOpsFrontend() {
  // TTS voices
  ensureVoicesHooked();

  // audio prefs
  loadAudioPrefs();

  // master mute
  loadMasterMute();
  applyMasterMute();
  wireAudioUiOnce();
  syncAudioUi();

  // buttons
  document.getElementById("loginBtn")?.addEventListener("click", () => clickElementById("loginBtn"));
  document.getElementById("registerBtn")?.addEventListener("click", () => clickElementById("registerBtn"));
  document.getElementById("requestOpsBtn")?.addEventListener("click", requestOpsAccess);
  document.getElementById("logoutBtn")?.addEventListener("click", doLogout);
  document.getElementById("adminBtn")?.addEventListener("click", async () => {
    openModal("admin");
    await adminLoadAll();
    await adminLoadVisitsStats();
  });
  document.getElementById("audioBtn")?.addEventListener("click", () => openModal("audio"));
  document.getElementById("briefingBtn")?.addEventListener("click", runBriefing);
  document.getElementById("fullscreenBtn")?.addEventListener("click", toggleFullscreen);
  document.getElementById("muteBtn")?.addEventListener("click", toggleMasterMute);
  document.getElementById("tvModeBtn")?.addEventListener("click", toggleTvMode);
  document.getElementById("audioBtn")?.addEventListener("click", () => openModal("audio"));

  // modal close
  document.getElementById("modalBackdrop")?.addEventListener("click", closeModals);
  document.getElementById("loginCloseBtn")?.addEventListener("click", closeModals);
  document.getElementById("loginCancelBtn")?.addEventListener("click", closeModals);
  document.getElementById("registerCloseBtn")?.addEventListener("click", closeModals);
  document.getElementById("regCancelBtn")?.addEventListener("click", closeModals);
  document.getElementById("regSubmitBtn")?.addEventListener("click", doRegister);
  // allow enter in register
  document.getElementById("regPass")?.addEventListener("keydown", (e) => { if (e.key === "Enter") doRegister(); });
  wireMissingCoordsUiOnce();
  document.getElementById("adminCloseBtn")?.addEventListener("click", closeModals);

  // login submit
  document.getElementById("loginSubmitBtn")?.addEventListener("click", doLogin);
  document.getElementById("loginPass")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });

  // admin actions
  document.getElementById("createUserBtn")?.addEventListener("click", adminCreateUser);
  document.getElementById("adminSaveSettings")?.addEventListener("click", adminSaveSettings);

  // settings + shift
  await loadPublicSettings();
  tickShiftUi();
  setInterval(tickShiftUi, 1000);

  // 🔊 souhrn každé 3 hodiny (OPS): tick každých 30 s
  ensureSummarySchedule();
  setInterval(audioTickSummary, 30000);

  // 🔊 souhrn po 3h (OPS) — běží nenápadně, hlásí jen pokud je audio zapnuté
  ensureSummarySchedule();
  setInterval(audioTickSummary, 30000);

  // 🔊 souhrn po 3 hodinách (OPS): jen hlas, žádný spam
  ensureSummarySchedule();
  setInterval(audioTickSummary, 30 * 1000);

  // auth state
  await syncPublicGuestUi();
refreshMe();
  await sendVisitPing();
})();


function toggleTalkPanel() {
  talkPanelOpen = !talkPanelOpen;
  localStorage.setItem(LS_TALK_PANEL_OPEN, talkPanelOpen ? "1" : "0");
  if (typeof window.firewatchOpsRadioSetVisible === "function") {
    window.firewatchOpsRadioSetVisible(!!currentUser && talkPanelOpen);
  }
  syncPublicGuestUi();
}

// FireWatchCZ guest-mode safety wiring.
// This fallback keeps top-bar buttons working even if earlier init code changes.
(function firewatchSafetyWireButtons() {
  function byId(id) { return document.getElementById(id); }
  function on(id, fn) {
    const el = byId(id);
    if (!el) return;
    if (el.dataset.fwSafetyWired === "1") return;
    el.dataset.fwSafetyWired = "1";
    el.addEventListener("click", fn);
  }

  on("guestContinueBtn", () => {
    localStorage.setItem(LS_GUEST_HERO_DISMISSED, "1");
    syncPublicGuestUi?.();
  });

  on("toggleTalkBtn", toggleTalkPanel);
  on("guestLoginBtn", () => byId("loginBtn")?.click());
  on("guestRegisterBtn", () => byId("registerBtn")?.click());
  on("talkLockedLoginBtn", () => byId("loginBtn")?.click());
  on("talkLockedRegisterBtn", () => byId("registerBtn")?.click());

  syncPublicGuestUi?.();
})();


// -----------------------------------------------------------------------------
// FireWatchCZ login/register fallback
// Keeps login and registration working in public/guest mode.
// -----------------------------------------------------------------------------
function fwPrompt(title, fields, onSubmit) {
  const old = document.getElementById("fwPromptOverlay");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "fwPromptOverlay";
  overlay.className = "fwPromptOverlay";

  const box = document.createElement("div");
  box.className = "fwPromptBox";

  const h = document.createElement("h2");
  h.textContent = title;
  box.appendChild(h);

  const inputs = {};

  fields.forEach((f) => {
    const label = document.createElement("label");
    label.className = "fwPromptLabel";
    label.textContent = f.label;

    const input = document.createElement("input");
    input.className = "fwPromptInput";
    input.type = f.type || "text";
    input.placeholder = f.placeholder || "";
    input.value = f.value || "";
    input.autocomplete = f.autocomplete || "off";

    label.appendChild(input);
    box.appendChild(label);
    inputs[f.name] = input;
  });

  const msg = document.createElement("div");
  msg.className = "fwPromptMsg";
  box.appendChild(msg);

  const actions = document.createElement("div");
  actions.className = "fwPromptActions";

  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Zrušit";
  cancel.addEventListener("click", () => overlay.remove());

  const submit = document.createElement("button");
  submit.className = "btn primary";
  submit.textContent = title.includes("Registr") ? "Registrovat" : "Přihlásit";
  submit.addEventListener("click", async () => {
    msg.textContent = "";
    submit.disabled = true;
    try {
      const values = {};
      Object.entries(inputs).forEach(([key, input]) => values[key] = input.value.trim());

      await onSubmit(values, msg);
      overlay.remove();

      if (typeof refreshMe === "function") await refreshMe();
      if (typeof syncPublicGuestUi === "function") syncPublicGuestUi();
      if (typeof loadAll === "function") loadAll();
    } catch (e) {
      msg.textContent = e?.message || "Akce se nepodařila.";
    } finally {
      submit.disabled = false;
    }
  });

  actions.appendChild(cancel);
  actions.appendChild(submit);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const first = Object.values(inputs)[0];
  if (first) setTimeout(() => first.focus(), 50);
}

async function fwPostJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });

  let data = null;
  try { data = await res.json(); } catch (_) {}

  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return data || {};
}

function fwOpenLoginDialog() {
  fwPrompt("Přihlášení", [
    { name: "username", label: "Uživatelské jméno", autocomplete: "username" },
    { name: "password", label: "Heslo", type: "password", autocomplete: "current-password" }
  ], async (v, msg) => {
    if (!v.username || !v.password) throw new Error("Vyplň uživatelské jméno a heslo.");
    msg.textContent = "Přihlašuji…";

    const endpoints = ["/api/auth/login", "/api/login", "/auth/login"];
    let lastError = null;

    for (const ep of endpoints) {
      try {
        await fwPostJson(ep, { username: v.username, password: v.password });
        return;
      } catch (e) {
        lastError = e;
      }
    }

    throw lastError || new Error("Přihlášení se nepodařilo.");
  });
}

function fwOpenRegisterDialog() {
  fwPrompt("Registrace", [
    { name: "username", label: "Uživatelské jméno", autocomplete: "username" },
    { name: "name", label: "Zobrazované jméno" },
    { name: "password", label: "Heslo", type: "password", autocomplete: "new-password" },
    { name: "password2", label: "Heslo znovu", type: "password", autocomplete: "new-password" }
  ], async (v, msg) => {
    if (!v.username || v.username.length < 3) throw new Error("Uživatelské jméno musí mít aspoň 3 znaky.");
    if (!v.password || v.password.length < 6) throw new Error("Heslo musí mít aspoň 6 znaků.");
    if (v.password !== v.password2) throw new Error("Hesla se neshodují.");

    msg.textContent = "Registruji…";

    const payload = {
      username: v.username,
      name: v.name || v.username,
      displayName: v.name || v.username,
      password: v.password
    };

    const endpoints = ["/api/auth/register", "/api/register", "/auth/register"];
    let lastError = null;

    for (const ep of endpoints) {
      try {
        await fwPostJson(ep, payload);

        // Try auto-login after registration.
        try {
          await fwPostJson("/api/auth/login", { username: v.username, password: v.password });
        } catch (_) {
          try { await fwPostJson("/api/login", { username: v.username, password: v.password }); } catch (_) {}
        }

        return;
      } catch (e) {
        lastError = e;
      }
    }

    throw lastError || new Error("Registrace se nepodařila.");
  });
}

(function fwWireLoginRegisterFallback() {
  function wire(id, fn) {
    const el = document.getElementById(id);
    if (!el) return;

    // Capture phase prevents broken previous handlers from swallowing the click.
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      fn();
    }, true);
  }

  wire("loginBtn", fwOpenLoginDialog);
  wire("registerBtn", fwOpenRegisterDialog);
  wire("guestLoginBtn", fwOpenLoginDialog);
  wire("guestRegisterBtn", fwOpenRegisterDialog);
  wire("talkLockedLoginBtn", fwOpenLoginDialog);
  wire("talkLockedRegisterBtn", fwOpenRegisterDialog);
})();




// -----------------------------------------------------------------------------
// FireWatchCZ Reports Archive - safe wiring fallback
// -----------------------------------------------------------------------------
(function fwReportsArchiveSafeInit() {
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function wire(id, handler) {
    const el = byId(id);
    if (!el) return false;
    if (el.dataset.fwReportsWired === "1") return true;
    el.dataset.fwReportsWired = "1";
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        await handler(ev);
      } catch (e) {
        console.error("[reports] action failed:", e);
        alert("Akce archivu souhrnů selhala: " + (e?.message || e));
      }
    });
    return true;
  }

  ready(() => {
    const typeEl = byId("reportTypeSelect");
    const keyEl = byId("reportKeyInput");

    if (!typeEl || !keyEl) return;

    if (typeof defaultReportKey === "function" && !keyEl.value.trim()) {
      keyEl.value = defaultReportKey(typeEl.value);
    }

    if (typeEl.dataset.fwReportsTypeWired !== "1") {
      typeEl.dataset.fwReportsTypeWired = "1";
      typeEl.addEventListener("change", () => {
        if (typeof defaultReportKey === "function") {
          keyEl.value = defaultReportKey(typeEl.value);
        }
      });
    }

    wire("generateReportBtn", async () => {
      if (typeof generateSelectedReport === "function") {
        await generateSelectedReport();
      } else {
        const type = typeEl.value;
        const key = keyEl.value.trim();
        const r = await fetch("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, key, force: true })
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || "generate failed");
        location.reload();
      }
    });

    wire("refreshReportsBtn", async () => {
      if (typeof loadReportsArchive === "function") await loadReportsArchive();
    });

    wire("runReportsAutomationBtn", async () => {
      if (typeof runReportsAutomationNow === "function") {
        await runReportsAutomationNow();
      } else {
        const r = await fetch("/api/reports/automation/run", { method: "POST" });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || "automation failed");
        location.reload();
      }
    });

    if (typeof loadReportsArchive === "function") {
      loadReportsArchive();
    }

    console.log("[reports] archive controls wired");
  });
})();

document.getElementById("eventsLimitSelect")?.addEventListener("change", () => loadAll());
