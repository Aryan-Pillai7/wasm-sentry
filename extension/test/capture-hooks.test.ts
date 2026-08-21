import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asBytes,
  fingerprint,
  installHooks,
  type HookCapture,
  type HookSkip,
  type WasmNamespace,
} from "../src/content/capture-hooks";

/** Smallest legal module: magic + version, no sections. */
const MODULE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

interface Harness {
  wasm: WasmNamespace;
  emitted: Array<HookCapture | HookSkip>;
  calls: Array<{ api: string; args: unknown[] }>;
  advance: (ms: number) => void;
}

function harness(overrides: { maxBytes?: number; maxPerMinute?: number } = {}): Harness {
  const calls: Array<{ api: string; args: unknown[] }> = [];
  const emitted: Array<HookCapture | HookSkip> = [];
  let clock = 1_000_000;

  const record =
    (api: string) =>
    (...args: unknown[]) => {
      calls.push({ api, args });
      return Promise.resolve({ api, args });
    };

  class FakeModule {
    source: unknown;
    constructor(source: unknown) {
      this.source = source;
      calls.push({ api: "Module", args: [source] });
    }
  }

  const wasm = {
    instantiate: record("instantiate"),
    instantiateStreaming: record("instantiateStreaming"),
    compile: record("compile"),
    compileStreaming: record("compileStreaming"),
    Module: FakeModule,
  } as unknown as WasmNamespace;

  installHooks({
    wasm,
    emit: (message) => emitted.push(message),
    maxBytes: overrides.maxBytes ?? 16 * 1024 * 1024,
    maxPerMinute: overrides.maxPerMinute ?? 60,
    now: () => clock,
    // Run deferred work immediately so assertions do not need to await a tick.
    defer: (task) => task(),
  });

  return { wasm, emitted, calls, advance: (ms) => (clock += ms) };
}

function captures(harnessed: Harness): HookCapture[] {
  return harnessed.emitted.filter((m): m is HookCapture => "bytes" in m);
}

test("captures bytes handed to instantiate and still calls through", async () => {
  const h = harness();
  const imports = { env: {} };
  await h.wasm.instantiate(MODULE as unknown as BufferSource, imports);

  assert.equal(captures(h).length, 1);
  assert.deepEqual(captures(h)[0]!.bytes, MODULE);
  assert.equal(captures(h)[0]!.api, "instantiate");
  assert.deepEqual(h.calls, [{ api: "instantiate", args: [MODULE, imports] }]);
});

test("passes a compiled Module through without trying to capture it", async () => {
  const h = harness();
  const alreadyCompiled = { notABuffer: true };
  await h.wasm.instantiate(alreadyCompiled as unknown as WebAssembly.Module);

  assert.equal(captures(h).length, 0, "a Module argument carries no bytes");
  assert.equal(h.calls.length, 1);
});

test("reports identical bytes only once per frame", async () => {
  const h = harness();
  await h.wasm.compile(MODULE as unknown as BufferSource);
  await h.wasm.compile(Uint8Array.from(MODULE) as unknown as BufferSource);

  assert.equal(captures(h).length, 1, "same content, one report");
  assert.equal(h.calls.length, 2, "but the page still gets both compiles");
});

test("refuses artifacts over the size cap and says so", async () => {
  const h = harness({ maxBytes: 16 });
  const big = new Uint8Array(64);
  await h.wasm.compile(big as unknown as BufferSource);

  assert.equal(captures(h).length, 0);
  assert.deepEqual(h.emitted, [{ api: "compile", url: "inline:compile", size: 64, skipped: "too-large" }]);
  assert.equal(h.calls.length, 1, "the page is never blocked by our cap");
});

test("rate limits within a rolling minute and recovers after it", async () => {
  const h = harness({ maxPerMinute: 2 });
  for (let i = 0; i < 4; i++) {
    await h.wasm.compile(Uint8Array.of(i, 1, 2, 3) as unknown as BufferSource);
  }
  assert.equal(captures(h).length, 2);
  assert.equal(h.emitted.filter((m) => "skipped" in m && m.skipped === "rate-limited").length, 2);

  h.advance(61_000);
  await h.wasm.compile(Uint8Array.of(9, 9, 9, 9) as unknown as BufferSource);
  assert.equal(captures(h).length, 3, "a new window allows captures again");
});

test("clones a streaming response without consuming the engine's copy", async () => {
  const h = harness();
  const response = new Response(MODULE, { headers: { "content-type": "application/wasm" } });

  await h.wasm.instantiateStreaming(response, {});
  // Let the clone's arrayBuffer() promise settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(captures(h).length, 1);
  assert.deepEqual(captures(h)[0]!.bytes, MODULE);

  const forwarded = h.calls[0]!.args[0] as Response;
  assert.equal(forwarded.bodyUsed, false, "the engine's response must still be readable");
  assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), MODULE);
});

test("captures a Module constructed with new and preserves instanceof", () => {
  const h = harness();
  const ModuleCtor = h.wasm.Module;
  const instance = new ModuleCtor(MODULE as unknown as BufferSource);

  assert.equal(captures(h).length, 1);
  assert.equal(captures(h)[0]!.api, "Module");
  assert.ok(instance instanceof ModuleCtor, "the Proxy must keep instanceof working");
});

test("a failing transport never reaches the page", async () => {
  const calls: unknown[] = [];
  const wasm = {
    compile: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve("compiled");
    },
  } as unknown as WasmNamespace;

  installHooks({
    wasm,
    emit: () => {
      throw new Error("transport is down");
    },
    maxBytes: 1024,
    maxPerMinute: 10,
    defer: (task) => task(),
  });

  assert.equal(await wasm.compile(MODULE as unknown as BufferSource), "compiled");
  assert.equal(calls.length, 1);
});

test("asBytes respects the bounds of a view onto a larger buffer", () => {
  const backing = new Uint8Array([0xff, 0x00, 0x61, 0x73, 0x6d, 0xff]);
  const view = backing.subarray(1, 5);
  assert.deepEqual(asBytes(view), Uint8Array.of(0x00, 0x61, 0x73, 0x6d));
  assert.deepEqual(asBytes(backing.buffer), backing);
  assert.equal(asBytes({ length: 4 }), null);
});

test("fingerprint separates content and matches on identical content", () => {
  const a = new Uint8Array(9000).fill(1);
  const b = new Uint8Array(9000).fill(1);
  const c = new Uint8Array(9000).fill(1);
  c[8999] = 2; // differs only in the trailing window

  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
  assert.notEqual(fingerprint(a), fingerprint(new Uint8Array(9001).fill(1)));
});
