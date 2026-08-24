import type {
  ArtifactAnalysis,
  ArtifactKind,
  CaptureSource,
  JsArtifactAnalysis,
  PageScorecard,
  RiskAssessment,
  RiskLevel,
  RuntimeReport,
  WasmApi,
} from "@wasm-sentry/core";

/**
 * Wire protocol between the three contexts the extension runs in.
 *
 *   page main world  --(window.postMessage)-->  isolated content script
 *   isolated script  --(chrome.runtime)------>  service worker
 *
 * The first hop is observable and forgeable by the page: anything running in
 * the main world shares a global object with us, so a hostile page can read our
 * messages (it already has the bytes -- nothing is leaked) and can post fake
 * ones. Forgery is bounded rather than prevented: the service worker enforces
 * size and rate caps, and re-hashes every payload itself instead of trusting
 * the hash the page-side code computed.
 */
export const CAPTURE_CHANNEL = "wasm-sentry:capture:v1";

/**
 * Where a capture was intercepted.
 *
 * Worth carrying all the way to the popup: "compiled inside a Web Worker" was
 * a blind spot until the worker hook landed, and a report that cannot say which
 * modules came from workers cannot show that the blind spot is closed.
 */
export type CaptureContext = "page" | "worker";

/** Hard ceiling on a single captured artifact, before base64 expansion. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** Most captures the page main world may report per minute, per frame. */
export const MAX_CAPTURES_PER_MINUTE = 60;

/** Sent from the page main world to the isolated content script. */
export interface InjectorCaptureMessage {
  channel: typeof CAPTURE_CHANNEL;
  api: WasmApi;
  /** Source URL, or `inline:<api>` when bytes were passed with no URL. */
  url: string;
  pageUrl: string;
  size: number;
  bytes: Uint8Array;
  context?: CaptureContext;
}

/** Sent from the isolated content script to the service worker. */
export interface CaptureRequest {
  type: "wasm-sentry:capture";
  api: WasmApi;
  url: string;
  pageUrl: string;
  size: number;
  /** Artifact bytes, base64 encoded -- see `@wasm-sentry/core` base64 notes. */
  bytesB64: string;
  context?: CaptureContext;
  /**
   * The page-side fingerprint of these bytes.
   *
   * Not trusted for anything -- the service worker hashes the bytes itself --
   * but recorded, because runtime samples can only be keyed by something the
   * page can compute, and over plain http that cannot be a hash.
   */
  fingerprint?: string;
}

/** Reported when an artifact was seen but deliberately not captured. */
export interface SkipRequest {
  type: "wasm-sentry:skipped";
  api: WasmApi;
  url: string;
  pageUrl: string;
  size: number;
  reason: "too-large" | "rate-limited" | "read-failed";
  context?: CaptureContext;
}

/**
 * A context's periodic account of how the modules in it are behaving.
 *
 * Cumulative rather than incremental: a context that is killed between reports
 * -- a terminated worker, a navigation -- would otherwise take its last delta
 * with it, and a duplicate would double-count. The service worker keeps the
 * latest report per context and folds them together.
 */
export interface RuntimeRequest {
  type: "wasm-sentry:runtime";
  /** Stable for the life of the reporting context, so reports supersede. */
  contextId: string;
  pageUrl: string;
  report: RuntimeReport;
}

/**
 * A piece of JavaScript the page assembled and ran, or the metadata of one it
 * loaded. Only sent when the user has enabled JavaScript analysis.
 *
 * Inline source travels to the service worker, is measured there and is *not*
 * stored: what persists is the measurements and the verdict. External scripts
 * are metadata only and their contents are never read at all.
 */
export interface ScriptRequest {
  type: "wasm-sentry:script";
  pageUrl: string;
  /** Present for source the page assembled itself. */
  inline?: { origin: "inline" | "injected-inline" | "Function"; source: string };
  /** Present for a script the page loaded by URL. Never carries its contents. */
  external?: { url: string; thirdParty: boolean; hasIntegrity: boolean; injected: boolean };
}

/** Popup asking the service worker what it has seen in a given tab. */
export interface TabReportRequest {
  type: "wasm-sentry:tab-report";
  tabId: number;
}

/** Liveness probe, so the popup can tell "asleep" from "broken". */
export interface PingRequest {
  type: "wasm-sentry:ping";
}

/** Dashboard asking for the cross-tab activity view. */
export interface ActivityRequest {
  type: "wasm-sentry:activity";
}

/** Dashboard changing a setting. */
export interface UpdateSettingsRequest {
  type: "wasm-sentry:update-settings";
  patch: Record<string, unknown>;
}

/** Dashboard wiping stored state. */
export interface ClearAllRequest {
  type: "wasm-sentry:clear-all";
}

export type ExtensionMessage =
  | CaptureRequest
  | SkipRequest
  | RuntimeRequest
  | ScriptRequest
  | TabReportRequest
  | PingRequest
  | ActivityRequest
  | UpdateSettingsRequest
  | ClearAllRequest;

export function isInjectorMessage(value: unknown): value is InjectorCaptureMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { channel?: unknown }).channel === CAPTURE_CHANNEL
  );
}

/** One artifact as presented in the popup, joined from artifacts + sightings. */
export interface TabArtifactView {
  hash: string;
  kind: ArtifactKind;
  size: number;
  /** Most recent URL this hash was seen at, in this tab. */
  url: string;
  /** How it reached us the last time we saw it in this tab. */
  api?: WasmApi;
  source: CaptureSource;
  /** Whether the last sighting was in the page or inside a Web Worker. */
  context?: CaptureContext;
  firstSeen: number;
  lastSeen: number;
  /** Times seen in this tab (not globally). */
  sightings: number;
  /** Static analysis, once it has run. Absent means still queued. */
  analysis?: ArtifactAnalysis;
}

/** One analysed piece of JavaScript, as the popup receives it. */
export interface TabScriptView {
  hash: string;
  origin: "inline" | "injected-inline" | "Function";
  byteLength: number;
  analysis: JsArtifactAnalysis;
}

/** Everything the popup needs to render one tab. */
export interface TabReport {
  tabId: number;
  pageUrl: string;
  /** The page-level verdict, rolled up from every module below. */
  scorecard: PageScorecard;
  artifacts: TabArtifactView[];
  notes: Array<{ url: string; reason: string; size: number; api?: WasmApi; timestamp: number }>;
  /** Analysed JavaScript. Empty unless the user enabled it. */
  scripts?: TabScriptView[];
  /** The supply-chain verdict over this page's external scripts, if any. */
  supplyChain?: RiskAssessment;
}

/** One line of the activity feed, as the dashboard receives it. */
export interface ActivityEvent {
  timestamp: number;
  kind: "captured" | "analysed" | "skipped" | "alerted" | "cleared";
  pageUrl: string;
  hash?: string;
  size?: number;
  api?: WasmApi;
  level?: RiskLevel;
  score?: number;
  detail?: string;
  context?: CaptureContext;
}

/** A module in the all-sites listing. */
export interface ModuleRow {
  hash: string;
  size: number;
  seenCount: number;
  firstSeen: number;
  lastSeen: number;
  lastPageUrl: string;
  analysis?: ArtifactAnalysis;
}

/** Live self-check, so the extension can show that it is working. */
export interface RuntimeStatus {
  /** Epoch ms the service worker answering this request started. */
  workerStartedAt: number;
  /** Whether the observational network listener registered successfully. */
  networkObserver: boolean;
  /** Chrome's notification permission level, or "unavailable". */
  notificationLevel: string;
  /** Total artifacts retained locally. */
  artifactCount: number;
  /** Epoch ms of the most recent capture, if any. */
  lastCaptureAt: number | null;
}

/** Everything the dashboard renders. */
export interface ActivityReport {
  status: RuntimeStatus;
  settings: Record<string, unknown>;
  events: ActivityEvent[];
  modules: ModuleRow[];
}
