//! ICMP echo ("ping") that works without administrator rights.
//!
//! * macOS / Linux: unprivileged `SOCK_DGRAM` ICMP sockets (falls back to a raw
//!   socket when running as root on Linux systems that disallow datagram ICMP).
//! * Windows: the `IcmpSendEcho2Ex` API from iphlpapi, which never needs admin.

use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

/// How to send the probe out of a specific network interface.
#[derive(Debug, Clone, Default)]
pub struct Binding {
    /// OS interface name (e.g. `en0`, or the adapter GUID on Windows).
    #[allow(dead_code)]
    pub name: Option<String>,
    /// OS interface index.
    #[allow(dead_code)]
    pub index: Option<u32>,
    /// IPv4 source address that belongs to the interface.
    pub source_v4: Option<std::net::Ipv4Addr>,
}

#[derive(Debug, Clone)]
pub struct PingSummary {
    pub ip: Option<IpAddr>,
    pub sent: u32,
    pub received: u32,
    pub rtts_ms: Vec<f64>,
    pub error: Option<String>,
}

impl PingSummary {
    pub fn loss_pct(&self) -> f64 {
        if self.sent == 0 {
            return 100.0;
        }
        100.0 * (self.sent - self.received) as f64 / self.sent as f64
    }
    pub fn min(&self) -> Option<f64> {
        self.rtts_ms.iter().cloned().reduce(f64::min)
    }
    pub fn max(&self) -> Option<f64> {
        self.rtts_ms.iter().cloned().reduce(f64::max)
    }
    pub fn avg(&self) -> Option<f64> {
        if self.rtts_ms.is_empty() {
            None
        } else {
            Some(self.rtts_ms.iter().sum::<f64>() / self.rtts_ms.len() as f64)
        }
    }
    /// Mean absolute difference between consecutive replies (RFC 3550 style jitter).
    pub fn jitter(&self) -> Option<f64> {
        if self.rtts_ms.len() < 2 {
            return None;
        }
        let diffs: Vec<f64> = self.rtts_ms.windows(2).map(|w| (w[1] - w[0]).abs()).collect();
        Some(diffs.iter().sum::<f64>() / diffs.len() as f64)
    }
}

/// Resolve a host name or literal address. Prefers IPv4 (Windows only supports IPv4 here).
pub fn resolve(host: &str) -> Result<IpAddr, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(ip);
    }
    let addrs: Vec<IpAddr> = (host, 0)
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve {host}: {e}"))?
        .map(|a| a.ip())
        .collect();
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.first())
        .cloned()
        .ok_or_else(|| format!("Could not resolve {host}"))
}

/// Ping `host` `count` times, blocking. Each probe waits up to `timeout`.
pub fn ping_host(host: &str, count: u32, timeout: Duration, binding: &Binding) -> PingSummary {
    let ip = match resolve(host) {
        Ok(ip) => ip,
        Err(e) => {
            return PingSummary { ip: None, sent: 0, received: 0, rtts_ms: vec![], error: Some(e) }
        }
    };
    let mut summary = PingSummary { ip: Some(ip), sent: 0, received: 0, rtts_ms: vec![], error: None };
    let mut pinger = match imp::Pinger::new(ip, binding) {
        Ok(p) => p,
        Err(e) => {
            summary.error = Some(e);
            return summary;
        }
    };
    let gap = Duration::from_millis(250);
    for seq in 0..count {
        summary.sent += 1;
        match pinger.echo(seq as u16, timeout) {
            Ok(Some(rtt)) => {
                summary.received += 1;
                summary.rtts_ms.push(rtt.as_secs_f64() * 1000.0);
            }
            Ok(None) => {}
            Err(e) => {
                summary.error = Some(e);
                break;
            }
        }
        if seq + 1 < count {
            std::thread::sleep(gap);
        }
    }
    if summary.received == 0 && summary.error.is_none() {
        summary.error = Some("Request timed out".into());
    }
    summary
}

#[cfg(unix)]
mod imp {
    use super::Binding;
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::io::ErrorKind;
    use std::mem::MaybeUninit;
    use std::net::{IpAddr, SocketAddr};
    use std::time::{Duration, Instant};

    pub struct Pinger {
        socket: Socket,
        dest: SockAddr,
        v6: bool,
        raw: bool,
        ident: u16,
        token: [u8; 8],
    }

    fn checksum(data: &[u8]) -> u16 {
        let mut sum: u32 = 0;
        for chunk in data.chunks(2) {
            let word = if chunk.len() == 2 {
                u16::from_be_bytes([chunk[0], chunk[1]]) as u32
            } else {
                (chunk[0] as u32) << 8
            };
            sum = sum.wrapping_add(word);
        }
        while sum >> 16 != 0 {
            sum = (sum & 0xffff) + (sum >> 16);
        }
        !(sum as u16)
    }

    impl Pinger {
        pub fn new(ip: IpAddr, binding: &Binding) -> Result<Self, String> {
            let v6 = ip.is_ipv6();
            let (domain, proto) = if v6 {
                (Domain::IPV6, Protocol::ICMPV6)
            } else {
                (Domain::IPV4, Protocol::ICMPV4)
            };
            let (socket, raw) = match Socket::new(domain, Type::DGRAM, Some(proto)) {
                Ok(s) => (s, false),
                Err(dgram_err) => match Socket::new(domain, Type::RAW, Some(proto)) {
                    Ok(s) => (s, true),
                    Err(_) => return Err(format!("Cannot open ICMP socket: {dgram_err}")),
                },
            };

            // Pin traffic to the chosen interface.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let Some(idx) = binding.index.and_then(std::num::NonZeroU32::new) {
                let r = if v6 {
                    socket.bind_device_by_index_v6(Some(idx))
                } else {
                    socket.bind_device_by_index_v4(Some(idx))
                };
                r.map_err(|e| format!("Cannot bind to interface: {e}"))?;
            }
            #[cfg(any(target_os = "linux", target_os = "android"))]
            if let Some(name) = &binding.name {
                // SO_BINDTODEVICE needs CAP_NET_RAW; fall back to source-address binding.
                let _ = socket.bind_device(Some(name.as_bytes()));
            }
            if !v6 {
                if let Some(src) = binding.source_v4 {
                    socket
                        .bind(&SocketAddr::new(IpAddr::V4(src), 0).into())
                        .map_err(|e| format!("Cannot bind to {src}: {e}"))?;
                }
            }

            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            let ident = (std::process::id() as u16) ^ (nanos as u16);
            Ok(Pinger { socket, dest: SocketAddr::new(ip, 0).into(), v6, raw, ident, token: nanos.to_be_bytes() })
        }

        fn packet(&self, seq: u16) -> Vec<u8> {
            let mut p = vec![if self.v6 { 128 } else { 8 }, 0, 0, 0];
            p.extend_from_slice(&self.ident.to_be_bytes());
            p.extend_from_slice(&seq.to_be_bytes());
            p.extend_from_slice(&self.token);
            p.extend_from_slice(b"PingTracker-payload-0123456789ab");
            if !self.v6 {
                // The kernel fills in the ICMPv6 checksum (it needs the pseudo-header).
                let c = checksum(&p);
                p[2..4].copy_from_slice(&c.to_be_bytes());
            }
            p
        }

        /// Returns Ok(Some(rtt)) on reply, Ok(None) on timeout.
        pub fn echo(&mut self, seq: u16, timeout: Duration) -> Result<Option<Duration>, String> {
            let pkt = self.packet(seq);
            let start = Instant::now();
            if let Err(e) = self.socket.send_to(&pkt, &self.dest) {
                return match e.kind() {
                    // Transient network errors count as a lost packet, not a fatal error.
                    ErrorKind::WouldBlock | ErrorKind::TimedOut => Ok(None),
                    _ if matches!(e.raw_os_error(), Some(50 | 51 | 64 | 65 | 101 | 113)) => Ok(None),
                    _ => Err(format!("Send failed: {e}")),
                };
            }
            let deadline = start + timeout;
            let mut buf = [MaybeUninit::<u8>::uninit(); 2048];
            loop {
                let now = Instant::now();
                if now >= deadline {
                    return Ok(None);
                }
                self.socket
                    .set_read_timeout(Some(deadline - now))
                    .map_err(|e| e.to_string())?;
                let n = match self.socket.recv(&mut buf) {
                    Ok(n) => n,
                    Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {
                        continue
                    }
                    Err(e) => return Err(format!("Receive failed: {e}")),
                };
                let data: Vec<u8> = buf[..n].iter().map(|b| unsafe { b.assume_init() }).collect();
                if self.matches(&data, seq) {
                    return Ok(Some(start.elapsed()));
                }
            }
        }

        fn matches(&self, data: &[u8], seq: u16) -> bool {
            let mut icmp = data;
            // IPv4 sockets on macOS (and raw sockets everywhere) include the IP header.
            if !self.v6 && !icmp.is_empty() && icmp[0] >> 4 == 4 {
                let ihl = ((icmp[0] & 0x0f) as usize) * 4;
                if icmp.len() < ihl {
                    return false;
                }
                icmp = &icmp[ihl..];
            }
            if icmp.len() < 16 {
                return false;
            }
            let reply_type = if self.v6 { 129 } else { 0 };
            if icmp[0] != reply_type {
                return false;
            }
            let r_seq = u16::from_be_bytes([icmp[6], icmp[7]]);
            // Linux datagram sockets rewrite the identifier, so match on seq + our token.
            let id_ok = !self.raw || u16::from_be_bytes([icmp[4], icmp[5]]) == self.ident;
            id_ok && r_seq == seq && icmp[8..16] == self.token
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::Binding;
    use std::net::IpAddr;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho2Ex, ICMP_ECHO_REPLY,
    };

    pub struct Pinger {
        handle: HANDLE,
        dest: u32,
        source: u32,
    }

    impl Drop for Pinger {
        fn drop(&mut self) {
            unsafe {
                IcmpCloseHandle(self.handle);
            }
        }
    }

    impl Pinger {
        pub fn new(ip: IpAddr, binding: &Binding) -> Result<Self, String> {
            let dest = match ip {
                IpAddr::V4(v4) => u32::from_ne_bytes(v4.octets()),
                IpAddr::V6(_) => return Err("IPv6 targets are not supported on Windows yet".into()),
            };
            let source = binding.source_v4.map(|s| u32::from_ne_bytes(s.octets())).unwrap_or(0);
            let handle = unsafe { IcmpCreateFile() };
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                return Err("IcmpCreateFile failed".into());
            }
            Ok(Pinger { handle, dest, source })
        }

        pub fn echo(&mut self, _seq: u16, timeout: Duration) -> Result<Option<Duration>, String> {
            let payload = b"PingTracker-payload-0123456789ab";
            let reply_size = std::mem::size_of::<ICMP_ECHO_REPLY>() + payload.len() + 8 + 64;
            let mut reply = vec![0u8; reply_size];
            let start = std::time::Instant::now();
            let n = unsafe {
                IcmpSendEcho2Ex(
                    self.handle,
                    std::ptr::null_mut(),
                    None,
                    std::ptr::null(),
                    self.source,
                    self.dest,
                    payload.as_ptr() as *const _,
                    payload.len() as u16,
                    std::ptr::null(),
                    reply.as_mut_ptr() as *mut _,
                    reply_size as u32,
                    timeout.as_millis().max(1) as u32,
                )
            };
            let elapsed = start.elapsed();
            if n == 0 {
                return Ok(None);
            }
            let r: ICMP_ECHO_REPLY = unsafe { std::ptr::read_unaligned(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
            if r.Status != 0 {
                return Ok(None);
            }
            // RoundTripTime only has 1 ms resolution; use our own timer when it is finer.
            let api = Duration::from_millis(r.RoundTripTime as u64);
            let rtt = if elapsed < api + Duration::from_millis(1) { elapsed } else { api };
            Ok(Some(rtt))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_ping() {
        let s = ping_host("127.0.0.1", 3, Duration::from_secs(1), &Binding::default());
        assert_eq!(s.sent, 3);
        assert_eq!(s.received, 3, "error: {:?}", s.error);
        assert!(s.avg().unwrap() < 50.0);
    }

    #[test]
    fn stats() {
        let s = PingSummary { ip: None, sent: 4, received: 3, rtts_ms: vec![10.0, 20.0, 15.0], error: None };
        assert_eq!(s.loss_pct(), 25.0);
        assert_eq!(s.min(), Some(10.0));
        assert_eq!(s.max(), Some(20.0));
        assert_eq!(s.avg(), Some(15.0));
        assert_eq!(s.jitter(), Some(7.5));
    }
}
