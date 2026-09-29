// 폰 안 저장소 (IndexedDB). 이 기록은 폰 밖으로 나가지 않아요.
const DB = 'swinglab';
const VER = 1;
const STORES = ['kv', 'sessions', 'clips', 'courses'];
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, s === 'kv' ? undefined : { keyPath: 'id' });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const st = tx.objectStore(store);
    let out;
    const req = fn(st);
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const put = (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => run(store, 'readonly', (s) => s.getAll());
export const clearStore = (store) => run(store, 'readwrite', (s) => s.clear());

export async function getKV(key, def = null) {
  try {
    const v = await get('kv', key);
    return v === undefined ? def : v;
  } catch {
    return def;
  }
}
export const setKV = (key, value) => put('kv', value, key);

// 백업: 영상은 빼고 기록만 파일로 만들어요
export async function exportAll() {
  const kvKeys = ['profile', 'slots', 'clubStats', 'windConsent'];
  const kv = {};
  for (const k of kvKeys) kv[k] = await getKV(k);
  return {
    app: 'swinglab',
    version: 1,
    exportedAt: new Date().toISOString(),
    kv,
    sessions: await all('sessions'),
    courses: await all('courses'),
  };
}

export async function importAll(data) {
  if (!data || data.app !== 'swinglab') throw new Error('스윙 랩 백업 파일이 아니에요.');
  for (const [k, v] of Object.entries(data.kv || {})) if (v != null) await setKV(k, v);
  for (const s of data.sessions || []) await put('sessions', s);
  for (const c of data.courses || []) await put('courses', c);
}

export async function wipeAll() {
  for (const s of STORES) await clearStore(s);
}
