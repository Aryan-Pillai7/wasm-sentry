# Wasm-Sentry extension

Chrome MV3 extension. See the [root README](../README.md) for setup and the
[architecture doc](../docs/architecture.md) for how the pieces fit.

## Build

```bash
npm run build -w extension    # from the repository root
```

Output lands in `dist/`. Load it with **Load unpacked** at `chrome://extensions`
with Developer mode on. Chrome 111+ is required for `"world": "MAIN"` content
scripts.

Two build tools, split by responsibility: Vite owns HTML entry points, esbuild
owns the three script entries — Rollup will not emit several IIFE bundles from
one multi-entry build, and MV3 content scripts cannot be ES modules. See
`scripts/build-scripts.mjs`.

## Entry points

| File | World | Role |
|---|---|---|
| `src/content/injector.ts` | page MAIN | Installs the WebAssembly hooks at `document_start`. |
| `src/content/capture-hooks.ts` | — | The interception logic, with globals injected so it is unit-testable. |
| `src/content/bridge.ts` | ISOLATED | Relays captures to the service worker, base64 encoding on the way. |
| `src/background/service-worker.ts` | extension | Trust boundary, analysis, storage, scorecard. |
| `src/popup/popup.tsx` | extension | Privacy Scorecard UI. |

## Test

```bash
npm test -w extension
```
