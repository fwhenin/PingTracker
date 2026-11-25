// Browser backend for the standalone web version (GitHub Pages / PWA).
//
// It implements the same commands as the Tauri backend, so the dashboard in
// main.js works unchanged. Differences from the desktop app:
//   * Browsers can't send ICMP pings, so latency is the round-trip time of a
//     tiny HTTPS request (HEAD, no-cors, never cached) to each target.
//   * Tests run only while the page is open. When the page comes back after
//     being hidden or closed, one catch-up test runs; missed slots aren't
//     backfilled.
//   * History and settings live in IndexedDB in this browser.
//   * If several tabs are open, a Web Lock makes sure only one of them runs a
//     given test, and a BroadcastChannel keeps the others up to date.

import { openDb, kvGet, kvSet, addRows, rowsInRange, recentRows, countRows, clearRows, pruneBefore } from "./db.js";

const INTERVALS = [1, 2, 5, 10, 15, 30, 60];
const PING_GAP_MS = 250;

export const DEFAULT_TARGETS = [
  { id: "cloudflare", label: "Cloudflare", kind: "url", host: "1.1.1.1", url: "https://1.1.1.1/cdn-cgi/trace", enabled: true, builtin: true },
  { id: "google", label: "Google", kind: "url", host: "www.google.com", url: "https://www.google.com/generate_204", enabled: true, builtin: true },
  { id: "quad9", label: "Quad9", kind: "url", host: "dns.quad9.net", url: "https://dns.quad9.net/dns-query", enabled: false, builtin: true },
];

const DEFAULT_SETTINGS = {
  interval_minutes: 5,
  targets: DEFAULT_TARGETS,
  interface: null,
  pings_per_test: 5,
  timeout_ms: 2000,
  retention_days: 90,
  paused: false,
  slow_threshold_ms: 150,
  keep_awake: false,
};

// ---------------------------------------------------------------------------
// Events (same names as the Tauri backend emits)
// ---------------------------------------------------------------------------

const listeners = {};
const emitLocal = (name, payload) => (listeners[name] || []).forEach((cb) => cb(payload));
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pingtracker") : null;
function emit(name, payload) {
  emitLocal(name, payload);
  channel?.postMessage({ name, payload });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let db;
let settings;
let lastRunTs = null;
let running = false;
let latest = [];

const nextRunTs = () => {
  if (settings.paused) return null;
  if (!lastRunTs) return Date.now();
  return lastRunTs + settings.interval_minutes * 60_000;
};

const ready = (async () => {
  db = await openDb();
  settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...((await kvGet(db, "settings")) ?? {}) });
  lastRunTs = (await kvGet(db, "last_run_ts")) ?? null;
  latest = await latestPerTarget();
  // Ask the browser not to evict our data under storage pressure (and on iOS
  // after a week without visits). Installed home-screen apps get this anyway.
  navigator.storage?.persist?.().catch(() => {});

  channel?.addEventListener("message", async ({ data }) => {
    // Another tab changed something: reload our copy, then tell our UI.
    if (data.name === "settings-updated") settings = normalizeSettings(data.payload);
    if (data.name === "results-updated") {
      lastRunTs = (await kvGet(db, "last_run_ts")) ?? lastRunTs;
      latest = await latestPerTarget();
    }
    if (data.name === "status-updated") lastRunTs = (await kvGet(db, "last_run_ts")) ?? lastRunTs;
    emitLocal(data.name, data.payload);
  });

  setInterval(tick, 1000);
  document.addEventListener("visibilitychange", () => {
    updateWakeLock();
    if (!document.hidden) tick();
  });
  window.addEventListener("online", () => tick());
  updateWakeLock();
  // First visit: run the first test shortly after the page appears.
  setTimeout(tick, 1500);
})();

function normalizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...s };
  if (!INTERVALS.includes(out.interval_minutes)) out.interval_minutes = DEFAULT_SETTINGS.interval_minutes;
  out.interface = null;
  out.targets = (out.targets ?? []).filter((t) => t.kind !== "gateway");
  return out;
}

/** Accepts "example.com", "1.2.3.4", "example.com/path" or a full https:// URL. */
export function targetUrl(input) {
  let s = String(input ?? "").trim();
  if (!s) throw "Enter a web address to test";
  if (/^http:\/\//i.test(s)) {
    throw "Only https:// addresses can be tested from a web page (browsers block plain http here)";
  }
  if (!/^https:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw `"${input}" isn't a valid web address`;
  }
  if (!u.hostname.includes(".") && !u.hostname.includes(":")) throw `"${input}" isn't a valid web address`;
  return u;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timedRequest(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const u = new URL(url);
  u.searchParams.set("_pt", `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  const t0 = performance.now();
  try {
    await fetch(u, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: ctrl.signal,
    });
    return { ms: performance.now() - t0 };
  } catch (e) {
    return { error: e?.name === "AbortError" ? "Timed out" : "Couldn't connect" };
  } finally {
    clearTimeout(timer);
  }
}

export async function measure(target, { pings, timeoutMs }) {
  const ts = Date.now();
  const base = {
    ts, target_id: target.id, target_label: target.label, host: target.host, ip: null, interface: null, sent: pings,
  };
  const fail = (error) => ({ ...base, received: 0, loss: 100, min_ms: null, avg_ms: null, max_ms: null, jitter_ms: null, error });
  if (typeof navigator !== "undefined" && navigator.onLine === false) return fail("Device is offline");

  // Warm-up request: opens the connection (DNS, TCP, TLS) so the timed
  // requests measure round trips on an open connection, like a ping does.
  await timedRequest(target.url, timeoutMs);

  const times = [];
  const errors = [];
  for (let i = 0; i < pings; i++) {
    if (i) await sleep(PING_GAP_MS);
    const r = await timedRequest(target.url, timeoutMs);
    if (r.ms != null) times.push(r.ms);
    else errors.push(r.error);
  }
  if (!times.length) return fail(errors[0] ?? "No reply");
  let jitter = 0;
  for (let i = 1; i < times.length; i++) jitter += Math.abs(times[i] - times[i - 1]);
  return {
    ...base,
    received: times.length,
    loss: (100 * (pings - times.length)) / pings,
    min_ms: Math.min(...times),
    avg_ms: times.reduce((a, b) => a + b, 0) / times.length,
    max_ms: Math.max(...times),
    jitter_ms: times.length > 1 ? jitter / (times.length - 1) : 0,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function tick() {
  if (!settings || running || settings.paused) return;
  const next = nextRunTs();
  if (next != null && Date.now() >= next) runTest(false);
}

function withRunLock(fn) {
  if (!navigator.locks) return fn();
  return navigator.locks.request("pingtracker-run", { ifAvailable: true }, (lock) => (lock ? fn() : null));
}

async function runTest(force) {
  if (running) return;
  running = true;
  try {
    await withRunLock(async () => {
      // Another tab may have just run this test.
      lastRunTs = (await kvGet(db, "last_run_ts")) ?? lastRunTs;
      if (!force && (settings.paused || Date.now() < nextRunTs())) return;
      emit("status-updated", null);
      const targets = settings.targets.filter((t) => t.enabled);
      const opts = { pings: settings.pings_per_test, timeoutMs: settings.timeout_ms };
      const results = await Promise.all(targets.map((t) => measure(t, opts)));
      const stored = await addRows(db, results);
      lastRunTs = stored[0]?.ts ?? Date.now();
      await kvSet(db, "last_run_ts", lastRunTs);
      if (settings.retention_days > 0) await pruneBefore(db, lastRunTs - settings.retention_days * 86_400_000);
      latest = await latestPerTarget();
      running = false;
      emit("results-updated", stored);
    });
  } catch (e) {
    console.error("Test failed", e);
  } finally {
    running = false;
    emit("status-updated", null);
  }
}

// ---------------------------------------------------------------------------
// Keep the screen awake (optional) so tests keep running on a tablet/phone
// ---------------------------------------------------------------------------

let wakeLock = null;
async function updateWakeLock() {
  const want = settings?.keep_awake && !settings.paused && !document.hidden && "wakeLock" in navigator;
  if (want && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } catch {
      wakeLock = null;
    }
  } else if (!want && wakeLock) {
    await wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function latestPerTarget() {
  const out = [];
  const seen = new Set();
  for (const r of await recentRows(db, 200)) {
    if (seen.has(r.target_id)) continue;
    seen.add(r.target_id);
    if (settings.targets.some((t) => t.id === r.target_id && t.enabled)) out.push(r);
  }
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function toCsv(rows) {
  const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const f = (v) => (v == null ? "" : v.toFixed(3));
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (ts) => {
    const d = new Date(ts);
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  };
  let out = "timestamp,target,host,ip,interface,sent,received,loss_pct,min_ms,avg_ms,max_ms,jitter_ms,error\n";
  for (const r of rows) {
    out += [iso(r.ts), esc(r.target_label), esc(r.host ?? ""), "", "", r.sent, r.received, r.loss.toFixed(1),
      f(r.min_ms), f(r.avg_ms), f(r.max_ms), f(r.jitter_ms), esc(r.error ?? "")].join(",") + "\n";
  }
  return out;
}

async function saveFile(name, text) {
  const blob = new Blob([text], { type: "text/csv" });
  // On iPhone/iPad the share sheet is the friendliest way to save a file.
  const file = typeof File !== "undefined" ? new File([blob], name, { type: "text/csv" }) : null;
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (iOS && file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return `Shared ${name}`;
    } catch (e) {
      if (e?.name === "AbortError") return "Export cancelled";
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return `Downloaded ${name}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const handlers = {
  get_settings: () => settings,

  save_settings: async ({ settings: s }) => {
    const next = normalizeSettings(s);
    next.targets = next.targets.map((t) => {
      if (t.builtin || t.url) return t;
      const u = targetUrl(t.host);
      const host = u.pathname === "/" && !u.search ? u.host : `${u.host}${u.pathname}`;
      return { ...t, kind: "url", url: u.href, host, label: t.label === t.host ? host : t.label };
    });
    settings = next;
    await kvSet(db, "settings", settings);
    latest = await latestPerTarget();
    updateWakeLock();
    emit("settings-updated", settings);
    return settings;
  },

  get_status: async () => ({
    running,
    last_run_ts: lastRunTs,
    next_run_ts: nextRunTs(),
    latest,
    paused: settings.paused,
    interval_minutes: settings.interval_minutes,
    interval_choices: INTERVALS,
    total_results: await countRows(db),
    platform: "web",
    data_dir: null,
    features: { wake_lock: "wakeLock" in navigator },
  }),

  run_now: () => {
    runTest(true);
    return null;
  },

  set_paused: ({ paused }) => handlers.save_settings({ settings: { ...settings, paused } }),

  list_interfaces: () => [],
  default_gateway: () => null,

  get_series: async ({ from, to, maxPoints }) => {
    const bucket = Math.max(1, Math.floor((to - from) / maxPoints));
    const m = new Map();
    for (const r of await rowsInRange(db, from, to)) {
      const b = Math.floor(r.ts / bucket) * bucket;
      const k = `${r.target_id}|${b}`;
      let a = m.get(k);
      if (!a) m.set(k, (a = { target_id: r.target_id, ts: b, sum: 0, n: 0, min: null, max: null, sent: 0, rec: 0, tests: 0 }));
      if (r.avg_ms != null) { a.sum += r.avg_ms; a.n++; }
      if (r.min_ms != null) a.min = Math.min(a.min ?? Infinity, r.min_ms);
      if (r.max_ms != null) a.max = Math.max(a.max ?? -Infinity, r.max_ms);
      a.sent += r.sent; a.rec += r.received; a.tests++;
    }
    const points = [...m.values()].sort((a, b) => a.ts - b.ts).map((a) => ({
      target_id: a.target_id, ts: a.ts, avg_ms: a.n ? a.sum / a.n : null, min_ms: a.min, max_ms: a.max,
      loss: a.sent ? (100 * (a.sent - a.rec)) / a.sent : 0, tests: a.tests,
    }));
    return { bucket_ms: bucket, points };
  },

  get_summary: async ({ from, to }) => {
    const by = new Map();
    for (const r of await rowsInRange(db, from, to)) {
      if (!by.has(r.target_id)) by.set(r.target_id, []);
      by.get(r.target_id).push(r);
    }
    return [...by.entries()].map(([tid, rs]) => {
      const avgs = rs.map((r) => r.avg_ms).filter((v) => v != null).sort((a, b) => a - b);
      const jit = rs.map((r) => r.jitter_ms).filter((v) => v != null);
      const sent = rs.reduce((a, r) => a + r.sent, 0);
      const rec = rs.reduce((a, r) => a + r.received, 0);
      const last = rs[rs.length - 1];
      return {
        target_id: tid, target_label: last.target_label, tests: rs.length, failed_tests: rs.filter((r) => !r.received).length,
        sent, received: rec, loss: sent ? (100 * (sent - rec)) / sent : 0,
        avg_ms: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null,
        median_ms: quantile(avgs, 0.5), p95_ms: quantile(avgs, 0.95),
        min_ms: avgs[0] ?? null, max_ms: avgs[avgs.length - 1] ?? null,
        jitter_ms: jit.length ? jit.reduce((a, b) => a + b, 0) / jit.length : null,
        last,
      };
    });
  },

  get_recent: ({ limit }) => recentRows(db, limit),

  clear_history: async () => {
    const n = await clearRows(db);
    latest = [];
    emit("status-updated", null);
    return n;
  },

  export_csv: async ({ from = 0, to = Date.now() } = {}) => {
    const rows = await rowsInRange(db, from, to);
    if (!rows.length) throw "There is no history to export yet";
    const d = new Date();
    const name = `pingtracker-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.csv`;
    return saveFile(name, toCsv(rows));
  },
};

export async function invoke(cmd, args = {}) {
  await ready;
  const h = handlers[cmd];
  if (!h) throw `Unknown command ${cmd}`;
  return structuredClone(await h(args));
}

export async function listen(name, cb) {
  (listeners[name] ||= []).push(cb);
  return () => {
    listeners[name] = listeners[name].filter((x) => x !== cb);
  };
}
