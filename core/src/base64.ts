/**
 * Base64 transport helpers.
 *
 * `chrome.runtime.sendMessage` serialises with a JSON-shaped algorithm, not
 * structured clone, so a `Uint8Array` handed to it arrives as an object with
 * numeric keys -- the same 4x inflation the first prototype paid for. Base64
 * costs a predictable 4/3 and survives the boundary intact.
 */

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode bytes as standard (padded) base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += CHARS[(n >> 18) & 63]! + CHARS[(n >> 12) & 63]! + CHARS[(n >> 6) & 63]! + CHARS[n & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i]! << 16;
    out += CHARS[(n >> 18) & 63]! + CHARS[(n >> 12) & 63]! + "==";
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += CHARS[(n >> 18) & 63]! + CHARS[(n >> 12) & 63]! + CHARS[(n >> 6) & 63]! + "=";
  }
  return out;
}

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(256).fill(255);
  for (let i = 0; i < CHARS.length; i++) table[CHARS.charCodeAt(i)] = i;
  return table;
})();

/** Decode standard base64 back into bytes. Throws on malformed input. */
export function base64ToBytes(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text[end - 1] === "=") end--;
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const value = LOOKUP[text.charCodeAt(i)]!;
    if (value === 255) throw new Error(`invalid base64 character at index ${i}`);
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
