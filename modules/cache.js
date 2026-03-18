/**
 * GSVI Inline TTS Extension Cache and Persistent Storage
 */

import { LOG } from "./constants.js";
import { getSettings } from "./settings.js";
import { hashKey, uploadAudioToST } from "./utils.js";
import { generateAudio } from "./api.js";

/** @type {Map<string, { blob?: Blob, url: string, isServerPath?: boolean }>} hash → audio data */
export const audioCache = new Map();

/** @type {Map<string, Promise>} hash → pending generation promise */
export const pendingGenerations = new Map();

export let currentGenerations = 0;

const IDB_NAME = "gsvi_tts_cache";
const IDB_STORE = "audio";
let _idb = null;

async function openIDB() {
    if (_idb) return _idb;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            e.target.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
        req.onerror = (e) => reject(e.target.error);
    });
}

export async function idbGet(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

export async function idbSet(key, blob) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { }
}

export async function idbDelete(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { }
}

/**
 * Warm the in-memory audio cache from IndexedDB for a given set of keys.
 * Called after messages are rendered to pre-load previously generated audio.
 */
export async function warmCacheFromIDB(keys) {
    for (const key of keys) {
        if (audioCache.has(key)) continue;
        const blob = await idbGet(key);
        if (blob) {
            const url = URL.createObjectURL(blob);
            audioCache.set(key, { blob, url });
            console.debug(`${LOG} Loaded from IDB: ${key}`);
        }
    }
}

/**
 * Generate audio with concurrency control and caching.
 * Returns cached result if available.
 */
export async function generateWithCache(text, voiceId, emotion, langOverride) {
    const key = hashKey(text, voiceId, emotion);

    // 1. In-memory cache
    if (audioCache.has(key)) {
        return { ...audioCache.get(key), key };
    }

    // 2. IndexedDB persistent cache
    const persisted = await idbGet(key);
    if (persisted) {
        const url = URL.createObjectURL(persisted);
        audioCache.set(key, { blob: persisted, url });
        return { blob: persisted, url, key };
    }

    // 3. Check pending
    if (pendingGenerations.has(key)) {
        await pendingGenerations.get(key);
        if (audioCache.has(key)) {
            return { ...audioCache.get(key), key };
        }
    }

    // 4. Wait for concurrency slot
    const s = getSettings();
    while (currentGenerations >= s.maxConcurrent) {
        await new Promise(r => setTimeout(r, 100));
    }

    currentGenerations++;

    const promise = generateAudio(text, voiceId, emotion, langOverride)
        .then(async result => {
            audioCache.set(key, result);
            // 1. Persist to IDB for future page loads
            if (result.blob) await idbSet(key, result.blob);
            // 2. Optionally upload to SillyTavern server
            const s = getSettings();
            if (s.saveToServer && result.blob) {
                try {
                    const serverPath = await uploadAudioToST(result.blob, text, voiceId, emotion);
                    result.serverPath = serverPath;
                } catch (err) {
                    console.warn(`${LOG} Server upload failed:`, err);
                }
            }
            return result;
        })
        .finally(() => {
            currentGenerations--;
            pendingGenerations.delete(key);
        });

    pendingGenerations.set(key, promise);

    const result = await promise;
    return { ...result, key };
}
