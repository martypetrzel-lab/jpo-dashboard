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

// Pojistka i ve FE: pokud je to extrémně velké, bereme to jako sekundy.
function normalizeDuration(min) {
  if (!Number.isFinite(min)) return null;
  let n = Math.round(min);
  if (n <= 0) return null;
  if (n > 20000) n = Math.round(n / 60);
  return n;
}

function formatDuration(min) {
  const v = normalizeDuration(min);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const h = Math.floor(v / 60);
  const m = v % 60;
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

function renderTable(items) {
  const tbody = document.getElementById("eventsTbody");
  tbody.innerHTML = "";
  for (const it of items) {
    const t = it.event_type || "other";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDate(it.pub_date || it.created_at)}</td>
      <td><span class="iconPill" title="${escapeHtml((TYPE[t]||TYPE.other).label)}">${typeEmoji(t)}</span></td>
      <td>${escapeHtml(it.title || "")}</td>
      <td>${escapeHtml(it.place_text || "")}</td>
      <td>${escapeHtml(it.status_text || "")}</td>
      <td>${formatDuration(it.duration_min)}</td>
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

      const html = `
        <div style="min-width:240px">
          <div style="font-weight:700;margin-bottom:6px">${emoji} ${escapeHtml(it.title || "")}</div>
          <div><b>Místo:</b> ${escapeHtml(it.place_text || "")}</div>
          <div><b>Stav:</b> ${escapeHtml(it.status_text || "")}</div>
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

async function loadAll() {
  setStatus("načítám…", true);

  const [eventsRes, statsRes] = await Promise.all([
    fetch("/api/events?limit=400"),
    fetch("/api/stats")
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
  renderBestCity(statsJson.bestCity || null);
  renderTopCities(statsJson.topCities || []);
  renderLongest(statsJson.longest || []);

  setStatus(`OK • ${items.length} záznamů`, true);
}

document.getElementById("refreshBtn").addEventListener("click", loadAll);

initMap();
loadAll();