/**
 * Find the specific file(s) responsible for a memory blowup during
 * `filter-corpus` / `train-model`, by processing largest-first and printing
 * a START/DONE marker around every `analyzeWasm` call. If the process
 * crashes, the last unmatched START line names the offending file.
 *
 *   npm run diagnose-corpus -w @wasm-sentry/core -- <corpus-dir>/<class>
 *
 * Not part of the normal pipeline -- a one-off tool for this investigation.
 * Sorted largest-first deliberately: a memory blowup from a single expensive
 * file is far more likely among the biggest files than the smallest, and
 * filter-corpus.ts's own size ceiling (20MB) already keeps anything larger
 * out of analyzeWasm entirely, so this only needs to cover up to that limit.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeWasm } from "../src/analysis.js";
import { isWasm } from "../src/sniff.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: diagnose-corpus <corpus-dir>/<class>");
  process.exit(2);
}

const names = readdirSync(dir)
  .filter((n) => n.endsWith(".wasm"))
  .map((name) => ({ name, size: statSync(join(dir, name)).size }))
  .sort((a, b) => b.size - a.size);

console.log(`${names.length} files, largest first (${(names[0]?.size ?? 0) / 1024 / 1024}MB down to ${(names[names.length - 1]?.size ?? 0) / 1024}KB)\n`);

for (let i = 0; i < names.length; i++) {
  const { name, size } = names[i]!;
  const path = join(dir, name);
  process.stdout.write(`[${i + 1}/${names.length}] START ${name} (${(size / 1024 / 1024).toFixed(2)}MB)\n`);

  const bytes = readFileSync(path);
  if (!isWasm(bytes)) {
    console.log("  not wasm, skip");
    continue;
  }

  const t0 = Date.now();
  const result = analyzeWasm(bytes);
  const dt = Date.now() - t0;
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  process.stdout.write(`  DONE ok=${result.ok} time=${dt}ms heapUsed=${heapMB.toFixed(0)}MB\n`);

  if (dt > 3000 || heapMB > 1500) {
    console.log(`  ^^^ SUSPECT: slow or high heap usage on this file`);
  }
}

console.log("\nALL DONE -- no crash. The pathological file, if any, is not in this directory as filtered.");
