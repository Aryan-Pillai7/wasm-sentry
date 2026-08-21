/**
 * Service worker: the extension's trust boundary and system of record.
 *
 * Everything reaching this file came from a web page, directly or otherwise, so
 * nothing from the page side is trusted: bytes are re-sniffed and re-hashed
 * here, and the hash computed here is the one everything downstream keys on.
 *
 * MV3 lifecycle: this worker is killed after roughly 30 seconds of idle, and
 * that is not something to fight with a keepalive. Instead every handler is
 * short, holds no state across messages, and writes through to IndexedDB. A
 * worker that dies mid-flight loses at most the capture it was working on, and
 * the badge is always recomputed from storage rather than from a counter that
 * would not survive.
 */
import { sha256, base64ToBytes, sniff } from "@wasm-sentry/core";
import {
  addNote,
  addSighting,
  clearTab,
  getArtifacts,
  getNotesByTab,
  getSightingsByTab,
  prune,
  upsertArtifact,
} from "../utils/db";
import type { SightingRow } from "../utils/db";
import { getSettings } from "../utils/settings";
import { MAX_ARTIFACT_BYTES } from "../shared/protocol";
import type {
  CaptureRequest,
  ExtensionMessage,
  SkipRequest,
  TabReport,
  TabArtifactView,
} from "../shared/protocol";

const LOG = "[wasm-sentry]";

/* ------------------------------------------------------------------ */
/* Capture intake                                                      */
/* ------------------------------------------------------------------ */

async function handleCapture(
  message: CaptureRequest,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; hash?: string; reason?: string }> {
  const tabId = sender.tab?.id ?? -1;
  const frameId = sender.frameId ?? 0;
  const now = Date.now();

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(message.bytesB64);
  } catch {
    return { ok: false, reason: "undecodable" };
  }

  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: "size" };
  }

  // Re-sniff rather than believing the page. A capture that reaches the
  // WebAssembly API but carries no magic number is not a module we can analyse.
  const kind = sniff(bytes, { url: message.url });
  if (kind !== "wasm") return { ok: false, reason: "not-wasm" };

  const hash = await sha256(bytes);

  const { isNew } = await upsertArtifact({ hash, kind, size: bytes.length, bytes }, now);

  const sighting: SightingRow = {
    hash,
    url: message.url,
    pageUrl: message.pageUrl,
    tabId,
    frameId,
    source: "wasm-api",
    api: message.api,
    timestamp: now,
  };
  await addSighting(sighting);

  if (isNew) {
    console.log(`${LOG} new module ${hash.slice(0, 12)} (${bytes.length} B) via ${message.api}`);
    void prune().catch(() => undefined);
    // Phase 2 hooks the static analysis pipeline in here; Phase 1 stops at
    // durable, de-duplicated capture.
  }

  await refreshBadge(tabId);
  return { ok: true, hash };
}

async function handleSkip(
  message: SkipRequest,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true }> {
  await addNote({
    url: message.url,
    pageUrl: message.pageUrl,
    tabId: sender.tab?.id ?? -1,
    api: message.api,
    size: message.size,
    reason: message.reason,
    timestamp: Date.now(),
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

async function buildTabReport(tabId: number): Promise<TabReport> {
  const [sightings, notes] = await Promise.all([getSightingsByTab(tabId), getNotesByTab(tabId)]);

  // Collapse sightings to one row per hash, keeping the most recent context.
  const latest = new Map<string, { sighting: SightingRow; count: number }>();
  for (const sighting of sightings) {
    const entry = latest.get(sighting.hash);
    if (!entry) latest.set(sighting.hash, { sighting, count: 1 });
    else {
      entry.count++;
      if (sighting.timestamp > entry.sighting.timestamp) entry.sighting = sighting;
    }
  }

  const rows = await getArtifacts([...latest.keys()]);
  const artifacts: TabArtifactView[] = rows.map((row) => {
    const entry = latest.get(row.hash)!;
    return {
      hash: row.hash,
      kind: row.kind,
      size: row.size,
      url: entry.sighting.url,
      ...(entry.sighting.api ? { api: entry.sighting.api } : {}),
      source: entry.sighting.source,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      sightings: entry.count,
    };
  });
  artifacts.sort((a, b) => b.lastSeen - a.lastSeen);

  return {
    tabId,
    pageUrl: sightings.at(-1)?.pageUrl ?? "",
    artifacts,
    notes: notes.map((note) => ({
      url: note.url,
      reason: note.reason,
      size: note.size,
      ...(note.api ? { api: note.api } : {}),
      timestamp: note.timestamp,
    })),
  };
}

async function refreshBadge(tabId: number): Promise<void> {
  if (tabId < 0) return;
  const sightings = await getSightingsByTab(tabId);
  const distinct = new Set(sightings.map((s) => s.hash)).size;
  await chrome.action.setBadgeText({ tabId, text: distinct === 0 ? "" : String(distinct) });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f6feb" });
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const message = raw as ExtensionMessage;
  let work: Promise<unknown>;

  switch (message?.type) {
    case "wasm-sentry:capture":
      work = handleCapture(message, sender);
      break;
    case "wasm-sentry:skipped":
      work = handleSkip(message, sender);
      break;
    case "wasm-sentry:tab-report":
      work = buildTabReport(message.tabId);
      break;
    default:
      return false;
  }

  work.then(sendResponse, (error: unknown) => {
    console.error(`${LOG} handler failed`, error);
    sendResponse({ ok: false, reason: String(error) });
  });
  return true; // keeps the message channel open for the async reply
});

/**
 * Network-side observation.
 *
 * This does *not* fetch anything. Its only job is to notice Wasm that the
 * main-world hook could not see -- most importantly modules compiled inside a
 * Web Worker, where content scripts do not run. Recording it as a note keeps
 * the Scorecard honest about its own blind spots instead of silently reporting
 * a clean page.
 */
chrome.webRequest.onCompleted.addListener(
  (details) => {
    void (async () => {
      const settings = await getSettings();
      if (!settings.trackNetworkSightings) return;

      const header = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-type",
      )?.value;
      const declaredWasm = header?.toLowerCase().includes("wasm") ?? false;
      const looksWasm = new URL(details.url).pathname.endsWith(".wasm");
      if (!declaredWasm && !looksWasm) return;

      // The main-world hook records the same module within a few milliseconds
      // when it can see it; this note is reconciled away by the popup, which
      // hides notes whose URL already has a captured sighting.
      await addNote({
        url: details.url,
        pageUrl: details.initiator ?? "",
        tabId: details.tabId,
        size: 0,
        reason: "network-only",
        timestamp: Date.now(),
      });
    })().catch(() => undefined);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTab(tabId).catch(() => undefined);
});

/** A committed navigation retires the previous page's findings for that tab. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  void clearTab(tabId)
    .then(() => refreshBadge(tabId))
    .catch(() => undefined);
});
