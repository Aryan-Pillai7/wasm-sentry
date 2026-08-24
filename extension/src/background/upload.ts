/**
 * Opt-in upload to the backend.
 *
 * Off by default, and the reason is the whole privacy stance of the project:
 * Wasm-Sentry sees every module a page executes, and some of those are private
 * by nature -- an internal build, an authenticated application. Shipping them
 * to a server by default would be an exfiltration channel wearing a security
 * tool's badge. So this runs only when the user has said so, and it is written
 * to be obviously bounded when it does.
 *
 * What it buys when it is on: artifacts survive across browsers and profiles,
 * and a rule change can be re-run over everything ever seen without the browser
 * having to observe those modules again.
 */
import type { Settings } from "../utils/settings";

/** Matches the backend's cap and the capture cap. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/** A slow or missing backend must never hold a capture open. */
const UPLOAD_TIMEOUT_MS = 10_000;

export type UploadOutcome =
  | { status: "uploaded"; jobId: string }
  | { status: "known" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface UploadDeps {
  settings: Pick<Settings, "uploadEnabled" | "backendUrl">;
  hash: string;
  bytes: Uint8Array;
  /** Injected so the policy can be tested without a server. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Send one artifact, if the user has enabled uploading.
 *
 * Never throws: an unreachable backend is a normal condition, not an error the
 * capture path should have to handle. The outcome is returned so the caller can
 * record it rather than guess.
 */
export async function uploadArtifact(deps: UploadDeps): Promise<UploadOutcome> {
  const { settings, hash, bytes } = deps;
  if (!settings.uploadEnabled) return { status: "skipped", reason: "upload is off" };
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
    return { status: "skipped", reason: "outside the size cap" };
  }

  let endpoint: string;
  try {
    // Built with `URL` rather than string concatenation, so a backendUrl with a
    // trailing slash, a path or a port behaves the way the user expects.
    endpoint = new URL("/api/artifacts", settings.backendUrl).href;
  } catch {
    return { status: "skipped", reason: `backendUrl is not a URL: ${settings.backendUrl}` };
  }

  const send = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? UPLOAD_TIMEOUT_MS);

  try {
    const response = await send(endpoint, {
      method: "POST",
      // Raw bytes, never a JSON array of numbers: the first prototype did the
      // latter and paid roughly 4x inflation for it.
      headers: { "content-type": "application/octet-stream", "x-artifact-hash": hash },
      body: bytes as unknown as BodyInit,
      signal: controller.signal,
    });

    if (!response.ok) {
      return { status: "failed", reason: `backend replied ${response.status}` };
    }

    const body = (await response.json()) as { status?: string; job_id?: string };
    if (body.status === "known") return { status: "known" };
    if (typeof body.job_id === "string") return { status: "uploaded", jobId: body.job_id };
    return { status: "failed", reason: "backend reply had no job id" };
  } catch (error) {
    // An unreachable backend, a CORS refusal and a timeout all land here, and
    // none of them is worth more than a line in the activity feed.
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "failed", reason };
  } finally {
    clearTimeout(timer);
  }
}
