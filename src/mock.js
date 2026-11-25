// Browser-only mock backend used when the UI runs outside Tauri (for previews).

const now = Date.now();
let settings = {
  interval_minutes: 5,
  targets: [
    { id: "gateway", label: "Router (gateway)", kind: "gateway", host: "", enabled: true, builtin: true },
    { id: "cloudflare", label: "Cloudflare DNS", kind: "host", host: "1.1.1.1", enabled: true, builtin: true },
    { id: "google", label: "Google DNS", kind: "host", host: "8.8.8.8", enabled: true, builtin: true },
    { id: "quad9", label: "Quad9 DNS", kind: "host", host: "9.9.9.9", enabled: false, builtin: true },
  ],
  interface: null,
  pings_per_test: 5,
  timeout_ms: 2000,
  retention_days: 90,
  paused: false,
  launch_at_login: false,
  show_latency_in_menu_bar: true,
  slow_threshold_ms: 100,
};

const base = { gateway: [2, "192.168.1.1"], cloudflare: [14, "1.1.1.1"], google: [22, "8.8.8.8"] };
let rows = [];
let id = 1;
function seeded(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
for (let t = now - 3 * 86_400_000; t < now; t += 5 * 60_000) {
  const hour = new Date(t).getHours();
  const evening = hour >= 19 && hour <= 23 ? 1.8 : 1;
  for (const [tid, [b, host]] of Object.entries(base)) {
    const r = seeded(id);
    const spike = r > 0.985 ? 6 : 1;
    const avg = b * evening * spike * (0.85 + r * 0.4);
    const lost = r > 0.993 ? 5 : r > 0.975 ? 1 : 0;
    rows.push({
      id: id++, ts: t, target_id: tid, target_label: settings.targets.find((x) => x.id === tid).label,
      host, ip: host, interface: null, sent: 5, received: 5 - lost, loss: lost * 20,
      min_ms: lost === 5 ? null : avg * 0.8, avg_ms: lost === 5 ? null : avg, max_ms: lost === 5 ? null : avg * 1.4,
      jitter_ms: lost === 5 ? null : avg * 0.08, error: lost === 5 ? "Request timed out" : null,
    });
  }
}

const listeners = {};
const emit = (n, p) => (listeners[n] || []).forEach((cb) => cb(p));
const latest = () => {
  const out = [];
  for (const t of settings.targets.filter((t) => t.enabled)) {
    const r = [...rows].reverse().find((x) => x.target_id === t.id);
    if (r) out.push(r);
  }
  return out;
};

let nextRun = Date.now() + 192_000;
let lastRun = now;
let running = false;
function simulateRun() {
  running = true;
  emit("status-updated", null);
  setTimeout(() => {
    const ts = Date.now();
    const fresh = [];
    for (const [tid, [b, host]] of Object.entries(base)) {
      if (!settings.targets.find((t) => t.id === tid)?.enabled) continue;
      const avg = b * (0.85 + Math.random() * 0.4);
      const r = { id: id++, ts, target_id: tid, target_label: settings.targets.find((x) => x.id === tid).label, host, ip: host,
        interface: null, sent: 5, received: 5, loss: 0, min_ms: avg * 0.8, avg_ms: avg, max_ms: avg * 1.4, jitter_ms: avg * 0.08, error: null };
      rows.push(r);
      fresh.push(r);
    }
    running = false;
    lastRun = ts;
    nextRun = ts + settings.interval_minutes * 60_000;
    emit("results-updated", structuredClone(fresh));
    emit("status-updated", null);
  }, 1200);
}
setInterval(() => {
  if (!running && !settings.paused && Date.now() >= nextRun) simulateRun();
}, 500);
if (typeof location !== "undefined" && location.hash === "#soon") nextRun = Date.now() + 4000;

const handlers = {
  get_settings: () => settings,
  save_settings: ({ settings: s }) => {
    if (s.interval_minutes !== settings.interval_minutes) nextRun = lastRun + s.interval_minutes * 60_000;
    settings = s;
    emit("settings-updated", s);
    return s;
  },
  get_status: () => ({
    running, last_run_ts: lastRun, next_run_ts: settings.paused ? null : nextRun, latest: latest(),
    paused: settings.paused, interval_minutes: settings.interval_minutes, interval_choices: [1, 2, 5, 10, 15, 30, 60],
    total_results: rows.length, platform: "macos", data_dir: "~/Library/Application Support/com.fwhenin.pingtracker",
  }),
  run_now: () => { if (!running) simulateRun(); return null; },
  set_paused: ({ paused }) => ((settings = { ...settings, paused }), settings),
  list_interfaces: () => [
    { id: "en0", label: "en0", ipv4: ["192.168.1.23"], gateway: "192.168.1.1", is_default: true },
    { id: "en5", label: "en5", ipv4: ["10.0.0.12"], gateway: "10.0.0.1", is_default: false },
  ],
  default_gateway: () => "192.168.1.1",
  get_series: ({ from, to, maxPoints }) => {
    const bucket = Math.max(1, Math.floor((to - from) / maxPoints));
    const m = new Map();
    for (const r of rows) {
      if (r.ts < from || r.ts > to) continue;
      const b = Math.floor(r.ts / bucket) * bucket;
      const k = `${r.target_id}|${b}`;
      const a = m.get(k) || { target_id: r.target_id, ts: b, sum: 0, n: 0, min: null, max: null, sent: 0, rec: 0, tests: 0 };
      if (r.avg_ms != null) { a.sum += r.avg_ms; a.n++; }
      a.min = r.min_ms == null ? a.min : Math.min(a.min ?? Infinity, r.min_ms);
      a.max = r.max_ms == null ? a.max : Math.max(a.max ?? 0, r.max_ms);
      a.sent += r.sent; a.rec += r.received; a.tests++;
      m.set(k, a);
    }
    const points = [...m.values()].sort((a, b) => a.ts - b.ts).map((a) => ({
      target_id: a.target_id, ts: a.ts, avg_ms: a.n ? a.sum / a.n : null, min_ms: a.min, max_ms: a.max,
      loss: (100 * (a.sent - a.rec)) / a.sent, tests: a.tests,
    }));
    return { bucket_ms: bucket, points };
  },
  get_summary: ({ from, to }) => {
    const by = {};
    for (const r of rows) {
      if (r.ts < from || r.ts > to) continue;
      (by[r.target_id] ||= []).push(r);
    }
    return Object.entries(by).map(([tid, rs]) => {
      const avgs = rs.map((r) => r.avg_ms).filter((v) => v != null).sort((a, b) => a - b);
      const sent = rs.reduce((a, r) => a + r.sent, 0), rec = rs.reduce((a, r) => a + r.received, 0);
      return {
        target_id: tid, target_label: rs[0].target_label, tests: rs.length, failed_tests: rs.filter((r) => !r.received).length,
        sent, received: rec, loss: (100 * (sent - rec)) / sent,
        avg_ms: avgs.reduce((a, b) => a + b, 0) / avgs.length, median_ms: avgs[Math.floor(avgs.length / 2)],
        p95_ms: avgs[Math.floor(avgs.length * 0.95)], min_ms: avgs[0], max_ms: avgs[avgs.length - 1],
        jitter_ms: rs.reduce((a, r) => a + (r.jitter_ms ?? 0), 0) / rs.length, last: rs[rs.length - 1],
      };
    });
  },
  get_recent: ({ limit }) => [...rows].reverse().slice(0, limit),
  clear_history: () => { const n = rows.length; rows = []; return n; },
  export_csv: () => "~/Downloads/pingtracker-mock.csv",
};

export async function invoke(cmd, args = {}) {
  return structuredClone(handlers[cmd](args));
}
export async function listen(name, cb) {
  (listeners[name] ||= []).push(cb);
  return () => {};
}
