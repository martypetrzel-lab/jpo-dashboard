// FireWatch CZ - frontend
let map, markersLayer, chart;
let inFlight = false;

function setStatus(text, ok) {
  const pill = document.getElementById("statusPill");
  if (!pill) return;
  pill.textContent = text;
  pill.classList.toggle("ok", !!ok);
  pill.classList.toggle("bad", !ok);
}

function typeIcon(t) {
  switch (t) {
    case "fire":
      return "🔥";
    case "traffic":
      return "🚗";
    case "tech":
      return "🛠️";
    case "rescue":
      return "🧍";
    case "false_alarm":
      return "🚨";
    default:
      return "❓";
  }
}

function initMap() {
  map = L.map("map").setView([49.8, 15.3], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "© OpenStreetMap",
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
}

function formatDate(d) {
  if (!d) return "";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleString("cs-CZ");
  } catch {
    return String(d);
  }
}

function formatDuration(min) {
  if (!Number.isFinite(min) || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function getLiveDurationMin(it) {
  // pro aktivní: spočítej od start_time_iso/pub_date/created_at do teď
  if (it?.is_closed) return null;
  const start = it?.start_time_iso || it?.pub_date || it?.created_at;
  if (!start) return null;
  const a = new Date(start).getTime();
  if (!Number.isFinite(a)) return null;
  const diff = Math.round((Date.now() - a) / 60000);
  if (!Number.isFinite(diff) || diff <= 0) return null;
  return diff;
}

function getDisplayDurationMin(it) {
  // ✅ Historické ukončené zásahy (z doby před nasazením) nemají mít délku
  if (it?.is_closed && !it?.closed_detected_at) return null;

  if (Number.isFinite(it?.duration_min) && it.duration_min > 0) return it.duration_min;

  const live = getLiveDurationMin(it);
  return Number.isFinite(live) ? live : null;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTable(items) {
  const tbody = document.getElementById("eventsTbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const it of items) {
    const tr = document.createElement("tr");
    const d = formatDate(it.pub_date || it.created_at);
    const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";

    tr.innerHTML = `
      <td>${escapeHtml(d)}</td>
      <td class="center">${escapeHtml(typeIcon(it.event_type))}</td>
      <td>${escapeHtml(it.title || "")}</td>
      <td>${escapeHtml(it.city_text || it.place_text || "")}</td>
      <td>${escapeHtml(state)}</td>
      <td>${escapeHtml(formatDuration(getDisplayDurationMin(it)))}</td>
      <td><a href="${escapeHtml(it.link || "#")}" target="_blank" rel="noopener">otevřít</a></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderMap(items) {
  if (!markersLayer || !map) return;
  markersLayer.clearLayers();

  const pts = [];

  for (const it of items) {
    if (typeof it.lat !== "number" || typeof it.lon !== "number") continue;

    const lat = it.lat;
    const lon = it.lon;
    pts.push([lat, lon]);

    const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const popupHtml = `
      <div style="min-width:220px">
        <div><b>${escapeHtml(it.title || "")}</b></div>
        <div>${escapeHtml(it.city_text || it.place_text || "")}</div>
        <div>${escapeHtml(state)} • ${escapeHtml(formatDuration(getDisplayDurationMin(it)))}</div>
        <div style="margin-top:6px">
          <a href="${escapeHtml(it.link || "#")}" target="_blank" rel="noopener">otevřít detail</a>
        </div>
      </div>
    `;

    // ✅ zachovat emotikony i v bodech mapy
    const emoji = typeIcon(it.event_type);
    const icon = L.divIcon({
      className: "emoji-marker",
      html: `<div style="font-size:22px; line-height:22px;">${escapeHtml(emoji)}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });

    const m = L.marker([lat, lon], { title: it.title || "", icon }).bindPopup(popupHtml);
    markersLayer.addLayer(m);
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
      try {
        map.invalidateSize(true);
      } catch {
        /* ignore */
      }
    }, 30);
  } catch {
    /* ignore */
  }
}

function renderChart(byDay) {
  const ctx = document.getElementById("chartByDay");
  if (!ctx) return;

  const labels = (byDay || []).map((x) => x.day);
  const data = (byDay || []).map((x) => x.count);

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update();
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: "Počet výjezdů", data, tension: 0.25 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true } },
    },
  });
}

function renderCounts(openCount, closedCount) {
  const a = document.getElementById("openCount");
  const b = document.getElementById("closedCount");
  if (a) a.textContent = String(openCount ?? "—");
  if (b) b.textContent = String(closedCount ?? "—");
}

function renderTopCities(topCities) {
  const el = document.getElementById("topCities");
  if (!el) return;
  el.innerHTML = "";

  for (const c of topCities || []) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `<div>${escapeHtml(c.city || "")}</div><div class="muted">${escapeHtml(c.count)}</div>`;
    el.appendChild(row);
  }
}

function renderLongest(longest) {
  const el = document.getElementById("longestList");
  if (!el) return;
  el.innerHTML = "";

  const items = longest || [];
  if (items.length === 0) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `<div class="muted">Zatím nic (délka se počítá jen u nových uzavření)</div>`;
    el.appendChild(row);
    return;
  }

  let idx = 1;
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "listRow";
    row.innerHTML = `
      <div>
        <div><b>#${idx}</b> ${escapeHtml(it.title || "")}</div>
        <div class="muted">${escapeHtml(it.city_text || it.place_text || "")}</div>
      </div>
      <div class="muted">${escapeHtml(formatDuration(it.duration_min))}</div>
    `;
    el.appendChild(row);
    idx++;
  }
}

function getFiltersFromUi() {
  const day = (document.getElementById("daySelect")?.value || "today").trim();
  const type = (document.getElementById("typeSelect")?.value || "").trim();
  const city = (document.getElementById("cityInput")?.value || "").trim();
  const status = (document.getElementById("statusSelect")?.value || "all").trim();
  const month = (document.getElementById("monthInput")?.value || "").trim();
  return { day: day || "today", type, city, status: status || "all", month };
}

function buildQuery(filters) {
  const qs = new URLSearchParams();

  // ✅ FIX: day posílej vždy (today/yesterday/all), aby mapa+body seděly s tabulkou
  if (filters.day) qs.set("day", filters.day);

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
      fetch(`/api/stats${q ? `?${q}` : ""}`),
    ]);

    if (!eventsRes.ok || !statsRes.ok) {
      setStatus("chyba API", false);
      return;
    }

    const eventsJson = await eventsRes.json();
    const statsJson = await statsRes.json();

    const items = eventsJson.items || [];

    renderTable(items);
    renderMap(items);

    renderChart(statsJson.byDay || []);
    renderCounts(statsJson.openCount, statsJson.closedCount);
    renderTopCities(statsJson.topCities || []);
    renderLongest(statsJson.longest || []);

    const missing = items.filter((x) => x.lat == null || x.lon == null).length;
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
  const t = document.getElementById("typeSelect");
  if (t) t.value = "";
  const c = document.getElementById("cityInput");
  if (c) c.value = "";
  const s = document.getElementById("statusSelect");
  if (s) s.value = "all";
  const monthEl = document.getElementById("monthInput");
  if (monthEl) monthEl.value = "";
}

function exportWithFilters(kind) {
  const filters = getFiltersFromUi();
  const q = buildQuery(filters);

  const url =
    kind === "pdf"
      ? `/api/export.pdf${q ? `?${q}` : ""}`
      : `/api/export.csv${q ? `?${q}` : ""}`;

  window.open(url, "_blank");
}

// UI events
document.getElementById("refreshBtn")?.addEventListener("click", loadAll);
document.getElementById("applyBtn")?.addEventListener("click", loadAll);
document.getElementById("resetBtn")?.addEventListener("click", () => {
  resetFilters();
  loadAll();
});
document.getElementById("exportCsvBtn")?.addEventListener("click", () => exportWithFilters("csv"));
document.getElementById("exportPdfBtn")?.addEventListener("click", () => exportWithFilters("pdf"));

// map resize
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => safeInvalidateMap(), 120);
});
window.addEventListener("orientationchange", () => safeInvalidateMap());

initMap();
loadAll();

// auto refresh každých 5 min
setInterval(() => {
  loadAll();
}, 5 * 60 * 1000);