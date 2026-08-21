/**
 * The compact, storable form of a static analysis.
 *
 * `StaticAnalysis` holds the parsed module and every per-function row, which is
 * the right shape to compute with and the wrong shape to keep: a 2 MB module
 * produces megabytes of it. This is what actually goes into IndexedDB and
 * across the wire -- bounded, flat, and JSON-serialisable.
 */
import type { StaticAnalysisResult } from "./analysis.js";

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
  hottestLoop: { functionIndex: number; size: number; bitwiseRatio: number } | null;
}

export interface ArtifactAnalysis {
  hash: string;
  analyzedAt: number;
  elapsedMs: number;
  ok: boolean;
  /** Why analysis failed, when `ok` is false. */
  reason?: string;
  summary?: AnalysisSummary;
  /** The module's declared surface as WAT -- what a reviewer reads first. */
  watHeader?: string;
  warnings?: string[];
}

/** Reduce a full analysis to the record that gets stored. */
export function summarise(hash: string, result: StaticAnalysisResult): ArtifactAnalysis {
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
      hottestLoop: f.hottestLoop,
    },
    watHeader: result.watHeader,
    warnings: result.warnings.slice(0, 10),
  };
}
