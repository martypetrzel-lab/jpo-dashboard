let map;
let cluster;
let currentFilter = "all";
let eventsCache = [];

const NEHVIZDY = [50.1309, 14.7289];

function setStatus(text, ok=true) {
  const el = document.getElementById("statusPill");
  el.textContent = text;
  el.style.color = ok ? "#a6f4c5" : "#ffd1d1";
}

function iconForKind(kind) {
  const k = (kind || "jine").toLowerCase();
  const emoji =
    k === "pozar" ? "🔥" :
    k === "nehoda" ? "🚗" :
    k === "technicka" ? "🔧" :
    k === "zachrana" ? "🧑‍🚒" : "❓";

  const cls =
    k === "pozar" ? "evt-pozar" :
    k === "nehoda" ? "evt-nehoda" :
    k === "technicka" ? "evt-technicka" :
    k === "zachrana" ? "evt-zachrana" : "evt-jine";

  return L.divIcon({
    className: "",
    html: `<div class="evt-icon ${cls}">${emoji}</div>`,
    iconSize: [34,34],
    iconAnchor: [17,17],
    popupAnchor: [0,-14]
  });
}

function formatDt(s) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    return d.toLocaleString("cs-CZ");
  } catch { return "—"; }
}

function safe(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({
    "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;"
  }[c]));
}

function ensureMap() {
  if (map) return;

  map = L.map("map", { zoomControl: true }).setView(NEHVIZDY, 9);

  // OSM standard
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  cluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 15,
    maxClusterRadius: 60
  });

  map.addLayer(cluster);
}

function renderMap(items) {
  ensureMap();
  cluster.clearLayers();

  const filtered = items.filter(it => {
    if (currentFilter === "all") return true;
    return (it.kind || "jine") === currentFilter;
  });

  let any = false;

  for (const it of filtered) {
    const lat = Number(it.lat);
    const lon = Number(it.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    any = true;

    const isActive = !!it.is_active;
    const badge = isActive ? `<span class="badge active">🟢 aktivní</span>` : `<span class="badge closed">⚫ ukončeno</span>`;

    const popup = `
      <div style="min-width:220px">
        <div style="font-weight:700;margin-bottom:6px">${safe(it.title || "—")}</div>
        <div style="color:#93a4bd;margin-bottom:8px">${badge}</div>
        <div><b>Město:</b> ${safe(it.place_text || "—")}</div>
        <div><b>Typ:</b> ${safe(it.kind || "jine")}</div>
        <div><b>Začátek:</b> ${safe(formatDt(it.started_at))}</div>
        <div><b>Konec:</b> ${safe(formatDt(it.ended_at))}</div>
        <div><b>Trvání:</b> ${it.duration_min ? `${it.duration_min} min` : "—"}</div>
        <div style="margin-top:8px">
          ${it.link ? `<a href="${safe(it.link)}" target="_blank" rel="noreferrer">detail</a>` : ""}
        </div>
      </div>
    `;

    const m = L.marker([lat, lon], { icon: iconForKind(it.kind) }).bindPopup(popup);
    cluster.addLayer(m);
  }

  if (any) {
    // necháme mapu přibližně tam kde user je, ale když je to poprvé, tak fit bounds
    if (!map._didFitOnce) {
      const bounds = cluster.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
      map._didFitOnce = true;
    }
  }
}

function renderTable(items) {
  const el = document.getElementById("eventsTable");

  const rows = items.slice(0, 50).map(it => {
    const badge = it.is_active
      ? `<span class="badge active">aktivní</span>`
      : `<span class="badge closed">ukončeno</span>`;

    return `
      <tr>
        <td>${badge}</td>
        <td>${safe(it.kind || "jine")}</td>
        <td>${it.link ? `<a href="${safe(it.link)}" target="_blank" rel="noreferrer">${safe(it.title || "—")}</a>` : safe(it.title || "—")}</td>
        <td>${safe(it.place_text || "—")}</td>
        <td>${it.duration_min ? `${it.duration_min} min` : "—"}</td>
      </tr>
    `;
  }).join("");

  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Stav</th>
          <th>Typ</th>
          <th>Název</th>
          <th>Město</th>
          <th>Délka</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadStats() {
  const r = await fetch("/api/stats?days=30");
  const j = await r.json();
  if (!j.ok) return;

  const top = j.top_city ? `${j.top_city.city} (${j.top_city.cnt}×)` : "—";
  document.getElementById("statsBox").innerHTML = `
    <div><b>Aktivní:</b> ${j.active_count}</div>
    <div><b>Ukončené (30 dní):</b> ${j.closed_count}</div>
    <div style="margin-top:10px"><b>Top město:</b> ${safe(top)}</div>
  `;
}

async function loadAll() {
  setStatus("načítám…", true);

  const r = await fetch("/api/events?limit=500");
  const j = await r.json();

  if (!j.ok) {
    setStatus("chyba API", false);
    return;
  }

  eventsCache = j.items || [];
  setStatus(`OK • ${eventsCache.length} záznamů`, true);

  renderMap(eventsCache);
  renderTable(eventsCache);
  await loadStats();
}

function bindUI() {
  document.getElementById("btnReload").addEventListener("click", () => loadAll());

  document.querySelectorAll(".chip").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter || "all";
      renderMap(eventsCache);
    });
  });

  // default aktivní chip
  const first = document.querySelector('.chip[data-filter="all"]');
  if (first) first.classList.add("active");
}

bindUI();
loadAll();
