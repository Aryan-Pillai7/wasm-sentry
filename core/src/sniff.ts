import type { ArtifactKind } from "./types.js";

/** The four magic bytes every WebAssembly binary starts with: `\0asm`. */
export const WASM_MAGIC = Uint8Array.of(0x00, 0x61, 0x73, 0x6d);

/** The only binary format version defined by the MVP spec. */
export const WASM_VERSION_1 = Uint8Array.of(0x01, 0x00, 0x00, 0x00);

/**
 * True when `bytes` begins with the WebAssembly magic number.
 *
 * We check the bytes rather than the URL suffix or the MIME type. Attackers
 * control both of those -- a miner is routinely served as `/assets/a8f3.dat`
 * with `Content-Type: application/octet-stream` -- but they cannot change the
 * magic number without the browser refusing to compile the module.
 */
export function isWasm(bytes: Uint8Array): boolean {
  if (bytes.length < WASM_MAGIC.length) return false;
  for (let i = 0; i < WASM_MAGIC.length; i++) {
    if (bytes[i] !== WASM_MAGIC[i]) return false;
  }
  return true;
}

/** True when the module declares binary format version 1. */
export function isSupportedWasmVersion(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 4; i++) {
    if (bytes[4 + i] !== WASM_VERSION_1[i]) return false;
  }
  return true;
}

/**
 * Fraction of the first `sampleSize` bytes that are plausible source text
 * (printable ASCII, tab, CR, LF). Minified JavaScript scores ~1.0; a stripped
 * binary scores well under 0.9 because of the density of control bytes.
 */
function textRatio(bytes: Uint8Array, sampleSize = 4096): number {
  const n = Math.min(bytes.length, sampleSize);
  if (n === 0) return 0;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) printable++;
    // UTF-8 continuation and lead bytes are common in real bundles (emoji,
    // non-Latin string literals) and should not count against text-ness.
    else if (b >= 0x80) printable++;
  }
  return printable / n;
}

/**
 * Classify raw bytes into an artifact kind, or `null` if we should not spend
 * analysis budget on them.
 *
 * Wasm is decided structurally. JavaScript has no magic number, so it is
 * decided by a text-density test plus the caller's transport hint -- being
 * wrong here costs a wasted parse, not a missed detection, because anything
 * carrying the Wasm magic number is caught by the first branch regardless of
 * what the transport claimed it was.
 */
export function sniff(
  bytes: Uint8Array,
  hint?: { contentType?: string; url?: string },
): ArtifactKind | null {
  if (isWasm(bytes)) return "wasm";

  const contentType = hint?.contentType?.toLowerCase() ?? "";
  if (contentType.includes("wasm")) {
    // Claimed to be Wasm but does not carry the magic number: not analysable
    // as a module, and not JavaScript either.
    return null;
  }

  const looksTextual =
    contentType.includes("javascript") ||
    contentType.includes("ecmascript") ||
    contentType.includes("text/") ||
    contentType.includes("json") ||
    contentType === "";

  if (looksTextual && textRatio(bytes) > 0.95) return "js";
  return null;
}
