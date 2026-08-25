/**
 * Filter a raw corpus down to parseable, high-coverage, reasonably-sized
 * Wasm before anything gets deduplicated or trained on.
 *
 *   npm run filter-corpus -w @wasm-sentry/core -- <corpus-dir> [--min-coverage 0.9] [--min-bytes 1024] [--max-bytes 20971520]
 *
 * Walks <corpus-dir>/benign and <corpus-dir>/malicious (flat, non-recursive,
 * same contract as train-model.ts) and moves anything that fails a gate into
 * a sibling "<class>-rejected" directory with the reason in its filename, so
 * nothing disappears silently and the counts are auditable afterwards.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeWasm } from "../src/analysis.js";
import { isWasm } from "../src/sniff.js";
import { coverageOf } from "../src/scoring.js";

const args = process.argv.slice(2);
const corpusDir = args.find((arg) => !arg.startsWith("--"));
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

if (!corpusDir) {
  console.error("usage: filter-corpus <corpus-dir> [--min-coverage 0.9] [--min-bytes 1024] [--max-bytes 20971520]");
  process.exit(2);
}

const minCoverage = flag("min-coverage", 0.9);
const minBytes = flag("min-bytes", 1024);
const maxBytes = flag("max-bytes", 20 * 1024 * 1024);

function filterClass(className: "benign" | "malicious"): void {
  const dir = join(corpusDir!, className);
  const rejectedDir = join(corpusDir!, `${className}-rejected`);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".wasm"));
  } catch {
    console.log(`${className}: ${dir} not readable, skipping`);
    return;
  }

  let kept = 0;
  const rejections: Record<string, number> = {};

  for (const name of names) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;

    // Check size against the stat first -- reading a 75MB outlier into memory
    // just to reject it a moment later is real, avoidable memory pressure
    // across a corpus with thousands of files.
    let reason: string | null = null;
    if (stat.size < minBytes) reason = "too-small";
    else if (stat.size > maxBytes) reason = "too-large";

    if (!reason) {
      // readFileSync already returns a Buffer, which *is* a Uint8Array
      // (Node's own subclass) -- wrapping it in `new Uint8Array(...)` copies
      // every byte a second time for no reason, doubling memory per file.
      const bytes = readFileSync(path);

      if (!isWasm(bytes)) {
        reason = "not-wasm-magic";
      } else {
        const result = analyzeWasm(bytes);
        if (!result.ok) {
          reason = "parse-failed";
        } else {
          const f = result.features;
          const coverage = coverageOf({
            functionCount: f.functionCount,
            truncatedFunctions: f.truncatedFunctions,
            skippedFunctions: f.skippedFunctions,
          });
          if (coverage < minCoverage) reason = "low-coverage";
        }
      }
    }

    if (reason) {
      mkdirSync(rejectedDir, { recursive: true });
      renameSync(path, join(rejectedDir, `${reason}__${name}`));
      rejections[reason] = (rejections[reason] ?? 0) + 1;
    } else {
      kept++;
    }
  }

  console.log(`${className}: kept ${kept}/${names.length}`);
  for (const [reason, count] of Object.entries(rejections)) {
    console.log(`  rejected ${count} (${reason})`);
  }
}

filterClass("benign");
filterClass("malicious");
console.log(
  "\nRejected files were moved, not deleted -- see <corpus-dir>/<class>-rejected/. " +
    "Review before assuming the gate was right in every case.",
);
