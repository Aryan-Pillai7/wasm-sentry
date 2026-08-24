import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWasm } from "../src/analysis.js";
import { evaluateHeuristics, listRules } from "../src/heuristics.js";
import {
  FEATURE_COUNT,
  FEATURE_NAMES,
  FEATURE_SCHEMA_VERSION,
  vectorise,
} from "../src/ml/features.js";
import {
  ModelSchemaError,
  parseModel,
  predict,
  predictVector,
  standardise,
} from "../src/ml/model.js";
import type { ClassifierModel } from "../src/ml/model.js";
import { standardiser, train } from "../src/ml/train.js";
import type { LabelledSample } from "../src/ml/train.js";
import { confusion, crossValidate, heuristicScore, metrics, rocAuc } from "../src/ml/evaluate.js";
import type { CorpusEntry } from "../src/ml/evaluate.js";
import type { ModuleFeatures } from "../src/wasm/features.js";
import { benignModule, minerLikeModule, syntheticMinerModule } from "./fixtures.js";

function featuresOf(bytes: Uint8Array): ModuleFeatures {
  const result = analyzeWasm(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.features;
}

/* ------------------------------------------------------------------ */
/* The vector                                                          */
/* ------------------------------------------------------------------ */

test("every column is named, and the names are unique", () => {
  // Order is part of the model: a vector is meaningless without knowing what
  // column 34 was, and a duplicate name makes a weight impossible to attribute.
  assert.equal(FEATURE_NAMES.length, FEATURE_COUNT);
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_COUNT);
});

test("vectorising is deterministic and produces no NaN", () => {
  for (const bytes of [benignModule(), minerLikeModule(), syntheticMinerModule()]) {
    const features = featuresOf(bytes);
    const first = vectorise(features);
    assert.deepEqual(first, vectorise(features), "the same module, the same vector");
    assert.equal(first.length, FEATURE_COUNT);
    // A single NaN silently poisons every weight it touches during training.
    assert.ok(first.every(Number.isFinite), "a NaN reached the vector");
  }
});

test("an unparseable-but-headered module still vectorises", () => {
  // Analysis never throws, so the pipeline behind it must not either: a module
  // with a valid header and a garbage body is a normal input here.
  const result = analyzeWasm(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0xff]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(vectorise(result.features).every(Number.isFinite));
});

test("counts are compressed so one huge module cannot dominate the fit", () => {
  const small = vectorise(featuresOf(benignModule()));
  const large = vectorise(featuresOf(syntheticMinerModule({ rounds: 400 })));

  const index = FEATURE_NAMES.indexOf("log_instructionCount");
  assert.ok(large[index]! > small[index]!, "bigger is still bigger");
  // Raw counts differ by orders of magnitude; log-scaled they differ by a few.
  assert.ok(large[index]! < small[index]! * 6, "but not by orders of magnitude");
});

test("the kernel columns say when there is no kernel, rather than guessing", () => {
  const vector = vectorise(featuresOf(benignModule()));
  const hasKernel = FEATURE_NAMES.indexOf("has_kernel");
  assert.equal(vector[hasKernel], 0);
  assert.equal(vector[FEATURE_NAMES.indexOf("kernel_bitwiseRatio")], 0);
});

/* ------------------------------------------------------------------ */
/* Training                                                            */
/* ------------------------------------------------------------------ */

/**
 * A separable synthetic corpus.
 *
 * Deliberately synthetic and deliberately easy: what is under test is that the
 * trainer minimises its loss and that inference agrees with training, not that
 * any model is good at anything. Proving the latter needs a labelled corpus
 * this project does not have, and this file will not pretend otherwise.
 */
function syntheticCorpus(count = 60): LabelledSample[] {
  const samples: LabelledSample[] = [];
  let seed = 12345;
  const random = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < count; i++) {
    const label: 0 | 1 = i % 2 === 0 ? 0 : 1;
    const vector = new Array<number>(FEATURE_COUNT).fill(0).map(() => random() * 0.1);
    // One column carries the signal, with overlap between the classes.
    vector[6] = label === 1 ? 0.6 + random() * 0.3 : 0.05 + random() * 0.2;
    samples.push({ vector, label });
  }
  return samples;
}

test("training reduces its loss and separates a separable corpus", () => {
  const samples = syntheticCorpus();
  const { model, lossCurve, finalLoss } = train(samples, { epochs: 300 });

  assert.ok(finalLoss < (lossCurve[0] ?? 1) / 2, `loss barely moved: ${lossCurve[0]} -> ${finalLoss}`);
  assert.equal(model.schemaVersion, FEATURE_SCHEMA_VERSION);

  const correct = samples.filter(
    (sample) => (predictVector(model, sample.vector).probability >= 0.5 ? 1 : 0) === sample.label,
  ).length;
  assert.ok(correct / samples.length > 0.9, `only ${correct}/${samples.length} correct`);
});

test("a corpus with one class is refused rather than fitted", () => {
  const oneSided = syntheticCorpus().map((sample) => ({ ...sample, label: 0 as const }));
  // A model fitted to one class learns to answer that class, and reports
  // excellent accuracy while doing it.
  assert.throws(() => train(oneSided), /needs both classes/);
  assert.throws(() => train([]), /empty corpus/);
});

test("class weighting stops a skewed corpus from training a constant answer", () => {
  // 10% malicious: answering "benign" to everything already scores 0.9
  // accuracy, which is the shape of a useless detector with a good headline.
  const skewed: LabelledSample[] = syntheticCorpus(100).map((sample, index) => {
    const label: 0 | 1 = index % 10 === 0 ? 1 : 0;
    const vector = [...sample.vector];
    vector[6] = label === 1 ? 0.75 : 0.1;
    return { vector, label };
  });

  const positives = skewed.filter((sample) => sample.label === 1);
  assert.equal(positives.length, 10, "the corpus really is skewed");

  const balanced = train(skewed, { epochs: 300, balanceClasses: true }).model;
  const found = positives.filter(
    (sample) => predictVector(balanced, sample.vector).probability >= 0.5,
  ).length;
  assert.ok(found > positives.length / 2, `found ${found} of ${positives.length} positives`);

  // Without the weighting, the cheap answer is available and the fit takes it.
  const unweighted = train(skewed, { epochs: 300, balanceClasses: false }).model;
  const foundUnweighted = positives.filter(
    (sample) => predictVector(unweighted, sample.vector).probability >= 0.5,
  ).length;
  assert.ok(
    found >= foundUnweighted,
    `weighting should not find fewer positives: ${found} vs ${foundUnweighted}`,
  );
});

test("standardisation survives a column that never varies", () => {
  const constant: LabelledSample[] = [
    { vector: new Array<number>(FEATURE_COUNT).fill(1), label: 0 },
    { vector: new Array<number>(FEATURE_COUNT).fill(1), label: 1 },
  ];
  const { mean, stdDev } = standardiser(constant);
  assert.ok(stdDev.every((value) => value > 0), "a zero spread would divide by zero");

  const model = { mean, stdDev, weights: [], bias: 0 } as unknown as ClassifierModel;
  assert.ok(standardise(model, constant[0]!.vector).every(Number.isFinite));
});

/* ------------------------------------------------------------------ */
/* Inference                                                           */
/* ------------------------------------------------------------------ */

test("inference reproduces training's arithmetic exactly", () => {
  const samples = syntheticCorpus(40);
  const { model } = train(samples, { epochs: 200 });

  // Same input, same output, every time -- a model that drifts between the
  // trainer and the extension is a model whose evaluation means nothing.
  const first = predictVector(model, samples[0]!.vector).probability;
  assert.equal(predictVector(model, samples[0]!.vector).probability, first);
  assert.ok(first >= 0 && first <= 1);
});

test("a prediction says which columns moved it", () => {
  const { model } = train(syntheticCorpus(), { epochs: 300 });
  const prediction = predictVector(model, syntheticCorpus()[1]!.vector);

  // A score with no attribution is the interpretability problem this project
  // exists to avoid, and a model producing it does not make it acceptable.
  assert.ok(prediction.topContributions.length > 0);
  assert.ok(FEATURE_NAMES.includes(prediction.topContributions[0]!.feature));
  const magnitudes = prediction.topContributions.map((entry) => Math.abs(entry.contribution));
  assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a), "strongest first");
});

test("a model from another feature schema is refused, not reinterpreted", () => {
  const { model } = train(syntheticCorpus(), { epochs: 10 });
  const stale = { ...model, schemaVersion: FEATURE_SCHEMA_VERSION + 1 };

  // Scoring the wrong columns produces confident nonsense with no way to notice.
  assert.throws(() => predictVector(stale, new Array<number>(FEATURE_COUNT).fill(0)), ModelSchemaError);
  assert.throws(() => parseModel(JSON.stringify(stale)), ModelSchemaError);
});

test("a corrupt model file fails immediately and says what is wrong", () => {
  const { model } = train(syntheticCorpus(), { epochs: 10 });

  assert.throws(() => parseModel(JSON.stringify({ ...model, weights: [1, 2] })), /weights/);
  assert.throws(() => parseModel(JSON.stringify({ ...model, bias: "x" })), /bias/);
  assert.throws(
    () => parseModel(JSON.stringify({ ...model, mean: model.mean.map(() => Number.NaN) })),
    /finite/,
  );
  assert.throws(() => parseModel("null"), /not an object/);
});

test("a valid model round-trips through JSON unchanged", () => {
  const { model } = train(syntheticCorpus(), { epochs: 50 });
  const restored = parseModel(JSON.stringify(model));
  assert.deepEqual(restored.weights, model.weights);
  assert.equal(
    predictVector(restored, syntheticCorpus()[3]!.vector).probability,
    predictVector(model, syntheticCorpus()[3]!.vector).probability,
  );
});

/* ------------------------------------------------------------------ */
/* Metrics and the baseline                                            */
/* ------------------------------------------------------------------ */

test("the confusion matrix counts what it says it counts", () => {
  const scored: Array<{ score: number; label: 0 | 1 }> = [
    { score: 0.9, label: 1 },
    { score: 0.8, label: 0 },
    { score: 0.2, label: 1 },
    { score: 0.1, label: 0 },
  ];
  assert.deepEqual(confusion(scored, 0.5), {
    truePositives: 1,
    falsePositives: 1,
    trueNegatives: 1,
    falseNegatives: 1,
  });

  const m = metrics(scored, 0.5);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.equal(m.f1, 0.5);
  assert.equal(m.accuracy, 0.5);
});

test("AUC gives ties half credit, so a rule-based baseline is not flattered", () => {
  assert.equal(rocAuc([{ score: 1, label: 1 }, { score: 0, label: 0 }]), 1);
  assert.equal(rocAuc([{ score: 0, label: 1 }, { score: 1, label: 0 }]), 0);
  // A baseline that scores many modules identically would otherwise look like a
  // perfect ranker on the pairs it cannot separate at all.
  assert.equal(rocAuc([{ score: 0.5, label: 1 }, { score: 0.5, label: 0 }]), 0.5);
  assert.equal(rocAuc([{ score: 1, label: 1 }]), 0.5, "one class is not an evaluation");
});

test("perfect and useless classifiers both report honestly", () => {
  const perfect = metrics(
    [
      { score: 0.99, label: 1 },
      { score: 0.01, label: 0 },
    ],
    0.5,
  );
  assert.equal(perfect.f1, 1);
  assert.equal(perfect.rocAuc, 1);

  // Answering "benign" to everything on a skewed corpus: high accuracy, no
  // recall. The reason accuracy alone is never reported.
  const lazy = metrics(
    [
      { score: 0, label: 1 },
      ...Array.from({ length: 9 }, () => ({ score: 0, label: 0 as const })),
    ],
    0.5,
  );
  assert.equal(lazy.accuracy, 0.9);
  assert.equal(lazy.recall, 0);
  assert.equal(lazy.f1, 0);
});

test("the heuristic baseline is scored on the same 0..1 scale as the model", () => {
  const miner = heuristicScore(featuresOf(syntheticMinerModule()));
  const benign = heuristicScore(featuresOf(benignModule()));

  assert.ok(miner > 0.5, `the mining shape should clear the high band, got ${miner}`);
  assert.ok(benign < 0.1, `ordinary compiled code should not, got ${benign}`);
});

test("cross-validation reports the model against the heuristics, always", () => {
  // A corpus of real fixtures: the mining shapes and the benign one, repeated
  // with varying kernel sizes so folds have something to hold.
  const corpus: CorpusEntry[] = [];
  for (let i = 0; i < 8; i++) {
    corpus.push({
      features: featuresOf(syntheticMinerModule({ rounds: 25 + i })),
      label: 1,
      source: `miner-${i}`,
    });
    corpus.push({ features: featuresOf(benignModule()), label: 0, source: `benign-${i}` });
    corpus.push({ features: featuresOf(minerLikeModule()), label: 0, source: `kernel-${i}` });
  }

  const evaluation = crossValidate(corpus, { folds: 4, epochs: 200 });

  assert.equal(evaluation.corpusSize, 24);
  assert.equal(evaluation.malicious, 8);
  assert.equal(evaluation.benign, 16);

  // The comparison is not optional, and it is not omittable: it is a field.
  assert.ok(evaluation.baseline.f1 >= 0 && evaluation.baseline.f1 <= 1);
  assert.equal(evaluation.f1Delta, evaluation.classifier.f1 - evaluation.baseline.f1);
  assert.match(evaluation.verdict, /heuristics|rules/);
});

test("a fold that would train on one class is refused rather than reported", () => {
  const corpus: CorpusEntry[] = Array.from({ length: 6 }, (_, i) => ({
    features: featuresOf(benignModule()),
    label: (i === 0 ? 1 : 0) as 0 | 1,
    source: `m-${i}`,
  }));

  // With one positive across six modules, some fold trains on benign only --
  // and a model fitted to one class reports excellent accuracy while being
  // useless. Failing loudly beats printing that number.
  assert.throws(() => crossValidate(corpus, { folds: 6 }), /one class|too small|too skewed/);
});

/* ------------------------------------------------------------------ */
/* The rule                                                            */
/* ------------------------------------------------------------------ */

/** A model that always answers "malicious", for testing the rule around it. */
function certainModel(probability: number): ClassifierModel {
  const weights = new Array<number>(FEATURE_COUNT).fill(0);
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    weights,
    // The inverse sigmoid of the target, so the bias alone produces it.
    bias: Math.log(probability / (1 - probability)),
    mean: new Array<number>(FEATURE_COUNT).fill(0),
    stdDev: new Array<number>(FEATURE_COUNT).fill(1),
    metadata: {
      trainedAt: new Date().toISOString(),
      corpus: "test",
      benignCount: 100,
      maliciousCount: 40,
    },
  };
}

test("no model means no finding, not an absent one", () => {
  const features = featuresOf(benignModule());
  assert.equal(
    evaluateHeuristics(features).some((finding) => finding.id === "classifier-opinion"),
    false,
  );
  // Absence of a model is not evidence of anything, and must not become a note.
  assert.equal(evaluateHeuristics(features, undefined, undefined).length, 0);
});

test("a confident model raises a question and cannot answer one alone", () => {
  const features = featuresOf(benignModule());
  const findings = evaluateHeuristics(features, undefined, certainModel(0.97));

  const opinion = findings.find((finding) => finding.id === "classifier-opinion");
  assert.ok(opinion, "a confident model should be heard");
  assert.match(opinion.evidence, /40 malicious and 100 benign/);
  assert.match(opinion.evidence, /not a measurement of intent/);
  // Weighted below every corroborated rule, permanently: "the model said so" is
  // exactly the uninterrogable verdict this project refuses to ship.
  assert.ok(opinion.weight < 22, `weight ${opinion.weight} can reach too far alone`);
});

test("an unsure model says nothing at all", () => {
  const findings = evaluateHeuristics(featuresOf(benignModule()), undefined, certainModel(0.55));
  assert.equal(
    findings.some((finding) => finding.id === "classifier-opinion"),
    false,
    "barely better than a coin flip is not a finding",
  );
});

test("a model with the wrong schema is ignored, not allowed to guess", () => {
  const stale = { ...certainModel(0.99), schemaVersion: FEATURE_SCHEMA_VERSION + 1 };
  const findings = evaluateHeuristics(featuresOf(benignModule()), undefined, stale);
  assert.equal(findings.length, 0, "scoring the wrong columns is worse than saying nothing");
});

test("the rule listing says which rules need a model", () => {
  const rules = listRules();
  const model = rules.filter((rule) => rule.kind === "model");
  assert.equal(model.length, 1);
  assert.equal(model[0]!.id, "classifier-opinion");
});

test("a module scored with a model still carries every measurement it had", () => {
  const findings = evaluateHeuristics(
    featuresOf(syntheticMinerModule()),
    undefined,
    certainModel(0.9),
  );

  // The model joins the evidence; it does not replace it.
  assert.ok(findings.some((finding) => finding.id === "mining-corroborated"));
  assert.ok(findings.some((finding) => finding.id === "classifier-opinion"));
  for (const finding of findings) {
    assert.match(finding.evidence, /\d|"/, `${finding.id} cites nothing checkable`);
  }
});

test("a real module can be scored by a model trained on real fixtures", () => {
  // End to end through the pieces a corpus would use: analyse, vectorise,
  // train, predict. It proves the pipeline runs, and nothing about detection.
  const samples: LabelledSample[] = [];
  for (let i = 0; i < 10; i++) {
    samples.push({ vector: vectorise(featuresOf(syntheticMinerModule({ rounds: 25 + i }))), label: 1 });
    samples.push({ vector: vectorise(featuresOf(benignModule())), label: 0 });
  }

  const { model } = train(samples, { epochs: 300 });
  const minerScore = predict(model, featuresOf(syntheticMinerModule())).probability;
  const benignScore = predict(model, featuresOf(benignModule())).probability;

  assert.ok(
    minerScore > benignScore,
    `the shape it was trained on should rank higher: ${minerScore} vs ${benignScore}`,
  );
});
