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
import { createMonitor } from "./runtime-monitor";
import { installScriptHooks } from "./script-hooks";
import { installSocketHooks } from "./socket-hooks";
import { installWorkerHook } from "./worker-hooks";
import type { RuntimeReport } from "@wasm-sentry/core";

/** Bundled source of `worker-prelude.ts`, inlined at build time. */
declare const __WASM_SENTRY_WORKER_PRELUDE__: string;

const CHANNEL = "wasm-sentry:capture:v1";
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURES_PER_MINUTE = 60;
const INSTALLED = "__wasmSentryInstalled";

/** Where a capture was intercepted, so the report can say which. */
type CaptureContext = "page" | "worker";

function post(payload: Record<string, unknown>): void {
  try {
    // Target origin `*` rather than `location.origin`: sandboxed and
    // `about:blank` frames have an opaque origin that would reject the message.
    // The delivery target is this same window either way, and the page already
    // owns every byte being forwarded, so this discloses nothing new.
    window.postMessage({ channel: CHANNEL, pageUrl: location.href, ...payload }, "*");
  } catch {
    /* A page that has broken postMessage is not worth crashing over. */
  }
}

function emit(message: HookCapture | HookSkip, context: CaptureContext = "page"): void {
  post({ context, ...message });
}

/**
 * One identity per document, so the service worker can tell a fresh report from
 * a repeat of one it already folded in. It is deliberately not the page URL: a
 * single-page application changes that without ever reloading, and the
 * measurements would then be attributed to two different contexts.
 */
const CONTEXT_ID = `page:${Math.random().toString(36).slice(2)}`;

function sendRuntime(report: RuntimeReport): void {
  post({ runtime: report, contextId: CONTEXT_ID });
}

const guard = globalThis as unknown as { [INSTALLED]?: boolean };
const wasm = (globalThis as { WebAssembly?: WasmNamespace }).WebAssembly;

if (!guard[INSTALLED]) {
  guard[INSTALLED] = true;

  // Created before the hooks so the very first module a page compiles is
  // already being timed. The monitor itself costs one timer per second.
  const monitor = createMonitor({
    context: "page",
    now: () => performance.now(),
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    report: sendRuntime,
    every: (task, ms) => {
      setInterval(task, ms);
    },
  });

  try {
    installSocketHooks(globalThis as never, monitor);
  } catch {
    /* Socket counting is corroboration; losing it costs one signal. */
  }

  if (wasm) {
    installHooks({
      wasm,
      emit,
      maxBytes: MAX_ARTIFACT_BYTES,
      maxPerMinute: MAX_CAPTURES_PER_MINUTE,
      instrument: (fingerprint, exports) => monitor.instrument(fingerprint, exports),
    });
  }

  // Installed independently of the WebAssembly hooks: a page that deleted
  // `WebAssembly` from its own world can still start a worker that uses it.
  let workerHook: { disable: () => void } | undefined;
  try {
    const scope = globalThis as { Worker?: typeof Worker };
    if (typeof scope.Worker === "function") {
      const hook = installWorkerHook({
        workerCtor: scope.Worker,
        prelude: { source: __WASM_SENTRY_WORKER_PRELUDE__ },
        pageUrl: location.href,
        emit: (message) => emit(message, "worker"),
        onRuntimeReport: (report, contextId) => post({ runtime: report, contextId }),
        onWorker: () => monitor.noteWorker(),
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      });
      scope.Worker = hook.Worker;

      workerHook = hook;
    }
  } catch {
    /* Losing worker coverage is a coverage loss, never a broken page. */
  }

  // The capture settings live in extension storage, which is async, while these
  // hooks have to exist before the page's first line runs. Worker
  // instrumentation and runtime monitoring are therefore on by default and
  // switched off a moment later when the user has turned them off, taking full
  // effect from the next navigation.
  //
  // JavaScript analysis is the other way round -- off until the user asks --
  // because it is the only path that reads source the page has not published
  // to anyone else. Missing the first few scripts is the price of not reading
  // them without consent, and it is the right way round to be wrong.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as { channel?: unknown; command?: unknown } | null;
    if (data?.channel !== CHANNEL) return;
    if (data.command === "disable-worker-instrumentation") workerHook?.disable();
    if (data.command === "disable-runtime-monitoring") monitor.disable();
    if (data.command === "enable-javascript-analysis") enableScriptAnalysis();
  });
}

let scriptHooksInstalled = false;

/** Start reading the page's own scripts. Only ever called on an explicit opt-in. */
function enableScriptAnalysis(): void {
  if (scriptHooksInstalled) return;
  scriptHooksInstalled = true;
  try {
    installScriptHooks({
      document,
      pageOrigin: location.href,
      scope: globalThis as { Function?: unknown },
      emitInline: (script) => post({ script: { inline: script } }),
      emitExternal: (script) => post({ script: { external: script } }),
    });
  } catch {
    /* Losing script coverage is a coverage loss, never a broken page. */
  }
}
