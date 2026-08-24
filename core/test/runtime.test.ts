import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWasm } from "../src/analysis.js";
import { evaluateHeuristics, listRules } from "../src/heuristics.js";
import { summarise } from "../src/report.js";
import {
  accumulateRuntime,
  emptyRuntimeFeatures,
  foldRuntime,
  meanDrift,
} from "../src/runtime.js";
import type { ModuleSample, RuntimeFeatures, RuntimeReport } from "../src/runtime.js";
import { benignModule, syntheticMinerModule } from "./fixtures.js";

/* ------------------------------------------------------------------ */
/* Accumulation                                                        */
/* ------------------------------------------------------------------ */

function sample(overrides: Partial<ModuleSample> = {}): ModuleSample {
  return {
    fingerprint: "fp-1",
    wasmTimeMs: 0,
    callCount: 0,
    longestCallMs: 0,
    timingStopped: false,
    ...overrides,
  };
}

function report(overrides: Partial<RuntimeReport> = {}): RuntimeReport {
  return {
    context: "page",
    observedMs: 30_000,
    drift: { samples: 30, lateMs: 60, maxLateMs: 8 },
    workerCount: 0,
    socketCount: 0,
    socketMessages: 0,
    hardwareConcurrency: 8,
    modules: [],
    ...overrides,
  };
}

test("a module saturating four workers reports four core-equivalents", () => {
  // Summing capped shares rather than averaging them is the whole point: fan-out
  // across cores is the shape being looked for, and a mean would hide it behind
  // the idle main thread.
  const reports = Array.from({ length: 4 }, () =>
    report({
      context: "worker",
      modules: [sample({ wasmTimeMs: 29_000, callCount: 1, longestCallMs: 29_000 })],
    }),
  );

  const features = accumulateRuntime(reports).get("fp-1")!;
  assert.equal(features.contextCount, 4);
  assert.ok(features.cpuShare > 3.8 && features.cpuShare <= 4, `got ${features.cpuShare}`);
  assert.deepEqual(features.contexts, ["worker"], "contexts are deduplicated, counts are not");
  assert.equal(features.wasmTimeMs, 116_000);
});

test("a context cannot spend more time running than it has existed for", () => {
  // A clock that says otherwise is a broken clock, not four cores.
  const features = accumulateRuntime([
    report({ observedMs: 10_000, modules: [sample({ wasmTimeMs: 90_000 })] }),
  ]).get("fp-1")!;
  assert.equal(features.cpuShare, 1);
});

test("observed time is the longest window, not the sum", () => {
  // Contexts run concurrently. Adding their windows together would claim the
  // page had been watched for minutes after twenty seconds.
  const features = accumulateRuntime([
    report({ observedMs: 30_000, modules: [sample()] }),
    report({ context: "worker", observedMs: 25_000, modules: [sample()] }),
  ]).get("fp-1")!;
  assert.equal(features.observedMs, 30_000);
});

test("an idle context does not erase the starvation a busy one recorded", () => {
  const busy = report({
    context: "worker",
    drift: { samples: 30, lateMs: 30_000, maxLateMs: 2_000 },
    modules: [sample({ wasmTimeMs: 29_000 })],
  });
  const idle = report({ drift: { samples: 30, lateMs: 30, maxLateMs: 3 }, modules: [sample()] });

  const features = accumulateRuntime([busy, idle]).get("fp-1")!;
  assert.ok(features.meanDriftMs > 400, `mean drift collapsed to ${features.meanDriftMs}`);
});

test("folding is additive over reports and keeps the worst call", () => {
  let features = emptyRuntimeFeatures();
  features = foldRuntime(features, report(), sample({ wasmTimeMs: 5_000, longestCallMs: 900 }));
  features = foldRuntime(features, report(), sample({ wasmTimeMs: 7_000, longestCallMs: 120 }));

  assert.equal(features.wasmTimeMs, 12_000);
  assert.equal(features.longestCallMs, 900);
  assert.equal(features.reportCount, 2);
});

test("drift with no samples is zero rather than a division by zero", () => {
  assert.equal(meanDrift({ samples: 0, lateMs: 0, maxLateMs: 0 }), 0);
});

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

function runtime(overrides: Partial<RuntimeFeatures> = {}): RuntimeFeatures {
  return { ...emptyRuntimeFeatures(), observedMs: 30_000, hardwareConcurrency: 8, ...overrides };
}

function findingsFor(bytes: Uint8Array, r?: RuntimeFeatures) {
  const result = analyzeWasm(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return evaluateHeuristics(result.features, r);
}

function riskFor(bytes: Uint8Array, r?: RuntimeFeatures) {
  const result = analyzeWasm(bytes);
  assert.equal(result.ok, true);
  return summarise("test", result, r)!.risk!;
}

test("a short observation says so instead of clearing the module", () => {
  const findings = findingsFor(syntheticMinerModule(), runtime({ observedMs: 4_000 }));
  const notYet = findings.find((finding) => finding.id === "runtime-not-yet-observed");
  assert.ok(notYet, "a page watched for four seconds has not been watched");
  assert.equal(notYet.weight, 0, "it qualifies the other findings rather than scoring");
  assert.match(notYet.evidence, /4\.0s/);
  assert.equal(
    findings.some((finding) => finding.id === "sustained-execution"),
    false,
  );
});

test("a busy few seconds is not sustained execution", () => {
  // Starting a game, decoding an image, recalculating a sheet. The threshold
  // exists so that ordinary work does not read as mining.
  const findings = findingsFor(
    syntheticMinerModule(),
    runtime({ observedMs: 8_000, wasmTimeMs: 7_500, cpuShare: 0.94, contextCount: 1 }),
  );
  assert.equal(
    findings.some((finding) => finding.id.startsWith("sustained") || finding.id.includes("runtime-corroborated")),
    false,
  );
});

test("sustained execution alone cannot reach the high band", () => {
  // A video codec saturates a core honestly. Static shape is what turns this
  // into an accusation, and a module with no kernel has none.
  const risk = riskFor(
    benignModule(),
    runtime({ wasmTimeMs: 28_000, cpuShare: 0.93, contextCount: 1, callCount: 4 }),
  );
  assert.ok(risk.score < 50, `expected below the high band, got ${risk.score}`);
  assert.equal(
    risk.findings.some((finding) => finding.id === "mining-runtime-corroborated"),
    false,
    "no kernel, no corroboration",
  );
});

test("a kernel that then runs flat out is the finding this phase exists for", () => {
  const idle = riskFor(syntheticMinerModule());
  const running = riskFor(
    syntheticMinerModule(),
    runtime({
      wasmTimeMs: 115_000,
      cpuShare: 3.9,
      contextCount: 4,
      contexts: ["worker"],
      callCount: 4,
      longestCallMs: 29_000,
      meanDriftMs: 900,
      workerCount: 4,
    }),
  );

  const corroborated = running.findings.find(
    (finding) => finding.id === "mining-runtime-corroborated",
  );
  assert.ok(corroborated, "kernel plus sustained execution must corroborate");
  assert.match(corroborated.evidence, /115\.0s/);
  assert.match(corroborated.evidence, /4 contexts at once/);
  assert.equal(running.level, "critical");
  assert.ok(
    running.score > idle.score,
    `runtime evidence must move the verdict: ${idle.score} -> ${running.score}`,
  );
});

test("fan-out is judged against the machine, not a fixed number", () => {
  const kernel = syntheticMinerModule();
  const base = { wasmTimeMs: 60_000, cpuShare: 2, contexts: ["worker" as const] };

  // Two workers on an eight-core machine is a thread pool.
  const pool = findingsFor(kernel, runtime({ ...base, contextCount: 2, hardwareConcurrency: 16 }));
  assert.equal(
    pool.some((finding) => finding.id === "worker-fan-out"),
    false,
  );

  // Two workers on a two-core machine is the whole machine.
  const total = findingsFor(kernel, runtime({ ...base, contextCount: 2, hardwareConcurrency: 2 }));
  const finding = total.find((f) => f.id === "worker-fan-out");
  assert.ok(finding);
  assert.match(finding.evidence, /2-core machine/);
});

test("a module sitting exactly on the fan-out threshold still reports", () => {
  // Four contexts on eight cores is the boundary the rule admits. A confidence
  // ramp starting at that same point returns zero there, which silently drops
  // the finding the gate just let through -- the finding is reported with the
  // low confidence it deserves instead.
  const findings = findingsFor(
    syntheticMinerModule(),
    runtime({
      wasmTimeMs: 60_000,
      cpuShare: 2,
      contexts: ["worker"],
      contextCount: 4,
      hardwareConcurrency: 8,
    }),
  );
  const finding = findings.find((f) => f.id === "worker-fan-out");
  assert.ok(finding, "the boundary case must not vanish");
  assert.ok(finding.confidence > 0 && finding.confidence < 0.5, `got ${finding.confidence}`);
});

test("socket traffic only counts alongside real execution", () => {
  const chatty = runtime({ socketCount: 1, socketMessages: 400, wasmTimeMs: 200 });
  assert.equal(
    findingsFor(benignModule(), chatty).some((f) => f.id === "persistent-socket-traffic"),
    false,
    "a chatty page that computes nothing is a chatty page",
  );

  const working = runtime({ socketCount: 1, socketMessages: 400, wasmTimeMs: 20_000 });
  assert.ok(
    findingsFor(benignModule(), working).some((f) => f.id === "persistent-socket-traffic"),
  );
});

test("every runtime finding states the numbers that produced it", () => {
  const findings = findingsFor(
    syntheticMinerModule(),
    runtime({
      wasmTimeMs: 115_000,
      cpuShare: 3.9,
      contextCount: 4,
      contexts: ["worker"],
      meanDriftMs: 900,
      socketCount: 1,
      socketMessages: 50,
      workerCount: 4,
    }),
  );

  // The same bar every static rule is held to: a finding nobody can check is a
  // finding nobody can act on.
  for (const finding of findings) {
    assert.ok(finding.evidence.length > 20, `${finding.id} has no evidence`);
    assert.match(finding.evidence, /\d|"/, `${finding.id} cites nothing checkable`);
  }
});

test("stopped timing is reported as a floor, not as a measurement", () => {
  const findings = findingsFor(
    syntheticMinerModule(),
    runtime({ wasmTimeMs: 25_000, cpuShare: 0.9, contextCount: 1, timingStopped: true }),
  );
  const sustained = findings.find((finding) => finding.id === "sustained-execution");
  assert.ok(sustained);
  assert.match(sustained.evidence, /floor/);
});

test("a module with no runtime evidence is scored exactly as before", () => {
  const withoutRuntime = riskFor(syntheticMinerModule());
  assert.equal(
    withoutRuntime.findings.some((finding) => finding.id.startsWith("runtime-")),
    false,
    "absent evidence must not become a finding of its own",
  );
  assert.equal(withoutRuntime.level, "high");
});

test("the rule listing distinguishes what needs the module to have run", () => {
  const rules = listRules();
  const runtimeRules = rules.filter((rule) => rule.kind === "runtime");
  assert.equal(runtimeRules.length, 5);
  assert.ok(rules.filter((rule) => rule.kind === "static").length >= 12);
  assert.ok(runtimeRules.every((rule) => rule.title.length > 0));
});
