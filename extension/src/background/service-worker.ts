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
import {
  accumulateRuntime,
  analyzeWasm,
  base64ToBytes,
  buildScorecard,
  sha256,
  sniff,
  summarise,
} from "@wasm-sentry/core";
import type { RiskAssessment, RiskLevel, RuntimeFeatures } from "@wasm-sentry/core";
import {
  addEvent,
  addNote,
  addSighting,
  clearAll,
  clearTab,
  countArtifacts,
  getAllArtifacts,
  getAnalyses,
  getArtifacts,
  getArtifactBytes,
  getNotesByTab,
  getRecentEvents,
  getRuntimeByTab,
  getSightingsByTab,
  hasAnalysis,
  linkFingerprint,
  prune,
  resolveFingerprints,
  saveAnalysis,
  saveRuntimeReport,
  upsertArtifact,
} from "../utils/db";
import type { RuntimeRow, SightingRow } from "../utils/db";
import { getSettings, setSettings } from "../utils/settings";
import { decideAlert } from "./alerts";
import { MAX_ARTIFACT_BYTES } from "../shared/protocol";
import type {
  ActivityEvent,
  ActivityReport,
  CaptureRequest,
  ExtensionMessage,
  ModuleRow,
  RuntimeRequest,
  SkipRequest,
  TabReport,
  TabArtifactView,
} from "../shared/protocol";

const LOG = "[wasm-sentry]";

/** When this worker instance started. Shown in the dashboard as proof of life. */
const WORKER_STARTED_AT = Date.now();

/** Set false if the observational network listener could not be registered. */
let networkObserverActive = false;

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

  const { isNew } = await upsertArtifact(
    { hash, kind, size: bytes.length, bytes, pageUrl: message.pageUrl },
    now,
  );

  // The page can only key its runtime samples by something the page can
  // compute, and over plain http that cannot be a hash. Recording the join here
  // is what lets a measurement find the artifact it belongs to.
  if (message.fingerprint) {
    await linkFingerprint(message.fingerprint, hash).catch(() => undefined);
  }

  const context = message.context ?? "page";
  const sighting: SightingRow = {
    hash,
    url: message.url,
    pageUrl: message.pageUrl,
    tabId,
    frameId,
    source: "wasm-api",
    api: message.api,
    context,
    timestamp: now,
  };
  await addSighting(sighting);

  await addEvent({
    timestamp: now,
    kind: "captured",
    pageUrl: message.pageUrl,
    tabId,
    hash,
    size: bytes.length,
    api: message.api,
    context,
    ...(isNew ? {} : { detail: "already seen" }),
  });

  if (isNew) {
    console.log(`${LOG} new module ${hash.slice(0, 12)} (${bytes.length} B) via ${message.api}`);
    void prune().catch(() => undefined);
  }

  // Analysis is keyed by hash, so a module already characterised on another
  // site costs nothing here. Awaiting it keeps the worker alive through the
  // parse; it is synchronous and budgeted, so this is bounded work, not a
  // reason to reach for a keepalive.
  if (!(await hasAnalysis(hash))) {
    const analysis = summarise(hash, analyzeWasm(bytes));
    await saveAnalysis(analysis);
    console.log(
      `${LOG} analysed ${hash.slice(0, 12)} in ${analysis.elapsedMs}ms:`,
      analysis.ok
        ? `${analysis.summary?.functionCount} functions, ${analysis.summary?.totalLoops} loops`
        : analysis.reason,
    );
    await addEvent({
      timestamp: Date.now(),
      kind: "analysed",
      pageUrl: message.pageUrl,
      tabId,
      hash,
      size: bytes.length,
      ...(analysis.risk ? { level: analysis.risk.level, score: analysis.risk.score } : {}),
      detail: analysis.ok
        ? (analysis.risk?.findings[0]?.title ?? "no findings")
        : (analysis.reason ?? "analysis failed"),
    });
  }

  const report = await refreshBadge(tabId);
  if (report) await maybeAlert(tabId, report).catch(() => undefined);
  return { ok: true, hash };
}

async function handleSkip(
  message: SkipRequest,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: true }> {
  await addEvent({
    timestamp: Date.now(),
    kind: "skipped",
    pageUrl: message.pageUrl,
    tabId: sender.tab?.id ?? -1,
    size: message.size,
    api: message.api,
    context: message.context ?? "page",
    detail: message.reason,
  });
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
/* Runtime intake                                                      */
/* ------------------------------------------------------------------ */

/**
 * Take one context's account of how its modules are behaving, and re-score
 * whatever it has something to say about.
 *
 * Re-running the whole assessment rather than patching the stored one is
 * deliberate: `mining-runtime-corroborated` has to see the static kernel and
 * the measured execution together, and a rule that only ever sees half of its
 * inputs cannot produce the finding this phase exists for. The bytes are still
 * in `blobs`, which is what makes re-analysis possible at all.
 */
async function handleRuntime(
  message: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; rescored?: number }> {
  const tabId = sender.tab?.id ?? -1;

  await saveRuntimeReport({
    contextId: message.contextId,
    tabId,
    pageUrl: message.pageUrl,
    report: message.report,
    updatedAt: Date.now(),
  });

  const rescored = await rescoreTab(tabId);
  if (rescored > 0) {
    const report = await refreshBadge(tabId);
    if (report) await maybeAlert(tabId, report).catch(() => undefined);
  }
  return { ok: true, rescored };
}

/** Fold every context's latest report for a tab into per-hash features. */
async function runtimeByHash(tabId: number): Promise<Map<string, RuntimeFeatures>> {
  const rows: RuntimeRow[] = await getRuntimeByTab(tabId);
  if (rows.length === 0) return new Map();

  const byFingerprint = accumulateRuntime(rows.map((row) => row.report));
  const hashes = await resolveFingerprints([...byFingerprint.keys()]);

  const byHash = new Map<string, RuntimeFeatures>();
  for (const [fingerprint, features] of byFingerprint) {
    const hash = hashes.get(fingerprint);
    // A fingerprint we never captured bytes for is a module we cannot name.
    // Dropping it is right: a measurement with nothing to attribute it to
    // cannot become a finding about anything.
    if (hash) byHash.set(hash, features);
  }
  return byHash;
}

/**
 * Re-analyse the modules in a tab that now have runtime evidence.
 *
 * Only modules whose evidence has actually moved are re-run: the parse is
 * bounded but not free, and a report arrives every ten seconds per context.
 */
async function rescoreTab(tabId: number): Promise<number> {
  const runtime = await runtimeByHash(tabId);
  if (runtime.size === 0) return 0;

  const existing = await getAnalyses([...runtime.keys()]);
  let rescored = 0;

  for (const [hash, features] of runtime) {
    const previous = existing.get(hash);
    if (!previous?.ok) continue;
    if (!worthRescoring(previous.runtime, features)) continue;

    const bytes = await getArtifactBytes(hash);
    if (!bytes) continue;

    const analysis = summarise(hash, analyzeWasm(bytes), features);
    await saveAnalysis(analysis);
    rescored++;

    const before = previous.risk?.level;
    const after = analysis.risk?.level;
    if (after !== undefined && after !== before) {
      await addEvent({
        timestamp: Date.now(),
        kind: "analysed",
        pageUrl: "",
        tabId,
        hash,
        ...(analysis.risk ? { level: analysis.risk.level, score: analysis.risk.score } : {}),
        detail: `runtime evidence moved this from ${before ?? "unscored"} to ${after}`,
      });
    }
  }

  return rescored;
}

/**
 * Whether new measurements are different enough to be worth a re-parse.
 *
 * Reports arrive every ten seconds per context and mostly say the same thing.
 * Re-analysing on every one of them would burn the service worker's budget
 * restating a verdict nobody asked to have restated.
 */
function worthRescoring(previous: RuntimeFeatures | undefined, next: RuntimeFeatures): boolean {
  if (!previous) return true;
  if (next.contextCount !== previous.contextCount) return true;
  if (Math.abs(next.cpuShare - previous.cpuShare) >= 0.1) return true;
  // Crossing the observation floor changes which rules can fire at all.
  return previous.observedMs < 20_000 && next.observedMs >= 20_000;
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

  const hashes = [...latest.keys()];
  const [rows, analyses] = await Promise.all([getArtifacts(hashes), getAnalyses(hashes)]);
  const artifacts: TabArtifactView[] = rows.map((row) => {
    const entry = latest.get(row.hash)!;
    const analysis = analyses.get(row.hash);
    return {
      hash: row.hash,
      kind: row.kind,
      size: row.size,
      url: entry.sighting.url,
      ...(entry.sighting.api ? { api: entry.sighting.api } : {}),
      source: entry.sighting.source,
      ...(entry.sighting.context ? { context: entry.sighting.context } : {}),
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      sightings: entry.count,
      ...(analysis ? { analysis } : {}),
    };
  });
  // Riskiest first: the reason to open the popup is at the top, not buried
  // under whatever loaded most recently.
  artifacts.sort((a, b) => {
    const byScore = (b.analysis?.risk?.score ?? -1) - (a.analysis?.risk?.score ?? -1);
    return byScore !== 0 ? byScore : b.lastSeen - a.lastSeen;
  });

  // A network note for a URL we also captured is the same module counted
  // twice; only the genuine blind spots are worth reporting.
  const capturedUrls = new Set(artifacts.map((artifact) => artifact.url));
  const blindSpots = notes.filter((note) => !capturedUrls.has(note.url));

  const assessments = artifacts
    .map((artifact) => artifact.analysis?.risk)
    .filter((risk): risk is RiskAssessment => risk !== undefined);

  const pageUrl = sightings.at(-1)?.pageUrl ?? "";
  const unanalysed = artifacts.length - assessments.length + blindSpots.length;

  return {
    tabId,
    pageUrl,
    scorecard: buildScorecard(pageUrl, assessments, unanalysed),
    artifacts,
    notes: blindSpots.map((note) => ({
      url: note.url,
      reason: note.reason,
      size: note.size,
      ...(note.api ? { api: note.api } : {}),
      timestamp: note.timestamp,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Cross-tab activity, for the dashboard                               */
/* ------------------------------------------------------------------ */

const MAX_FEED_EVENTS = 200;
const MAX_MODULE_ROWS = 200;

async function notificationLevel(): Promise<string> {
  if (!chrome.notifications?.getPermissionLevel) return "unavailable";
  return new Promise((resolve) => {
    try {
      chrome.notifications.getPermissionLevel((level) => resolve(level));
    } catch {
      resolve("unavailable");
    }
  });
}

/**
 * Everything the dashboard renders, in one round trip.
 *
 * The point of this view is evidence rather than data: a user cannot see the
 * capture hooks firing, so the extension has to show its own work -- what it
 * saw, when, and whether its moving parts are actually alive.
 */
async function buildActivityReport(): Promise<ActivityReport> {
  const [rows, eventRows, settings, artifactCount, level] = await Promise.all([
    getAllArtifacts(MAX_MODULE_ROWS),
    getRecentEvents(MAX_FEED_EVENTS),
    getSettings(),
    countArtifacts(),
    notificationLevel(),
  ]);

  const analyses = await getAnalyses(rows.map((row) => row.hash));

  const modules: ModuleRow[] = rows.map((row) => {
    const analysis = analyses.get(row.hash);
    return {
      hash: row.hash,
      size: row.size,
      seenCount: row.seenCount,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      lastPageUrl: row.lastPageUrl,
      ...(analysis ? { analysis } : {}),
    };
  });

  const events: ActivityEvent[] = eventRows.map((row) => ({
    timestamp: row.timestamp,
    kind: row.kind,
    pageUrl: row.pageUrl,
    ...(row.hash !== undefined ? { hash: row.hash } : {}),
    ...(row.size !== undefined ? { size: row.size } : {}),
    ...(row.api !== undefined ? { api: row.api } : {}),
    ...(row.level !== undefined ? { level: row.level } : {}),
    ...(row.score !== undefined ? { score: row.score } : {}),
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    ...(row.context !== undefined ? { context: row.context } : {}),
  }));

  const lastCapture = eventRows.find((row) => row.kind === "captured");

  return {
    status: {
      workerStartedAt: WORKER_STARTED_AT,
      networkObserver: networkObserverActive,
      notificationLevel: level,
      artifactCount,
      lastCaptureAt: lastCapture?.timestamp ?? null,
    },
    settings: settings as unknown as Record<string, unknown>,
    events,
    modules,
  };
}

/** Badge colours follow the risk bands, so the toolbar carries the verdict. */
const BADGE_COLOURS: Record<RiskLevel, string> = {
  benign: "#1f6feb",
  low: "#1f6feb",
  medium: "#bf8700",
  high: "#d1242f",
  critical: "#a40e26",
};

async function refreshBadge(tabId: number): Promise<TabReport | null> {
  if (tabId < 0) return null;
  const report = await buildTabReport(tabId);
  const count = report.artifacts.length;
  await chrome.action.setBadgeText({ tabId, text: count === 0 ? "" : String(count) });
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: BADGE_COLOURS[report.scorecard.level],
  });
  return report;
}

/* ------------------------------------------------------------------ */
/* Alerting                                                            */
/* ------------------------------------------------------------------ */

const ALERTED_KEY = "alertedKeys";
const NOTIFICATION_TABS = "notificationTabs";

/**
 * Session storage, not memory: the service worker is killed between page loads,
 * and an in-memory de-duplication set would reset with it, so the same module
 * would notify again on every navigation.
 */
async function sessionValue<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

async function maybeAlert(tabId: number, report: TabReport): Promise<void> {
  const settings = await getSettings();
  const worst = report.artifacts[0]; // buildTabReport sorts riskiest-first
  const seen = await sessionValue<string[]>(ALERTED_KEY, []);

  const decision = decideAlert({
    scorecard: report.scorecard,
    topHash: worst?.hash,
    topFinding: worst?.analysis?.risk?.findings[0]?.title,
    enabled: settings.notifyOnHighRisk,
    seen: new Set(seen),
  });
  if (!decision.notify) return;

  const notificationId = `wasm-sentry:${decision.key}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: decision.title,
    message: decision.message,
    contextMessage: decision.contextMessage,
    priority: 2,
  });

  await addEvent({
    timestamp: Date.now(),
    kind: "alerted",
    pageUrl: report.scorecard.pageUrl,
    tabId,
    ...(worst ? { hash: worst.hash } : {}),
    level: report.scorecard.level,
    score: report.scorecard.score,
    detail: decision.message,
  });

  const tabs = await sessionValue<Record<string, number>>(NOTIFICATION_TABS, {});
  await chrome.storage.session.set({
    [ALERTED_KEY]: [...seen, decision.key].slice(-200),
    [NOTIFICATION_TABS]: { ...tabs, [notificationId]: tabId },
  });
}

/** Clicking the notification takes the user to the page it is about. */
chrome.notifications.onClicked.addListener((notificationId) => {
  void (async () => {
    const tabs = await sessionValue<Record<string, number>>(NOTIFICATION_TABS, {});
    const tabId = tabs[notificationId];
    if (tabId === undefined) return;
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return;
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.notifications.clear(notificationId);
  })().catch(() => undefined);
});

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

// Registered first and unconditionally. Everything below it is optional
// instrumentation, and a failure there must never cost us the ability to answer
// the popup -- an extension whose UI cannot ask its worker anything is an
// extension with no observable state at all.
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const message = raw as ExtensionMessage;
  let work: Promise<unknown>;

  try {
    switch (message?.type) {
      case "wasm-sentry:ping":
        sendResponse({ ok: true, at: Date.now() });
        return false;
      case "wasm-sentry:capture":
        work = handleCapture(message, sender);
        break;
      case "wasm-sentry:skipped":
        work = handleSkip(message, sender);
        break;
      case "wasm-sentry:runtime":
        work = handleRuntime(message, sender);
        break;
      case "wasm-sentry:tab-report":
        work = buildTabReport(message.tabId);
        break;
      case "wasm-sentry:activity":
        work = buildActivityReport();
        break;
      case "wasm-sentry:update-settings":
        work = setSettings(message.patch as Parameters<typeof setSettings>[0]);
        break;
      case "wasm-sentry:clear-all":
        work = clearAll().then(async () => {
          await addEvent({
            timestamp: Date.now(),
            kind: "cleared",
            pageUrl: "",
            tabId: -1,
            detail: "stored state wiped from the dashboard",
          });
          return { ok: true };
        });
        break;
      default:
        return false;
    }
  } catch (error) {
    // A synchronous throw here would otherwise leave the sender's promise
    // unsettled forever, which is exactly the hang this guards against.
    console.error(`${LOG} handler threw synchronously`, error);
    sendResponse({ ok: false, reason: String(error) });
    return false;
  }

  work.then(sendResponse, (error: unknown) => {
    console.error(`${LOG} handler failed`, error);
    sendResponse({ ok: false, reason: String(error) });
  });
  return true; // keeps the message channel open for the async reply
});

console.log(`${LOG} service worker ready`);

/**
 * Network-side observation.
 *
 * This does *not* fetch anything. Its only job is to notice Wasm that the
 * main-world hook could not see -- most importantly modules compiled inside a
 * Web Worker, where content scripts do not run. Recording it as a note keeps
 * the Scorecard honest about its own blind spots instead of silently reporting
 * a clean page.
 */
try {
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
        // when it can see it; buildTabReport drops notes whose URL already has
        // a captured sighting, so only genuine blind spots reach the popup.
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
  networkObserverActive = true;
} catch (error) {
  // Observational webRequest is only used to notice modules the main-world hook
  // could not see. Losing it costs coverage reporting, not capture.
  console.warn(`${LOG} network observer unavailable`, error);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTab(tabId).catch(() => undefined);
});

/** A committed navigation retires the previous page's findings for that tab. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" || !changeInfo.url) return;
  void clearTab(tabId)
    .then(() => refreshBadge(tabId))
    .then(() => undefined)
    .catch(() => undefined);
});
