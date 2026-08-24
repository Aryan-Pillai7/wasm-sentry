import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "fake-indexeddb/auto";

/**
 * End-to-end test of the service worker, from a capture message to a verdict,
 * an activity feed entry and a notification.
 *
 * Every other test covers one unit. This one covers the seam between them,
 * which is where the failures the user actually sees have lived: a worker that
 * imports cleanly and a storage layer that works can still add up to a popup
 * that shows nothing.
 */

const notifications: Array<Record<string, unknown>> = [];
const listeners: Array<(m: unknown, s: unknown, r: (v: unknown) => void) => unknown> = [];
const session: Record<string, unknown> = {};
const badges: Array<{ text?: string; color?: string }> = [];
const noop = { addListener: () => {} };

Object.assign(globalThis, {
  chrome: {
    runtime: {
      onMessage: { addListener: (fn: never) => listeners.push(fn) },
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    webRequest: { onCompleted: { addListener: () => {} } },
    tabs: {
      onRemoved: noop,
      onUpdated: noop,
      get: async () => ({ windowId: 1 }),
      update: async () => {},
    },
    windows: { update: async () => {} },
    action: {
      setBadgeText: async (o: { text?: string }) => badges.push(o),
      setBadgeBackgroundColor: async (o: { color?: string }) => badges.push(o),
    },
    notifications: {
      onClicked: noop,
      clear: async () => {},
      create: async (_id: string, options: Record<string, unknown>) => {
        notifications.push(options);
      },
      getPermissionLevel: (cb: (level: string) => void) => cb("granted"),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (patch: Record<string, unknown>) => Object.assign(session, patch),
      },
    },
  },
});

await import("../src/background/service-worker");

function send(message: unknown, sender: unknown = {}): Promise<any> {
  return new Promise((resolve) => {
    listeners[0]!(message, sender, resolve);
    setTimeout(() => resolve("timed out"), 8000);
  });
}

const minerPath = fileURLToPath(new URL("../../testbed/miner.wasm", import.meta.url));

test("registers exactly one message listener", () => {
  assert.equal(listeners.length, 1);
});

test("answers a ping", async () => {
  const reply = await send({ type: "wasm-sentry:ping" });
  assert.equal(reply.ok, true);
});

test("a captured module is analysed, scored, fed and alerted", async (t) => {
  let bytes: Buffer;
  try {
    bytes = readFileSync(minerPath);
  } catch {
    t.skip("run `npm run fixtures` to generate testbed/miner.wasm");
    return;
  }

  const captured = await send(
    {
      type: "wasm-sentry:capture",
      api: "instantiateStreaming",
      url: "https://miner.test/kernel.wasm",
      pageUrl: "https://miner.test/play",
      size: bytes.length,
      bytesB64: bytes.toString("base64"),
    },
    { tab: { id: 42 }, frameId: 0 },
  );
  assert.equal(captured.ok, true);
  assert.match(captured.hash, /^[0-9a-f]{64}$/);

  const activity = await send({ type: "wasm-sentry:activity" });

  assert.equal(activity.status.artifactCount, 1);
  assert.equal(activity.status.notificationLevel, "granted");
  assert.notEqual(activity.status.lastCaptureAt, null);

  assert.equal(activity.modules.length, 1);
  assert.equal(activity.modules[0].analysis.risk.level, "high");

  const kinds = activity.events.map((event: { kind: string }) => event.kind);
  assert.deepEqual(kinds, ["alerted", "analysed", "captured"], "newest first");

  assert.equal(notifications.length, 1);
  assert.match(String(notifications[0]!["message"]), /Compute kernel/);
  assert.equal(notifications[0]!["contextMessage"], "miner.test");
});

test("the same module on the same page does not alert twice", async () => {
  const before = notifications.length;
  const bytes = readFileSync(minerPath);
  await send(
    {
      type: "wasm-sentry:capture",
      api: "compile",
      url: "inline:compile",
      pageUrl: "https://miner.test/play",
      size: bytes.length,
      bytesB64: bytes.toString("base64"),
    },
    { tab: { id: 42 }, frameId: 0 },
  );
  assert.equal(notifications.length, before, "a reload must stay quiet");
});

test("a module compiled inside a worker is reported as one", async () => {
  const bytes = readFileSync(minerPath);
  const report = await send(
    {
      type: "wasm-sentry:capture",
      api: "instantiateStreaming",
      url: "https://miner.test/pool.wasm",
      pageUrl: "https://miner.test/play",
      size: bytes.length,
      bytesB64: bytes.toString("base64"),
      context: "worker",
    },
    { tab: { id: 42 }, frameId: 0 },
  );
  assert.equal(report.ok, true);

  // Worker fan-out is how one page saturates every core, so "this came from a
  // worker" is the part of the report that says the old blind spot is closed
  // rather than merely quiet.
  const tab = await send({ type: "wasm-sentry:tab-report", tabId: 42 });
  const artifact = tab.artifacts.find((row: { hash: string }) => row.hash === report.hash);
  assert.equal(artifact.context, "worker");

  const activity = await send({ type: "wasm-sentry:activity" });
  assert.equal(activity.events[0].context, "worker");
});

/**
 * The whole point of Phase 4, exercised through the real service worker: a
 * module whose static shape is ambiguous is scored one way, and after it has
 * been watched running flat out it is scored another. Every hop is real -- the
 * fingerprint join, the fold across contexts, the re-parse from stored bytes.
 */
test("runtime evidence re-scores a module that was already analysed", async () => {
  const bytes = readFileSync(minerPath);
  const fingerprint = "341:runtime-test";

  const captured = await send(
    {
      type: "wasm-sentry:capture",
      api: "instantiate",
      url: "inline:instantiate",
      pageUrl: "https://runtime.test/app",
      size: bytes.length,
      bytesB64: bytes.toString("base64"),
      fingerprint,
    },
    { tab: { id: 77 }, frameId: 0 },
  );
  assert.equal(captured.ok, true);

  const before = await send({ type: "wasm-sentry:tab-report", tabId: 77 });
  const staticScore = before.artifacts[0].analysis.risk.score;
  assert.equal(
    before.artifacts[0].analysis.runtime,
    undefined,
    "nothing has been observed yet, and absence is not a finding",
  );

  // Four workers, each reporting the module running for almost the whole
  // window. Reported separately, because each context is its own report and
  // counting them is how fan-out is seen at all.
  const runtimeSample = {
    fingerprint,
    wasmTimeMs: 29_000,
    callCount: 1,
    longestCallMs: 29_000,
    timingStopped: false,
  };
  for (let i = 0; i < 4; i++) {
    const reply = await send(
      {
        type: "wasm-sentry:runtime",
        contextId: `worker:${i}`,
        pageUrl: "https://runtime.test/app",
        report: {
          context: "worker",
          observedMs: 30_000,
          drift: { samples: 30, lateMs: 27_000, maxLateMs: 2_000 },
          workerCount: 4,
          socketCount: 1,
          socketMessages: 42,
          hardwareConcurrency: 8,
          modules: [runtimeSample],
        },
      },
      { tab: { id: 77 }, frameId: 0 },
    );
    assert.equal(reply.ok, true);
  }

  const after = await send({ type: "wasm-sentry:tab-report", tabId: 77 });
  const analysis = after.artifacts[0].analysis;

  assert.ok(
    analysis.risk.score > staticScore,
    `runtime evidence must move the verdict: ${staticScore} -> ${analysis.risk.score}`,
  );
  assert.equal(analysis.risk.level, "critical");

  const ids = analysis.risk.findings.map((finding: { id: string }) => finding.id);
  assert.ok(ids.includes("mining-runtime-corroborated"), ids.join(","));
  assert.ok(ids.includes("worker-fan-out"));

  // Four contexts, folded rather than averaged: the measurement the rule reads
  // has to survive the trip through storage intact.
  assert.equal(analysis.runtime.contextCount, 4);
  assert.equal(analysis.runtime.wasmTimeMs, 116_000);
  assert.ok(analysis.runtime.cpuShare > 3.8);
});

test("a report about a module we never captured is dropped, not guessed at", async () => {
  const reply = await send(
    {
      type: "wasm-sentry:runtime",
      contextId: "worker:orphan",
      pageUrl: "https://runtime.test/app",
      report: {
        context: "worker",
        observedMs: 30_000,
        drift: { samples: 30, lateMs: 0, maxLateMs: 0 },
        workerCount: 0,
        socketCount: 0,
        socketMessages: 0,
        hardwareConcurrency: 8,
        modules: [
          {
            fingerprint: "never:seen",
            wasmTimeMs: 29_000,
            callCount: 1,
            longestCallMs: 29_000,
            timingStopped: false,
          },
        ],
      },
    },
    { tab: { id: 78 }, frameId: 0 },
  );

  // A measurement with nothing to attribute it to cannot become a finding about
  // anything, and inventing an artifact for it would be worse than losing it.
  assert.equal(reply.ok, true);
  assert.equal(reply.rescored, 0);
});

test("an inline script is analysed, and its source is not kept", async () => {
  const secret = "sk-live-do-not-store-this-anywhere";
  const source =
    `var token="${secret}";eval(atob("${"ZnVuY3Rpb24oKXt9".repeat(8)}"));` +
    `new WebSocket("wss://xmr-pool.test/stratum");`;

  const reply = await send(
    {
      type: "wasm-sentry:script",
      pageUrl: "https://scripts.test/app",
      inline: { origin: "inline", source },
    },
    { tab: { id: 91 }, frameId: 0 },
  );
  assert.equal(reply.ok, true);

  const report = await send({ type: "wasm-sentry:tab-report", tabId: 91 });
  assert.equal(report.scripts.length, 1);

  const analysed = report.scripts[0];
  assert.equal(analysed.origin, "inline");
  const ids = analysed.analysis.risk.findings.map((finding: { id: string }) => finding.id);
  assert.ok(ids.includes("js-decoded-code-execution"), ids.join(","));
  assert.ok(ids.includes("js-mining-pool-endpoint"), ids.join(","));

  // The measurement survives the trip; the source does not. A script on an
  // authenticated page can carry far more of somebody's private business than
  // a compiled module does, which is the whole reason this path is opt-in.
  assert.equal(
    JSON.stringify(report).includes(secret),
    false,
    "the script's source reached the stored report",
  );
});

test("external scripts contribute a supply-chain view and no contents", async () => {
  for (const external of [
    { url: "https://app.test/main.js", thirdParty: false, hasIntegrity: false, injected: false },
    { url: "https://ads.other.test/t.js", thirdParty: true, hasIntegrity: false, injected: true },
  ]) {
    await send(
      { type: "wasm-sentry:script", pageUrl: "https://scripts.test/app", external },
      { tab: { id: 92 }, frameId: 0 },
    );
  }

  const report = await send({ type: "wasm-sentry:tab-report", tabId: 92 });
  assert.ok(report.supplyChain);
  const finding = report.supplyChain.findings[0];
  assert.equal(finding.id, "js-third-party-unpinned");
  assert.match(finding.evidence, /ads\.other\.test/);
  // Most of the web loads unpinned third-party scripts. Worth surfacing, not
  // worth accusing anybody of.
  assert.ok(report.supplyChain.score < 10, `scored ${report.supplyChain.score}`);
});

test("the badge is coloured by the verdict, not just counted", () => {
  const colours = badges.filter((badge) => badge.color).map((badge) => badge.color);
  assert.ok(colours.includes("#d1242f"), `expected the high-risk red, saw ${colours.join(",")}`);
});

test("settings can be changed and state cleared from the dashboard", async () => {
  await send({ type: "wasm-sentry:update-settings", patch: { notifyOnHighRisk: false } });
  await send({ type: "wasm-sentry:clear-all" });

  const activity = await send({ type: "wasm-sentry:activity" });
  assert.equal(activity.modules.length, 0);
  assert.equal(activity.status.artifactCount, 0);
  assert.equal(activity.events.at(-1).kind, "cleared", "the wipe is itself logged");
});
