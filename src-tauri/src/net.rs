//! Network interface discovery and default-gateway lookup.

use crate::ping::Binding;
use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Debug, Clone, Serialize)]
pub struct NetInterface {
    /// Stable id we persist in settings (the OS interface name).
    pub id: String,
    pub label: String,
    pub ipv4: Vec<String>,
    pub gateway: Option<String>,
    pub is_default: bool,
}

fn label_for(i: &netdev::Interface) -> String {
    let friendly = i.friendly_name.clone().filter(|s| !s.is_empty());
    match (friendly, i.description.clone().filter(|s| !s.is_empty())) {
        (Some(f), _) if f != i.name => f,
        (_, Some(d)) if cfg!(windows) => d,
        _ => i.name.clone(),
    }
}

/// Interfaces that are up, not loopback and have an IPv4 address.
pub fn list_interfaces() -> Vec<NetInterface> {
    let mut out: Vec<NetInterface> = netdev::get_interfaces()
        .into_iter()
        .filter(|i| i.is_up() && !i.is_loopback() && !i.ipv4.is_empty())
        .map(|i| NetInterface {
            id: i.name.clone(),
            label: label_for(&i),
            ipv4: i.ipv4.iter().map(|n| n.addr().to_string()).collect(),
            gateway: i.gateway.as_ref().and_then(|g| g.ipv4.first()).map(|g| g.to_string()),
            is_default: i.default,
        })
        .collect();
    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.label.cmp(&b.label)));
    out
}

/// Binding (index, name, source address) for the interface with the given id.
pub fn binding_for(id: Option<&str>) -> Result<Binding, String> {
    let Some(id) = id.filter(|s| !s.is_empty()) else {
        return Ok(Binding::default());
    };
    let iface = netdev::get_interfaces()
        .into_iter()
        .find(|i| i.name == id)
        .ok_or_else(|| format!("Network interface {id} is not available"))?;
    Ok(Binding {
        name: Some(iface.name.clone()),
        index: Some(iface.index),
        source_v4: iface.ipv4.first().map(|n| n.addr()),
    })
}

/// Default gateway, either for a specific interface or the system default route.
pub fn gateway_for(id: Option<&str>) -> Option<Ipv4Addr> {
    if let Some(id) = id.filter(|s| !s.is_empty()) {
        return netdev::get_interfaces()
            .into_iter()
            .find(|i| i.name == id)
            .and_then(|i| i.gateway)
            .and_then(|g| g.ipv4.first().cloned());
    }
    if let Ok(gw) = netdev::get_default_gateway() {
        if let Some(ip) = gw.ipv4.first() {
            return Some(*ip);
        }
    }
    netdev::get_default_interface()
        .ok()
        .and_then(|i| i.gateway)
        .and_then(|g| g.ipv4.first().cloned())
}
