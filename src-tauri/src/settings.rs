//! User settings, persisted as JSON in the app config directory.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const INTERVAL_CHOICES: [u32; 7] = [1, 2, 5, 10, 15, 30, 60];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    /// The default gateway (router) of the selected interface.
    Gateway,
    /// A fixed host name or IP address.
    Host,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub label: String,
    pub kind: TargetKind,
    #[serde(default)]
    pub host: String,
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub interval_minutes: u32,
    pub targets: Vec<Target>,
    /// OS interface name; `None` = let the system route.
    pub interface: Option<String>,
    pub pings_per_test: u32,
    pub timeout_ms: u32,
    /// 0 keeps history forever.
    pub retention_days: u32,
    pub paused: bool,
    pub launch_at_login: bool,
    /// macOS: show the last latency next to the menu bar icon.
    pub show_latency_in_menu_bar: bool,
    /// Latency (ms) above which a result is shown as "slow".
    pub slow_threshold_ms: u32,
}

fn builtin(id: &str, label: &str, kind: TargetKind, host: &str, enabled: bool) -> Target {
    Target { id: id.into(), label: label.into(), kind, host: host.into(), enabled, builtin: true }
}

pub fn builtin_targets() -> Vec<Target> {
    vec![
        builtin("gateway", "Router (gateway)", TargetKind::Gateway, "", true),
        builtin("cloudflare", "Cloudflare DNS", TargetKind::Host, "1.1.1.1", true),
        builtin("google", "Google DNS", TargetKind::Host, "8.8.8.8", false),
        builtin("quad9", "Quad9 DNS", TargetKind::Host, "9.9.9.9", false),
    ]
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            interval_minutes: 5,
            targets: builtin_targets(),
            interface: None,
            pings_per_test: 5,
            timeout_ms: 2000,
            retention_days: 90,
            paused: false,
            launch_at_login: false,
            show_latency_in_menu_bar: true,
            slow_threshold_ms: 100,
        }
    }
}

impl Settings {
    /// Clamp values to supported choices and make sure built-in targets exist.
    pub fn normalize(mut self) -> Self {
        if !INTERVAL_CHOICES.contains(&self.interval_minutes) {
            self.interval_minutes = 5;
        }
        self.pings_per_test = self.pings_per_test.clamp(1, 20);
        self.timeout_ms = self.timeout_ms.clamp(200, 10_000);
        self.slow_threshold_ms = self.slow_threshold_ms.clamp(5, 5_000);
        for b in builtin_targets() {
            if !self.targets.iter().any(|t| t.id == b.id) {
                self.targets.push(Target { enabled: false, ..b });
            }
        }
        for t in &mut self.targets {
            t.host = t.host.trim().to_string();
            t.label = t.label.trim().to_string();
            if t.label.is_empty() {
                t.label = t.host.clone();
            }
        }
        self.targets.retain(|t| t.kind == TargetKind::Gateway || !t.host.is_empty());
        if self.interface.as_deref() == Some("") {
            self.interface = None;
        }
        self
    }

    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
            .normalize()
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}
