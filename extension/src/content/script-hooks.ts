/**
 * Observing the JavaScript a page runs.
 *
 * This is the part that needed a consent design before it needed code, and the
 * design is the reason it is shaped the way it is. A page's scripts can carry
 * far more of somebody's private business than a compiled WebAssembly module
 * does -- an internal build, an authenticated application, a session token
 * inlined into a bootstrap script. So:
 *
 * 1. **It is off by default.** Every other capture path is on, because none of
 *    them can see anything the page has not already published to itself. This
 *    one can, so the user turns it on.
 * 2. **Nothing is re-fetched.** External scripts are never read. What is
 *    recorded about them is their origin, whether they are third-party and
 *    whether they carry Subresource Integrity -- facts already in the markup,
 *    and exactly what the supply-chain rule needs.
 * 3. **What *is* read is only what the page assembled itself**: inline scripts,
 *    and bodies handed to `new Function`. Those never crossed the network, so
 *    nothing else could have seen them, and they are where an obfuscated loader
 *    actually lives.
 * 4. **Source never leaves the browser.** It is measured, and the measurements
 *    are stored; the text is not, and it is excluded from upload even when
 *    upload is enabled.
 *
 * The globals are injected rather than reached for, as everywhere else here, so
 * the whole thing runs against fakes in a test.
 */

/** A piece of source the page assembled and ran itself. */
export interface InlineScript {
  /** How it reached the engine. */
  origin: "inline" | "injected-inline" | "Function";
  source: string;
}

/** An external script, as metadata only. Its contents are never read. */
export interface ExternalScript {
  url: string;
  thirdParty: boolean;
  hasIntegrity: boolean;
  injected: boolean;
}

export interface ScriptHookOptions {
  /** The document to read, and to observe for injected scripts. */
  document: Document;
  /** The page's own origin, for deciding what counts as third-party. */
  pageOrigin: string;
  /** The global to patch `Function` on. See the note below about `eval`. */
  scope: { Function?: unknown };
  /** Where observations go. Must not throw. */
  emitInline: (script: InlineScript) => void;
  emitExternal: (script: ExternalScript) => void;
  /** Longest source we will forward. Beyond this, measuring costs more than it says. */
  maxSourceLength?: number;
}

const DEFAULT_MAX_SOURCE = 2 * 1024 * 1024;

/** Shortest source worth measuring. A one-liner has nothing to hide. */
const MIN_SOURCE = 40;

export function isThirdParty(url: string, pageOrigin: string): boolean {
  try {
    return new URL(url, pageOrigin).origin !== new URL(pageOrigin).origin;
  } catch {
    // An unparseable src is not something to guess about.
    return false;
  }
}

/**
 * Read one `<script>` element into an observation.
 *
 * A script with a `src` is metadata; one without is source the page already
 * has. `type` is checked because `<script type="application/json">` is data,
 * and importmaps and templates are not code either.
 */
export function readScriptElement(
  element: HTMLScriptElement,
  pageOrigin: string,
  injected: boolean,
): InlineScript | ExternalScript | null {
  const type = element.type.toLowerCase().trim();
  const isCode = type === "" || type === "module" || /javascript|ecmascript/.test(type);
  if (!isCode) return null;

  const src = element.getAttribute("src");
  if (src !== null && src !== "") {
    return {
      url: new URL(src, pageOrigin).href,
      thirdParty: isThirdParty(src, pageOrigin),
      hasIntegrity: element.hasAttribute("integrity"),
      injected,
    };
  }

  const source = element.textContent ?? "";
  if (source.length < MIN_SOURCE) return null;
  return { origin: injected ? "injected-inline" : "inline", source };
}

/**
 * Start observing. Returns a function that stops.
 *
 * Only called when the user has enabled JavaScript analysis, which is why
 * nothing here checks a setting: the decision was made before it was installed.
 */
export function installScriptHooks(options: ScriptHookOptions): () => void {
  const { document, pageOrigin, scope, emitInline, emitExternal } = options;
  const maxSource = options.maxSourceLength ?? DEFAULT_MAX_SOURCE;

  const seen = new Set<string>();

  function offer(script: InlineScript | ExternalScript): void {
    try {
      if ("url" in script) {
        if (seen.has(script.url)) return;
        seen.add(script.url);
        emitExternal(script);
        return;
      }
      if (script.source.length > maxSource) return;
      emitInline(script);
    } catch {
      /* Observation must never surface as a page-visible error. */
    }
  }

  function offerElement(element: Element, injected: boolean): void {
    try {
      if (element.tagName !== "SCRIPT") return;
      const script = readScriptElement(element as HTMLScriptElement, pageOrigin, injected);
      if (script) offer(script);
    } catch {
      /* A hostile DOM is the normal case, not an exception. */
    }
  }

  // Whatever is already in the document. At `document_start` this is usually
  // nothing, which is why the observer below matters more.
  for (const element of Array.from(document.querySelectorAll("script"))) {
    offerElement(element, false);
  }

  /**
   * Everything added afterwards.
   *
   * A loader that injects a script element is the pattern this is here for, and
   * it is invisible to a one-time sweep of the document.
   */
  let observer: MutationObserver | undefined;
  try {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node.nodeType !== 1) continue;
          const element = node as Element;
          offerElement(element, true);
          // A subtree can arrive in one mutation -- `innerHTML = "<div><script…"`.
          for (const nested of Array.from(element.querySelectorAll?.("script") ?? [])) {
            offerElement(nested, true);
          }
        }
      }
    });
    observer.observe(document.documentElement ?? document, { childList: true, subtree: true });
  } catch {
    /* No observer is a coverage loss, not a broken page. */
  }

  /* ---------------------------------------------------------------- */
  /* Code built at runtime                                             */
  /* ---------------------------------------------------------------- */

  /**
   * `eval` is deliberately **not** hooked.
   *
   * It is the obvious thing to wrap and it cannot be wrapped honestly. A
   * *direct* `eval(...)` call evaluates in its caller's scope, and that
   * behaviour depends on the callee resolving to the intrinsic `eval` -- so
   * replacing the global turns every direct call in the page into an indirect
   * one, which silently evaluates in global scope instead. That is a change to
   * what the page observes, of exactly the kind the capture layer refuses to
   * make.
   *
   * Nothing is lost that matters. These rules are lexical: `eval(atob("..."))`
   * is visible in the source of the script that contains it, and inline scripts
   * are read in full. The only gap is code that arrives inside an external
   * script -- whose source is deliberately never read -- and evals from there.
   * That gap is worth more than the language semantic.
   */
  const originalFunction = scope.Function;

  if (typeof originalFunction === "function") {
    scope.Function = new Proxy(originalFunction as new (...args: string[]) => unknown, {
      construct(target, args, newTarget) {
        const body = args.at(-1);
        if (typeof body === "string" && body.length >= MIN_SOURCE) {
          offer({ origin: "Function", source: body });
        }
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, thisArg, args) {
        const body = args.at(-1);
        if (typeof body === "string" && body.length >= MIN_SOURCE) {
          offer({ origin: "Function", source: body });
        }
        return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      },
    });
  }

  return () => {
    observer?.disconnect();
    if (typeof originalFunction === "function") scope.Function = originalFunction;
  };
}
