let map, markersLayer, chart;
let hzsLayer, hzsStationsToggleEl;
let routesLayer, vehiclesLayer;

// OPS auth state (musí být nahoře kvůli TTS, které může běžet už při prvním loadu)
let currentUser = null; // {id, username, role}

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

function buildQuery(filters) {
  const params = new URLSearchParams();
  if (filters.day && filters.day !== "all") params.set("day", filters.day);
  if (filters.type) params.set("type", filters.type);
  if (filters.city) params.set("city", filters.city);
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.month) params.set("month", filters.month);
  return params.toString();
}

function getFiltersFromUi() {
  return {
    day: document.getElementById("daySelect").value,
    type: document.getElementById("typeSelect").value,
    city: document.getElementById("cityInput").value.trim(),
    status: document.getElementById("statusSelect").value,
    month: document.getElementById("monthInput")?.value || ""
  };
}

function renderTable(items) {
  const tbody = document.getElementById("eventsTbody");
  tbody.innerHTML = "";

  for (const it of items) {
    const meta = typeMeta(it.event_type);
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${escapeHtml(formatDate(it.pub_date))}</td>
      <td title="${escapeHtml(meta.label)}">${meta.emoji}</td>
      <td>${escapeHtml(it.title)}</td>
      <td>${escapeHtml(it.city_text || it.place_text || "")}</td>
      <td>${statusEmoji(it.is_closed)} ${it.is_closed ? "ukončená" : "aktivní"}</td>
      <td>${escapeHtml(formatDuration(it.duration_min))}</td>
      <td><a href="${escapeHtml(it.link)}" target="_blank" rel="noopener">detail</a></td>
    `;

    tbody.appendChild(tr);
  }
}

function makeEventIcon(eventType) {
  const meta = typeMeta(eventType);
  return L.divIcon({
    className: `fw-emoji-wrap ${meta.cls}`,
    html: `<div class="fw-emoji">${meta.emoji}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
}

function renderMap(items) {
  markersLayer.clearLayers();

  const pts = [];
  for (const it of items) {
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) continue;
    const marker = L.marker([it.lat, it.lon], { icon: makeEventIcon(it.event_type) });
    marker.bindPopup(`
      <b>${escapeHtml(it.title)}</b><br>
      <span style="opacity:.85">${escapeHtml(it.city_text || it.place_text || "")}</span><br>
      <span style="opacity:.75">${statusEmoji(it.is_closed)} ${it.is_closed ? "ukončená" : "aktivní"}</span><br>
      <a href="${escapeHtml(it.link)}" target="_blank" rel="noopener">detail</a>
    `);
    marker.addTo(markersLayer);
    pts.push([it.lat, it.lon]);
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
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) continue;

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
        const r = await osrmRoute([c.station.lat, c.station.lon], [ev.lat, ev.lon]);
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

async function loadAll() {
  if (inFlight) return;
  inFlight = true;

  try {
    setStatus("načítám…", true);

    const filters = getFiltersFromUi();
    const q = buildQuery(filters);

    const [eventsRes, statsRes] = await Promise.all([
      fetch(`/api/events${q ? `?${q}` : ""}`),
      fetch(`/api/stats${q ? `?${q}` : ""}`)
    ]);

    if (!eventsRes.ok || !statsRes.ok) throw new Error("bad http");

    const eventsJson = await eventsRes.json();
    const statsJson = await statsRes.json();

    const items = eventsJson.items || [];
    // snapshot pro audio souhrn
    latestItemsSnapshot = items;
    latestStatsSnapshot = statsJson;
    renderTable(items);
    renderMap(items);

    // ✅ simulace výjezdu HZS (jen NOVÉ + AKTIVNÍ)
    updateSimsFromItems(items);

    renderChart(statsJson.byDay || []);
    renderCounts(statsJson.openCount, statsJson.closedCount);
    renderTopCities(statsJson.topCities || []);
    renderLongest(statsJson.longest || []);

    const missing = items.filter(x => x.lat == null || x.lon == null).length;
    setStatus(`OK • ${items.length} záznamů • bez souřadnic ${missing}`, true);
  } catch {
    setStatus("chyba načítání", false);
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
  const q = buildQuery(filters);
  const url = kind === "pdf"
    ? `/api/export.pdf${q ? `?${q}` : ""}`
    : `/api/export.csv${q ? `?${q}` : ""}`;
  window.open(url, "_blank");
}

// UI events
document.getElementById("refreshBtn").addEventListener("click", loadAll);
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
  loadAll();
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
    const r = await fetch("/api/settings", { credentials: "include" });
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
  el.style.background = modeText === "OPS" ? "rgba(60, 180, 120, 0.20)" : "rgba(255,255,255,0.06)";
  el.style.borderColor = modeText === "OPS" ? "rgba(60, 180, 120, 0.35)" : "rgba(255,255,255,0.12)";
}

function showEl(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = on ? "" : "none";
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

    setModePill(isOps ? "OPS" : "PUBLIC", role);

    showEl("loginBtn", false);
    showEl("registerBtn", false);
    showEl("logoutBtn", true);
    showEl("requestOpsBtn", !isOps && role === "public");
    showEl("adminBtn", role === "admin");
    showEl("audioBtn", isOps);
    showEl("briefingBtn", isOps);
  } else {
    setModePill("PUBLIC");
    showEl("loginBtn", true);
    showEl("registerBtn", true);
    showEl("logoutBtn", false);
    showEl("requestOpsBtn", false);
    showEl("adminBtn", false);
    showEl("audioBtn", false);
    showEl("briefingBtn", false);
  }
}

function openModal(which) {
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
    const r = await fetch("/api/settings", { method: "GET" });
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
        document.getElementById("coordsEventId").value = String(ev.id);
        document.getElementById("coordsLat").value = "";
        document.getElementById("coordsLon").value = "";
        setPickMode(false);
        msg("coordsMsg", `Vybrána událost: ${ev.id}`, true);
        // posuň mapu aspoň na Středočeský kraj, ať se kliká pohodlně
        try { map?.setView([49.9, 15.0], 9); } catch {}
      });
      tdAct.appendChild(pickBtn);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    }
    if (info) info.textContent = rows.length ? `Nalezeno ${rows.length} událostí bez souřadnic.` : "Žádné události bez souřadnic.";
  } catch (e) {
    if (info) info.textContent = "Chyba načítání.";
    tbody.innerHTML = "";
    msg("coordsMsg", String(e.message || e), false);
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
  document.getElementById("pickOnMapBtn")?.addEventListener("click", () => {
    if (pickingCoords) return setPickMode(false);
    setPickMode(true);
  });
  document.getElementById("saveCoordsBtn")?.addEventListener("click", saveCoordsForSelected);
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
  document.getElementById("loginBtn")?.addEventListener("click", () => openModal("login"));
  document.getElementById("registerBtn")?.addEventListener("click", () => openModal("register"));
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
  await refreshMe();
  await sendVisitPing();
})();
