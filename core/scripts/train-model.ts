/**
 * Train and evaluate a classifier over a labelled corpus.
 *
 *   npm run train -w @wasm-sentry/core -- <corpus-dir> [--out model.json]
 *
 * The corpus is two directories of `.wasm` files:
 *
 *   corpus/
 *     benign/       WasmBench, npm packages, anything you can vouch for
 *     malicious/    verified samples
 *
 * Nothing is committed to this repository, and no model is shipped with it.
 * Assembling the malicious half honestly is the actual blocker for this phase,
 * and it is not a code problem: until it exists, every number this script can
 * print is a number about a corpus somebody assembled themselves.
 *
 * The evaluation always reports the heuristics on the same folds, and this
 * script will tell you plainly when the model loses to them -- which, for a
 * small corpus, is the likely and correct outcome.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeWasm } from "../src/analysis.js";
import { crossValidate } from "../src/ml/evaluate.js";
import type { CorpusEntry } from "../src/ml/evaluate.js";
import { FEATURE_NAMES, vectorise } from "../src/ml/features.js";
import { train } from "../src/ml/train.js";
import type { LabelledSample } from "../src/ml/train.js";

const args = process.argv.slice(2);
const corpusDir = args.find((arg) => !arg.startsWith("--"));
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

if (!corpusDir) {
  console.error("usage: train-model <corpus-dir> [--out model.json]");
  console.error("  <corpus-dir> contains benign/ and malicious/ directories of .wasm files");
  process.exit(2);
}

function loadDirectory(dir: string, label: 0 | 1): CorpusEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".wasm"));
  } catch {
    console.error(`  ${dir}: not readable`);
    return [];
  }

  const entries: CorpusEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;

    const result = analyzeWasm(readFileSync(path));
    if (!result.ok) {
      // Reported rather than dropped silently: a corpus quietly missing a
      // third of its samples produces numbers about a corpus nobody chose.
      console.error(`  skipped ${name}: ${result.reason}`);
      continue;
    }
    entries.push({ features: result.features, label, source: name });
  }
  return entries;
}

console.log(`Loading corpus from ${corpusDir}`);
const corpus = [
  ...loadDirectory(join(corpusDir, "benign"), 0),
  ...loadDirectory(join(corpusDir, "malicious"), 1),
];

const benign = corpus.filter((entry) => entry.label === 0).length;
const malicious = corpus.length - benign;
console.log(`  ${corpus.length} modules: ${benign} benign, ${malicious} malicious`);

if (benign === 0 || malicious === 0) {
  console.error("\nA corpus needs both classes. A model fitted to one learns to answer it.");
  process.exit(1);
}

if (corpus.length < 50) {
  console.warn(
    `\nWARNING: ${corpus.length} modules is far too few to conclude anything.\n` +
      "Whatever this prints is a fact about these files, not a detection rate.",
  );
}

/* ---------------------------------------------------------------- */
/* Evaluation first, then the model                                  */
/* ---------------------------------------------------------------- */

console.log("\nCross-validating against the heuristic baseline...");
const evaluation = crossValidate(corpus, { folds: Math.min(5, corpus.length) });

const row = (name: string, m: typeof evaluation.classifier): string =>
  `  ${name.padEnd(12)} acc=${m.accuracy.toFixed(3)} prec=${m.precision.toFixed(3)} ` +
  `rec=${m.recall.toFixed(3)} f1=${m.f1.toFixed(3)} auc=${m.rocAuc.toFixed(3)} ` +
  `(tp=${m.truePositives} fp=${m.falsePositives} tn=${m.trueNegatives} fn=${m.falseNegatives})`;

console.log(`\n${evaluation.folds}-fold, ${evaluation.corpusSize} modules:`);
console.log(row("classifier", evaluation.classifier));
console.log(row("heuristics", evaluation.baseline));
console.log(`\n  ${evaluation.verdict}`);

/* ---------------------------------------------------------------- */
/* The model itself                                                  */
/* ---------------------------------------------------------------- */

const samples: LabelledSample[] = corpus.map((entry) => ({
  vector: vectorise(entry.features),
  label: entry.label,
  source: entry.source,
}));

const { model, finalLoss, lossCurve } = train(samples, {
  metadata: {
    corpus: corpusDir,
    notes: `${evaluation.folds}-fold F1 ${evaluation.classifier.f1.toFixed(3)} vs heuristics ${evaluation.baseline.f1.toFixed(3)}`,
  },
});

console.log(`\nTrained on all ${corpus.length} modules. Final loss ${finalLoss.toFixed(4)}.`);
if (lossCurve.length > 1 && finalLoss > (lossCurve[0] ?? 0) * 0.9) {
  console.warn("  WARNING: loss barely moved. The model has not converged; check the corpus.");
}

const ranked = model.weights
  .map((weight, index) => ({ name: FEATURE_NAMES[index] ?? `column_${index}`, weight }))
  .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  .slice(0, 10);

console.log("\nStrongest weights (standardised units):");
for (const { name, weight } of ranked) {
  console.log(`  ${weight >= 0 ? "+" : "-"}${Math.abs(weight).toFixed(3)}  ${name}`);
}

if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
} else {
  console.log("\nNot written. Pass --out <path> to save the model.");
}

console.log(
  "\nNo detection rate is claimed by this repository. These numbers describe the\n" +
    "corpus you supplied and nothing else.",
);
