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

function typeLabel(t) {
  return (TYPE[t] || TYPE.other).label;
}

function setStatus(text, ok = true) {
  const pill = document.getElementById("statusPill");
  pill.textContent = text;
  pill.style.background = ok ? "rgba(60, 180, 120, 0.20)" : "rgba(220, 80, 80, 0.20)";
  pill.style.borderColor = ok ? "rgba(60, 180, 120, 0.35)" : "rgba(220, 80, 80, 0.35)";
}

function initMap() {
  map = L.map("map").setView([50.08, 14.43], 8);
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
  const m = Math.round(min % 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function minutesSince(dtIso) {
  if (!dtIso) return null;
  const dt = new Date(dtIso);
  if (isNaN(dt.getTime())) return null;
  const ms = Date.now() - dt.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

function effectiveRunningMinutes(it) {
  // prefer start_time_iso, else first_seen_at, else created_at
  const m =
    minutesSince(it.start_time_iso) ??
    minutesSince(it.first_seen_at) ??
    minutesSince(it.created_at);
  return Number.isFinite(m) ? m : null;
}

function statePill(isClosed) {
  return isClosed
    ? `<span class="statePill closed">UKONČENO</span>`
    : `<span class="statePill open">AKTIVNÍ</span>`;
}

function renderTable(items) {
  const tbody = document.getElementById("eventsTbody");
  tbody.innerHTML = "";

  for (const it of items) {
    const t = it.event_type || "other";
    const tr = document.createElement("tr");
    const isClosed = !!it.is_closed;

    const durMin = isClosed
      ? (Number.isFinite(it.duration_min) ? it.duration_min : null)
      : effectiveRunningMinutes(it);

    tr.className = isClosed ? "" : "rowActive";

    tr.innerHTML = `
      <td>${escapeHtml(formatDate(it.pub_date || it.created_at))}</td>
      <td><span class="iconPill" title="${escapeHtml(typeLabel(t))}">${typeEmoji(t)}</span></td>
      <td>${statePill(isClosed)}</td>
      <td>${escapeHtml(it.title || "")}</td>
      <td>${escapeHtml(it.place_text || "")}</td>
      <td>${escapeHtml(it.status_text || "")}</td>
      <td>${escapeHtml(formatDuration(durMin))}</td>
      <td>${it.link ? `<a href="${it.link}" target="_blank" rel="noopener">otevřít</a>` : ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

function makeMarkerIcon(emoji, isClosed) {
  const cls = isClosed ? "mIcon" : "mIcon mIconActive";
  return L.divIcon({
    className: "leaflet-div-icon",
    html: `<div class="${cls}" style="transform:translate(-50%,-50%);font-size:22px;">${emoji}</div>`,
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
      const isClosed = !!it.is_closed;

      const m = L.marker([it.lat, it.lon], { icon: makeMarkerIcon(emoji, isClosed) });

      const durMin = isClosed
        ? (Number.isFinite(it.duration_min) ? it.duration_min : null)
        : effectiveRunningMinutes(it);

      const html = `
        <div style="min-width:260px">
          <div style="font-weight:700;margin-bottom:6px">${emoji} ${escapeHtml(it.title || "")}</div>
          <div><b>Stav:</b> ${isClosed ? "UKONČENO" : "AKTIVNÍ"}</div>
          <div><b>Typ:</b> ${escapeHtml(typeLabel(t))}</div>
          <div><b>Místo:</b> ${escapeHtml(it.place_text || "")}</div>
          <div><b>Čas:</b> ${escapeHtml(formatDate(it.pub_date || it.created_at))}</div>
          <div><b>Délka:</b> ${escapeHtml(formatDuration(durMin))}${isClosed ? "" : " (běží)"}</div>
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
    div.innerHTML = `
      <div class="left">
        <div class="meta">#${idx + 1}</div>
        <div class="name">${escapeHtml(r.title || "")}</div>
      </div>
      <div class="meta">${escapeHtml(formatDuration(r.duration_min))}</div>
    `;
    div.addEventListener("click", () => {
      if (r.link) window.open(r.link, "_blank", "noopener");
    });
    wrap.appendChild(div);
  });
}

function renderBestCity(bestCity) {
  const v = document.getElementById("bestCityValue");
  const l = document.getElementById("bestCityLabel");
  if (!bestCity) {
    v.textContent = "—";
    l.textContent = "Zatím žádná data";
    return;
  }
  v.textContent = `${bestCity.count}×`;
  l.textContent = bestCity.city;
}

function renderOpenClosed(openCount, closedCount) {
  document.getElementById("openCountValue").textContent = `${openCount ?? 0}`;
  document.getElementById("closedCountValue").textContent = `${closedCount ?? 0}`;
}

function renderByType(rows) {
  const wrap = document.getElementById("byTypeList");
  wrap.innerHTML = "";
  rows.forEach((r, idx) => {
    const t = r.type || "other";
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `
      <div class="left">
        <div class="meta">#${idx + 1}</div>
        <div class="name">${typeEmoji(t)} ${escapeHtml(typeLabel(t))}</div>
      </div>
      <div class="meta">${r.count}×</div>
    `;
    wrap.appendChild(div);
  });
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
  const type = document.getElementById("filterType").value.trim();
  const city = document.getElementById("filterCity").value.trim();
  const status = document.getElementById("filterStatus").value.trim();

  const p = new URLSearchParams();
  if (type) p.set("type", type);
  if (city) p.set("city", city);
  if (status && status !== "all") p.set("status", status);
  return p;
}

function updateExportLinks(params) {
  const qs = params.toString();
  const csv = document.getElementById("exportCsvBtn");
  const pdf = document.getElementById("exportPdfBtn");
  csv.href = "/api/export.csv" + (qs ? `?${qs}` : "");
  pdf.href = "/api/export.pdf" + (qs ? `?${qs}` : "");
}

async function loadAll() {
  setStatus("načítám…", true);

  const params = getFiltersFromUi();
  params.set("limit", "400");
  updateExportLinks(params);

  const qs = params.toString();
  const [eventsRes, statsRes] = await Promise.all([
    fetch("/api/events" + (qs ? `?${qs}` : "")),
    fetch("/api/stats" + (qs ? `?${qs}` : ""))
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
  renderOpenClosed(statsJson.openCount ?? 0, statsJson.closedCount ?? 0);
  renderByType(statsJson.byType || []);

  renderBestCity(statsJson.bestCity || null);
  renderTopCities(statsJson.topCities || []);
  renderLongest(statsJson.longest || []);

  const openNow = items.filter(x => !x.is_closed).length;
  setStatus(`OK • ${items.length} záznamů • aktivní ${openNow}`, true);
}

document.getElementById("refreshBtn").addEventListener("click", loadAll);

document.getElementById("applyBtn").addEventListener("click", loadAll);
document.getElementById("resetBtn").addEventListener("click", () => {
  document.getElementById("filterType").value = "";
  document.getElementById("filterCity").value = "";
  document.getElementById("filterStatus").value = "all";
  loadAll();
});

initMap();
loadAll();
