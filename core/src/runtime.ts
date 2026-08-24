/**
 * Runtime behaviour: what a module actually did, not what it could do.
 *
 * Static analysis took this project as far as static analysis goes, and
 * calibration established exactly where that is: a legitimate image codec
 * contains a loop that is *statically indistinguishable* from a hashing kernel
 * (see `docs/detection.md`). Compression, checksums and image filters all take
 * that shape. No amount of further inspection of the bytes separates them.
 *
 * What separates them is that one of them runs flat out for minutes. This is
 * the observation MINOS is built on, and it is why the kernel rule was capped
 * below the high band until this arrived.
 *
 * The vocabulary here is deliberately small and physical -- time on the clock,
 * calls made, timers starved, workers started, sockets opened. Each number has
 * to be something a user could in principle verify with a stopwatch and a task
 * manager, because every finding built on it has to state its evidence.
 */

/** Where a set of samples was collected. */
export type SampleContext = "page" | "worker";

/**
 * One reporting context's view of one module, as sent from the page side.
 *
 * Keyed by the page-side fingerprint rather than the content hash: the page
 * cannot compute SHA-256 over plain http (`crypto.subtle` is undefined there),
 * and the service worker is the only place a hash is trusted anyway. It maps
 * fingerprints back to hashes from the captures it has already accepted.
 */
export interface ModuleSample {
  /** Page-side fingerprint of the module these samples belong to. */
  fingerprint: string;
  /** Wall-clock milliseconds spent inside this module's exported functions. */
  wasmTimeMs: number;
  /** Calls into exported functions. */
  callCount: number;
  /** The longest single call, in milliseconds. */
  longestCallMs: number;
  /**
   * True when per-call timing was switched off because the module was being
   * called in a hot loop and measuring every call had itself become the cost.
   * Counts continue; `wasmTimeMs` stops growing and is a floor from then on.
   */
  timingStopped: boolean;
}

/**
 * How badly the context's own event loop is starved.
 *
 * A periodic timer is scheduled at a fixed interval and its lateness recorded.
 * A context executing a tight WebAssembly loop cannot run its own timers on
 * time, so sustained lateness is direct evidence that something is holding the
 * thread -- and unlike a CPU reading it needs no permission and no platform
 * API that varies by browser.
 */
export interface SchedulerDrift {
  /** Timer ticks observed. */
  samples: number;
  /** Total milliseconds late, summed across ticks. */
  lateMs: number;
  /** The worst single tick, in milliseconds late. */
  maxLateMs: number;
}

/** One context's periodic report. */
export interface RuntimeReport {
  context: SampleContext;
  /** Milliseconds this context has been observed for. */
  observedMs: number;
  drift: SchedulerDrift;
  /** Workers this context started. */
  workerCount: number;
  /** WebSocket connections opened, and messages across them. */
  socketCount: number;
  socketMessages: number;
  /** `navigator.hardwareConcurrency`, for judging whether fan-out is total. */
  hardwareConcurrency: number;
  modules: ModuleSample[];
}

/**
 * Everything observed about one module at runtime, accumulated across every
 * context and every report. This is what the rules read.
 */
export interface RuntimeFeatures {
  /** Milliseconds spent inside this module's exports, summed over contexts. */
  wasmTimeMs: number;
  /** The longest single window any one context has been observed for. */
  observedMs: number;
  /**
   * Execution time as a share of observed time, capped at 1 per context and
   * summed -- so a module saturating four workers reports about 4.0, not 1.0.
   * Fan-out is the point, and a metric that hides it would miss the shape.
   */
  cpuShare: number;
  callCount: number;
  longestCallMs: number;
  /** True if any context gave up on per-call timing; `wasmTimeMs` is a floor. */
  timingStopped: boolean;
  /** Contexts this module ran in, deduplicated. */
  contexts: SampleContext[];
  /** How many separate contexts executed it. Worker fan-out, counted. */
  contextCount: number;
  /** Average timer lateness across contexts running this module, ms per tick. */
  meanDriftMs: number;
  workerCount: number;
  socketCount: number;
  socketMessages: number;
  hardwareConcurrency: number;
  /** Reports folded in so far, so a single spike cannot look like a trend. */
  reportCount: number;
}

export function emptyRuntimeFeatures(): RuntimeFeatures {
  return {
    wasmTimeMs: 0,
    observedMs: 0,
    cpuShare: 0,
    callCount: 0,
    longestCallMs: 0,
    timingStopped: false,
    contexts: [],
    contextCount: 0,
    meanDriftMs: 0,
    workerCount: 0,
    socketCount: 0,
    socketMessages: 0,
    hardwareConcurrency: 0,
    reportCount: 0,
  };
}

/** Mean milliseconds late per timer tick, or 0 when nothing was sampled. */
export function meanDrift(drift: SchedulerDrift): number {
  return drift.samples > 0 ? drift.lateMs / drift.samples : 0;
}

/**
 * Fold one context's report into the running totals for one module.
 *
 * Reports are cumulative per context rather than deltas: a context that is
 * killed between reports (an MV3 worker restart, a terminated Web Worker) would
 * otherwise take its last delta with it. The caller keeps the latest report per
 * context and folds them together, so a lost report costs nothing and a
 * duplicate one cannot double-count.
 */
export function foldRuntime(
  previous: RuntimeFeatures,
  report: RuntimeReport,
  sample: ModuleSample,
): RuntimeFeatures {
  const contexts = previous.contexts.includes(report.context)
    ? previous.contexts
    : [...previous.contexts, report.context];

  // Capped per context: a context cannot spend more time running a module than
  // it has existed for, and a clock skew that says otherwise is not evidence.
  const share = report.observedMs > 0 ? Math.min(sample.wasmTimeMs / report.observedMs, 1) : 0;
  const drift = meanDrift(report.drift);
  const reportCount = previous.reportCount + 1;

  return {
    wasmTimeMs: previous.wasmTimeMs + sample.wasmTimeMs,
    observedMs: Math.max(previous.observedMs, report.observedMs),
    cpuShare: previous.cpuShare + share,
    callCount: previous.callCount + sample.callCount,
    longestCallMs: Math.max(previous.longestCallMs, sample.longestCallMs),
    timingStopped: previous.timingStopped || sample.timingStopped,
    contexts,
    contextCount: previous.contextCount + 1,
    // A running mean, so an idle context reporting late does not erase the
    // starvation a busy one recorded.
    meanDriftMs: (previous.meanDriftMs * previous.reportCount + drift) / reportCount,
    workerCount: Math.max(previous.workerCount, report.workerCount),
    socketCount: Math.max(previous.socketCount, report.socketCount),
    socketMessages: Math.max(previous.socketMessages, report.socketMessages),
    hardwareConcurrency: Math.max(previous.hardwareConcurrency, report.hardwareConcurrency),
    reportCount,
  };
}

/**
 * Fold a whole set of per-context reports into per-module features.
 *
 * The caller passes the latest report from every context it has heard from;
 * this returns one entry per fingerprint that appears in any of them.
 */
export function accumulateRuntime(
  reports: readonly RuntimeReport[],
): Map<string, RuntimeFeatures> {
  const byFingerprint = new Map<string, RuntimeFeatures>();
  for (const report of reports) {
    for (const sample of report.modules) {
      const previous = byFingerprint.get(sample.fingerprint) ?? emptyRuntimeFeatures();
      byFingerprint.set(sample.fingerprint, foldRuntime(previous, report, sample));
    }
  }
  return byFingerprint;
}
