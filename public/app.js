let map, markersLayer, chart;
let hzsLayer, hzsStationsToggleEl;
let routesLayer, vehiclesLayer;

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

    // máme stanice?
    if (!hzsStations || hzsStations.length === 0) continue;

    startSimulationForEvent(it).catch(() => {});
  }
}

async function startSimulationForEvent(ev) {
  if (inFlight) return;
  inFlight = true;

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

    let start = null;
    let rafId = null;

    const step = (ts) => {
      if (!start) start = ts;
      const p = clamp((ts - start) / animMs, 0, 1);
      const idx = Math.floor(p * (best.route.coords.length - 1));
      const pt = best.route.coords[idx];
      vehicle.setLatLng(pt);
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
    inFlight = false;
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
let currentUser = null; // {id, username, role}

function apiFetch(url, opt = {}) {
  const o = { ...opt };
  o.credentials = "include";
  o.headers = { "Content-Type": "application/json", ...(o.headers || {}) };
  return fetch(url, o);
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
    setModePill("OPS", currentUser.role);
    showEl("loginBtn", false);
    showEl("logoutBtn", true);
    showEl("adminBtn", currentUser.role === "admin");
  } else {
    setModePill("PUBLIC");
    showEl("loginBtn", true);
    showEl("logoutBtn", false);
    showEl("adminBtn", false);
  }
}

function openModal(which) {
  const back = document.getElementById("modalBackdrop");
  const login = document.getElementById("loginModal");
  const admin = document.getElementById("adminModal");
  if (!back || !login || !admin) return;

  back.style.display = "";
  login.style.display = which === "login" ? "" : "none";
  admin.style.display = which === "admin" ? "" : "none";

  if (which === "login") {
    document.getElementById("loginMsg").textContent = "";
    setTimeout(() => document.getElementById("loginUser")?.focus(), 30);
  }
}

function closeModals() {
  const back = document.getElementById("modalBackdrop");
  const login = document.getElementById("loginModal");
  const admin = document.getElementById("adminModal");
  if (back) back.style.display = "none";
  if (login) login.style.display = "none";
  if (admin) admin.style.display = "none";
}

function msg(id, text, ok = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.style.color = ok ? "rgba(120,255,180,0.9)" : "rgba(255,140,140,0.95)";
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
  } catch (e) {
    msg("loginMsg", `Chyba: ${String(e.message || e)}`, false);
  }
}

async function doLogout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {}
  await refreshMe();
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
  // buttons
  document.getElementById("loginBtn")?.addEventListener("click", () => openModal("login"));
  document.getElementById("logoutBtn")?.addEventListener("click", doLogout);
  document.getElementById("adminBtn")?.addEventListener("click", async () => {
    openModal("admin");
    await adminLoadAll();
  });
  document.getElementById("fullscreenBtn")?.addEventListener("click", toggleFullscreen);
  document.getElementById("tvModeBtn")?.addEventListener("click", toggleTvMode);

  // modal close
  document.getElementById("modalBackdrop")?.addEventListener("click", closeModals);
  document.getElementById("loginCloseBtn")?.addEventListener("click", closeModals);
  document.getElementById("loginCancelBtn")?.addEventListener("click", closeModals);
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

  // auth state
  await refreshMe();
})();
