/**
 * The JavaScript analysis entry point.
 *
 * Mirrors `analyzeWasm`: bytes in, a structured result out, and it never
 * throws -- a script that cannot be analysed is a result, not an exception,
 * because a thrown error inside a message handler is a capture silently lost.
 *
 * What it produces feeds the same `assessRisk` the WebAssembly side uses, so a
 * page's Privacy Scorecard covers both without a second scoring system that
 * could disagree with the first.
 */
import { evaluateJsHeuristics, evaluateScriptInventory } from "./heuristics.js";
import { extractJsFeatures } from "./features.js";
import type { JsFeatures, ScriptReference } from "./features.js";
import { assessRisk } from "../scoring.js";
import type { RiskAssessment } from "../scoring.js";

/**
 * Scripts above this are measured but not scanned in full.
 *
 * The regular expressions here are linear in the source, but a 20 MB bundle
 * still costs real time in a service worker that is killed after thirty
 * seconds idle. The head of a file is where a loader lives; a payload hidden at
 * the end of a 20 MB bundle is a miss, and `truncated` says so rather than
 * letting the result imply a clean scan.
 */
export const MAX_SCANNED_CHARS = 4 * 1024 * 1024;

export interface JsAnalysis {
  ok: true;
  features: JsFeatures;
  risk: RiskAssessment;
  /** True when only the first `MAX_SCANNED_CHARS` were examined. */
  truncated: boolean;
  elapsedMs: number;
}

export interface JsAnalysisFailure {
  ok: false;
  reason: string;
  elapsedMs: number;
}

export type JsAnalysisResult = JsAnalysis | JsAnalysisFailure;

/**
 * Measure and score a piece of JavaScript.
 *
 * Coverage is reported as 1 for a fully scanned script and as the scanned share
 * otherwise, so a partially examined bundle says so in the same field the
 * WebAssembly side uses for the same purpose.
 */
export function analyzeJs(source: string): JsAnalysisResult {
  const started = Date.now();
  try {
    if (source.length === 0) {
      return { ok: false, reason: "empty script", elapsedMs: Date.now() - started };
    }

    const truncated = source.length > MAX_SCANNED_CHARS;
    const scanned = truncated ? source.slice(0, MAX_SCANNED_CHARS) : source;

    const features = extractJsFeatures(scanned);
    // `byteLength` reports the real size even when the scan did not cover it:
    // the size is a fact about the script, not about our effort.
    features.byteLength = source.length;

    const findings = evaluateJsHeuristics(features);
    const coverage = truncated ? MAX_SCANNED_CHARS / source.length : 1;

    return {
      ok: true,
      features,
      risk: assessRisk(findings, coverage),
      truncated,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    };
  }
}

/** Score a page's external scripts from metadata alone. No contents involved. */
export function analyzeScriptInventory(scripts: readonly ScriptReference[]): RiskAssessment {
  return assessRisk(evaluateScriptInventory(scripts), 1);
}

/**
 * The compact, storable form of a JavaScript analysis.
 *
 * The source itself is deliberately not part of it. A script on an
 * authenticated page can carry far more of somebody's private business than a
 * compiled module does, so what is kept is the measurements and the verdict --
 * enough to explain the finding, and not enough to reconstruct the code.
 */
export interface JsArtifactAnalysis {
  hash: string;
  analyzedAt: number;
  elapsedMs: number;
  ok: boolean;
  reason?: string;
  byteLength?: number;
  truncated?: boolean;
  risk?: RiskAssessment;
  /** A handful of measurements, for the reader who wants to check the finding. */
  summary?: {
    lineCount: number;
    maxLineLength: number;
    escapeDensity: number;
    entropy: number;
    base64Literals: number;
    evalSites: number;
    webAssemblyCalls: number;
    workerConstructions: number;
    webSocketConstructions: number;
  };
}

export function summariseJs(hash: string, result: JsAnalysisResult): JsArtifactAnalysis {
  const analyzedAt = Date.now();
  if (!result.ok) {
    return { hash, analyzedAt, elapsedMs: result.elapsedMs, ok: false, reason: result.reason };
  }

  const f = result.features;
  return {
    hash,
    analyzedAt,
    elapsedMs: result.elapsedMs,
    ok: true,
    byteLength: f.byteLength,
    truncated: result.truncated,
    risk: result.risk,
    summary: {
      lineCount: f.lineCount,
      maxLineLength: f.maxLineLength,
      escapeDensity: Number(f.escapeDensity.toFixed(5)),
      entropy: Number(f.entropy.toFixed(2)),
      base64Literals: f.base64Literals,
      evalSites: f.api.eval + f.api.functionConstructor + f.api.setIntervalString,
      webAssemblyCalls: f.api.webAssembly,
      workerConstructions: f.api.worker,
      webSocketConstructions: f.api.webSocket,
    },
  };
}
