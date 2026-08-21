# Wasm-Sentry

An in-browser auditor for WebAssembly modules and JavaScript bundles.

Wasm-Sentry watches the code a page actually executes — including modules that
never touch the network — disassembles it, and explains what it does in terms a
person can act on. It is built as a Chrome MV3 extension with a shared analysis
engine that runs unchanged in the browser, in Node, and in tests.

> Status: Phase 3 of 5. Capture, disassembly, static analysis, heuristic
> detection and the Privacy Scorecard are complete and tested; runtime
> monitoring and the ML classifier are next. See
> [`docs/architecture.md`](docs/architecture.md) for the full pipeline.

## Layout

| Path | What it is |
|---|---|
| `core/` | `@wasm-sentry/core` — format sniffing, hashing, the Wasm parser, CFG builder, WAT renderer and feature extractor. Zero runtime dependencies. |
| `extension/` | Chrome MV3 extension: main-world capture hook, service worker, popup. |
| `backend/` | Optional Node service for opt-in deep analysis. |
| `docs/` | [Architecture](docs/architecture.md), [design decisions](docs/design-decisions.md), [detection rules](docs/detection.md), [API spec](docs/api-spec.md) and a handover [context note](docs/CONTEXT.md). |

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

## Analysis

Captured modules are parsed in the extension by a dependency-free TypeScript
decoder: sections, imports and exports, every function body, and an exact
control flow graph per function. WAT is rendered from that same decode rather
than by a second tool, so the listing you read is the decode the detector
reasoned about.

Findings are then produced by rules over that feature vector — each one carrying
the numbers that triggered it — and combined into a banded Privacy Scorecard.
Thresholds are calibrated against real compiled output rather than guessed; see
[`docs/detection.md`](docs/detection.md), including the false positive that
reshaped the design.

You can point the parser at any module from the command line:

```bash
npm run inspect -w @wasm-sentry/core -- path/to/module.wasm
```

## Seeing it work

Analysis runs on every page load with no interaction. Three places show it:

**The dashboard** (right-click the extension → Options, or the button in the
popup) is the full view: a live status panel, an activity feed of every capture
and verdict across all tabs, every module ever seen with its findings and
disassembly, and the settings toggles. It refreshes on its own.

**The toolbar badge** is the ambient signal: modules on the current page,
coloured by the worst verdict — blue for benign or low, amber for medium, red
for high, dark red for critical. Pin the extension or the badge is hidden in the
puzzle-piece menu.

**A desktop notification** fires only for the high and critical bands, names the
finding rather than just the score, and is de-duplicated per site and module so
a reload never notifies twice. Turn it off with the `notifyOnHighRisk` setting.

The popup is only needed for per-page detail.

## Privacy

Analysis runs locally in the extension. Captured bytes stay in the browser's
IndexedDB unless you explicitly enable upload in settings, because the modules a
page executes can be private by nature — an internal build, an authenticated
app — and a security tool that ships them off by default is an exfiltration
channel wearing a badge.

## Licence

ISC
