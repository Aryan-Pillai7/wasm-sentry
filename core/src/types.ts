/**
 * Shared vocabulary for the whole system.
 *
 * These types cross three process boundaries (page main world -> extension
 * service worker -> backend), so everything here must be structured-clone-able
 * and JSON-serialisable. No classes, no Dates, no Maps.
 */

/** What kind of artifact a capture holds. */
export type ArtifactKind = "wasm" | "js";

/** Which mechanism observed the artifact. */
export type CaptureSource =
  /** Seen on the network via chrome.webRequest. */
  | "webrequest"
  /** Seen at the moment it was handed to the WebAssembly API in the page. */
  | "wasm-api"
  /** Submitted directly by a user or a test harness. */
  | "manual";

/** The WebAssembly entry point a `wasm-api` capture was intercepted at. */
export type WasmApi =
  | "instantiate"
  | "instantiateStreaming"
  | "compile"
  | "compileStreaming"
  | "Module";

/**
 * Metadata about one observed artifact.
 *
 * Identity is the content hash, never the URL: the same module served from a
 * CDN under a hundred different query strings is one artifact, and a
 * one-time-token URL that refuses a second fetch is still analysable because we
 * captured the bytes rather than the address.
 */
export interface CaptureMeta {
  /** SHA-256 of the artifact bytes, lowercase hex. Primary key everywhere. */
  hash: string;
  kind: ArtifactKind;
  /**
   * Where the bytes came from. May be a `blob:` or `data:` URL, or the
   * sentinel `"inline:<api>"` when bytes were handed straight to the
   * WebAssembly API with no URL involved.
   */
  url: string;
  /** Top-level page that caused the load, used for per-site reporting. */
  pageUrl: string;
  /** Byte length of the artifact. */
  size: number;
  source: CaptureSource;
  /** WebAssembly entry point, present when `source === "wasm-api"`. */
  api?: WasmApi;
  /** Chrome tab the capture belongs to; -1 when not attributable. */
  tabId: number;
  /** Frame within the tab, when known. */
  frameId?: number;
  /** Epoch ms of first and most recent sighting of this hash. */
  firstSeen: number;
  lastSeen: number;
  /** How many times this hash has been observed across all sites. */
  seenCount: number;
}

/** A capture together with its bytes, as it travels to an analyser. */
export interface CapturePayload {
  meta: CaptureMeta;
  bytes: Uint8Array;
}

/** Lifecycle of an analysis job. */
export type JobStatus = "queued" | "running" | "complete" | "failed";

/** Coarse risk bands surfaced to the user in the Privacy Scorecard. */
export type RiskLevel = "benign" | "low" | "medium" | "high" | "critical";
