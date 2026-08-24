/**
 * Runtime sampling, from inside the page's own world.
 *
 * Static analysis cannot separate a hashing kernel from an image codec -- the
 * project measured that and wrote it down. What separates them is that one of
 * them runs flat out for minutes, so this measures exactly that: time spent
 * inside a module's exports, how starved the context's own event loop is, and
 * how many contexts and sockets are involved.
 *
 * Two constraints shape everything here.
 *
 * **The measurement must not become the cost.** A module called a million times
 * in a hot loop would spend more time in `performance.now()` than in its own
 * body. Timing therefore switches itself off when the numbers say it is not
 * worth it, leaving a counter and an accumulated total that says out loud it is
 * a floor.
 *
 * **A busy page is not a mining page.** Nothing here decides anything; it
 * reports what happened and lets the rules in `@wasm-sentry/core` -- which can
 * see the static shape too -- reach a verdict over a window long enough to tell
 * a spike from a habit.
 */
import type { ModuleSample, RuntimeReport, SampleContext } from "@wasm-sentry/core";

export interface MonitorOptions {
  context: SampleContext;
  /** Monotonic clock, in milliseconds. */
  now: () => number;
  /** `navigator.hardwareConcurrency`, or 0 when unavailable. */
  hardwareConcurrency: number;
  /** Where periodic reports go. Must not throw. */
  report: (report: RuntimeReport) => void;
  /** Repeating timer. Returns nothing; the monitor never cancels it. */
  every: (task: () => void, ms: number) => void;
  /** Timer interval used to measure how starved this context's event loop is. */
  tickMs?: number;
  /** How often a report is sent. */
  reportEveryMs?: number;
}

/** One tick per second: frequent enough to see starvation, cheap enough to ignore. */
const DEFAULT_TICK_MS = 1_000;
const DEFAULT_REPORT_MS = 10_000;

/**
 * When to stop timing individual calls.
 *
 * A module whose exports are called tens of thousands of times with a mean
 * duration in the microseconds is a library being used, not a kernel being run,
 * and two `performance.now()` calls per invocation would be a real tax on the
 * page. Counting continues; the accumulated time becomes a floor, and every
 * finding built on it says so.
 */
const TIMING_CALL_LIMIT = 20_000;
const TIMING_MEAN_MS = 0.05;

interface ModuleState {
  wasmTimeMs: number;
  callCount: number;
  longestCallMs: number;
  timingStopped: boolean;
}

export interface RuntimeMonitor {
  /**
   * Wrap an instance's exports so calls into them are timed.
   *
   * Returns what the page should see. Non-function exports -- memories, tables,
   * globals -- are passed straight through: they carry no time and wrapping
   * them could only break something.
   */
  instrument: (fingerprint: string, exports: Record<string, unknown>) => Record<string, unknown>;
  /** A worker was started from this context. */
  noteWorker: () => void;
  /** A WebSocket was opened from this context. */
  noteSocket: () => void;
  /** A message crossed a WebSocket opened from this context. */
  noteSocketMessage: () => void;
  /** The report that would be sent right now. */
  snapshot: () => RuntimeReport;
  /**
   * Stop instrumenting and stop reporting.
   *
   * The setting behind this lives in extension storage, which is async, while
   * the monitor has to exist before the page's first line runs -- so monitoring
   * starts on and is switched off a few milliseconds later when the user has
   * turned it off. Modules instrumented in that window keep their wrappers,
   * which by then cost a counter increment; nothing new is wrapped, and nothing
   * further is sent.
   */
  disable: () => void;
}

export function createMonitor(options: MonitorOptions): RuntimeMonitor {
  const { context, now, hardwareConcurrency, report, every } = options;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const reportEveryMs = options.reportEveryMs ?? DEFAULT_REPORT_MS;

  const startedAt = now();
  const modules = new Map<string, ModuleState>();

  let workerCount = 0;
  let socketCount = 0;
  let socketMessages = 0;

  let enabled = true;

  let driftSamples = 0;
  let driftLateMs = 0;
  let driftMaxLateMs = 0;
  let lastTickAt = startedAt;

  /**
   * A timer asked for every `tickMs` that arrives late says the thread was busy
   * with something else. It costs one closure per second and needs no
   * permission, unlike anything that reports CPU directly.
   */
  every(() => {
    const at = now();
    const late = Math.max(0, at - lastTickAt - tickMs);
    lastTickAt = at;
    driftSamples++;
    driftLateMs += late;
    if (late > driftMaxLateMs) driftMaxLateMs = late;
  }, tickMs);

  function stateFor(fingerprint: string): ModuleState {
    let state = modules.get(fingerprint);
    if (!state) {
      state = { wasmTimeMs: 0, callCount: 0, longestCallMs: 0, timingStopped: false };
      modules.set(fingerprint, state);
    }
    return state;
  }

  function snapshot(): RuntimeReport {
    const samples: ModuleSample[] = [];
    for (const [fingerprint, state] of modules) {
      samples.push({
        fingerprint,
        wasmTimeMs: Math.round(state.wasmTimeMs),
        callCount: state.callCount,
        longestCallMs: Math.round(state.longestCallMs),
        timingStopped: state.timingStopped,
      });
    }
    return {
      context,
      observedMs: Math.round(now() - startedAt),
      drift: {
        samples: driftSamples,
        lateMs: Math.round(driftLateMs),
        maxLateMs: Math.round(driftMaxLateMs),
      },
      workerCount,
      socketCount,
      socketMessages,
      hardwareConcurrency,
      modules: samples,
    };
  }

  every(() => {
    if (!enabled) return;
    try {
      // Nothing to say yet is worth saying: the service worker needs to know a
      // module has been watched and stayed quiet, not just hear about the ones
      // that were noisy.
      report(snapshot());
    } catch {
      /* A closed extension context must not surface as a page-visible error. */
    }
  }, reportEveryMs);

  function wrap(state: ModuleState, name: string, fn: (...args: unknown[]) => unknown): unknown {
    const wrapped = function instrumented(this: unknown, ...args: unknown[]): unknown {
      if (state.timingStopped) {
        state.callCount++;
        return fn.apply(this, args);
      }

      const start = now();
      try {
        return fn.apply(this, args);
      } finally {
        const elapsed = now() - start;
        state.callCount++;
        state.wasmTimeMs += elapsed;
        if (elapsed > state.longestCallMs) state.longestCallMs = elapsed;

        // Past this point the wrapper only counts, which is a single increment
        // -- far less than the two clock reads it replaces.
        if (
          state.callCount >= TIMING_CALL_LIMIT &&
          state.wasmTimeMs / state.callCount < TIMING_MEAN_MS
        ) {
          state.timingStopped = true;
        }
      }
    };

    // Page code reads these -- Emscripten checks `length` when building its own
    // call shims -- and a wrapper that reports the wrong arity is a wrapper
    // that changes what the page observes.
    try {
      Object.defineProperty(wrapped, "name", { value: name, configurable: true });
      Object.defineProperty(wrapped, "length", { value: fn.length, configurable: true });
    } catch {
      /* Non-configurable in some engines; the wrapper still works. */
    }
    return wrapped;
  }

  /**
   * A copy, not a Proxy.
   *
   * The obvious implementation is a `Proxy` with a `get` trap, and it does not
   * work: an instance's exports namespace is created with a null prototype and
   * then *frozen*, so every property is non-configurable and non-writable. A
   * proxy over it may not return anything other than the target's own value --
   * the invariant check throws a `TypeError` on the first access. The failure
   * would surface inside the page's own code, at the first call into its
   * module, which is the worst possible place for it.
   *
   * So the namespace is reproduced: same key order, same null prototype, frozen
   * the same way, with function exports replaced by their timed wrappers and
   * everything else -- memories, tables, globals -- passed through untouched.
   */
  function instrument(
    fingerprint: string,
    exports: Record<string, unknown>,
  ): Record<string, unknown> {
    // Switched off: hand back exactly what the engine produced. Not a copy of
    // it, not a frozen lookalike -- the same object.
    if (!enabled) return exports;

    const state = stateFor(fingerprint);
    const copy = Object.create(null) as Record<string, unknown>;

    for (const name of Object.getOwnPropertyNames(exports)) {
      const value = exports[name];
      if (typeof value !== "function") {
        copy[name] = value;
        continue;
      }
      // Wrapped once per instance, never cached across instances: two
      // instances of the same module have different export functions, and a
      // wrapper shared between them would call the wrong one.
      copy[name] = wrap(state, name, value as (...args: unknown[]) => unknown);
    }

    return Object.freeze(copy);
  }

  return {
    instrument,
    noteWorker: () => {
      workerCount++;
    },
    noteSocket: () => {
      socketCount++;
    },
    noteSocketMessage: () => {
      socketMessages++;
    },
    snapshot,
    disable: () => {
      enabled = false;
    },
  };
}
