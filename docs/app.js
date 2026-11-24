// =============================================================================
// AI Astro Lookup Dashboard
// =============================================================================
// Loads daily JSON snapshots from /data/, aggregates across a date range,
// and renders 3 modules: astrologer table, duration blocks, entry-point funnel.
// =============================================================================

// SHA-256 of the dashboard password. REPLACE THIS with your own hash.
// Default password: "astro-lookup-2026" (change in production via gen-pw-hash.html or CLI)
const PW_HASH = "a046d5f2b5191ab02a4715f9f1aabecc76d3de54df09a852621605b075165218";

// Entry-point metadata for Module 3
const ENTRY_POINTS = {
  M:  { title: "Menu Bar",                    note: "utm_medium=menu_screen_item" },
  B:  { title: "Bottom Navigation",           note: "utm_medium=bottom_bar" },
  N:  { title: "Notification (App Push)",     note: "utm_medium=au_app + utm_source like %notification%" },
  Bn: { title: "Banner (Story+Listing)",      note: "flag_key=top_banner_listing, V1_7 — ⚠️ over-counts", warn: true },
};

// Funnel step definitions — LI vs NLI
const LI_STEPS = [
  ["Entry",              "s1_{entry}"],
  ["Listing view",       "s2_listing_view"],
  ["Call click",         "s3_call_click"],
  ["Chat click",         "s3_chat_click"],
  ["Call connected",     "s4_call_connected"],
  ["Chat connected",     "s4_chat_connected"],
  ["Call completed",     "s5_call_completed"],
  ["Chat completed",     "s5_chat_completed"],
];
const NLI_STEPS = [
  ["Entry",              "s1_{entry}"],
  ["Listing view",       "s2_listing_view"],
  ["Call click",         "s3_call_click"],
  ["Chat click",         "s3_chat_click"],
  ["Login screen view",  "s4_login_screen_view"],
  ["Login success (OTP)", "s5_login_success"],
  ["Call connected",     "s6_call_connected"],
  ["Chat connected",     "s6_chat_connected"],
  ["Call completed",     "s7_call_completed"],
  ["Chat completed",     "s7_chat_completed"],
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

function renderStep(label, value, maxValue, prevValue, totalEntry, cohortClass) {
  const pctOfEntry = totalEntry > 0 ? Math.round((value / totalEntry) * 1000) / 10 : 0;
  const pctOfPrev = prevValue > 0 ? Math.round((value / prevValue) * 1000) / 10 : null;
  const barPct = maxValue > 0 ? Math.min(100, (value / maxValue) * 100) : 0;
  const conv = pctOfPrev != null ? ` · ${pctOfPrev}% from prev` : "";
  return `
    <div class="step">
      <div class="step-label">${label}</div>
      <div class="step-value">${fmt(value)}</div>
      <div class="step-bar"><div class="step-bar-fill" style="width:${barPct}%"></div></div>
      <div class="step-conv" style="grid-column:1 / -1">${pctOfEntry}% of entry${conv}</div>
    </div>
  `;
}

function renderFunnel(cohort, data, epKey, cls) {
  if (!data) return `<div class="empty-msg">No ${cls.toUpperCase()} data</div>`;
  const steps = cls === "li" ? LI_STEPS : NLI_STEPS;
  const entryCol = steps[0][1].replace("{entry}", ENTRY_KEYS[epKey]);
  const totalEntry = data[entryCol] || 0;
  const maxVal = Math.max(...steps.map(([, col]) => data[col.replace("{entry}", ENTRY_KEYS[epKey])] || 0)) || 1;

  let html = `<p class="funnel-title ${cls}">${cls === "li" ? "Logged-in cohort" : "Non-logged-in cohort"}</p>`;
  let prev = null;
  for (const [label, colTemplate] of steps) {
    const col = colTemplate.replace("{entry}", ENTRY_KEYS[epKey]);
    const v = data[col] || 0;
    html += renderStep(label, v, maxVal, prev, totalEntry, cls);
    prev = v;
  }
  if (totalEntry === 0) html += `<p class="funnel-note">No entries in this range.</p>`;
  return html;
}

function renderEntryPoints(agg) {
  const area = document.getElementById("funnel-area");
  if (state.selectedEps.size === 0) {
    area.innerHTML = `<p class="empty-msg">Select at least one entry point above.</p>`;
    return;
  }

  area.innerHTML = Array.from(state.selectedEps).map(ep => {
    const meta = ENTRY_POINTS[ep];
    const li = agg.pinot[`ep_${ep}_li`];
    const nli = agg.pinot[`ep_${ep}_nli`];
    const idData = agg.pinot[`ep_${ep}_id`];
    const idStr = idData ? `${fmt(idData.unique_users)} unique entries` : "no identification data";

    return `
      <div class="ep-card${meta.warn ? " warn" : ""}">
        <h3>${meta.title}</h3>
        <p class="ep-meta">${idStr} · ${escapeHtml(meta.note)}</p>
        ${meta.warn ? `<p class="ep-warning">⚠️ V1_7 flag attributes every event from a variant-user to the banner. Numbers are directional, not exact.</p>` : ""}
        <div class="funnel-grid">
          <div class="funnel">${renderFunnel("li", li, ep, "li")}</div>
          <div class="funnel">${renderFunnel("nli", nli, ep, "nli")}</div>
        </div>
      </div>
    `;
  }).join("");
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
