import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadArtifact } from "../src/background/upload";

/**
 * Uploading is the one thing this extension does that leaves the machine, so
 * what is under test is mostly restraint: that it does nothing at all unless
 * the user asked, that a broken backend costs nothing, and that when it does
 * send, it sends raw bytes to the address the user configured.
 */

const HASH = "a".repeat(64);
const BYTES = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

const ON = { uploadEnabled: true, backendUrl: "http://localhost:3000" };
const OFF = { uploadEnabled: false, backendUrl: "http://localhost:3000" };

function recorder(reply: unknown, status = 202) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("nothing is sent unless the user turned uploading on", async () => {
  const { calls, fetchImpl } = recorder({});
  const outcome = await uploadArtifact({ settings: OFF, hash: HASH, bytes: BYTES, fetchImpl });

  assert.equal(outcome.status, "skipped");
  assert.equal(calls.length, 0, "not one request, not even a preflight");
});

test("an enabled upload sends raw bytes with the hash we computed", async () => {
  const { calls, fetchImpl } = recorder({ job_id: "job_1", status: "queued" });
  const outcome = await uploadArtifact({ settings: ON, hash: HASH, bytes: BYTES, fetchImpl });

  assert.deepEqual(outcome, { status: "uploaded", jobId: "job_1" });
  assert.equal(calls.length, 1);

  const { url, init } = calls[0]!;
  assert.equal(url, "http://localhost:3000/api/artifacts");
  assert.equal(init.method, "POST");

  const headers = init.headers as Record<string, string>;
  // Raw octets, never a JSON array of numbers -- that cost roughly 4x in the
  // first prototype and is why its body limit had to be 50 MB.
  assert.equal(headers["content-type"], "application/octet-stream");
  assert.equal(headers["x-artifact-hash"], HASH);
  assert.equal(init.body, BYTES);
});

test("a backend URL with a path or a trailing slash still resolves", async () => {
  const { calls, fetchImpl } = recorder({ job_id: "job_1" });
  await uploadArtifact({
    settings: { uploadEnabled: true, backendUrl: "https://sentry.internal:8443/base/" },
    hash: HASH,
    bytes: BYTES,
    fetchImpl,
  });
  assert.equal(calls[0]!.url, "https://sentry.internal:8443/api/artifacts");
});

test("a backend URL that is not a URL is skipped, not thrown", async () => {
  const { calls, fetchImpl } = recorder({});
  const outcome = await uploadArtifact({
    settings: { uploadEnabled: true, backendUrl: "not a url" },
    hash: HASH,
    bytes: BYTES,
    fetchImpl,
  });

  assert.equal(outcome.status, "skipped");
  assert.equal(calls.length, 0);
});

test("a module the backend already has is reported as known, not as a failure", async () => {
  const { fetchImpl } = recorder({ status: "known" }, 200);
  const outcome = await uploadArtifact({ settings: ON, hash: HASH, bytes: BYTES, fetchImpl });
  assert.deepEqual(outcome, { status: "known" });
});

test("an unreachable backend is a normal condition, not an exception", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  const outcome = await uploadArtifact({ settings: ON, hash: HASH, bytes: BYTES, fetchImpl });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /Failed to fetch/);
});

test("an error status is surfaced with its code rather than swallowed", async () => {
  const { fetchImpl } = recorder({ error: "nope" }, 413);
  const outcome = await uploadArtifact({ settings: ON, hash: HASH, bytes: BYTES, fetchImpl });
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.reason : "", /413/);
});

test("a backend that hangs is abandoned rather than holding the worker", async () => {
  const fetchImpl = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  const outcome = await uploadArtifact({
    settings: ON,
    hash: HASH,
    bytes: BYTES,
    fetchImpl,
    timeoutMs: 10,
  });
  assert.equal(outcome.status, "failed");
});

test("an artifact outside the size cap is not sent", async () => {
  const { calls, fetchImpl } = recorder({});
  const outcome = await uploadArtifact({
    settings: ON,
    hash: HASH,
    bytes: new Uint8Array(17 * 1024 * 1024),
    fetchImpl,
  });

  assert.equal(outcome.status, "skipped");
  assert.equal(calls.length, 0);
});
