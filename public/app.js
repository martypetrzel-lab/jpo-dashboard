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
const ANIM_MIN_MS = 15000;  // min 15 s
const ANIM_MAX_MS = 180000; // max 3 min
const ANIM_SPEEDUP = 20;    // reálná doba / 20
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

// ==============================
// SIMULACE VÝJEZDU HZS (ETA + pohyb)
// ==============================

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function osrmRoute(fromLat, fromLon, toLat, toLon) {
  const url = `${OSRM_BASE}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.routes?.[0];
  const coords = r?.geometry?.coordinates;
  const dur = r?.duration;
  if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(dur)) {
    throw new Error("OSRM invalid");
  }
  // OSRM: [lon,lat] -> Leaflet: [lat,lon]
  const latlngs = coords.map(c => [c[1], c[0]]);
  return { duration_s: dur, latlngs };
}

function makeVehicleIcon() {
  return L.divIcon({
    className: "fw-emoji-wrap",
    html: `<div class="fw-emoji" title="Simulovaný výjezd">🚒</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13]
  });
}

function computeAnimMs(durationS) {
  const ms = (durationS * 1000) / ANIM_SPEEDUP;
  return Math.max(ANIM_MIN_MS, Math.min(ANIM_MAX_MS, ms));
}

function buildCumulativeDistances(latlngs) {
  const pts = latlngs.map(p => L.latLng(p[0], p[1]));
  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += pts[i - 1].distanceTo(pts[i]);
    cum.push(total);
  }
  return { pts, cum, total };
}

function latlngAtDistance(distM, pts, cum) {
  if (distM <= 0) return pts[0];
  const total = cum[cum.length - 1];
  if (distM >= total) return pts[pts.length - 1];

  // lineární vyhledání (body nejsou extrémně dlouhé)
  let i = 1;
  while (i < cum.length && cum[i] < distM) i++;
  const d0 = cum[i - 1];
  const d1 = cum[i];
  const t = (distM - d0) / Math.max(1, (d1 - d0));

  const a = pts[i - 1];
  const b = pts[i];
  const lat = a.lat + (b.lat - a.lat) * t;
  const lng = a.lng + (b.lng - a.lng) * t;
  return L.latLng(lat, lng);
}

async function pickBestStationByEta(eventLat, eventLon) {
  // filtr vzdušnou čarou
  const candidates = (hzsStations || [])
    .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map(s => ({
      ...s,
      airKm: haversineKm(eventLat, eventLon, s.lat, s.lon)
    }))
    .filter(s => s.airKm <= MAX_STATION_AIR_KM)
    .sort((a, b) => a.airKm - b.airKm);

  if (candidates.length === 0) return null;

  // aby to nebyl spam na OSRM: vyhodnotíme max 8 nejbližších
  const top = candidates.slice(0, 8);
  let best = null;

  for (const s of top) {
    try {
      const r = await osrmRoute(s.lat, s.lon, eventLat, eventLon);
      if (!best || r.duration_s < best.route.duration_s) {
        best = { station: s, route: r };
      }
    } catch {
      // ignore jednotlivé selhání
    }
  }

  return best;
}

function stopSim(eventId) {
  const sim = runningSims.get(eventId);
  if (!sim) return;
  try { if (sim.raf) cancelAnimationFrame(sim.raf); } catch {}
  try { if (sim.route) routesLayer.removeLayer(sim.route); } catch {}
  try { if (sim.marker) vehiclesLayer.removeLayer(sim.marker); } catch {}
  runningSims.delete(eventId);
}

async function startSimForEvent(it) {
  try {
    const eventId = it?.id;
    if (!eventId) return;
    if (runningSims.has(eventId)) return;
    if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) return;
    if (it.is_closed) return;

    // stanice musí být připravené (geocode běží na pozadí)
    if (stationsReadyPromise) {
      await stationsReadyPromise;
    }

    const picked = await pickBestStationByEta(it.lat, it.lon);
    if (!picked) return;

    const { station, route } = picked;

    // vykresli trasu
    const routeLine = L.polyline(route.latlngs, {
      weight: 4,
      opacity: 0.55,
      dashArray: "8 10"
    }).addTo(routesLayer);

    // vozidlo
    const marker = L.marker(route.latlngs[0], { icon: makeVehicleIcon() }).addTo(vehiclesLayer);
    marker.bindPopup(
      `<b>Simulovaný výjezd HZS</b><br>` +
      `<span style="opacity:.85">${escapeHtml(station.name)}</span><br>` +
      `<span style="opacity:.85">ETA: ${escapeHtml(formatDuration(Math.round(route.duration_s / 60)))}</span>`
    );

    const animMs = computeAnimMs(route.duration_s);
    const { pts, cum, total } = buildCumulativeDistances(route.latlngs);
    const t0 = performance.now();

    const sim = { marker, route: routeLine, raf: null, stop: () => stopSim(eventId) };
    runningSims.set(eventId, sim);

    const tick = (tNow) => {
      // ukončení/odstranění
      if (!runningSims.has(eventId)) return;

      const p = Math.min(1, (tNow - t0) / animMs);
      const dist = total * p;
      const ll = latlngAtDistance(dist, pts, cum);
      marker.setLatLng(ll);

      if (p >= 1) {
        // po dojezdu smaž (aby to nezůstávalo na mapě)
        setTimeout(() => stopSim(eventId), 6000);
        return;
      }
      sim.raf = requestAnimationFrame(tick);
    };

    sim.raf = requestAnimationFrame(tick);
  } catch {
    // ignore
  }
}

function updateSimsFromItems(items) {
  const byId = new Map((items || []).map(x => [x.id, x]));

  // stopni ty, které už jsou ukončené nebo zmizely z filtru
  for (const [eventId] of runningSims) {
    const it = byId.get(eventId);
    if (!it || it.is_closed) stopSim(eventId);
  }

  // nastartuj jen NOVÉ + AKTIVNÍ
  for (const it of (items || [])) {
    if (!it?.id) continue;
    if (it.is_closed) {
      seenEventIds.add(it.id);
      continue;
    }

    // jen nové (od načtení stránky)
    if (!seenEventIds.has(it.id)) {
      seenEventIds.add(it.id);
      startSimForEvent(it);
    }
  }
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
