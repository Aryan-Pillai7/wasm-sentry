# Architecture

Wasm-Sentry is a seven-stage pipeline split across three execution contexts. This
document describes the target design and marks which parts exist today.

```
  page main world          extension                     optional backend
  ───────────────          ─────────                     ────────────────
  WebAssembly.*  ─┐
   hook           │
  Worker shim ────┼─► bridge ─► service worker ─► IndexedDB
   (same hooks)   │                  │
  webRequest ─────┘                  │
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

Three observers, because none is sufficient alone.

**Main-world API hook** (`extension/src/content/`). A `"world": "MAIN"` content
script at `document_start` wraps the five entry points a module can reach the
engine through. It sees the exact bytes handed to the engine, including modules
that never touch the network.

**Worker instrumentation** (`extension/src/content/worker-hooks.ts`). Content
scripts do not run inside Web Workers, so the same hooks are carried in: the
`Worker` constructor is wrapped, and each worker starts from a `blob:` shim
that loads the hooks and then the script the page asked for. Captures travel
back over `postMessage` on a private channel that is intercepted before any page
listener can see it. A worker whose shim is refused -- a Content Security Policy
that forbids `blob:` workers -- runs untouched and falls back to being reported
as `network-only`.

**Script observation** (`extension/src/content/script-hooks.ts`), *off by
default*. Every other capture path sees only what the page has already
published to itself; this one reads the source of scripts the page wrote, which
on an authenticated page can carry far more of somebody's private business than
a compiled module does. So it is the one path the user switches on.

External scripts are never fetched or read. What is recorded about them is
origin, third-partyness and whether they carry Subresource Integrity -- facts
already in the markup, and what the supply-chain rule needs. What *is* read is
inline source and `new Function` bodies: code the page assembled itself, which
never crossed the network, and where an obfuscated loader lives. `eval` is
deliberately not hooked -- wrapping it converts every direct call in the page
into an indirect one and changes its scoping.

**Network observer** (service worker). A `webRequest.onCompleted` listener that
records Wasm-typed responses as metadata only — it never re-fetches. Its job is
to notice what the hooks missed, so the report can say "one module was
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

### 3a. JavaScript analysis — *complete, opt-in*

A lexical scan rather than an AST: no parser dependency, no stack to overflow on
hostile input, and every property the rules need survives at that level.

The hard part was calibration, and it is the opposite problem to WebAssembly.
Almost nothing compiled looks like a mining kernel; almost *all* production
JavaScript looks obfuscated to a naive test -- minified to one enormous line,
full of one-character identifiers and opaque literals. Measuring real bundles
found the separator: **escape density**. A minifier has no reason to escape
anything (`ajv.min.js`: 0.93% with a 119,360-character line), while an
obfuscator escapes nearly everything (54-99%). See
[`detection.md`](detection.md).

Source is measured and discarded. Only the measurements and the verdict are
stored, and JavaScript is never uploaded regardless of the upload setting.

### 4. Heuristics — *complete*

Rules over those features, each producing evidence with the numbers that
triggered it rather than a bare verdict. Calibrated against real compiled
output, which is where the design earned its shape: a legitimate Rust image
codec contains a loop that is statically indistinguishable from a hashing
kernel, so density alone can never reach the top band and escalation requires
corroborating infrastructure. See [`detection.md`](detection.md).

This is the explainable baseline, and the bar the classifier has to beat.

### 5. Runtime monitoring — *complete*

Static analysis took the detector as far as static analysis goes, and
calibration established exactly where that is: a legitimate image codec contains
a loop statically indistinguishable from a hashing kernel. What separates them
is that one runs flat out for minutes.

Four things are measured, from inside the page's own world and inside every
instrumented worker:

- **Time inside a module's exports.** The instance's exports namespace is
  reproduced with each function wrapped in a timer. Timing switches itself off
  for a module called tens of thousands of times with a mean in the
  microseconds -- a library being used, not a kernel being run -- after which
  the accumulated total is reported as a floor and every finding built on it
  says so.
- **Scheduler starvation.** A timer asked for every second, and how late it
  actually arrives. A context executing a tight loop cannot run its own timers
  on time, and unlike a CPU reading this needs no permission.
- **Worker fan-out.** How many separate contexts are executing the same module,
  judged against `hardwareConcurrency` rather than a fixed number.
- **Socket activity.** Opens and message counts only -- never URLs, never
  payloads. A mining pool hands out work and takes back shares this way.

Samples are keyed by the page-side fingerprint, because the page cannot compute
a hash (`crypto.subtle` is undefined over plain http); the service worker joins
them back to the content hash from the captures it already accepted. Reports are
cumulative per context, so a context that dies takes nothing with it and a
duplicate cannot double-count.

When the evidence moves, the module is re-analysed from its stored bytes and
re-scored through the same rule pass -- not patched -- because
`mining-runtime-corroborated` has to see the static kernel and the measured
execution together.

### 6. AI classification — *pipeline complete, no model shipped*

A logistic regression over the same `ModuleFeatures` the rules read: a versioned
vector of measurements and opcode shares, standardised, fitted offline, shipped
as a few kilobytes of JSON that inference reads with a dot product. Linear
deliberately -- a model whose reasons are a list of columns and how much each
one moved the score keeps the promise every rule in this project keeps, and
"the model said so" does not.

**No model is shipped, and this is not a code problem.** Training one honestly
needs a labelled corpus of benign and verified-malicious modules that does not
exist here yet. Everything around that corpus is built: vectoriser, trainer,
k-fold evaluation, a CLI, and the socket in the extension a model drops into.

Two things are enforced rather than left to whoever runs it. Standardisation is
fitted **inside each fold**, because fitting it over the whole corpus leaks the
test set's distribution into training and flatters every number afterwards. And
the evaluation always scores the heuristics on the same folds, so the model is
reported against the baseline it has to beat -- including when it loses, which
the CLI says in those words.

The `classifier-opinion` rule is weighted below every corroborated rule,
permanently. A model is an opinion about a module; the rules are measurements of
one.

### 7. Risk aggregation and Privacy Scorecard — *complete*

Findings are combined into a banded score that saturates, so corroborated
evidence outranks accumulated hints. The score is never shown alone: it ships
with the findings that produced it and with a coverage figure, because a verdict
a user cannot interrogate is a verdict they cannot act on. Runtime findings go
through the same aggregation, which needed no redesign to take them: it was
always a function of an arbitrary finding list.

## Storage

**Extension (IndexedDB, schema v4).** `artifacts` keyed by content hash holds
metadata only, with the bytes in a separate `blobs` store so that listing every
module ever seen never deserialises megabytes of WebAssembly; `sightings`
records every time a hash was seen and where; `notes` covers artifacts observed
but not analysed, with the reason; `results` holds verdicts; `events` is a
capped append-only activity log across all tabs, which is what lets the
dashboard show the extension working rather than leaving the user to infer it;
`runtime` holds the latest report from each reporting context, and
`fingerprints` maps the page-side fingerprint those reports are keyed by to the
content hash everything else is keyed by. Retention is bounded by a
least-recently-seen eviction pass.

Keeping the bytes is what makes re-scoring possible: runtime evidence arrives
tens of seconds after the capture, and re-running the rules needs the module
again.

**Backend (SQLite).** `artifacts` keyed by content hash, with the bytes, so a
rule change can be re-run without the browser ever seeing the module again;
`jobs` is the queue itself, which is why a restart resumes rather than forgets;
`results` holds one verdict per artifact. Schema in
`backend/src/db/schema.sql`, driven by Node's built-in `node:sqlite` — a backend
that needs a compiler toolchain to install is a backend nobody runs.

## Design constraints

**Never change what the page observes.** Hooks call through with the arguments
they were given, swallow their own exceptions, and defer capture work off the
critical path.

There are exactly two deliberate exceptions, both of which buy something static
analysis cannot: an instrumented worker starts from a shim rather than its own
script, and an instrumented module's exports are wrapped in timers. Both restore
everything they can -- base URLs, message ordering, export names, arity, key
order, frozen null-prototype namespaces -- both fall back to the untouched path
on any failure, and both have an off switch, which nothing else in the capture
layer needs.

**Content hash is identity.** URLs are attacker-controlled, cache-busted and
sometimes single-use. The hash is none of those things.

**MV3 lifecycle is not fought.** The service worker is killed after ~30s idle.
Rather than a keepalive, every handler is short, stateless and writes through to
IndexedDB, and the badge is recomputed from storage rather than a counter that
would not survive.

**Local-first.** Analysis runs in the extension. Upload is opt-in.

**Interrupt sparingly.** The badge is the ambient channel and costs nothing;
desktop notifications are reserved for the high and critical bands and
de-duplicated per site and module, because a tool that notifies on every page
trains its user to dismiss it unread.
