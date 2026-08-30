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
import type { RuntimeFeatures } from "./runtime.js";
import { predict } from "./ml/model.js";
import type { ClassifierModel } from "./ml/model.js";

/**
 * Bump whenever a rule's threshold, weight or logic changes -- anything that
 * would make a stored verdict answer a question this file no longer asks the
 * same way. A verdict stamped with the ruleset that produced it is one a
 * store can tell is stale without re-deriving it; a verdict with no version
 * at all is indistinguishable from a fresh one, silently, forever.
 */
export const RULESET_VERSION = 1;

export type Severity = "info" | "low" | "medium" | "high";

/** What a finding needed to be produced: the bytes, the module running, or a trained model. */
export type FindingKind = "static" | "runtime" | "model";

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
  /**
   * What this means, in one sentence, for someone who has never read a
   * bitwise-ratio number in their life. `title` and `evidence` stay
   * technical on purpose -- they're what makes a finding verifiable
   * rather than a bare accusation -- but a first-time user shouldn't
   * have to parse "31.2% shifts, rotates and xors" to know what a
   * finding is telling them. This is what a UI shows first.
   */
  plainSummary: string;
  /** The literature the rule is drawn from. */
  reference?: string;
  /**
   * Which of the three detection layers produced this: static analysis,
   * runtime observation, or the trained classifier. Carried on the finding
   * itself, not just in `listRules()`'s catalog, so a reader can see which
   * layer caught something without a separate lookup -- the same reasoning
   * that puts the evidence numbers on the finding instead of a rule-name
   * they'd have to go look up.
   */
  kind: FindingKind;
}

interface RuleHit {
  confidence: number;
  evidence: string;
}

interface Rule {
  id: string;
  title: string;
  /** See `Finding.plainSummary`. */
  plainSummary: string;
  severity: Severity;
  weight: number;
  reference?: string;
  evaluate: (features: ModuleFeatures) => RuleHit | null;
}

/**
 * A rule that needs to see the module run.
 *
 * Kept as a separate list rather than made optional on `Rule`, so that a static
 * rule can never quietly start depending on runtime data it will not have: most
 * modules are scored the moment they are captured, seconds before any runtime
 * evidence exists.
 */
interface RuntimeRule {
  id: string;
  title: string;
  /** See `Finding.plainSummary`. */
  plainSummary: string;
  severity: Severity;
  weight: number;
  reference?: string;
  evaluate: (runtime: RuntimeFeatures, features: ModuleFeatures) => RuleHit | null;
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
    plainSummary: "Directly names a known cryptomining library or service inside the module.",
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
    plainSummary:
      "Includes a cryptographic hashing function -- used by miners, but also by ordinary password security, so this alone doesn't mean much.",
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
    plainSummary:
      "Runs a tight, repetitive number-crunching loop -- the same shape used by cryptomining, but also by ordinary compression and checksum code.",
    severity: "medium",
    weight: 22,
    reference: "MINOS: A Lightweight Real-Time Cryptojacking Detection System",
    evaluate: (f) => kernelHit(f),
  },

  {
    id: "mining-corroborated",
    title: "Compute kernel combined with mining infrastructure",
    plainSummary:
      "Has that repetitive loop plus the extra machinery a miner needs -- multiple worker threads, a live network connection, or a module that does nothing else.",
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
    plainSummary:
      "An unusually large share of this module's code is low-level bit-shuffling -- far more than typical compiled apps, which lean on this only occasionally.",
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
    plainSummary:
      "Sets up memory shared across multiple worker threads -- a common way to spread heavy computation across every CPU core.",
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
    plainSummary: "Can open a live network connection -- how a miner would report results back to a mining pool.",
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
    plainSummary:
      "A large amount of code sits behind a tiny public interface -- the shape of a module built to do one repetitive job, not a general-purpose library.",
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
    plainSummary:
      "Reserves an unusually large, possibly unbounded chunk of memory -- mining routines often need a big scratch space to work in.",
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
    plainSummary:
      "Most of this module's size is embedded data rather than code -- worth noting, though this is common and often harmless (e.g. bundled assets).",
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
    plainSummary: "Function names have been removed, which is standard for production builds and not suspicious by itself.",
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
    plainSummary: "Part of this module couldn't be fully analyzed -- the findings above cover what could be checked, not the whole thing.",
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

/* ------------------------------------------------------------------ */
/* Runtime rules                                                       */
/* ------------------------------------------------------------------ */

/**
 * How long a module has to be watched before its behaviour means anything.
 *
 * A page is legitimately busy for a few seconds all the time -- decoding an
 * image, starting a game, running a spreadsheet recalculation. Twenty seconds
 * of sustained execution is a different claim from a spike, and the difference
 * is the whole reason this phase exists.
 */
const MIN_OBSERVED_MS = 20_000;

/**
 * Timer lateness that counts as a starved event loop.
 *
 * The sampler asks for a tick every second. Ordinary scheduling jitter is a few
 * milliseconds; a background tab is throttled to whole seconds, which is why
 * drift is only ever read as corroboration alongside measured execution time
 * and never on its own.
 */
const STARVED_DRIFT_MS = 250;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const RUNTIME_RULES: RuntimeRule[] = [
  {
    // Deliberately weighted below the high band on its own. A video codec, a
    // game and a physics engine all saturate a core honestly, and the whole
    // lesson of the static calibration was that a shape shared with legitimate
    // software is a prior, not a verdict.
    id: "sustained-execution",
    title: "Runs continuously rather than in bursts",
    plainSummary:
      "Kept the CPU busy continuously rather than in short bursts, for longer than an ordinary page usually needs.",
    severity: "medium",
    weight: 28,
    reference: "MINOS: A Lightweight Real-Time Cryptojacking Detection System",
    evaluate: (r) => {
      if (r.observedMs < MIN_OBSERVED_MS) return null;
      if (r.cpuShare < 0.5) return null;
      return {
        confidence: Math.min(ramp(r.cpuShare, 0.5, 2), 1),
        evidence:
          `spent ${seconds(r.wasmTimeMs)} executing during ${seconds(r.observedMs)} of observation ` +
          `across ${r.contextCount} context(s) — ${r.cpuShare.toFixed(2)} core-equivalents` +
          (r.timingStopped ? ", and that is a floor: per-call timing was stopped to avoid becoming the cost itself" : ""),
      };
    },
  },

  {
    // The finding this phase was built for. Static analysis cannot separate a
    // hashing kernel from an image codec; a hashing kernel that then runs flat
    // out for half a minute is no longer ambiguous.
    id: "mining-runtime-corroborated",
    title: "Compute kernel that then ran flat out",
    plainSummary:
      "Found that same repetitive loop, then watched it actually run -- continuously, at close to full processor speed, for tens of seconds. Ordinary apps don't stay this busy this long.",
    severity: "high",
    weight: 45,
    reference: "MINOS: A Lightweight Real-Time Cryptojacking Detection System",
    evaluate: (r, f) => {
      const kernel = kernelHit(f);
      if (!kernel) return null;
      if (r.observedMs < MIN_OBSERVED_MS || r.cpuShare < 0.5) return null;

      const corroboration: string[] = [];
      if (r.contextCount > 1) corroboration.push(`${r.contextCount} contexts at once`);
      if (r.meanDriftMs >= STARVED_DRIFT_MS) {
        corroboration.push(`its own timers running ${r.meanDriftMs.toFixed(0)}ms late`);
      }
      if (r.socketMessages > 0) {
        corroboration.push(`${r.socketMessages} messages over ${r.socketCount} socket(s)`);
      }

      return {
        confidence: Math.min(kernel.confidence * Math.min(0.7 + 0.15 * corroboration.length, 1.3), 1),
        evidence:
          `${kernel.evidence}; it then ran for ${seconds(r.wasmTimeMs)} of ${seconds(r.observedMs)} ` +
          `(${r.cpuShare.toFixed(2)} core-equivalents)` +
          (corroboration.length > 0 ? `, with ${corroboration.join(" and ")}` : "") +
          ` — compression and checksum routines do not run continuously`,
      };
    },
  },

  {
    id: "worker-fan-out",
    title: "Executes in several workers at once",
    plainSummary:
      "Runs the same code across most of your CPU's cores at once via background workers -- a way to make heavy computation faster, mining included.",
    severity: "medium",
    weight: 20,
    reference: "Silent Spring: Characterizing Cryptojacking in the Wild",
    evaluate: (r) => {
      if (r.contextCount < 2 || !r.contexts.includes("worker")) return null;
      const cores = r.hardwareConcurrency > 0 ? r.hardwareConcurrency : 4;
      // Two workers is a thread pool. Half the machine is a decision about the
      // machine rather than about the work.
      if (r.contextCount < Math.max(2, Math.ceil(cores / 2))) return null;
      return {
        // Floored rather than ramped from zero: the gate above has already
        // decided this is worth reporting, and a bare `ramp` starting at the
        // same point returns exactly zero for a module sitting on it, which
        // would drop the finding the gate just admitted.
        confidence: Math.min(0.4 + 0.6 * ramp(r.contextCount / cores, 0.5, 1), 1),
        evidence:
          `the same module is executing in ${r.contextCount} contexts on a ${cores}-core machine, ` +
          `for ${seconds(r.wasmTimeMs)} in total — the shape of claiming every core`,
      };
    },
  },

  {
    id: "persistent-socket-traffic",
    title: "Keeps a socket busy while it computes",
    plainSummary:
      "Kept a network connection busy while it was computing -- consistent with reporting work back to a remote server.",
    severity: "low",
    weight: 12,
    evaluate: (r) => {
      if (r.socketCount === 0 || r.socketMessages < 10) return null;
      if (r.wasmTimeMs < 5_000) return null;
      return {
        confidence: 0.45,
        evidence:
          `${r.socketMessages} messages across ${r.socketCount} socket(s) while executing for ` +
          `${seconds(r.wasmTimeMs)} — a mining pool hands out work and takes back shares this way`,
      };
    },
  },

  {
    id: "runtime-not-yet-observed",
    title: "Runtime behaviour not observed for long enough",
    plainSummary:
      "Hasn't been watched running long enough yet to say anything about its behavior -- check back after using the page a bit longer.",
    severity: "info",
    weight: 0,
    evaluate: (r) => {
      if (r.observedMs >= MIN_OBSERVED_MS) return null;
      return {
        confidence: 1,
        evidence:
          `watched for ${seconds(r.observedMs)} so far; runtime rules need ${seconds(MIN_OBSERVED_MS)} ` +
          `before a busy page can be told from a mining page`,
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* The classifier's opinion                                            */
/* ------------------------------------------------------------------ */

/**
 * Weighted below every corroborated rule, on purpose and permanently.
 *
 * A model is an opinion about a module; the rules above are measurements of
 * one. This project's entire position is that a verdict a user cannot
 * interrogate is a verdict they cannot act on, and "the model said so" is
 * exactly that verdict -- so the classifier is allowed to raise a question and
 * never to answer one on its own. Its evidence names the columns that moved the
 * score, which is as close to interrogable as a model gets.
 *
 * No model ships with this repository, so in practice this rule does not fire.
 * It is the socket a model plugs into once there is a corpus honest enough to
 * train one.
 */
const CLASSIFIER_RULE = {
  id: "classifier-opinion",
  title: "A trained classifier considers this module suspicious",
  plainSummary: "A trained pattern-matching model flags this module as statistically similar to known cryptomining code.",
  severity: "medium" as Severity,
  weight: 18,
  reference: "Deep-Wasm: Detecting Malicious WebAssembly Binaries via Deep Learning",
};

/** Only worth reporting once the model is more sure than a coin flip. */
const CLASSIFIER_FLOOR = 0.6;

function classifierHit(model: ClassifierModel, features: ModuleFeatures): RuleHit | null {
  let prediction;
  try {
    prediction = predict(model, features);
  } catch {
    // A model trained on a different feature schema, or a corrupt one. Scoring
    // the wrong columns would produce confident nonsense; saying nothing is the
    // honest failure.
    return null;
  }

  if (prediction.probability < CLASSIFIER_FLOOR) return null;

  const drivers = prediction.topContributions
    .slice(0, 3)
    .map((entry) => `${entry.feature}=${entry.value.toFixed(3)}`)
    .join(", ");

  return {
    confidence: ramp(prediction.probability, CLASSIFIER_FLOOR, 0.95),
    evidence:
      `a model trained on ${model.metadata.maliciousCount} malicious and ` +
      `${model.metadata.benignCount} benign modules scores this ` +
      `${prediction.probability.toFixed(2)}, driven by ${drivers} ` +
      `(a model's opinion, not a measurement of intent)`,
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function toFinding(
  rule: {
    id: string;
    title: string;
    plainSummary: string;
    severity: Severity;
    weight: number;
    reference?: string;
  },
  hit: RuleHit,
  kind: FindingKind,
): Finding {
  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    confidence: Number(hit.confidence.toFixed(3)),
    weight: rule.weight,
    evidence: hit.evidence,
    plainSummary: rule.plainSummary,
    kind,
    ...(rule.reference !== undefined ? { reference: rule.reference } : {}),
  };
}

/**
 * Run every rule against a feature vector, strongest finding first.
 *
 * `runtime` is optional and usually absent: a module is scored the moment it is
 * captured, which is seconds before there is anything to say about how it
 * behaves. The static verdict stands on its own and is replaced, not amended,
 * when runtime evidence arrives.
 */
export function evaluateHeuristics(
  features: ModuleFeatures,
  runtime?: RuntimeFeatures,
  model?: ClassifierModel,
): Finding[] {
  const findings: Finding[] = [];

  for (const rule of RULES) {
    const hit = rule.evaluate(features);
    if (!hit || hit.confidence <= 0) continue;
    findings.push(toFinding(rule, hit, "static"));
  }

  if (runtime) {
    for (const rule of RUNTIME_RULES) {
      const hit = rule.evaluate(runtime, features);
      if (!hit || hit.confidence <= 0) continue;
      findings.push(toFinding(rule, hit, "runtime"));
    }
  }

  if (model) {
    const hit = classifierHit(model, features);
    if (hit && hit.confidence > 0) findings.push(toFinding(CLASSIFIER_RULE, hit, "model"));
  }

  return findings.sort((a, b) => b.weight * b.confidence - a.weight * a.confidence);
}

export interface RuleSummary {
  id: string;
  title: string;
  plainSummary: string;
  severity: Severity;
  weight: number;
  reference?: string;
  /** What the rule needs: the bytes, the module running, or a trained model. */
  kind: FindingKind;
}

/** Every rule the engine can produce, for documentation and UI legends. */
export function listRules(): RuleSummary[] {
  const summarise = (kind: RuleSummary["kind"]) =>
    ({ id, title, plainSummary, severity, weight, reference }: Omit<Rule, "evaluate">): RuleSummary => ({
      id,
      title,
      plainSummary,
      severity,
      weight,
      kind,
      ...(reference !== undefined ? { reference } : {}),
    });

  return [
    ...RULES.map(summarise("static")),
    ...RUNTIME_RULES.map(summarise("runtime")),
    summarise("model")(CLASSIFIER_RULE),
  ];
}
