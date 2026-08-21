import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWasm } from "../src/analysis.js";
import { buildCfg } from "../src/wasm/cfg.js";
import { decodeExpression } from "../src/wasm/decode.js";
import { Reader } from "../src/wasm/reader.js";
import { parseModule } from "../src/wasm/module.js";
import { instructionsToWat } from "../src/wasm/wat.js";
import { benignModule, minerLikeModule } from "./fixtures.js";

function decodeFirstBody(bytes: Uint8Array) {
  const module = parseModule(bytes);
  const entry = module.code[0]!;
  return decodeExpression(new Reader(module.bytes, entry.bodyStart), entry.bodyEnd);
}

test("decodes a function body exactly, immediates included", () => {
  const { instructions, truncated } = decodeFirstBody(minerLikeModule());

  assert.equal(truncated, undefined);
  assert.deepEqual(
    instructions.map((i) => i.name),
    [
      "loop", "local.get", "i32.const", "i32.shl", "local.get", "i32.xor",
      "local.set", "local.get", "i32.const", "i32.gt_s", "br_if", "end",
      "local.get", "end",
    ],
  );
  assert.deepEqual(instructions[2]!.args, [7], "i32.const 7 keeps its operand");
});

test("renders WAT that reflects the decode a detector reasoned about", () => {
  const { instructions } = decodeFirstBody(minerLikeModule());
  const wat = instructionsToWat(instructions);

  assert.match(wat, /^loop 64$/m);
  assert.match(wat, /^ {2}i32\.xor$/m, "loop body is indented one level");
  assert.match(wat, /^ {2}br_if 0$/m);
});

test("builds a control flow graph with the loop's back edge", () => {
  const { instructions } = decodeFirstBody(minerLikeModule());
  const cfg = buildCfg(instructions);

  assert.equal(cfg.loops.length, 1);
  assert.equal(cfg.loops[0]!.depth, 0);
  assert.equal(cfg.backEdges.length, 1, "br_if 0 re-enters the loop header");
  assert.equal(cfg.approximate, false);
  assert.ok(cfg.blocks.length >= 2);
});

test("a straight-line body has no loops and no back edges", () => {
  const cfg = buildCfg(decodeFirstBody(benignModule()).instructions);
  assert.deepEqual(cfg.loops, []);
  assert.deepEqual(cfg.backEdges, []);
});

test("separates integer-loop work from float work in the feature vector", () => {
  const miner = analyzeWasm(minerLikeModule());
  const benign = analyzeWasm(benignModule());
  assert.equal(miner.ok, true);
  assert.equal(benign.ok, true);
  if (!miner.ok || !benign.ok) return;

  assert.equal(miner.features.totalLoops, 1);
  assert.ok(miner.features.bitwiseRatio > 0.1, "shifts and xors dominate the kernel");
  assert.equal(miner.features.floatRatio, 0);
  assert.equal(miner.features.memoryInitialPages, 1);

  assert.equal(benign.features.totalLoops, 0);
  assert.equal(benign.features.bitwiseRatio, 0);
  assert.ok(benign.features.floatRatio > 0.1);
  assert.deepEqual(benign.features.importNames, ["env.log"]);
});

test("does not nominate a short loop as a compute kernel", () => {
  const result = analyzeWasm(minerLikeModule());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // The fixture's loop is eleven instructions. Calling that a kernel is how a
  // detector ends up flagging every checksum in every module on the web.
  assert.equal(result.features.kernelCandidate, null);
});

test("reports a stripped module as stripped", () => {
  const result = analyzeWasm(minerLikeModule());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.features.stripped, true, "no name section was emitted");
});

test("returns a failure rather than throwing on hostile input", () => {
  const html = analyzeWasm(new TextEncoder().encode("<html><body>nope"));
  assert.equal(html.ok, false);
  if (html.ok) return;
  assert.match(html.reason, /not a WebAssembly module/);

  // Correct header, garbage body: still a result, never an exception.
  const fake = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0, 0xff, 0xff, 0xff]);
  const result = analyzeWasm(fake);
  assert.equal(result.ok, true, "a bad section is a warning, not a parse failure");
});

test("honours the instruction budget instead of running unbounded", () => {
  const result = analyzeWasm(minerLikeModule(), { instructionBudget: 0 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.features.decodedFunctions, 0);
  assert.equal(result.features.skippedFunctions, 1);
});

test("renders a module header a reviewer can read", () => {
  const result = analyzeWasm(benignModule());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.match(result.watHeader, /\(import "env" "log" \(func \(type \$t0\)\)\)/);
  assert.match(result.watHeader, /\(export "compute" \(func 1\)\)/);
});
