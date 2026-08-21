import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModule, importedFunctionCount } from "../src/wasm/module.js";
import { WasmParseError } from "../src/wasm/reader.js";
import { benignModule, minerLikeModule } from "./fixtures.js";

test("fixtures are modules the engine itself accepts", () => {
  assert.equal(WebAssembly.validate(minerLikeModule()), true);
  assert.equal(WebAssembly.validate(benignModule()), true);
});

test("reads the declared surface of a module", () => {
  const module = parseModule(minerLikeModule());

  assert.equal(module.version, 1);
  assert.equal(module.types.length, 1);
  assert.deepEqual(module.types[0], { params: ["i32"], results: ["i32"] });
  assert.deepEqual(module.memories, [{ min: 1, shared: false }]);
  assert.deepEqual(module.exports, [{ name: "hash", kind: "func", index: 0 }]);
  assert.equal(module.code.length, 1);
  assert.deepEqual(module.warnings, []);
});

test("reads imports and separates them from defined functions", () => {
  const module = parseModule(benignModule());

  assert.deepEqual(module.imports, [
    { module: "env", name: "log", kind: "func", typeIndex: 0 },
  ]);
  assert.equal(importedFunctionCount(module), 1);
  assert.equal(module.code.length, 1, "one body, and it is not the import");
});

test("rejects bytes that are not a module", () => {
  assert.throws(() => parseModule(new TextEncoder().encode("<!doctype html>")), WasmParseError);
});

test("a truncated section costs that section, not the module", () => {
  const bytes = minerLikeModule();
  // Overstate the type section's length so it runs past the end of the module.
  const typeSectionLengthOffset = 9;
  const damaged = Uint8Array.from(bytes);
  damaged[typeSectionLengthOffset] = 0x7f;

  const module = parseModule(damaged);
  assert.equal(module.warnings.length > 0, true, "the failure is reported, not swallowed");
  assert.equal(module.types.length, 0);
});

test("survives a module that is cut off mid-body", () => {
  const bytes = minerLikeModule();
  const module = parseModule(bytes.subarray(0, bytes.length - 6));
  assert.equal(module.warnings.length > 0, true);
});
