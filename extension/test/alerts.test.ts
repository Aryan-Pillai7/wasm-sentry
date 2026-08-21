import { test } from "node:test";
import assert from "node:assert/strict";
import { alertKey, decideAlert, originOf } from "../src/background/alerts";
import type { PageScorecard, RiskLevel } from "@wasm-sentry/core";

function card(level: RiskLevel, score: number): PageScorecard {
  return {
    pageUrl: "https://miner.test/play",
    level,
    score,
    moduleCount: 1,
    unanalysedCount: 0,
    headline: "Behaves like cryptomining code.",
  };
}

const BASE = {
  topHash: "abc123",
  topFinding: "Compute kernel combined with mining infrastructure",
  enabled: true,
  seen: new Set<string>(),
};

test("alerts on the high and critical bands", () => {
  for (const level of ["high", "critical"] as const) {
    const decision = decideAlert({ ...BASE, scorecard: card(level, 63) });
    assert.equal(decision.notify, true, level);
  }
});

test("stays quiet below the high band", () => {
  for (const level of ["benign", "low", "medium"] as const) {
    const decision = decideAlert({ ...BASE, scorecard: card(level, 30) });
    assert.equal(decision.notify, false, level);
  }
});

test("the message names the finding, not just the score", () => {
  const decision = decideAlert({ ...BASE, scorecard: card("high", 63) });
  assert.equal(decision.notify, true);
  if (!decision.notify) return;
  assert.match(decision.message, /Compute kernel/);
  assert.match(decision.message, /63\/100/);
  assert.equal(decision.contextMessage, "miner.test");
});

test("falls back to the headline when there is no named finding", () => {
  const decision = decideAlert({ ...BASE, topFinding: undefined, scorecard: card("high", 55) });
  assert.equal(decision.notify, true);
  if (!decision.notify) return;
  assert.match(decision.message, /cryptomining/);
});

test("does not alert twice for the same module on the same site", () => {
  const scorecard = card("high", 63);
  const first = decideAlert({ ...BASE, scorecard });
  assert.equal(first.notify, true);
  if (!first.notify) return;

  const second = decideAlert({ ...BASE, scorecard, seen: new Set([first.key]) });
  assert.equal(second.notify, false);
  if (second.notify) return;
  assert.match(second.reason, /already alerted/);
});

test("a different module on the same site does alert", () => {
  const scorecard = card("high", 63);
  const first = decideAlert({ ...BASE, scorecard });
  assert.equal(first.notify, true);
  if (!first.notify) return;

  const other = decideAlert({ ...BASE, scorecard, topHash: "def456", seen: new Set([first.key]) });
  assert.equal(other.notify, true, "a newly loaded bad module is news again");
});

test("escalation from high to critical alerts again", () => {
  const high = decideAlert({ ...BASE, scorecard: card("high", 60) });
  assert.equal(high.notify, true);
  if (!high.notify) return;
  const worse = decideAlert({ ...BASE, scorecard: card("critical", 80), seen: new Set([high.key]) });
  assert.equal(worse.notify, true);
});

test("respects the user turning alerts off", () => {
  const decision = decideAlert({ ...BASE, scorecard: card("critical", 90), enabled: false });
  assert.equal(decision.notify, false);
});

test("origin parsing survives unusual page URLs", () => {
  assert.equal(originOf("https://a.test:8443/x?y=1"), "a.test:8443");
  assert.equal(originOf(""), "unknown page");
  assert.equal(originOf("not a url"), "not a url");
});

test("alert keys separate site, band and module", () => {
  assert.notEqual(alertKey("a.test", "high", "x"), alertKey("b.test", "high", "x"));
  assert.notEqual(alertKey("a.test", "high", "x"), alertKey("a.test", "critical", "x"));
  assert.notEqual(alertKey("a.test", "high", "x"), alertKey("a.test", "high", "y"));
});
