import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitor } from "../src/content/runtime-monitor";
import type { RuntimeMonitor } from "../src/content/runtime-monitor";
import { installSocketHooks } from "../src/content/socket-hooks";
import type { RuntimeReport } from "@wasm-sentry/core";

/**
 * The monitor is the only part of the extension that hands the page something
 * other than what the engine produced, and the only part that runs on every
 * call into every module. So the properties under test here are not really
 * "does it measure" -- they are "does the page still work" and "does measuring
 * stay cheap".
 */

interface Harness {
  monitor: RuntimeMonitor;
  reports: RuntimeReport[];
  /** Advance the fake clock. */
  advance: (ms: number) => void;
  /** Fire every timer registered at this interval, once. */
  tick: (ms: number) => void;
}

function harness(): Harness {
  let clock = 0;
  const reports: RuntimeReport[] = [];
  const timers: Array<{ task: () => void; ms: number }> = [];

  const monitor = createMonitor({
    context: "page",
    now: () => clock,
    hardwareConcurrency: 8,
    report: (report) => reports.push(report),
    every: (task, ms) => timers.push({ task, ms }),
  });

  return {
    monitor,
    reports,
    advance: (ms) => {
      clock += ms;
    },
    tick: (ms) => timers.filter((timer) => timer.ms === ms).forEach((timer) => timer.task()),
  };
}

/** A stand-in for an instance's exports: null prototype, frozen, as the real one is. */
function exportsOf(entries: Record<string, unknown>): Record<string, unknown> {
  const namespace = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(entries)) namespace[name] = value;
  return Object.freeze(namespace);
}

/* ------------------------------------------------------------------ */
/* What the page sees                                                  */
/* ------------------------------------------------------------------ */

test("an instrumented export returns exactly what the real one returned", () => {
  const h = harness();
  const exports = exportsOf({ add: (a: number, b: number) => a + b });
  const wrapped = h.monitor.instrument("fp", exports);

  assert.equal((wrapped["add"] as (a: number, b: number) => number)(2, 3), 5);
});

test("a throwing export still throws, and is still counted", () => {
  const h = harness();
  const wrapped = h.monitor.instrument(
    "fp",
    exportsOf({
      boom: () => {
        throw new Error("trap");
      },
    }),
  );

  assert.throws(() => (wrapped["boom"] as () => void)(), /trap/);
  assert.equal(h.monitor.snapshot().modules[0]!.callCount, 1, "a trap is still a call");
});

test("the namespace keeps its shape, its order and its non-function exports", () => {
  const h = harness();
  const memory = { buffer: new ArrayBuffer(8) };
  const exports = exportsOf({ memory, run: () => 1, table: [1, 2] });
  const wrapped = h.monitor.instrument("fp", exports);

  assert.deepEqual(Object.keys(wrapped), ["memory", "run", "table"]);
  // Memories, tables and globals carry no time. Wrapping them could only break
  // something, so they are passed through by identity.
  assert.equal(wrapped["memory"], memory);
  assert.equal(wrapped["table"], exports["table"]);
  assert.equal(Object.getPrototypeOf(wrapped), null, "the real namespace has a null prototype");
  assert.equal(Object.isFrozen(wrapped), true, "and is frozen");
});

test("a wrapper keeps the name and arity page code reads", () => {
  const h = harness();
  // The parameter is unused on purpose: what is under test is that the wrapper
  // reports the same arity, and arity is what the parameter list declares.
  const malloc1 = (size: number): number => size * 0;
  const wrapped = h.monitor.instrument("fp", exportsOf({ malloc: malloc1 }));
  const malloc = wrapped["malloc"] as (size: number) => number;

  // Emscripten inspects `length` when building its own call shims, and a
  // wrapper that reports the wrong arity is a wrapper that changed the page.
  assert.equal(malloc.name, "malloc");
  assert.equal(malloc.length, 1);
});

test("export identity is stable, so a page can cache what it looks up", () => {
  const h = harness();
  const wrapped = h.monitor.instrument("fp", exportsOf({ run: () => 1 }));
  assert.equal(wrapped["run"], wrapped["run"]);
});

test("two instances of one module do not share wrappers", () => {
  // Both instances report against the same fingerprint, because it is the same
  // module -- but each instance's exports are its own functions, and a wrapper
  // shared between them would call into the wrong instance.
  const h = harness();
  const first = h.monitor.instrument("fp", exportsOf({ run: () => "first" }));
  const second = h.monitor.instrument("fp", exportsOf({ run: () => "second" }));

  assert.equal((first["run"] as () => string)(), "first");
  assert.equal((second["run"] as () => string)(), "second");
  assert.equal(h.monitor.snapshot().modules.length, 1, "one module, two instances");
});

/* ------------------------------------------------------------------ */
/* Measurement                                                         */
/* ------------------------------------------------------------------ */

test("time inside an export is attributed to the module it came from", () => {
  const h = harness();
  const wrapped = h.monitor.instrument(
    "fp-miner",
    exportsOf({
      grind: () => {
        h.advance(4_000);
      },
    }),
  );

  (wrapped["grind"] as () => void)();
  h.advance(1_000);

  const [sample] = h.monitor.snapshot().modules;
  assert.equal(sample!.fingerprint, "fp-miner");
  assert.equal(sample!.wasmTimeMs, 4_000);
  assert.equal(sample!.longestCallMs, 4_000);
  assert.equal(sample!.callCount, 1);
});

test("timing stops when measuring it would cost more than the call", () => {
  const h = harness();
  // A library called in a hot loop: 20,000 calls that each take no measurable
  // time. Two clock reads per call would be a real tax on the page.
  const wrapped = h.monitor.instrument("fp", exportsOf({ tiny: () => 0 }));
  const tiny = wrapped["tiny"] as () => number;
  for (let i = 0; i < 20_000; i++) tiny();

  const stopped = h.monitor.snapshot().modules[0]!;
  assert.equal(stopped.timingStopped, true);
  assert.equal(stopped.callCount, 20_000);

  // Counting continues, and the accumulated time stops growing -- which is why
  // every finding built on it calls the number a floor.
  const before = stopped.wasmTimeMs;
  h.advance(5_000);
  tiny();
  const after = h.monitor.snapshot().modules[0]!;
  assert.equal(after.callCount, 20_001);
  assert.equal(after.wasmTimeMs, before);
});

test("a long-running kernel is never demoted to counting", () => {
  const h = harness();
  const wrapped = h.monitor.instrument(
    "fp",
    exportsOf({
      round: () => {
        h.advance(50);
      },
    }),
  );
  const round = wrapped["round"] as () => void;
  for (let i = 0; i < 20_100; i++) round();

  // The call limit is reached, but the mean is nowhere near the floor: this is
  // exactly the shape worth timing, and switching it off would blind the rule.
  assert.equal(h.monitor.snapshot().modules[0]!.timingStopped, false);
});

test("a starved event loop shows up as timer lateness", () => {
  const h = harness();

  for (let i = 0; i < 3; i++) {
    h.advance(1_000);
    h.tick(1_000);
  }
  assert.equal(h.monitor.snapshot().drift.lateMs, 0, "an idle context is on time");

  // A tick that should have run a second after the last one but arrives four
  // seconds late means something held the thread for three seconds.
  h.advance(4_000);
  h.tick(1_000);

  const drift = h.monitor.snapshot().drift;
  assert.equal(drift.lateMs, 3_000);
  assert.equal(drift.maxLateMs, 3_000);
  assert.equal(drift.samples, 4);
});

test("reports are sent on their own schedule and carry the whole picture", () => {
  const h = harness();
  h.monitor.instrument("fp", exportsOf({ run: () => 0 }));
  h.monitor.noteWorker();
  h.advance(10_000);
  h.tick(10_000);

  assert.equal(h.reports.length, 1);
  const report = h.reports[0]!;
  assert.equal(report.context, "page");
  assert.equal(report.observedMs, 10_000);
  assert.equal(report.workerCount, 1);
  assert.equal(report.hardwareConcurrency, 8);
  // A module that has been watched and stayed quiet is worth reporting: the
  // service worker needs to know it was watched at all.
  assert.equal(report.modules.length, 1);
  assert.equal(report.modules[0]!.callCount, 0);
});

test("a sink that throws does not escape into the page's timer", () => {
  let clock = 0;
  const timers: Array<{ task: () => void; ms: number }> = [];
  createMonitor({
    context: "page",
    now: () => clock,
    hardwareConcurrency: 4,
    report: () => {
      throw new Error("extension context invalidated");
    },
    every: (task, ms) => timers.push({ task, ms }),
  });

  clock += 10_000;
  for (const timer of timers) assert.doesNotThrow(() => timer.task());
});

test("switching monitoring off hands the page the engine's own exports back", () => {
  const h = harness();
  const exports = exportsOf({ run: () => 1 });

  h.monitor.disable();
  const after = h.monitor.instrument("fp", exports);

  // Not a copy, not a frozen lookalike: the same object the engine produced.
  assert.equal(after, exports);
  assert.equal(h.monitor.snapshot().modules.length, 0);

  // And nothing further is sent.
  h.advance(10_000);
  h.tick(10_000);
  assert.equal(h.reports.length, 0);
});

/* ------------------------------------------------------------------ */
/* Sockets                                                             */
/* ------------------------------------------------------------------ */

test("socket opens and traffic are counted in both directions", () => {
  const h = harness();
  const opened: string[] = [];
  const sent: unknown[] = [];

  class FakeSocket extends EventTarget {
    constructor(url: string) {
      super();
      opened.push(url);
    }
    send(data: unknown): void {
      sent.push(data);
    }
  }

  const scope: { WebSocket?: unknown } = { WebSocket: FakeSocket };
  installSocketHooks(scope, h.monitor);

  const Socket = scope.WebSocket as new (url: string) => EventTarget & { send: (d: unknown) => void };
  const socket = new Socket("wss://pool.test/stratum");

  const pageSaw: unknown[] = [];
  socket.addEventListener("message", (event) => pageSaw.push((event as MessageEvent).data));
  socket.dispatchEvent(new MessageEvent("message", { data: "job" }));
  socket.send("share");

  const report = h.monitor.snapshot();
  assert.equal(report.socketCount, 1);
  assert.equal(report.socketMessages, 2, "one received, one sent");

  // Counting must be invisible: the page's own handler still runs, and its send
  // still reaches the socket.
  assert.deepEqual(pageSaw, ["job"]);
  assert.deepEqual(sent, ["share"]);
  assert.deepEqual(opened, ["wss://pool.test/stratum"]);
  assert.ok(socket instanceof FakeSocket, "instanceof still works for page code");
});

test("no WebSocket in the scope is not an error", () => {
  const h = harness();
  assert.doesNotThrow(() => installSocketHooks({}, h.monitor));
});
