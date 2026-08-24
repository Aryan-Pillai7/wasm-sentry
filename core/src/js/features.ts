/**
 * Characterising a piece of JavaScript, without parsing it.
 *
 * No AST, deliberately. A parser for the whole language is a large dependency
 * and a large attack surface, and every property these rules need survives at
 * the lexical level: how the code is *shaped*, what APIs it names, and how much
 * of it is escaped rather than written. Hostile input is the normal case here,
 * and a scanner that cannot be tripped into a stack overflow by nested
 * parentheses is worth more than one that understands scoping.
 *
 * The governing risk is the opposite of the WebAssembly side. There, almost
 * nothing looks like a mining kernel. Here, **almost everything looks
 * suspicious**: every production bundle on the web is minified, single-line,
 * megabytes long, full of one-letter identifiers, and frequently contains
 * `eval` somewhere in a vendored dependency. So the measurements below are
 * chosen to separate *minified* from *obfuscated*, which are not the same
 * thing, and the thresholds are calibrated against real production bundles.
 */

/** What was measured about one piece of JavaScript. */
export interface JsFeatures {
  byteLength: number;
  lineCount: number;
  /** Minifiers produce very long lines; so does obfuscation. Alone it means nothing. */
  maxLineLength: number;
  meanLineLength: number;

  /**
   * Share of characters that are `\xNN`, `\uNNNN` or `\NNN` escapes.
   *
   * This is the measurement that separates minified from obfuscated. A
   * minifier has no reason to escape anything; an obfuscator escapes almost
   * everything, because the point is that the source should not be readable.
   */
  escapeDensity: number;
  /** Longest single string literal, where a packed payload would sit. */
  longestStringLiteral: number;
  /** String literals that look like base64 and are long enough to hold something. */
  base64Literals: number;
  /** Shannon entropy over the whole text, in bits per character. */
  entropy: number;

  /** Named APIs, counted. Presence is a fact; meaning is the rules' problem. */
  api: {
    eval: number;
    functionConstructor: number;
    atob: number;
    fromCharCode: number;
    documentWrite: number;
    createElementScript: number;
    importScripts: number;
    dynamicImport: number;
    webAssembly: number;
    worker: number;
    webSocket: number;
    setIntervalString: number;
  };

  /** Matched mining family names, deduplicated. */
  minerNames: string[];
  /** Matched pool or stratum endpoints, deduplicated and truncated. */
  poolEndpoints: string[];
  /** `hardwareConcurrency` is how a miner decides how many workers to start. */
  readsHardwareConcurrency: boolean;
}

const MINER_FAMILY =
  /coinhive|cryptonight|crypto-?loot|jsecoin|webminepool|deepminer|minero|coinimp|monero|randomx|xmrig|nicehash|coinhave|minr\.pw/gi;

/**
 * Endpoints that only a mining client connects to.
 *
 * `stratum` is the mining pool protocol and appears in essentially nothing
 * else; the rest are the hostnames the known browser families ship with. A bare
 * `wss://` is deliberately not here -- every chat application on the web opens
 * one.
 */
const POOL_ENDPOINT =
  /stratum\+tcp:\/\/[^\s"']{1,80}|wss?:\/\/[^\s"']*(?:pool|xmr|monero|mine|stratum)[^\s"']{0,60}/gi;

/** `\xNN`, `\uNNNN`, `\u{...}` and octal escapes. */
const ESCAPE = /\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|[0-7]{2,3})/g;

/** Base64-ish: the alphabet, no spaces, long enough to be a payload. */
const BASE64_LIKE = /^[A-Za-z0-9+/=]{64,}$/;

/** Shortest literal worth measuring. Below this nothing can be hidden. */
const MIN_LITERAL = 16;

/**
 * Longest literal we will read in full.
 *
 * Everything past this is counted but not examined: whether a payload is 4 KB
 * or 4 MB does not change any rule's answer, and reading it does cost.
 */
const MAX_LITERAL_SCAN = 4096;

interface LiteralStats {
  longest: number;
  base64Count: number;
}

/**
 * Find string literals with a linear scan rather than a regular expression.
 *
 * The obvious pattern -- `(["'`])((?:\\.|(?!\1)[^\\\r\n]){16,})\1` -- works
 * until it meets a multi-megabyte literal, at which point V8's backtracking
 * stack overflows and the whole analysis is lost. A bundle with a 5 MB inlined
 * asset is not exotic, so this walks the source once instead: no backtracking,
 * no recursion, and a fixed cost per character.
 */
function scanLiterals(source: string): LiteralStats {
  const stats: LiteralStats = { longest: 0, base64Count: 0 };

  for (let i = 0; i < source.length; i++) {
    const quote = source[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;

    const start = i + 1;
    let end = -1;
    for (let j = start; j < source.length; j++) {
      const character = source[j];
      if (character === "\\") {
        j++; // Skip whatever was escaped, including a quote.
        continue;
      }
      if (character === quote) {
        end = j;
        break;
      }
      // A single- or double-quoted literal cannot span a line. Treating a
      // newline as the end keeps an unterminated quote from swallowing the
      // rest of the file.
      if (quote !== "`" && (character === "\n" || character === "\r")) break;
    }
    if (end === -1) continue;

    const length = end - start;
    if (length >= MIN_LITERAL) {
      if (length > stats.longest) stats.longest = length;
      if (length <= MAX_LITERAL_SCAN && BASE64_LIKE.test(source.slice(start, end))) {
        stats.base64Count++;
      }
    }
    i = end;
  }

  return stats;
}

function countMatches(text: string, pattern: RegExp): number {
  // The literal is safer than `RegExp.exec` in a loop: a global regex carries
  // `lastIndex` between calls, and a shared one would skip matches.
  return text.match(pattern)?.length ?? 0;
}

/** Shannon entropy in bits per character. Bounded and cheap. */
export function entropyOf(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Measure a piece of JavaScript.
 *
 * Total: any string is valid input, including one that is not JavaScript at
 * all. Analysing hostile input is the job.
 */
export function extractJsFeatures(source: string): JsFeatures {
  const lines = source.split("\n");
  const lineCount = lines.length;
  let maxLineLength = 0;
  for (const line of lines) if (line.length > maxLineLength) maxLineLength = line.length;

  const literals = scanLiterals(source);

  const escaped = source.match(ESCAPE)?.reduce((total, match) => total + match.length, 0) ?? 0;
  const unique = (matches: RegExpMatchArray | null): string[] =>
    [...new Set((matches ?? []).map((match) => match.slice(0, 80)))].slice(0, 5);

  return {
    byteLength: source.length,
    lineCount,
    maxLineLength,
    meanLineLength: lineCount > 0 ? source.length / lineCount : 0,

    escapeDensity: source.length > 0 ? escaped / source.length : 0,
    longestStringLiteral: literals.longest,
    base64Literals: literals.base64Count,
    // Entropy over a very large bundle costs more than it tells us, and the
    // first megabyte is thoroughly representative of the rest.
    entropy: entropyOf(source.length > 1_000_000 ? source.slice(0, 1_000_000) : source),

    api: {
      eval: countMatches(source, /\beval\s*\(/g),
      functionConstructor: countMatches(source, /\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/g),
      atob: countMatches(source, /\batob\s*\(|decodeURIComponent\s*\(\s*escape\s*\(/g),
      // Counted separately from `atob`: the TypeScript compiler alone calls
      // this 44 times in the course of doing its job, so folding it into a
      // "decodes a payload" counter would make one that counts string handling.
      fromCharCode: countMatches(source, /fromCharCode/g),
      documentWrite: countMatches(source, /document\s*\.\s*write(?:ln)?\s*\(/g),
      createElementScript: countMatches(source, /createElement\s*\(\s*["'`]script["'`]/gi),
      importScripts: countMatches(source, /\bimportScripts\s*\(/g),
      dynamicImport: countMatches(source, /\bimport\s*\(/g),
      webAssembly: countMatches(source, /\bWebAssembly\s*\./g),
      worker: countMatches(source, /\bnew\s+(?:Shared)?Worker\s*\(/g),
      webSocket: countMatches(source, /\bnew\s+WebSocket\s*\(/g),
      // `setTimeout("code")` is a string evaluator wearing a timer's name.
      setIntervalString: countMatches(source, /set(?:Timeout|Interval)\s*\(\s*["'`]/g),
    },

    minerNames: unique(source.match(MINER_FAMILY)),
    poolEndpoints: unique(source.match(POOL_ENDPOINT)),
    readsHardwareConcurrency: /hardwareConcurrency/.test(source),
  };
}

/**
 * What is known about an external script, without reading it.
 *
 * Deliberately metadata only. Re-fetching a page's scripts to inspect them is
 * the design this project rejected for WebAssembly in `design-decisions.md`
 * §2.1, and it is a worse idea here: a script on an authenticated page can
 * contain far more of somebody's private business than a compiled module does.
 * Origin, whether it is third-party and whether it is pinned with Subresource
 * Integrity are facts the page already published, and they are the ones the
 * supply-chain rule needs.
 */
export interface ScriptReference {
  url: string;
  /** Whether the script came from an origin other than the page's own. */
  thirdParty: boolean;
  /** Whether an `integrity` attribute pins its contents. */
  hasIntegrity: boolean;
  /** Whether it was injected after parse rather than present in the markup. */
  injected: boolean;
}
