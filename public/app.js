// app.js
let map, markersLayer, chart;

// CZ bounding box: lon 12.09–18.87, lat 48.55–51.06 (stejné jako backend)
const CZ_BOUNDS = { minLat: 48.55, maxLat: 51.06, minLon: 12.09, maxLon: 18.87 };

function inBounds(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= CZ_BOUNDS.minLat && lat <= CZ_BOUNDS.maxLat &&
    lon >= CZ_BOUNDS.minLon && lon <= CZ_BOUNDS.maxLon
  );
}

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
    if (typeof it.lat === "number" && typeof it.lon === "number" && inBounds(it.lat, it.lon)) {
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

function getFiltersFromUi() {
  const type = document.getElementById("typeSelect").value.trim();
  const city = document.getElementById("cityInput").value.trim();
  const status = document.getElementById("statusSelect").value.trim();

  // do API posíláme: type=... (1 typ), city=..., status=all/open/closed
  return {
    type: type || "",
    city: city || "",
    status: status || "all"
  };
}

function buildQuery(filters) {
  const qs = new URLSearchParams();
  if (filters.type) qs.set("type", filters.type);
  if (filters.city) qs.set("city", filters.city);
  if (filters.status && filters.status !== "all") qs.set("status", filters.status);
  return qs.toString();
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

// admin: ruční přepočet délek zásahu
const recalcBtn = document.getElementById("recalcBtn");
if (recalcBtn) {
  recalcBtn.addEventListener("click", async () => {
    const pw = String(document.getElementById("adminPwInput")?.value || "").trim();
    if (!pw) {
      setStatus("Zadej ADMIN_PASSWORD", false);
      return;
    }

    try {
      setStatus("Přepočítávám…", true);
      const r = await fetch("/api/admin/recalc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Password": pw
        },
        body: JSON.stringify({ limit: 10000 })
      });

      if (!r.ok) {
        setStatus("Chyba přepočtu (heslo?)", false);
        return;
      }

      const j = await r.json();
      setStatus(`Hotovo • opraveno: ${j.touched || 0} • doplněno end: ${j.filledEnd || 0} • délka: ${j.filledDur || 0}`, true);
      await loadAll();
    } catch {
      setStatus("Chyba přepočtu", false);
    }
  });
}

// map resize on responsive changes
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => safeInvalidateMap(), 120);
});
window.addEventListener("orientationchange", () => safeInvalidateMap());

initMap();
loadAll();
