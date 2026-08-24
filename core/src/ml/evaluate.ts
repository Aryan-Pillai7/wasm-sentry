/**
 * Evaluation, and the baseline it has to be reported against.
 *
 * The rule this file exists to enforce: **a classifier is reported against the
 * heuristics, never against nothing.** A model with 0.94 accuracy sounds like an
 * achievement until the twelve hand-written rules it replaced score 0.95 on the
 * same folds, and a project that has refused to claim a detection rate
 * everywhere else is not going to start by claiming one with no comparison.
 *
 * Two more things are enforced here rather than left to whoever runs it:
 *
 * **Folds, not a single split.** A small corpus and a lucky split produce a
 * number that means nothing and cannot be told apart from one that does.
 *
 * **Standardisation is fitted inside each fold.** Fitting it over the whole
 * corpus first leaks the test set's distribution into training, which quietly
 * flatters every number below. It is the easiest mistake to make here and the
 * hardest to notice afterwards.
 */
import { evaluateHeuristics } from "../heuristics.js";
import { assessRisk, coverageOf } from "../scoring.js";
import type { ModuleFeatures } from "../wasm/features.js";
import { vectorise } from "./features.js";
import { predictVector } from "./model.js";
import { train } from "./train.js";
import type { LabelledSample, TrainOptions } from "./train.js";

export interface ConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
}

export interface Metrics extends ConfusionMatrix {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  /** Threshold-free ranking quality; 0.5 is a coin flip. */
  rocAuc: number;
}

/** Count outcomes at a decision threshold. */
export function confusion(
  scored: ReadonlyArray<{ score: number; label: 0 | 1 }>,
  threshold: number,
): ConfusionMatrix {
  const matrix: ConfusionMatrix = {
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
  };
  for (const { score, label } of scored) {
    const predicted = score >= threshold ? 1 : 0;
    if (predicted === 1 && label === 1) matrix.truePositives++;
    else if (predicted === 1) matrix.falsePositives++;
    else if (label === 1) matrix.falseNegatives++;
    else matrix.trueNegatives++;
  }
  return matrix;
}

/**
 * Area under the ROC curve, by rank.
 *
 * Computed from the Mann-Whitney statistic, with ties given half credit --
 * which matters here, because a rule-based baseline produces a lot of exactly
 * equal scores and a tie-blind implementation would flatter it.
 */
export function rocAuc(scored: ReadonlyArray<{ score: number; label: 0 | 1 }>): number {
  const positives = scored.filter((entry) => entry.label === 1);
  const negatives = scored.filter((entry) => entry.label === 0);
  if (positives.length === 0 || negatives.length === 0) return 0.5;

  let concordant = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.score > negative.score) concordant += 1;
      else if (positive.score === negative.score) concordant += 0.5;
    }
  }
  return concordant / (positives.length * negatives.length);
}

export function metrics(
  scored: ReadonlyArray<{ score: number; label: 0 | 1 }>,
  threshold: number,
): Metrics {
  const matrix = confusion(scored, threshold);
  const { truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn } = matrix;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

  return {
    ...matrix,
    accuracy: scored.length > 0 ? (tp + tn) / scored.length : 0,
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    rocAuc: rocAuc(scored),
  };
}

/** A corpus entry: the module's features, its label, and where it came from. */
export interface CorpusEntry {
  features: ModuleFeatures;
  label: 0 | 1;
  source: string;
}

/**
 * The heuristic baseline's score for one module, on the same 0..1 scale as the
 * classifier, so the two are comparable at all.
 */
export function heuristicScore(features: ModuleFeatures): number {
  const findings = evaluateHeuristics(features);
  return assessRisk(findings, coverageOf(features)).score / 100;
}

export interface EvaluationOptions extends TrainOptions {
  folds?: number;
  /** Decision threshold for the classifier. */
  threshold?: number;
  /**
   * Decision threshold for the baseline, on the same 0..1 scale.
   *
   * Defaults to 0.5, which is the boundary of the *high* band -- the point at
   * which the existing rules would actually tell a user something is wrong.
   * Comparing against a baseline tuned to a different question would not be a
   * comparison.
   */
  baselineThreshold?: number;
  /** Injected so a test can make folds deterministic. */
  shuffle?: <T>(items: T[]) => T[];
}

export interface Evaluation {
  folds: number;
  corpusSize: number;
  benign: number;
  malicious: number;
  classifier: Metrics;
  baseline: Metrics;
  /** F1 difference, classifier minus baseline. Negative means it lost. */
  f1Delta: number;
  /** A sentence stating the comparison, so a report cannot omit it. */
  verdict: string;
}

/** Deterministic Fisher-Yates over a seeded generator, so a run reproduces. */
function seededShuffle<T>(items: T[]): T[] {
  let seed = 0x2f6e2b1;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Cross-validate the classifier and the heuristics over the same folds.
 *
 * Both are scored on exactly the same held-out modules, which is the only way
 * the comparison means anything.
 */
export function crossValidate(
  corpus: readonly CorpusEntry[],
  options: EvaluationOptions = {},
): Evaluation {
  const folds = Math.max(2, options.folds ?? 5);
  const threshold = options.threshold ?? 0.5;
  const baselineThreshold = options.baselineThreshold ?? 0.5;
  const shuffle = options.shuffle ?? seededShuffle;

  if (corpus.length < folds) {
    throw new Error(`a ${folds}-fold evaluation needs at least ${folds} modules`);
  }

  const shuffled = shuffle([...corpus]);
  const classifierScores: Array<{ score: number; label: 0 | 1 }> = [];
  const baselineScores: Array<{ score: number; label: 0 | 1 }> = [];

  for (let fold = 0; fold < folds; fold++) {
    const test = shuffled.filter((_entry, index) => index % folds === fold);
    const trainingSet = shuffled.filter((_entry, index) => index % folds !== fold);
    if (test.length === 0) continue;

    const labels = new Set(trainingSet.map((entry) => entry.label));
    if (labels.size < 2) {
      throw new Error(
        `fold ${fold} has only one class in its training split; the corpus is too small or too skewed`,
      );
    }

    // Standardisation is fitted inside `train`, over this fold's training split
    // only. Fitting it over the whole corpus first would leak the test set's
    // distribution into training and quietly flatter every number below.
    const samples: LabelledSample[] = trainingSet.map((entry) => ({
      vector: vectorise(entry.features),
      label: entry.label,
    }));
    const { model } = train(samples, options);

    for (const entry of test) {
      classifierScores.push({
        score: predictVector(model, vectorise(entry.features)).probability,
        label: entry.label,
      });
      baselineScores.push({ score: heuristicScore(entry.features), label: entry.label });
    }
  }

  const classifier = metrics(classifierScores, threshold);
  const baseline = metrics(baselineScores, baselineThreshold);
  const f1Delta = classifier.f1 - baseline.f1;

  return {
    folds,
    corpusSize: corpus.length,
    benign: corpus.filter((entry) => entry.label === 0).length,
    malicious: corpus.filter((entry) => entry.label === 1).length,
    classifier,
    baseline,
    f1Delta,
    verdict:
      f1Delta > 0.01
        ? `the classifier beats the heuristics by ${(f1Delta * 100).toFixed(1)} F1 points on ${corpus.length} modules`
        : f1Delta < -0.01
          ? `the classifier LOSES to the heuristics by ${(-f1Delta * 100).toFixed(1)} F1 points -- ship the rules, not the model`
          : `the classifier matches the heuristics; the rules are explainable and the model is not, so ship the rules`,
  };
}
