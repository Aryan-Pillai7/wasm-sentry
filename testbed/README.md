# Testbed

A page that loads WebAssembly through every entry point the extension hooks --
in the page and inside Web Workers -- so capture, parsing and scoring can be
checked end to end.

```bash
npm run testbed     # emits the fixtures and serves this directory on :8080
```

Then open <http://localhost:8080>, click **Run all**, and open the Wasm-Sentry
popup.

## Two pages

`index.html` is the full path: the extension must be loaded and reloaded, and
what you are checking is capture, analysis, the badge, the notification and the
popup, end to end.

`standalone.html` needs no extension at all. It loads the built
`extension/dist/injector.js` with a plain script tag -- exactly what the
extension injects at `document_start` -- listens for the messages it posts, and
checks each capture path itself. It covers only the first hop, but that is the
hop worker instrumentation lives in, and it is the fastest way to find out
whether the shim broke something. Run `npm run build` first, or the injector
will not be there to copy.

The `.wasm` files are generated from `core/test/fixtures.ts` and are gitignored;
`npm run fixtures` regenerates them without starting a server.

## What each fixture is

| File | Shape | Expected verdict |
|---|---|---|
| `benign.wasm` | float arithmetic, no loops | 0/100 benign |
| `kernel-only.wasm` | a short integer loop, nothing else | below the high band — a bare loop is not evidence |
| `miner-no-threads.wasm` | integer kernel + pool import | ~51/100 high |
| `miner.wasm` | integer kernel + shared memory + atomics + pool import | ~63/100 high |

## The worker buttons

Buttons 7 to 9 cover worker instrumentation, which is the one part of the
capture layer that changes how a page loads its own code. Each is a different
way that swap could go wrong:

| Button | What it checks |
|---|---|
| 7. inside a Worker | A classic worker. Expect a module tagged **in a Worker**, not a "not analysed" note. |
| 8. inside a module Worker | A module worker's two loads are awaited, so the shim buffers the page's `postMessage` and re-dispatches it. If the buffer is wrong, the worker never replies. |
| 9. a Worker inside a Worker | Captures bubble up one hop at a time, and the parent's relative `fetch` still resolves against its own URL rather than the blob it was started from. |

None of the three may deliver one of our own messages to a page handler. The
log lines come from the workers themselves, so a spurious extra line would mean
an internal message leaked.

The "miner" fixtures compute nothing: their accumulator stays zero and the loop
exits on the first iteration. They are shaped like a mining kernel so the
detector has something honest to fire on without a real malware sample being
committed to the repository.
