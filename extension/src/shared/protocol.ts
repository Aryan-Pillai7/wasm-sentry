import type { ArtifactAnalysis, ArtifactKind, CaptureSource, WasmApi } from "@wasm-sentry/core";

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
}

/** Reported when an artifact was seen but deliberately not captured. */
export interface SkipRequest {
  type: "wasm-sentry:skipped";
  api: WasmApi;
  url: string;
  pageUrl: string;
  size: number;
  reason: "too-large" | "rate-limited" | "read-failed";
}

/** Popup asking the service worker what it has seen in a given tab. */
export interface TabReportRequest {
  type: "wasm-sentry:tab-report";
  tabId: number;
}

export type ExtensionMessage = CaptureRequest | SkipRequest | TabReportRequest;

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
  firstSeen: number;
  lastSeen: number;
  /** Times seen in this tab (not globally). */
  sightings: number;
  /** Static analysis, once it has run. Absent means still queued. */
  analysis?: ArtifactAnalysis;
}

/** Everything the popup needs to render one tab. */
export interface TabReport {
  tabId: number;
  pageUrl: string;
  artifacts: TabArtifactView[];
  notes: Array<{ url: string; reason: string; size: number; api?: WasmApi; timestamp: number }>;
}
