/**
 * The WebAssembly interception logic, with every ambient global passed in.
 *
 * Kept separate from `injector.ts` so it can be exercised against a synthetic
 * WebAssembly namespace in tests. Capture correctness is the foundation the
 * rest of the pipeline stands on -- a module we never see is a module we can
 * never rule on -- so it is worth being able to assert on directly.
 */

export type WasmApi =
  | "instantiate"
  | "instantiateStreaming"
  | "compile"
  | "compileStreaming"
  | "Module";

/** A capture ready to leave the page world. */
export interface HookCapture {
  api: WasmApi;
  url: string;
  size: number;
  bytes: Uint8Array;
}

/** An artifact seen but deliberately not captured. */
export interface HookSkip {
  api: WasmApi;
  url: string;
  size: number;
  skipped: "too-large" | "rate-limited" | "read-failed";
}

/** The subset of the `WebAssembly` namespace we wrap. */
export interface WasmNamespace {
  instantiate: typeof WebAssembly.instantiate;
  instantiateStreaming: typeof WebAssembly.instantiateStreaming;
  compile: typeof WebAssembly.compile;
  compileStreaming: typeof WebAssembly.compileStreaming;
  Module: typeof WebAssembly.Module;
}

export interface HookOptions {
  /** The namespace object to patch in place. */
  wasm: WasmNamespace;
  /** Where captures and skips go. Must not throw. */
  emit: (message: HookCapture | HookSkip) => void;
  /** Largest artifact we will forward, in bytes. */
  maxBytes: number;
  /** Captures allowed per rolling minute. */
  maxPerMinute: number;
  /** Injected for deterministic tests. */
  now?: () => number;
  /** Injected for deterministic tests; defaults to `queueMicrotask`. */
  defer?: (task: () => void) => void;
}

/* ------------------------------------------------------------------ */
/* De-duplication                                                      */
/* ------------------------------------------------------------------ */

/**
 * FNV-1a over the length plus three 4 KiB windows of the artifact.
 *
 * This is a *bandwidth* optimisation, not a security boundary -- a page could
 * trivially collide it, and the service worker re-hashes everything with
 * SHA-256 and treats its own result as authoritative. We cannot use SHA-256
 * here because `crypto.subtle` is undefined on plain-http pages, and a miner
 * served over http is still a miner we want to see.
 */
export function fingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  const mix = (byte: number): void => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const length = bytes.length;
  mix(length & 0xff);
  mix((length >>> 8) & 0xff);
  mix((length >>> 16) & 0xff);
  mix((length >>> 24) & 0xff);

  const window = 4096;
  const starts = [0, Math.max(0, (length >> 1) - (window >> 1)), Math.max(0, length - window)];
  for (const start of starts) {
    const end = Math.min(length, start + window);
    for (let i = start; i < end; i++) mix(bytes[i]!);
  }
  return `${length.toString(36)}:${hash.toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* Argument coercion                                                   */
/* ------------------------------------------------------------------ */

/**
 * View a `BufferSource` argument as bytes, or `null` for anything else --
 * notably a `WebAssembly.Module`, which carries no bytes because it was
 * produced by `compile`, which we already captured.
 */
export function asBytes(source: unknown): Uint8Array | null {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Installation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Wrap the five entry points through which a module can reach the engine.
 *
 * Hard rule: never change what the page observes. The real function is always
 * called with the arguments it was given, our own exceptions are swallowed, and
 * capture work is deferred off the critical path.
 */
export function installHooks(options: HookOptions): void {
  const { wasm, emit, maxBytes, maxPerMinute } = options;
  const now = options.now ?? (() => Date.now());
  const defer = options.defer ?? queueMicrotask;

  const reported = new Set<string>();
  let windowStartedAt = now();
  let capturesInWindow = 0;

  function withinRateLimit(): boolean {
    const timestamp = now();
    if (timestamp - windowStartedAt >= 60_000) {
      windowStartedAt = timestamp;
      capturesInWindow = 0;
    }
    return ++capturesInWindow <= maxPerMinute;
  }

  function safeEmit(message: HookCapture | HookSkip): void {
    try {
      emit(message);
    } catch {
      /* A broken transport must not surface as a page-visible error. */
    }
  }

  function report(api: WasmApi, url: string, bytes: Uint8Array): void {
    try {
      if (bytes.length === 0) return;
      if (bytes.length > maxBytes) {
        safeEmit({ api, url, size: bytes.length, skipped: "too-large" });
        return;
      }
      const print = fingerprint(bytes);
      if (reported.has(print)) return;
      reported.add(print);

      if (!withinRateLimit()) {
        safeEmit({ api, url, size: bytes.length, skipped: "rate-limited" });
        return;
      }

      // Copy before deferring: the caller owns the original buffer and is free
      // to reuse or detach it the moment the real API call returns.
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      defer(() => safeEmit({ api, url, size: copy.length, bytes: copy }));
    } catch {
      /* Capture must never break the page. */
    }
  }

  /** Read a streaming source without disturbing the response the engine gets. */
  function captureResponse(api: WasmApi, response: Response): void {
    try {
      const copy = response.clone();
      void copy
        .arrayBuffer()
        .then((buffer) => report(api, response.url || `inline:${api}`, new Uint8Array(buffer)))
        .catch(() => safeEmit({ api, url: response.url, size: 0, skipped: "read-failed" }));
    } catch {
      safeEmit({ api, url: response.url, size: 0, skipped: "read-failed" });
    }
  }

  const originals: WasmNamespace = {
    instantiate: wasm.instantiate,
    instantiateStreaming: wasm.instantiateStreaming,
    compile: wasm.compile,
    compileStreaming: wasm.compileStreaming,
    Module: wasm.Module,
  };

  // Each hook is installed independently. A page is free to have deleted or
  // replaced any of these before we run, and losing one entry point must not
  // cost us the other four.
  if (typeof originals.instantiate === "function") wasm.instantiate = function instantiate(source: never, ...rest: never[]) {
    const bytes = asBytes(source);
    if (bytes) report("instantiate", "inline:instantiate", bytes);
    return originals.instantiate.call(wasm, source, ...rest);
  } as typeof wasm.instantiate;

  if (typeof originals.compile === "function") wasm.compile = function compile(source: never, ...rest: never[]) {
    const bytes = asBytes(source);
    if (bytes) report("compile", "inline:compile", bytes);
    return originals.compile.call(wasm, source, ...rest);
  } as typeof wasm.compile;

  // Awaiting the response *before* calling through is deliberate: `clone()`
  // throws once the engine has started draining the body, so we have to get in
  // front of it rather than racing it. The page cannot observe the extra
  // microtask -- both functions already return promises.
  if (typeof originals.instantiateStreaming === "function")
    wasm.instantiateStreaming = function instantiateStreaming(source: never, ...rest: never[]) {
    return Promise.resolve(source as unknown as Response | Promise<Response>).then((response) => {
      captureResponse("instantiateStreaming", response);
      return originals.instantiateStreaming.call(wasm, response as never, ...rest);
    });
  } as typeof wasm.instantiateStreaming;

  if (typeof originals.compileStreaming === "function")
    wasm.compileStreaming = function compileStreaming(source: never, ...rest: never[]) {
    return Promise.resolve(source as unknown as Response | Promise<Response>).then((response) => {
      captureResponse("compileStreaming", response);
      return originals.compileStreaming.call(wasm, response as never, ...rest);
    });
  } as typeof wasm.compileStreaming;

  // A Proxy rather than a subclass: it forwards `new`, keeps `instanceof`
  // working for page code, and leaves the static helpers (`Module.imports`,
  // `Module.exports`, `Module.customSections`) untouched.
  if (typeof originals.Module === "function")
    wasm.Module = new Proxy(originals.Module, {
      construct(target, args, newTarget) {
        const bytes = asBytes(args[0]);
        if (bytes) report("Module", "inline:Module", bytes);
        return Reflect.construct(target, args, newTarget);
      },
    });
}
