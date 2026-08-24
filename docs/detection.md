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
- **Static analysis only.** A module that fetches its kernel at runtime, or
  gates it behind a delay, looks benign here until runtime monitoring lands.
- **A worker terminated mid-capture loses that capture.** A streaming capture is
  posted once the cloned response has been read, which can land after the module
  has finished instantiating — so a page that calls `terminate()` the instant its
  worker reports back can kill a capture already in flight. It degrades rather
  than disappears: the network observer still records the module as
  `network-only`, so the report says "not analysed" instead of implying a clean
  page.
- **A worker whose shim is refused stays a blind spot.** Modules compiled inside
  a Web Worker are analysed now — the hooks are carried in by a shim the
  extension starts the worker from — but a Content Security Policy that forbids
  `blob:` workers rejects that shim, and those workers fall back to running
  untouched and being reported as `network-only`.
