import { readFileSync } from "node:fs";
import { analyzeWasm } from "../src/analysis.js";
for (const path of process.argv.slice(2)) {
  const r = analyzeWasm(new Uint8Array(readFileSync(path)));
  if (!r.ok) continue;
  const withLoops = r.features.functions.filter((f) => f.largestLoop >= 40);
  const top = [...withLoops].sort((a, b) => b.bitwiseRatio - a.bitwiseRatio).slice(0, 5);
  console.log(path.split("/").pop(), "functions with loops>=40:", withLoops.length);
  for (const f of top) {
    console.log(`   fn${f.index} loop=${f.largestLoop} bitwise=${(f.bitwiseRatio*100).toFixed(1)}% instr=${f.instructionCount}`);
  }
  console.log("   hottest:", r.features.hottestLoop);
}
