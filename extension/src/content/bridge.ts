/**
 * Isolated-world bridge.
 *
 * The main-world hook cannot reach `chrome.runtime`; this script can, but
 * cannot see the page's `WebAssembly` object. It exists purely to carry
 * messages across that boundary, and to do the base64 encoding so the page's
 * main thread is not billed for it.
 *
 * Everything arriving here is untrusted input from the page. It is validated
 * for shape and size, and the service worker still re-hashes the bytes rather
 * than trusting anything computed on the page side.
 */
import { bytesToBase64 } from "@wasm-sentry/core";
import { CAPTURE_CHANNEL, MAX_ARTIFACT_BYTES } from "../shared/protocol";
import type { CaptureRequest, SkipRequest } from "../shared/protocol";
import type { WasmApi } from "@wasm-sentry/core";

const VALID_APIS: ReadonlySet<string> = new Set<WasmApi>([
  "instantiate",
  "instantiateStreaming",
  "compile",
  "compileStreaming",
  "Module",
]);

const VALID_SKIP_REASONS: ReadonlySet<string> = new Set(["too-large", "rate-limited", "read-failed"]);

function send(message: CaptureRequest | SkipRequest): void {
  // Fire and forget. A closed service worker, a torn-down extension context or
  // a navigation mid-flight all reject here, and none of them are actionable.
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

window.addEventListener("message", (event: MessageEvent) => {
  // Only messages this window posted to itself; anything from a child frame or
  // an opener is somebody else's page.
  if (event.source !== window) return;

  const data = event.data as Record<string, unknown> | null;
  if (!data || data["channel"] !== CAPTURE_CHANNEL) return;

  const api = data["api"];
  const url = data["url"];
  const pageUrl = data["pageUrl"];
  if (typeof api !== "string" || !VALID_APIS.has(api)) return;
  if (typeof url !== "string" || typeof pageUrl !== "string") return;

  const skipped = data["skipped"];
  if (typeof skipped === "string") {
    if (!VALID_SKIP_REASONS.has(skipped)) return;
    send({
      type: "wasm-sentry:skipped",
      api: api as WasmApi,
      url,
      pageUrl,
      size: typeof data["size"] === "number" ? data["size"] : 0,
      reason: skipped as SkipRequest["reason"],
    });
    return;
  }

  const bytes = data["bytes"];
  if (!(bytes instanceof Uint8Array)) return;
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) return;

  send({
    type: "wasm-sentry:capture",
    api: api as WasmApi,
    url,
    pageUrl,
    size: bytes.length,
    bytesB64: bytesToBase64(bytes),
  });
});
