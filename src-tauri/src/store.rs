//! Local SQLite history of ping tests.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct PingResult {
    pub id: i64,
    /// Unix epoch milliseconds.
    pub ts: i64,
    pub target_id: String,
    pub target_label: String,
    pub host: String,
    pub ip: Option<String>,
    pub interface: Option<String>,
    pub sent: u32,
    pub received: u32,
    pub loss: f64,
    pub min_ms: Option<f64>,
    pub avg_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesPoint {
    pub target_id: String,
    pub ts: i64,
    pub avg_ms: Option<f64>,
    pub min_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub loss: f64,
    pub tests: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Series {
    pub bucket_ms: i64,
    pub points: Vec<SeriesPoint>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetSummary {
    pub target_id: String,
    pub target_label: String,
    pub tests: u32,
    pub failed_tests: u32,
    pub sent: u64,
    pub received: u64,
    pub loss: f64,
    pub avg_ms: Option<f64>,
    pub median_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub min_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub last: Option<PingResult>,
}

pub struct Store {
    conn: Connection,
}

const COLS: &str = "id, ts, target_id, target_label, host, ip, interface, sent, received, loss, min_ms, avg_ms, max_ms, jitter_ms, error";

fn row_to_result(r: &rusqlite::Row) -> rusqlite::Result<PingResult> {
    Ok(PingResult {
        id: r.get(0)?,
        ts: r.get(1)?,
        target_id: r.get(2)?,
        target_label: r.get(3)?,
        host: r.get(4)?,
        ip: r.get(5)?,
        interface: r.get(6)?,
        sent: r.get(7)?,
        received: r.get(8)?,
        loss: r.get(9)?,
        min_ms: r.get(10)?,
        avg_ms: r.get(11)?,
        max_ms: r.get(12)?,
        jitter_ms: r.get(13)?,
        error: r.get(14)?,
    })
}

fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (p / 100.0) * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    Some(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64))
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                target_id TEXT NOT NULL,
                target_label TEXT NOT NULL,
                host TEXT NOT NULL,
                ip TEXT,
                interface TEXT,
                sent INTEGER NOT NULL,
                received INTEGER NOT NULL,
                loss REAL NOT NULL,
                min_ms REAL,
                avg_ms REAL,
                max_ms REAL,
                jitter_ms REAL,
                error TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_results_ts ON results(ts);
             CREATE INDEX IF NOT EXISTS idx_results_target_ts ON results(target_id, ts);",
        )?;
        Ok(Store { conn })
    }

    pub fn insert(&self, r: &mut PingResult) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO results (ts, target_id, target_label, host, ip, interface, sent, received, loss, min_ms, avg_ms, max_ms, jitter_ms, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![r.ts, r.target_id, r.target_label, r.host, r.ip, r.interface, r.sent, r.received, r.loss, r.min_ms, r.avg_ms, r.max_ms, r.jitter_ms, r.error],
        )?;
        r.id = self.conn.last_insert_rowid();
        Ok(())
    }

    pub fn recent(&self, limit: u32, target: Option<&str>) -> rusqlite::Result<Vec<PingResult>> {
        let sql = format!(
            "SELECT {COLS} FROM results WHERE (?1 IS NULL OR target_id = ?1) ORDER BY ts DESC, id DESC LIMIT ?2"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![target, limit], row_to_result)?;
        rows.collect()
    }

    pub fn range(&self, from: i64, to: i64) -> rusqlite::Result<Vec<PingResult>> {
        let sql = format!("SELECT {COLS} FROM results WHERE ts >= ?1 AND ts <= ?2 ORDER BY ts, id");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![from, to], row_to_result)?;
        rows.collect()
    }

    pub fn last_for(&self, target_id: &str) -> rusqlite::Result<Option<PingResult>> {
        let sql = format!("SELECT {COLS} FROM results WHERE target_id = ?1 ORDER BY ts DESC, id DESC LIMIT 1");
        self.conn.query_row(&sql, params![target_id], row_to_result).optional()
    }

    /// Time series bucketed so that no more than `max_points` buckets are returned per target.
    pub fn series(&self, from: i64, to: i64, max_points: u32) -> rusqlite::Result<Series> {
        let span = (to - from).max(1);
        let bucket_ms = (span / max_points.max(1) as i64).max(1);
        let mut stmt = self.conn.prepare(
            "SELECT target_id, (ts / ?3) * ?3 AS bucket, AVG(avg_ms), MIN(min_ms), MAX(max_ms),
                    SUM(sent), SUM(received), COUNT(*)
             FROM results WHERE ts >= ?1 AND ts <= ?2
             GROUP BY target_id, bucket ORDER BY bucket",
        )?;
        let rows = stmt.query_map(params![from, to, bucket_ms], |r| {
            let sent: i64 = r.get(5)?;
            let received: i64 = r.get(6)?;
            let count: i64 = r.get(7)?;
            Ok(SeriesPoint {
                target_id: r.get(0)?,
                ts: r.get(1)?,
                avg_ms: r.get(2)?,
                min_ms: r.get(3)?,
                max_ms: r.get(4)?,
                loss: if sent > 0 { 100.0 * (sent - received) as f64 / sent as f64 } else { 100.0 },
                tests: count as u32,
            })
        })?;
        Ok(Series { bucket_ms, points: rows.collect::<rusqlite::Result<_>>()? })
    }

    pub fn summary(&self, from: i64, to: i64) -> rusqlite::Result<Vec<TargetSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT target_id, target_label, sent, received, min_ms, avg_ms, max_ms, jitter_ms
             FROM results WHERE ts >= ?1 AND ts <= ?2 ORDER BY ts",
        )?;
        struct Acc {
            label: String,
            tests: u32,
            failed: u32,
            sent: u64,
            received: u64,
            avgs: Vec<f64>,
            min: Option<f64>,
            max: Option<f64>,
            jit: Vec<f64>,
        }
        let mut map: BTreeMap<String, Acc> = BTreeMap::new();
        let mut rows = stmt.query(params![from, to])?;
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let label: String = r.get(1)?;
            let a = map.entry(id).or_insert_with(|| Acc {
                label: label.clone(),
                tests: 0,
                failed: 0,
                sent: 0,
                received: 0,
                avgs: vec![],
                min: None,
                max: None,
                jit: vec![],
            });
            a.label = label;
            a.tests += 1;
            let sent: u32 = r.get(2)?;
            let received: u32 = r.get(3)?;
            a.sent += sent as u64;
            a.received += received as u64;
            if received == 0 {
                a.failed += 1;
            }
            if let Some(v) = r.get::<_, Option<f64>>(4)? {
                a.min = Some(a.min.map_or(v, |m| m.min(v)));
            }
            if let Some(v) = r.get::<_, Option<f64>>(5)? {
                a.avgs.push(v);
            }
            if let Some(v) = r.get::<_, Option<f64>>(6)? {
                a.max = Some(a.max.map_or(v, |m| m.max(v)));
            }
            if let Some(v) = r.get::<_, Option<f64>>(7)? {
                a.jit.push(v);
            }
        }
        drop(rows);
        let mut out = vec![];
        for (id, mut a) in map {
            a.avgs.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
            let mean = |v: &[f64]| if v.is_empty() { None } else { Some(v.iter().sum::<f64>() / v.len() as f64) };
            out.push(TargetSummary {
                last: self.last_for(&id)?,
                target_id: id,
                target_label: a.label,
                tests: a.tests,
                failed_tests: a.failed,
                sent: a.sent,
                received: a.received,
                loss: if a.sent > 0 { 100.0 * (a.sent - a.received) as f64 / a.sent as f64 } else { 0.0 },
                avg_ms: mean(&a.avgs),
                median_ms: percentile(&a.avgs, 50.0),
                p95_ms: percentile(&a.avgs, 95.0),
                min_ms: a.min,
                max_ms: a.max,
                jitter_ms: mean(&a.jit),
            });
        }
        Ok(out)
    }

    pub fn prune(&self, before_ts: i64) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM results WHERE ts < ?1", params![before_ts])
    }

    pub fn clear(&self) -> rusqlite::Result<usize> {
        let n = self.conn.execute("DELETE FROM results", [])?;
        let _ = self.conn.execute_batch("VACUUM");
        Ok(n)
    }

    pub fn count(&self) -> rusqlite::Result<i64> {
        self.conn.query_row("SELECT COUNT(*) FROM results", [], |r| r.get(0))
    }
}

pub fn to_csv(rows: &[PingResult]) -> String {
    fn esc(s: &str) -> String {
        if s.contains([',', '"', '\n']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    }
    let f = |v: Option<f64>| v.map(|x| format!("{x:.3}")).unwrap_or_default();
    let mut out = String::from("timestamp,target,host,ip,interface,sent,received,loss_pct,min_ms,avg_ms,max_ms,jitter_ms,error\n");
    for r in rows {
        let ts = chrono::DateTime::from_timestamp_millis(r.ts)
            .map(|d| d.with_timezone(&chrono::Local).to_rfc3339())
            .unwrap_or_default();
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{:.1},{},{},{},{},{}\n",
            ts,
            esc(&r.target_label),
            esc(&r.host),
            r.ip.clone().unwrap_or_default(),
            esc(&r.interface.clone().unwrap_or_default()),
            r.sent,
            r.received,
            r.loss,
            f(r.min_ms),
            f(r.avg_ms),
            f(r.max_ms),
            f(r.jitter_ms),
            esc(&r.error.clone().unwrap_or_default()),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(ts: i64, target: &str, avg: Option<f64>, received: u32) -> PingResult {
        PingResult {
            id: 0,
            ts,
            target_id: target.into(),
            target_label: target.into(),
            host: "1.1.1.1".into(),
            ip: Some("1.1.1.1".into()),
            interface: None,
            sent: 4,
            received,
            loss: 100.0 * (4 - received) as f64 / 4.0,
            min_ms: avg,
            avg_ms: avg,
            max_ms: avg,
            jitter_ms: avg.map(|_| 1.0),
            error: None,
        }
    }

    #[test]
    fn roundtrip_and_summary() {
        let s = Store::memory().unwrap();
        for i in 0..10 {
            s.insert(&mut sample(i * 60_000, "a", Some(10.0 + i as f64), 4)).unwrap();
        }
        s.insert(&mut sample(11 * 60_000, "a", None, 0)).unwrap();
        s.insert(&mut sample(5 * 60_000, "b", Some(30.0), 2)).unwrap();
        assert_eq!(s.count().unwrap(), 12);
        let sum = s.summary(0, 1_000_000).unwrap();
        let a = sum.iter().find(|t| t.target_id == "a").unwrap();
        assert_eq!(a.tests, 11);
        assert_eq!(a.failed_tests, 1);
        assert_eq!(a.min_ms, Some(10.0));
        assert_eq!(a.max_ms, Some(19.0));
        assert!((a.avg_ms.unwrap() - 14.5).abs() < 1e-9);
        assert!((a.loss - 100.0 * 4.0 / 44.0).abs() < 1e-9);
        assert_eq!(a.last.as_ref().unwrap().ts, 11 * 60_000);

        let series = s.series(0, 12 * 60_000, 4).unwrap();
        assert_eq!(series.bucket_ms, 3 * 60_000);
        assert!(series.points.iter().filter(|p| p.target_id == "a").count() <= 5);

        assert_eq!(s.recent(3, Some("a")).unwrap().len(), 3);
        assert_eq!(s.prune(5 * 60_000).unwrap(), 5);
        assert!(to_csv(&s.range(0, i64::MAX).unwrap()).lines().count() == 8);
        s.clear().unwrap();
        assert_eq!(s.count().unwrap(), 0);
    }
}
