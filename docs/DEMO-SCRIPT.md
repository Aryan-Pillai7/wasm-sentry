# Live demo script

Written for a ~6-7 minute in-person evaluation. Uses only deterministic,
already-built pieces — the testbed's fixtures have documented expected
scores (see `testbed/README.md`), so nothing here depends on the live
internet or on today's classifier weights being trustworthy. Rehearse this
once end-to-end before the real thing; the timings below assume you have.

## Setup — do this before you're in the room

```bash
cd /Users/amoghbhatnagri/Desktop/wasm-sentry
npm run build -w extension
npm run testbed          # regenerates fixtures, serves testbed/ on :8080
```

- Load `extension/dist` as an unpacked extension at `chrome://extensions`
  (Developer mode on, "Load unpacked").
- Open the dashboard once (click the extension icon → **Open dashboard**) and
  click **Clear stored data** so the activity feed and module list start empty —
  a demo that opens with a clean slate reads far better than one with stale
  data from your own testing sitting in it.
- Open two tabs in advance, both blank: one you'll navigate to a real site,
  one to `http://localhost:8080`. Switching tabs live is faster and less
  failure-prone than typing URLs while people are watching.
- Keep the popup closed until the scripted moment — it polls every 1.5s and
  is more distracting open than closed while you talk.

## The script

### 1. The problem (30s, no clicking)

State it in one breath, matching the synopsis's own framing: WebAssembly and
obfuscated JS let a page run high-performance code the browser's own
sandboxing does nothing to make *inspectable* — sandboxing prevents a module
from escaping its box, not from cryptomining or exfiltrating inside it. That
gap is what this project targets.

### 2. A real, benign page (45s)

Navigate the first tab to any real site that loads WebAssembly for a
legitimate reason — `https://squoosh.app` is reliable (image codecs) and
doesn't require an account. Let it load, click the extension icon.

**Say:** "This is capturing every module the page instantiates, live, as it
loads — not from a pre-collected dataset." Point at the module count and the
Privacy Scorecard sitting at a low score. Open one artifact card, point at
the static facts (functions, loops, bitwise ratio) — **this is the point to
land**: "these are real structural measurements of the actual binary the
page just ran, not a guess."

### 3. Switch to the testbed (3 min — this is the core of the demo)

Switch to the second tab, already on `localhost:8080`. Click **Run all**.

Open the popup. Walk the four fixtures in order, reading their scores off
the popup as you go — don't recite the expected numbers from memory, read
them live, that's the point of a live demo:

| Fixture | What you say |
|---|---|
| `benign.wasm` | "Float arithmetic, no loops — scores at the bottom, no findings." |
| `kernel-only.wasm` | "A bare integer loop. On its own this is not evidence of anything — the scorecard says so explicitly, it stays below the flagged band." |
| `miner-no-threads.wasm` | "Now it has an integer kernel *and* a pool-import shape. That combination is what moves it into the high band — open the finding, and it names exactly that: not 'suspicious,' but which structural facts corroborated each other." |
| `miner.wasm` | "Shared memory, atomics, and the pool import together — the highest score of the four, for the same reason: more independent evidence agreeing." |

**This is the one sentence to say out loud, because it's the whole design
argument of the project**: *"The score is never the only thing shown — it
always ships with the specific findings and their confidence, because a
verdict you can't interrogate is one you can't act on."* This is the
architecture doc's own stated thesis; saying it while pointing at a findings
list with confidence percentages on screen is the strongest moment you have.

### 4. Worker capture (60s, optional if time is short)

Back on the testbed page, click one of buttons 7–9 (worker instrumentation).
Open the popup, point at the artifact tagged **in a Worker**.

**Say:** "A miner's obvious move is to fan out across every CPU core using
Workers, to look like normal parallel code. The capture layer follows it
into the Worker — this tag is proof it did, not an assumption that it
would." Skip this step entirely if you're tight on time; it's real but not
essential to the core argument.

### 5. The dashboard (60s)

Open the dashboard (popup → **Open dashboard**, or the extension's own
page). Point at three things in order:

1. **Activity feed** — every page visited this session, in order, each with
   its verdict. "This is the history, not just the current tab."
2. **Modules table** — every distinct module seen, deduplicated by content
   hash, with its score. "The same module served from ten cache-busted URLs
   is one row, not ten."
3. **Settings panel** — point at `analyseJavaScript` being off by default.
   "This is the one capture path that reads a page's own inline source
   rather than a compiled binary — on an authenticated app that can carry
   real private business logic, so it's opt-in, not on by default. Nothing
   else in the extension makes that trade."

### 6. Close (30s)

One sentence tying it back to the synopsis's stated objective: real-time,
in-browser visibility into an execution layer that's otherwise opaque —
demonstrated live, on both a real site and a controlled fixture, with the
evidence shown alongside every verdict rather than instead of it.

## "Show us a real-world case"

Expect this question, and don't defend the testbed against it — agree with
the premise and pivot. `testbed/README.md` says outright that the miner
fixtures "compute nothing... they are shaped like a mining kernel," which is
a deliberate, honest design choice (no real malware sample committed to the
repo), not something to talk around if pushed on it directly.

The real-world answer has two halves, and you already have both:

1. **Real-world benign** — step 2 of this script (`squoosh.app`) is already
   genuine third-party WASM, not anything built for this project.
2. **Real-world malicious** — serve `~/wasm-sentry-demo-assets/miner-test-harness` locally
   (`npx --yes serve ~/wasm-sentry-demo-assets/miner-test-harness -l 8081`, a page already built
   for this) and load one or two of its buttons. These `.wasm` files are not
   synthetic: they're the actual compiled CryptoNight kernels pulled from
   `deepwn/deepMiner`, `craciuncezar/browser-cryptominer`, and
   `pRizz/CryptoNoter` — real, historically-deployed browser-cryptojacking
   binaries, verified with `WebAssembly.validate` before use.

If asked why this isn't running from a live, currently-active malicious
site: say that directly, as the correct call rather than a limitation.
CoinHive-era cryptojacking sites are almost entirely dead now (CoinHive
itself shut down in 2019), so there is no reliable current example to point
a browser at — and even if one existed, executing an unverified live sample
in front of an audience is not good practice. A real sample in a controlled,
local environment is the standard way malware is actually analysed;
demonstrate that judgement rather than apologise for it.

Rehearse this pivot once so it isn't the first time you've said it out loud.

## If something breaks live

- **Popup shows "reading capture log" and never resolves**: the tab was
  already open before the extension loaded. Reload the tab — the content
  script only injects at `document_start` on a fresh navigation.
- **A testbed fixture doesn't fire**: click **Clear stored data** on the dashboard
  first, then **Run all** again — a stale capture from an earlier run of
  yours can still be sitting in the module list.
- **Total failure**: fall back to the dashboard's Activity feed from your
  rehearsal run (don't clear it *before* the actual demo if you're worried —
  clear it after your last rehearsal, not before you walk into the room) and
  narrate from that, or fall back to reading a finding straight from
  `core/src/heuristics.ts`'s rule definitions to show the logic exists even
  if the live capture hiccups.

## What not to demo

Don't open with or dwell on the ML classifier. It's real, but it currently
loses to the heuristics on the honest cross-validation numbers (`docs/
DATASET-PLAN.md` §5) — if asked directly, say exactly that: the pipeline is
built and evaluated honestly, the heuristic engine is what's shipping, and
the classifier is disclosed as a work in progress with real numbers, not
hidden. That's a stronger answer to a direct question than pretending it
isn't there.
