/**
 * Base URL compensation for an instrumented worker.
 *
 * Capturing WebAssembly inside a Web Worker means the worker has to run our
 * hooks before its own script, and the only way to get code in front of a
 * worker script is to start the worker from a `blob:` URL that loads the real
 * script itself. That works, and it costs one thing: the worker's base URL
 * becomes the blob rather than the script it was asked for, so every relative
 * URL the real script resolves would silently point somewhere else.
 *
 * That is exactly the kind of observable change the capture layer is not
 * allowed to make, so it is undone here. Each patched API resolves a relative
 * argument against the URL the page actually asked for, before the platform
 * gets a chance to resolve it against the blob.
 *
 * The globals are passed in rather than reached for, so the whole thing can be
 * driven against a plain object in a test instead of a real worker.
 */

/** The subset of a worker's global scope this module rewrites. */
export interface PatchableScope {
  location?: unknown;
  importScripts?: (...urls: string[]) => void;
  fetch?: (input: unknown, init?: unknown) => unknown;
  Request?: unknown;
  XMLHttpRequest?: unknown;
  WebSocket?: unknown;
  EventSource?: unknown;
  Worker?: unknown;
  navigator?: { sendBeacon?: (url: string, data?: unknown) => boolean };
}

/**
 * Resolve one argument against the worker's real script URL.
 *
 * Anything that is not a string or a `URL` is handed back untouched: a
 * `Request` object already carries an absolute URL, and a `TrustedScriptURL`
 * must not be stringified or it stops being trusted.
 */
export function resolveAgainst(base: string, value: unknown): unknown {
  if (typeof value !== "string" && !(value instanceof URL)) return value;
  try {
    return new URL(String(value), base).href;
  } catch {
    // An unparseable specifier is the platform's error to report, not ours to
    // swallow or rewrite into something that parses.
    return value;
  }
}

/**
 * A stand-in for `WorkerLocation`.
 *
 * `self.location` inside a blob worker reports the blob URL. Scripts read it to
 * build sibling URLs -- `new URL("./data.bin", location.href)` is the standard
 * idiom -- so it has to report the URL the page asked for. Defined as an own
 * property on the scope, which shadows the prototype getter.
 */
export function workerLocation(base: string): Record<string, unknown> {
  const url = new URL(base);
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    // `String(location)` and `"" + location` are both common; a data property
    // holding the href would make them read "[object Object]".
    toString: () => url.href,
  };
}

/** Wrap a constructor so its first argument is resolved against `base`. */
function rebaseConstructor(base: string, target: unknown): unknown {
  if (typeof target !== "function") return target;
  return new Proxy(target as new (...args: unknown[]) => unknown, {
    construct(ctor, args, newTarget) {
      const rebased = args.length > 0 ? [resolveAgainst(base, args[0]), ...args.slice(1)] : args;
      return Reflect.construct(ctor, rebased, newTarget);
    },
  });
}

/**
 * Point the URL-resolving APIs in `scope` back at `base`.
 *
 * The list is deliberately finite and stated rather than exhaustive: these are
 * the APIs that take a relative URL and resolve it against the worker's own
 * base. Module resolution needs nothing here -- a module worker's real script
 * is imported by URL, so its `import.meta.url` and every dynamic `import()`
 * inside it already resolve against the right place.
 */
export function applyBaseCompensation(scope: PatchableScope, base: string): void {
  try {
    Object.defineProperty(scope, "location", {
      value: workerLocation(base),
      configurable: true,
      writable: true,
    });
  } catch {
    /* A scope that refuses the redefinition still gets everything below. */
  }

  const importScripts = scope.importScripts;
  if (typeof importScripts === "function") {
    scope.importScripts = function patchedImportScripts(...urls: string[]): void {
      return importScripts.apply(
        scope,
        urls.map((url) => resolveAgainst(base, url) as string),
      );
    };
  }

  const originalFetch = scope.fetch;
  if (typeof originalFetch === "function") {
    scope.fetch = function patchedFetch(input: unknown, init?: unknown): unknown {
      return originalFetch.call(scope, resolveAgainst(base, input), init);
    };
  }

  const sendBeacon = scope.navigator?.sendBeacon;
  if (typeof sendBeacon === "function" && scope.navigator) {
    scope.navigator.sendBeacon = function patchedSendBeacon(url: string, data?: unknown): boolean {
      return sendBeacon.call(scope.navigator, resolveAgainst(base, url) as string, data);
    };
  }

  const xhr = scope.XMLHttpRequest;
  if (typeof xhr === "function") {
    const proto = (xhr as { prototype?: { open?: (...args: unknown[]) => unknown } }).prototype;
    const open = proto?.open;
    if (proto && typeof open === "function") {
      // Patched on the prototype rather than by wrapping the constructor: page
      // code holds XHR instances it created before we ran.
      proto.open = function patchedOpen(this: unknown, ...args: unknown[]): unknown {
        const rebased = args.length > 1 ? [args[0], resolveAgainst(base, args[1]), ...args.slice(2)] : args;
        return open.apply(this, rebased);
      };
    }
  }

  for (const key of ["Request", "WebSocket", "EventSource", "Worker"] as const) {
    const target = scope[key];
    if (typeof target === "function") {
      (scope as Record<string, unknown>)[key] = rebaseConstructor(base, target);
    }
  }
}
