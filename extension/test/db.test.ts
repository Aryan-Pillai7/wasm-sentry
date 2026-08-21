import { test } from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import {
  addNote,
  addSighting,
  clearTab,
  getAnalyses,
  getArtifacts,
  getNotesByTab,
  getSightingsByTab,
  prune,
  saveAnalysis,
  upsertArtifact,
} from "../src/utils/db";

const BYTES = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

/**
 * Every one of these runs the real IndexedDB code path. The popup hangs rather
 * than errors when a storage helper never settles, so "does it resolve at all"
 * is the property under test as much as what it returns.
 */
test("stores an artifact and reports whether it was new", async () => {
  const first = await upsertArtifact(
    { hash: "aaa", kind: "wasm", size: BYTES.length, bytes: BYTES },
    1000,
  );
  assert.equal(first.isNew, true);
  assert.equal(first.row.seenCount, 1);

  const second = await upsertArtifact(
    { hash: "aaa", kind: "wasm", size: BYTES.length, bytes: BYTES },
    2000,
  );
  assert.equal(second.isNew, false);
  assert.equal(second.row.seenCount, 2);
  assert.equal(second.row.lastSeen, 2000);
});

test("records and reads back sightings for a tab", async () => {
  await addSighting({
    hash: "aaa", url: "inline:compile", pageUrl: "https://x.test/",
    tabId: 7, frameId: 0, source: "wasm-api", api: "compile", timestamp: 1000,
  });
  const rows = await getSightingsByTab(7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hash, "aaa");
});

test("getArtifacts resolves for an empty hash list", async () => {
  // The empty case is the one the popup hits on a page with no Wasm, which is
  // exactly when it appeared to hang.
  assert.deepEqual(await getArtifacts([]), []);
});

test("getAnalyses resolves for an empty hash list", async () => {
  assert.equal((await getAnalyses([])).size, 0);
});

test("stores and reads an analysis", async () => {
  await saveAnalysis({ hash: "aaa", analyzedAt: 1, elapsedMs: 2, ok: true });
  const found = await getAnalyses(["aaa", "missing"]);
  assert.equal(found.size, 1);
  assert.equal(found.get("aaa")?.ok, true);
});

test("notes round-trip", async () => {
  await addNote({
    url: "https://x.test/m.wasm", pageUrl: "https://x.test/", tabId: 7,
    size: 0, reason: "network-only", timestamp: 1000,
  });
  assert.equal((await getNotesByTab(7)).length, 1);
});

test("clearTab resolves when the tab has nothing stored", async () => {
  await clearTab(999);
  assert.deepEqual(await getSightingsByTab(999), []);
});

test("clearTab removes a tab's sightings and notes", async () => {
  await clearTab(7);
  assert.deepEqual(await getSightingsByTab(7), []);
  assert.deepEqual(await getNotesByTab(7), []);
});

test("prune resolves when nothing needs evicting", async () => {
  assert.equal(await prune(), 0);
});
