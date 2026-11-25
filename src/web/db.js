// Small promise wrapper around IndexedDB for the web version.
//   results: one row per test per target, auto-increment id, indexed by ts
//   kv:      settings and scheduler state

const DB_NAME = "pingtracker";

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
});

export function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const results = db.createObjectStore("results", { keyPath: "id", autoIncrement: true });
      results.createIndex("ts", "ts");
      db.createObjectStore("kv");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("Close other PingTracker tabs and reload"));
  });
}

export async function kvGet(db, key) {
  return req(db.transaction("kv").objectStore("kv").get(key));
}

export async function kvSet(db, key, value) {
  const tx = db.transaction("kv", "readwrite");
  tx.objectStore("kv").put(value, key);
  await done(tx);
}

export async function addRows(db, rows) {
  const tx = db.transaction("results", "readwrite");
  const store = tx.objectStore("results");
  const out = rows.map((r) => ({ ...r }));
  out.forEach((r) => {
    store.add(r).onsuccess = (e) => (r.id = e.target.result);
  });
  await done(tx);
  return out;
}

export async function rowsInRange(db, from, to) {
  const idx = db.transaction("results").objectStore("results").index("ts");
  return req(idx.getAll(IDBKeyRange.bound(from, to)));
}

export async function recentRows(db, limit) {
  const idx = db.transaction("results").objectStore("results").index("ts");
  const out = [];
  return new Promise((resolve, reject) => {
    const c = idx.openCursor(null, "prev");
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur || out.length >= limit) return resolve(out);
      out.push(cur.value);
      cur.continue();
    };
    c.onerror = () => reject(c.error);
  });
}

export async function countRows(db) {
  return req(db.transaction("results").objectStore("results").count());
}

export async function clearRows(db) {
  const n = await countRows(db);
  const tx = db.transaction("results", "readwrite");
  tx.objectStore("results").clear();
  await done(tx);
  return n;
}

export async function pruneBefore(db, ts) {
  const tx = db.transaction("results", "readwrite");
  const idx = tx.objectStore("results").index("ts");
  const c = idx.openKeyCursor(IDBKeyRange.upperBound(ts, true));
  c.onsuccess = () => {
    const cur = c.result;
    if (!cur) return;
    tx.objectStore("results").delete(cur.primaryKey);
    cur.continue();
  };
  await done(tx);
}
