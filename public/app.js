let map;
let layerActive;
let layerClosed;

function kindFromTitle(title = "") {
  const t = title.toLowerCase();
  if (t.includes("požár") || t.includes("pozar")) return "požár";
  if (t.includes("doprav") || t.includes("nehod")) return "nehoda";
  if (t.includes("techn")) return "technická";
  if (t.includes("záchran") || t.includes("zachran")) return "záchrana";
  return "jiné";
}

function iconFor(kind) {
  if (kind === "požár") return "🔥";
  if (kind === "nehoda") return "🚗";
  if (kind === "technická") return "🛠️";
  if (kind === "záchrana") return "🧍";
  return "❓";
}

function fmtDur(min) {
  if (min === null || min === undefined) return "—";
  const m = Number(min);
  if (!Number.isFinite(m)) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h <= 0) return `${mm} min`;
  return `${h} h ${mm} min`;
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true }).setView([50.08, 14.42], 8);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  layerActive = L.layerGroup().addTo(map);
  layerClosed = L.layerGroup().addTo(map);
}

function clearLayers() {
  layerActive.clearLayers();
  layerClosed.clearLayers();
}

function addMarker(ev) {
  const hasLL = Number.isFinite(Number(ev.lat)) && Number.isFinite(Number(ev.lon));
  if (!hasLL) return;

  const kind = kindFromTitle(ev.title);
  const ico = iconFor(kind);
  const stateDot = ev.is_closed ? "⚪" : "🟢";
  const place = ev.place_norm || ev.place_text || "—";

  const html = `
    <div style="font-weight:800;margin-bottom:4px">${stateDot} ${ico} ${ev.title}</div>
    <div style="color:#9fb0c4;font-size:12px;margin-bottom:6px">${place}</div>
    <div style="font-size:12px">Délka: <b>${fmtDur(ev.duration_min)}</b></div>
    <div style="margin-top:8px">
      <a href="${ev.link}" target="_blank" rel="noreferrer">Otevřít detail</a>
    </div>
  `;

  const marker = L.marker([Number(ev.lat), Number(ev.lon)]).bindPopup(html);
  if (ev.is_closed) marker.addTo(layerClosed);
  else marker.addTo(layerActive);
}

function renderTable(items) {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";

  for (const ev of items) {
    const tr = document.createElement("tr");
    const kind = kindFromTitle(ev.title);
    const ico = iconFor(kind);
    const place = ev.place_norm || ev.place_text || "—";

    const badge = ev.is_closed
      ? `<span class="badge closed">⚪ ukončeno</span>`
      : `<span class="badge active">🟢 aktivní</span>`;

    tr.innerHTML = `
      <td>${badge}</td>
      <td>${ico}</td>
      <td><a href="${ev.link}" target="_blank" rel="noreferrer">${ev.title}</a></td>
      <td>${place}</td>
      <td>${fmtDur(ev.duration_min)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderTopCities(topCities) {
  const top = topCities?.[0];
  document.getElementById("topCityCount").textContent = top ? `${top.cnt}×` : "—";
  document.getElementById("topCityName").textContent = top ? top.city : "—";

  const ol = document.getElementById("topCities");
  ol.innerHTML = "";
  (topCities || []).forEach((c, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `<div>#${idx + 1} <b>${c.city}</b></div><div class="muted">${c.cnt}×</div>`;
    ol.appendChild(li);
  });
}

function renderLongest(longest) {
  const ol = document.getElementById("longest");
  ol.innerHTML = "";
  (longest || []).forEach((e, idx) => {
    const li = document.createElement("li");
    const place = e.place_norm || e.place_text || "—";
    li.innerHTML = `
      <div>
        #${idx + 1} <b>${fmtDur(e.duration_min)}</b>
        <div class="muted">${place}</div>
      </div>
      <div class="muted"><a href="${e.link}" target="_blank" rel="noreferrer">detail</a></div>
    `;
    ol.appendChild(li);
  });
}

let chart;
function renderChart(byDay) {
  const ctx = document.getElementById("chartDays").getContext("2d");
  const labels = (byDay || []).map(x => x.day);
  const values = (byDay || []).map(x => x.cnt);

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Výjezdy", data: values }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true },
      },
    },
  });
}

async function loadAll() {
  const onlyActive = document.getElementById("onlyActive").checked;
  const days = Number(document.getElementById("days").value || 30);
  document.getElementById("daysLabel").textContent = String(days);

  setStatus("načítám…");

  const [evRes, stRes] = await Promise.all([
    fetch(`/api/events?limit=400&onlyActive=${onlyActive ? 1 : 0}`).then(r => r.json()),
    fetch(`/api/stats?days=${days}`).then(r => r.json()),
  ]);

  if (!evRes.ok) {
    setStatus("chyba /api/events");
    return;
  }
  if (!stRes.ok) {
    setStatus("chyba /api/stats");
    return;
  }

  const items = evRes.items || [];
  ensureMap();
  clearLayers();
  items.forEach(addMarker);

  renderTable(items);
  renderTopCities(stRes.topCities || []);
  renderLongest(stRes.longest || []);
  renderChart(stRes.byDay || []);

  setStatus(`OK • ${items.length} záznamů • aktivní: ${stRes.activeCount}`);
}

function exportCsv() {
  const days = Number(document.getElementById("days").value || 30);
  window.location.href = `/api/export.csv?days=${days}`;
}

document.getElementById("btnReload").addEventListener("click", loadAll);
document.getElementById("btnExport").addEventListener("click", exportCsv);
document.getElementById("onlyActive").addEventListener("change", loadAll);
document.getElementById("days").addEventListener("change", loadAll);

loadAll();
