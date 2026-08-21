import { test } from "node:test";
import assert from "node:assert/strict";
import { isTabReport, loadReport } from "../src/popup/load-report";

const REPORT = {
  tabId: 1,
  pageUrl: "https://x.test/",
  scorecard: { pageUrl: "https://x.test/", level: "benign", score: 0, moduleCount: 0, unanalysedCount: 0, headline: "" },
  artifacts: [],
  notes: [],
};

const activeTab = async () => ({ id: 1 });

test("returns the report when the worker answers properly", async () => {
  const outcome = await loadReport({ queryActiveTab: activeTab, sendMessage: async () => REPORT });
  assert.equal(outcome.status, "ok");
});

test("an empty reply is an error, not an endless loading state", async () => {
  // This is the bug this module exists to prevent: the popup previously treated
  // `undefined` as "still loading" and sat on it forever with nothing to act on.
  const outcome = await loadReport({
    queryActiveTab: activeTab,
    sendMessage: async () => undefined,
  });
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.match(outcome.message, /replied with nothing/);
  assert.match(outcome.hint ?? "", /service worker/);
});

test("a worker that never answers times out with a diagnosis", async () => {
  const outcome = await loadReport({
    queryActiveTab: activeTab,
    sendMessage: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.match(outcome.message, /did not respond/);
  assert.match(outcome.hint ?? "", /chrome:\/\/extensions/);
});

test("a rejected send names the likely cause", async () => {
  const outcome = await loadReport({
    queryActiveTab: activeTab,
    sendMessage: async () => {
      throw new Error("Could not establish connection");
    },
  });
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.match(outcome.message, /Could not reach the service worker/);
  assert.match(outcome.hint ?? "", /Reload the extension/);
});

test("a failure reply from the worker is surfaced with its reason", async () => {
  const outcome = await loadReport({
    queryActiveTab: activeTab,
    sendMessage: async () => ({ ok: false, reason: "IndexedDB upgrade blocked" }),
  });
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.match(outcome.message, /IndexedDB upgrade blocked/);
});

test("no usable tab is explained rather than thrown", async () => {
  const outcome = await loadReport({
    queryActiveTab: async () => undefined,
    sendMessage: async () => REPORT,
  });
  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") return;
  assert.match(outcome.message, /No active tab/);
});

test("shape validation rejects partial replies", () => {
  assert.equal(isTabReport(REPORT), true);
  assert.equal(isTabReport({ artifacts: [], notes: [] }), false, "missing scorecard");
  assert.equal(isTabReport(null), false);
  assert.equal(isTabReport("ok"), false);
});
