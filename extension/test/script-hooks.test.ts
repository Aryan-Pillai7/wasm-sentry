import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installScriptHooks,
  isThirdParty,
  readScriptElement,
} from "../src/content/script-hooks";
import type { ExternalScript, InlineScript } from "../src/content/script-hooks";

/**
 * The privacy boundary is the thing under test here, more than the detection.
 *
 * Reading a page's own scripts is the only capture path that can see something
 * the page has not already published to somebody else, so what these assert is
 * mostly what is *not* read: no external script contents, no `eval` wrapper, and
 * nothing at all until the hooks are installed.
 */

const PAGE = "https://app.test/index.html";

/** A DOM small enough to reason about and real enough to hook. */
function fakeDocument(): {
  document: Document;
  add: (element: FakeElement) => void;
} {
  const listeners: Array<(records: Array<{ addedNodes: unknown[] }>) => void> = [];
  const elements: FakeElement[] = [];

  const document = {
    querySelectorAll: (selector: string) =>
      selector === "script" ? elements.filter((element) => element.tagName === "SCRIPT") : [],
    documentElement: {},
  } as unknown as Document;

  // A stand-in for MutationObserver: `observe` records the callback, and `add`
  // delivers to it, which is all the hook uses.
  (globalThis as { MutationObserver?: unknown }).MutationObserver = class {
    constructor(callback: (records: Array<{ addedNodes: unknown[] }>) => void) {
      listeners.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
  };

  return {
    document,
    add: (element) => {
      elements.push(element);
      for (const listener of listeners) listener([{ addedNodes: [element] }]);
    },
  };
}

interface FakeElement {
  tagName: string;
  type: string;
  textContent: string;
  nodeType: number;
  attributes: Record<string, string>;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  querySelectorAll: (selector: string) => FakeElement[];
}

function scriptElement(options: {
  src?: string;
  text?: string;
  type?: string;
  integrity?: boolean;
}): FakeElement {
  const attributes: Record<string, string> = {};
  if (options.src !== undefined) attributes["src"] = options.src;
  if (options.integrity) attributes["integrity"] = "sha384-abc";

  return {
    tagName: "SCRIPT",
    type: options.type ?? "",
    textContent: options.text ?? "",
    nodeType: 1,
    attributes,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
    querySelectorAll: () => [],
  };
}

function harness() {
  const inline: InlineScript[] = [];
  const external: ExternalScript[] = [];
  const dom = fakeDocument();
  const scope: { Function?: unknown } = { Function };

  const stop = installScriptHooks({
    document: dom.document,
    pageOrigin: PAGE,
    scope,
    emitInline: (script) => inline.push(script),
    emitExternal: (script) => external.push(script),
  });

  return { inline, external, add: dom.add, scope, stop };
}

const LONG = `var payload="${"A".repeat(120)}";console.log(payload);`;

/* ------------------------------------------------------------------ */
/* What is and is not read                                             */
/* ------------------------------------------------------------------ */

test("an external script contributes metadata and never its contents", () => {
  const h = harness();
  h.add(scriptElement({ src: "https://cdn.other.test/a.js" }));

  assert.equal(h.inline.length, 0, "nothing was read");
  assert.deepEqual(h.external, [
    {
      url: "https://cdn.other.test/a.js",
      thirdParty: true,
      hasIntegrity: false,
      injected: true,
    },
  ]);
});

test("an inline script the page wrote itself is read", () => {
  const h = harness();
  h.add(scriptElement({ text: LONG }));

  assert.equal(h.inline.length, 1);
  assert.equal(h.inline[0]!.origin, "injected-inline");
  assert.equal(h.inline[0]!.source, LONG);
});

test("data in a script tag is not code", () => {
  const h = harness();
  // `application/json` and importmaps are data. Measuring them would produce
  // findings about a page's configuration.
  h.add(scriptElement({ text: LONG, type: "application/json" }));
  h.add(scriptElement({ text: LONG, type: "importmap" }));
  h.add(scriptElement({ text: LONG, type: "text/template" }));
  assert.equal(h.inline.length, 0);

  h.add(scriptElement({ text: LONG, type: "module" }));
  h.add(scriptElement({ text: LONG, type: "text/javascript" }));
  assert.equal(h.inline.length, 2);
});

test("a one-liner is not worth measuring", () => {
  const h = harness();
  h.add(scriptElement({ text: "var a=1;" }));
  assert.equal(h.inline.length, 0);
});

test("`eval` is left exactly as the engine provided it", () => {
  const before = globalThis.eval;
  const h = harness();

  // Wrapping the global turns every *direct* `eval(...)` in the page into an
  // indirect one, which evaluates in global scope instead of the caller's.
  // That is a change to what the page observes, so it is not made -- and the
  // rules are lexical, so the call is visible in the source anyway.
  assert.equal(globalThis.eval, before);
  h.stop();
});

test("a function built at runtime is seen, and still works", () => {
  const h = harness();
  const Wrapped = h.scope.Function as FunctionConstructor;

  const built = new Wrapped("a", `return a + ${"1".repeat(2)}; /* ${"x".repeat(60)} */`);
  assert.equal((built as (a: number) => number)(1), 12);
  assert.equal(h.inline.length, 1);
  assert.equal(h.inline[0]!.origin, "Function");

  // Called without `new` as well, which is the same constructor.
  const applied = (Wrapped as unknown as (...args: string[]) => unknown)(
    "b",
    `return b * 2; /* ${"y".repeat(60)} */`,
  );
  assert.equal((applied as (b: number) => number)(3), 6);
  assert.equal(h.inline.length, 2);

  h.stop();
  assert.equal(h.scope.Function, Function, "stopping puts the original back");
});

test("the same external script is reported once, however often it appears", () => {
  const h = harness();
  h.add(scriptElement({ src: "https://cdn.other.test/a.js" }));
  h.add(scriptElement({ src: "https://cdn.other.test/a.js" }));
  assert.equal(h.external.length, 1);
});

/* ------------------------------------------------------------------ */
/* Reading one element                                                 */
/* ------------------------------------------------------------------ */

test("integrity and third-partyness are read from the markup", () => {
  const pinned = readScriptElement(
    scriptElement({ src: "https://cdn.other.test/a.js", integrity: true }) as never,
    PAGE,
    false,
  ) as ExternalScript;
  assert.equal(pinned.hasIntegrity, true);
  assert.equal(pinned.thirdParty, true);

  const own = readScriptElement(
    scriptElement({ src: "/js/app.js" }) as never,
    PAGE,
    false,
  ) as ExternalScript;
  assert.equal(own.thirdParty, false);
  assert.equal(own.url, "https://app.test/js/app.js", "resolved against the page");
});

test("third-party is decided by origin, and an unparseable src is not guessed at", () => {
  assert.equal(isThirdParty("https://cdn.other.test/a.js", PAGE), true);
  assert.equal(isThirdParty("/js/a.js", PAGE), false);
  assert.equal(isThirdParty("https://app.test:443/a.js", PAGE), false, "the default port is the same origin");
  assert.equal(isThirdParty("http://app.test/a.js", PAGE), true, "so is the scheme");
  assert.equal(isThirdParty("::::", PAGE), false);
});

test("a hostile DOM does not surface as a page-visible error", () => {
  const h = harness();
  const hostile = {
    tagName: "SCRIPT",
    nodeType: 1,
    get type(): string {
      throw new Error("no");
    },
    querySelectorAll: () => [],
  } as unknown as FakeElement;

  assert.doesNotThrow(() => h.add(hostile));
  assert.equal(h.inline.length, 0);
});
