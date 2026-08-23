/**
 * Worker instrumentation: the capture layer's one remaining blind spot.
 *
 * Content scripts do not run inside Web Workers, so until now a module compiled
 * in a worker was reported as `network-only` -- observed, never analysed. That
 * is the gap a miner would live in: worker fan-out is how one page saturates
 * every core, so the modules most worth analysing are precisely the ones we
 * could not reach.
 *
 * The only way to get code in front of a worker's own script is to start the
 * worker from a `blob:` shim that loads our hooks first and the real script
 * second. Everything below exists to make that swap invisible to the page:
 *
 *  - the shim loads the real script itself, in the same order and (for classic
 *    workers) with the same synchronous timing the page would have had;
 *  - `worker-scope.ts` puts the worker's base URL back where the page expects
 *    it, so relative fetches still resolve against the real script;
 *  - captures travel back over `postMessage` with a channel marker, and this
 *    module intercepts them before any page listener can be registered, so the
 *    page never sees a message it did not send;
 *  - anything that throws falls back to the untouched constructor. A page whose
 *    worker does not start is a far worse outcome than a module not analysed.
 *
 * The globals are injected rather than reached for, so the whole thing runs
 * against fakes in a test.
 */
import type { HookCapture, HookSkip } from "./capture-hooks";

/** Marks a message as ours rather than the page's, in both directions. */
export const WORKER_CHANNEL = "wasm-sentry:worker:v1";

/** Configuration handed to the prelude through the shim. */
export interface WorkerBootstrap {
  /** Absolute URL of the script the page actually asked to run. */
  base: string;
  /** Whether the real script is a classic script or an ES module. */
  type: "classic" | "module";
  /** Blob URL of the prelude bundle, reused by nested workers. */
  preludeUrl: string;
  channel: typeof WORKER_CHANNEL;
}

/** A capture forwarded up from inside a worker. */
export interface WorkerCaptureMessage {
  channel: typeof WORKER_CHANNEL;
  capture: HookCapture | HookSkip;
}

export function isWorkerCaptureMessage(value: unknown): value is WorkerCaptureMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<WorkerCaptureMessage>;
  return message.channel === WORKER_CHANNEL && typeof message.capture === "object";
}

/**
 * Source of the shim the worker actually starts from.
 *
 * Classic workers get `importScripts`, which is synchronous: the prelude has
 * installed its hooks and the real script has run by the time the constructor's
 * caller sees the worker, exactly as before.
 *
 * Module workers cannot use `importScripts` and have to `await` two dynamic
 * imports, which opens a window in which a `postMessage` from the page would
 * arrive before the real script has registered its handler -- a message the
 * page would simply lose. The buffer closes that window: messages received
 * during startup are queued and re-dispatched, in order, once the real script
 * is running.
 */
export function buildShimSource(bootstrap: WorkerBootstrap): string {
  const config = JSON.stringify(bootstrap);

  if (bootstrap.type === "classic") {
    return [
      `self.__WASM_SENTRY__ = ${config};`,
      `importScripts(${JSON.stringify(bootstrap.preludeUrl)});`,
      `importScripts(${JSON.stringify(bootstrap.base)});`,
      "",
    ].join("\n");
  }

  return [
    `self.__WASM_SENTRY__ = ${config};`,
    "const __ws_queue = [];",
    "const __ws_buffer = (event) => __ws_queue.push(event);",
    "self.addEventListener('message', __ws_buffer);",
    `await import(${JSON.stringify(bootstrap.preludeUrl)});`,
    `await import(${JSON.stringify(bootstrap.base)});`,
    "self.removeEventListener('message', __ws_buffer);",
    "for (const event of __ws_queue) {",
    "  self.dispatchEvent(new MessageEvent('message', {",
    "    data: event.data, origin: event.origin,",
    "    lastEventId: event.lastEventId, ports: event.ports,",
    "  }));",
    "}",
    "",
  ].join("\n");
}

/**
 * Whether a worker script is one we can safely put a shim in front of.
 *
 * A worker script is always same-origin, a `blob:` or a `data:` URL -- the
 * platform refuses anything else -- so this rejects almost nothing in practice.
 * It exists so that an exotic specifier we have not reasoned about (a
 * `TrustedScriptURL`, a scheme handled by an extension) runs untouched rather
 * than being stringified into something that only looks right.
 */
export function isInstrumentable(specifier: unknown, pageOrigin: string): specifier is string | URL {
  if (typeof specifier !== "string" && !(specifier instanceof URL)) return false;
  try {
    const url = new URL(String(specifier), pageOrigin);
    if (url.protocol === "blob:" || url.protocol === "data:") return true;
    return url.origin === new URL(pageOrigin).origin;
  } catch {
    return false;
  }
}

export interface WorkerHookOptions {
  /** The constructor to wrap. */
  workerCtor: typeof Worker;
  /**
   * The prelude, as bundled source in the document or as the blob URL the
   * document already made. A nested worker takes the URL: blob URLs are
   * origin-scoped and a dedicated worker shares its owner's store, so there is
   * no reason to publish a second copy of the same bundle.
   */
  prelude: { source: string } | { url: string };
  /** Base URL relative specifiers are resolved against -- the page or worker URL. */
  pageUrl: string;
  /** Where captures forwarded out of a worker go. Must not throw. */
  emit: (message: HookCapture | HookSkip) => void;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** Injected for tests; defaults to `setTimeout`. */
  schedule?: (task: () => void, ms: number) => void;
}

/**
 * How long a shim's blob URL is kept alive after the worker is constructed.
 *
 * The worker fetches its script asynchronously, so the URL cannot be revoked
 * immediately; it also cannot be kept forever, or a page that spawns workers in
 * a loop accumulates blob entries for the life of the document. Ten seconds is
 * far longer than a same-origin script fetch and short enough to bound growth.
 */
const SHIM_URL_TTL_MS = 10_000;

export interface WorkerHook {
  /** The wrapped constructor to install in place of the original. */
  Worker: typeof Worker;
  /**
   * Stop instrumenting workers constructed from now on.
   *
   * The setting that drives this lives in extension storage, which is async,
   * while the hook has to be installed synchronously at `document_start`.
   * Instrumentation is therefore on by default and switched off a few
   * milliseconds later if the user has disabled it -- so a worker constructed
   * in that window is still instrumented, and the setting takes full effect on
   * the next navigation.
   */
  disable: () => void;
}

export function installWorkerHook(options: WorkerHookOptions): WorkerHook {
  const { workerCtor, prelude, pageUrl, emit, createObjectURL, revokeObjectURL } = options;
  const schedule = options.schedule ?? ((task, ms) => setTimeout(task, ms));

  let enabled = true;
  /** Created once per document and shared by every worker, nested ones included. */
  let preludeUrl: string | null = "url" in prelude ? prelude.url : null;

  function ensurePreludeUrl(): string {
    if (preludeUrl === null) {
      const source = "source" in prelude ? prelude.source : "";
      preludeUrl = createObjectURL(new Blob([source], { type: "text/javascript" }));
    }
    return preludeUrl;
  }

  /** Take our own messages out of the stream before the page can see them. */
  function interceptCaptures(worker: Worker): void {
    worker.addEventListener("message", (event: MessageEvent) => {
      if (!isWorkerCaptureMessage(event.data)) return;
      // Registered before the page can attach a handler, so stopping immediate
      // propagation here means no page listener ever runs for this event. The
      // page did not send this message and must not observe it.
      event.stopImmediatePropagation();
      try {
        emit(event.data.capture);
      } catch {
        /* A broken transport must not surface as a page-visible error. */
      }
    });
  }

  const wrapped = new Proxy(workerCtor, {
    construct(target, args, newTarget) {
      const specifier = args[0];
      const rawOptions = args[1] as WorkerOptions | undefined;

      if (!enabled || !isInstrumentable(specifier, pageUrl)) {
        return Reflect.construct(target, args, newTarget);
      }

      let shimUrl: string | null = null;
      let worker: Worker;

      // Everything that can send us back to the untouched constructor happens
      // in here, and nothing else does. Constructing a worker is not a pure
      // act -- it starts fetching and running a script -- so a failure *after*
      // it exists must never be answered by constructing a second one.
      try {
        const base = new URL(String(specifier), pageUrl).href;
        const shim = buildShimSource({
          base,
          type: rawOptions?.type === "module" ? "module" : "classic",
          preludeUrl: ensurePreludeUrl(),
          channel: WORKER_CHANNEL,
        });
        shimUrl = createObjectURL(new Blob([shim], { type: "text/javascript" }));
        worker = Reflect.construct(target, [shimUrl, ...args.slice(1)], newTarget) as Worker;
      } catch {
        // Content Security Policy is the expected failure: a policy that
        // forbids `blob:` workers rejects the shim at construction. Falling
        // back leaves the page working and the module unanalysed, which is the
        // trade this whole file is built around.
        if (shimUrl !== null) revokeObjectURL(shimUrl);
        return Reflect.construct(target, args, newTarget);
      }

      try {
        interceptCaptures(worker);
        schedule(() => revokeObjectURL(shimUrl as string), SHIM_URL_TTL_MS);
      } catch {
        // The worker is already running the page's script. Losing our listener
        // costs us its captures; it costs the page nothing.
      }
      return worker;
    },
  });

  return {
    Worker: wrapped,
    disable: () => {
      enabled = false;
    },
  };
}
