import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildShimSource,
  installWorkerHook,
  isInstrumentable,
  isWorkerCaptureMessage,
  WORKER_CHANNEL,
} from "../src/content/worker-hooks";
import type { HookCapture } from "../src/content/capture-hooks";

const PAGE = "https://app.test/index.html";
const PRELUDE = "/* prelude */";

/**
 * A stand-in for the platform's `Worker`.
 *
 * Instrumentation is the one part of the capture layer that changes how a page
 * loads its own code, so what these tests are really asserting is the blast
 * radius: what the page's constructor receives, what its listeners see, and
 * that every failure path ends with an untouched worker rather than a broken
 * page.
 */
interface Harness {
  Worker: typeof Worker;
  constructed: Array<{ url: string; options: unknown }>;
  blobs: Map<string, string>;
  revoked: string[];
  emitted: unknown[];
  timers: Array<{ task: () => void; ms: number }>;
  disable: () => void;
}

function harness(overrides: { failOnBlob?: boolean } = {}): Harness {
  const constructed: Array<{ url: string; options: unknown }> = [];
  const blobs = new Map<string, string>();
  const revoked: string[] = [];
  const emitted: unknown[] = [];
  const timers: Array<{ task: () => void; ms: number }> = [];
  let counter = 0;

  class FakeWorker extends EventTarget {
    url: string;
    constructor(url: string, options?: unknown) {
      super();
      if (overrides.failOnBlob && url.startsWith("blob:")) {
        throw new DOMException("blocked by Content Security Policy", "SecurityError");
      }
      constructed.push({ url, options });
      this.url = url;
    }
  }

  const hook = installWorkerHook({
    workerCtor: FakeWorker as unknown as typeof Worker,
    prelude: { source: PRELUDE },
    pageUrl: PAGE,
    emit: (message) => emitted.push(message),
    createObjectURL: (blob) => {
      const url = `blob:https://app.test/${++counter}`;
      // The Blob's text is what the worker will actually run, so it is worth
      // keeping rather than just counting the calls.
      blobs.set(url, (blob as unknown as { __text?: string }).__text ?? "");
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
    schedule: (task, ms) => timers.push({ task, ms }),
  });

  return {
    Worker: hook.Worker,
    disable: hook.disable,
    constructed,
    blobs,
    revoked,
    emitted,
    timers,
  };
}

/**
 * Node's `Blob` does not expose its contents synchronously, and the shim source
 * is the thing worth asserting on. Recording it at construction keeps the test
 * synchronous without teaching the production code about tests.
 */
const RealBlob = globalThis.Blob;
class RecordingBlob extends RealBlob {
  __text: string;
  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    this.__text = parts.map((part) => String(part)).join("");
  }
}
globalThis.Blob = RecordingBlob as unknown as typeof Blob;

/* ------------------------------------------------------------------ */
/* Shim source                                                         */
/* ------------------------------------------------------------------ */

test("a classic shim loads the hooks and then the real script, synchronously", () => {
  const source = buildShimSource({
    base: "https://app.test/worker.js",
    type: "classic",
    preludeUrl: "blob:https://app.test/prelude",
    channel: WORKER_CHANNEL,
  });

  const preludeAt = source.indexOf('importScripts("blob:https://app.test/prelude")');
  const scriptAt = source.indexOf('importScripts("https://app.test/worker.js")');
  assert.ok(preludeAt > 0, "the prelude is loaded");
  assert.ok(scriptAt > preludeAt, "the real script is loaded after the hooks are installed");
  assert.match(source, /self\.__WASM_SENTRY__ = \{/, "the prelude is told which script it is fronting");
  // `importScripts` is synchronous, so a classic worker's script still runs
  // during the same task the page's constructor started -- nothing to buffer.
  assert.doesNotMatch(source, /addEventListener/);
});

test("a module shim buffers messages that arrive before the real script loads", () => {
  const source = buildShimSource({
    base: "https://app.test/worker.mjs",
    type: "module",
    preludeUrl: "blob:https://app.test/prelude",
    channel: WORKER_CHANNEL,
  });

  // A module worker cannot use importScripts, so its two loads are awaited --
  // and a message posted during that window would otherwise be dropped, because
  // the real script has not registered its handler yet.
  assert.doesNotMatch(source, /importScripts/);
  assert.match(source, /await import\("blob:https:\/\/app\.test\/prelude"\)/);
  assert.match(source, /await import\("https:\/\/app\.test\/worker\.mjs"\)/);
  assert.match(source, /self\.addEventListener\('message', __ws_buffer\)/);
  assert.match(source, /self\.removeEventListener\('message', __ws_buffer\)/);
  assert.match(source, /dispatchEvent\(new MessageEvent/);
});

/* ------------------------------------------------------------------ */
/* What we will and will not touch                                     */
/* ------------------------------------------------------------------ */

test("only specifiers we can reason about are instrumented", () => {
  assert.equal(isInstrumentable("worker.js", PAGE), true);
  assert.equal(isInstrumentable("/js/worker.js", PAGE), true);
  assert.equal(isInstrumentable(new URL("https://app.test/w.js"), PAGE), true);
  assert.equal(isInstrumentable("blob:https://app.test/abc", PAGE), true);
  assert.equal(isInstrumentable("data:text/javascript,void 0", PAGE), true);

  // The platform refuses a cross-origin worker script anyway; rewriting one
  // would mean the failure came from us rather than from the page's own bug.
  assert.equal(isInstrumentable("https://cdn.other.test/w.js", PAGE), false);
  assert.equal(isInstrumentable({ toString: () => "worker.js" }, PAGE), false);
  assert.equal(isInstrumentable(undefined, PAGE), false);
});

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

test("the worker starts from a shim that names the script the page asked for", () => {
  const h = harness();
  new h.Worker("./mine.js", { name: "pool-0" });

  assert.equal(h.constructed.length, 1);
  const { url, options } = h.constructed[0]!;
  assert.match(url, /^blob:/, "the platform gets the shim, not the original URL");
  assert.deepEqual(options, { name: "pool-0" }, "every other option is passed through untouched");

  const shim = h.blobs.get(url)!;
  assert.match(shim, /importScripts\("https:\/\/app\.test\/mine\.js"\)/);
});

test("a module worker keeps its type", () => {
  const h = harness();
  new h.Worker("mod.mjs", { type: "module" });

  const shim = h.blobs.get(h.constructed[0]!.url)!;
  assert.match(shim, /await import\("https:\/\/app\.test\/mod\.mjs"\)/);
  assert.deepEqual(h.constructed[0]!.options, { type: "module" });
});

test("a policy that forbids blob workers falls back to an untouched worker", () => {
  const h = harness({ failOnBlob: true });
  const worker = new h.Worker("mine.js") as unknown as { url: string };

  // The page's worker must still start. Losing the capture costs coverage;
  // losing the worker breaks the site.
  assert.equal(worker.url, "mine.js");
  assert.equal(h.revoked.length, 1, "the shim URL we could not use is released immediately");
});

test("a failure after the worker exists never starts a second one", () => {
  // Constructing a worker is not a pure act: it fetches and runs a script. An
  // over-broad catch around everything the trap does turned a failed listener
  // registration into two live workers running the page's code twice, which
  // this fixes and pins.
  const constructed: string[] = [];
  class HostileWorker {
    constructor(url: string) {
      constructed.push(url);
    }
    addEventListener(): never {
      throw new Error("listeners are not available here");
    }
  }

  const hook = installWorkerHook({
    workerCtor: HostileWorker as unknown as typeof Worker,
    prelude: { source: PRELUDE },
    pageUrl: PAGE,
    emit: () => {},
    createObjectURL: () => "blob:https://app.test/shim",
    revokeObjectURL: () => {},
    schedule: () => {},
  });

  assert.doesNotThrow(() => new hook.Worker("mine.js"));
  assert.deepEqual(constructed, ["blob:https://app.test/shim"], "exactly one worker was started");
});

test("a cross-origin script and a disabled hook both pass straight through", () => {
  const h = harness();
  new h.Worker("https://cdn.other.test/w.js");
  assert.equal(h.constructed[0]!.url, "https://cdn.other.test/w.js");

  h.disable();
  new h.Worker("mine.js");
  assert.equal(h.constructed[1]!.url, "mine.js");
});

test("every worker shares one prelude blob, and its own shim is released", () => {
  const h = harness();
  new h.Worker("a.js");
  new h.Worker("b.js");

  // One prelude plus one shim per worker: the prelude is the big one, and
  // publishing it once per worker would be a copy of the bundle each time.
  assert.equal(h.blobs.size, 3);

  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[0]!.ms, 10_000);
  h.timers.forEach((timer) => timer.task());
  assert.equal(h.revoked.length, 2);
  assert.equal(
    h.revoked.some((url) => h.blobs.get(url) === PRELUDE),
    false,
    "the shared prelude is not revoked out from under the next worker",
  );
});

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

const CAPTURE: HookCapture = {
  api: "compile",
  url: "https://app.test/m.wasm",
  size: 8,
  bytes: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
  fingerprint: "8:abc",
};

test("captures from inside a worker reach us and never reach the page", () => {
  const h = harness();
  const worker = new h.Worker("mine.js") as unknown as EventTarget;

  const pageSaw: unknown[] = [];
  worker.addEventListener("message", (event) => pageSaw.push((event as MessageEvent).data));
  (worker as unknown as { onmessage: (event: MessageEvent) => void }).onmessage = (event) =>
    pageSaw.push(event.data);

  worker.dispatchEvent(
    new MessageEvent("message", { data: { channel: WORKER_CHANNEL, capture: CAPTURE } }),
  );

  assert.deepEqual(h.emitted, [CAPTURE]);
  // The page never sent this message and must not observe it: our listener is
  // registered at construction, before the page can attach one, and stops the
  // event there.
  assert.deepEqual(pageSaw, []);
});

test("the worker's own messages are left completely alone", () => {
  const h = harness();
  const worker = new h.Worker("mine.js") as unknown as EventTarget;

  const pageSaw: unknown[] = [];
  worker.addEventListener("message", (event) => pageSaw.push((event as MessageEvent).data));
  worker.dispatchEvent(new MessageEvent("message", { data: { hello: "page" } }));

  assert.deepEqual(pageSaw, [{ hello: "page" }]);
  assert.deepEqual(h.emitted, []);
});

test("a message shaped like ours but malformed is not treated as a capture", () => {
  assert.equal(isWorkerCaptureMessage({ channel: WORKER_CHANNEL, capture: CAPTURE }), true);
  assert.equal(isWorkerCaptureMessage({ channel: WORKER_CHANNEL }), false);
  assert.equal(isWorkerCaptureMessage({ channel: "other", capture: CAPTURE }), false);
  assert.equal(isWorkerCaptureMessage(null), false);
});

test("a throwing sink does not surface as a page-visible error", () => {
  const worker = installWorkerHook({
    workerCtor: class extends EventTarget {} as unknown as typeof Worker,
    prelude: { source: PRELUDE },
    pageUrl: PAGE,
    emit: () => {
      throw new Error("transport is gone");
    },
    createObjectURL: () => "blob:https://app.test/x",
    revokeObjectURL: () => {},
    schedule: () => {},
  });

  const instance = new worker.Worker("mine.js") as unknown as EventTarget;
  assert.doesNotThrow(() =>
    instance.dispatchEvent(
      new MessageEvent("message", { data: { channel: WORKER_CHANNEL, capture: CAPTURE } }),
    ),
  );
});
