# Detection

How Wasm-Sentry decides that a module is worth flagging, what each rule
measures, and where the thresholds come from.

## Principles

**Every finding carries its evidence.** A rule that cannot state the numbers
that triggered it does not ship. The interpretability gap — tools that return
"malicious" with nothing a developer can check — is one of the drawbacks this
project set out to close, and a scorecard that repeats that mistake would not be
an improvement.

**A false positive costs more than a miss.** Flagging a popular site once
destroys trust in the tool permanently; a missed module is caught by the next
stage of the pipeline. Every threshold therefore sits well clear of where
ordinary compiled code measures.

**Corroboration, not accumulation.** The score saturates, so reaching the top
band takes evidence that is individually strong rather than merely plentiful.
Twelve weak hints cannot add up to an accusation.

## Rules

| Rule | Weight | What it measures |
|---|---|---|
| `known-miner-family` | 45 | Import, export or custom-section names matching known browser mining families (Coinhive, CryptoLoot, CryptoNight, XMRig, …). |
| `mining-corroborated` | 40 | A compute kernel **and** the infrastructure a miner needs: shared memory, atomics, a socket import, or a module that exists only to run one loop. |
| `bitwise-dominant-module` | 25 | Module-wide bitwise share above 12% with little floating point. |
| `hash-loop-density` | 22 | A loop of ≥40 instructions at ≥22% bitwise and ≥45% integer arithmetic, with no floating point and effectively no calls. |
| `shared-memory-parallelism` | 15 | Shared memory plus atomics — the shape of saturating every core through Web Workers. |
| `socket-transport` | 15 | Imports naming a socket, stratum or message transport. |
| `hash-primitive-symbols` | 12 | Symbols naming Argon2, scrypt, Keccak, BLAKE2. Weighted low: these are legitimate password-hashing primitives. |
| `compute-kernel-surface` | 10 | A large looping body behind ≤6 exported functions. |
| `aggressive-memory-growth` | 10 | ≥256 pages (16 MiB) requested, or `memory.grow` with no declared maximum. |
| `large-embedded-payload` | 8 | Data section over 256 KB and more than 40% of the module. |
| `stripped-binary` | 4 | No name section. Normal for production builds; only meaningful as a multiplier. |
| `incomplete-coverage` | 0 | Functions that could not be decoded or were skipped for budget. Contributes no score — it qualifies the ones that do. |

## Runtime rules

Static rules score a module the moment it is captured. These score it again once
it has been watched long enough for its behaviour to mean something, through the
same aggregation and the same evidence requirement.

| Rule | Weight | What it measures |
|---|---|---|
| `mining-runtime-corroborated` | 45 | A static compute kernel **and** sustained execution: the finding this phase exists for. Escalated further by fan-out, timer starvation or socket traffic. |
| `sustained-execution` | 28 | At least 0.5 core-equivalents of execution over at least 20 seconds of observation. |
| `worker-fan-out` | 20 | The same module executing in at least half the machine's cores' worth of contexts. |
| `persistent-socket-traffic` | 12 | Ten or more socket messages alongside at least five seconds of execution. |
| `runtime-not-yet-observed` | 0 | Watched for under 20 seconds. Contributes no score — it says the runtime rules have not had long enough to mean anything. |

**Twenty seconds, not two.** A page is legitimately busy for a few seconds all
the time: starting a game, decoding an image, recalculating a sheet. Sustained
execution is a different claim from a spike and the threshold is what makes it
one.

**Core-equivalents, not a percentage.** Each context's share is capped at 1 and
the capped shares are summed, so a module saturating four workers reports about
4.0. Averaging would hide fan-out behind an idle main thread, and fan-out is
exactly the shape being looked for.

**Sustained execution alone cannot reach the high band.** A video codec, a game
and a physics engine all saturate a core honestly. `sustained-execution` is
weighted so that it cannot on its own accuse anything; escalation requires the
static kernel too, which is the same corroboration-not-accumulation rule the
static side already followed.

## JavaScript rules

Opt-in, and calibrated against the opposite problem. Ordinary compiled
WebAssembly looks nothing like a mining kernel; ordinary production JavaScript
looks *exactly* like obfuscated JavaScript to any naive test.

| Rule | Weight | What it measures |
|---|---|---|
| `js-known-miner-family` | 45 | Names a known browser mining family. |
| `js-mining-pool-endpoint` | 35 | A `stratum://` or pool-shaped socket address. A bare `wss://` is not matched — every chat application opens one. |
| `js-decoded-code-execution` | 30 | Runtime evaluation **and** base64 decoding together. Either alone is ordinary. |
| `js-miner-bootstrap-shape` | 25 | Three or more of: WebAssembly calls, Worker construction, a `hardwareConcurrency` read, a socket. |
| `js-obfuscated-source` | 20 | Escape density above 5%. |
| `js-injects-remote-script` | 8 | Injects script elements. Every tag manager does this; it is context, not an accusation. |
| `js-third-party-unpinned` | 6 | Third-party scripts with no Subresource Integrity, from markup alone. |

### Calibration

Measured against real production bundles in this repository's own
`node_modules`, and against payloads built the way an obfuscator writes them:

| Source | Size | Escape density | `eval` | `atob` |
|---|---|---|---|---|
| `react-dom.production.js` | 6 KB | 0.000% | 0 | 0 |
| `esquery.esm.min.js` | 36 KB | 0.131% | 0 | 0 |
| `ajv.min.js` | 117 KB | 0.928% | 0 | 0 |
| `typescript.js` | 8.9 MB | 0.006% | 0 | 0 |
| hex-escaped payload | 0.4 KB | **54.8%** | 1 | 1 |
| packed payload | 6.3 KB | **98.9%** | 1 | 0 |

**Escape density is the separator, not line length or entropy.** `ajv.min.js`
has a 119,360-character line and is entirely legitimate; every real bundle sits
between 4.7 and 5.4 bits of entropy, as does obfuscated code. A minifier
shortens code; an obfuscator hides it, and hiding it means escaping it.

The threshold is 5%: 5.4x above the worst real bundle and 11x below the mildest
obfuscated sample. Not one of the four real bundles calls `eval` or `atob` at
all, which is what makes `js-decoded-code-execution` safe at weight 30.

These measurements live in `core/test/js.test.ts` as assertions, not only in
this table, so a threshold change breaks a test rather than quietly invalidating
a document nobody re-reads.

## The classifier

One more rule exists and does not fire, because no model ships with this
repository.

| Rule | Weight | What it measures |
|---|---|---|
| `classifier-opinion` | 18 | A trained logistic regression scores the module above 0.6. Its evidence names the columns that moved the score and the corpus it was trained on. |

Eighteen, below `hash-loop-density`, permanently. A model is an opinion about a
module; every other rule here is a measurement of one. The project's position is
that a verdict a user cannot interrogate is a verdict they cannot act on, and
"the model said so" is exactly that verdict — so the classifier may raise a
question and never answer one alone.

Training needs a labelled corpus this project does not have. The pipeline around
it is complete and documented in [`design-decisions.md`](design-decisions.md)
§7; `npm run train -w @wasm-sentry/core -- <corpus>` cross-validates any corpus
you supply **against the heuristics on the same folds**, and says plainly when
the model loses to them.

## Scoring

Raw score is `Σ (weight × confidence)`, then saturated:

```
score = 100 × (1 − e^(−raw / 50))
```

| Band | Score |
|---|---|
| benign | 0–9 |
| low | 10–24 |
| medium | 25–49 |
| high | 50–74 |
| critical | 75–100 |

At a saturation constant of 50, one high-weight rule at full confidence lands in
*high*, and *critical* requires two independent strong findings.

Each assessment also reports **coverage**: the share of the module's functions
that were actually decoded. A partly analysed module says so rather than
implying a clean result.

## Calibration

Thresholds were measured against real compiled output, not chosen by intuition.

| Module | Source | Size | Bitwise | Float | Verdict |
|---|---|---|---|---|---|
| `sql-wasm.wasm` | SQLite via Emscripten (C) | 643 KB | 2.8% | 0.6% | 6/100 benign |
| `index_bg.wasm` | resvg via wasm-bindgen (Rust) | 2.4 MB | 3.7% | 4.0% | 21/100 low |

Reproduce with:

```bash
npm run inspect -w @wasm-sentry/core -- path/to/module.wasm
npm run calibrate -w @wasm-sentry/core -- path/to/module.wasm
```

### What is and is not calibrated at runtime

The static thresholds in this document were measured against real compiled
output. **The runtime thresholds were not calibrated against real mining
samples**, because this project still has no labelled corpus, and saying
otherwise would be exactly the unsupported number the literature review
criticises.

What they are is bounded by measurement of the mechanism. Driving the built
extension in headless Chrome against a fixture that really spins:

| Measurement | Observed |
|---|---|
| Grinding workers, one per two cores | 8 of 8 reported, each under its own context identity |
| Execution measured in the busiest worker | 12.0s inside a 12.0s window — a full core |
| Instrumentation overhead on a hot-loop module | timing self-disables after 20,000 calls averaging under 0.05 ms |

So the pipeline measures what it claims to measure, to the resolution the rules
need. Whether 0.5 core-equivalents over 20 seconds is the right line for real
cryptojacking in the wild is an open question, and it is written here as one.

### What calibration changed

The first version of the kernel detector ranked candidate loops by
`loopSize × bitwiseRatio` and let a high-density loop alone produce a *high*
verdict. Measuring real modules broke both halves of that.

**Ranking by size found the wrong function.** On the Rust module the top-ranked
"hot loop" was a 53,000-instruction dispatch loop at 4% bitwise — the biggest
function in the module, which says nothing. Selection now ranks by density among
functions that pass a structural filter (loop ≥40 instructions, no floating
point, call ratio under 2%).

**Density alone cannot separate mining from compression.** With ranking fixed,
the Rust module surfaced function 240: a 631-instruction loop, 24.5% shifts and
xors, 62.9% integer arithmetic, zero calls, zero floating point. That is a
legitimate image codec routine and it is *statically indistinguishable* from a
hashing kernel. Checksums, compression and image filters all produce this shape.

So `hash-loop-density` was capped at a weight that cannot on its own reach the
high band, its evidence text says out loud that compression takes the same
shape, and escalation was moved to `mining-corroborated`, which requires the
kernel plus infrastructure. The Rust module now scores 21/100 (*low*) with a
finding that explains itself, instead of 39/100 with an accusation.

This is also why MINOS, the closest system in the literature, is runtime-based:
sustained CPU is the signal that settles the question, and it arrives in Phase 4.

## Known limitations

- **No labelled corpus yet.** Detection rates are not claimed, because measuring
  them honestly needs a benchmark set (WasmBench plus verified malicious
  samples) that this project does not yet have. The synthetic miner fixture in
  `core/test/fixtures.ts` proves the rules fire on the shape they target; it
  does not prove a detection rate.
- **Runtime thresholds are not corpus-calibrated.** See above. The mechanism is
  measured; the lines drawn on it are conservative rather than fitted.
- **A module gated behind a long delay is still missed.** Runtime monitoring
  watches from page load; a kernel that waits ten minutes before starting is
  observed only if the tab is still open when it does.
- **A worker terminated mid-capture loses that capture.** A streaming capture is
  posted once the cloned response has been read, which can land after the module
  has finished instantiating — so a page that calls `terminate()` the instant its
  worker reports back can kill a capture already in flight. It degrades rather
  than disappears: the network observer still records the module as
  `network-only`, so the report says "not analysed" instead of implying a clean
  page.
- **JavaScript analysis reads only what the page wrote itself.** External
  script contents are never fetched, so a payload delivered inside a third-party
  bundle is seen as an unpinned third-party script and not as its contents.
  `eval` is not hooked either, for a reason given in `script-hooks.ts`.
- **A worker whose shim is refused stays a blind spot.** Modules compiled inside
  a Web Worker are analysed now — the hooks are carried in by a shim the
  extension starts the worker from — but a Content Security Policy that forbids
  `blob:` workers rejects that shim, and those workers fall back to running
  untouched and being reported as `network-only`.
