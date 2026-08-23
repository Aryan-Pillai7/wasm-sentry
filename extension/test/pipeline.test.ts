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
