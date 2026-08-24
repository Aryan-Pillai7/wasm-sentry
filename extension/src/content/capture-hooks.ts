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
  /**
   * The page-side fingerprint of these bytes.
   *
   * Carried so runtime samples, which can only be keyed by something the page
   * can compute, can be matched back to the artifact the service worker hashed.
   */
  fingerprint: string;
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
  /**
   * Synchronous instantiation. Not a capture path -- it takes an already
   * compiled `Module`, whose bytes were seen by `compile` -- but it is a path
   * to a fresh set of exports, which is what runtime timing attaches to.
   */
  Instance?: typeof WebAssembly.Instance;
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
  /**
   * Wrap an instance's exports so time spent inside them can be measured, and
   * return what the page should see.
   *
   * Absent by default: this is the only part of the capture layer that hands
   * the page something other than what the engine produced, so it is opt-in at
   * the call site rather than something the hooks do on their own.
   */
  instrument?: (fingerprint: string, exports: Record<string, unknown>) => Record<string, unknown>;
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
 * Wrap the five entry points through which a module can reach the engine, and
 * -- when runtime monitoring is on -- the two through which it gets its exports.
 *
 * Hard rule: never change what the page observes. The real function is always
 * called with the arguments it was given, our own exceptions are swallowed, and
 * capture work is deferred off the critical path. Instrumentation is the single
 * deliberate exception, which is why it arrives as an injected function rather
 * than as something these hooks do by default: with `instrument` absent, this
 * file behaves exactly as it did before runtime monitoring existed.
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

  /**
   * Record a set of bytes, and return the fingerprint that identifies them.
   *
   * The fingerprint is returned even when the capture itself is dropped as a
   * duplicate: the bytes are still the same module, and runtime samples taken
   * from a second instantiation belong with the first one's captures.
   */
  function report(api: WasmApi, url: string, bytes: Uint8Array): string | null {
    try {
      if (bytes.length === 0) return null;
      if (bytes.length > maxBytes) {
        safeEmit({ api, url, size: bytes.length, skipped: "too-large" });
        return null;
      }
      const print = fingerprint(bytes);
      if (reported.has(print)) return print;
      reported.add(print);

      if (!withinRateLimit()) {
        safeEmit({ api, url, size: bytes.length, skipped: "rate-limited" });
        return print;
      }

      // Copy before deferring: the caller owns the original buffer and is free
      // to reuse or detach it the moment the real API call returns.
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      defer(() => safeEmit({ api, url, size: copy.length, bytes: copy, fingerprint: print }));
      return print;
    } catch {
      /* Capture must never break the page. */
      return null;
    }
  }

  /**
   * Read a streaming source without disturbing the response the engine gets.
   *
   * Resolves with the fingerprint so a streaming instantiation's exports can be
   * attributed to the module they came from -- or with `null` if the read
   * failed, in which case the exports are simply not instrumented.
   */
  function captureResponse(api: WasmApi, response: Response): Promise<string | null> {
    try {
      const copy = response.clone();
      return copy
        .arrayBuffer()
        .then((buffer) => report(api, response.url || `inline:${api}`, new Uint8Array(buffer)))
        .catch(() => {
          safeEmit({ api, url: response.url, size: 0, skipped: "read-failed" });
          return null;
        });
    } catch {
      safeEmit({ api, url: response.url, size: 0, skipped: "read-failed" });
      return Promise.resolve(null);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Runtime attribution                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Which module a compiled `WebAssembly.Module` came from.
   *
   * `instantiate(module)` and `new Instance(module)` carry no bytes -- they take
   * something `compile` already produced -- so the link back to the bytes has to
   * be remembered when that `Module` was created. A `WeakMap` keeps it without
   * holding the module alive.
   */
  const moduleFingerprints = new WeakMap<object, string>();

  function rememberModule(module: unknown, print: string | null): void {
    if (print !== null && typeof module === "object" && module !== null) {
      moduleFingerprints.set(module, print);
    }
  }

  /**
   * Hand back an instance whose exports are timed.
   *
   * The instance itself is wrapped in a Proxy rather than replaced, so
   * `instanceof WebAssembly.Instance` still holds and everything except
   * `exports` is the engine's own. Any failure here returns the untouched
   * instance: losing a measurement is nothing, breaking instantiation is
   * everything.
   */
  function instrumentInstance(print: string | null | undefined, instance: unknown): unknown {
    const instrument = options.instrument;
    if (!instrument || !print || typeof instance !== "object" || instance === null) return instance;

    try {
      const exports = (instance as { exports?: unknown }).exports;
      if (typeof exports !== "object" || exports === null) return instance;
      const wrapped = instrument(print, exports as Record<string, unknown>);

      return new Proxy(instance as object, {
        get(target, property) {
          if (property === "exports") return wrapped;
          // Read with the target as receiver rather than the proxy: `exports`
          // is a branded accessor, and handing it the proxy as `this` fails its
          // brand check.
          return Reflect.get(target, property, target);
        },
      });
    } catch {
      return instance;
    }
  }

  /** Instrument whichever shape an instantiation resolved to. */
  function instrumentResult(print: string | null | undefined, result: unknown): unknown {
    if (!options.instrument || !print) return result;
    try {
      if (typeof result !== "object" || result === null) return result;
      // `instantiate(bytes)` resolves to `{ module, instance }`; `instantiate(module)`
      // resolves to the instance itself.
      if ("instance" in result && "module" in result) {
        const pair = result as { module: unknown; instance: unknown };
        rememberModule(pair.module, print ?? null);
        return { module: pair.module, instance: instrumentInstance(print, pair.instance) };
      }
      return instrumentInstance(print, result);
    } catch {
      return result;
    }
  }

  const originals: WasmNamespace = {
    instantiate: wasm.instantiate,
    instantiateStreaming: wasm.instantiateStreaming,
    compile: wasm.compile,
    compileStreaming: wasm.compileStreaming,
    Module: wasm.Module,
    ...(wasm.Instance !== undefined ? { Instance: wasm.Instance } : {}),
  };

  // Each hook is installed independently. A page is free to have deleted or
  // replaced any of these before we run, and losing one entry point must not
  // cost us the other four.
  if (typeof originals.instantiate === "function") wasm.instantiate = function instantiate(source: never, ...rest: never[]) {
    const bytes = asBytes(source);
    // Bytes give us the fingerprint directly; a `Module` argument was compiled
    // earlier, so its fingerprint was remembered then.
    const print = bytes
      ? report("instantiate", "inline:instantiate", bytes)
      : typeof source === "object" && source !== null
        ? moduleFingerprints.get(source)
        : undefined;

    const result = originals.instantiate.call(wasm, source, ...rest);
    if (!options.instrument || !print) return result;
    return Promise.resolve(result).then((value) =>
      instrumentResult(print, value),
    ) as ReturnType<typeof wasm.instantiate>;
  } as typeof wasm.instantiate;

  if (typeof originals.compile === "function") wasm.compile = function compile(source: never, ...rest: never[]) {
    const bytes = asBytes(source);
    const print = bytes ? report("compile", "inline:compile", bytes) : null;
    const result = originals.compile.call(wasm, source, ...rest);
    // Remember which bytes produced this Module, so the instantiation that
    // follows -- which carries no bytes at all -- can still be attributed.
    if (print) {
      void Promise.resolve(result).then(
        (module) => rememberModule(module, print),
        () => undefined,
      );
    }
    return result;
  } as typeof wasm.compile;

  // Awaiting the response *before* calling through is deliberate: `clone()`
  // throws once the engine has started draining the body, so we have to get in
  // front of it rather than racing it. The page cannot observe the extra
  // microtask -- both functions already return promises.
  if (typeof originals.instantiateStreaming === "function")
    wasm.instantiateStreaming = function instantiateStreaming(source: never, ...rest: never[]) {
    return Promise.resolve(source as unknown as Response | Promise<Response>).then((response) => {
      const capture = captureResponse("instantiateStreaming", response);
      const result = originals.instantiateStreaming.call(wasm, response as never, ...rest);
      if (!options.instrument) return result;
      // The page is already waiting on instantiation, so joining the capture
      // here adds no round trip it was not making anyway -- and without the
      // fingerprint there is nothing to attribute the exports to.
      return Promise.all([result, capture]).then(([value, print]) =>
        instrumentResult(print, value),
      ) as typeof result;
    });
  } as typeof wasm.instantiateStreaming;

  if (typeof originals.compileStreaming === "function")
    wasm.compileStreaming = function compileStreaming(source: never, ...rest: never[]) {
    return Promise.resolve(source as unknown as Response | Promise<Response>).then((response) => {
      const capture = captureResponse("compileStreaming", response);
      const result = originals.compileStreaming.call(wasm, response as never, ...rest);
      void Promise.all([result, capture])
        .then(([module, print]) => rememberModule(module, print))
        .catch(() => undefined);
      return result;
    });
  } as typeof wasm.compileStreaming;

  // A Proxy rather than a subclass: it forwards `new`, keeps `instanceof`
  // working for page code, and leaves the static helpers (`Module.imports`,
  // `Module.exports`, `Module.customSections`) untouched.
  if (typeof originals.Module === "function")
    wasm.Module = new Proxy(originals.Module, {
      construct(target, args, newTarget) {
        const bytes = asBytes(args[0]);
        const print = bytes ? report("Module", "inline:Module", bytes) : null;
        const module = Reflect.construct(target, args, newTarget);
        rememberModule(module, print);
        return module;
      },
    });

  // Not a capture path -- `new Instance(module)` takes something `compile`
  // already handed us -- but it is where a synchronously instantiated module
  // gets its exports, and those are what runtime timing attaches to.
  if (options.instrument && typeof originals.Instance === "function")
    wasm.Instance = new Proxy(originals.Instance, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget);
        const source = args[0];
        const print =
          typeof source === "object" && source !== null
            ? moduleFingerprints.get(source)
            : undefined;
        return instrumentInstance(print, instance) as object;
      },
    });
}
