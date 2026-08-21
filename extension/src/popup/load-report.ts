/**
 * Fetching the tab report, with every failure mode made visible.
 *
 * The first version of this treated any falsy reply as "still loading", so a
 * service worker that never answered left the popup sitting on "Reading capture
 * log..." indefinitely with nothing to diagnose. A tool whose own UI cannot say
 * why it has no data is not much of a diagnostic tool.
 */
import type { TabReport } from "../shared/protocol";

export type LoadOutcome =
  | { status: "ok"; report: TabReport }
  | { status: "error"; message: string; hint?: string };

/** The service worker can be asleep; waking it should not take this long. */
export const REPORT_TIMEOUT_MS = 4000;

/** A reply is only usable if it carries the fields the UI reads. */
export function isTabReport(value: unknown): value is TabReport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TabReport>;
  return (
    Array.isArray(candidate.artifacts) &&
    Array.isArray(candidate.notes) &&
    typeof candidate.scorecard === "object" &&
    candidate.scorecard !== null
  );
}

export interface LoadDeps {
  queryActiveTab: () => Promise<{ id?: number | undefined } | undefined>;
  sendMessage: (message: unknown) => Promise<unknown>;
  timeoutMs?: number;
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

/** Resolve the current tab's report, or explain precisely why it could not. */
export async function loadReport(deps: LoadDeps): Promise<LoadOutcome> {
  let tabId: number;
  try {
    const tab = await deps.queryActiveTab();
    if (typeof tab?.id !== "number") {
      return {
        status: "error",
        message: "No active tab to report on.",
        hint: "Open the popup from a normal web page rather than a chrome:// page.",
      };
    }
    tabId = tab.id;
  } catch (cause) {
    return { status: "error", message: `Could not read the active tab: ${String(cause)}` };
  }

  let reply: unknown;
  try {
    const raced = await Promise.race([
      deps.sendMessage({ type: "wasm-sentry:tab-report", tabId }),
      timeout(deps.timeoutMs ?? REPORT_TIMEOUT_MS),
    ]);
    if (raced === "timeout") {
      return {
        status: "error",
        message: "The background service worker did not respond.",
        hint: 'Open chrome://extensions, find Wasm-Sentry and click "service worker" to see its console.',
      };
    }
    reply = raced;
  } catch (cause) {
    // Chrome rejects with "Could not establish connection" when the worker is
    // not registered at all -- usually a build that was never reloaded.
    return {
      status: "error",
      message: `Could not reach the service worker: ${String(cause)}`,
      hint: 'Reload the extension at chrome://extensions, then reload the page.',
    };
  }

  if (reply === undefined || reply === null) {
    return {
      status: "error",
      message: "The service worker replied with nothing.",
      hint: 'Check its console at chrome://extensions -> Wasm-Sentry -> "service worker".',
    };
  }

  if (!isTabReport(reply)) {
    const detail =
      typeof reply === "object" && reply !== null && "reason" in reply
        ? String((reply as { reason: unknown }).reason)
        : JSON.stringify(reply).slice(0, 200);
    return { status: "error", message: `The service worker reported a failure: ${detail}` };
  }

  return { status: "ok", report: reply };
}
