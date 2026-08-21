/**
 * The static analysis entry point: bytes in, structured findings out.
 *
 * Everything here is synchronous and allocation-bounded so it can run inside a
 * service worker without a keepalive, and identically inside Node for tests and
 * batch evaluation.
 */
import { extractFeatures } from "./wasm/features.js";
import type { ExtractOptions, ModuleFeatures } from "./wasm/features.js";
import { parseModule } from "./wasm/module.js";
import type { WasmModule } from "./wasm/module.js";
import { moduleToWatHeader } from "./wasm/wat.js";
import { isWasm } from "./sniff.js";

export interface StaticAnalysis {
  ok: true;
  module: WasmModule;
  features: ModuleFeatures;
  /** The module's declared surface, rendered as WAT. */
  watHeader: string;
  /** Sections that did not parse cleanly. */
  warnings: string[];
  /** Wall-clock cost of the analysis, in milliseconds. */
  elapsedMs: number;
}

export interface StaticAnalysisFailure {
  ok: false;
  reason: string;
  elapsedMs: number;
}

export type StaticAnalysisResult = StaticAnalysis | StaticAnalysisFailure;

/**
 * Parse and characterise a WebAssembly module.
 *
 * Never throws: a module that cannot be parsed is a result, not an exception.
 * Analysing hostile input is the job, and a thrown error inside a service worker
 * message handler is a capture silently lost.
 */
export function analyzeWasm(bytes: Uint8Array, options: ExtractOptions = {}): StaticAnalysisResult {
  const started = Date.now();
  try {
    if (!isWasm(bytes)) {
      return { ok: false, reason: "not a WebAssembly module", elapsedMs: Date.now() - started };
    }
    const module = parseModule(bytes);
    const features = extractFeatures(module, options);
    return {
      ok: true,
      module,
      features,
      watHeader: moduleToWatHeader(module),
      warnings: module.warnings,
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
