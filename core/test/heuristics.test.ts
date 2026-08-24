import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWasm } from "../src/analysis.js";
import { evaluateHeuristics } from "../src/heuristics.js";
import type { Finding } from "../src/heuristics.js";
import { listRules } from "../src/heuristics.js";
import { evaluateJsHeuristics, evaluateScriptInventory } from "../src/js/heuristics.js";
import { extractJsFeatures } from "../src/js/features.js";
import { assessRisk, buildScorecard, coverageOf, worstLevel } from "../src/scoring.js";
import { summarise } from "../src/report.js";
import { benignModule, minerLikeModule, syntheticMinerModule } from "./fixtures.js";

function findingsFor(bytes: Uint8Array): Finding[] {
  const result = analyzeWasm(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return evaluateHeuristics(result.features);
}

function riskFor(bytes: Uint8Array) {
  const result = analyzeWasm(bytes);
  assert.equal(result.ok, true);
  return summarise("test", result).risk!;
}

test("the synthetic miner fixture is a module the engine accepts", () => {
  assert.equal(WebAssembly.validate(syntheticMinerModule()), true);
  assert.equal(WebAssembly.validate(syntheticMinerModule({ shared: false })), true);
});

test("ordinary compiled code raises nothing actionable", () => {
  const risk = riskFor(benignModule());
  assert.equal(risk.level, "benign");
  assert.equal(risk.score < 10, true);
  assert.equal(
    risk.findings.every((finding) => finding.severity === "info"),
    true,
  );
});

test("the full mining shape reaches the high band with corroboration", () => {
  const risk = riskFor(syntheticMinerModule());

  assert.equal(risk.level, "high");
  const ids = risk.findings.map((finding) => finding.id);
  assert.ok(ids.includes("mining-corroborated"));
  assert.ok(ids.includes("hash-loop-density"));
  assert.ok(ids.includes("shared-memory-parallelism"));
});

test("removing the kernel drops the verdict out of the high band", () => {
  // Same imports and shared memory, but only a three-round loop: the
  // infrastructure alone must not be enough to accuse a module.
  const risk = riskFor(syntheticMinerModule({ rounds: 3 }));

  assert.notEqual(risk.level, "high");
  assert.notEqual(risk.level, "critical");
  assert.equal(
    risk.findings.some((finding) => finding.id === "mining-corroborated"),
    false,
  );
});

test("a kernel with no supporting evidence stays a question, not a verdict", () => {
  // The small hand-written fixture is a bare loop with no imports, no shared
  // memory and no oversized memory request.
  const risk = riskFor(minerLikeModule());
  assert.equal(
    risk.findings.some((finding) => finding.id === "mining-corroborated"),
    false,
    "nothing corroborates a bare loop",
  );
  assert.ok(risk.score < 50, `expected below the high band, got ${risk.score}`);
});

test("every finding carries the numbers that produced it", () => {
  for (const finding of findingsFor(syntheticMinerModule())) {
    assert.ok(finding.evidence.length > 20, `${finding.id} has no evidence`);
    // Every finding cites either a measurement or the symbol it matched --
    // never a bare assertion the reader has to take on trust.
    assert.match(finding.evidence, /\d|"/, `${finding.id} cites nothing checkable`);
    assert.ok(finding.confidence > 0 && finding.confidence <= 1);
  }
});

test("many weak findings cannot add up to an accusation", () => {
  const weak: Finding[] = Array.from({ length: 12 }, (_, index) => ({
    id: `weak-${index}`,
    title: "weak signal",
    severity: "low",
    confidence: 0.3,
    weight: 10,
    evidence: "something mildly unusual",
  }));

  const risk = assessRisk(weak, 1);
  assert.equal(risk.level !== "critical", true, `12 weak hints reached ${risk.level}`);
  assert.ok(risk.score < 75);
});

test("one strong corroborated finding outweighs a pile of weak ones", () => {
  const strong = assessRisk(
    [
      { id: "a", title: "a", severity: "high", confidence: 0.9, weight: 40, evidence: "x" },
      { id: "b", title: "b", severity: "high", confidence: 0.9, weight: 45, evidence: "y" },
    ],
    1,
  );
  assert.equal(strong.level, "critical");
});

test("coverage reflects what the analysis actually saw", () => {
  assert.equal(coverageOf({ functionCount: 100, truncatedFunctions: 0, skippedFunctions: 0 }), 1);
  assert.equal(coverageOf({ functionCount: 100, truncatedFunctions: 10, skippedFunctions: 15 }), 0.75);
  assert.equal(coverageOf({ functionCount: 0, truncatedFunctions: 0, skippedFunctions: 0 }), 1);
});

test("a partly analysed module says so instead of implying a clean result", () => {
  const result = analyzeWasm(syntheticMinerModule(), { instructionBudget: 0 });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const findings = evaluateHeuristics(result.features);
  assert.ok(findings.some((finding) => finding.id === "incomplete-coverage"));
  assert.equal(assessRisk(findings, coverageOf(result.features)).coverage, 0);
});

test("a page rolls up to its worst module", () => {
  assert.equal(worstLevel(["benign", "medium", "low"]), "medium");
  assert.equal(worstLevel([]), "benign");

  const card = buildScorecard(
    "https://example.test/",
    [assessRisk([], 1), riskFor(syntheticMinerModule())],
    2,
  );
  assert.equal(card.level, "high");
  assert.equal(card.moduleCount, 2);
  assert.equal(card.unanalysedCount, 2);
  assert.match(card.headline, /mining/i);
});

test("an empty page says nothing was found rather than nothing was checked", () => {
  assert.match(buildScorecard("https://x.test/", [], 0).headline, /No WebAssembly/);
  assert.match(buildScorecard("https://x.test/", [], 3).headline, /not analysed/);
});

test("the rule counts the documentation claims are the rule counts that exist", () => {
  // `design-decisions.md` states these in its summary, and a summary nobody can
  // check is a summary that goes stale. It already had: it said twelve rules
  // long after there were twenty-five.
  const rules = listRules();
  const byKind = (kind: string): number => rules.filter((rule) => rule.kind === kind).length;

  assert.equal(byKind("static"), 12, "static rules");
  assert.equal(byKind("runtime"), 5, "runtime rules");
  assert.equal(byKind("model"), 1, "the classifier's opinion");

  // The JavaScript rules are a separate list, because they read a different
  // feature vector. Counted here so the documented total covers them.
  const everything =
    `var m=new CoinHive.Anonymous("k");eval(atob("${"QUJD".repeat(20)}"));` +
    `new WebSocket("wss://xmr-pool.test/stratum");new Worker("w.js");` +
    `navigator.hardwareConcurrency;WebAssembly.instantiate(b);` +
    `document.write("<script src=x>");` +
    // Literal backslash-x pairs, which is what an obfuscator emits. Written
    // this way because a real escape here would be the character it encodes.
    `${String.fromCharCode(92)}x68${String.fromCharCode(92)}x69`.repeat(200);
  const jsRuleIds = new Set(evaluateJsHeuristics(extractJsFeatures(everything)).map((f) => f.id));
  const supplyChainIds = evaluateScriptInventory([
    { url: "https://cdn.other.test/a.js", thirdParty: true, hasIntegrity: false, injected: false },
  ]).map((finding) => finding.id);
  for (const id of supplyChainIds) jsRuleIds.add(id);

  assert.equal(jsRuleIds.size, 7, `JavaScript rules: ${[...jsRuleIds].join(", ")}`);
  assert.equal(rules.length + jsRuleIds.size, 25, "the documented total");

  const cited =
    rules.filter((rule) => rule.reference !== undefined).length +
    evaluateJsHeuristics(extractJsFeatures(everything)).filter((f) => f.reference !== undefined)
      .length;
  assert.equal(cited, 12, "rules citing literature");
});
