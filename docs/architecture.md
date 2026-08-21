# Architecture

Wasm-Sentry is a seven-stage pipeline split across three execution contexts. This
document describes the target design and marks which parts exist today.

```
  page main world          extension                     optional backend
  ───────────────          ─────────                     ────────────────
  WebAssembly.*  ─┐
   hook           ├─► bridge ─► service worker ─► IndexedDB
  webRequest ─────┘                   │
                                      ├─► analysis engine (@wasm-sentry/core)
                                      │      parse → features → CFG
                                      │      heuristics → risk score
                                      │
                                      ├─► popup (Privacy Scorecard)
                                      │
                                      └─► upload (opt-in) ─► SQLite + job queue
                                                             ML classifier
```

## Layers

### 1. Capture — *complete*

Two independent observers, because neither is sufficient alone.

**Main-world API hook** (`extension/src/content/`). A `"world": "MAIN"` content
script at `document_start` wraps the five entry points a module can reach the
engine through. It sees the exact bytes handed to the engine, including modules
that never touch the network. It cannot see modules compiled inside a Web
Worker, where content scripts do not run.

**Network observer** (service worker). A `webRequest.onCompleted` listener that
records Wasm-typed responses as metadata only — it never re-fetches. Its job is
to notice what the main-world hook missed, so the report can say "one module was
not analysed" instead of quietly claiming a clean page.

The two hops between contexts are described in
`extension/src/shared/protocol.ts`. The first hop crosses into the page's world
and is therefore forgeable; the service worker treats everything from it as
untrusted input, re-sniffs the format and re-hashes the bytes itself.

### 2. Disassembly — *complete*

A pure-TypeScript parser in `@wasm-sentry/core` walks the binary's sections and
decodes function bodies into instructions. Emitting WAT is a view over that
decode, not a separate tool: it keeps the engine dependency-free, so the same
code runs in the extension, in the backend and under `node --test`, and the
listing a user reads is the same decode the detector reasoned about.

The decoder is total. It either returns a faithful instruction list or stops at
the first byte it cannot account for and says so; it never guesses an operand
width, because a wrong guess desynchronises the stream and every instruction
after it is fiction. A section that fails to parse costs that section, not the
module.

Measured on real-world output: 643 KB of Emscripten-compiled SQLite parses in
165 ms (1,879 functions, 285k instructions, no warnings); 2.4 MB of Rust
`wasm-bindgen` output in 399 ms (1,433 functions, 975k instructions).

### 3. Static analysis — *complete*

Per-module features (imports, exports, memory declarations, opcode histograms
by name and by category) and an exact control flow graph per function.

WebAssembly's control flow is structured -- no computed goto, every branch
targeting an enclosing frame by relative depth -- so the CFG is built in one pass
with none of the indirect-jump guesswork that makes native-binary CFG recovery
expensive, and a loop it reports is a loop the engine will actually execute.
Loop count, nesting depth, back edges and the "hottest" loop (largest body
weighted by bitwise density) fall out of it.

Analysis is budgeted: it stops after a fixed instruction count and reports how
many functions it skipped, so a hostile 50 MB module cannot hold the service
worker open.

### 4. Heuristics — *complete*

Rules over those features, each producing evidence with the numbers that
triggered it rather than a bare verdict. Calibrated against real compiled
output, which is where the design earned its shape: a legitimate Rust image
codec contains a loop that is statically indistinguishable from a hashing
kernel, so density alone can never reach the top band and escalation requires
corroborating infrastructure. See [`detection.md`](detection.md).

This is the explainable baseline, and the bar the classifier has to beat.

### 5. Runtime monitoring — *Phase 4*

API call tracing and CPU sampling from the page world, correlated back to the
module that caused them.

### 6. AI classification — *Phase 5*

An opcode-sequence model over the Phase 3 feature pipeline. It runs last on
purpose: without the feature extractor and a labelled corpus it has nothing to
learn from, and without the heuristic baseline there is nothing to compare it
against.

### 7. Risk aggregation and Privacy Scorecard — *complete for static findings*

Findings are combined into a banded score that saturates, so corroborated
evidence outranks accumulated hints. The score is never shown alone: it ships
with the findings that produced it and with a coverage figure, because a verdict
a user cannot interrogate is a verdict they cannot act on. Runtime findings join
the same aggregation in Phase 4.

## Storage

**Extension (IndexedDB).** `artifacts` keyed by content hash and holding the
bytes; `sightings` recording every time a hash was seen and where; `notes` for
artifacts observed but not analysed, with the reason; `results` for verdicts.
Retention is bounded by a least-recently-seen eviction pass.

**Backend (SQLite, Phase 2).** Sessions, jobs and results, per
`backend/src/db/schema.sql`.

## Design constraints

**Never change what the page observes.** Hooks call through with the arguments
they were given, swallow their own exceptions, and defer capture work off the
critical path.

**Content hash is identity.** URLs are attacker-controlled, cache-busted and
sometimes single-use. The hash is none of those things.

**MV3 lifecycle is not fought.** The service worker is killed after ~30s idle.
Rather than a keepalive, every handler is short, stateless and writes through to
IndexedDB, and the badge is recomputed from storage rather than a counter that
would not survive.

**Local-first.** Analysis runs in the extension. Upload is opt-in.
