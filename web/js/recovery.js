// Crash safety: right after every change, a copy of the open project goes into the browser's own storage (IndexedDB).
// It is removed once the server has the change on disk, so if PlanCraft, the browser or the PC goes down in between,
// the next time the project opens the copy is still there and can be recovered.

const DB_NAME = 'plancraft';
const STORE = 'drafts';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(err => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

async function run(mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined;       // storage blocked (private window, disk full): autosave still works, just no extra copy
  }
}

/** Keep a copy of the project as it is right now. */
export const putDraft = project => run('readwrite', s => s.put({ id: project.id, at: Date.now(), json: JSON.stringify(project) }));

/** The copy, if one is left over from a session that did not finish saving. */
export const getDraft = id => run('readonly', s => s.get(id));

export const dropDraft = id => run('readwrite', s => s.delete(id));

/** Same project content, ignoring the save time stamp. */
export function sameContent(a, b) {
  const strip = p => JSON.stringify({ ...p, modified: null });
  return strip(a) === strip(b);
}
