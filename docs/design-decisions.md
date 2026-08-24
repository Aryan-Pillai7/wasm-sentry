# Design Decisions

Why the system is built the way it is: each significant choice, the alternatives
that were rejected, and — where it applies — the measurement that forced the
decision.

This is the companion to [`architecture.md`](architecture.md), which describes
*what* the pipeline does. This one covers *why*.

---

## 1. Architecture

### 1.1 A shared, dependency-free analysis core

**Decision.** All analysis lives in `@wasm-sentry/core`: a TypeScript package
with **zero runtime dependencies**, consumed unchanged by the browser extension,
the Node backend, and the test suite.

**Why.** The synopsis calls for analysis in three places — in-browser real-time,
server-side deep analysis, and offline evaluation against a corpus. Writing it
three times guarantees they drift apart, and a detector that disagrees with
itself depending on where it runs cannot be evaluated.

**Consequence.** The parser is exercised by `node --test` on every commit, runs
identically inside an MV3 service worker, and adds ~25 KB to the extension
bundle. No native binaries, no WASI shims, no build-target juggling.

**Alternative rejected.** Python backend with a JS shim in the extension — two
implementations, two threat models, and no way to run the same rule in both.

### 1.2 npm workspaces

Three packages (`core`, `extension`, `backend`) under one root install.
`@wasm-sentry/core` resolves by name from both consumers with no relative-path
imports crossing package boundaries and no publish step.

### 1.3 Vite and esbuild split by responsibility

Vite owns HTML entry points (the popup) because it handles asset graphs.
esbuild owns the three script entries. This is not arbitrary: **Rollup will not
emit several IIFE bundles from one multi-entry build**, and MV3 content scripts
**cannot be ES modules**. The two tools split along that constraint rather than
fighting over it. Build time for the scripts is ~15 ms.

---

## 2. Capture layer (Phase 1)

### 2.1 Hooking the WebAssembly API instead of re-fetching the URL

**The first iteration** detected Wasm by URL suffix (`url.endsWith(".wasm")`)
and then called `fetch(url)` a second time to obtain the bytes.

**Three things go wrong with that**, and each one is exactly where an evasive
miner lives:

1. **The bytes analysed need not be the bytes that ran.** One-time tokens, auth
   headers and server-side A/B switches all make the second fetch return
   something different.
2. **It cannot see anything off-network.** `blob:` URLs, `data:` URLs, and
   `WebAssembly.instantiate(buffer)` on bytes pulled over XHR or a WebSocket
   never touch `webRequest`. Fetching a payload over a socket and compiling it
   from memory is a documented cryptojacking pattern.
3. **It doubles bandwidth** on the user's connection for every module.

**Decision.** A `"world": "MAIN"` content script at `document_start` wraps all
five entry points through which a module can reach the engine:
`WebAssembly.instantiate`, `instantiateStreaming`, `compile`,
`compileStreaming`, and `new WebAssembly.Module`. It sees the exact buffer the
engine receives.

**Cost.** Requires Chrome 111+. Content scripts do not run inside Web Workers,
so a module compiled in a worker is not seen by this hook — reported honestly in
§2.6, and reached in §2.6a.

### 2.2 Never change what the page observes

Hard rule for every hook:

- the real function is always called with the arguments it was given;
- our own exceptions are swallowed — a broken transport must never surface as a
  page-visible error (there is a test for this);
- capture work is deferred off the critical path via `queueMicrotask`;
- bytes are **copied before deferring**, because the caller owns the buffer and
  may reuse or detach it the moment the call returns;
- each of the five hooks installs independently, so a page that deleted one
  entry point does not cost us the other four.

### 2.3 Streaming capture without consuming the engine's copy

`instantiateStreaming` takes a `Response`. `Response.clone()` throws once the
body has started draining, so cloning after handing the response to the engine
is a race we would lose.

The wrapper therefore **awaits the response itself, clones it, then calls
through**. The page cannot observe the extra microtask — both functions already
return promises. There is a test asserting `bodyUsed === false` on the response
the engine receives, and that its bytes still read back correctly.

### 2.4 `WebAssembly.Module` wrapped in a Proxy, not a subclass

A `Proxy` with a `construct` trap forwards `new` correctly, keeps `instanceof`
working for page code, and leaves the static helpers (`Module.imports`,
`Module.exports`, `Module.customSections`) untouched. A subclass would break at
least one of those.

### 2.5 Content hash is identity, not the URL

Every artifact is keyed by the **SHA-256 of its bytes**. The same module served
from a CDN under a thousand cache-busted URLs is one row, parsed once. A
one-time-token URL that refuses a second fetch is still analysable because we
captured the bytes rather than the address. Analysis is cached by hash, so a
module already characterised on another site costs nothing on the next.

### 2.6 The network observer records blind spots rather than fetching

`webRequest.onCompleted` is still listened to, but it **never fetches
anything**. Its only job is to notice Wasm-typed responses the main-world hook
could not see — most importantly modules compiled inside a Web Worker. These
are recorded as `network-only` notes and surfaced in the popup as *"not
analysed"*.

**Why this matters:** the alternative is silently reporting a clean page. A
security tool that under-reports its own coverage is worse than one that reports
nothing.

### 2.6a Carrying the hooks into Web Workers

§2.6 above describes the blind spot as a reporting problem: content scripts do
not run in workers, so a module compiled in one was recorded as `network-only`
rather than analysed. That was the honest interim answer. It is not a good
permanent one, because **worker fan-out is how one page saturates every core** --
the modules most worth analysing are exactly the ones a worker would hold.

**Decision.** Wrap the `Worker` constructor in the main world and start each
worker from a `blob:` shim that loads the capture hooks first and the script the
page asked for second.

**Why a shim and not something less invasive.** There is nothing less invasive.
`chrome.scripting` cannot target workers, worker scripts must be same-origin so
a redirect to an extension-hosted script is refused, and re-fetching the module
URL from the service worker is the design this project rejected in §2.1 for
reasons that have not changed.

**This is the one place the capture layer changes how a page loads its own
code**, so the cost is worth stating precisely rather than glossing:

1. **The worker's base URL moves to the blob.** Every relative URL the real
   script resolves would silently point somewhere else, which is exactly the
   observable change §2.2 forbids. `worker-scope.ts` puts it back: `location` is
   redefined, and `importScripts`, `fetch`, `Request`, `XMLHttpRequest.open`,
   `WebSocket`, `EventSource`, `Worker` and `sendBeacon` all resolve their
   argument against the real script's URL first. Module workers need less of
   this than classic ones — the real module is imported by URL, so its
   `import.meta.url` and every dynamic `import()` inside it are already right.

2. **Module workers cannot load synchronously.** `importScripts` does not exist
   there, so the shim awaits two dynamic imports, and a `postMessage` arriving
   in that window would find no handler registered and be dropped. The shim
   buffers messages during startup and re-dispatches them in order. Classic
   workers need none of this: `importScripts` is synchronous, so the real script
   has run before the constructor's caller gets its worker back.

3. **Our own messages must never reach the page.** Captures come back over
   `postMessage` with a channel marker, and the interception listener is
   attached at construction — before page code can hold the worker, let alone
   add a handler — so `stopImmediatePropagation()` there means no page listener
   ever runs for one of our events.

4. **Content Security Policy can refuse a `blob:` worker.** Then the shim throws
   at construction and the untouched worker is started instead. A page whose
   worker does not start is a far worse outcome than a module not analysed.

**The failure that shaped the code.** The first version wrapped the whole
construct trap in one try/catch. Constructing a worker is not a pure act — it
fetches and runs a script — so a failure *after* the worker existed was
answered by constructing a second one, and the page's code ran twice. The
fallback is now scoped to the steps that happen before the worker exists;
anything failing after it is swallowed and costs only our own listener. A test
pins it.

**What only a real browser found.** The unit tests and the sandboxed prelude
test both pass against a nested worker; a run in headless Chrome showed its
capture never arriving. The cause was not in our code: a streaming capture is
posted once the cloned response has been read, which can land after
instantiation finishes, so the worker's reply and its capture race — and the
consumer calling `terminate()` on the reply kills whichever is still in flight.
It degrades to the network observer's "not analysed" note rather than
disappearing, which is the behaviour §2.6 exists to guarantee.

**Why it has an off switch when nothing else does.** Every other part of capture
is unobservable by construction. This one is not, so `instrumentWorkers` exists.
It cannot be consulted before the hook installs — `chrome.storage` is async and
the hook must exist before the page's first line — so instrumentation is on by
default and switched off a few milliseconds later by the bridge, taking full
effect from the next navigation.

### 2.7 Format detection by magic bytes, never by URL or MIME type

`sniff()` checks for `\0asm`. An attacker controls the URL and the
`Content-Type` header — a miner is routinely served as `/assets/a8f3.dat` with
`application/octet-stream` — but cannot change the magic number without the
browser refusing to compile the module. Tested explicitly: a module served as
`.dat` with `octet-stream` is still identified as Wasm.

### 2.8 The service worker is the trust boundary

Everything from the page side is untrusted: the main world shares a global
object with the hook, so a hostile page can read our messages (it already owns
the bytes — nothing is disclosed) and can forge them.

Forgery is **bounded rather than prevented**:

- the service worker **re-sniffs the format and re-hashes with SHA-256** rather
  than trusting anything computed page-side;
- size cap of 16 MiB per artifact;
- rate cap of 60 captures per minute per frame;
- the isolated-world bridge validates message shape before forwarding.

### 2.9 Base64 across the extension messaging boundary

`chrome.runtime.sendMessage` serialises with a **JSON-shaped algorithm, not
structured clone**. A `Uint8Array` handed to it arrives as an object with
numeric keys — roughly **4× inflation**, which is why the first iteration
needed `express.json({ limit: "50mb" })`. Base64 costs a predictable
4/3 and survives intact.

### 2.10 The page-side fingerprint is not SHA-256, deliberately

The main-world hook de-duplicates with an FNV-1a fingerprint over the length
plus three 4 KiB windows, **not** a cryptographic hash, because `crypto.subtle`
is **undefined on plain-http pages** — and a miner served over http is still a
miner. It is a bandwidth optimisation, not a security boundary; the service
worker's SHA-256 is authoritative.

### 2.11 MV3 lifecycle: designed around, not fought

The service worker is killed after ~30 s idle. The common workaround is a
keepalive (a self-ping timer), which is a battery cost and a Chrome Web Store
review flag.

Instead: **every handler is short, stateless and writes through to IndexedDB**,
and the badge is recomputed from storage rather than from an in-memory counter
that would not survive. A worker killed mid-flight loses at most the single
capture it was working on.

### 2.12 Bounded local retention

IndexedDB keeps artifact bytes so analysis can be re-run after a rule change
without re-observing the module. Bounded by a least-recently-seen eviction pass
at 300 artifacts / 128 MB.

---

## 3. Privacy

### 3.1 Local-first by default; upload is opt-in

The first iteration POSTed every captured script and module to
`localhost:3000`. Wasm-Sentry sees every module a page executes, and some are
private by nature — an internal build, an authenticated application.

**Shipping those bytes to a server by default is an exfiltration channel wearing
a security tool's badge**, and would not survive Chrome Web Store review.

Analysis therefore runs in the extension. The backend was cut back to a health
endpoint rather than left as an endpoint that accepts artifacts and silently
drops them.

---

## 4. Static analysis (Phase 2)

### 4.1 A hand-written parser instead of WABT

The synopsis names WABT. It was not used, for three reasons:

1. WABT is a **native binary** the extension cannot load.
2. The wasm build of it is **~1 MB** — shipping a second WebAssembly module
   inside a WebAssembly security tool is both ironic and a real attack surface.
3. The analysis needs a decoded instruction stream regardless. Using WABT for
   text and our own decoder for analysis means **two implementations of the same
   format** to keep in step.

**Result:** WAT rendering is a *view over our own decode*, so the listing a user
reads is provably the same decode the detector reasoned about. ~900 lines,
no dependencies.

### 4.2 The decoder is total, and stops rather than guesses

Every opcode declares exactly what immediates follow it — including the 0xFC
(bulk memory), 0xFD (SIMD) and 0xFE (threads) multi-byte families.

**Why this is the critical correctness property:** a decoder that guesses an
operand width wrong does not produce a slightly wrong listing. It
**desynchronises**, and every instruction after that point is fiction. For a
detector, that means inventing evidence. So the decoder either returns a
faithful instruction list or stops at the first byte it cannot account for and
reports where.

### 4.3 Malformed input is the normal case

Hostile and truncated modules are the job, not an exception:

- vector lengths larger than the remaining input are **rejected before
  allocating** — otherwise a 20-byte file becomes an out-of-memory crash;
- a section that fails to parse costs **that section**, not the module: the walk
  resynchronises on the declared section boundary;
- a malformed *section header* stops the walk (there is nothing left to
  resynchronise on) but keeps everything parsed so far, with a warning;
- `analyzeWasm()` **never throws** — a module that cannot be parsed is a result,
  not an exception, because a thrown error inside a message handler is a capture
  silently lost.

### 4.4 Exact CFG, cheaply — the advantage Wasm gives us

WebAssembly's control flow is **structured**: no computed goto, every branch
targets an enclosing `block`/`loop`/`if` by relative depth. Branch targets
resolve by frame depth in a single pass.

The consequence is worth stating plainly: **native-binary CFG recovery is
expensive and approximate because of indirect jumps; WebAssembly hands us an
exact CFG for free.** A loop this pass reports is a loop the engine will
actually execute. The literature entry that motivates the static module
(`Wasm-Analyser`) is described as "computationally intensive, not optimised for
real-time" — this is why our version is not.

### 4.5 Budgeted analysis

Decoding stops after a fixed instruction budget and **reports how many functions
it skipped**. A hostile 50 MB module cannot hold the service worker open, and
the resulting partial analysis is labelled as partial rather than presented as
clean.

### 4.6 One feature vector, two consumers

The heuristics read the same `ModuleFeatures` the classifier will train on, from
the same code path. A rule and a model can never disagree about what they were
shown.

### 4.7 Storage shape separated from compute shape

`StaticAnalysis` holds the parsed module and every per-function row — right for
computing, wrong for keeping (megabytes for a 2 MB module). `summarise()`
reduces it to a bounded, flat, JSON-serialisable `ArtifactAnalysis` for
IndexedDB and the wire.

### 4.8 Measured performance

| Module | Source | Size | Time | Functions | Instructions | Warnings |
|---|---|---|---|---|---|---|
| `sql-wasm.wasm` | SQLite / Emscripten (C) | 643 KB | 165 ms | 1,879 | 285,184 | 0 |
| `index_bg.wasm` | resvg / wasm-bindgen (Rust) | 2.4 MB | 399 ms | 1,433 | 975,433 | 0 |

Zero undecodable function bodies in either.

---

## 5. Detection and scoring (Phase 3)

### 5.1 What calibration against real modules changed

The sequence below is the clearest illustration of why thresholds in this
project are measured rather than chosen.

**Version 1.** Rank candidate loops by `loopSize × bitwiseRatio`; let a
high-density loop alone produce a *high* verdict. Reasonable-sounding.

**What real data showed, step 1.** On the Rust module, the top-ranked "hot loop"
was a **53,000-instruction dispatch loop at 4% bitwise** — simply the biggest
function in the module. Size dominated the product, so the metric found the
largest function rather than the most suspicious one.

*Fix:* rank by **density**, among functions passing a structural filter (loop
≥ 40 instructions, zero floating point, call ratio < 2%) — the shape of a
register-arithmetic kernel.

**What real data showed, step 2.** With ranking fixed, function 240 surfaced:

> 631-instruction loop · **24.5%** shifts/rotates/xors · **62.9%** integer
> arithmetic · **0** calls · **0** floating point

That is a legitimate image codec routine in an SVG renderer, and it is
**statically indistinguishable from a hashing kernel**. Compression, checksums
and image filters all produce this shape.

**The tempting fix was to raise the threshold until the sample passed.** That is
overfitting to one sample and hides the real finding.

**What was done instead:**

1. `hash-loop-density` capped at weight 22 — **cannot on its own reach the high
   band**;
2. its evidence text says out loud: *"compression and checksum routines also
   take this shape"*;
3. escalation moved to a new `mining-corroborated` rule requiring the kernel
   **plus** the infrastructure a miner needs to be worth running: shared memory
   for worker fan-out, atomics, a socket import, or a module with ≤3 exports
   over 2,000 instructions.

**Outcome:** the Rust module scores **21/100 (low)** with a self-qualifying
finding, instead of 39/100 with an accusation. SQLite scores **6/100 (benign)**.
The synthetic full-mining-shape fixture scores **63/100 (high)**.

**And the wider point:** this is precisely why MINOS — the closest system in
the literature — is runtime-based. Sustained CPU is the signal that settles the
question. It arrives in Phase 4.

### 5.2 The score saturates

```
score = 100 × (1 − e^(−raw / 50)),  raw = Σ (weight × confidence)
```

Linear addition would let a pile of weak, common signals — stripped names, a
large data section, one socket import — add up to an accusation. Saturation
means each additional finding moves the score less than the last, so the top
band requires evidence that is **individually strong rather than merely
plentiful**. At a constant of 50, one strong rule reaches *high* and *critical*
needs two independent ones. There is a test asserting twelve weak findings
cannot reach *critical*.

### 5.3 Every finding carries its evidence

A rule that cannot state the numbers that triggered it does not ship. The
finding is not *"suspicious loop detected"* — it is:

> *function 240 runs a 631-instruction loop that is 24.5% shifts, rotates and
> xors and 62.9% integer arithmetic overall, with no floating point and no calls
> out (compression and checksum routines also take this shape)*

Each rule also cites the paper it is drawn from, shown in the popup. This
directly answers the "poor interpretability" drawback in the synopsis (§4.3):
tools that return a binary verdict with nothing a developer can check.

There is a test asserting every finding cites either a measurement or the symbol
it matched.

### 5.4 Coverage is reported alongside the score

Every assessment states what share of the module was actually decoded. A partly
analysed module **says so** rather than implying a clean result. The
`incomplete-coverage` rule carries weight 0 — it contributes no score, it
qualifies the ones that do.

### 5.5 The asymmetry that governs every threshold

A false positive on a popular site destroys trust in the tool permanently; a
missed module is caught by the next pipeline stage. Every threshold sits well
clear of where ordinary compiled code measures (2.8–3.7% bitwise).

### 5.6 Rules that deliberately under-claim

`hash-primitive-symbols` (Argon2, scrypt, Keccak, BLAKE2) is weighted 12 at
confidence 0.4, because these are legitimate password-hashing primitives — the
rule raises a question rather than answering one. `stripped-binary` is weight 4:
almost every production build strips names, so it only matters as a multiplier.

---

## 6. Testing

### 6.1 Self-validating fixtures

Test modules are **hand-assembled byte by byte**, and every test that uses one
first asserts `WebAssembly.validate()` accepts it.

**Why this matters:** with a recorded blob, a bug in our encoder and a matching
bug in our parser cancel out and the test passes. Making the engine validate the
fixture means a broken encoder fails **at the fixture**, not by quietly proving
the parser agrees with our own mistake.

### 6.2 Ablation-friendly fixtures

`syntheticMinerModule({ shared, rounds })` lets individual signals be switched
off, so tests prove **no single signal carries the verdict**: removing the
kernel drops the module out of the high band; removing the infrastructure stops
`mining-corroborated` from firing.

### 6.3 Interception logic is a pure unit

`capture-hooks.ts` takes every ambient global as an injected parameter, so the
interception logic is tested directly against a synthetic WebAssembly namespace
— no browser, no DOM shim. Capture correctness is the foundation everything else
stands on: a module never seen is a module never ruled on.

### 6.4 The worker prelude is tested as a built artifact

Everything else is unit tested against injected fakes, which proves the logic
and says nothing about the bundle. The worker prelude never runs as an extension
script at all: it is bundled to a string, published as a `blob:` URL, and
evaluated inside a worker no test can reach. A broken bundle — a stray reference
to `window`, an import that did not get inlined — would leave every unit test
green while no module in any worker was ever captured again.

So one test builds it exactly as the build script does and evaluates it in a
`vm` context shaped like a worker global scope, then asserts that a compile
inside it emits a capture, that the base URL was restored, and that a nested
worker is instrumented from the same prelude blob.

### 6.5 Counts

118 tests. 41 in `core` (sniffing, hashing, base64, parser, decoder, CFG,
features, heuristics, scoring) and 77 in `extension` (capture hooks, worker
instrumentation and base compensation, the built worker prelude, storage against
a real IndexedDB, popup message handling, alert policy, formatting, and an
end-to-end run through the real service worker).

### 6.6 No detection rate is claimed

Deliberately. An honest figure needs a labelled corpus (WasmBench plus verified
malicious samples) that this project does not yet have. The synthetic fixture
proves the rules fire on the shape they target; it does not prove a detection
rate. Claiming one would be the kind of unsupported number the literature review
criticises.

---

## 7. Things deliberately not done yet

| Not done | Why |
|---|---|
| ML classifier | Needs the Phase 2 feature pipeline (done) *and* a labelled dataset (not obtained). Heuristics are the baseline it has to beat — building the model first leaves nothing to compare against. |
| Runtime monitoring | Phase 4. It is the signal that settles the mining question, per §5.1. |
| JS bundle analysis | Needs its own consent story: shipping page scripts anywhere is a bigger privacy question than Wasm modules. |
| SQLite + job queue | Only meaningful once upload is opt-in-able and there is deep analysis worth queueing. |
| Element/data segment contents | Only needed for indirect-call resolution; segment *counts* are already a useful structural feature. |

---

## 8. At a glance

- **7-stage pipeline**, 3 of 5 phases complete
- **0 runtime dependencies** in the analysis core
- **643 KB / 1,879 functions parsed in 165 ms**; 2.4 MB / 975k instructions in 399 ms
- **0 warnings, 0 undecodable function bodies** on both real-world modules
- **~38 KB** added to the extension bundle by the whole analysis engine
- **118 tests**, all green — 41 in `core`, 77 in `extension`
- **12 detection rules**, every one citing evidence, 5 citing literature
- Calibration: benign real-world modules score **6** and **21** out of 100; the
  full mining shape scores **63**
- **No detection rate is claimed**, here or anywhere in the repository — see §6.6
