/**
 * What runs inside an instrumented Web Worker, before the worker's own script.
 *
 * Loaded by the `blob:` shim that `worker-hooks.ts` starts the worker from. By
 * the time the real script runs, this has:
 *
 *   1. put the worker's base URL back where the page expects it, so the swap to
 *      a blob script is not observable through relative URL resolution;
 *   2. installed the same WebAssembly hooks the page main world uses, emitting
 *      over `postMessage` with a channel marker the page side strips out;
 *   3. installed the worker hook again, so a worker that spawns workers is
 *      covered too and its captures bubble up one level at a time.
 *
 * Nothing here may throw into the worker: an exception during startup would
 * stop the page's own script from ever running.
 */
import { installHooks } from "./capture-hooks";
import type { HookCapture, HookSkip, WasmNamespace } from "./capture-hooks";
import { installWorkerHook, WORKER_CHANNEL } from "./worker-hooks";
import type { WorkerBootstrap } from "./worker-hooks";
import { applyBaseCompensation } from "./worker-scope";
import type { PatchableScope } from "./worker-scope";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURES_PER_MINUTE = 60;
const INSTALLED = "__wasmSentryWorkerInstalled";

interface WorkerScope extends PatchableScope {
  __WASM_SENTRY__?: WorkerBootstrap;
  [INSTALLED]?: boolean;
  postMessage?: (message: unknown, transfer?: Transferable[]) => void;
  WebAssembly?: WasmNamespace;
}

const scope = globalThis as unknown as WorkerScope;
const bootstrap = scope.__WASM_SENTRY__;

if (bootstrap && !scope[INSTALLED]) {
  scope[INSTALLED] = true;

  // Captured before anything else: the worker's own script is free to replace
  // `postMessage`, and a capture that travels over the page's replacement would
  // be visible to the page and could be dropped by it.
  const post = scope.postMessage?.bind(scope);

  function emit(message: HookCapture | HookSkip): void {
    if (!post) return;
    try {
      // The bytes are a copy the hook made for us, so transferring rather than
      // structured-cloning them is safe and saves copying a module twice.
      const transfer = "bytes" in message ? [message.bytes.buffer as ArrayBuffer] : [];
      post({ channel: WORKER_CHANNEL, capture: message }, transfer);
    } catch {
      /* A worker that cannot talk to its owner is not worth crashing over. */
    }
  }

  try {
    applyBaseCompensation(scope, bootstrap.base);
  } catch {
    /* Compensation is best-effort; losing it must not cost the capture. */
  }

  try {
    const wasm = scope.WebAssembly;
    if (wasm) {
      installHooks({
        wasm,
        emit,
        maxBytes: MAX_ARTIFACT_BYTES,
        maxPerMinute: MAX_CAPTURES_PER_MINUTE,
      });
    }
  } catch {
    /* Nothing here may stop the worker's own script from running. */
  }

  try {
    const nested = scope.Worker;
    if (typeof nested === "function") {
      // `applyBaseCompensation` already wrapped `Worker` to resolve relative
      // specifiers against the real script, so this layers on top of that and
      // both behaviours survive.
      const hook = installWorkerHook({
        workerCtor: nested as typeof Worker,
        // Reuses the blob the document already published rather than making a
        // second copy of this bundle per worker.
        prelude: { url: bootstrap.preludeUrl },
        pageUrl: bootstrap.base,
        emit,
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      });
      scope.Worker = hook.Worker;
    }
  } catch {
    /* A worker that cannot spawn instrumented children still captures its own. */
  }
}
