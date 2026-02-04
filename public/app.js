// Frontend logic (Leaflet + Chart.js)

const API = "";

const el = (id) => document.getElementById(id);

const state = {
  map: null,
  markersLayer: null,
  chart: null
};

function fmtDateCz(pubDate) {
  if (!pubDate) return "";
  // pubDate je RFC2822 string, zobrazíme "d. m. yyyy hh:mm:ss"
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return String(pubDate);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(min) {
  if (min == null) return "—";
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} h ${mm} min`;
}

function iconForType(t) {
  const map = {
    fire: "🔥",
    traffic: "🚑",
    tech: "🛠️",
    rescue: "🧑‍🚒",
    false_alarm: "🧯",
    other: "❓"
  };
  return map[t] || "❓";
}

function buildQuery() {
  const day = el("daySelect").value;
  const type = el("typeSelect").value;
  const city = el("cityInput").value.trim();
  const status = el("statusSelect").value;
  const month = el("monthInput").value;

  const p = new URLSearchParams();
  // day: default today - FE pro today neposílá -> server default = today
  if (day && day !== "today") p.set("day", day);
  if (type && type !== "all") p.set("type", type);
  if (city) p.set("city", city);
  if (status && status !== "all") p.set("status", status);
  if (month) p.set("month", month);

  return p.toString();
}

async function apiGetJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function initMap() {
  const map = L.map("map", { zoomControl: true }).setView([49.8, 15.5], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "Leaflet | © OpenStreetMap"
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);

  state.map = map;
  state.markersLayer = layer;
}

function setMarkers(rows) {
  state.markersLayer.clearLayers();

  const valid = rows.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  for (const r of valid) {
    const ico = iconForType(r.event_type);
    const html = `<div style="font-size:18px;line-height:18px">${ico}</div>`;
    const marker = L.marker([r.lat, r.lon], {
      icon: L.divIcon({ className: "marker-ico", html, iconSize: [20, 20], iconAnchor: [10, 10] })
    });

    const status = r.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const city = r.city_text || r.place_text || "";
    const dur = fmtDuration(r.duration_min);

    marker.bindPopup(
      `<div class="popup">
        <div class="popup-title">${r.title || ""}</div>
        <div class="popup-meta"><b>${status}</b> • ${city} • ${dur}</div>
        <div class="popup-time">${fmtDateCz(r.pub_date)}</div>
        <div class="popup-link"><a href="${r.link}" target="_blank" rel="noopener">Otevřít detail</a></div>
      </div>`
    );

    marker.addTo(state.markersLayer);
  }
}

function renderTable(rows) {
  const tbody = el("eventsTbody");
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = fmtDateCz(r.pub_date);

    const tdType = document.createElement("td");
    tdType.innerHTML = `<span class="type-pill">${iconForType(r.event_type)}</span>`;

    const tdTitle = document.createElement("td");
    tdTitle.textContent = r.title || "";

    const tdCity = document.createElement("td");
    tdCity.textContent = r.city_text || r.place_text || "";

    const tdStatus = document.createElement("td");
    tdStatus.textContent = r.is_closed ? "UKONČENO" : "AKTIVNÍ";

    const tdDur = document.createElement("td");
    tdDur.textContent = fmtDuration(r.duration_min);

    const tdLink = document.createElement("td");
    const a = document.createElement("a");
    a.href = r.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "otevřít";
    tdLink.appendChild(a);

    tr.appendChild(tdTime);
    tr.appendChild(tdType);
    tr.appendChild(tdTitle);
    tr.appendChild(tdCity);
    tr.appendChild(tdStatus);
    tr.appendChild(tdDur);
    tr.appendChild(tdLink);

    tbody.appendChild(tr);
  }
}

function renderLongest(rows) {
  const list = el("longestList");
  list.innerHTML = "";

  if (!rows || !rows.length) {
    list.innerHTML = `<div class="empty">—</div>`;
    return;
  }

  rows.forEach((r, idx) => {
    const div = document.createElement("div");
    div.className = "rank-item";
    div.innerHTML = `
      <div class="rank-left">
        <span class="rank-num">#${idx + 1}</span>
        <span class="rank-title">${(r.title || "").slice(0, 38)}${(r.title || "").length > 38 ? "..." : ""}</span>
      </div>
      <div class="rank-right">${fmtDuration(r.duration_min)}</div>
    `;
    list.appendChild(div);
  });
}

function renderMonthlyCities(rows) {
  const box = el("citiesList");
  box.innerHTML = "";

  if (!rows || !rows.length) {
    box.innerHTML = `<div class="empty">—</div>`;
    return;
  }

  rows.forEach((r, idx) => {
    const div = document.createElement("div");
    div.className = "city-item";
    div.innerHTML = `
      <div class="city-left">
        <span class="rank-num">#${idx + 1}</span>
        <span class="city-name">${r.city || ""}</span>
      </div>
      <div class="city-right">${r.count}</div>
    `;
    box.appendChild(div);
  });
}

function renderOpenClosed(openCount, closedCount) {
  el("openCount").textContent = Number.isFinite(openCount) ? String(openCount) : "—";
  el("closedCount").textContent = Number.isFinite(closedCount) ? String(closedCount) : "—";
}

function renderChart(byDay) {
  const ctx = el("chart").getContext("2d");
  const labels = (byDay || []).map((x) => x.day);
  const data = (byDay || []).map((x) => x.count);

  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = data;
    state.chart.update();
    return;
  }

  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Počet výjezdů",
          data,
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: "#9aa4b2" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: "#9aa4b2" }, grid: { color: "rgba(255,255,255,0.06)" } }
      }
    }
  });
}

async function loadEvents() {
  const q = buildQuery();
  const url = q ? `${API}/api/events?${q}` : `${API}/api/events`;
  const json = await apiGetJson(url);
  return json.rows || [];
}

async function loadStats() {
  const q = buildQuery();
  const url = q ? `${API}/api/stats?${q}` : `${API}/api/stats`;
  const json = await apiGetJson(url);
  return json;
}

async function loadAll() {
  try {
    el("statusPill").textContent = "Načítám...";
    const [rows, statsJson] = await Promise.all([loadEvents(), loadStats()]);

    // Map
    setMarkers(rows);

    // Table (poslední výjezdy)
    renderTable(rows);

    // Stats
    renderChart(statsJson.byDay || []);
    renderOpenClosed(statsJson.openCount, statsJson.closedCount);
    renderMonthlyCities(statsJson.monthlyCities || []);
    renderLongest(statsJson.longest || []);

    // Status pill
    const w = statsJson?.filters?.day || "today";
    const total = rows.length;
    const noCoords = rows.filter((r) => !(Number.isFinite(r.lat) && Number.isFinite(r.lon))).length;
    el("statusPill").textContent = `OK • ${total} záznamů • den: ${w} • bez souřadnic: ${noCoords}`;
  } catch (e) {
    console.error(e);
    el("statusPill").textContent = "Chyba načítání";
  }
}

function resetFilters() {
  el("daySelect").value = "today";
  el("typeSelect").value = "all";
  el("cityInput").value = "";
  el("statusSelect").value = "all";

  // month default = current month
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  el("monthInput").value = `${d.getFullYear()}-${m}`;
}

// Export buttons
el("csvBtn").addEventListener("click", () => {
  const q = buildQuery();
  const url = q ? `${API}/api/export.csv?${q}` : `${API}/api/export.csv`;
  window.open(url, "_blank");
});

el("pdfBtn").addEventListener("click", () => {
  const q = buildQuery();
  const url = q ? `${API}/api/export.pdf?${q}` : `${API}/api/export.pdf`;
  window.open(url, "_blank");
});

// Controls
el("refreshBtn").addEventListener("click", loadAll);
el("applyBtn").addEventListener("click", loadAll);
el("resetBtn").addEventListener("click", () => {
  resetFilters();
  loadAll();
});

// Init
initMap();
resetFilters();
loadAll();

// ✅ Auto-refresh celé stránky po 5 minutách
// (uživatel chtěl, aby se dashboard sám obnovoval)
setInterval(() => {
  try {
    window.location.reload();
  } catch (e) {}
}, 5 * 60 * 1000);
