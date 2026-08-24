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
import type {
  CaptureContext,
  CaptureRequest,
  RuntimeRequest,
  ScriptRequest,
  SkipRequest,
} from "../shared/protocol";
import { getSettings } from "../utils/settings";
import type { WasmApi } from "@wasm-sentry/core";

const VALID_APIS: ReadonlySet<string> = new Set<WasmApi>([
  "instantiate",
  "instantiateStreaming",
  "compile",
  "compileStreaming",
  "Module",
]);

const VALID_SKIP_REASONS: ReadonlySet<string> = new Set(["too-large", "rate-limited", "read-failed"]);

const VALID_CONTEXTS: ReadonlySet<string> = new Set<CaptureContext>(["page", "worker"]);

/** Read a capture's context, defaulting to the page for older senders. */
function contextOf(value: unknown): CaptureContext {
  return typeof value === "string" && VALID_CONTEXTS.has(value) ? (value as CaptureContext) : "page";
}

function send(message: CaptureRequest | SkipRequest | RuntimeRequest | ScriptRequest): void {
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

  const pageUrlValue = data["pageUrl"];

  // Runtime reports carry no bytes and no API -- they are measurements, not
  // captures -- so they are recognised before the capture validation below.
  const runtime = data["runtime"];
  if (runtime !== undefined) {
    const contextId = data["contextId"];
    if (typeof runtime !== "object" || runtime === null) return;
    if (typeof contextId !== "string" || typeof pageUrlValue !== "string") return;
    if (!Array.isArray((runtime as { modules?: unknown }).modules)) return;
    send({
      type: "wasm-sentry:runtime",
      contextId,
      pageUrl: pageUrlValue,
      report: runtime as RuntimeRequest["report"],
    });
    return;
  }

  // A script observation, which carries no bytes and no API either.
  const script = data["script"];
  if (script !== undefined) {
    if (typeof script !== "object" || script === null) return;
    if (typeof pageUrlValue !== "string") return;
    const { inline, external } = script as {
      inline?: NonNullable<ScriptRequest["inline"]>;
      external?: NonNullable<ScriptRequest["external"]>;
    };
    if (inline === undefined && external === undefined) return;
    send({
      type: "wasm-sentry:script",
      pageUrl: pageUrlValue,
      ...(inline !== undefined ? { inline } : {}),
      ...(external !== undefined ? { external } : {}),
    });
    return;
  }

  const api = data["api"];
  const url = data["url"];
  const pageUrl = pageUrlValue;
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
      context: contextOf(data["context"]),
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
    context: contextOf(data["context"]),
    ...(typeof data["fingerprint"] === "string" ? { fingerprint: data["fingerprint"] } : {}),
  });
});

/**
 * Relay the two opt-out settings into the main world.
 *
 * Both hooks have to exist before the page's first line runs, and
 * `chrome.storage` is async, so neither setting can be consulted first. They
 * are on by default and switched off here a few milliseconds later when the
 * user has disabled them. A worker started -- or a module instantiated --
 * inside that window is still instrumented; the settings take full effect from
 * the next navigation.
 */
void getSettings()
  .then((settings) => {
    if (!settings.instrumentWorkers) {
      window.postMessage(
        { channel: CAPTURE_CHANNEL, command: "disable-worker-instrumentation" },
        "*",
      );
    }
    if (!settings.monitorRuntime) {
      window.postMessage({ channel: CAPTURE_CHANNEL, command: "disable-runtime-monitoring" }, "*");
    }
    // The one that is off by default, so this switches it on rather than off.
    if (settings.analyseJavaScript) {
      window.postMessage({ channel: CAPTURE_CHANNEL, command: "enable-javascript-analysis" }, "*");
    }
  })
  .catch(() => undefined);
