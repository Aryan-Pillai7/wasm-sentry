import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64, base64ToBytes } from "../src/base64.js";

test("matches Node's base64 encoder across every padding case", () => {
  for (let length = 0; length < 130; length++) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length) & 0xff;
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), `length ${length}`);
  }
});

test("round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array(1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test("decodes a Wasm header without loss", () => {
  const header = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
  assert.deepEqual(base64ToBytes(bytesToBase64(header)), header);
});

test("rejects malformed input", () => {
  assert.throws(() => base64ToBytes("abc$def"), /invalid base64/);
});
