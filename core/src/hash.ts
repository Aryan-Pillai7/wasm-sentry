/**
 * Content hashing.
 *
 * Uses WebCrypto, which is present unchanged in Chrome extension service
 * workers, page main worlds and Node 20+. That is what lets the extension and
 * the backend agree on an artifact's identity without shipping a hash library
 * to either of them.
 */

const HEX = "0123456789abcdef";

function toHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    const b = view[i]!;
    out += HEX[b >> 4]! + HEX[b & 0x0f]!;
  }
  return out;
}

/** SHA-256 of `bytes` as lowercase hex. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer: a Uint8Array may be a view onto a larger
  // (or SharedArrayBuffer-backed) buffer, which subtle.digest rejects.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return toHex(digest);
}

/** First 12 hex characters of a hash, for logs and UI labels. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
