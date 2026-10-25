// Device storage: IndexedDB for candles, localStorage for settings and the test.
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('tradelab', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbp;
}
export async function idbGet(key) {
  const d = await db(); if (!d) return memory.get(key);
  return new Promise(res => {
    try {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => res(undefined);
    } catch { res(memory.get(key)); }
  });
}
export async function idbSet(key, val) {
  const d = await db(); if (!d) { memory.set(key, val); return; }
  return new Promise(res => {
    try {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => res();
    } catch { memory.set(key, val); res(); }
  });
}
export async function idbClear() {
  const d = await db(); memory.clear(); if (!d) return;
  return new Promise(res => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').clear(); tx.oncomplete = () => res(); tx.onerror = () => res(); });
}
const memory = new Map();

// demo mode keeps its own separate world of saved state
let prefix = 'tl:';
export function setDemoStorage(on) { prefix = on ? 'tl:demo:' : 'tl:'; }
const GLOBAL = new Set(['theme', 'demo', 'pendingJoin']);
const k = key => (GLOBAL.has(key) ? 'tl:' : prefix) + key;

export function load(key, fallback) {
  try { const v = localStorage.getItem(k(key)); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function save(key, val) {
  try { localStorage.setItem(k(key), JSON.stringify(val)); } catch { /* storage blocked */ }
}
export function remove(key) { try { localStorage.removeItem(k(key)); } catch { /* */ } }
