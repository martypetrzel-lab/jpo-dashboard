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
  map = L.map("map").setView([49.8, 15.3], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
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

function renderTable(items) {
  const tbody = document.getElementById("eventsTbody");
  tbody.innerHTML = "";
  for (const it of items) {
    const t = it.event_type || "other";
    const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(formatDate(it.pub_date || it.created_at))}</td>
      <td><span class="iconPill" title="${escapeHtml((TYPE[t]||TYPE.other).label)}">${typeEmoji(t)}</span></td>
      <td>${escapeHtml(it.title || "")}</td>
      <td>${escapeHtml(it.city_text || it.place_text || "")}</td>
      <td>${escapeHtml(state)}</td>
      <td>${escapeHtml(formatDuration(it.duration_min))}</td>
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
      const html = `
        <div style="min-width:240px">
          <div style="font-weight:700;margin-bottom:6px">${emoji} ${escapeHtml(it.title || "")}</div>
          <div><b>Stav:</b> ${escapeHtml(state)}</div>
          <div><b>Město:</b> ${escapeHtml(it.city_text || it.place_text || "")}</div>
          <div><b>Čas:</b> ${escapeHtml(formatDate(it.pub_date || it.created_at))}</div>
          <div><b>Délka:</b> ${escapeHtml(formatDuration(it.duration_min))}</div>
          ${it.link ? `<div style="margin-top:8px"><a href="${it.link}" target="_blank" rel="noopener">Detail</a></div>` : ""}
        </div>
      `;
      m.bindPopup(html);
      m.addTo(markersLayer);
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

function defaultMonthValue() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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

function buildQueryForEvents(filters) {
  const qs = new URLSearchParams();
  if (filters.day) qs.set("day", filters.day);
  if (filters.type) qs.set("type", filters.type);
  if (filters.city) qs.set("city", filters.city);
  if (filters.status && filters.status !== "all") qs.set("status", filters.status);
  return qs.toString();
}

function buildQueryForStats(filters) {
  // ✅ sem neposíláme day (stats = 30 dní), ale posíláme month (žebříček)
  const qs = new URLSearchParams();
  if (filters.type) qs.set("type", filters.type);
  if (filters.city) qs.set("city", filters.city);
  if (filters.status && filters.status !== "all") qs.set("status", filters.status);
  if (filters.month) qs.set("month", filters.month);
  return qs.toString();
}

async function loadAll() {
  const filters = getFiltersFromUi();

  const qEvents = buildQueryForEvents(filters);
  const qStats = buildQueryForStats(filters);

  setStatus("načítám…", true);

  const [eventsRes, statsRes] = await Promise.all([
    fetch(`/api/events?limit=500${qEvents ? `&${qEvents}` : ""}`),
    fetch(`/api/stats${qStats ? `?${qStats}` : ""}`)
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

  // ✅ žebříček měst – preferuje monthlyCities, fallback pokud by někde byl starý topCities
  renderTopCities(statsJson.monthlyCities || statsJson.topCities || []);
  renderLongest(statsJson.longest || []);

  const missing = items.filter(x => x.lat == null || x.lon == null).length;

  const dayLabel =
    filters.day === "today" ? "dnes" :
    filters.day === "yesterday" ? "včera" : "vše";

  const monthLabel = filters.month || "—";

  setStatus(`OK • ${items.length} záznamů • den ${dayLabel} • měsíc ${monthLabel} • bez souřadnic ${missing}`, true);
}

function resetFilters() {
  if (document.getElementById("daySelect")) document.getElementById("daySelect").value = "today";
  document.getElementById("typeSelect").value = "";
  document.getElementById("cityInput").value = "";
  document.getElementById("statusSelect").value = "all";
  if (document.getElementById("monthInput")) document.getElementById("monthInput").value = defaultMonthValue();
}

function exportWithFilters(kind) {
  const filters = getFiltersFromUi();

  // export = map+tabulka logika, takže day patří do exportu (ať exportuje to co vidíš)
  const qs = new URLSearchParams();
  if (filters.day) qs.set("day", filters.day);
  if (filters.type) qs.set("type", filters.type);
  if (filters.city) qs.set("city", filters.city);
  if (filters.status && filters.status !== "all") qs.set("status", filters.status);

  const q = qs.toString();
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

// init defaults
if (document.getElementById("monthInput") && !document.getElementById("monthInput").value) {
  document.getElementById("monthInput").value = defaultMonthValue();
}
loadAll();
