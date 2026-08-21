/**
 * IndexedDB storage for the extension.
 *
 * Schema notes:
 *
 *  - `artifacts` is keyed by content hash, not URL. One CDN module served under
 *    a thousand cache-busted URLs is one row, analysed once.
 *  - The bytes are kept alongside the metadata so a later pipeline stage (or a
 *    re-run after a rule change) does not have to re-observe the module. This
 *    is bounded by `prune()`.
 *  - `sightings` is the many-to-one side: every time a hash is seen, where and
 *    through which API. That is what makes per-tab and per-site reporting
 *    possible without duplicating payloads.
 */
import type { ArtifactKind, CaptureSource, WasmApi } from "@wasm-sentry/core";

const DB_NAME = "wasm-sentry";
const DB_VERSION = 2;

/** Upper bounds on locally retained artifact bytes. */
const MAX_STORED_ARTIFACTS = 300;
const MAX_STORED_BYTES = 128 * 1024 * 1024;

export interface ArtifactRow {
  hash: string;
  kind: ArtifactKind;
  size: number;
  firstSeen: number;
  lastSeen: number;
  seenCount: number;
  bytes: Uint8Array;
}

export interface SightingRow {
  id?: number;
  hash: string;
  url: string;
  pageUrl: string;
  tabId: number;
  frameId: number;
  source: CaptureSource;
  api?: WasmApi;
  timestamp: number;
}

export interface NoteRow {
  id?: number;
  url: string;
  pageUrl: string;
  tabId: number;
  api?: WasmApi;
  size: number;
  reason: NoteReason;
  timestamp: number;
}

/**
 * Why an observed artifact has no bytes on record. Kept as data rather than
 * dropped silently so the Scorecard can say "3 modules seen, 1 not analysed
 * because it exceeded the size cap" instead of quietly under-reporting.
 */
export type NoteReason = "too-large" | "rate-limited" | "read-failed" | "network-only";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      // v1 keyed captures by an auto-increment id and stored no bytes. There is
      // nothing worth migrating, so the old stores are dropped outright.
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);

      db.createObjectStore("artifacts", { keyPath: "hash" }).createIndex("by_lastSeen", "lastSeen");

      const sightings = db.createObjectStore("sightings", { keyPath: "id", autoIncrement: true });
      sightings.createIndex("by_hash", "hash");
      sightings.createIndex("by_tab", "tabId");

      const notes = db.createObjectStore("notes", { keyPath: "id", autoIncrement: true });
      notes.createIndex("by_tab", "tabId");

      db.createObjectStore("results", { keyPath: "hash" });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another context"));
  });
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  const result = await run(tx.objectStore(name));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

/**
 * Record an artifact, merging with any existing row for the same hash.
 * Returns whether this was the first time we ever saw these bytes, which is
 * what the caller uses to decide if analysis needs to run at all.
 */
export async function upsertArtifact(
  input: Omit<ArtifactRow, "firstSeen" | "lastSeen" | "seenCount">,
  now: number,
): Promise<{ row: ArtifactRow; isNew: boolean }> {
  return withStore("artifacts", "readwrite", async (store) => {
    const existing = await promisify<ArtifactRow | undefined>(store.get(input.hash));
    const row: ArtifactRow = existing
      ? { ...existing, lastSeen: now, seenCount: existing.seenCount + 1 }
      : { ...input, firstSeen: now, lastSeen: now, seenCount: 1 };
    await promisify(store.put(row));
    return { row, isNew: !existing };
  });
}

export async function addSighting(row: SightingRow): Promise<void> {
  await withStore("sightings", "readwrite", (store) => promisify(store.add(row)));
}

export async function addNote(row: NoteRow): Promise<void> {
  await withStore("notes", "readwrite", (store) => promisify(store.add(row)));
}

export async function getArtifact(hash: string): Promise<ArtifactRow | undefined> {
  return withStore("artifacts", "readonly", (store) =>
    promisify<ArtifactRow | undefined>(store.get(hash)),
  );
}

export async function getSightingsByTab(tabId: number): Promise<SightingRow[]> {
  return withStore("sightings", "readonly", (store) =>
    promisify<SightingRow[]>(store.index("by_tab").getAll(tabId)),
  );
}

export async function getNotesByTab(tabId: number): Promise<NoteRow[]> {
  return withStore("notes", "readonly", (store) =>
    promisify<NoteRow[]>(store.index("by_tab").getAll(tabId)),
  );
}

export async function getArtifacts(hashes: readonly string[]): Promise<ArtifactRow[]> {
  return withStore("artifacts", "readonly", async (store) => {
    const rows = await Promise.all(
      hashes.map((hash) => promisify<ArtifactRow | undefined>(store.get(hash))),
    );
    return rows.filter((row): row is ArtifactRow => row !== undefined);
  });
}

/** Drop sightings and skips belonging to a tab that has gone away. */
export async function clearTab(tabId: number): Promise<void> {
  for (const name of ["sightings", "notes"] as const) {
    await withStore(name, "readwrite", async (store) => {
      const keys = await promisify<IDBValidKey[]>(store.index("by_tab").getAllKeys(tabId));
      await Promise.all(keys.map((key) => promisify(store.delete(key))));
    });
  }
}

/**
 * Evict the least recently seen artifacts until the local cache is back inside
 * its bounds. Metadata is cheap; the retained bytes are not, so this is what
 * keeps a long browsing session from filling the user's disk.
 */
export async function prune(): Promise<number> {
  return withStore("artifacts", "readwrite", async (store) => {
    const rows = await promisify<ArtifactRow[]>(store.index("by_lastSeen").getAll());
    let totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
    let evicted = 0;
    // `getAll` on the index yields oldest-first, which is exactly eviction order.
    for (const row of rows) {
      if (rows.length - evicted <= MAX_STORED_ARTIFACTS && totalBytes <= MAX_STORED_BYTES) break;
      await promisify(store.delete(row.hash));
      totalBytes -= row.size;
      evicted++;
    }
    return evicted;
  });
}
