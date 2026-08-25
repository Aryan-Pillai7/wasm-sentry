/**
 * Feature extraction.
 *
 * Turns a decoded module into the fixed-shape numeric summary that the
 * heuristics read and, later, the classifier trains on. Both consumers get the
 * same vector from the same code path, so a rule and a model can never disagree
 * about what they were shown.
 *
 * The categories are chosen for what distinguishes a mining kernel from
 * ordinary compiled code: mining is integer and bitwise work in a tight,
 * shallow loop with almost no floating point and little I/O, whereas a codec or
 * a physics engine spreads its work across float arithmetic, many call sites and
 * a much larger surface of exported functions.
 */
import { buildCfg } from "./cfg.js";
import type { Cfg } from "./cfg.js";
import { decodeExpression } from "./decode.js";
import type { Instruction } from "./decode.js";
import { Reader } from "./reader.js";
import { importedFunctionCount } from "./module.js";
import type { WasmModule } from "./module.js";

export type OpcodeCategory =
  | "control"
  | "call"
  | "variable"
  | "memory"
  | "integer"
  | "bitwise"
  | "float"
  | "simd"
  | "atomic"
  | "reference"
  | "other";

/** Integer operations that dominate hashing inner loops. */
const BITWISE = new Set([
  "and", "or", "xor", "shl", "shr_s", "shr_u", "rotl", "rotr", "clz", "ctz", "popcnt",
]);

const INTEGER_ARITH = new Set(["add", "sub", "mul", "div_s", "div_u", "rem_s", "rem_u"]);

export function categorise(name: string): OpcodeCategory {
  if (name.startsWith("v128.") || name.startsWith("i8x16.") || name.startsWith("i16x8.")) return "simd";
  if (name.startsWith("i32x4.") || name.startsWith("i64x2.") || name.startsWith("f32x4.")) return "simd";
  if (name.startsWith("f64x2.")) return "simd";
  if (name.includes("atomic")) return "atomic";
  if (name.startsWith("ref.")) return "reference";
  if (name === "call" || name === "call_indirect") return "call";
  if (name.startsWith("local.") || name.startsWith("global.")) return "variable";
  if (name.startsWith("memory.") || name.startsWith("data.") || name.includes(".load") || name.includes(".store")) {
    return "memory";
  }
  if (name.startsWith("table.") || name.startsWith("elem.")) return "memory";

  const [type, operation] = name.split(".", 2);
  if (operation !== undefined && (type === "i32" || type === "i64")) {
    if (BITWISE.has(operation)) return "bitwise";
    if (INTEGER_ARITH.has(operation)) return "integer";
    return "integer";
  }
  if (type === "f32" || type === "f64") return "float";

  return name === "" ? "other" : "control";
}

export interface FunctionFeatures {
  /** Index among defined functions, excluding imports. */
  index: number;
  typeIndex: number;
  instructionCount: number;
  localCount: number;
  blocks: number;
  loops: number;
  backEdges: number;
  maxNesting: number;
  /** Instructions in the largest loop body. */
  largestLoop: number;
  bitwiseOps: number;
  integerOps: number;
  /** Share of instructions in this function that are bitwise integer work. */
  bitwiseRatio: number;
  /** Share that is integer arithmetic or bitwise work combined. */
  arithmeticRatio: number;
  /** Calls per instruction. A hashing kernel makes almost none. */
  callRatio: number;
  calls: number;
  indirectCalls: number;
  memoryOps: number;
  floatOps: number;
  /** Present when the body could not be fully decoded. */
  truncated?: string;
}

/** A function whose shape is consistent with a compute kernel. */
export interface KernelCandidate {
  functionIndex: number;
  /** Instructions in its largest loop. */
  loopSize: number;
  instructionCount: number;
  bitwiseRatio: number;
  arithmeticRatio: number;
  callRatio: number;
}

/**
 * Structural filter for kernel candidates.
 *
 * A hashing inner loop is register arithmetic and nothing else: no calls out,
 * no floating point. These bounds exclude the bulk of compiled code without
 * making any claim about what the survivors are -- that judgement belongs to
 * the heuristics, which have the corroborating signals to make it.
 */
const KERNEL_MIN_LOOP = 40;
const KERNEL_MAX_CALL_RATIO = 0.02;

export interface ModuleFeatures {
  byteLength: number;
  version: number;
  functionCount: number;
  importedFunctionCount: number;
  exportCount: number;
  /** `module.name` pairs, which is the clearest statement of what a module wants. */
  importNames: string[];
  exportNames: string[];
  memoryInitialPages: number;
  memoryMaxPages: number | null;
  memoryShared: boolean;
  dataSectionBytes: number;
  customSectionNames: string[];
  /** True when the module ships no name section -- i.e. it has been stripped. */
  stripped: boolean;

  instructionCount: number;
  opcodeCounts: Record<string, number>;
  categoryCounts: Record<OpcodeCategory, number>;
  /** Share of all decoded instructions that are bitwise integer work. */
  bitwiseRatio: number;
  floatRatio: number;

  totalLoops: number;
  maxNesting: number;
  totalBackEdges: number;
  indirectCalls: number;
  memoryGrowSites: number;

  decodedFunctions: number;
  truncatedFunctions: number;
  /** Functions skipped because the analysis budget ran out. */
  skippedFunctions: number;

  /**
   * The function most consistent with a hashing kernel, if any qualifies.
   *
   * Selected by arithmetic density among functions that pass a structural
   * filter, not by loop size. Ranking by size alone just finds the biggest
   * function in the module -- on real Rust output that is a 53,000-instruction
   * dispatch loop at 4% bitwise, which tells you nothing.
   */
  kernelCandidate: KernelCandidate | null;

  functions: FunctionFeatures[];
}

export interface ExtractOptions {
  /** Stop decoding after this many instructions across the whole module. */
  instructionBudget?: number;
  /** Keep per-function rows only for this many functions. */
  maxFunctionRows?: number;
}

const DEFAULT_BUDGET = 2_000_000;
const DEFAULT_FUNCTION_ROWS = 2_000;

function emptyCategories(): Record<OpcodeCategory, number> {
  return {
    control: 0, call: 0, variable: 0, memory: 0, integer: 0, bitwise: 0,
    float: 0, simd: 0, atomic: 0, reference: 0, other: 0,
  };
}

function summariseFunction(
  index: number,
  typeIndex: number,
  localCount: number,
  instructions: readonly Instruction[],
  cfg: Cfg,
  truncated: string | undefined,
): FunctionFeatures {
  let bitwise = 0;
  let integer = 0;
  let calls = 0;
  let indirectCalls = 0;
  let memoryOps = 0;
  let floatOps = 0;

  for (const instruction of instructions) {
    switch (categorise(instruction.name)) {
      case "bitwise": bitwise++; break;
      case "integer": integer++; break;
      case "call":
        calls++;
        if (instruction.name === "call_indirect") indirectCalls++;
        break;
      case "memory": memoryOps++; break;
      case "float": floatOps++; break;
      default: break;
    }
  }

  const largestLoop = cfg.loops.reduce((max, loop) => Math.max(max, loop.size), 0);

  return {
    index,
    typeIndex,
    instructionCount: instructions.length,
    localCount,
    blocks: cfg.blocks.length,
    loops: cfg.loops.length,
    backEdges: cfg.backEdges.length,
    maxNesting: cfg.maxNesting,
    largestLoop,
    bitwiseOps: bitwise,
    integerOps: integer,
    bitwiseRatio: instructions.length > 0 ? bitwise / instructions.length : 0,
    arithmeticRatio: instructions.length > 0 ? (bitwise + integer) / instructions.length : 0,
    callRatio: instructions.length > 0 ? calls / instructions.length : 0,
    calls,
    indirectCalls,
    memoryOps,
    floatOps,
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

/** Decode every function body within budget and reduce it to a feature vector. */
export function extractFeatures(module: WasmModule, options: ExtractOptions = {}): ModuleFeatures {
  const budget = options.instructionBudget ?? DEFAULT_BUDGET;
  const maxRows = options.maxFunctionRows ?? DEFAULT_FUNCTION_ROWS;

  const opcodeCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  const categoryCounts = emptyCategories();
  const functions: FunctionFeatures[] = [];

  let instructionCount = 0;
  let decodedFunctions = 0;
  let truncatedFunctions = 0;
  let skippedFunctions = 0;
  let totalLoops = 0;
  let totalBackEdges = 0;
  let maxNesting = 0;
  let indirectCalls = 0;
  let memoryGrowSites = 0;
  let kernelCandidate: KernelCandidate | null = null;

  for (const entry of module.code) {
    if (instructionCount >= budget) {
      skippedFunctions++;
      continue;
    }

    const reader = new Reader(module.bytes, entry.bodyStart);
    const { instructions, truncated } = decodeExpression(reader, entry.bodyEnd, budget - instructionCount);
    decodedFunctions++;
    if (truncated !== undefined) truncatedFunctions++;

    for (const instruction of instructions) {
      instructionCount++;
      opcodeCounts[instruction.name] = (opcodeCounts[instruction.name] ?? 0) + 1;
      categoryCounts[categorise(instruction.name)]++;
      if (instruction.name === "memory.grow") memoryGrowSites++;
    }

    const cfg = buildCfg(instructions);
    const features = summariseFunction(
      entry.index,
      entry.typeIndex,
      entry.localCount,
      instructions,
      cfg,
      truncated,
    );

    totalLoops += features.loops;
    totalBackEdges += features.backEdges;
    maxNesting = Math.max(maxNesting, features.maxNesting);
    indirectCalls += features.indirectCalls;

    const qualifies =
      features.largestLoop >= KERNEL_MIN_LOOP &&
      features.floatOps === 0 &&
      features.callRatio < KERNEL_MAX_CALL_RATIO;

    // Rank by density, breaking ties on loop size. The reverse -- size first --
    // selects the largest function in the module regardless of what it does.
    if (
      qualifies &&
      (kernelCandidate === null ||
        features.bitwiseRatio > kernelCandidate.bitwiseRatio ||
        (features.bitwiseRatio === kernelCandidate.bitwiseRatio &&
          features.largestLoop > kernelCandidate.loopSize))
    ) {
      kernelCandidate = {
        functionIndex: entry.index,
        loopSize: features.largestLoop,
        instructionCount: features.instructionCount,
        bitwiseRatio: features.bitwiseRatio,
        arithmeticRatio: features.arithmeticRatio,
        callRatio: features.callRatio,
      };
    }

    if (functions.length < maxRows) functions.push(features);
  }

  const memory = module.memories[0] ?? module.imports.find((i) => i.kind === "memory")?.limits;

  return {
    byteLength: module.bytes.length,
    version: module.version,
    functionCount: module.code.length,
    importedFunctionCount: importedFunctionCount(module),
    exportCount: module.exports.length,
    importNames: module.imports.map((entry) => `${entry.module}.${entry.name}`),
    exportNames: module.exports.map((entry) => entry.name),
    memoryInitialPages: memory?.min ?? 0,
    memoryMaxPages: memory?.max ?? null,
    memoryShared: memory?.shared ?? false,
    dataSectionBytes: module.dataSectionBytes,
    customSectionNames: module.customSections.map((section) => section.name),
    stripped: !module.customSections.some((section) => section.name === "name"),

    instructionCount,
    opcodeCounts,
    categoryCounts,
    bitwiseRatio: instructionCount > 0 ? categoryCounts.bitwise / instructionCount : 0,
    floatRatio: instructionCount > 0 ? categoryCounts.float / instructionCount : 0,

    totalLoops,
    maxNesting,
    totalBackEdges,
    indirectCalls,
    memoryGrowSites,

    decodedFunctions,
    truncatedFunctions,
    skippedFunctions,
    kernelCandidate,
    functions,
  };
}
