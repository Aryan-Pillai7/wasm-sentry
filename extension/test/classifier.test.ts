import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadClassifier, resetClassifierCache } from "../src/background/classifier";
import { FEATURE_COUNT, FEATURE_SCHEMA_VERSION } from "@wasm-sentry/core";

/**
 * No model ships with this extension, so the case that matters most is the one
 * where there is nothing to load: it has to be silent, cheap, and leave the
 * rules behaving exactly as they did before the classifier existed.
 */

function validModel(): Record<string, unknown> {
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    weights: new Array<number>(FEATURE_COUNT).fill(0.1),
    bias: -1,
    mean: new Array<number>(FEATURE_COUNT).fill(0),
    stdDev: new Array<number>(FEATURE_COUNT).fill(1),
    metadata: {
      trainedAt: "2026-01-01T00:00:00.000Z",
      corpus: "test",
      benignCount: 200,
      maliciousCount: 50,
    },
  };
}

function responder(body: string, ok = true) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return { ok, text: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const getURL = (path: string): string => `chrome-extension://test/${path}`;

beforeEach(() => resetClassifierCache());

test("no packaged model means no model, quietly", async () => {
  const { fetchImpl } = responder("", false);
  assert.equal(await loadClassifier({ getURL, fetchImpl }), undefined);
});

test("a packaged model is loaded and its provenance kept", async () => {
  const { fetchImpl } = responder(JSON.stringify(validModel()));
  const model = await loadClassifier({ getURL, fetchImpl });

  assert.ok(model);
  assert.equal(model.metadata.maliciousCount, 50);
  assert.equal(model.weights.length, FEATURE_COUNT);
});

test("the absence of a model is cached as hard as its presence", async () => {
  const missing = responder("", false);
  await loadClassifier({ getURL, fetchImpl: missing.fetchImpl });
  await loadClassifier({ getURL, fetchImpl: missing.fetchImpl });
  await loadClassifier({ getURL, fetchImpl: missing.fetchImpl });

  // MV3 kills this worker every thirty seconds; re-fetching a file that is not
  // there on every capture would be a silly way to spend that lifetime.
  assert.equal(missing.calls(), 1);

  resetClassifierCache();
  const present = responder(JSON.stringify(validModel()));
  await loadClassifier({ getURL, fetchImpl: present.fetchImpl });
  await loadClassifier({ getURL, fetchImpl: present.fetchImpl });
  assert.equal(present.calls(), 1);
});

test("a malformed model is refused rather than scored with", async () => {
  const { fetchImpl } = responder('{"weights": [1, 2, 3]}');
  assert.equal(await loadClassifier({ getURL, fetchImpl }), undefined);
});

test("a model from a different feature schema is refused", async () => {
  // Scoring the wrong columns produces confident nonsense with no way to notice
  // from the output, so a stale model is not used at all.
  const stale = { ...validModel(), schemaVersion: FEATURE_SCHEMA_VERSION + 1 };
  const { fetchImpl } = responder(JSON.stringify(stale));
  assert.equal(await loadClassifier({ getURL, fetchImpl }), undefined);
});

test("a fetch that throws is not an error the capture path has to handle", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  assert.equal(await loadClassifier({ getURL, fetchImpl }), undefined);
});
