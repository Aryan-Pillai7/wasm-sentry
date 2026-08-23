/**
 * Main-world entry point.
 *
 * Runs inside the page's own JavaScript world at `document_start`, before any
 * page script executes, and installs the capture hooks defined in
 * `capture-hooks.ts`.
 *
 * Why hook the WebAssembly API rather than re-fetch the URL, which is what the
 * first prototype did:
 *
 *   - A second `fetch()` of the same URL is not guaranteed to return the same
 *     bytes. One-time tokens, auth headers and server-side A/B switches all
 *     make the analysed artifact differ from the executed one, which is
 *     precisely the gap an evasive miner hides in.
 *   - `blob:`, `data:` and `WebAssembly.instantiate(buffer)` never touch the
 *     network at all, so `webRequest` never sees them. Pulling bytes over
 *     XHR or a WebSocket and compiling them is a known cryptojacking pattern.
 *   - Re-fetching doubles every module's bandwidth cost on the user's
 *     connection.
 *
 * Content scripts still do not run inside Web Workers, so the same hooks are
 * carried into workers by `worker-hooks.ts`, which starts each worker from a
 * shim that loads them before the worker's own script. A worker we cannot
 * instrument -- one blocked by Content Security Policy -- falls back to running
 * untouched and is reported by the network observer as `network-only`, as
 * before.
 */
import { installHooks } from "./capture-hooks";
import type { HookCapture, HookSkip, WasmNamespace } from "./capture-hooks";
import { installWorkerHook } from "./worker-hooks";

/** Bundled source of `worker-prelude.ts`, inlined at build time. */
declare const __WASM_SENTRY_WORKER_PRELUDE__: string;

const CHANNEL = "wasm-sentry:capture:v1";
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURES_PER_MINUTE = 60;
const INSTALLED = "__wasmSentryInstalled";

/** Where a capture was intercepted, so the report can say which. */
type CaptureContext = "page" | "worker";

function emit(message: HookCapture | HookSkip, context: CaptureContext = "page"): void {
  try {
    // Target origin `*` rather than `location.origin`: sandboxed and
    // `about:blank` frames have an opaque origin that would reject the message.
    // The delivery target is this same window either way, and the page already
    // owns every byte being forwarded, so this discloses nothing new.
    window.postMessage({ channel: CHANNEL, pageUrl: location.href, context, ...message }, "*");
  } catch {
    /* A page that has broken postMessage is not worth crashing over. */
  }
}

const guard = globalThis as unknown as { [INSTALLED]?: boolean };
const wasm = (globalThis as { WebAssembly?: WasmNamespace }).WebAssembly;

if (!guard[INSTALLED]) {
  guard[INSTALLED] = true;

  if (wasm) {
    installHooks({
      wasm,
      emit,
      maxBytes: MAX_ARTIFACT_BYTES,
      maxPerMinute: MAX_CAPTURES_PER_MINUTE,
    });
  }

  // Installed independently of the WebAssembly hooks: a page that deleted
  // `WebAssembly` from its own world can still start a worker that uses it.
  try {
    const scope = globalThis as { Worker?: typeof Worker };
    if (typeof scope.Worker === "function") {
      const hook = installWorkerHook({
        workerCtor: scope.Worker,
        prelude: { source: __WASM_SENTRY_WORKER_PRELUDE__ },
        pageUrl: location.href,
        emit: (message) => emit(message, "worker"),
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      });
      scope.Worker = hook.Worker;

      // The setting lives in extension storage, which is async, while this hook
      // has to exist before the page's first line runs. Instrumentation is
      // therefore on by default and switched off a moment later if the user has
      // turned it off, taking full effect from the next navigation.
      window.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data as { channel?: unknown; command?: unknown } | null;
        if (data?.channel !== CHANNEL || data.command !== "disable-worker-instrumentation") return;
        hook.disable();
      });
    }
  } catch {
    /* Losing worker coverage is a coverage loss, never a broken page. */
  }
}
