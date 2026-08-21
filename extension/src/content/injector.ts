/**
 * Main-world entry point.
 *
 * Runs inside the page's own JavaScript world at `document_start`, before any
 * page script executes, and installs the capture hooks defined in
 * `capture-hooks.ts`.
 *
 * Why hook the WebAssembly API rather than re-fetch the URL, which is what the
 * first prototype did:
 *
 *   - A second `fetch()` of the same URL is not guaranteed to return the same
 *     bytes. One-time tokens, auth headers and server-side A/B switches all
 *     make the analysed artifact differ from the executed one, which is
 *     precisely the gap an evasive miner hides in.
 *   - `blob:`, `data:` and `WebAssembly.instantiate(buffer)` never touch the
 *     network at all, so `webRequest` never sees them. Pulling bytes over
 *     XHR or a WebSocket and compiling them is a known cryptojacking pattern.
 *   - Re-fetching doubles every module's bandwidth cost on the user's
 *     connection.
 *
 * Known blind spot: content scripts do not run inside Web Workers, so a module
 * compiled in a worker is not seen here. The service worker records those from
 * the network side as a `network-only` note so the report stays honest about
 * what it did not analyse.
 */
import { installHooks } from "./capture-hooks";
import type { HookCapture, HookSkip, WasmNamespace } from "./capture-hooks";

const CHANNEL = "wasm-sentry:capture:v1";
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURES_PER_MINUTE = 60;
const INSTALLED = "__wasmSentryInstalled";

function emit(message: HookCapture | HookSkip): void {
  try {
    // Target origin `*` rather than `location.origin`: sandboxed and
    // `about:blank` frames have an opaque origin that would reject the message.
    // The delivery target is this same window either way, and the page already
    // owns every byte being forwarded, so this discloses nothing new.
    window.postMessage({ channel: CHANNEL, pageUrl: location.href, ...message }, "*");
  } catch {
    /* A page that has broken postMessage is not worth crashing over. */
  }
}

const guard = globalThis as unknown as { [INSTALLED]?: boolean };
const wasm = (globalThis as { WebAssembly?: WasmNamespace }).WebAssembly;

if (wasm && !guard[INSTALLED]) {
  guard[INSTALLED] = true;
  installHooks({
    wasm,
    emit,
    maxBytes: MAX_ARTIFACT_BYTES,
    maxPerMinute: MAX_CAPTURES_PER_MINUTE,
  });
}
