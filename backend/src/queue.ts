/**
 * The analysis queue.
 *
 * One job at a time, in the same process. That is a deliberate ceiling rather
 * than a placeholder: analysis is CPU-bound and synchronous -- the whole engine
 * is, so that it can run inside an MV3 service worker -- so running two at once
 * on one thread finishes neither sooner and only makes the event loop worse.
 * Scaling this means more processes, not more concurrency here.
 *
 * The queue lives in SQLite rather than in memory, so a restart resumes rather
 * than forgetting. A job left `running` by a crash is picked up again on the
 * next start, because the alternative is a job that no one will ever finish.
 */
import { analyzeWasm, summarise } from "@wasm-sentry/core";
import type { Store } from "./db/index.js";

export interface Queue {
  /** Ask the queue to look for work. Safe to call at any time. */
  poke: () => void;
  /** Resolves when the queue has nothing left to do. Used by tests. */
  drain: () => Promise<void>;
  /** Whether a job is being processed right now. */
  busy: () => boolean;
}

export interface QueueOptions {
  store: Store;
  /** Injected so tests can watch progress without polling the database. */
  onFinished?: (jobId: string, hash: string, ok: boolean) => void;
  /** Injected for tests; defaults to `queueMicrotask`. */
  defer?: (task: () => void) => void;
}

export function createQueue(options: QueueOptions): Queue {
  const { store } = options;
  const defer = options.defer ?? queueMicrotask;

  let running = false;
  let idleWaiters: Array<() => void> = [];

  function settleIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function runOne(): boolean {
    const job = store.nextQueued();
    if (!job) return false;

    store.markRunning(job.id);
    const bytes = store.getArtifactBytes(job.hash);
    if (!bytes) {
      // The row is gone but the job survives, which means something deleted the
      // artifact underneath us. Failing the job says so; silently completing it
      // would leave a result nobody could explain.
      store.markFailed(job.id, "artifact bytes are no longer stored");
      options.onFinished?.(job.id, job.hash, false);
      return true;
    }

    // `analyzeWasm` never throws -- a module that cannot be parsed is a result,
    // not an exception -- so a throw here is a bug in this file, not bad input.
    const analysis = summarise(job.hash, analyzeWasm(bytes));
    store.saveResult(job.id, analysis);
    store.markComplete(job.id);
    options.onFinished?.(job.id, job.hash, analysis.ok);
    return true;
  }

  function pump(): void {
    if (running) return;
    running = true;
    try {
      // One job per turn, yielding between them: a burst of uploads must not
      // hold the event loop long enough to stall the requests still arriving.
      const worked = runOne();
      running = false;
      if (worked) defer(pump);
      else settleIdle();
    } catch (error) {
      running = false;
      // Nothing above should throw. If it does, the queue must not wedge.
      console.error("[wasm-sentry] queue failed", error);
      settleIdle();
    }
  }

  return {
    poke: () => defer(pump),
    busy: () => running,
    drain: () =>
      new Promise<void>((resolve) => {
        if (!running && !store.nextQueued()) {
          resolve();
          return;
        }
        idleWaiters.push(resolve);
        defer(pump);
      }),
  };
}

/**
 * Return jobs abandoned mid-flight to the queue.
 *
 * A process killed while analysing leaves a row saying `running` that nothing
 * will ever finish. Analysis is deterministic and idempotent -- same bytes,
 * same verdict -- so re-running one costs a parse and nothing else.
 */
export function requeueAbandoned(store: Store): number {
  let requeued = 0;
  for (let stuck = store.nextRunning(); stuck; stuck = store.nextRunning()) {
    store.requeue(stuck.id);
    requeued++;
  }
  return requeued;
}
