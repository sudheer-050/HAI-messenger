// Persistent cache for the vosk model blob.
//
// The service worker uses fetch(req, { cache: 'no-store' }) for all requests,
// so HTTP cache and SW cache cannot store the model between sessions. We manage
// caching ourselves: first download goes to IndexedDB, subsequent sessions read
// from IDB and create a blob URL that bypasses the SW entirely.
//
// DB: 'hai-voice-v1', store: 'blobs', key: model filename.

const DB_NAME = 'hai-voice-v1';
const STORE = 'blobs';
const MODEL_KEY = 'vosk-model-small-en-us-0.15.tar.gz';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

export async function getCachedModel() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE).objectStore(STORE).get(MODEL_KEY);
        req.onsuccess = e => resolve(e.target.result ?? null);
        req.onerror = e => reject(e.target.error);
    });
}

export async function setCachedModel(blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).put(blob, MODEL_KEY);
        req.onsuccess = () => resolve();
        req.onerror = e => reject(e.target.error);
    });
}

// Returns true if the model blob is already stored — lets callers skip the
// "Downloading 40 MB…" indicator and show a shorter "Initializing…" instead.
export async function isModelCached() {
    try {
        const db = await openDb();
        return new Promise(resolve => {
            const req = db.transaction(STORE).objectStore(STORE).count(MODEL_KEY);
            req.onsuccess = e => resolve(e.target.result > 0);
            req.onerror = () => resolve(false);
        });
    } catch {
        return false;
    }
}
