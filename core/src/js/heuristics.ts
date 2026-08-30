/**
 * Detection rules for JavaScript.
 *
 * Same contract as the WebAssembly rules: every finding states the numbers that
 * produced it, thresholds are measured rather than guessed, and a false
 * positive costs more than a miss.
 *
 * The measuring was harder here, because the baseline is worse. Ordinary
 * compiled WebAssembly looks nothing like a mining kernel; ordinary production
 * JavaScript looks *exactly* like obfuscated JavaScript to any naive test. It
 * is minified to one line, hundreds of kilobytes long, full of one-character
 * identifiers, and full of long opaque string literals. A rule that flags
 * "minified" flags the entire web.
 *
 * ## Calibration
 *
 * Measured against real production bundles shipped in this repository's own
 * `node_modules`, plus obfuscated samples built to the shape an obfuscator
 * actually produces:
 *
 * | Source | Size | Escape density | `eval` | `atob` |
 * |---|---|---|---|---|
 * | `react-dom.production.js` | 6 KB | 0.000% | 0 | 0 |
 * | `esquery.esm.min.js` | 36 KB | 0.131% | 0 | 0 |
 * | `ajv.min.js` (119k-char line) | 117 KB | 0.928% | 0 | 0 |
 * | `typescript.js` | 8.9 MB | 0.006% | 0 | 0 |
 * | hex-escaped payload | 0.4 KB | **54.8%** | 1 | 1 |
 * | packed payload | 6.3 KB | **98.9%** | 1 | 0 |
 *
 * Two orders of magnitude separate them, and the separator is **escape
 * density**, not line length or entropy -- a minifier has no reason to escape
 * anything, while an obfuscator escapes almost everything, because the point is
 * that the source should not be readable. `ajv.min.js` has a 119,360-character
 * line and is entirely legitimate, which is why line length is measured and
 * never used as evidence on its own.
 *
 * Not one of the four real bundles calls `eval` or `atob` at all.
 */
import type { Finding, Severity } from "../heuristics.js";
import type { JsFeatures, ScriptReference } from "./features.js";

/**
 * Where obfuscation begins.
 *
 * Five percent: 5.4x above the worst real bundle measured (0.93%) and 11x below
 * the mildest obfuscated sample (54.8%). Sitting in the middle of a gap that
 * wide is the whole reason this threshold can be trusted.
 */
const ESCAPE_CEILING = 0.05;

interface JsRuleHit {
  confidence: number;
  evidence: string;
}

interface JsRule {
  id: string;
  title: string;
  /** See `Finding.plainSummary`. */
  plainSummary: string;
  severity: Severity;
  weight: number;
  reference?: string;
  evaluate: (features: JsFeatures) => JsRuleHit | null;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function quoteList(values: readonly string[], limit = 3): string {
  return values.slice(0, limit).map((value) => `"${value}"`).join(", ");
}

const JS_RULES: JsRule[] = [
  {
    id: "js-known-miner-family",
    title: "Names a known browser mining family",
    plainSummary: "Directly names a known cryptomining library or service in the script.",
    severity: "high",
    weight: 45,
    reference: "Silent Spring: Characterizing Cryptojacking in the Wild",
    evaluate: (f) =>
      f.minerNames.length === 0
        ? null
        : {
            confidence: 0.95,
            evidence: `script references ${quoteList(f.minerNames, 4)}`,
          },
  },

  {
    id: "js-mining-pool-endpoint",
    title: "Contains a mining pool address",
    plainSummary: "Connects to what looks like a cryptomining pool server address.",
    severity: "high",
    weight: 35,
    reference: "Silent Spring: Characterizing Cryptojacking in the Wild",
    evaluate: (f) =>
      f.poolEndpoints.length === 0
        ? null
        : {
            confidence: 0.8,
            // `stratum` is the mining pool protocol and appears in essentially
            // nothing else. A bare `wss://` is not evidence -- every chat
            // application on the web opens one -- so it is not matched.
            evidence: `connects to ${quoteList(f.poolEndpoints)}; stratum is the mining pool protocol`,
          },
  },

  {
    id: "js-obfuscated-source",
    title: "Source is escaped rather than merely minified",
    plainSummary:
      "The code is deliberately scrambled to be unreadable -- beyond normal minification, which just shortens code without hiding it.",
    severity: "medium",
    weight: 20,
    evaluate: (f) => {
      if (f.escapeDensity < ESCAPE_CEILING || f.byteLength < 200) return null;
      return {
        confidence: Math.min((f.escapeDensity - ESCAPE_CEILING) / 0.25, 1),
        evidence:
          `${percent(f.escapeDensity)} of the source is character escapes; real production ` +
          `bundles measure under 1% (react-dom 0.000%, ajv.min.js 0.928%) because minifiers ` +
          `shorten code and do not hide it`,
      };
    },
  },

  {
    id: "js-decoded-code-execution",
    title: "Builds code at runtime out of encoded data",
    plainSummary:
      "Decodes hidden data and then runs it as code -- a common way to sneak in a payload that isn't visible by just reading the script.",
    severity: "high",
    weight: 30,
    evaluate: (f) => {
      const evaluates = f.api.eval + f.api.functionConstructor + f.api.setIntervalString;
      const decodes = f.api.atob + f.base64Literals;
      // Both halves are required. `new Function` alone compiles a validator in
      // ajv and a template in a dozen other libraries; a base64 literal alone
      // is an inlined image. Together they are a payload and its loader.
      if (evaluates === 0 || decodes === 0) return null;

      const escaped = f.escapeDensity >= ESCAPE_CEILING;
      return {
        confidence: escaped ? 0.85 : 0.5,
        evidence:
          `${evaluates} runtime code-evaluation site(s) alongside ${f.api.atob} base64 decode(s) ` +
          `and ${f.base64Literals} base64-shaped literal(s)` +
          (escaped ? `, in source that is ${percent(f.escapeDensity)} escapes` : "") +
          ` -- code assembled from data cannot be read before it runs`,
      };
    },
  },

  {
    id: "js-miner-bootstrap-shape",
    title: "Has the shape of a WebAssembly miner's loader",
    plainSummary:
      "Has the exact startup pattern of a browser miner: loads a compiled module, spins up one worker per CPU core, and opens a network connection.",
    severity: "medium",
    weight: 25,
    reference: "MINOS: A Lightweight Real-Time Cryptojacking Detection System",
    evaluate: (f) => {
      // A miner's loader does three things together: compile a module, start
      // one worker per core, and open a socket to a pool. Any one of them is
      // ordinary; all three in one script is the bootstrap.
      const parts: string[] = [];
      if (f.api.webAssembly > 0) parts.push(`${f.api.webAssembly} WebAssembly call(s)`);
      if (f.api.worker > 0) parts.push(`${f.api.worker} Worker construction(s)`);
      if (f.readsHardwareConcurrency) parts.push("a read of hardwareConcurrency");
      if (f.api.webSocket > 0) parts.push(`${f.api.webSocket} WebSocket(s)`);
      if (parts.length < 3) return null;

      return {
        confidence: parts.length >= 4 ? 0.7 : 0.45,
        evidence: `${parts.join(", ")} in one script -- how a miner sizes itself to the machine and asks for work`,
      };
    },
  },

  {
    id: "js-injects-remote-script",
    title: "Injects further scripts at runtime",
    plainSummary:
      "Loads and runs additional code from elsewhere at runtime -- common for ads and analytics, but also how hidden code gets pulled in.",
    severity: "low",
    weight: 8,
    evaluate: (f) => {
      const injections = f.api.createElementScript + f.api.documentWrite;
      if (injections === 0) return null;
      return {
        // Every tag manager and analytics snippet on the web does this. It is
        // context for the findings around it, not an accusation of its own.
        confidence: 0.3,
        evidence:
          `${injections} site(s) that inject a script element -- ordinary for tag managers ` +
          `and analytics, and also how a loader reaches code that was never on the page`,
      };
    },
  },
];

/** Run every JavaScript rule, strongest first. */
export function evaluateJsHeuristics(features: JsFeatures): Finding[] {
  const findings: Finding[] = [];

  for (const rule of JS_RULES) {
    const hit = rule.evaluate(features);
    if (!hit || hit.confidence <= 0) continue;
    findings.push({
      id: rule.id,
      title: rule.title,
      severity: rule.severity,
      confidence: Number(hit.confidence.toFixed(3)),
      weight: rule.weight,
      evidence: hit.evidence,
      plainSummary: rule.plainSummary,
      kind: "static",
      ...(rule.reference !== undefined ? { reference: rule.reference } : {}),
    });
  }

  return findings.sort((a, b) => b.weight * b.confidence - a.weight * a.confidence);
}

/**
 * The supply-chain view, from metadata the page already published.
 *
 * No script contents are involved. A third-party script with no Subresource
 * Integrity is the classic supply-chain exposure -- whoever controls that
 * origin controls code running with the page's full privileges -- and it is
 * visible from the markup alone.
 *
 * Weighted very low on purpose. Most of the web loads unpinned third-party
 * scripts; this is a fact worth surfacing, not a verdict about the page.
 */
export function evaluateScriptInventory(scripts: readonly ScriptReference[]): Finding[] {
  const unpinned = scripts.filter((script) => script.thirdParty && !script.hasIntegrity);
  if (unpinned.length === 0) return [];

  const origins = [...new Set(unpinned.map((script) => originOf(script.url)))];
  const injected = unpinned.filter((script) => script.injected).length;

  return [
    {
      id: "js-third-party-unpinned",
      title: "Runs third-party scripts with no integrity pin",
      plainSummary:
        "Loads scripts from other websites without verifying they haven't been tampered with -- whoever controls those sites controls code running on this page.",
      severity: "info",
      weight: 6,
      confidence: 0.35,
      kind: "static",
      evidence:
        `${unpinned.length} script(s) from ${origins.length} other origin(s) -- ` +
        `${quoteList(origins)} -- run without Subresource Integrity` +
        (injected > 0 ? `, ${injected} of them added after the page parsed` : "") +
        `; whoever controls those origins controls code running as this page`,
    },
  ];
}

function originOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}
