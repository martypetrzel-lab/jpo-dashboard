const API_EVENTS = "/api/events";
const API_STATS  = "/api/stats";

let currentKind = "all";
let currentActive = "active"; // active | closed | all

const statusPill = document.getElementById("statusPill");
const btnRefresh = document.getElementById("btnRefresh");
const btnPrint = document.getElementById("btnPrint");

const kpiActive = document.getElementById("kpiActive");
const kpiClosed = document.getElementById("kpiClosed");
const topCityEl = document.getElementById("topCity");
const topCitiesEl = document.getElementById("topCities");
const longestEl = document.getElementById("longest");
const tableWrap = document.getElementById("tableWrap");

// ---------- Map ----------
const map = L.map("map", { zoomControl: true }).setView([50.08, 14.43], 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const cluster = L.markerClusterGroup({ showCoverageOnHover: false });
map.addLayer(cluster);

function kindEmoji(k){
  if (k === "pozar") return "🔥";
  if (k === "nehoda") return "🚗";
  if (k === "technicka") return "🛠";
  if (k === "zachrana") return "🧍";
  return "❓";
}

function fmtDur(sec){
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h <= 0) return `${m} min`;
  return `${h} h ${m} min`;
}

function fmtDt(dt){
  if (!dt) return "—";
  const d = new Date(dt);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("cs-CZ");
}

function badgeHtml(isClosed){
  if (isClosed) return `<span class="badge closed">⚪ ukončeno</span>`;
  return `<span class="badge ok">🟢 aktivní</span>`;
}

function buildPopup(e){
  const title = e.title || "—";
  const place = e.place_text || "—";
  const st = e.status_text || "";
  const opened = fmtDt(e.opened_at);
  const closed = fmtDt(e.closed_at);
  const dur = fmtDur(e.duration_sec);

  return `
    <div style="font-family:system-ui;min-width:220px">
      <div style="font-weight:800;margin-bottom:6px">${kindEmoji(e.kind)} ${title}</div>
      <div style="color:#556; margin-bottom:6px">${place}</div>
      <div style="font-size:12px; margin-bottom:8px">${badgeHtml(e.is_closed)} <span style="margin-left:8px">${st}</span></div>
      <div style="font-size:12px">
        <div><b>Start:</b> ${opened}</div>
        <div><b>Konec:</b> ${closed}</div>
        <div><b>Délka:</b> ${dur}</div>
      </div>
      <div style="margin-top:10px">
        ${e.link ? `<a href="${e.link}" target="_blank" rel="noreferrer">Detail události</a>` : ""}
      </div>
    </div>
  `;
}

function makeMarker(e){
  const icon = L.divIcon({
    className: "customPin",
    html: `<div style="
      width:28px;height:28px;border-radius:999px;
      display:flex;align-items:center;justify-content:center;
      background:${e.is_closed ? "#172435" : "#17d48a"};
      color:${e.is_closed ? "#e7eef7" : "#0c251a"};
      font-weight:900;
      border:1px solid rgba(0,0,0,0.2);
      box-shadow:0 6px 12px rgba(0,0,0,0.22);
    ">${kindEmoji(e.kind)}</div>`,
    iconSize: [28,28],
    iconAnchor: [14,14]
  });

  const m = L.marker([e.lat, e.lon], { icon });
  m.bindPopup(buildPopup(e));
  return m;
}

// ---------- Charts ----------
let chartByDay = null;

function renderChartByDay(byDay){
  const arr = Array.isArray(byDay) ? byDay : [];
  const labels = arr.map(x => x.day);
  const values = arr.map(x => x.cnt);

  const ctx = document.getElementById("chartByDay");
  if (chartByDay) chartByDay.destroy();

  chartByDay = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Počet výjezdů", data: values, tension: 0.25 }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#93a4b7" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: "#93a4b7" }, grid: { color: "rgba(255,255,255,0.06)" } }
      }
    }
  });
}

// ---------- UI render ----------
function renderTopCities(list){
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length){ topCitiesEl.innerHTML = `<div class="small">—</div>`; return; }

  topCitiesEl.innerHTML = arr.map((x, i) => `
    <div class="item">
      <div class="left">
        <div class="title">#${i+1} ${x.city}</div>
        <div class="sub">počet výjezdů</div>
      </div>
      <div class="badge">${x.cnt}×</div>
    </div>
  `).join("");
}

function renderLongest(list){
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length){ longestEl.innerHTML = `<div class="small">Zatím nejsou data o délce (ukončení).</div>`; return; }

  longestEl.innerHTML = arr.map((x, i) => `
    <div class="item">
      <div class="left">
        <div class="title">#${i+1} ${kindEmoji(x.kind)} ${x.place_text || "—"}</div>
        <div class="sub">${x.title || "—"}</div>
        <div class="sub">Start: ${fmtDt(x.opened_at)} • Konec: ${fmtDt(x.closed_at)}</div>
      </div>
      <div class="badge">${fmtDur(x.duration_sec)}</div>
    </div>
  `).join("");
}

function renderTable(items){
  const arr = Array.isArray(items) ? items : [];

  // mobile cards
  if (window.matchMedia("(max-width: 640px)").matches){
    tableWrap.innerHTML = `<div class="cards">${
      arr.map(e => `
        <div class="cardRow">
          <div class="rowTop">
            <div>${kindEmoji(e.kind)} ${e.place_text || "—"}</div>
            <div>${e.is_closed ? "⚪" : "🟢"}</div>
          </div>
          <div class="rowMid">${e.title || "—"}</div>
          <div class="rowBot">
            <span class="badge ${e.is_closed ? "closed" : "ok"}">${e.is_closed ? "ukončeno" : "aktivní"}</span>
            <span class="badge">${fmtDur(e.duration_sec)}</span>
            ${e.link ? `<a class="btn ghost" style="padding:6px 10px" href="${e.link}" target="_blank" rel="noreferrer">Detail</a>` : ""}
          </div>
        </div>
      `).join("")
    }</div>`;
    return;
  }

  // desktop table
  tableWrap.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Stav</th>
          <th>Typ</th>
          <th>Název</th>
          <th>Město</th>
          <th>Délka</th>
        </tr>
      </thead>
      <tbody>
        ${arr.map(e => `
          <tr>
            <td>${e.is_closed ? `<span class="badge closed">⚪ ukončeno</span>` : `<span class="badge ok">🟢 aktivní</span>`}</td>
            <td class="kindIcon">${kindEmoji(e.kind)}</td>
            <td>${e.link ? `<a href="${e.link}" target="_blank" rel="noreferrer">${e.title || "—"}</a>` : (e.title || "—")}</td>
            <td>${e.place_text || "—"}</td>
            <td>${fmtDur(e.duration_sec)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function setStatus(ok, msg){
  statusPill.textContent = msg;
  statusPill.style.color = ok ? "#93a4b7" : "#ffd25a";
}

// ---------- Data loading ----------
async function loadAll(){
  try{
    setStatus(true, "načítám…");

    const qs = new URLSearchParams();
    qs.set("limit", "800");

    if (currentKind !== "all") qs.set("kind", currentKind);

    if (currentActive === "active") qs.set("active", "1");
    else if (currentActive === "closed") qs.set("active", "0");

    const [ev, st] = await Promise.all([
      fetch(`${API_EVENTS}?${qs.toString()}`).then(r => r.json()),
      fetch(`${API_STATS}?days=30`).then(r => r.json())
    ]);

    if (!ev.ok) throw new Error("events failed");
    if (!st.ok) throw new Error("stats failed");

    // KPIs
    kpiActive.textContent = st.active_count ?? "—";
    kpiClosed.textContent = st.closed_count ?? "—";

    // top city
    if (st.top_city?.city) topCityEl.textContent = `${st.top_city.cnt}×  ${st.top_city.city}`;
    else topCityEl.textContent = "—";

    // lists
    renderTopCities(st.top_cities);
    renderLongest(st.longest);

    // chart
    renderChartByDay(st.by_day);

    // table
    renderTable(ev.items);

    // map
    cluster.clearLayers();
    const withGeo = ev.items.filter(x => isFinite(x.lat) && isFinite(x.lon));
    withGeo.forEach(e => cluster.addLayer(makeMarker(e)));

    setStatus(true, `OK • ${ev.items.length} záznamů (${withGeo.length} na mapě)`);

  }catch(err){
    console.error(err);
    setStatus(false, "chyba načtení");
  }
}

// ---------- Filters ----------
document.querySelectorAll(".chip[data-kind]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chip[data-kind]").forEach(b => b.classList.remove("chipOn"));
    btn.classList.add("chipOn");
    currentKind = btn.dataset.kind;
    loadAll();
  });
});

document.querySelectorAll(".chip[data-active]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chip[data-active]").forEach(b => b.classList.remove("chipOn"));
    btn.classList.add("chipOn");
    currentActive = btn.dataset.active;
    loadAll();
  });
});

btnRefresh.addEventListener("click", loadAll);
btnPrint.addEventListener("click", () => window.print());

window.addEventListener("resize", () => {
  // přerender tabulky při změně breakpointu
  loadAll();
});

loadAll();
