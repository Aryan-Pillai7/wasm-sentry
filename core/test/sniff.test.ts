import { test } from "node:test";
import assert from "node:assert/strict";
import { isWasm, isSupportedWasmVersion, sniff, WASM_MAGIC } from "../src/sniff.js";

/** Smallest legal Wasm module: magic + version, no sections. */
const EMPTY_MODULE = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test("recognises the Wasm magic number", () => {
  assert.equal(isWasm(EMPTY_MODULE), true);
  assert.equal(isWasm(WASM_MAGIC), true);
  assert.equal(isWasm(ascii("not wasm at all")), false);
  assert.equal(isWasm(Uint8Array.of(0x00, 0x61)), false, "must not read past the end");
});

test("checks the binary format version", () => {
  assert.equal(isSupportedWasmVersion(EMPTY_MODULE), true);
  const v2 = Uint8Array.from(EMPTY_MODULE);
  v2[4] = 0x02;
  assert.equal(isSupportedWasmVersion(v2), false);
});

test("sniffs Wasm regardless of what the URL or MIME type claims", () => {
  assert.equal(sniff(EMPTY_MODULE, { url: "https://x.test/a8f3.dat" }), "wasm");
  assert.equal(
    sniff(EMPTY_MODULE, { contentType: "application/octet-stream" }),
    "wasm",
    "a mislabelled miner is still a miner",
  );
});

test("sniffs minified JavaScript as js", () => {
  const bundle = ascii("!function(e,t){\"use strict\";var n=e.length;for(;n--;)t(e[n])}(a,b);");
  assert.equal(sniff(bundle, { contentType: "application/javascript" }), "js");
  assert.equal(sniff(bundle), "js", "no content type still works on text density");
});

test("refuses bytes that are neither", () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01);
  assert.equal(sniff(png, { contentType: "image/png" }), null);
  assert.equal(
    sniff(ascii("<!doctype html>"), { contentType: "application/wasm" }),
    null,
    "claims to be wasm but has no magic number",
  );
});
