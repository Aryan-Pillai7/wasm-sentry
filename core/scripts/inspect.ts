import { readFileSync } from "node:fs";
import { analyzeWasm } from "./src/analysis.js";

for (const path of process.argv.slice(2)) {
  const bytes = new Uint8Array(readFileSync(path));
  const valid = WebAssembly.validate(bytes);
  const result = analyzeWasm(bytes);
  if (!result.ok) {
    console.log(`${path}: FAILED ${result.reason}`);
    continue;
  }
  const f = result.features;
  console.log(
    [
      path.split("/").slice(-2).join("/"),
      `engineValid=${valid}`,
      `${(bytes.length / 1024).toFixed(0)}KB`,
      `${result.elapsedMs}ms`,
      `funcs=${f.decodedFunctions} truncated=${f.truncatedFunctions}`,
      `instrs=${f.instructionCount}`,
      `loops=${f.totalLoops} nest=${f.maxNesting}`,
      `bitwise=${(f.bitwiseRatio * 100).toFixed(1)}% float=${(f.floatRatio * 100).toFixed(1)}%`,
      `mem=${f.memoryInitialPages}p shared=${f.memoryShared}`,
      `warnings=${result.warnings.length}`,
    ].join(" | "),
  );
  if (result.warnings.length) console.log("   warnings:", result.warnings.slice(0, 3));
}
