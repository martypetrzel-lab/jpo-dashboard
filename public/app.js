let map, markersLayer, chart;

const TYPE = {
  fire: { emoji: "🔥", label: "požár" },
  traffic: { emoji: "🚗", label: "nehoda" },
  tech: { emoji: "🛠️", label: "technická" },
  rescue: { emoji: "🧍", label: "záchrana" },
  false_alarm: { emoji: "🚨", label: "planý poplach" },
  other: { emoji: "❓", label: "jiné" }
};

function typeEmoji(t) {
  return (TYPE[t] || TYPE.other).emoji;
}

function setStatus(text, ok = true) {
  const pill = document.getElementById("statusPill");
  pill.textContent = text;
  pill.style.background = ok ? "rgba(60, 180, 120, 0.20)" : "rgba(220, 80, 80, 0.20)";
  pill.style.borderColor = ok ? "rgba(60, 180, 120, 0.35)" : "rgba(220, 80, 80, 0.35)";
}

function initMap() {
  // ✅ Středočeský kraj: základní pohled + omezení posunu mapy
  const stcCenter = [49.95, 14.60];
  const stcZoom = 8;

  map = L.map("map").setView(stcCenter, stcZoom);

  // přibližné hranice Středočeského kraje (ne úplně přesné, ale pro omezení mapy stačí)
  const stcBounds = L.latLngBounds(
    L.latLng(49.20, 13.20), // SW
    L.latLng(50.75, 15.80)  // NE
  );
  map.setMaxBounds(stcBounds.pad(0.05));
  map.on("drag", () => map.panInsideBounds(stcBounds, { animate: false }));

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("cs-CZ");
}

function formatDuration(min) {
  if (!Number.isFinite(min) || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function parseIsoMs(iso) {
  if (!iso) return NaN;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

// ✅ DÉLKA:
// - aktivní: (now - start)
// - ukončené historické: bez času (—)
// - ukončené nové: použij duration_min z DB
function getDisplayDurationMin(it) {
  if (!it) return null;

  if (!it.is_closed) {
    const startMs = parseIsoMs(it.start_time_iso) || parseIsoMs(it.pub_date) || parseIsoMs(it.created_at);
    if (!Number.isFinite(startMs)) return null;
    const nowMs = Date.now();
    const min = Math.round((nowMs - startMs) / 60000);
    if (!Number.isFinite(min) || min <= 0) return null;
    return min;
  }

  // ukončené: jen "nově ukončené" mají closed_detected_at
  if (it.closed_detected_at && Number.isFinite(it.duration_min) && it.duration_min > 0) {
    return it.duration_min;
  }

  return null;
}

function safeInvalidateMap() {
  try {
    if (map) map.invalidateSize();
  } catch {
    // ignore
  }
}

function getFiltersFromUi() {
  const type = document.getElementById("typeSelect").value.trim();
  const city = document.getElementById("cityInput").value.trim();
  const status = document.getElementById("statusSelect").value.trim();

  const types = type ? [type] : [];
  return { types, city, status };
}

function buildQuery(filters) {
  const q = new URLSearchParams();
  if (filters.types && filters.types.length) q.set("type", filters.types.join(","));
  if (filters.city) q.set("city", filters.city);
  if (filters.status && filters.status !== "all") q.set("status", filters.status);
  return q.toString();
}

function renderTable(items) {
  const tbody = document.querySelector("#eventsTable tbody");
  tbody.innerHTML = "";
  for (const it of items) {
    const t = it.event_type || "other";
    const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const tr = document.createElement("tr");

    const durMin = getDisplayDurationMin(it);

    tr.innerHTML = `
      <td>${escapeHtml(formatDate(it.pub_date || it.created_at))}</td>
      <td><span class="iconPill" title="${escapeHtml((TYPE[t] || TYPE.other).label)}">${typeEmoji(t)}</span></td>
      <td>${escapeHtml(it.title || "")}</td>
      <td>${escapeHtml(it.city_text || it.place_text || "")}</td>
      <td>${escapeHtml(state)}</td>
      <td>${escapeHtml(formatDuration(durMin))}</td>
      <td>${it.link ? `<a href="${it.link}" target="_blank" rel="noopener">otevřít</a>` : ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

function makeMarkerIcon(emoji) {
  return L.divIcon({
    className: "leaflet-div-icon",
    html: `<div style="transform:translate(-50%,-50%);font-size:22px;">${emoji}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });
}

function renderMap(items) {
  markersLayer.clearLayers();

  const pts = [];
  for (const it of items) {
    if (typeof it.lat === "number" && typeof it.lon === "number") {
      const t = it.event_type || "other";
      const emoji = typeEmoji(t);

      const m = L.marker([it.lat, it.lon], { icon: makeMarkerIcon(emoji) });

      const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
      const durMin = getDisplayDurationMin(it);

      const html = `
        <div style="min-width:240px">
          <div style="font-weight:700;margin-bottom:6px">${emoji} ${escapeHtml(it.title || "")}</div>
          <div><b>Stav:</b> ${escapeHtml(state)}</div>
          <div><b>Město:</b> ${escapeHtml(it.city_text || it.place_text || "")}</div>
          <div><b>Čas:</b> ${escapeHtml(formatDate(it.pub_date || it.created_at))}</div>
          <div><b>Délka:</b> ${escapeHtml(formatDuration(durMin))}</div>
          ${it.link ? `<div style="margin-top:8px"><a href="${it.link}" target="_blank" rel="noopener">Detail</a></div>` : ""}
        </div>
      `;
      m.bindPopup(html);
      m.addTo(markersLayer);
      pts.push([it.lat, it.lon]);
    }
  }

  // ❗️Nezoomuj na celou ČR – zůstaň v STČ, ale když máme body, přizpůsob se jim v rámci max bounds
  if (pts.length > 0) {
    const bounds = L.latLngBounds(pts);
    map.fitBounds(bounds.pad(0.15), { maxZoom: 12 });
  }
}

function renderTopCities(rows) {
  const wrap = document.getElementById("topCitiesList");
  wrap.innerHTML = "";
  rows.forEach((r, idx) => {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `
      <div class="left">
        <div class="meta">#${idx + 1}</div>
        <div class="name">${escapeHtml(r.city || "")}</div>
      </div>
      <div class="meta">${escapeHtml(String(r.count ?? 0))}</div>
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

    // stats vrací jen nově ukončené => duration_min je validní
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

  const ctx = document.getElementById("chartCanvas");

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Události / den", data, tension: 0.3 }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { maxRotation: 0 } },
        y: { beginAtZero: true }
      }
    }
  });
}

async function loadAll() {
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

  renderChart(statsJson.byDay || []);
  renderCounts(statsJson.openCount, statsJson.closedCount);
  renderTopCities(statsJson.topCities || []);
  renderLongest(statsJson.longest || []);

  const missing = items.filter(x => x.lat == null || x.lon == null).length;
  setStatus(`OK • ${items.length} záznamů • bez souřadnic ${missing}`, true);
}

function resetFilters() {
  document.getElementById("typeSelect").value = "";
  document.getElementById("cityInput").value = "";
  document.getElementById("statusSelect").value = "all";
}

function exportWithFilters(kind) {
  const filters = getFiltersFromUi();
  const q = buildQuery(filters);
  const url = `/api/export.${kind}${q ? `?${q}` : ""}`;
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

// ✅ AUTO REFRESH (bez reloadu stránky)
setInterval(() => {
  loadAll();
}, 5 * 60 * 1000);
