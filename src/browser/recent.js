// Recent projects: persist the picked FileSystemDirectoryHandle in IndexedDB so a
// returning user can re-open with one click. The handle survives reloads, but
// re-opening must re-check / re-request READ permission (a user gesture — the
// button click). Best-effort throughout: any failure degrades to "no recents".
const DB = 'coir', STORE = 'recents', MAX = 8;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const store = (db, mode) => db.transaction(STORE, mode).objectStore(STORE);
const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/** Most-recent-first list of `{ id, name, handle, ts }`. */
export async function listRecent() {
  try { const db = await open(); const all = await reqP(store(db, 'readonly').getAll()); db.close(); return all.sort((a, b) => b.ts - a.ts); }
  catch { return []; }
}

/** Remember a picked directory handle (dedupe by same directory, cap to MAX). */
export async function addRecent(handle) {
  try {
    const db = await open();
    const existing = await reqP(store(db, 'readonly').getAll());
    const dup = [];
    for (const e of existing) { try { if (e.handle && await e.handle.isSameEntry(handle)) dup.push(e.id); } catch { /* ignore */ } }
    const w = store(db, 'readwrite');
    for (const id of dup) w.delete(id);
    await reqP(w.add({ name: handle.name, handle, ts: Date.now() }));
    const after = (await reqP(store(db, 'readonly').getAll())).sort((a, b) => b.ts - a.ts);
    const p = store(db, 'readwrite');
    for (const e of after.slice(MAX)) p.delete(e.id); // drop the oldest beyond MAX
    db.close();
  } catch { /* ignore — recents are best-effort */ }
}

export async function removeRecent(id) {
  try { const db = await open(); store(db, 'readwrite').delete(id); db.close(); } catch { /* ignore */ }
}
