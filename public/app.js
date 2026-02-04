let map, markersLayer, chart;
let inFlight = false;

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
    const state = it.is_closed ? "UKONČENO" : "AKTIVNÍ";
    const durMin = getDisplayDurationMin(it);

    const tr = document.createElement("tr");
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

// ✅ ADMIN: ruční přepočet délek přes heslo
async function manualRecalc() {
  const pw = prompt("Zadej admin heslo pro přepočet délek:");
  if (!pw) return;

  try {
    setStatus("přepočítávám…", true);
    const r = await fetch("/api/admin/recalc-durations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Password": pw
      },
      body: JSON.stringify({ limit: 2000 })
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j?.ok) {
      setStatus(`chyba přepočtu: ${j?.error || r.status}`, false);
      return;
    }

    const rssInfo = j?.rss?.ok
      ? `rss ${j.rss.processed} / ukonč ${j.rss.closed_found}`
      : `rss skip`;

    const durInfo = `délky fixed ${j?.durations?.fixed ?? 0} / checked ${j?.durations?.checked ?? 0}`;

    setStatus(`OK • ${rssInfo} • ${durInfo}`, true);

    // po úspěchu obnov data
    await loadAll();
  } catch (e) {
    setStatus(`chyba přepočtu`, false);
  }
}

// UI events
document.getElementById("refreshBtn").addEventListener("click", loadAll);
document.getElementById("applyBtn").addEventListener("click", loadAll);
document.getElementById("resetBtn").addEventListener("click", () => { resetFilters(); loadAll(); });
document.getElementById("exportCsvBtn").addEventListener("click", () => exportWithFilters("csv"));
document.getElementById("exportPdfBtn").addEventListener("click", () => exportWithFilters("pdf"));
document.getElementById("recalcBtn").addEventListener("click", manualRecalc);

// map resize on responsive changes
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => safeInvalidateMap(), 120);
});
window.addEventListener("orientationchange", () => safeInvalidateMap());

initMap();
loadAll();

// ✅ AUTO REFRESH každých 5 minut (zachová filtry, jen znovu načte)
setInterval(() => {
  loadAll();
}, 5 * 60 * 1000);
