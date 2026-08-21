import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, shortHash } from "../src/hash.js";

test("sha256 matches the known digest of the empty input", async () => {
  assert.equal(
    await sha256(new Uint8Array(0)),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("sha256 matches the known digest of 'abc'", async () => {
  const bytes = new TextEncoder().encode("abc");
  assert.equal(
    await sha256(bytes),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256 hashes only the view, not the whole backing buffer", async () => {
  const backing = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
  const view = backing.subarray(1, 4); // "abc"
  assert.equal(
    await sha256(view),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("shortHash truncates for display", () => {
  assert.equal(shortHash("ba7816bf8f01cfea414140de5dae2223"), "ba7816bf8f01");
});
