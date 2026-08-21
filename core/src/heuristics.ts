/**
 * Heuristic detection.
 *
 * Rules over the static feature vector, each one producing evidence with the
 * numbers that triggered it rather than a bare verdict. That constraint is the
 * point: the drawback these rules exist to answer is that existing tools return
 * "malicious" with nothing a developer can check, and a finding nobody can
 * interrogate is a finding nobody can act on.
 *
 * Thresholds are calibrated against real compiled output rather than guessed --
 * see `docs/detection.md` for the corpus measurements behind each number. The
 * governing asymmetry is that a false positive on a popular site destroys trust
 * in the tool permanently, while a missed module is caught by the next stage, so
 * every threshold sits well clear of where ordinary compiled code lands.
 */
import type { ModuleFeatures } from "./wasm/features.js";

export type Severity = "info" | "low" | "medium" | "high";

export interface Finding {
  /** Stable rule identifier, safe to key on. */
  id: string;
  title: string;
  severity: Severity;
  /** 0..1. How sure the rule is that its evidence means what it thinks. */
  confidence: number;
  /** Points contributed to the risk score at full confidence. */
  weight: number;
  /** What was actually measured, in numbers the reader can verify. */
  evidence: string;
  /** The literature the rule is drawn from. */
  reference?: string;
}

interface RuleHit {
  confidence: number;
  evidence: string;
}

interface Rule {
  id: string;
  title: string;
  severity: Severity;
  weight: number;
  reference?: string;
  evaluate: (features: ModuleFeatures) => RuleHit | null;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Scale a measurement between a floor and a ceiling into a 0..1 confidence. */
function ramp(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  if (value >= ceiling) return 1;
  return (value - floor) / (ceiling - floor);
}

/**
 * Import and export names used by known browser mining families and the
 * hash primitives they are built on.
 *
 * `argon2` and `scrypt` are deliberately weighted lower than the rest: both are
 * legitimate password-hashing primitives that appear in honest authentication
 * code, so they raise a question rather than answer one.
 */
const MINER_FAMILY = /coinhive|cryptonight|crypto-?loot|jsecoin|webminepool|deepminer|minero|monero|randomx|xmrig|nicehash/i;
const HASH_PRIMITIVE = /argon2|scrypt|keccak|blake2|cryptonight/i;
const SOCKET_HINT = /websocket|\bws\b|socket|stratum|postmessage|onmessage/i;

/**
 * Shared kernel test used by both the density rule and the corroboration rule,
 * so the two can never disagree about whether a kernel is present.
 */
function kernelHit(features: ModuleFeatures): RuleHit | null {
  const kernel = features.kernelCandidate;
  if (!kernel) return null;
  if (kernel.bitwiseRatio < 0.22 || kernel.arithmeticRatio < 0.45) return null;

  const confidence = Math.min(
    ramp(kernel.bitwiseRatio, 0.22, 0.4) * 0.7 + ramp(kernel.loopSize, 40, 400) * 0.3,
    1,
  );
  return {
    confidence,
    evidence:
      `function ${kernel.functionIndex} runs a ${kernel.loopSize}-instruction loop that is ` +
      `${percent(kernel.bitwiseRatio)} shifts, rotates and xors and ${percent(kernel.arithmeticRatio)} ` +
      `integer arithmetic overall, with no floating point and no calls out ` +
      `(compression and checksum routines also take this shape)`,
  };
}

const RULES: Rule[] = [
  {
    id: "known-miner-family",
    title: "Names a known browser mining family",
    severity: "high",
    weight: 45,
    reference: "Silent Spring: Characterizing Cryptojacking in the Wild",
    evaluate: (f) => {
      const names = [...f.importNames, ...f.exportNames, ...f.customSectionNames];
      const matches = names.filter((name) => MINER_FAMILY.test(name));
      if (matches.length === 0) return null;
      return {
        confidence: 0.95,
        evidence: `module references ${matches.slice(0, 4).map((m) => `"${m}"`).join(", ")}`,
      };
    },
  },

  {
    id: "hash-primitive-symbols",
    title: "Exports a hashing primitive by name",
    severity: "low",
    weight: 12,
    evaluate: (f) => {
      const matches = [...f.importNames, ...f.exportNames].filter((n) => HASH_PRIMITIVE.test(n));
      if (matches.length === 0) return null;
      return {
        // Legitimate password hashing looks exactly like this, so the rule
        // raises a question rather than answering one.
        confidence: 0.4,
        evidence: `symbols ${matches.slice(0, 3).map((m) => `"${m}"`).join(", ")} are hash primitives, which also appear in honest password hashing`,
      };
    },
  },

  {
    // Deliberately capped at a weight that cannot on its own reach the "high"
    // band. Measuring real compiled output showed why: a legitimate SVG
    // renderer contains a 631-instruction loop that is 24.5% shifts and xors
    // and 62.9% integer arithmetic, with no calls and no floating point --
    // statically indistinguishable from a hashing kernel. Compression,
    // checksums and image filters all produce this shape. Density is a prior,
    // not a verdict; `mining-corroborated` below is what escalates it, and
    // runtime CPU evidence is what settles it.
    id: "hash-loop-density",
    title: "Tight loop of integer and bitwise arithmetic",
    severity: "medium",
    weight: 22,
    reference: "MINOS: A Lightweight Real-Time Cryptojacking Detection System",
    evaluate: (f) => kernelHit(f),
  },

  {
    id: "mining-corroborated",
    title: "Compute kernel combined with mining infrastructure",
    severity: "high",
    weight: 40,
    reference: "Silent Spring: Characterizing Cryptojacking in the Wild",
    evaluate: (f) => {
      const kernel = kernelHit(f);
      if (!kernel) return null;

      // A kernel is ambiguous. A kernel plus the machinery a miner needs to be
      // worth running -- parallelism across cores, a pool connection, or a
      // module that exists only to run this one loop -- is not.
      const corroboration: string[] = [];
      if (f.memoryShared) corroboration.push("shared memory for worker fan-out");
      if (f.categoryCounts.atomic > 0) corroboration.push(`${f.categoryCounts.atomic} atomic operations`);
      if (f.importNames.some((name) => SOCKET_HINT.test(name))) {
        corroboration.push("a socket or message transport import");
      }
      if (f.exportCount > 0 && f.exportCount <= 3 && f.instructionCount > 2000) {
        corroboration.push(`only ${f.exportCount} exported function(s) over ${f.instructionCount} instructions`);
      }
      if (corroboration.length === 0) return null;

      return {
        confidence: Math.min(kernel.confidence * (0.6 + 0.2 * corroboration.length), 1),
        evidence: `${kernel.evidence}, alongside ${corroboration.join(" and ")}`,
      };
    },
  },

  {
    id: "bitwise-dominant-module",
    title: "Module-wide instruction mix is bitwise integer work",
    severity: "medium",
    weight: 25,
    reference: "Deep-Wasm: Detecting Malicious WebAssembly Binaries via Deep Learning",
    evaluate: (f) => {
      if (f.instructionCount < 200) return null;
      if (f.bitwiseRatio < 0.12) return null;
      // Real compiled applications sit far below this: Emscripten-built SQLite
      // measures 2.8% bitwise, Rust wasm-bindgen output 3.7%.
      const floatPenalty = f.floatRatio > 0.05 ? 0.5 : 1;
      return {
        confidence: ramp(f.bitwiseRatio, 0.12, 0.3) * floatPenalty,
        evidence: `${percent(f.bitwiseRatio)} of ${f.instructionCount} instructions are bitwise integer operations, against ${percent(f.floatRatio)} floating point (ordinary compiled code measures 3-4%)`,
      };
    },
  },

  {
    id: "shared-memory-parallelism",
    title: "Shared memory with atomics, the shape of worker fan-out",
    severity: "medium",
    weight: 15,
    reference: "Silent Spring: Characterizing Cryptojacking in the Wild",
    evaluate: (f) => {
      if (!f.memoryShared) return null;
      const atomics = f.categoryCounts.atomic;
      return {
        confidence: atomics > 0 ? 0.7 : 0.35,
        evidence: `memory is declared shared with ${atomics} atomic operations, which lets one module saturate every core through Web Workers`,
      };
    },
  },

  {
    id: "socket-transport",
    title: "Imports a socket or message transport",
    severity: "low",
    weight: 15,
    evaluate: (f) => {
      const matches = f.importNames.filter((name) => SOCKET_HINT.test(name));
      if (matches.length === 0) return null;
      return {
        confidence: 0.5,
        evidence: `imports ${matches.slice(0, 3).map((m) => `"${m}"`).join(", ")}; mining pools are reached over a persistent socket`,
      };
    },
  },

  {
    id: "compute-kernel-surface",
    title: "Large compute body behind a very small API",
    severity: "low",
    weight: 10,
    evaluate: (f) => {
      if (f.instructionCount < 2000 || f.exportCount > 6 || f.totalLoops === 0) return null;
      return {
        confidence: 0.45,
        evidence: `${f.instructionCount} instructions and ${f.totalLoops} loops behind only ${f.exportCount} exported function(s) -- the shape of a kernel rather than a library`,
      };
    },
  },

  {
    id: "aggressive-memory-growth",
    title: "Requests and grows a large linear memory",
    severity: "low",
    weight: 10,
    evaluate: (f) => {
      // 256 pages is 16 MiB. Mining scratchpads (CryptoNight uses 2 MiB per
      // thread) and unbounded growth are both worth stating plainly.
      if (f.memoryInitialPages < 256 && f.memoryGrowSites === 0) return null;
      const unbounded = f.memoryMaxPages === null;
      return {
        confidence: f.memoryInitialPages >= 256 && unbounded ? 0.5 : 0.25,
        evidence: `asks for ${f.memoryInitialPages} pages (${(f.memoryInitialPages / 16).toFixed(1)} MiB)${unbounded ? " with no declared maximum" : ""}, with ${f.memoryGrowSites} memory.grow site(s)`,
      };
    },
  },

  {
    id: "large-embedded-payload",
    title: "Large embedded data payload",
    severity: "info",
    weight: 8,
    evaluate: (f) => {
      if (f.dataSectionBytes < 262_144) return null;
      const share = f.dataSectionBytes / Math.max(f.byteLength, 1);
      if (share < 0.4) return null;
      return {
        confidence: ramp(share, 0.4, 0.8),
        evidence: `${(f.dataSectionBytes / 1024).toFixed(0)} KB of the module's ${(f.byteLength / 1024).toFixed(0)} KB is data rather than code`,
      };
    },
  },

  {
    id: "stripped-binary",
    title: "Symbol names stripped",
    severity: "info",
    weight: 4,
    evaluate: (f) => {
      if (!f.stripped || f.instructionCount < 500) return null;
      return {
        // Almost every production build strips names. On its own this says
        // nothing; it matters only as a multiplier on other findings.
        confidence: 0.2,
        evidence: "no name section, so function names are unavailable (normal for production builds)",
      };
    },
  },

  {
    id: "incomplete-coverage",
    title: "Analysis did not cover the whole module",
    severity: "info",
    weight: 0,
    evaluate: (f) => {
      if (f.truncatedFunctions === 0 && f.skippedFunctions === 0) return null;
      return {
        confidence: 1,
        evidence: `${f.truncatedFunctions} function(s) could not be fully decoded and ${f.skippedFunctions} were skipped for budget; findings below cover the rest`,
      };
    },
  },
];

/** Run every rule against a feature vector, strongest finding first. */
export function evaluateHeuristics(features: ModuleFeatures): Finding[] {
  const findings: Finding[] = [];

  for (const rule of RULES) {
    const hit = rule.evaluate(features);
    if (!hit || hit.confidence <= 0) continue;
    findings.push({
      id: rule.id,
      title: rule.title,
      severity: rule.severity,
      confidence: Number(hit.confidence.toFixed(3)),
      weight: rule.weight,
      evidence: hit.evidence,
      ...(rule.reference !== undefined ? { reference: rule.reference } : {}),
    });
  }

  return findings.sort((a, b) => b.weight * b.confidence - a.weight * a.confidence);
}

/** Every rule the engine can produce, for documentation and UI legends. */
export function listRules(): Array<Pick<Rule, "id" | "title" | "severity" | "weight" | "reference">> {
  return RULES.map(({ id, title, severity, weight, reference }) => ({
    id,
    title,
    severity,
    weight,
    ...(reference !== undefined ? { reference } : {}),
  }));
}
