# Testbed

A page that loads WebAssembly through every entry point the extension hooks, so
capture, parsing and scoring can be checked end to end.

```bash
npm run testbed     # emits the fixtures and serves this directory on :8080
```

Then open <http://localhost:8080>, click **Run all**, and open the Wasm-Sentry
popup.

The `.wasm` files are generated from `core/test/fixtures.ts` and are gitignored;
`npm run fixtures` regenerates them without starting a server.

## What each fixture is

| File | Shape | Expected verdict |
|---|---|---|
| `benign.wasm` | float arithmetic, no loops | 0/100 benign |
| `kernel-only.wasm` | a short integer loop, nothing else | below the high band — a bare loop is not evidence |
| `miner-no-threads.wasm` | integer kernel + pool import | ~51/100 high |
| `miner.wasm` | integer kernel + shared memory + atomics + pool import | ~63/100 high |

The "miner" fixtures compute nothing: their accumulator stays zero and the loop
exits on the first iteration. They are shaped like a mining kernel so the
detector has something honest to fire on without a real malware sample being
committed to the repository.
