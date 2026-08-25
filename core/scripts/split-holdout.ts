/**
 * Split a final, cleaned corpus into a training set and a held-out test set,
 * by SHA-256 prefix -- reproducible, and stable as the corpus grows (a file
 * added later lands wherever its hash says, not wherever it happened to sort).
 *
 *   npm run split-holdout -w @wasm-sentry/core -- <corpus-dir> [--prefixes 0,1,2]
 *
 * Run this LAST, after filter-corpus, dedupe-corpus and cluster-corpus.
 * Moves matching files from <corpus-dir>/<class>/ into
 * <corpus-dir>/holdout/<class>/. Never train on the holdout directory; run
 * `npm run train` against it only once, at the end, to report the final number.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";

const args = process.argv.slice(2);
const corpusDir = args.find((arg) => !arg.startsWith("--"));
const prefixIndex = args.indexOf("--prefixes");
const prefixes = (prefixIndex >= 0 ? args[prefixIndex + 1]! : "0,1,2").split(",");

if (!corpusDir) {
  console.error("usage: split-holdout <corpus-dir> [--prefixes 0,1,2]");
  process.exit(2);
}

async function splitClass(className: "benign" | "malicious"): Promise<void> {
  const dir = join(corpusDir!, className);
  const holdoutDir = join(corpusDir!, "holdout", className);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".wasm"));
  } catch {
    console.log(`${className}: ${dir} not readable, skipping`);
    return;
  }

  let moved = 0;
  for (const name of names) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const hash = await sha256(readFileSync(path));
    if (prefixes.some((p) => hash.startsWith(p))) {
      mkdirSync(holdoutDir, { recursive: true });
      renameSync(path, join(holdoutDir, name));
      moved++;
    }
  }
  console.log(`${className}: ${moved}/${names.length} moved to holdout (prefixes ${prefixes.join(",")})`);
}

await splitClass("benign");
await splitClass("malicious");
console.log(
  "\nTrain only against <corpus-dir> (holdout/ is a sibling, not a subdirectory " +
    "the trainer reads). Evaluate the saved model against <corpus-dir>/holdout once, at the end.",
);
