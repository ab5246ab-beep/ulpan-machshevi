// @ts-nocheck
/** Cache the ONNX weights in the browser. A song change must not download them again. */

const OPFS_DIR = "ulpan-machshevi";
const MODEL_KEY = "mel_band_roformer_kim_T801.onnx";
const SIZE_KEY = `${MODEL_KEY}.size`;
const IDB_NAME = "ulpan-machshevi-kim";
const CACHE_NAME = "ulpan-machshevi-kim";
const MIN_BYTES = 800 * 1024 * 1024;

export const MODEL_URL =
  "https://github.com/santiquiroz/port-bs-roformer-onnx/releases/download/models-v1.0/mel_band_roformer_kim_T801.onnx";

function purgeLegacyModel() {
  try {
    indexedDB.deleteDatabase("ulpan-machshevi-model");
  } catch {
    /* ignore */
  }
  if ("caches" in globalThis) caches.delete("ulpan-machshevi-model").catch(() => {});
  navigator.storage
    ?.getDirectory?.()
    .then(async (root) => {
      const dir = await root.getDirectoryHandle(OPFS_DIR);
      await dir.removeEntry("bs_roformer_sw_6stem_fp16.onnx").catch(() => {});
      await dir.removeEntry("bs_roformer_sw_6stem_fp16.onnx.size").catch(() => {});
      await dir.removeEntry("bs_roformer_sw_6stem_fp16.onnx.part").catch(() => {});
    })
    .catch(() => {});
}

purgeLegacyModel();

let memory = null;
let flight = null;
let lastProgress = null;
const progressListeners = new Set();
const stateListeners = new Set();

function emitProgress(progress) {
  lastProgress = progress;
  for (const listener of progressListeners) listener(progress);
}

function emitState() {
  for (const listener of stateListeners) listener();
}

export function subscribeModel(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function subscribeProgress(listener) {
  progressListeners.add(listener);
  if (lastProgress) listener(lastProgress);
  return () => progressListeners.delete(listener);
}

async function getDir() {
  if (!navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

async function readSizeFile(dir) {
  try {
    const handle = await dir.getFileHandle(SIZE_KEY);
    const text = (await (await handle.getFile()).text()).trim();
    const size = Number(text);
    return Number.isFinite(size) ? size : 0;
  } catch {
    return 0;
  }
}

async function opfsFile() {
  try {
    const dir = await getDir();
    if (!dir) return null;
    const handle = await dir.getFileHandle(MODEL_KEY);
    const file = await handle.getFile();
    const expected = await readSizeFile(dir);
    if (!expected || file.size !== expected || file.size < MIN_BYTES) return null;
    return file;
  } catch {
    return null;
  }
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("files")) {
        request.result.createObjectStore("files");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

function idbGet(key) {
  return openIdb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("files", "readonly");
        const request = tx.objectStore("files").get(key);
        request.onsuccess = () => {
          db.close();
          resolve(request.result ?? null);
        };
        request.onerror = () => {
          db.close();
          reject(request.error ?? new Error("indexedDB"));
        };
      }),
  );
}

async function idbReady() {
  try {
    const size = await idbGet("size");
    return typeof size === "number" && size >= MIN_BYTES;
  } catch {
    return false;
  }
}

async function cacheHit() {
  if (!("caches" in globalThis)) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(MODEL_URL);
    if (!hit) return false;
    const size = Number(hit.headers.get("content-length")) || 0;
    return size >= MIN_BYTES;
  } catch {
    return false;
  }
}

export async function deleteCachedModel() {
  memory = null;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(OPFS_DIR, { recursive: true });
  } catch {
    /* already gone */
  }
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(IDB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  try {
    if ("caches" in globalThis) await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
  emitState();
}

export async function modelIsCached() {
  if (memory) return true;
  if (await opfsFile()) return true;
  if (await idbReady()) return true;
  return cacheHit();
}

export async function modelState() {
  if (memory) return "ready";
  if (flight) return "downloading";
  if (await modelIsCached()) return "ready";
  if (memory) return "ready";
  if (flight) return "downloading";
  return "missing";
}

async function writeOpfs(bytes) {
  const dir = await getDir();
  if (!dir) return false;
  const handle = await dir.getFileHandle(MODEL_KEY, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Blob([bytes]));
  await writable.close();
  const sizeHandle = await dir.getFileHandle(SIZE_KEY, { create: true });
  const sizeWritable = await sizeHandle.createWritable();
  await sizeWritable.write(String(bytes.byteLength));
  await sizeWritable.close();
  const file = await handle.getFile();
  return file.size === bytes.byteLength;
}

async function writeIdb(bytes) {
  const db = await openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    store.put(bytes.byteLength, "size");
    store.put(bytes, "model");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB"));
  });
  db.close();
  return true;
}

async function writeCache(bytes) {
  if (!("caches" in globalThis)) return false;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    MODEL_URL,
    new Response(new Blob([bytes]), {
      headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
    }),
  );
  return true;
}

async function persist(bytes) {
  try {
    if (await writeOpfs(bytes)) return true;
  } catch (error) {
    console.warn("OPFS model save failed", error);
  }
  try {
    if (await writeIdb(bytes)) return true;
  } catch (error) {
    console.warn("IndexedDB model save failed", error);
  }
  try {
    if (await writeCache(bytes)) return true;
  } catch (error) {
    console.warn("Cache model save failed", error);
  }
  return false;
}

async function readStored() {
  const file = await opfsFile();
  if (file) return new Uint8Array(await file.arrayBuffer());
  try {
    if (await idbReady()) {
      const stored = await idbGet("model");
      if (stored instanceof Uint8Array && stored.byteLength >= MIN_BYTES) return stored;
      if (stored instanceof ArrayBuffer && stored.byteLength >= MIN_BYTES) return new Uint8Array(stored);
    }
  } catch {
    /* try the next store */
  }
  if (!("caches" in globalThis)) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(MODEL_URL);
    if (!hit) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    return bytes.byteLength >= MIN_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

function concat(chunks, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} מ״ב`;
}

function causeText(error) {
  const parts = [];
  let current = error;
  const seen = new Set();
  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : null;
  }
  return parts.join(" ← ");
}

function totalOf(resp, offset) {
  const range = resp.headers.get("content-range");
  if (range && range.includes("/")) {
    const size = Number(range.split("/").pop());
    if (Number.isFinite(size) && size >= MIN_BYTES) return size;
  }
  const len = Number(resp.headers.get("content-length")) || 0;
  if (resp.status === 206) return len ? offset + len : 0;
  return len >= MIN_BYTES ? len : 0;
}

async function openDownload(offset) {
  const errors = [];
  const sources = [
    ["/api/model", "השרת המקומי"],
    [MODEL_URL, "GitHub"],
  ];
  for (const [url, label] of sources) {
    try {
      const headers = {};
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const resp = await fetch(url, { headers, redirect: "follow", cache: "no-store" });
      if (!resp.ok || !resp.body || resp.type === "opaqueredirect" || resp.status === 0) {
        let snippet = "";
        try {
          snippet = (await resp.text()).replace(/\s+/g, " ").slice(0, 160);
        } catch {
          /* body already unusable */
        }
        errors.push(`${label}: סטטוס ${resp.status || "חסום"} ${resp.statusText} ${snippet}`.trim());
        continue;
      }
      const len = Number(resp.headers.get("content-length")) || 0;
      if (resp.status === 200 && len > 0 && len < MIN_BYTES) {
        const text = (await resp.text()).replace(/\s+/g, " ").slice(0, 160);
        errors.push(`${label}: התקבל קובץ של ${len} בייט במקום המודל. ${text}`.trim());
        continue;
      }
      return resp;
    } catch (error) {
      errors.push(`${label}: ${causeText(error)}`);
    }
  }
  throw new Error(`הורדת המודל נכשלה. ${errors.join(" | ")}`);
}

async function partSize(dir) {
  try {
    const handle = await dir.getFileHandle(`${MODEL_KEY}.part`);
    return (await handle.getFile()).size;
  } catch {
    return 0;
  }
}

async function promotePart(dir, size) {
  const partKey = `${MODEL_KEY}.part`;
  const part = await dir.getFileHandle(partKey);
  await dir.removeEntry(MODEL_KEY).catch(() => {});
  if (typeof part.move === "function") {
    await part.move(MODEL_KEY);
  } else {
    const file = await part.getFile();
    const finalHandle = await dir.getFileHandle(MODEL_KEY, { create: true });
    const writable = await finalHandle.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
    await dir.removeEntry(partKey).catch(() => {});
  }
  const sizeHandle = await dir.getFileHandle(SIZE_KEY, { create: true });
  const sizeWritable = await sizeHandle.createWritable();
  await sizeWritable.write(String(size));
  await sizeWritable.close();
}

async function streamInto(resp, offset, write) {
  const total = totalOf(resp, offset);
  const reader = resp.body.getReader();
  let loaded = offset;
  const started = performance.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await write(value);
    loaded += value.byteLength;
    const elapsed = (performance.now() - started) / 1000;
    const etaSec = total && loaded ? (elapsed * (total - loaded)) / loaded : undefined;
    emitProgress({ phase: "download", loaded, total, etaSec });
  }
  return { loaded, total };
}

async function downloadToMemory() {
  let offset = 0;
  const chunks = [];
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await openDownload(offset);
      if (resp.status === 200 && offset > 0) {
        chunks.length = 0;
        offset = 0;
      }
      const { loaded, total } = await streamInto(resp, offset, async (value) => {
        chunks.push(value);
      });
      if (total && loaded + 1024 < total) {
        offset = loaded;
        lastError = new Error(`הקשר נותק אחרי ${mb(loaded)} מתוך ${mb(total)}`);
        continue;
      }
      if (loaded < MIN_BYTES) {
        throw new Error(`הקובץ שירד קטן מדי (${mb(loaded)}). זו לא חבילת המודל.`);
      }
      const bytes = concat(chunks, loaded);
      chunks.length = 0;
      memory = bytes;
      emitProgress({ phase: "download", loaded, total: loaded });
      emitState();
      await persist(bytes);
      emitState();
      return bytes;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("הורדת המודל נכשלה")) throw error;
      if (error instanceof Error && error.message.includes("קטן מדי")) throw error;
      lastError = error;
    }
  }
  throw new Error(`הורדת המודל נקטעה. סיבה: ${causeText(lastError)}`);
}

async function downloadToOpfs(dir) {
  const partKey = `${MODEL_KEY}.part`;
  let offset = await partSize(dir);
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let writable = null;
    try {
      const resp = await openDownload(offset);
      if (resp.status === 200 && offset > 0) {
        await dir.removeEntry(partKey).catch(() => {});
        offset = 0;
      }
      const handle = await dir.getFileHandle(partKey, { create: true });
      writable = await handle.createWritable({ keepExistingData: offset > 0 });
      if (offset > 0 && writable.seek) await writable.seek(offset);
      const { loaded, total } = await streamInto(resp, offset, (value) => writable.write(value));
      await writable.close();
      writable = null;
      const size = await partSize(dir);
      if (total && size + 1024 < total) {
        offset = size;
        lastError = new Error(`הקשר נותק אחרי ${mb(size)} מתוך ${mb(total)}`);
        continue;
      }
      if (size < MIN_BYTES) {
        throw new Error(`הקובץ שירד קטן מדי (${mb(size)}). זו לא חבילת המודל.`);
      }
      await promotePart(dir, size || loaded);
      const file = await (await dir.getFileHandle(MODEL_KEY)).getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      memory = bytes;
      emitProgress({ phase: "download", loaded: bytes.byteLength, total: bytes.byteLength });
      emitState();
      return bytes;
    } catch (error) {
      if (writable) await writable.close().catch(() => {});
      if (error && (error.name === "QuotaExceededError" || /quota/i.test(String(error.message)))) {
        throw new Error(`אין מספיק מקום בדפדפן לשמירת המודל. סיבה: ${causeText(error)}`);
      }
      if (error instanceof Error && error.message.startsWith("הורדת המודל נכשלה")) throw error;
      if (error instanceof Error && error.message.includes("קטן מדי")) throw error;
      lastError = error;
      offset = await partSize(dir).catch(() => offset);
    }
  }
  throw new Error(`הורדת המודל נקטעה. סיבה: ${causeText(lastError)}`);
}

async function download() {
  const dir = await getDir().catch((error) => {
    console.warn("OPFS unavailable", error);
    return null;
  });
  if (!dir) return downloadToMemory();
  try {
    return await downloadToOpfs(dir);
  } catch (error) {
    if (error instanceof Error && error.message.includes("אין מספיק מקום")) throw error;
    console.warn("OPFS download failed, keeping the file in memory", error);
    try {
      return await downloadToMemory();
    } catch (memoryError) {
      throw new Error(`${error instanceof Error ? error.message : causeText(error)} | זיכרון: ${causeText(memoryError)}`);
    }
  }
}

export async function getModelBytes({ onProgress } = {}) {
  const stop = onProgress ? subscribeProgress(onProgress) : () => {};
  try {
    if (!memory) {
      const stored = await readStored();
      if (stored) memory = stored;
    }
    if (memory) {
      emitState();
      return { bytes: memory, persisted: true };
    }
    if (!flight) {
      flight = download().finally(() => {
        flight = null;
        emitState();
      });
      emitState();
    }
    const bytes = await flight;
    return { bytes, persisted: true };
  } finally {
    stop();
  }
}
