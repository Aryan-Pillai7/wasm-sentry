/**
 * Training, in about a hundred lines of arithmetic.
 *
 * Batch gradient descent on a logistic regression with L2 regularisation. No
 * framework, because `core` has no runtime dependencies and this does not need
 * one: the model is a vector of sixty weights, and fitting it is a loop.
 *
 * Training never runs in the extension. It runs offline, over a corpus, and
 * produces a JSON file that inference reads -- which is the split the project
 * planned from the start: train outside, ship inference only.
 */
import { FEATURE_COUNT, FEATURE_SCHEMA_VERSION } from "./features.js";
import type { ClassifierModel } from "./model.js";

export interface LabelledSample {
  /** Raw, unstandardised feature vector. */
  vector: number[];
  /** 1 for malicious, 0 for benign. */
  label: 0 | 1;
  /** Where it came from, for error messages a human can act on. */
  source?: string;
}

export interface TrainOptions {
  /** Passes over the corpus. */
  epochs?: number;
  learningRate?: number;
  /** L2 penalty. Small corpora overfit instantly without one. */
  l2?: number;
  /**
   * Weight the positive class by the imbalance in the corpus.
   *
   * A corpus that is 95% benign lets a model reach 95% accuracy by answering
   * "benign" every time, which is the shape of a useless detector with a good
   * headline number.
   */
  balanceClasses?: boolean;
  metadata?: Partial<ClassifierModel["metadata"]>;
}

const DEFAULTS = { epochs: 400, learningRate: 0.3, l2: 0.01, balanceClasses: true };

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Column means and standard deviations over the corpus. */
export function standardiser(samples: readonly LabelledSample[]): {
  mean: number[];
  stdDev: number[];
} {
  const n = samples.length;
  const mean = new Array<number>(FEATURE_COUNT).fill(0);
  const stdDev = new Array<number>(FEATURE_COUNT).fill(0);
  if (n === 0) return { mean, stdDev: stdDev.map(() => 1) };

  for (const sample of samples) {
    for (let i = 0; i < FEATURE_COUNT; i++) mean[i]! += (sample.vector[i] ?? 0) / n;
  }
  for (const sample of samples) {
    for (let i = 0; i < FEATURE_COUNT; i++) {
      const delta = (sample.vector[i] ?? 0) - mean[i]!;
      stdDev[i]! += (delta * delta) / n;
    }
  }
  // A column that never varied carries no information. Left at 1 so
  // standardising it yields zero rather than an infinity.
  return { mean, stdDev: stdDev.map((variance) => Math.max(Math.sqrt(variance), 1e-9)) };
}

export interface TrainingReport {
  model: ClassifierModel;
  /** Mean log loss per epoch, sampled, so a failure to converge is visible. */
  lossCurve: number[];
  finalLoss: number;
}

export function train(samples: readonly LabelledSample[], options: TrainOptions = {}): TrainingReport {
  const epochs = options.epochs ?? DEFAULTS.epochs;
  const learningRate = options.learningRate ?? DEFAULTS.learningRate;
  const l2 = options.l2 ?? DEFAULTS.l2;
  const balance = options.balanceClasses ?? DEFAULTS.balanceClasses;

  if (samples.length === 0) throw new Error("cannot train on an empty corpus");
  const positives = samples.filter((sample) => sample.label === 1).length;
  const negatives = samples.length - positives;
  if (positives === 0 || negatives === 0) {
    // A model fitted to one class learns to answer that class. Refusing here
    // costs a confusing error message and saves a confident, useless model.
    throw new Error(
      `a corpus needs both classes: ${positives} malicious, ${negatives} benign`,
    );
  }

  const { mean, stdDev } = standardiser(samples);
  const scaled = samples.map((sample) => ({
    label: sample.label,
    // Standardised once, up front: doing it per epoch would be the same
    // arithmetic four hundred times.
    x: sample.vector.map((value, i) => (value - (mean[i] ?? 0)) / (stdDev[i] ?? 1)),
    weight: balance
      ? sample.label === 1
        ? samples.length / (2 * positives)
        : samples.length / (2 * negatives)
      : 1,
  }));

  const weights = new Array<number>(FEATURE_COUNT).fill(0);
  let bias = 0;
  const lossCurve: number[] = [];
  let loss = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array<number>(FEATURE_COUNT).fill(0);
    let biasGradient = 0;
    let totalWeight = 0;
    loss = 0;

    for (const sample of scaled) {
      let z = bias;
      for (let i = 0; i < FEATURE_COUNT; i++) z += weights[i]! * (sample.x[i] ?? 0);
      const prediction = sigmoid(z);
      const error = prediction - sample.label;

      for (let i = 0; i < FEATURE_COUNT; i++) {
        gradient[i]! += sample.weight * error * (sample.x[i] ?? 0);
      }
      biasGradient += sample.weight * error;
      totalWeight += sample.weight;

      // Clamped so a confident wrong answer costs a large number rather than
      // an infinity, which would make the whole curve unreadable.
      const p = Math.min(Math.max(prediction, 1e-12), 1 - 1e-12);
      loss += sample.weight * -(sample.label * Math.log(p) + (1 - sample.label) * Math.log(1 - p));
    }

    loss /= totalWeight;
    for (let i = 0; i < FEATURE_COUNT; i++) {
      // The bias is deliberately not regularised: penalising it pulls the
      // decision boundary toward the origin for no reason.
      weights[i]! -= learningRate * (gradient[i]! / totalWeight + l2 * weights[i]!);
    }
    bias -= learningRate * (biasGradient / totalWeight);

    if (epoch % Math.max(1, Math.floor(epochs / 20)) === 0) lossCurve.push(loss);
  }
  lossCurve.push(loss);

  return {
    model: {
      schemaVersion: FEATURE_SCHEMA_VERSION,
      weights,
      bias,
      mean,
      stdDev,
      metadata: {
        trainedAt: new Date().toISOString(),
        corpus: options.metadata?.corpus ?? "unspecified",
        benignCount: negatives,
        maliciousCount: positives,
        ...(options.metadata?.notes !== undefined ? { notes: options.metadata.notes } : {}),
      },
    },
    lossCurve,
    finalLoss: loss,
  };
}
