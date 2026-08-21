import { test } from "node:test";
import assert from "node:assert/strict";
import { duration, formatBytes, hostOf, relativeTime, sourceLabel } from "../src/dashboard/format";

test("formats byte sizes across the ranges", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.00 MB");
});

test("relative time never reads as the future", () => {
  const now = 1_000_000;
  // Clock skew between the worker and the page must not produce "in 3s".
  assert.equal(relativeTime(now + 5000, now), "just now");
  assert.equal(relativeTime(now, now), "just now");
  assert.equal(relativeTime(now - 30_000, now), "30s ago");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
});

test("durations read naturally", () => {
  assert.equal(duration(4_000), "4s");
  assert.equal(duration(90_000), "1m 30s");
  assert.equal(duration(3_930_000), "1h 5m");
});

test("host extraction survives odd URLs", () => {
  assert.equal(hostOf("https://a.test:8443/x"), "a.test:8443");
  assert.equal(hostOf(""), "—");
  assert.equal(hostOf("not a url"), "not a url");
});

test("modules compiled from memory are labelled, not blank", () => {
  assert.equal(sourceLabel("inline:compile", "compile"), "compiled from memory (compile)");
  assert.equal(sourceLabel("https://x.test/m.wasm", "instantiateStreaming"), "https://x.test/m.wasm");
  assert.equal(sourceLabel(undefined, "compile"), "via compile");
  assert.equal(sourceLabel(undefined, undefined), "—");
});
