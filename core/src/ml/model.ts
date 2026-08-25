/**
 * The model, and inference over it.
 *
 * Logistic regression, deliberately. Not because it is the strongest thing that
 * could sit here, but because of what this project has already committed to:
 * every finding states the numbers that produced it, and a rule that cannot be
 * interrogated does not ship. A linear model keeps that promise -- the reason
 * for a score is a list of columns and how much each one moved it, in the same
 * units a reader can check against the module's own measurements.
 *
 * It is also 60 numbers. It serialises to a few kilobytes of JSON, needs no
 * runtime, and inference is a dot product, which is what lets it run inside a
 * service worker without shipping a second WebAssembly module inside a
 * WebAssembly security tool.
 *
 * **No model is shipped with this repository.** Training one honestly needs a
 * labelled corpus that does not exist yet, and a model trained on anything less
 * would produce confident numbers with nothing behind them. Everything here is
 * the pipeline around that corpus, and a test-trained model proves the pipeline
 * works, not that any particular model does.
 */
import { FEATURE_COUNT, FEATURE_NAMES, FEATURE_SCHEMA_VERSION, vectorise } from "./features.js";
import type { ModuleFeatures } from "../wasm/features.js";
import { sha256 } from "../hash.js";

export interface ClassifierModel {
  /** Which feature schema this was trained against. Refused if it disagrees. */
  schemaVersion: number;
  /** One weight per column, in `FEATURE_NAMES` order. */
  weights: number[];
  bias: number;
  /** Column means and standard deviations, so inference scales as training did. */
  mean: number[];
  stdDev: number[];
  /** Free-form provenance. Never read by the code; always read by a human. */
  metadata: {
    trainedAt: string;
    /** How the corpus was assembled, in the trainer's own words. */
    corpus: string;
    benignCount: number;
    maliciousCount: number;
    /** What the training run measured about itself. Never a claim about the world. */
    notes?: string;
  };
}

export interface Prediction {
  /** 0..1, the model's probability that the module is malicious. */
  probability: number;
  /**
   * The columns that moved this prediction most, largest contribution first.
   *
   * Not decoration. A score with no attribution is the interpretability
   * problem this project exists to avoid, and it does not stop being one
   * because a model produced it rather than a rule.
   */
  topContributions: Array<{ feature: string; contribution: number; value: number }>;
}

export class ModelSchemaError extends Error {
  constructor(expected: number, found: number) {
    super(
      `model was trained on feature schema v${found}, this build produces v${expected}; ` +
        `retrain it rather than reinterpreting its columns`,
    );
    this.name = "ModelSchemaError";
  }
}

function sigmoid(z: number): number {
  // Split by sign so neither branch computes exp() of a large positive number.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Content hash of what actually decides a prediction -- weights, bias,
 * standardisation stats and the schema they're indexed against. Deliberately
 * excludes `metadata`: two training runs that land on the same numbers are
 * the same model as far as any stored verdict is concerned, even if they ran
 * at different times or one has a note the other doesn't. Compute this once
 * per loaded model, not per prediction -- it's the same reason artifact
 * identity is a content hash rather than a URL: a verdict computed under one
 * version should mean the same thing wherever that version's hash appears
 * again, and a store can tell a stale verdict from a fresh one only if it
 * has this to compare against.
 */
export async function modelVersion(model: ClassifierModel): Promise<string> {
  const canonical = JSON.stringify({
    schemaVersion: model.schemaVersion,
    weights: model.weights,
    bias: model.bias,
    mean: model.mean,
    stdDev: model.stdDev,
  });
  return sha256(new TextEncoder().encode(canonical));
}

/** Standardise a raw vector with the model's own training statistics. */
export function standardise(model: ClassifierModel, vector: readonly number[]): number[] {
  return vector.map((value, index) => {
    const spread = model.stdDev[index] ?? 1;
    // A column that never varied in training carries no information; dividing
    // by its zero spread would turn it into an infinity.
    return spread > 1e-12 ? (value - (model.mean[index] ?? 0)) / spread : 0;
  });
}

/**
 * Score a raw feature vector.
 *
 * Throws on a schema mismatch rather than scoring the wrong columns, because a
 * model quietly reading the wrong inputs produces confident nonsense and there
 * is no way to notice from the output.
 */
export function predictVector(model: ClassifierModel, vector: readonly number[]): Prediction {
  if (model.schemaVersion !== FEATURE_SCHEMA_VERSION) {
    throw new ModelSchemaError(FEATURE_SCHEMA_VERSION, model.schemaVersion);
  }
  if (vector.length !== FEATURE_COUNT) {
    throw new Error(`expected ${FEATURE_COUNT} features, received ${vector.length}`);
  }

  const scaled = standardise(model, vector);
  let z = model.bias;
  const contributions: Array<{ feature: string; contribution: number; value: number }> = [];

  for (let i = 0; i < scaled.length; i++) {
    const contribution = (model.weights[i] ?? 0) * (scaled[i] ?? 0);
    z += contribution;
    if (contribution !== 0) {
      contributions.push({
        feature: FEATURE_NAMES[i] ?? `column_${i}`,
        contribution,
        value: vector[i] ?? 0,
      });
    }
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return { probability: sigmoid(z), topContributions: contributions.slice(0, 5) };
}

/** Score a module. */
export function predict(model: ClassifierModel, features: ModuleFeatures): Prediction {
  return predictVector(model, vectorise(features));
}

/**
 * Parse a model from JSON, checking everything before it can be used.
 *
 * A model is a file on disk that somebody put there. Validating its shape here
 * means a truncated or hand-edited one fails immediately and says why, rather
 * than scoring every module with `undefined` weights.
 */
export function parseModel(json: string): ClassifierModel {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) throw new Error("model is not an object");

  const model = raw as Partial<ClassifierModel>;
  const arrays: Array<[string, unknown]> = [
    ["weights", model.weights],
    ["mean", model.mean],
    ["stdDev", model.stdDev],
  ];

  for (const [name, value] of arrays) {
    if (!Array.isArray(value) || value.length !== FEATURE_COUNT) {
      throw new Error(`model.${name} must be an array of ${FEATURE_COUNT} numbers`);
    }
    if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      throw new Error(`model.${name} contains a value that is not a finite number`);
    }
  }

  if (typeof model.bias !== "number" || !Number.isFinite(model.bias)) {
    throw new Error("model.bias must be a finite number");
  }
  if (typeof model.schemaVersion !== "number") {
    throw new Error("model.schemaVersion is missing");
  }
  if (model.schemaVersion !== FEATURE_SCHEMA_VERSION) {
    throw new ModelSchemaError(FEATURE_SCHEMA_VERSION, model.schemaVersion);
  }

  return model as ClassifierModel;
}
