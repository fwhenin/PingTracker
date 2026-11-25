import { Chart, registerables } from "chart.js";
import "chartjs-adapter-date-fns";
import { api, onEvent } from "./api.js";

Chart.register(...registerables);

const $ = (sel) => document.querySelector(sel);
const state = {
  settings: null,
  status: null,
  interfaces: [],
  rangeMs: 86_400_000,
  charts: {},
  clearArmed: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Color follows the target (its position in the settings list), never its rank. */
function colorFor(targetId) {
  const ids = state.settings?.targets.map((t) => t.id) ?? [];
  let idx = ids.indexOf(targetId);
  if (idx < 0) idx = ids.length + (hash(targetId) % 3);
  return css(`--s${(idx % 8) + 1}`);
}
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

const fmtMs = (v) => (v == null ? "–" : v < 10 ? `${v.toFixed(1)}` : `${Math.round(v)}`);
const fmtMsUnit = (v) => (v == null ? "–" : `${fmtMs(v)} ms`);
const fmtPct = (v) => (v == null ? "–" : v === 0 ? "0%" : v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);

function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function intervalLabel(m) {
  return m === 1 ? "1 min" : m === 60 ? "1 hour" : `${m} min`;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.setAttribute("style", v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function levelFor(r) {
  if (!r) return "idle";
  if (r.received === 0) return "bad";
  const slow = state.settings?.slow_threshold_ms ?? 100;
  if (r.loss > 0 || (r.avg_ms ?? 0) > slow) return "warn";
  return "good";
}

// ---------------------------------------------------------------------------
// Header status
// ---------------------------------------------------------------------------

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const dot = $("#status-dot");
  const latest = s.latest ?? [];
  let level = "idle";
  if (s.running) level = "running";
  else if (!s.paused && latest.length) {
    const levels = latest.map(levelFor);
    level = levels.includes("bad") ? "bad" : levels.includes("warn") ? "warn" : "good";
  }
  dot.className = `dot ${level}`;

  let text;
  if (s.running) text = "Testing…";
  else if (s.paused) text = "Paused";
  else text = `Testing every ${intervalLabel(s.interval_minutes)}`;
  $("#status-text").textContent = text;
  $("#btn-run").disabled = !!s.running;
  $("#btn-pause").textContent = s.paused ? "Resume" : "Pause";
  renderCountdown();
  $("#total-count").textContent = `${s.total_results.toLocaleString()} tests stored`;
}

function renderCountdown() {
  const s = state.status;
  const box = $("#countdown");
  box.classList.toggle("running", !!s.running);
  box.classList.toggle("paused", !!s.paused && !s.running);
  const fill = $("#cd-fill");
  if (s.running) {
    $("#cd-label").textContent = "Running test";
    $("#cd-time").textContent = "now";
    return;
  }
  if (s.paused || !s.next_run_ts) {
    $("#cd-label").textContent = s.paused ? "Tests paused" : "Next test";
    $("#cd-time").textContent = "–:–";
    fill.style.width = "0";
    return;
  }
  const remaining = Math.max(0, s.next_run_ts - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), sec = secs % 60;
  $("#cd-label").textContent = "Next test in";
  $("#cd-time").textContent = h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  const total = s.last_run_ts ? s.next_run_ts - s.last_run_ts : s.interval_minutes * 60_000;
  const frac = total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0;
  fill.style.width = `${(frac * 100).toFixed(1)}%`;
}

async function refreshStatus() {
  state.status = await api.get_status();
  renderStatus();
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function baseChartOptions() {
  const text2 = css("--text-2");
  const grid = css("--grid");
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "top",
        align: "end",
        labels: { color: css("--text"), boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded" },
      },
      tooltip: {
        backgroundColor: css("--surface"),
        titleColor: css("--text"),
        bodyColor: css("--text"),
        borderColor: css("--border"),
        borderWidth: 1,
        padding: 10,
        boxPadding: 4,
        usePointStyle: true,
      },
    },
    scales: {
      x: {
        type: "time",
        min: Date.now() - state.rangeMs,
        max: Date.now(),
        grid: { display: false },
        border: { color: grid },
        ticks: { color: text2, maxRotation: 0, autoSkipPadding: 18 },
        time: { tooltipFormat: "MMM d, HH:mm", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d" } },
      },
      y: {
        beginAtZero: true,
        grid: { color: grid },
        border: { display: false },
        ticks: { color: text2, maxTicksLimit: 6 },
      },
    },
  };
}

function labelFor(targetId, summaries) {
  return (
    state.settings.targets.find((t) => t.id === targetId)?.label ??
    summaries.find((s) => s.target_id === targetId)?.target_label ??
    targetId
  );
}

function renderCharts(series, summaries) {
  const byTarget = new Map();
  for (const p of series.points) {
    if (!byTarget.has(p.target_id)) byTarget.set(p.target_id, []);
    byTarget.get(p.target_id).push(p);
  }
  const order = state.settings.targets.map((t) => t.id);
  const ids = [...byTarget.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const gapMs = Math.max(series.bucket_ms, state.settings.interval_minutes * 60_000) * 2.5;

  // Latency: one line per target; a failed test or a long gap breaks the line.
  const latency = ids.map((id) => {
    const color = colorFor(id);
    const pts = [];
    let prev = null;
    for (const p of byTarget.get(id)) {
      if (prev && p.ts - prev > gapMs) pts.push({ x: prev + 1, y: null });
      pts.push({ x: p.ts, y: p.avg_ms, min: p.min_ms, max: p.max_ms, loss: p.loss, tests: p.tests });
      prev = p.ts;
    }
    return {
      label: labelFor(id, summaries),
      data: pts,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: pts.length < 60 ? 2.5 : 0,
      pointHoverRadius: 5,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: css("--surface"),
      tension: 0.25,
      spanGaps: false,
    };
  });

  const loss = ids.map((id) => {
    const color = colorFor(id);
    return {
      label: labelFor(id, summaries),
      data: byTarget.get(id).map((p) => ({ x: p.ts, y: p.loss, tests: p.tests })),
      backgroundColor: color,
      borderRadius: { topLeft: 2, topRight: 2 },
      borderSkipped: "bottom",
      barThickness: 4,
      grouped: false,
    };
  });

  const hasData = ids.length > 0;
  $("#empty-latency").hidden = hasData;
  $("#empty-loss").hidden = hasData;
  $("#chart-latency").parentElement.hidden = !hasData;
  $("#chart-loss").parentElement.hidden = !hasData;

  const latOpts = baseChartOptions();
  latOpts.scales.y.title = { display: false };
  latOpts.scales.y.ticks.callback = (v) => `${v} ms`;
  latOpts.plugins.tooltip.callbacks = {
    label: (ctx) => {
      const r = ctx.raw;
      if (r.y == null) return null;
      let s = ` ${ctx.dataset.label}: ${fmtMsUnit(r.y)}`;
      if (r.min != null && r.max != null && r.min !== r.max) s += `  (${fmtMs(r.min)}–${fmtMs(r.max)})`;
      if (r.loss > 0) s += `  · ${fmtPct(r.loss)} loss`;
      return s;
    },
  };

  const lossOpts = baseChartOptions();
  lossOpts.scales.y.suggestedMax = 10;
  lossOpts.scales.y.ticks.callback = (v) => `${v}%`;
  lossOpts.scales.x.offset = false;
  lossOpts.scales.y.ticks.precision = 0;
  lossOpts.plugins.legend.display = ids.length > 1;
  lossOpts.plugins.tooltip.callbacks = {
    label: (ctx) => ` ${ctx.dataset.label}: ${fmtPct(ctx.raw.y)} loss`,
  };

  upsertChart("latency", "line", latency, latOpts);
  upsertChart("loss", "bar", loss, lossOpts);
}

function upsertChart(key, type, datasets, options) {
  const existing = state.charts[key];
  if (existing) {
    existing.data.datasets = datasets;
    existing.options = options;
    existing.update("none");
    return;
  }
  const canvas = $(`#chart-${key}`);
  state.charts[key] = new Chart(canvas, { type, data: { datasets }, options });
}

function renderCards(summaries, freshTargets = new Set()) {
  const box = $("#cards");
  box.replaceChildren();
  const enabled = state.settings.targets.filter((t) => t.enabled);
  const ids = [...new Set([...enabled.map((t) => t.id), ...summaries.map((s) => s.target_id)])];
  if (!ids.length) {
    box.append(el("div", { class: "card" }, el("div", { class: "hint" }, "No targets enabled. Pick some in Settings.")));
    return;
  }
  for (const id of ids) {
    const sum = summaries.find((s) => s.target_id === id);
    const target = state.settings.targets.find((t) => t.id === id);
    const last = sum?.last ?? state.status?.latest?.find((r) => r.target_id === id);
    const level = levelFor(last);
    const stateText = !last
      ? "Waiting for first test"
      : last.received === 0
        ? last.error || "No reply"
        : level === "warn"
          ? last.loss > 0 ? `${fmtPct(last.loss)} packet loss` : "Slow"
          : "OK";
    const host = last?.host || target?.host || "";
    box.append(
      el(
        "div",
        { class: freshTargets.has(id) ? "card fresh" : "card" },
        el(
          "div",
          { class: "card-head" },
          el("span", { class: "swatch", style: `background:${colorFor(id)}` }),
          el("span", { class: "card-title" }, target?.label ?? sum?.target_label ?? id),
          el("span", { class: "host" }, host),
        ),
        el(
          "div",
          { class: "card-value" },
          last?.avg_ms != null ? fmtMs(last.avg_ms) : "–",
          el("small", {}, last?.avg_ms != null ? "ms" : ""),
        ),
        el(
          "div",
          { class: "card-state" },
          el("span", { class: `dot ${level}` }),
          el("span", {}, last ? `${stateText} · ${fmtTime(last.ts)}` : stateText),
        ),
        el(
          "div",
          { class: "card-stats" },
          el("div", {}, "Average", el("b", {}, fmtMsUnit(sum?.avg_ms))),
          el("div", {}, "95th pct", el("b", {}, fmtMsUnit(sum?.p95_ms))),
          el("div", {}, "Jitter", el("b", {}, fmtMsUnit(sum?.jitter_ms))),
          el("div", {}, "Loss", el("b", {}, sum ? fmtPct(sum.loss) : "–")),
        ),
      ),
    );
  }
}

function renderRecent(rows, freshIds = new Set()) {
  const body = $("#recent");
  body.replaceChildren();
  if (!rows.length) {
    body.append(el("tr", {}, el("td", { colspan: 7, class: "note" }, "No tests yet.")));
    return;
  }
  for (const r of rows) {
    const level = levelFor(r);
    body.append(
      el(
        "tr",
        { class: freshIds.has(r.id) ? "fresh" : "" },
        el("td", {}, fmtTime(r.ts)),
        el("td", {}, el("span", { class: "target" }, el("span", { class: "swatch", style: `background:${colorFor(r.target_id)}` }), r.target_label)),
        el("td", { class: `num ${level === "warn" && r.received ? "warn-text" : ""}` }, fmtMsUnit(r.avg_ms)),
        el("td", { class: "num" }, r.min_ms != null ? `${fmtMs(r.min_ms)} / ${fmtMs(r.max_ms)}` : "–"),
        el("td", { class: "num" }, fmtMsUnit(r.jitter_ms)),
        el("td", { class: `num ${r.loss > 0 ? (r.received ? "warn-text" : "bad-text") : ""}` }, fmtPct(r.loss)),
        el("td", { class: "note" }, [r.error, r.host && r.ip && r.host !== r.ip ? `${r.host} (${r.ip})` : r.host, r.interface ? `via ${r.interface}` : null].filter(Boolean).join(" · ")),
      ),
    );
  }
}

async function refreshDashboard(freshResults = []) {
  const freshIds = new Set(freshResults.map((r) => r.id));
  const freshTargets = new Set(freshResults.map((r) => r.target_id));
  const to = Date.now();
  const from = to - state.rangeMs;
  const [series, summaries, recent] = await Promise.all([
    api.get_series({ from, to, maxPoints: 400 }),
    api.get_summary({ from, to }),
    api.get_recent({ limit: 15 }),
  ]);
  renderCards(summaries, freshTargets);
  renderCharts(series, summaries);
  renderRecent(recent, freshIds);
  const tests = summaries.reduce((a, s) => a + s.tests, 0);
  $("#range-note").textContent = tests ? `${tests.toLocaleString()} tests in range` : "";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function save(patch, message = "Settings saved") {
  try {
    state.settings = await api.save_settings({ settings: { ...state.settings, ...patch } });
    renderSettings();
    toast(message);
    await Promise.all([refreshStatus(), refreshDashboard()]);
  } catch (e) {
    toast(String(e));
    renderSettings();
  }
}

async function renderSettings() {
  const s = state.settings;
  // Interval choices
  const iv = $("#interval");
  iv.replaceChildren(
    ...(state.status?.interval_choices ?? [1, 2, 5, 10, 15, 30, 60]).map((m) =>
      el(
        "button",
        { class: m === s.interval_minutes ? "on" : "", role: "radio", "aria-checked": String(m === s.interval_minutes), onclick: () => save({ interval_minutes: m }, `Testing every ${intervalLabel(m)}`) },
        intervalLabel(m),
      ),
    ),
  );

  // Targets
  const list = $("#targets");
  list.replaceChildren();
  const gw = isWeb() ? null : await api.default_gateway({ interface: s.interface }).catch(() => null);
  s.targets.forEach((t, i) => {
    const hostText = t.kind === "gateway" ? (gw ? `${gw} (detected)` : "Not detected") : t.host;
    list.append(
      el(
        "li",
        {},
        el("input", {
          type: "checkbox",
          checked: t.enabled,
          "aria-label": `Enable ${t.label}`,
          onchange: (e) => {
            const targets = s.targets.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x));
            save({ targets }, e.target.checked ? `${t.label} enabled` : `${t.label} disabled`);
          },
        }),
        el("span", { class: "swatch", style: `background:${colorFor(t.id)}` }),
        el("span", { class: "t-label" }, t.label),
        el("span", { class: "t-host" }, hostText),
        t.builtin
          ? null
          : el("button", { class: "remove", onclick: () => save({ targets: s.targets.filter((_, j) => j !== i) }, `${t.label} removed`) }, "Remove"),
      ),
    );
  });

  // Interfaces
  const sel = $("#interface");
  sel.replaceChildren(el("option", { value: "" }, "Automatic (system default route)"));
  for (const i of state.interfaces) {
    sel.append(el("option", { value: i.id }, `${i.label}${i.label !== i.id ? ` (${i.id})` : ""} · ${i.ipv4.join(", ")}${i.is_default ? " · default" : ""}`));
  }
  if (s.interface && !state.interfaces.some((i) => i.id === s.interface)) {
    sel.append(el("option", { value: s.interface }, `${s.interface} (not connected)`));
  }
  sel.value = s.interface ?? "";
  const cur = state.interfaces.find((i) => i.id === s.interface);
  $("#interface-hint").textContent = s.interface
    ? cur ? `Pings are sent from ${cur.ipv4[0]}${cur.gateway ? `, router ${cur.gateway}` : ""}.` : "This interface is not connected right now, so tests will fail."
    : "Pings use whichever interface the operating system routes through.";

  $("#pings").value = String(s.pings_per_test);
  $("#timeout").value = String(s.timeout_ms);
  $("#slow").value = String(s.slow_threshold_ms);
  $("#retention").value = String(s.retention_days);
  $("#login").checked = s.launch_at_login;
  $("#menubar").checked = s.show_latency_in_menu_bar;
  $("#menubar-row").hidden = state.status?.platform !== "macos";
  $("#data-dir").textContent = state.status?.data_dir ? `History is stored locally in ${state.status.data_dir}` : "";
  if (isWeb()) applyWebSettings(s);
}

const isWeb = () => state.status?.platform === "web";

/** The browser version has no interfaces, router, login item or menu bar. */
function applyWebSettings(s) {
  $("#interface-field").hidden = true;
  $("#network-title").textContent = "Measurement";
  $("label[for=pings]").textContent = "Requests per test";
  $("#login-row").hidden = true;
  $("#menubar-row").hidden = true;
  $("#awake-row").hidden = !state.status?.features?.wake_lock;
  $("#keep-awake").checked = !!s.keep_awake;
  $("#targets-hint").textContent =
    "Each enabled target is tested every run by timing small HTTPS requests to it. Add any website (https only).";
  $("#new-host").placeholder = "Web address, e.g. example.com";
  $("#data-dir").textContent =
    "History is stored only in this browser on this device. Clearing browsing data deletes it, so export a CSV now and then if you want to keep it.";
}

function setupWeb() {
  document.documentElement.classList.add("web");
  $("#btn-about").hidden = false;
  $("#loss-hint").textContent = "Share of requests that got no answer, in percent";
  const dlg = $("#about");
  const open = () => (dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", ""));
  $("#btn-about").addEventListener("click", open);
  $("#banner-more").addEventListener("click", open);
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());

  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("#install-hint").textContent = standalone
    ? ""
    : iOS
      ? "Tip: in Safari, tap Share, then “Add to Home Screen” to install PingTracker as an app."
      : "Tip: use “Install” in your browser’s menu (or the install icon in the address bar) to add PingTracker as an app.";

  let dismissed = false;
  try { dismissed = localStorage.getItem("pt-banner-dismissed") === "1"; } catch {}
  $("#web-banner").hidden = dismissed;
  $("#banner-close").addEventListener("click", () => {
    $("#web-banner").hidden = true;
    try { localStorage.setItem("pt-banner-dismissed", "1"); } catch {}
  });
}

function bindSettings() {
  $("#interface").addEventListener("change", (e) => save({ interface: e.target.value || null }, "Network interface updated"));
  $("#pings").addEventListener("change", (e) => save({ pings_per_test: Number(e.target.value) }));
  $("#timeout").addEventListener("change", (e) => save({ timeout_ms: Number(e.target.value) }));
  $("#slow").addEventListener("change", (e) => save({ slow_threshold_ms: Number(e.target.value) }));
  $("#retention").addEventListener("change", (e) => save({ retention_days: Number(e.target.value) }));
  $("#login").addEventListener("change", (e) => save({ launch_at_login: e.target.checked }));
  $("#menubar").addEventListener("change", (e) => save({ show_latency_in_menu_bar: e.target.checked }));
  $("#keep-awake").addEventListener("change", (e) => save({ keep_awake: e.target.checked }, e.target.checked ? "Screen will stay on while PingTracker is open" : "Screen can turn off normally"));

  $("#add-target").addEventListener("submit", (e) => {
    e.preventDefault();
    const host = $("#new-host").value.trim();
    if (!host) return;
    const label = $("#new-label").value.trim() || host;
    const id = `custom-${Date.now().toString(36)}`;
    $("#new-host").value = "";
    $("#new-label").value = "";
    save({ targets: [...state.settings.targets, { id, label, kind: "host", host, enabled: true, builtin: false }] }, `${label} added`);
  });

  $("#btn-export").addEventListener("click", async () => {
    try {
      const path = await api.export_csv({ from: 0, to: Date.now() });
      toast(isWeb() ? path : `Saved to ${path}`);
    } catch (e) {
      toast(String(e));
    }
  });

  const clearBtn = $("#btn-clear");
  clearBtn.addEventListener("click", async () => {
    if (!state.clearArmed) {
      state.clearArmed = true;
      clearBtn.classList.add("confirm");
      clearBtn.textContent = "Click again to delete all history";
      setTimeout(() => {
        state.clearArmed = false;
        clearBtn.classList.remove("confirm");
        clearBtn.textContent = "Clear history";
      }, 4000);
      return;
    }
    state.clearArmed = false;
    clearBtn.classList.remove("confirm");
    clearBtn.textContent = "Clear history";
    const n = await api.clear_history();
    toast(`Deleted ${n.toLocaleString()} tests`);
    await Promise.all([refreshStatus(), refreshDashboard()]);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function showView(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "settings") {
    api.list_interfaces().then((ifs) => {
      state.interfaces = ifs;
      renderSettings();
    });
  }
}

async function boot() {
  [state.settings, state.status, state.interfaces] = await Promise.all([api.get_settings(), api.get_status(), api.list_interfaces()]);
  if (isWeb()) setupWeb();
  renderStatus();
  renderSettings();
  bindSettings();

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  document.querySelectorAll("#range button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#range button").forEach((x) => x.classList.toggle("on", x === b));
      state.rangeMs = Number(b.dataset.range);
      refreshDashboard();
    }),
  );
  $("#btn-run").addEventListener("click", () => api.run_now());
  $("#btn-pause").addEventListener("click", async () => {
    state.settings = await api.set_paused({ paused: !state.status.paused });
    await refreshStatus();
  });

  await refreshDashboard();

  onEvent("status-updated", refreshStatus);
  onEvent("results-updated", (results) => {
    refreshDashboard(Array.isArray(results) ? results : []);
    refreshStatus();
  });
  onEvent("settings-updated", (s) => {
    state.settings = s;
    renderSettings();
    refreshStatus();
  });
  setInterval(renderStatus, 1000);
  // Keep the time axis moving even between tests.
  setInterval(() => !document.hidden && refreshDashboard(), 60_000);
  // Catch up immediately when the window is shown again from the tray.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) Promise.all([refreshStatus(), refreshDashboard()]);
  });
  window.addEventListener("focus", () => Promise.all([refreshStatus(), refreshDashboard()]));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    Object.values(state.charts).forEach((c) => c.destroy());
    state.charts = {};
    refreshDashboard();
  });
}

boot().catch((e) => {
  console.error(e);
  toast(`Failed to start: ${e}`);
});
