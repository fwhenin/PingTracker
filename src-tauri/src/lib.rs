mod net;
mod ping;
mod settings;
mod store;

use serde::Serialize;
use settings::{Settings, TargetKind, INTERVAL_CHOICES};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use store::{PingResult, Series, Store, TargetSummary};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tokio::sync::mpsc;

const TRAY_ID: &str = "main-tray";
const AUTOSTART_ARG: &str = "--autostart";

const ICON_IDLE: &[u8] = include_bytes!("../icons/tray/idle.png");
const ICON_GOOD: &[u8] = include_bytes!("../icons/tray/good.png");
const ICON_WARN: &[u8] = include_bytes!("../icons/tray/warn.png");
const ICON_BAD: &[u8] = include_bytes!("../icons/tray/bad.png");

enum Wake {
    RunNow,
    Reschedule,
}

#[derive(Debug, Clone, Default, Serialize)]
struct Status {
    running: bool,
    last_run_ts: Option<i64>,
    next_run_ts: Option<i64>,
    latest: Vec<PingResult>,
}

struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    store: Mutex<Store>,
    status: Mutex<Status>,
    wake: mpsc::UnboundedSender<Wake>,
}

#[derive(Serialize)]
struct StatusPayload {
    #[serde(flatten)]
    status: Status,
    paused: bool,
    interval_minutes: u32,
    interval_choices: Vec<u32>,
    total_results: i64,
    platform: &'static str,
    data_dir: String,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Ping runs
// ---------------------------------------------------------------------------

async fn run_tests(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    state.status.lock().unwrap().running = true;
    let _ = app.emit("status-updated", ());

    let iface = settings.interface.clone();
    let iface_label = iface.as_ref().map(|id| {
        net::list_interfaces()
            .into_iter()
            .find(|i| &i.id == id)
            .map(|i| i.label)
            .unwrap_or_else(|| id.clone())
    });
    let binding = net::binding_for(iface.as_deref());
    let count = settings.pings_per_test;
    let timeout = Duration::from_millis(settings.timeout_ms as u64);
    let ts = now_ms();

    let mut handles = vec![];
    for target in settings.targets.iter().filter(|t| t.enabled).cloned() {
        let binding = binding.clone();
        let iface = iface.clone();
        handles.push(tauri::async_runtime::spawn_blocking(move || {
            let host = match target.kind {
                TargetKind::Gateway => net::gateway_for(iface.as_deref()).map(|g| g.to_string()),
                TargetKind::Host => Some(target.host.clone()),
            };
            let summary = match (&binding, &host) {
                (Err(e), _) => ping::PingSummary { ip: None, sent: 0, received: 0, rtts_ms: vec![], error: Some(e.clone()) },
                (_, None) => ping::PingSummary {
                    ip: None,
                    sent: 0,
                    received: 0,
                    rtts_ms: vec![],
                    error: Some("No default gateway found".into()),
                },
                (Ok(b), Some(h)) => ping::ping_host(h, count, timeout, b),
            };
            (target, host, summary)
        }));
    }

    let mut results = vec![];
    for h in handles {
        let Ok((target, host, s)) = h.await else { continue };
        results.push(PingResult {
            id: 0,
            ts,
            target_id: target.id.clone(),
            target_label: target.label.clone(),
            host: host.unwrap_or_default(),
            ip: s.ip.map(|i| i.to_string()),
            interface: iface_label.clone(),
            sent: s.sent,
            received: s.received,
            loss: s.loss_pct(),
            min_ms: s.min(),
            avg_ms: s.avg(),
            max_ms: s.max(),
            jitter_ms: s.jitter(),
            error: s.error.clone(),
        });
    }

    {
        let store = state.store.lock().unwrap();
        for r in results.iter_mut() {
            if let Err(e) = store.insert(r) {
                log::error!("failed to store result: {e}");
            }
        }
        if settings.retention_days > 0 {
            let _ = store.prune(ts - settings.retention_days as i64 * 86_400_000);
        }
    }
    {
        let mut st = state.status.lock().unwrap();
        st.running = false;
        st.last_run_ts = Some(ts);
        st.latest = results.clone();
    }
    refresh_tray(app);
    let _ = app.emit("results-updated", &results);
    let _ = app.emit("status-updated", ());
}

/// Background loop: runs tests on the configured interval using the wall clock, so that
/// a sleeping laptop catches up as soon as it wakes.
async fn scheduler(app: AppHandle, mut rx: mpsc::UnboundedReceiver<Wake>) {
    let mut last_run: Option<i64> = None;
    loop {
        let (interval_ms, paused) = {
            let s = app.state::<AppState>().settings.lock().unwrap().clone();
            (s.interval_minutes as i64 * 60_000, s.paused)
        };
        let due = match last_run {
            Some(t) => t + interval_ms,
            None => now_ms() + 1_500,
        };
        {
            let state = app.state::<AppState>();
            state.status.lock().unwrap().next_run_ts = if paused { None } else { Some(due) };
        }
        let _ = app.emit("status-updated", ());

        let run = loop {
            let wait = if paused { 60_000 } else { (due - now_ms()).clamp(0, 15_000) };
            if !paused && wait == 0 {
                break true;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(wait as u64)) => {}
                msg = rx.recv() => match msg {
                    Some(Wake::RunNow) => break true,
                    Some(Wake::Reschedule) => break false,
                    None => return,
                }
            }
        };
        if run {
            run_tests(&app).await;
            last_run = Some(now_ms());
            // Collapse "run now" clicks that arrived while the test was running.
            while let Ok(Wake::RunNow) = rx.try_recv() {}
        }
    }
}

// ---------------------------------------------------------------------------
// Tray / menu bar
// ---------------------------------------------------------------------------

fn fmt_ms(v: f64) -> String {
    if v < 10.0 {
        format!("{v:.1} ms")
    } else {
        format!("{v:.0} ms")
    }
}

fn headline(results: &[PingResult]) -> Option<&PingResult> {
    results.iter().find(|r| r.target_id != "gateway").or_else(|| results.first())
}

fn build_menu(app: &AppHandle, settings: &Settings, status: &Status) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    if status.latest.is_empty() {
        menu.append(&MenuItem::with_id(app, "status", "No results yet", false, None::<&str>)?)?;
    } else {
        for r in &status.latest {
            let text = match (r.avg_ms, r.received) {
                (Some(avg), _) if r.loss > 0.0 => format!("{}: {} ({:.0}% loss)", r.target_label, fmt_ms(avg), r.loss),
                (Some(avg), _) => format!("{}: {}", r.target_label, fmt_ms(avg)),
                _ => format!("{}: failed", r.target_label),
            };
            menu.append(&MenuItem::with_id(app, format!("status:{}", r.target_id), text, false, None::<&str>)?)?;
        }
    }
    if settings.paused {
        menu.append(&MenuItem::with_id(app, "paused", "Tests are paused", false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Dashboard…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "run", "Run Test Now", !status.running, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "pause",
        if settings.paused { "Resume Tests" } else { "Pause Tests" },
        true,
        None::<&str>,
    )?)?;
    let interval = Submenu::with_id(app, "interval", "Test Every", true)?;
    for m in INTERVAL_CHOICES {
        let label = if m == 1 { "1 minute".to_string() } else if m == 60 { "1 hour".to_string() } else { format!("{m} minutes") };
        interval.append(&CheckMenuItem::with_id(
            app,
            format!("interval:{m}"),
            label,
            true,
            settings.interval_minutes == m,
            None::<&str>,
        )?)?;
    }
    menu.append(&interval)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit PingTracker", true, None::<&str>)?)?;
    Ok(menu)
}

fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let status = state.status.lock().unwrap().clone();
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    if let Ok(menu) = build_menu(app, &settings, &status) {
        let _ = tray.set_menu(Some(menu));
    }

    let icon_bytes = if settings.paused || status.latest.is_empty() {
        ICON_IDLE
    } else if status.latest.iter().any(|r| r.received == 0) {
        ICON_BAD
    } else if status
        .latest
        .iter()
        .any(|r| r.loss > 0.0 || r.avg_ms.unwrap_or(0.0) > settings.slow_threshold_ms as f64)
    {
        ICON_WARN
    } else {
        ICON_GOOD
    };
    if let Ok(img) = Image::from_bytes(icon_bytes) {
        let _ = tray.set_icon(Some(img));
    }

    let head = headline(&status.latest);
    let tooltip = match head {
        Some(r) => match r.avg_ms {
            Some(avg) => format!("PingTracker: {} {}", r.target_label, fmt_ms(avg)),
            None => format!("PingTracker: {} failed", r.target_label),
        },
        None => "PingTracker".to_string(),
    };
    let _ = tray.set_tooltip(Some(tooltip));

    #[cfg(target_os = "macos")]
    {
        let title = match (settings.show_latency_in_menu_bar && !settings.paused, head) {
            (true, Some(r)) => Some(r.avg_ms.map(fmt_ms).unwrap_or_else(|| "–".into())),
            _ => None,
        };
        let _ = tray.set_title(title);
    }
}

fn show_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn update_settings(app: &AppHandle, f: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let new = {
        let mut s = state.settings.lock().unwrap();
        f(&mut s);
        *s = s.clone().normalize();
        s.save(&state.settings_path)?;
        s.clone()
    };
    let _ = state.wake.send(Wake::Reschedule);
    refresh_tray(app);
    let _ = app.emit("settings-updated", &new);
    Ok(new)
}

fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open" => show_dashboard(app),
        "run" => {
            let _ = app.state::<AppState>().wake.send(Wake::RunNow);
        }
        "pause" => {
            let _ = update_settings(app, |s| s.paused = !s.paused);
        }
        "quit" => app.exit(0),
        other => {
            if let Some(m) = other.strip_prefix("interval:").and_then(|m| m.parse::<u32>().ok()) {
                let _ = update_settings(app, |s| s.interval_minutes = m);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands for the dashboard
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let launch = settings.launch_at_login;
    let autolaunch = app.autolaunch();
    if autolaunch.is_enabled().unwrap_or(false) != launch {
        let r = if launch { autolaunch.enable() } else { autolaunch.disable() };
        r.map_err(|e| format!("Could not change launch at login: {e}"))?;
    }
    update_settings(&app, move |s| *s = settings)
}

#[tauri::command]
fn get_status(state: State<AppState>) -> StatusPayload {
    let settings = state.settings.lock().unwrap().clone();
    StatusPayload {
        status: state.status.lock().unwrap().clone(),
        paused: settings.paused,
        interval_minutes: settings.interval_minutes,
        interval_choices: INTERVAL_CHOICES.to_vec(),
        total_results: state.store.lock().unwrap().count().unwrap_or(0),
        platform: std::env::consts::OS,
        data_dir: state.settings_path.parent().map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

#[tauri::command]
fn run_now(state: State<AppState>) {
    let _ = state.wake.send(Wake::RunNow);
}

#[tauri::command]
fn set_paused(app: AppHandle, paused: bool) -> Result<Settings, String> {
    update_settings(&app, |s| s.paused = paused)
}

#[tauri::command]
fn list_interfaces() -> Vec<net::NetInterface> {
    net::list_interfaces()
}

#[tauri::command]
fn default_gateway(interface: Option<String>) -> Option<String> {
    net::gateway_for(interface.as_deref()).map(|g| g.to_string())
}

#[tauri::command]
fn get_series(state: State<AppState>, from: i64, to: i64, max_points: Option<u32>) -> Result<Series, String> {
    state.store.lock().unwrap().series(from, to, max_points.unwrap_or(500)).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_summary(state: State<AppState>, from: i64, to: i64) -> Result<Vec<TargetSummary>, String> {
    state.store.lock().unwrap().summary(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_recent(state: State<AppState>, limit: Option<u32>, target: Option<String>) -> Result<Vec<PingResult>, String> {
    state.store.lock().unwrap().recent(limit.unwrap_or(50), target.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_history(app: AppHandle, state: State<AppState>) -> Result<usize, String> {
    let n = state.store.lock().unwrap().clear().map_err(|e| e.to_string())?;
    state.status.lock().unwrap().latest.clear();
    refresh_tray(&app);
    let _ = app.emit("results-updated", Vec::<PingResult>::new());
    Ok(n)
}

#[tauri::command]
fn export_csv(app: AppHandle, state: State<AppState>, from: i64, to: i64) -> Result<String, String> {
    let rows = state.store.lock().unwrap().range(from, to).map_err(|e| e.to_string())?;
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    let name = format!("pingtracker-{}.csv", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(name);
    std::fs::write(&path, store::to_csv(&rows)).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launched_by_autostart = std::env::args().any(|a| a == AUTOSTART_ARG);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_dashboard(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let settings_path = config_dir.join("settings.json");
            let first_run = !settings_path.exists();
            let settings = Settings::load(&settings_path);
            let _ = settings.save(&settings_path);
            let store = Store::open(&data_dir.join("history.sqlite3"))?;

            // Keep the OS login item in sync with the saved preference.
            let autolaunch = app.autolaunch();
            if autolaunch.is_enabled().unwrap_or(false) != settings.launch_at_login {
                let _ = if settings.launch_at_login { autolaunch.enable() } else { autolaunch.disable() };
            }

            let latest: Vec<PingResult> = settings
                .targets
                .iter()
                .filter(|t| t.enabled)
                .filter_map(|t| store.last_for(&t.id).ok().flatten())
                .collect();

            let (tx, rx) = mpsc::unbounded_channel();
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                settings_path,
                store: Mutex::new(store),
                status: Mutex::new(Status { latest, ..Default::default() }),
                wake: tx,
            });

            let handle = app.handle().clone();
            let menu = build_menu(&handle, &settings, &app.state::<AppState>().status.lock().unwrap().clone())?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(ICON_IDLE)?)
                .icon_as_template(false)
                .tooltip("PingTracker")
                .menu(&menu)
                // macOS: click opens the menu. Windows: left click opens the dashboard,
                // right click opens the menu.
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        if !cfg!(target_os = "macos") {
                            show_dashboard(tray.app_handle());
                        }
                    }
                })
                .build(app)?;
            refresh_tray(&handle);

            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        // Closing the dashboard keeps PingTracker running in the tray.
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
            }
            if first_run || !launched_by_autostart {
                show_dashboard(&handle);
            }

            tauri::async_runtime::spawn(scheduler(handle, rx));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_status,
            run_now,
            set_paused,
            list_interfaces,
            default_gateway,
            get_series,
            get_summary,
            get_recent,
            clear_history,
            export_csv
        ])
        .build(tauri::generate_context!())
        .expect("error while building PingTracker")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Stay alive in the tray when the dashboard is closed; only quit explicitly.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
