import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WORKER_CHANNEL } from "../src/content/worker-hooks";

/**
 * Runs the real bundle, not the modules it is built from.
 *
 * Everything else about worker instrumentation is unit tested against injected
 * fakes, which proves the logic and proves nothing about the artifact. The
 * prelude is the one piece that never runs as an extension script: it is
 * bundled to a string, published as a `blob:` URL and evaluated inside a worker
 * we cannot reach. If that bundle is broken -- a bad target, a stray reference
 * to `window`, an import that did not get inlined -- every test above still
 * passes and no module in any worker is ever captured again.
 *
 * So this builds `worker-prelude.ts` exactly as the build script does, and
 * evaluates it in a sandbox shaped like a worker global scope.
 */

const entry = fileURLToPath(new URL("../src/content/worker-prelude.ts", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));

const bundled = await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome111",
  minify: true,
  write: false,
  logLevel: "silent",
});

const PRELUDE_SOURCE = bundled.outputFiles[0]!.text;
const BASE = "https://app.test/js/miner.js";

/** Smallest legal module: magic + version, no sections. */
const MODULE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

interface Posted {
  message: { channel?: string; capture?: { api: string; bytes?: Uint8Array; url: string } };
  transfer: unknown[];
}

interface Sandbox {
  posted: Posted[];
  imported: string[];
  scope: Record<string, unknown>;
}

/**
 * A worker global scope, close enough for the prelude to install into.
 *
 * The host realm's primordials are handed in deliberately: the prelude checks
 * `source instanceof ArrayBuffer`, and a fresh realm's `ArrayBuffer` is a
 * different function, so a sandbox with its own would make every capture fail
 * for a reason that does not exist in a browser.
 */
function sandbox(): Sandbox {
  const posted: Posted[] = [];
  const imported: string[] = [];
  const compiled: unknown[] = [];

  const scope: Record<string, unknown> = {
    __WASM_SENTRY__: {
      base: BASE,
      type: "classic",
      preludeUrl: "blob:https://app.test/prelude",
      channel: WORKER_CHANNEL,
    },
    postMessage: (message: Posted["message"], transfer: unknown[] = []) =>
      posted.push({ message, transfer }),
    importScripts: (...urls: string[]) => imported.push(...urls),
    location: { href: "blob:https://app.test/0000-1111" },
    WebAssembly: {
      compile: (source: unknown) => {
        compiled.push(source);
        return Promise.resolve({ fake: "module" });
      },
      instantiate: (source: unknown) => {
        compiled.push(source);
        return Promise.resolve({ fake: "instance" });
      },
      compileStreaming: () => Promise.resolve({ fake: "module" }),
      instantiateStreaming: () => Promise.resolve({ fake: "instance" }),
      Module: class {},
    },
    // Real workers are EventTargets, and the hook attaches its capture
    // listener to one the moment it is constructed.
    Worker: class extends EventTarget {
      url: string;
      constructor(url: string) {
        super();
        this.url = url;
      }
    },
    URL,
    Blob,
    EventTarget,
    // The runtime monitor reads the clock and asks for a timer every second.
    performance,
    setInterval: () => 0,
    clearInterval: () => {},
    navigator: { hardwareConcurrency: 8 },
    WebSocket: class extends EventTarget {
      send(): void {}
    },
    ArrayBuffer,
    Uint8Array,
    Promise,
    Proxy,
    Reflect,
    Response,
    Set,
    Math,
    Date,
    TextEncoder,
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };

  createContext(scope);
  return { posted, imported, scope };
}

test("the bundled prelude installs into a worker scope without throwing", () => {
  const box = sandbox();
  assert.doesNotThrow(() => runInContext(PRELUDE_SOURCE, box.scope));
  assert.notEqual(
    box.scope["WebAssembly"],
    undefined,
    "the namespace is patched in place, not replaced",
  );
});

test("a module compiled inside the worker is posted out on our own channel", async () => {
  const box = sandbox();
  runInContext(PRELUDE_SOURCE, box.scope);

  const wasm = box.scope["WebAssembly"] as { compile: (bytes: Uint8Array) => Promise<unknown> };
  const result = await wasm.compile(MODULE);

  // The page's own call must come back exactly as it would have.
  assert.deepEqual(result, { fake: "module" });

  assert.equal(box.posted.length, 1);
  const { message, transfer } = box.posted[0]!;
  assert.equal(message.channel, WORKER_CHANNEL);
  assert.equal(message.capture?.api, "compile");
  assert.deepEqual(message.capture?.bytes, MODULE);
  // Transferred rather than cloned: the hook already copied the buffer for us,
  // so cloning it across would copy the same module a second time.
  assert.equal(transfer.length, 1);
});

test("the worker's base URL is put back where the page expects it", () => {
  const box = sandbox();
  runInContext(PRELUDE_SOURCE, box.scope);

  const location = box.scope["location"] as { href: string };
  assert.equal(location.href, BASE, "not the blob the worker actually started from");

  (box.scope["importScripts"] as (url: string) => void)("./helper.js");
  assert.deepEqual(box.imported, ["https://app.test/js/helper.js"]);
});

test("a nested worker is instrumented from the prelude the document already published", () => {
  const box = sandbox();
  runInContext(PRELUDE_SOURCE, box.scope);

  const shims = new Map<string, string>();
  // Node's Blob will not give its contents up synchronously, and the shim
  // source is the thing worth reading.
  box.scope["Blob"] = class RecordingBlob {
    text: string;
    constructor(parts: string[]) {
      this.text = parts.join("");
    }
  };
  // A subclass rather than a bare object: the hook resolves the specifier with
  // `new URL(...)` before it ever reaches `createObjectURL`, so a stand-in that
  // is not constructible sends it down the fallback path instead.
  class FakeURL extends URL {
    static override createObjectURL(blob: unknown): string {
      const url = `blob:https://app.test/child-${shims.size}`;
      shims.set(url, (blob as { text: string }).text);
      return url;
    }
    static override revokeObjectURL(): void {}
  }
  box.scope["URL"] = FakeURL;

  const NestedWorker = box.scope["Worker"] as new (url: string) => { url: string };
  const child = new NestedWorker("./child.js");

  assert.match(child.url, /^blob:/, "the child starts from a shim, not from its own URL");
  const shim = shims.get(child.url)!;
  assert.match(shim, /importScripts\("https:\/\/app\.test\/js\/child\.js"\)/);
  // The document's prelude blob is reused rather than a second copy of this
  // bundle being published from inside every worker that spawns one.
  assert.match(shim, /importScripts\("blob:https:\/\/app\.test\/prelude"\)/);
  assert.equal(shims.size, 1, "only the child's own shim was created");
});

test("a scope with no bootstrap config is left completely alone", () => {
  const box = sandbox();
  delete box.scope["__WASM_SENTRY__"];
  const before = box.scope["WebAssembly"];

  runInContext(PRELUDE_SOURCE, box.scope);

  // The prelude only ever runs inside a worker we started. Evaluated anywhere
  // else -- a page that found the blob URL, say -- it must do nothing at all.
  assert.equal(box.scope["WebAssembly"], before);
  assert.equal(box.posted.length, 0);
  assert.equal((box.scope["location"] as { href: string }).href, "blob:https://app.test/0000-1111");
});

test("the prelude does not reach for anything a worker does not have", () => {
  // A single reference to `window` or `document` would throw at install time
  // and take the worker's own script down with it. The sandbox above would
  // catch that, but only for the paths it exercises.
  assert.doesNotMatch(PRELUDE_SOURCE, /\bwindow\./);
  assert.doesNotMatch(PRELUDE_SOURCE, /\bdocument\./);
});
