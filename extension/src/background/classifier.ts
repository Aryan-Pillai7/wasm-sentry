/**
 * Loading the classifier, if there is one.
 *
 * **No model ships with this extension.** Training one honestly needs a
 * labelled corpus of benign and verified-malicious modules that this project
 * does not have, and a model trained on anything less would produce confident
 * numbers with nothing behind them -- which is the failure this whole codebase
 * has been built to avoid.
 *
 * So this is the socket rather than the plug. Drop a `model.json` produced by
 * `npm run train -w @wasm-sentry/core` into `extension/public/`, rebuild, and
 * the `classifier-opinion` rule starts contributing. Without one, every path
 * here returns `undefined` and the rules behave exactly as they did before the
 * classifier existed.
 *
 * The result is cached for the life of the service worker, including the
 * "there isn't one" answer: MV3 kills the worker every thirty seconds or so,
 * and re-fetching a file that is not there on every single capture would be a
 * silly way to spend that lifetime.
 */
import { parseModel, modelVersion } from "@wasm-sentry/core";
import type { ClassifierModel } from "@wasm-sentry/core";

const MODEL_PATH = "model.json";

export interface LoadDeps {
  /** Resolves the packaged path to a URL. Injected so this is testable. */
  getURL: (path: string) => string;
  fetchImpl: typeof fetch;
}

/**
 * `undefined` once we know there is no usable model; `null` while we have not
 * looked. The distinction is what stops a missing file being re-fetched
 * forever.
 */
let cached: ClassifierModel | undefined | null = null;

let cachedVersionHash: string | null = null;

/** Forget what we learned. Only used by tests. */
export function resetClassifierCache(): void {
  cached = null;
  cachedVersionHash = null;
}

export async function loadClassifier(deps: LoadDeps): Promise<ClassifierModel | undefined> {
  if (cached !== null) return cached;

  try {
    const response = await deps.fetchImpl(deps.getURL(MODEL_PATH));
    if (!response.ok) {
      cached = undefined;
      return undefined;
    }

    const model = parseModel(await response.text());
    console.log(
      `[wasm-sentry] classifier loaded: trained on ${model.metadata.maliciousCount} malicious ` +
        `and ${model.metadata.benignCount} benign modules (${model.metadata.corpus})`,
    );
    cached = model;
    return model;
  } catch (error) {
    // A missing file is the normal case and says nothing. A malformed or
    // stale-schema one is worth a warning, because somebody put it there on
    // purpose and it is not being used -- silently ignoring it would leave them
    // believing the classifier was running.
    if (error instanceof Error && !/fetch|network|not found/i.test(error.message)) {
      console.warn(`[wasm-sentry] a model.json is present but unusable: ${error.message}`);
    }
    cached = undefined;
    return undefined;
  }
}

/**
 * `modelVersion()` of whatever `loadClassifier` resolved to, cached the same
 * way and for the same reason: hashing is cheap once, not worth repeating on
 * every capture for a model that cannot have changed mid-lifetime. Resolves
 * to `undefined` exactly when `loadClassifier` would, so a caller can await
 * both and know the second is meaningless without checking the first.
 */
export async function loadClassifierVersion(deps: LoadDeps): Promise<string | undefined> {
  const model = await loadClassifier(deps);
  if (model === undefined) return undefined;
  if (cachedVersionHash === null) cachedVersionHash = await modelVersion(model);
  return cachedVersionHash;
}
