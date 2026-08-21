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

### 2. Disassembly — *Phase 2*

A pure-TypeScript streaming parser in `@wasm-sentry/core` walks the binary's
sections and decodes function bodies into instructions. Emitting WAT is a view
over that decode, not a separate tool: it keeps the engine dependency-free, so
the same code runs in the extension, in the backend and under `node --test`.

### 3. Static analysis — *Phase 2*

Per-module features (imports, exports, memory declarations, opcode histograms,
instruction n-grams) and a control-flow graph per function, from which loop
structure and nesting depth fall out.

### 4. Heuristics — *Phase 3*

Rules over those features: integer/rotate opcode density typical of hashing
inner loops, unbounded memory growth, WebSocket imports paired with worker
fan-out, and the structural signatures of known mining families. This is the
explainable baseline, and the bar the classifier has to beat.

### 5. Runtime monitoring — *Phase 4*

API call tracing and CPU sampling from the page world, correlated back to the
module that caused them.

### 6. AI classification — *Phase 5*

An opcode-sequence model over the Phase 3 feature pipeline. It runs last on
purpose: without the feature extractor and a labelled corpus it has nothing to
learn from, and without the heuristic baseline there is nothing to compare it
against.

### 7. Risk aggregation and Privacy Scorecard — *Phase 3 onward*

Findings from every stage are combined into a single banded score with the
evidence attached, because a verdict a user cannot interrogate is a verdict they
cannot act on.

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
