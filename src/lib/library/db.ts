export type LibraryId = "vocals" | "playback";

export type LibraryNode = {
  id: string;
  library: LibraryId;
  parentId: string | null;
  kind: "folder" | "file";
  name: string;
  createdAt: number;
  durationSec?: number;
};

const DB_NAME = "ulpan-machshevi";
const DB_VERSION = 1;

let snapshot: LibraryNode[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeLibrary(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLibrarySnapshot(): LibraryNode[] {
  return snapshot;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("nodes")) db.createObjectStore("nodes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB"));
  });
}

async function readAll(): Promise<LibraryNode[]> {
  const db = await openDb();
  const tx = db.transaction("nodes", "readonly");
  const rows = await requestToPromise(tx.objectStore("nodes").getAll() as IDBRequest<LibraryNode[]>);
  await txDone(tx);
  db.close();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function refreshLibrary(): Promise<void> {
  snapshot = await readAll();
  emit();
}

function hebrewQuota(error: unknown): never {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    throw new Error("אין מספיק מקום בדפדפן לשמירת התוצאה.");
  }
  throw error instanceof Error ? error : new Error("שמירת הספרייה נכשלה.");
}

export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("השם לא תקין.");
  return cleaned;
}

export function uniqueName(siblings: LibraryNode[], desired: string): string {
  const taken = new Set(siblings.map((node) => node.name));
  if (!taken.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  let index = 1;
  while (taken.has(`${stem} (${index})${ext}`)) index += 1;
  return `${stem} (${index})${ext}`;
}

export function stemFileName(original: string, kind: LibraryId): string {
  const base = sanitizeName(original.replace(/\.[^.]+$/, "") || "שיר");
  return `${base}_${kind === "vocals" ? "vocals" : "playback"}.wav`;
}

export async function addFile(input: {
  library: LibraryId;
  parentId: string | null;
  name: string;
  blob: Blob;
  durationSec: number;
}): Promise<LibraryNode> {
  const nodes = await readAll();
  const siblings = nodes.filter(
    (node) => node.library === input.library && node.parentId === input.parentId,
  );
  const node: LibraryNode = {
    id: crypto.randomUUID(),
    library: input.library,
    parentId: input.parentId,
    kind: "file",
    name: uniqueName(siblings, input.name),
    createdAt: Date.now(),
    durationSec: input.durationSec,
  };
  try {
    const db = await openDb();
    const tx = db.transaction(["nodes", "blobs"], "readwrite");
    tx.objectStore("nodes").put(node);
    tx.objectStore("blobs").put(input.blob, node.id);
    await txDone(tx);
    db.close();
  } catch (error) {
    hebrewQuota(error);
  }
  await refreshLibrary();
  return node;
}

export async function addFolder(library: LibraryId, parentId: string | null, rawName: string) {
  const name = sanitizeName(rawName);
  const nodes = await readAll();
  const siblings = nodes.filter((node) => node.library === library && node.parentId === parentId);
  if (siblings.some((node) => node.name === name)) throw new Error("כבר יש פריט באותו שם.");
  const node: LibraryNode = {
    id: crypto.randomUUID(),
    library,
    parentId,
    kind: "folder",
    name,
    createdAt: Date.now(),
  };
  const db = await openDb();
  const tx = db.transaction("nodes", "readwrite");
  tx.objectStore("nodes").put(node);
  await txDone(tx);
  db.close();
  await refreshLibrary();
}

export async function renameNode(id: string, rawName: string) {
  const nodes = await readAll();
  const node = nodes.find((item) => item.id === id);
  if (!node) throw new Error("הפריט לא נמצא.");
  let name = sanitizeName(rawName);
  if (node.kind === "file") {
    const ext = node.name.match(/\.[^.]+$/)?.[0] ?? ".wav";
    if (!name.toLowerCase().endsWith(ext.toLowerCase())) {
      name = name.replace(/\.[^.]+$/, "") + ext;
    }
  }
  const siblings = nodes.filter(
    (item) =>
      item.id !== id && item.library === node.library && item.parentId === node.parentId,
  );
  if (siblings.some((item) => item.name === name)) throw new Error("כבר יש פריט באותו שם.");
  node.name = name;
  const db = await openDb();
  const tx = db.transaction("nodes", "readwrite");
  tx.objectStore("nodes").put(node);
  await txDone(tx);
  db.close();
  await refreshLibrary();
}

function isInside(nodes: LibraryNode[], ancestorId: string, nodeId: string | null): boolean {
  let current = nodeId;
  const seen = new Set<string>();
  while (current) {
    if (current === ancestorId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = nodes.find((node) => node.id === current)?.parentId ?? null;
  }
  return false;
}

export async function moveNode(
  id: string,
  dest: { library: LibraryId; parentId: string | null },
) {
  const nodes = await readAll();
  const node = nodes.find((item) => item.id === id);
  if (!node) throw new Error("הפריט לא נמצא.");
  if (node.kind === "folder" && (dest.parentId === id || isInside(nodes, id, dest.parentId))) {
    throw new Error("אי אפשר להעביר תיקייה לתוך עצמה.");
  }
  const siblings = nodes.filter(
    (item) =>
      item.id !== id && item.library === dest.library && item.parentId === dest.parentId,
  );
  if (siblings.some((item) => item.name === node.name)) {
    throw new Error("כבר יש פריט באותו שם ביעד.");
  }
  const touched = new Set<string>([id]);
  if (node.kind === "folder") {
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of nodes) {
        if (item.parentId && touched.has(item.parentId) && !touched.has(item.id)) {
          touched.add(item.id);
          grew = true;
        }
      }
    }
  }
  const db = await openDb();
  const tx = db.transaction("nodes", "readwrite");
  const store = tx.objectStore("nodes");
  for (const item of nodes) {
    if (!touched.has(item.id)) continue;
    const next = { ...item, library: dest.library };
    if (item.id === id) next.parentId = dest.parentId;
    store.put(next);
  }
  await txDone(tx);
  db.close();
  await refreshLibrary();
}

export async function deleteNode(id: string) {
  const nodes = await readAll();
  const ids = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of nodes) {
      if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        grew = true;
      }
    }
  }
  const db = await openDb();
  const tx = db.transaction(["nodes", "blobs"], "readwrite");
  for (const itemId of ids) {
    tx.objectStore("nodes").delete(itemId);
    tx.objectStore("blobs").delete(itemId);
  }
  await txDone(tx);
  db.close();
  await refreshLibrary();
}

export async function getFileBlob(id: string): Promise<Blob> {
  const db = await openDb();
  const tx = db.transaction("blobs", "readonly");
  const blob = await requestToPromise(tx.objectStore("blobs").get(id) as IDBRequest<Blob | undefined>);
  await txDone(tx);
  db.close();
  if (!blob) throw new Error("הקובץ לא נמצא.");
  return blob;
}
