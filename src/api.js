// Thin wrapper over Tauri's IPC. When the page is opened in a plain browser
// (e.g. `npm run dev` without Tauri) it falls back to an in-memory mock so the
// dashboard can still be previewed.

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const COMMANDS = [
  "get_settings", "save_settings", "get_status", "run_now", "set_paused", "list_interfaces",
  "default_gateway", "get_series", "get_summary", "get_recent", "clear_history", "export_csv",
];

let impl;
let listenImpl;

if (inTauri) {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  impl = (cmd, args) => invoke(cmd, args);
  listenImpl = (name, cb) => listen(name, (e) => cb(e.payload));
} else {
  const mock = await import("./mock.js");
  impl = mock.invoke;
  listenImpl = mock.listen;
}

export const api = Object.fromEntries(COMMANDS.map((c) => [c, (args) => impl(c, args)]));
export const onEvent = (name, cb) => listenImpl(name, cb);
