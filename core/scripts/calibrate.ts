import { readFileSync } from "node:fs";
import { analyzeWasm } from "../src/analysis.js";

for (const path of process.argv.slice(2)) {
  const r = analyzeWasm(readFileSync(path));
  if (!r.ok) continue;
  const candidates = r.features.functions.filter((f) => f.largestLoop >= 40 && f.bitwiseRatio >= 0.15);
  console.log(`${path.split("/").pop()}: ${candidates.length} functions with a >=40 loop and >=15% bitwise`);
  for (const f of [...candidates].sort((a, b) => b.bitwiseRatio - a.bitwiseRatio).slice(0, 6)) {
    console.log(
      `   fn${f.index} loop=${f.largestLoop} instr=${f.instructionCount}` +
        ` bitwise=${(f.bitwiseRatio * 100).toFixed(1)}%` +
        ` arith=${(f.arithmeticRatio * 100).toFixed(1)}%` +
        ` calls=${f.calls}(${(f.callRatio * 100).toFixed(1)}%)` +
        ` float=${f.floatOps} mem=${f.memoryOps}`,
    );
  }
}
