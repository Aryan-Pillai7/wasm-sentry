# API specification

Two interfaces: the internal message protocol inside the extension, and the HTTP
API of the optional backend.

## Extension message protocol

Defined in `extension/src/shared/protocol.ts`. Two hops:

```
page main world  --window.postMessage-->  isolated content script
isolated script  --chrome.runtime-------> service worker
```

### Hop 1 — main world to bridge

```ts
{
  channel: "wasm-sentry:capture:v1",
  api: "instantiate" | "instantiateStreaming" | "compile" | "compileStreaming" | "Module",
  url: string,        // source URL, or "inline:<api>" for bytes with no URL
  pageUrl: string,
  size: number,
  context?: "page" | "worker",   // absent means "page"
  bytes: Uint8Array,  // absent on a skip message
  skipped?: "too-large" | "rate-limited" | "read-failed",
}
```

A capture with `context: "worker"` was intercepted inside a Web Worker and
forwarded to the main world over a third channel:

```
worker global scope --self.postMessage--> main world (worker hook)
{ channel: "wasm-sentry:worker:v1", capture: { api, url, size, bytes } }
```

That hop is intercepted by a listener registered when the worker is constructed,
before page code can attach one, and stopped there — the page never observes a
message it did not send.

This hop is observable and forgeable by the page — anything in the main world
shares a global object with the hook. Nothing is leaked by the disclosure (the
page already owns the bytes), and forgery is bounded rather than prevented: the
service worker enforces size and rate caps and re-hashes every payload.

### Hop 2 — bridge to service worker

`chrome.runtime.sendMessage` serialises with a JSON-shaped algorithm rather than
structured clone, so a `Uint8Array` would arrive as an object with numeric keys
at roughly 4x the size. Bytes are base64 encoded for this hop instead, at a
predictable 4/3.

| Message | Payload | Reply |
|---|---|---|
| `wasm-sentry:capture` | `{ api, url, pageUrl, size, bytesB64, context? }` | `{ ok, hash? , reason? }` |
| `wasm-sentry:skipped` | `{ api, url, pageUrl, size, reason, context? }` | `{ ok: true }` |
| `wasm-sentry:runtime` | `{ contextId, pageUrl, report }` | `{ ok, rescored }` |
| `wasm-sentry:tab-report` | `{ tabId }` | `TabReport` |

`TabReport` carries one row per distinct artifact hash seen in the tab, plus the
notes for artifacts that were observed but not analysed.

A `RuntimeReport` is the whole state of one reporting context -- the page, or one
worker -- sent every ten seconds:

```ts
{
  context: "page" | "worker",
  observedMs: number,              // how long this context has been watched
  drift: { samples, lateMs, maxLateMs },   // how starved its event loop is
  workerCount, socketCount, socketMessages, hardwareConcurrency: number,
  modules: Array<{
    fingerprint: string,           // page-side, not the hash -- see below
    wasmTimeMs, callCount, longestCallMs: number,
    timingStopped: boolean,        // if true, wasmTimeMs is a floor
  }>,
}
```

Cumulative rather than incremental, so a context killed between reports takes
nothing with it and a duplicate cannot double-count. Keyed by the page-side
fingerprint because `crypto.subtle` is undefined over plain http; the service
worker joins it to the content hash from the captures it already accepted, and
drops any report it cannot attribute.

Limits: `MAX_ARTIFACT_BYTES` = 16 MiB, `MAX_CAPTURES_PER_MINUTE` = 60 per frame.

## Backend HTTP API

Base URL `http://localhost:3000` by default. Used only when the user enables
upload.

### `GET /health`

```json
{ "status": "ok", "service": "wasm-sentry-backend", "version": "0.2.0",
  "queued": 0, "running": 0 }
```

The queue depth is part of the answer. A health check that cannot say whether
work is piling up is a liveness check wearing a health check's name.

### `POST /api/artifacts`

Body is the module itself as `application/octet-stream`, up to 16 MiB — the same
cap the capture layer enforces. `X-Artifact-Hash` is optional and is treated as
a *claim*: the bytes are hashed here regardless, and a mismatch is refused.

| Status | Meaning |
|---|---|
| `202` | `{ job_id, status: "queued", hash }` — accepted and queued. |
| `200` | `{ status: "known", hash }` — already analysed. The verdict is a function of the bytes and the bytes have not changed. |
| `400` | Empty body. |
| `409` | `X-Artifact-Hash` does not match the bytes received. The reply carries the hash the server computed. |
| `415` | Not a WebAssembly module, by magic bytes rather than by declared type. |

Artifacts are sent as raw bytes, never as a JSON number array. The first
prototype did the latter and paid a 4x inflation for it, which is why its body
limit had to be 50 MB.

A `409` is not a security control — the server never trusts the claim in the
first place. It exists because a mismatch means the two ends disagree about
which module they are discussing, and that is worth failing on rather than
resolving silently.

### `GET /api/jobs/:id`

```json
{ "job_id": "job_…", "hash": "7301f5…", "status": "complete",
  "created_at": 0, "started_at": 0, "finished_at": 0 }
```

`status` is `queued`, `running`, `complete` or `failed`; a failed job carries an
`error`. `404` if there is no such job.

### `GET /api/results/:hash`

```json
{ "hash": "7301f5…", "level": "high", "score": 63,
  "analysis": { "…": "the same ArtifactAnalysis the extension stores" },
  "analysed_at": 0 }
```

`400` if the hash is not 64 hex characters. `404` carries `known`, saying
whether the server has the bytes but no verdict yet — which is what a client
deciding between waiting and uploading needs to know.

### Notes on the implementation

- **The same engine.** Analysis is `@wasm-sentry/core`, unchanged, so a verdict
  computed here is the verdict the extension would have reached. `miner.wasm`
  scores 63/100 in both.
- **One job at a time.** Analysis is CPU-bound and synchronous — the engine is
  built that way so it can run inside an MV3 service worker — so two at once on
  one thread finishes neither sooner. Scaling means more processes.
- **The queue is in SQLite**, so a restart resumes. A job left `running` by a
  crash is re-queued on the next start; analysis is deterministic, so re-running
  one costs a parse.
