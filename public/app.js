let map, markersLayer, hzsStationsLayer, dispatchLayer, chart;
let inFlight = false;

// ===== Simulované výjezdy HZS (pouze orientační) =====
const HZS_MAX_STRAIGHT_KM = 20;
const OSRM_ENDPOINT = "https://router.project-osrm.org/route/v1/driving";
const knownEventIds = new Set();
let hasLoadedOnce = false;
const activeDispatch = new Map(); // eventId -> { marker, polyline, raf, startedAt, durationMs }

const TYPE = {
  fire: { emoji: "🔥", label: "požár", cls: "marker-fire" },
  traffic: { emoji: "🚗", label: "nehoda", cls: "marker-traffic" },
  tech: { emoji: "🛠️", label: "technická", cls: "marker-tech" },
  rescue: { emoji: "🚑", label: "záchrana", cls: "marker-rescue" },
  false_alarm: { emoji: "🚫", label: "planý poplach", cls: "marker-false" },
  other: { emoji: "❓", label: "jiné", cls: "marker-other" }
};


// --- Statická vrstva stanic HZS (Středočeský kraj – orientační body) ---
// Pozn.: seznam můžeš kdykoliv rozšířit/upravit. Souřadnice jsou pouze přibližné.
const HZS_STATIONS = [
  { id: "kladno", name: "HZS Kladno", lat: 50.147, lon: 14.104 },
  { id: "slany", name: "HZS Slaný", lat: 50.230, lon: 14.086 },
  { id: "rakovnik", name: "HZS Rakovník", lat: 50.103, lon: 13.733 },
  { id: "beroun", name: "HZS Beroun", lat: 49.963, lon: 14.072 },
  { id: "horovice", name: "HZS Hořovice", lat: 49.836, lon: 13.902 },
  { id: "pribram", name: "HZS Příbram", lat: 49.690, lon: 14.011 },
  { id: "benesov", name: "HZS Benešov", lat: 49.781, lon: 14.687 },
  { id: "ricany", name: "HZS Říčany", lat: 49.992, lon: 14.654 },
  { id: "brandys", name: "HZS Brandýs n. L.–St. Boleslav", lat: 50.187, lon: 14.663 },
  { id: "melnik", name: "HZS Mělník", lat: 50.350, lon: 14.474 },
  { id: "nymburk", name: "HZS Nymburk", lat: 50.186, lon: 15.041 },
  { id: "mlada_boleslav", name: "HZS Mladá Boleslav", lat: 50.411, lon: 14.903 },
  { id: "kolin", name: "HZS Kolín", lat: 50.028, lon: 15.200 },
  { id: "kutna_hora", name: "HZS Kutná Hora", lat: 49.949, lon: 15.268 }
];

function toRad(x) { return (x * Math.PI) / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}


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

  // Statické stanice HZS (skryté ve filtru – default OFF)
  hzsStationsLayer = L.layerGroup();

  // Simulované trasy + vozidla
  dispatchLayer = L.layerGroup().addTo(map);

  // UI: přepínač vrstvy stanic
  const toggle = document.getElementById("hzsStationsToggle");
  if (toggle) {
    toggle.checked = false;
    toggle.addEventListener("change", () => {
      try {
        if (toggle.checked) {
          hzsStationsLayer.addTo(map);
          renderHzsStationsLayer();
        } else {
          hzsStationsLayer.remove();
        }
      } catch { /* ignore */ }
    });
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
  const m = min % 60;
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ✅ běžící délka pro AKTIVNÍ zásah (když duration_min chybí)
const LIVE_DURATION_MAX_MIN = 4320; // 3 dny

function getLiveDurationMin(it) {
  try {
    if (!it || it.is_closed) return null;

    const now = Date.now();
    const startCandidate =
      it.start_time_iso ||
      it.first_seen_at ||
      it.created_at ||
      it.pub_date ||
      null;

    if (!startCandidate) return null;

    const startMs = new Date(startCandidate).getTime();
    if (!Number.isFinite(startMs)) return null;

    const diffMin = Math.floor((now - startMs) / 60000);
    if (!Number.isFinite(diffMin) || diffMin < 1) return 1;
    if (diffMin > LIVE_DURATION_MAX_MIN) return null;

    return diffMin;
  } catch {
    return null;
  }
}

function getDisplayDurationMin(it) {
  if (Number.isFinite(it?.duration_min) && it.duration_min > 0) return it.duration_min;
  const live = getLiveDurationMin(it);
  return Number.isFinite(live) ? live : null;
}

function renderTable(items) {
  const tbody = document.getElementById("eventsTbody");
  tbody.innerHTML = "";

  for (const it of items) {
    const t = it.event_type || "other";
    const meta = typeMeta(t);
    const state = it.is_closed ? "Ukončeno" : "Aktivní";

    const durMin = getDisplayDurationMin(it);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(formatDate(it.pub_date || it.created_at))}</td>
      <td><span class="iconPill" title="${escapeHtml(meta.label)}">${meta.emoji}</span></td>
      <td>${escapeHtml(it.title || "")}</td>
      <td>${escapeHtml(it.city_text || it.place_text || "")}</td>
      <td>${escapeHtml(`${statusEmoji(it.is_closed)} ${state}`)}</td>
      <td>${escapeHtml(formatDuration(durMin))}</td>
      <td>${it.link ? `<a href="${it.link}" target="_blank" rel="noopener">otevřít</a>` : ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

/**
 * ✅ MAP MARKER = jen čisté emoji (bez bublin/pinů)
 */
function makeMarkerIcon(typeKey, isClosed) {
  const meta = typeMeta(typeKey);
  const cls = isClosed ? "fw-emoji fw-emoji-closed" : "fw-emoji";

  return L.divIcon({
    className: "fw-emoji-wrap",
    html: `<div class="${cls}" title="${escapeHtml(meta.label)}">${meta.emoji}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14]
  });
}

/**
 * ✅ HZS STANICE – statická vrstva
 */
function makeStationIcon(name) {
  return L.divIcon({
    className: "fw-station-wrap",
    html: `<div class="fw-station" title="${escapeHtml(name)}">🏢</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

function renderHzsStationsLayer() {
  try {
    if (!hzsStationsLayer || !map) return;
    hzsStationsLayer.clearLayers();

    for (const s of HZS_STATIONS) {
      const m = L.marker([s.lat, s.lon], { icon: makeStationIcon(s.name) });
      m.bindTooltip(escapeHtml(s.name), { direction: "top", offset: [0, -6], opacity: 0.95 });
      m.addTo(hzsStationsLayer);
    }
  } catch { /* ignore */ }
}

/**
 * ✅ SIMULOVANÝ VÝJEZD – routing přes OSRM (nejrychlejší ETA)
 * - nejdřív filtr 20 km vzdušně
 * - poté pro kandidáty zjisti ETA po silnici a vyber nejrychlejší
 */
async function osrmRoute(fromLat, fromLon, toLat, toLon, abortSignal) {
  const url = `${OSRM_ENDPOINT}/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;
  const res = await fetch(url, { signal: abortSignal });
  if (!res.ok) throw new Error("osrm_error");
  const json = await res.json();
  const r = json?.routes?.[0];
  if (!r || !r.geometry || !Array.isArray(r.geometry.coordinates)) throw new Error("osrm_no_route");

  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]); // Leaflet [lat,lon]
  return { durationSec: Number(r.duration || 0), distanceM: Number(r.distance || 0), coords };
}

function makeVehicleIcon() {
  return L.divIcon({
    className: "fw-vehicle-wrap",
    html: `<div class="fw-vehicle" title="Simulované vozidlo HZS">🚒</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
}

function stopDispatchSimulation(eventId) {
  const sim = activeDispatch.get(eventId);
  if (!sim) return;
  try { if (sim.raf) cancelAnimationFrame(sim.raf); } catch { /* ignore */ }
  try { if (sim.marker) dispatchLayer.removeLayer(sim.marker); } catch { /* ignore */ }
  try { if (sim.polyline) dispatchLayer.removeLayer(sim.polyline); } catch { /* ignore */ }
  activeDispatch.delete(eventId);
}

function computeCumDistancesKm(latlngs) {
  const cum = [0];
  for (let i = 1; i < latlngs.length; i++) {
    const [lat1, lon1] = latlngs[i - 1];
    const [lat2, lon2] = latlngs[i];
    cum.push(cum[i - 1] + haversineKm(lat1, lon1, lat2, lon2));
  }
  return cum;
}

function interpolateOnPath(latlngs, cumKm, t01) {
  const total = cumKm[cumKm.length - 1] || 0;
  if (total <= 0 || latlngs.length === 0) return latlngs[0] || [0, 0];

  const target = total * Math.min(1, Math.max(0, t01));
  let i = 1;
  while (i < cumKm.length && cumKm[i] < target) i++;

  if (i >= cumKm.length) return latlngs[latlngs.length - 1];

  const prev = cumKm[i - 1];
  const next = cumKm[i];
  const seg = Math.max(1e-9, next - prev);
  const k = (target - prev) / seg;

  const [lat1, lon1] = latlngs[i - 1];
  const [lat2, lon2] = latlngs[i];
  return [lat1 + (lat2 - lat1) * k, lon1 + (lon2 - lon1) * k];
}

async function startDispatchSimulationForEvent(it) {
  try {
    if (!it || it.is_closed) return;
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) return;
    if (activeDispatch.has(it.id)) return; // už běží

    // Kandidáti do 20 km vzdušně
    const candidates = HZS_STATIONS
      .map(s => ({ ...s, km: haversineKm(s.lat, s.lon, it.lat, it.lon) }))
      .filter(s => s.km <= HZS_MAX_STRAIGHT_KM)
      .sort((a, b) => a.km - b.km);

    if (candidates.length === 0) return;

    // Routing – vyber nejrychlejší ETA
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    let best = null;
    for (const s of candidates.slice(0, 6)) { // limit kvůli rate-limitům
      try {
        const route = await osrmRoute(s.lat, s.lon, it.lat, it.lon, controller.signal);
        const eta = route.durationSec;
        if (!Number.isFinite(eta) || eta <= 0) continue;
        if (!best || eta < best.etaSec) best = { station: s, route, etaSec: eta };
      } catch {
        // zkoušíme další kandidáty
      }
    }

    clearTimeout(t);
    if (!best) return;

    const latlngs = best.route.coords;
    if (!Array.isArray(latlngs) || latlngs.length < 2) return;

    // Vykresli trasu + vozidlo
    const poly = L.polyline(latlngs, { weight: 4, opacity: 0.75 });
    poly.addTo(dispatchLayer);

    const vehicle = L.marker(latlngs[0], { icon: makeVehicleIcon(), interactive: false });
    vehicle.addTo(dispatchLayer);

    const cumKm = computeCumDistancesKm(latlngs);
    const durationMs = Math.max(10_000, Math.round(best.etaSec * 1000)); // min 10 s aby to bylo vidět
    const startedAt = performance.now();

    const sim = { marker: vehicle, polyline: poly, raf: null, startedAt, durationMs, cumKm, latlngs };
    activeDispatch.set(it.id, sim);

    const step = (now) => {
      // kdyby se mezitím ukončilo (zastaví se při loadAll)
      const s = activeDispatch.get(it.id);
      if (!s) return;

      const elapsed = now - s.startedAt;
      const t01 = Math.min(1, elapsed / s.durationMs);
      const [lat, lon] = interpolateOnPath(s.latlngs, s.cumKm, t01);
      try { s.marker.setLatLng([lat, lon]); } catch { /* ignore */ }

      if (t01 < 1) {
        s.raf = requestAnimationFrame(step);
      } else {
        // dojezd – necháme trasu + vozidlo ještě chvíli a pak uklidíme,
        // aby nebyla mapa přeplácaná
        setTimeout(() => stopDispatchSimulation(it.id), 15_000);
      }
    };

    sim.raf = requestAnimationFrame(step);
  } catch {
    // ticho – simulace nesmí rozbít zbytek dashboardu
  }
}

// ✅ když je více událostí na stejných souřadnicích, lehce je rozprostřeme,
// aby se emoji nepřekrývaly (bez clusterů/bublin).
function offsetLatLon(lat, lon, index, total) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || total <= 1) {
    return { lat, lon };
  }

  // malé kolečko okolo bodu (v metrech)
  const radiusM = 22; // ~22 m je na mapě hezky vidět a pořád to „sedí“ na město
  const angle = (index / total) * Math.PI * 2;

  // přepočet metrů na stupně
  const dLat = (radiusM * Math.cos(angle)) / 111320;
  const dLon = (radiusM * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));

  return { lat: lat + dLat, lon: lon + dLon };
}

function renderMap(items) {
  markersLayer.clearLayers();

  // ✅ seskup podle souřadnic (zaokrouhlení, aby se trefily stejné body)
  const groups = new Map();
  for (const it of items) {
    if (typeof it.lat === "number" && typeof it.lon === "number") {
      const key = `${it.lat.toFixed(5)},${it.lon.toFixed(5)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
  }

  const pts = [];
  for (const [, group] of groups) {
    const total = group.length;
    for (let i = 0; i < group.length; i++) {
      const it = group[i];
      const t = it.event_type || "other";
      const meta = typeMeta(t);

      const shifted = offsetLatLon(it.lat, it.lon, i, total);

      const m = L.marker([shifted.lat, shifted.lon], {
        icon: makeMarkerIcon(t, !!it.is_closed)
      });

      const state = it.is_closed ? "Ukončeno" : "Aktivní";
      const html = `
        <div style="min-width:240px">
          <div style="font-weight:700;margin-bottom:6px">${escapeHtml(meta.emoji)} ${escapeHtml(it.title || "")}</div>
          <div><b>Stav:</b> ${escapeHtml(`${statusEmoji(it.is_closed)} ${state}`)}</div>
          <div><b>Město:</b> ${escapeHtml(it.city_text || it.place_text || "")}</div>
          <div><b>Čas:</b> ${escapeHtml(formatDate(it.pub_date || it.created_at))}</div>
          <div><b>Délka:</b> ${escapeHtml(formatDuration(getDisplayDurationMin(it)))}${it.is_closed ? "" : " <span style=\"opacity:.7\">(běží)</span>"}</div>
          ${it.link ? `<div style="margin-top:8px"><a href="${it.link}" target="_blank" rel="noopener">Detail</a></div>` : ""}
        </div>
      `;
      m.bindPopup(html);
      m.addTo(markersLayer);

      // ✅ fitBounds bereme z původní pozice (ne z posunuté)
      pts.push([it.lat, it.lon]);
    }
  }

  if (pts.length > 0) {
    const bounds = L.latLngBounds(pts);
    map.fitBounds(bounds.pad(0.2));
  } else {
    map.setView([49.8, 15.3], 7);
  }

  safeInvalidateMap();
}

function safeInvalidateMap() {
  try {
    if (!map) return;
    setTimeout(() => {
      try { map.invalidateSize(true); } catch { /* ignore */ }
    }, 80);
  } catch { /* ignore */ }
}

function renderTopCities(rows) {
  const wrap = document.getElementById("topCities");
  wrap.innerHTML = "";
  rows.forEach((r, idx) => {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `
      <div class="left">
        <div class="meta">#${idx + 1}</div>
        <div class="name">${escapeHtml(r.city)}</div>
      </div>
      <div class="meta">${r.count}×</div>
    `;
    wrap.appendChild(div);
  });
}

function renderLongest(rows) {
  const wrap = document.getElementById("longestList");
  wrap.innerHTML = "";
  rows.forEach((r, idx) => {
    const div = document.createElement("div");
    div.className = "row";
    div.style.cursor = r.link ? "pointer" : "default";
    div.innerHTML = `
      <div class="left">
        <div class="meta">#${idx + 1}</div>
        <div class="name">${escapeHtml(r.title || "")}</div>
      </div>
      <div class="meta">${escapeHtml(formatDuration(r.duration_min))}</div>
    `;
    if (r.link) {
      div.addEventListener("click", () => window.open(r.link, "_blank", "noopener"));
    }
    wrap.appendChild(div);
  });
}

function renderCounts(openCount, closedCount) {
  document.getElementById("openCount").textContent = String(openCount ?? "—");
  document.getElementById("closedCount").textContent = String(closedCount ?? "—");
}

function renderChart(byDay) {
  const labels = byDay.map(x => x.day);
  const data = byDay.map(x => x.count);

  const ctx = document.getElementById("chartByDay");
  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: "Výjezdy", data }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true }
      }
    }
  });
}

function getFiltersFromUi() {
  const day = (document.getElementById("daySelect")?.value || "today").trim();
  const type = document.getElementById("typeSelect").value.trim();
  const city = document.getElementById("cityInput").value.trim();
  const status = document.getElementById("statusSelect").value.trim();
  const month = (document.getElementById("monthInput")?.value || "").trim();

  return {
    day: day || "today",
    type: type || "",
    city: city || "",
    status: status || "all",
    month: month || ""
  };
}

function buildQuery(filters) {
  const qs = new URLSearchParams();
  if (filters.day && filters.day !== "today") qs.set("day", filters.day);
  if (filters.type) qs.set("type", filters.type);
  if (filters.city) qs.set("city", filters.city);
  if (filters.status && filters.status !== "all") qs.set("status", filters.status);
  if (filters.month) qs.set("month", filters.month);
  return qs.toString();
}

async function loadAll() {
  if (inFlight) return;
  inFlight = true;

  try {
    const filters = getFiltersFromUi();
    const q = buildQuery(filters);

    setStatus("načítám…", true);

    const [eventsRes, statsRes] = await Promise.all([
      fetch(`/api/events?limit=500${q ? `&${q}` : ""}`),
      fetch(`/api/stats${q ? `?${q}` : ""}`)
    ]);

    if (!eventsRes.ok || !statsRes.ok) {
      setStatus("chyba API", false);
      return;
    }

    const eventsJson = await eventsRes.json();
    const statsJson = await statsRes.json();

    const items = (eventsJson.items || []);

    // --- Simulované výjezdy HZS: jen NOVÉ + AKTIVNÍ události ---
    // 1) zastav, co se ukončilo
    for (const [eventId] of activeDispatch) {
      const it = items.find(x => x.id === eventId);
      if (!it || it.is_closed) stopDispatchSimulation(eventId);
    }

    // 2) spust pro nové aktivní (až po prvním načtení, aby se nespouštělo na historických)
    const allowSim = hasLoadedOnce;
    for (const it of items) {
      if (!it?.id) continue;
      const isNew = !knownEventIds.has(it.id);
      if (allowSim && isNew && !it.is_closed) {
        startDispatchSimulationForEvent(it);
      }
      knownEventIds.add(it.id);
    }

    hasLoadedOnce = true;

    renderTable(items);
    renderMap(items);

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
loadAll();

// AUTO REFRESH každých 5 minut (stabilní 1.02 – beze změny)
setInterval(() => {
  loadAll();
}, 5 * 60 * 1000);
