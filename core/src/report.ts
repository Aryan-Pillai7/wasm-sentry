/**
 * The compact, storable form of a static analysis.
 *
 * `StaticAnalysis` holds the parsed module and every per-function row, which is
 * the right shape to compute with and the wrong shape to keep: a 2 MB module
 * produces megabytes of it. This is what actually goes into IndexedDB and
 * across the wire -- bounded, flat, and JSON-serialisable.
 */
import type { StaticAnalysisResult } from "./analysis.js";
import type { KernelCandidate } from "./wasm/features.js";
import { evaluateHeuristics, RULESET_VERSION } from "./heuristics.js";
import type { RuntimeFeatures } from "./runtime.js";
import type { ClassifierModel } from "./ml/model.js";
import { assessRisk, coverageOf } from "./scoring.js";
import type { RiskAssessment } from "./scoring.js";

/** How many import/export names to retain. Enough to characterise, not to store. */
const MAX_NAMES = 40;

export interface AnalysisSummary {
  functionCount: number;
  importedFunctionCount: number;
  instructionCount: number;
  totalLoops: number;
  maxNesting: number;
  totalBackEdges: number;
  bitwiseRatio: number;
  floatRatio: number;
  indirectCalls: number;
  memoryGrowSites: number;
  memoryInitialPages: number;
  memoryMaxPages: number | null;
  memoryShared: boolean;
  dataSectionBytes: number;
  stripped: boolean;
  truncatedFunctions: number;
  skippedFunctions: number;
  importNames: string[];
  exportNames: string[];
  kernelCandidate: KernelCandidate | null;
}

export interface ArtifactAnalysis {
  hash: string;
  analyzedAt: number;
  elapsedMs: number;
  ok: boolean;
  /** Why analysis failed, when `ok` is false. */
  reason?: string;
  /**
   * Which `RULESET_VERSION` produced `risk`, so a stored verdict can be told
   * apart from one a newer set of rules would compute. Present whenever
   * `risk` is: the two are set together or not at all.
   */
  rulesetVersion?: number;
  /**
   * Content hash of the classifier model that contributed to `risk`, from
   * `modelVersion()`. Absent when no model was loaded for this analysis --
   * which is the honest default today, since none is shipped yet -- and
   * absence here means exactly that, not "unknown."
   */
  modelVersion?: string;
  summary?: AnalysisSummary;
  /** Heuristic verdict with the evidence that produced it. */
  risk?: RiskAssessment;
  /** The module's declared surface as WAT -- what a reviewer reads first. */
  watHeader?: string;
  warnings?: string[];
  /**
   * What the module was observed doing, once it has been watched long enough.
   * Absent until then, which is the usual case: a verdict is produced the
   * moment a module is captured, seconds before it has behaved at all.
   */
  runtime?: RuntimeFeatures;
}

/**
 * Reduce a full analysis to the record that gets stored.
 *
 * Runtime evidence, when there is any, is folded into the same rule pass rather
 * than bolted on afterwards. Re-running the whole assessment is what lets
 * `mining-runtime-corroborated` see the static kernel and the measured
 * execution together, which is the finding this entire phase exists to produce.
 */
export function summarise(
  hash: string,
  result: StaticAnalysisResult,
  runtime?: RuntimeFeatures,
  model?: ClassifierModel,
  /**
   * `modelVersion(model)`, computed once by the caller when the model was
   * loaded and passed in here rather than recomputed per call -- hashing is
   * async and this function is not, deliberately, since it runs on every
   * capture and callers up and down the stack call it synchronously.
   */
  modelVersionHash?: string,
): ArtifactAnalysis {
  const analyzedAt = Date.now();
  if (!result.ok) {
    return { hash, analyzedAt, elapsedMs: result.elapsedMs, ok: false, reason: result.reason };
  }

  const f = result.features;
  const findings = evaluateHeuristics(f, runtime, model);
  const risk = assessRisk(findings, coverageOf(f));

  return {
    hash,
    analyzedAt,
    elapsedMs: result.elapsedMs,
    ok: true,
    rulesetVersion: RULESET_VERSION,
    ...(model !== undefined && modelVersionHash !== undefined ? { modelVersion: modelVersionHash } : {}),
    risk,
    summary: {
      functionCount: f.functionCount,
      importedFunctionCount: f.importedFunctionCount,
      instructionCount: f.instructionCount,
      totalLoops: f.totalLoops,
      maxNesting: f.maxNesting,
      totalBackEdges: f.totalBackEdges,
      bitwiseRatio: f.bitwiseRatio,
      floatRatio: f.floatRatio,
      indirectCalls: f.indirectCalls,
      memoryGrowSites: f.memoryGrowSites,
      memoryInitialPages: f.memoryInitialPages,
      memoryMaxPages: f.memoryMaxPages,
      memoryShared: f.memoryShared,
      dataSectionBytes: f.dataSectionBytes,
      stripped: f.stripped,
      truncatedFunctions: f.truncatedFunctions,
      skippedFunctions: f.skippedFunctions,
      importNames: f.importNames.slice(0, MAX_NAMES),
      exportNames: f.exportNames.slice(0, MAX_NAMES),
      kernelCandidate: f.kernelCandidate,
    },
    watHeader: result.watHeader,
    warnings: result.warnings.slice(0, 10),
    ...(runtime !== undefined ? { runtime } : {}),
  };
}
