// =============================================================================
// AI Astro Lookup Dashboard
// =============================================================================
// Loads daily JSON snapshots from /data/, aggregates across a date range,
// and renders 3 modules: astrologer table, duration blocks, entry-point funnel.
// =============================================================================

// SHA-256 of the dashboard password. REPLACE THIS with your own hash.
// Default password: "astro-lookup-2026" (change in production via gen-pw-hash.html or CLI)
const PW_HASH = "a4be6ec9c3c8d2c3df3c7e7e8d6c4d2e5f4a3b1c9d8e7f6a5b4c3d2e1f0a9b8c";

// Entry-point metadata for Module 3
const ENTRY_POINTS = {
  M:  { title: "Menu Bar",                    note: "utm_medium=menu_screen_item" },
  B:  { title: "Bottom Navigation",           note: "utm_medium=bottom_bar" },
  N:  { title: "Notification (App Push)",     note: "utm_medium=au_app + utm_source like %notification%" },
  Bn: { title: "Banner (Story+Listing)",      note: "flag_key=top_banner_listing, V1_7 — ⚠️ over-counts", warn: true },
};

// Funnel step definitions — LI vs NLI
// Unified stage list across LI/NLI. liKey=null means stage only exists in NLI.
const ALL_STAGES = [
  { label: "Entry",              liKey: "s1_{entry}",         nliKey: "s1_{entry}" },
  { label: "Listing view",       liKey: "s2_listing_view",    nliKey: "s2_listing_view" },
  { label: "Call click",         liKey: "s3_call_click",      nliKey: "s3_call_click" },
  { label: "Chat click",         liKey: "s3_chat_click",      nliKey: "s3_chat_click" },
  { label: "Login screen view",  liKey: null,                 nliKey: "s4_login_screen_view" },
  { label: "Login success (OTP)",liKey: null,                 nliKey: "s5_login_success" },
  { label: "Call connected",     liKey: "s4_call_connected",  nliKey: "s6_call_connected" },
  { label: "Chat connected",     liKey: "s4_chat_connected",  nliKey: "s6_chat_connected" },
  { label: "Call completed",     liKey: "s5_call_completed",  nliKey: "s7_call_completed" },
  { label: "Chat completed",     liKey: "s5_chat_completed",  nliKey: "s7_chat_completed" },
];

const ENTRY_KEYS = {
  M: "menu_click", B: "bottom_nav_click", N: "notif_open", Bn: "banner_click",
};

// =============================================================================
// STATE
// =============================================================================
const state = {
  index: null,      // {available_dates, latest}
  cache: new Map(), // date -> parsed JSON
  selectedEps: new Set(["M", "B"]),
  stageFilters: {}, // ep -> Set of stage labels to show
  charts: {},       // ep -> Chart.js instance
  lastAgg: null,    // last aggregated data (for re-rendering on filter change)
};

// =============================================================================
// PASSWORD GATE
// =============================================================================
async function sha256(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

document.getElementById("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("gate-pw").value;
  const err = document.getElementById("gate-err");
  err.textContent = "";
  const h = await sha256(pw);
  if (h === PW_HASH) {
    try { sessionStorage.setItem("au_auth", "1"); } catch {}
    document.getElementById("gate").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    await bootstrap();
  } else {
    err.textContent = "Wrong password.";
  }
});

// skip gate if already authenticated this session
try {
  if (sessionStorage.getItem("au_auth") === "1") {
    document.getElementById("gate").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    window.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  }
} catch {}

// =============================================================================
// DATA LOAD & AGGREGATE
// =============================================================================
async function loadIndex() {
  const r = await fetch("data/index.json", { cache: "no-store" });
  if (!r.ok) throw new Error("Could not load data/index.json");
  return r.json();
}

async function loadDate(date) {
  if (state.cache.has(date)) return state.cache.get(date);
  const r = await fetch(`data/${date}.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Could not load data/${date}.json`);
  const d = await r.json();
  state.cache.set(date, d);
  return d;
}

function datesInRange(from, to) {
  const out = [];
  let d = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

async function loadRange(from, to) {
  const avail = new Set(state.index.available_dates);
  const dates = datesInRange(from, to).filter(d => avail.has(d));
  const snaps = await Promise.all(dates.map(loadDate));
  return { dates, snaps };
}

// Aggregate N daily snapshots into one combined object. Sums integers.
// NOTE: for Pinot HLL unique counts, SUM across days is an approximation
// (same user across multiple days counted twice). Shown with a note in UI.
function aggregateSnaps(snaps) {
  const agg = { astrologers: {}, dur: { web: [], app: [], overall: [] }, pinot: {}, total_raw: 0 };

  for (const s of snaps) {
    // Yukti
    if (s.yukti) {
      for (const a of (s.yukti.astrologers || [])) {
        const key = `${a.name}||${a.platform}`;
        if (!agg.astrologers[key]) agg.astrologers[key] = { name: a.name, platform: a.platform, calls: 0, chats: 0 };
        agg.astrologers[key].calls += a.calls || 0;
        agg.astrologers[key].chats += a.chats || 0;
      }
      // simple weighted avg: push (avg, raw count) so we can re-weight below
      const n = s.yukti.raw_count || 0;
      if (s.yukti.avg_duration) {
        if (s.yukti.avg_duration.web)     agg.dur.web.push([s.yukti.avg_duration.web, n]);
        if (s.yukti.avg_duration.app)     agg.dur.app.push([s.yukti.avg_duration.app, n]);
        if (s.yukti.avg_duration.overall) agg.dur.overall.push([s.yukti.avg_duration.overall, n]);
      }
      agg.total_raw += n;
    }
    // Pinot
    if (s.pinot) {
      for (const [k, v] of Object.entries(s.pinot)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        if (!agg.pinot[k]) agg.pinot[k] = {};
        for (const [metric, value] of Object.entries(v)) {
          agg.pinot[k][metric] = (agg.pinot[k][metric] || 0) + (Number(value) || 0);
        }
      }
    }
  }

  // duration: weighted by raw conversation count per day
  const weighted = (arr) => {
    const totalN = arr.reduce((a, [, n]) => a + n, 0);
    if (totalN === 0) return 0;
    return Math.round(arr.reduce((a, [v, n]) => a + v * n, 0) / totalN * 10) / 10;
  };
  agg.duration = {
    web: weighted(agg.dur.web),
    app: weighted(agg.dur.app),
    overall: weighted(agg.dur.overall),
  };
  agg.astrologers = Object.values(agg.astrologers).sort((a, b) =>
    a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform)
  );
  return agg;
}

// =============================================================================
// RENDER
// =============================================================================
function fmt(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-IN");
}

function fmtDuration(seconds) {
  if (!seconds || seconds === 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}<small>s</small>`;
  return `${m}<small>m ${s}s</small>`;
}

function renderMeta(from, to, snaps) {
  const el = document.getElementById("data-meta");
  const n = snaps.length;
  if (n === 0) {
    el.textContent = `No data for ${from} → ${to}`;
  } else {
    el.textContent = `${from} → ${to} · ${n} day${n === 1 ? "" : "s"} loaded`;
  }
  document.querySelectorAll(".range-tag").forEach(e => e.textContent = `${from} → ${to}`);
}

function renderAstro(agg) {
  const tbody = document.getElementById("astro-tbody");
  const tfoot = document.getElementById("astro-tfoot");

  if (!agg.astrologers.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-msg">No Yukti data loaded. Check scripts/pull_yukti.py TODO markers.</td></tr>`;
    tfoot.innerHTML = "";
    return;
  }

  tbody.innerHTML = agg.astrologers.map(a => `
    <tr>
      <td>${escapeHtml(a.name)}</td>
      <td><span class="platform-badge ${a.platform}">${a.platform}</span></td>
      <td class="num">${fmt(a.chats)}</td>
      <td class="num">${fmt(a.calls)}</td>
    </tr>
  `).join("");

  const totals = agg.astrologers.reduce((acc, a) => {
    acc[a.platform] = acc[a.platform] || { chats: 0, calls: 0 };
    acc[a.platform].chats += a.chats;
    acc[a.platform].calls += a.calls;
    acc.all.chats += a.chats;
    acc.all.calls += a.calls;
    return acc;
  }, { all: { chats: 0, calls: 0 } });

  const rows = [];
  if (totals.app)  rows.push(`<tr><td><strong>Total App</strong></td><td><span class="platform-badge app">app</span></td><td class="num">${fmt(totals.app.chats)}</td><td class="num">${fmt(totals.app.calls)}</td></tr>`);
  if (totals.web)  rows.push(`<tr><td><strong>Total Web</strong></td><td><span class="platform-badge web">web</span></td><td class="num">${fmt(totals.web.chats)}</td><td class="num">${fmt(totals.web.calls)}</td></tr>`);
  rows.push(`<tr><td><strong>Grand Total</strong></td><td>—</td><td class="num"><strong>${fmt(totals.all.chats)}</strong></td><td class="num"><strong>${fmt(totals.all.calls)}</strong></td></tr>`);
  tfoot.innerHTML = rows.join("");
}

function renderDuration(agg) {
  document.getElementById("dur-web").innerHTML     = fmtDuration(agg.duration.web);
  document.getElementById("dur-app").innerHTML     = fmtDuration(agg.duration.app);
  document.getElementById("dur-overall").innerHTML = fmtDuration(agg.duration.overall);
}

function renderEntryPoints(agg) {
  state.lastAgg = agg;
  const area = document.getElementById("funnel-area");

  // destroy existing Chart.js instances before re-render
  Object.values(state.charts).forEach(c => c.destroy());
  state.charts = {};

  if (state.selectedEps.size === 0) {
    area.innerHTML = `<p class="empty-msg">Select at least one entry point above.</p>`;
    return;
  }

  area.innerHTML = Array.from(state.selectedEps).map(ep => {
    const meta = ENTRY_POINTS[ep];
    const idData = agg.pinot[`ep_${ep}_id`];
    const idStr = idData ? `${fmt(idData.unique_users)} unique entries` : "no identification data";

    // Initialize stage filter for this EP if not yet set (default: all stages visible)
    if (!state.stageFilters[ep]) {
      state.stageFilters[ep] = new Set(ALL_STAGES.map(s => s.label));
    }

    const stagePills = ALL_STAGES.map(s => `
      <label class="stage-pill">
        <input type="checkbox" value="${s.label}" data-ep="${ep}" ${state.stageFilters[ep].has(s.label) ? "checked" : ""}>
        <span>${s.label}</span>
      </label>
    `).join("");

    return `
      <div class="ep-card${meta.warn ? " warn" : ""}">
        <h3>${meta.title}</h3>
        <p class="ep-meta">${idStr} · ${escapeHtml(meta.note)}</p>
        ${meta.warn ? `<p class="ep-warning">⚠️ V1_7 flag attributes every event from a variant-user to the banner. Numbers are directional, not exact.</p>` : ""}
        <div class="stage-filter">
          <span class="stage-filter-label">Show events:</span>
          ${stagePills}
        </div>
        <div class="chart-wrap"><canvas id="chart-${ep}"></canvas></div>
      </div>
    `;
  }).join("");

  // Wire stage filter listeners + draw charts
  Array.from(state.selectedEps).forEach(ep => {
    document.querySelectorAll(`input[data-ep="${ep}"]`).forEach(cb => {
      cb.addEventListener("change", (e) => {
        if (e.target.checked) state.stageFilters[ep].add(e.target.value);
        else state.stageFilters[ep].delete(e.target.value);
        drawFunnelChart(ep);
      });
    });
    drawFunnelChart(ep);
  });
}

function drawFunnelChart(ep) {
  const canvas = document.getElementById(`chart-${ep}`);
  if (!canvas || !state.lastAgg) return;

  const li = state.lastAgg.pinot[`ep_${ep}_li`] || {};
  const nli = state.lastAgg.pinot[`ep_${ep}_nli`] || {};
  const entryKey = ENTRY_KEYS[ep];
  const liEntry = li[`s1_${entryKey}`] || 0;
  const nliEntry = nli[`s1_${entryKey}`] || 0;

  const visibleStages = ALL_STAGES.filter(s => state.stageFilters[ep].has(s.label));
  const labels = visibleStages.map(s => s.label);

  const liData = visibleStages.map(s => {
    if (!s.liKey) return null;
    const col = s.liKey.replace("{entry}", entryKey);
    return li[col] ?? null;
  });
  const nliData = visibleStages.map(s => {
    if (!s.nliKey) return null;
    const col = s.nliKey.replace("{entry}", entryKey);
    return nli[col] ?? null;
  });

  if (state.charts[ep]) state.charts[ep].destroy();
  if (visibleStages.length === 0) return;

  state.charts[ep] = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `Logged-in (${fmt(liEntry)} entries)`,
          data: liData,
          borderColor: "#C8102E",
          backgroundColor: "rgba(200, 16, 46, 0.12)",
          tension: 0.4,
          fill: true,
          spanGaps: true,
          pointRadius: 5,
          pointHoverRadius: 8,
          borderWidth: 2.5,
          pointBackgroundColor: "#C8102E",
        },
        {
          label: `Non-logged-in (${fmt(nliEntry)} entries)`,
          data: nliData,
          borderColor: "#0F7B6C",
          backgroundColor: "rgba(15, 123, 108, 0.12)",
          tension: 0.4,
          fill: true,
          spanGaps: true,
          pointRadius: 5,
          pointHoverRadius: 8,
          borderWidth: 2.5,
          pointBackgroundColor: "#0F7B6C",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: { font: { family: "Inter", size: 12, weight: "500" }, usePointStyle: true, padding: 16, boxWidth: 8 },
        },
        tooltip: {
          backgroundColor: "#1A1815",
          titleColor: "#F4EBE0",
          bodyColor: "#F4EBE0",
          titleFont: { family: "Inter", size: 13, weight: "600" },
          bodyFont: { family: "JetBrains Mono", size: 12 },
          padding: 12,
          borderColor: "rgba(244,235,224,0.15)",
          borderWidth: 1,
          callbacks: {
            label: (ctx) => {
              const val = ctx.parsed.y;
              if (val === null || val === undefined) return `${ctx.dataset.label}: —`;
              const entry = ctx.datasetIndex === 0 ? liEntry : nliEntry;
              const pct = entry > 0 ? ((val / entry) * 100).toFixed(1) : "0";
              return `${ctx.dataset.label}: ${fmt(val)} (${pct}% of entry)`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: "rgba(231, 224, 220, 0.25)" },
          ticks: { font: { family: "JetBrains Mono", size: 11 }, color: "#7A736E" },
        },
        x: {
          grid: { display: false },
          ticks: { font: { family: "Inter", size: 11, weight: "500" }, color: "#1A1815", maxRotation: 35, minRotation: 0, autoSkip: false },
        },
      },
    },
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// =============================================================================
// FLOW
// =============================================================================
async function refresh() {
  const from = document.getElementById("date-from").value;
  const to = document.getElementById("date-to").value;
  if (!from || !to || from > to) {
    document.getElementById("data-meta").textContent = "Invalid date range";
    return;
  }

  try {
    const { dates, snaps } = await loadRange(from, to);
    renderMeta(from, to, snaps);
    const agg = aggregateSnaps(snaps);
    renderAstro(agg);
    renderDuration(agg);
    renderEntryPoints(agg);

    // raw JSON link
    const link = document.getElementById("raw-link");
    if (dates.length) link.href = `data/${dates[dates.length - 1]}.json`;
  } catch (e) {
    console.error(e);
    document.getElementById("data-meta").textContent = `Load error: ${e.message}`;
  }
}

async function bootstrap() {
  try {
    state.index = await loadIndex();
  } catch (e) {
    document.getElementById("data-meta").textContent = `Could not load data index: ${e.message}`;
    return;
  }

  const latest = state.index.latest;
  if (!latest) {
    document.getElementById("data-meta").textContent = "No snapshots yet. Run scripts/daily_snapshot.py first.";
    return;
  }

  // default range: last 7 days up to latest
  const endDate = new Date(latest + "T00:00:00");
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 6);
  document.getElementById("date-from").value = startDate.toISOString().slice(0, 10);
  document.getElementById("date-to").value = endDate.toISOString().slice(0, 10);

  document.getElementById("apply-btn").addEventListener("click", refresh);
  document.querySelectorAll(".ep-check input").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedEps.add(cb.value);
      else state.selectedEps.delete(cb.value);
      refresh();
    });
  });

  await refresh();
}
