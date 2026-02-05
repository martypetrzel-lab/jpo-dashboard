// FireWatch CZ - frontend (App.js)
let map, markersLayer, chart;
let inFlight = false;

function setStatus(text, ok) {
  const pill = document.getElementById("statusPill");
  pill.textContent = text;
  pill.classList.toggle("ok", !!ok);
  pill.classList.toggle("bad", !ok);
}

function typeIcon(t) {
  // Hezčí / výraznější ikonky (pořád čisté emoji)
  switch (t) {
    case "fire":
      return "🔥🚒";
    case "traffic":
      return "🚗💥";
    case "tech":
      return "🛠️";
    case "rescue":
      return "🆘";
    case "false_alarm":
      return "🚨❎";
    default:
      return "📍";
  }
}

function fmtDT(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });
}

function fmtDateOnly(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("cs-CZ", { timeZone: "Europe/Prague" });
}

function fmtMin(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 60) return `${Math.round(n)} min`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return `${h} h ${m} min`;
}

function qs(id) {
  return document.getElementById(id);
}

function currentFilters() {
  const day = qs("daySelect")?.value || "all";
  const type = qs("typeSelect")?.value || "";
  const status = qs("statusSelect")?.value || "all";
  const city = qs("cityInput")?.value?.trim() || "";
  const month = qs("monthSelect")?.value || "";
  return { day, type, status, city, month };
}

function buildQuery(params) {
  const usp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (!s) return;
    usp.set(k, s);
  });
  return usp.toString();
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${t}`);
  }
  return await r.json();
}

function ensureMap() {
  if (map) return;

  map = L.map("map", {
    zoomControl: true,
    scrollWheelZoom: true,
  }).setView([49.95, 14.6], 9);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 18,
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function clearMarkers() {
  if (!markersLayer) return;
  markersLayer.clearLayers();
}

function addMarkers(items) {
  ensureMap();
  clearMarkers();

  const bounds = [];
  for (const it of items || []) {
    const lat = Number(it.lat);
    const lon = Number(it.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const icon = typeIcon(it.event_type);
    const title = it.title || "—";
    const place = it.city_text || it.place_text || "";
    const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const dur = fmtMin(it.duration_min);

    const popup = `
      <div style="min-width:220px">
        <div style="font-weight:700; margin-bottom:4px;">${icon} ${escapeHtml(title)}</div>
        <div style="opacity:.9">${escapeHtml(place)}</div>
        <div style="margin-top:6px;">
          <span style="padding:2px 6px;border-radius:10px;background:${it.is_closed ? "#203322" : "#2a2231"};color:#d7e2ff;">
            ${state}
          </span>
        </div>
        <div style="margin-top:6px;opacity:.85">
          Zahájení: ${escapeHtml(fmtDT(it.start_time_iso || it.pub_date))}<br/>
          Ukončení: ${it.is_closed ? escapeHtml(fmtDT(it.end_time_iso)) : "—"}<br/>
          Délka: ${escapeHtml(dur)}
        </div>
        ${it.link ? `<div style="margin-top:8px"><a href="${it.link}" target="_blank" rel="noopener">Detail</a></div>` : ""}
      </div>
    `;

    const marker = L.marker([lat, lon], {
      title: `${icon} ${title}`,
    }).bindPopup(popup);

    marker.addTo(markersLayer);
    bounds.push([lat, lon]);
  }

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderList(items) {
  const el = qs("list");
  if (!el) return;

  el.innerHTML = "";

  for (const it of items || []) {
    const row = document.createElement("div");
    row.className = "itemRow";

    const icon = typeIcon(it.event_type);
    const title = it.title || "—";
    const place = it.city_text || it.place_text || "";
    const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const dur = fmtMin(it.duration_min);

    row.innerHTML = `
      <div class="itemTop">
        <div class="itemTitle">${icon} ${escapeHtml(title)}</div>
        <div class="itemPill ${it.is_closed ? "pillClosed" : "pillOpen"}">${state}</div>
      </div>
      <div class="itemMeta">
        <div class="itemPlace">${escapeHtml(place)}</div>
        <div class="itemTime">
          <span>Zahájení:</span> ${escapeHtml(fmtDT(it.start_time_iso || it.pub_date))}
          <span class="sep">•</span>
          <span>Délka:</span> ${escapeHtml(dur)}
        </div>
      </div>
      <div class="itemActions">
        ${it.link ? `<a class="linkBtn" href="${it.link}" target="_blank" rel="noopener">Detail</a>` : ""}
        <button class="zoomBtn" data-lat="${it.lat}" data-lon="${it.lon}">Na mapě</button>
      </div>
    `;

    el.appendChild(row);
  }

  // map zoom buttons
  el.querySelectorAll(".zoomBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lat = Number(btn.getAttribute("data-lat"));
      const lon = Number(btn.getAttribute("data-lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      ensureMap();
      map.setView([lat, lon], 14, { animate: true });
    });
  });
}

function renderCounts(stats) {
  const openEl = qs("openCount");
  const closedEl = qs("closedCount");
  if (openEl) openEl.textContent = stats?.openCount ?? 0;
  if (closedEl) closedEl.textContent = stats?.closedCount ?? 0;
}

function renderTopCities(stats) {
  const el = qs("topCities");
  if (!el) return;
  el.innerHTML = "";

  for (const row of stats?.topCities || []) {
    const div = document.createElement("div");
    div.className = "topRow";
    div.innerHTML = `
      <div class="topCity">${escapeHtml(row.city)}</div>
      <div class="topCount">${row.count}</div>
    `;
    el.appendChild(div);
  }
}

function renderLongest(stats) {
  const el = qs("longest");
  if (!el) return;
  el.innerHTML = "";

  for (const it of stats?.longest || []) {
    const div = document.createElement("div");
    div.className = "longRow";
    const title = it.title || "—";
    const place = it.city_text || it.place_text || "";
    div.innerHTML = `
      <div class="longTitle">${escapeHtml(title)}</div>
      <div class="longMeta">
        <span class="longPlace">${escapeHtml(place)}</span>
        <span class="sep">•</span>
        <span class="longDur">${escapeHtml(fmtMin(it.duration_min))}</span>
      </div>
    `;
    el.appendChild(div);
  }
}

function renderChart(stats) {
  const canvas = qs("chart");
  if (!canvas) return;

  const labels = [];
  const data = [];

  const rows = (stats?.byDay || []).slice().reverse(); // od nejstaršího
  for (const r of rows) {
    labels.push(r.day);
    data.push(Number(r.count) || 0);
  }

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update();
    return;
  }

  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Počet výjezdů",
          data,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7 },
        },
      },
    },
  });
}

async function loadAll() {
  if (inFlight) return;
  inFlight = true;

  try {
    setStatus("Načítám…", true);

    const f = currentFilters();
    const qEvents = buildQuery({
      day: f.day,
      status: f.status,
      city: f.city,
      month: f.month,
      type: f.type,
      limit: 500,
    });

    const qStats = buildQuery({
      day: f.day,
      status: f.status,
      city: f.city,
      month: f.month,
      type: f.type,
    });

    const [events, stats] = await Promise.all([
      fetchJSON(`/api/events?${qEvents}`),
      fetchJSON(`/api/stats?${qStats}`),
    ]);

    const items = events?.items || [];
    addMarkers(items);
    renderList(items);

    renderCounts(stats);
    renderTopCities(stats);
    renderLongest(stats);
    renderChart(stats);

    setStatus(`OK (${items.length} položek)`, true);
  } catch (e) {
    console.error(e);
    setStatus(`Chyba: ${e?.message || "neznámá"}`, false);
  } finally {
    inFlight = false;
  }
}

function setupUI() {
  const refreshBtn = qs("refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", loadAll);

  ["daySelect", "typeSelect", "statusSelect", "monthSelect"].forEach((id) => {
    const el = qs(id);
    if (el) el.addEventListener("change", loadAll);
  });

  const cityInput = qs("cityInput");
  if (cityInput) {
    let t = null;
    cityInput.addEventListener("input", () => {
      if (t) clearTimeout(t);
      t = setTimeout(loadAll, 350);
    });
  }

  const exportPdfBtn = qs("exportPdfBtn");
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener("click", () => {
      const f = currentFilters();
      const q = buildQuery({
        day: f.day,
        status: f.status,
        city: f.city,
        month: f.month,
        type: f.type,
      });
      window.open(`/api/export/pdf?${q}`, "_blank");
    });
  }
}

window.addEventListener("load", () => {
  ensureMap();
  setupUI();
  loadAll();
});
