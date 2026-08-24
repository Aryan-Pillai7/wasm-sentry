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

### `GET /health` — *implemented*

```json
{ "status": "ok", "service": "wasm-sentry-backend", "version": "0.1.0" }
```

### Planned — Phase 2

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/artifacts` | Upload artifact bytes as `application/octet-stream`, keyed by the `X-Artifact-Hash` header. Returns `{ job_id, status }`, or `{ status: "known" }` if the hash has already been analysed. |
| `GET` | `/api/jobs/:id` | Job status. |
| `GET` | `/api/results/:hash` | Analysis result for an artifact. |

Artifacts are sent as raw bytes, never as a JSON number array. The first
prototype did the latter and paid a 4x inflation for it, which is why its body
limit had to be 50 MB.
