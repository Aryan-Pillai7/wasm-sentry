# Wasm-Sentry

An in-browser auditor for WebAssembly modules and JavaScript bundles.

Wasm-Sentry watches the code a page actually executes — including modules that
never touch the network — disassembles it, and explains what it does in terms a
person can act on. It is built as a Chrome MV3 extension with a shared analysis
engine that runs unchanged in the browser, in Node, and in tests.

> Status: Phase 1 of 5. The capture layer is complete and tested; static
> analysis, heuristics and scoring are in progress. See
> [`docs/architecture.md`](docs/architecture.md) for the full pipeline.

## Layout

| Path | What it is |
|---|---|
| `core/` | `@wasm-sentry/core` — format sniffing, hashing, and (from Phase 2) the Wasm parser, feature extractor and heuristics. Zero runtime dependencies. |
| `extension/` | Chrome MV3 extension: main-world capture hook, service worker, popup. |
| `backend/` | Optional Node service for opt-in deep analysis. |
| `docs/` | Architecture and API documentation. |

The three packages are npm workspaces, so a single `npm install` at the root
wires them together and `@wasm-sentry/core` resolves by name from both consumers.

## Getting started

```bash
npm install
npm run build      # core -> extension -> backend
npm test           # core + extension unit tests
```

Then load the extension:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select `extension/dist`.
3. Visit a page that uses WebAssembly and open the Wasm-Sentry popup.

Chrome 111 or newer is required — the capture hook relies on `"world": "MAIN"`
content scripts.

The backend is optional and off by default:

```bash
npm run dev -w backend    # http://localhost:3000/health
```

## How capture works

WebAssembly reaches the engine through five entry points, and Wasm-Sentry wraps
all of them in the page's own JavaScript world before any page script runs:
`WebAssembly.instantiate`, `instantiateStreaming`, `compile`, `compileStreaming`
and `new WebAssembly.Module`.

This is deliberately not a `webRequest` re-fetch of the module URL. Re-fetching
misses everything that never crosses the network — `blob:` and `data:` URLs,
and bytes pulled over XHR or a WebSocket and compiled from memory, which is a
known cryptojacking pattern — and it cannot guarantee the bytes it analyses are
the bytes that ran. Hooking the API gets the exact buffer the engine received.

Artifacts are identified by the SHA-256 of their contents, never by URL, so one
module served under a thousand cache-busted URLs is analysed once.

## Privacy

Analysis runs locally in the extension. Captured bytes stay in the browser's
IndexedDB unless you explicitly enable upload in settings, because the modules a
page executes can be private by nature — an internal build, an authenticated
app — and a security tool that ships them off by default is an exfiltration
channel wearing a badge.

## Licence

ISC
