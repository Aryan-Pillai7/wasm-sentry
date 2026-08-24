/**
 * IndexedDB storage for the extension.
 *
 * Schema notes:
 *
 *  - `artifacts` holds metadata only and is keyed by content hash, not URL. One
 *    CDN module served under a thousand cache-busted URLs is one row, analysed
 *    once. The bytes live separately in `blobs` so that listing every module
 *    ever seen never has to deserialise megabytes of WebAssembly.
 *  - Bytes are retained so a later pipeline stage, or a re-run after a rule
 *    change, does not have to re-observe the module. Bounded by `prune()`.
 *  - `sightings` is the many-to-one side: every time a hash is seen, where and
 *    through which API. That is what makes per-tab reporting possible without
 *    duplicating payloads.
 *  - `events` is an append-only activity log across all tabs, capped. It exists
 *    so the dashboard can show that the extension is working continuously
 *    rather than leaving the user to infer it.
 *  - `runtime` holds the latest report from each reporting context, and
 *    `fingerprints` maps the page-side fingerprint a report is keyed by to the
 *    content hash everything else is keyed by. The page cannot compute the
 *    hash -- `crypto.subtle` is undefined over plain http -- so the join has to
 *    happen here.
 */
import type {
  ArtifactAnalysis,
  ArtifactKind,
  CaptureSource,
  RiskLevel,
  WasmApi,
} from "@wasm-sentry/core";
import type { JsArtifactAnalysis, RuntimeReport } from "@wasm-sentry/core";
import type { CaptureContext } from "../shared/protocol";

const DB_NAME = "wasm-sentry";
const DB_VERSION = 5;

/** Upper bounds on locally retained artifact bytes. */
const MAX_STORED_ARTIFACTS = 300;
const MAX_STORED_BYTES = 128 * 1024 * 1024;
/** Activity log depth. Enough to show a session's work, not a history. */
const MAX_EVENTS = 500;

/** Metadata about an artifact. Never carries the bytes -- see `blobs`. */
export interface ArtifactRow {
  hash: string;
  kind: ArtifactKind;
  size: number;
  firstSeen: number;
  lastSeen: number;
  seenCount: number;
  /** Most recent page this hash was seen on, for the all-tabs listing. */
  lastPageUrl: string;
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
  /**
   * Page world or inside a Web Worker. Optional rather than required: rows
   * written before worker instrumentation existed have no value for it, and an
   * IndexedDB store holds whatever shape it was written with. Absent reads as
   * "page", which is what those rows were.
   */
  context?: CaptureContext;
  timestamp: number;
}

/**
 * Why an observed artifact has no bytes on record. Kept as data rather than
 * dropped silently so the Scorecard can say "3 modules seen, 1 not analysed
 * because it exceeded the size cap" instead of quietly under-reporting.
 */
export type NoteReason = "too-large" | "rate-limited" | "read-failed" | "network-only";

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
 * The latest runtime report from one context.
 *
 * Keyed by context rather than appended, because reports are cumulative: the
 * newest from a context replaces the last, so a context that dies takes nothing
 * with it and a duplicate cannot double-count. `fingerprints` maps what the
 * page could compute to what the service worker hashed.
 */
export interface RuntimeRow {
  contextId: string;
  tabId: number;
  pageUrl: string;
  report: RuntimeReport;
  updatedAt: number;
}

/** What a page-side fingerprint turned out to be, once the bytes were hashed. */
export interface FingerprintRow {
  fingerprint: string;
  hash: string;
  seenAt: number;
}

/**
 * An analysed piece of JavaScript.
 *
 * Note what is absent: the source. A script on an authenticated page can carry
 * far more of somebody's private business than a compiled module does, so what
 * persists is the measurements and the verdict -- enough to explain a finding,
 * and not enough to reconstruct the code. This is the reason there is no
 * `blobs` equivalent here.
 */
export interface ScriptRow {
  hash: string;
  tabId: number;
  pageUrl: string;
  origin: "inline" | "injected-inline" | "Function";
  byteLength: number;
  analysis: JsArtifactAnalysis;
  seenAt: number;
}

/** An external script, as metadata. Its contents are never read. */
export interface ExternalScriptRow {
  /** `${tabId}|${url}`, so one row per script per tab. */
  key: string;
  tabId: number;
  url: string;
  thirdParty: boolean;
  hasIntegrity: boolean;
  injected: boolean;
  seenAt: number;
}

export type EventKind = "captured" | "analysed" | "skipped" | "alerted" | "cleared";

/** One line in the activity feed. */
export interface EventRow {
  id?: number;
  timestamp: number;
  kind: EventKind;
  pageUrl: string;
  tabId: number;
  hash?: string;
  size?: number;
  api?: WasmApi;
  level?: RiskLevel;
  score?: number;
  detail?: string;
  context?: CaptureContext;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      // Earlier versions stored bytes inline with metadata and had no activity
      // log. Nothing there is worth migrating -- it is a cache of things the
      // browser can observe again -- so the old stores are dropped outright.
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);

      db.createObjectStore("artifacts", { keyPath: "hash" }).createIndex("by_lastSeen", "lastSeen");
      db.createObjectStore("blobs", { keyPath: "hash" });

      const sightings = db.createObjectStore("sightings", { keyPath: "id", autoIncrement: true });
      sightings.createIndex("by_hash", "hash");
      sightings.createIndex("by_tab", "tabId");

      const notes = db.createObjectStore("notes", { keyPath: "id", autoIncrement: true });
      notes.createIndex("by_tab", "tabId");

      db.createObjectStore("events", { keyPath: "id", autoIncrement: true });

      // Runtime measurements, one row per reporting context, and the map from
      // the page's own fingerprint to the hash this worker computed.
      const runtime = db.createObjectStore("runtime", { keyPath: "contextId" });
      runtime.createIndex("by_tab", "tabId");
      db.createObjectStore("fingerprints", { keyPath: "fingerprint" });

      // JavaScript: measurements and verdicts, never source.
      const scripts = db.createObjectStore("scripts", { keyPath: "hash" });
      scripts.createIndex("by_tab", "tabId");
      const external = db.createObjectStore("externalScripts", { keyPath: "key" });
      external.createIndex("by_tab", "tabId");

      // Verdicts are keyed by artifact hash too, so a module already analysed
      // on another site is never analysed twice.
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

async function withStores<T>(
  names: readonly string[],
  mode: IDBTransactionMode,
  run: (stores: Record<string, IDBObjectStore>) => Promise<T> | T,
): Promise<T> {
  const db = await openDB();
  const tx = db.transaction(names as string[], mode);
  const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
  const result = await run(stores);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  return withStores([name], mode, (stores) => run(stores[name]!));
}

/**
 * Record an artifact, merging with any existing row for the same hash.
 * Returns whether this was the first time we ever saw these bytes, which is
 * what the caller uses to decide if analysis needs to run at all.
 */
export async function upsertArtifact(
  input: { hash: string; kind: ArtifactKind; size: number; bytes: Uint8Array; pageUrl: string },
  now: number,
): Promise<{ row: ArtifactRow; isNew: boolean }> {
  return withStores(["artifacts", "blobs"], "readwrite", async (stores) => {
    const artifacts = stores["artifacts"]!;
    const existing = await promisify<ArtifactRow | undefined>(artifacts.get(input.hash));
    const row: ArtifactRow = existing
      ? { ...existing, lastSeen: now, seenCount: existing.seenCount + 1, lastPageUrl: input.pageUrl }
      : {
          hash: input.hash,
          kind: input.kind,
          size: input.size,
          firstSeen: now,
          lastSeen: now,
          seenCount: 1,
          lastPageUrl: input.pageUrl,
        };
    await promisify(artifacts.put(row));
    if (!existing) {
      await promisify(stores["blobs"]!.put({ hash: input.hash, bytes: input.bytes }));
    }
    return { row, isNew: !existing };
  });
}

export async function getArtifactBytes(hash: string): Promise<Uint8Array | undefined> {
  return withStore("blobs", "readonly", async (store) => {
    const row = await promisify<{ hash: string; bytes: Uint8Array } | undefined>(store.get(hash));
    return row?.bytes;
  });
}

export async function addSighting(row: SightingRow): Promise<void> {
  await withStore("sightings", "readwrite", (store) => promisify(store.add(row)));
}

export async function addNote(row: NoteRow): Promise<void> {
  await withStore("notes", "readwrite", (store) => promisify(store.add(row)));
}

/** Append to the activity log, trimming it back to its cap as it grows. */
export async function addEvent(row: EventRow): Promise<void> {
  await withStore("events", "readwrite", async (store) => {
    await promisify(store.add(row));
    const count = await promisify(store.count());
    if (count <= MAX_EVENTS) return;
    // Keys are auto-increment, so the oldest are simply the lowest.
    const oldest = await promisify<IDBValidKey[]>(store.getAllKeys(null, count - MAX_EVENTS));
    await Promise.all(oldest.map((key) => promisify(store.delete(key))));
  });
}

/** Most recent activity first. */
export async function getRecentEvents(limit: number): Promise<EventRow[]> {
  return withStore("events", "readonly", async (store) => {
    const rows = await promisify<EventRow[]>(store.getAll());
    return rows.reverse().slice(0, limit);
  });
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

/** Every artifact ever seen, most recent first. Metadata only. */
export async function getAllArtifacts(limit: number): Promise<ArtifactRow[]> {
  return withStore("artifacts", "readonly", async (store) => {
    const rows = await promisify<ArtifactRow[]>(store.index("by_lastSeen").getAll());
    return rows.reverse().slice(0, limit);
  });
}

export async function countArtifacts(): Promise<number> {
  return withStore("artifacts", "readonly", (store) => promisify(store.count()));
}

export async function saveAnalysis(analysis: ArtifactAnalysis): Promise<void> {
  await withStore("results", "readwrite", (store) => promisify(store.put(analysis)));
}

export async function getAnalyses(
  hashes: readonly string[],
): Promise<Map<string, ArtifactAnalysis>> {
  return withStore("results", "readonly", async (store) => {
    const rows = await Promise.all(
      hashes.map((hash) => promisify<ArtifactAnalysis | undefined>(store.get(hash))),
    );
    return new Map(
      rows.filter((row): row is ArtifactAnalysis => row !== undefined).map((row) => [row.hash, row]),
    );
  });
}

export async function hasAnalysis(hash: string): Promise<boolean> {
  return withStore("results", "readonly", async (store) => {
    const row = await promisify<ArtifactAnalysis | undefined>(store.get(hash));
    return row !== undefined;
  });
}

/** Drop sightings, notes and measurements belonging to a tab that has gone away. */
export async function clearTab(tabId: number): Promise<void> {
  for (const name of ["sightings", "notes", "runtime", "scripts", "externalScripts"] as const) {
    await withStore(name, "readwrite", async (store) => {
      const keys = await promisify<IDBValidKey[]>(store.index("by_tab").getAllKeys(tabId));
      await Promise.all(keys.map((key) => promisify(store.delete(key))));
    });
  }
}

/** Record which artifact a page-side fingerprint turned out to identify. */
export async function linkFingerprint(fingerprint: string, hash: string): Promise<void> {
  await withStore("fingerprints", "readwrite", (store) =>
    promisify(store.put({ fingerprint, hash, seenAt: Date.now() })),
  );
}

export async function resolveFingerprints(
  fingerprints: readonly string[],
): Promise<Map<string, string>> {
  return withStore("fingerprints", "readonly", async (store) => {
    const rows = await Promise.all(
      fingerprints.map((fingerprint) =>
        promisify<FingerprintRow | undefined>(store.get(fingerprint)),
      ),
    );
    return new Map(
      rows
        .filter((row): row is FingerprintRow => row !== undefined)
        .map((row) => [row.fingerprint, row.hash]),
    );
  });
}

/** Store a context's latest report, replacing whatever it said before. */
export async function saveRuntimeReport(row: RuntimeRow): Promise<void> {
  await withStore("runtime", "readwrite", (store) => promisify(store.put(row)));
}

export async function getRuntimeByTab(tabId: number): Promise<RuntimeRow[]> {
  return withStore("runtime", "readonly", (store) =>
    promisify<RuntimeRow[]>(store.index("by_tab").getAll(tabId)),
  );
}

export async function getAllRuntime(): Promise<RuntimeRow[]> {
  return withStore("runtime", "readonly", (store) => promisify<RuntimeRow[]>(store.getAll()));
}

export async function saveScript(row: ScriptRow): Promise<void> {
  await withStore("scripts", "readwrite", (store) => promisify(store.put(row)));
}

export async function getScriptsByTab(tabId: number): Promise<ScriptRow[]> {
  return withStore("scripts", "readonly", (store) =>
    promisify<ScriptRow[]>(store.index("by_tab").getAll(tabId)),
  );
}

export async function hasScript(hash: string): Promise<boolean> {
  return withStore("scripts", "readonly", async (store) => {
    const row = await promisify<ScriptRow | undefined>(store.get(hash));
    return row !== undefined;
  });
}

export async function saveExternalScript(row: ExternalScriptRow): Promise<void> {
  await withStore("externalScripts", "readwrite", (store) => promisify(store.put(row)));
}

export async function getExternalScriptsByTab(tabId: number): Promise<ExternalScriptRow[]> {
  return withStore("externalScripts", "readonly", (store) =>
    promisify<ExternalScriptRow[]>(store.index("by_tab").getAll(tabId)),
  );
}

/** Wipe everything. Exposed in the dashboard so the user can reset state. */
export async function clearAll(): Promise<void> {
  const names = [
    "artifacts",
    "blobs",
    "sightings",
    "notes",
    "events",
    "results",
    "runtime",
    "fingerprints",
    "scripts",
    "externalScripts",
  ] as const;
  await withStores(names, "readwrite", async (stores) => {
    await Promise.all(names.map((name) => promisify(stores[name]!.clear())));
  });
}

/**
 * Evict the least recently seen artifacts until the local cache is back inside
 * its bounds. Metadata is cheap; the retained bytes are not, so this is what
 * keeps a long browsing session from filling the user's disk.
 */
export async function prune(): Promise<number> {
  return withStores(["artifacts", "blobs"], "readwrite", async (stores) => {
    const artifacts = stores["artifacts"]!;
    const rows = await promisify<ArtifactRow[]>(artifacts.index("by_lastSeen").getAll());
    let totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
    let evicted = 0;
    // `getAll` on the index yields oldest-first, which is exactly eviction order.
    for (const row of rows) {
      if (rows.length - evicted <= MAX_STORED_ARTIFACTS && totalBytes <= MAX_STORED_BYTES) break;
      await promisify(artifacts.delete(row.hash));
      await promisify(stores["blobs"]!.delete(row.hash));
      totalBytes -= row.size;
      evicted++;
    }
    return evicted;
  });
}
