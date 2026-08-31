# Working Context

Read this first if you are picking the project up on a different machine or
after a break. It is the handover note: current state, how to run things,
conventions in force, the gotchas that waste time, and what to do next.

Last updated after JavaScript analysis landed, which finished the roadmap. The
only outstanding item is the labelled corpus described under "Next steps".

---

## Where things stand

| Phase | Scope | Status |
|---|---|---|
| 1 | Capture layer | complete, tested |
| 2 | Disassembly + static analysis | complete, tested |
| 3 | Heuristics + Privacy Scorecard | complete, tested |
| 4 | Runtime behavioural monitoring | complete, tested |
| 5 | ML classifier | pipeline complete and tested; no model, no corpus |
| — | JS bundle / supply-chain analysis | complete, tested, opt-in |
| — | Backend SQLite + job queue | complete, tested |

Beyond the phases, the extension has gained a dashboard, desktop notifications,
generated icons, a testbed page, CI, and worker instrumentation that closed the
last capture blind spot. 234 tests, all green: 100 in `core`, 121 in `extension`, 13 in `backend`.

```
JavaScript and supply-chain analysis, behind the consent design that blocked it
Phase 5: the classifier pipeline, and no model to ship with it
Backend Phase 2: SQLite, a job queue, and the upload API
Phase 4: measure what a module does, not only what it is
Fix the nested-worker capture race the browser found, and document it
Carry the capture hooks into Web Workers
Run build, typecheck, lint and tests in CI
Make `npm run lint` pass, and stop dashboard polls overlapping
Regenerate the lockfile so a checkout installs on any platform
--- everything above landed after the handover ---
d83f408  Add a dashboard so the extension can show its own work
61ef96f  Notify on high-risk pages, and give the extension a real icon
f805222  Fix the popup hanging on "Reading capture log"
71f0dfc  Add an end-to-end testbed exercising every capture path
3b337b3  Phase 3: heuristic detection and the Privacy Scorecard
0f562de  Phase 2: static analysis pipeline -- parser, CFG, WAT and features
d42780a  Phase 1: rebuild the capture layer around main-world API hooks
```

Hashes are omitted above the line because they change with a rebase; `git log`
has them, and the subjects are what you are looking for anyway.

Commit messages are deliberately detailed. `git log` is the design record.

---

## Getting running

```bash
npm install          # one install at the root; workspaces handle the rest
npm run build        # core -> extension -> backend
npm test             # core + extension
```

CI runs `npm ci`, build, typecheck, lint, fixtures and tests on Node 22.12 and
24 for every push and pull request (`.github/workflows/ci.yml`). The fixture
step is load-bearing: `extension/test/pipeline.test.ts` skips itself when
`testbed/miner.wasm` is absent, so without it the end-to-end test would report
green while covering nothing.

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** →
select `extension/dist`. **Chrome 111+ required** (`"world": "MAIN"` content
scripts). Pin it to the toolbar, or the badge is hidden in the puzzle menu.

Reload the extension after every rebuild, and reload the page under test — the
hook only installs at `document_start`.

### Seeing it work

The dashboard (right-click the extension → Options, or the button in the popup)
is the fastest way to confirm the whole chain is alive: worker uptime,
notification permission level, a live activity feed, and every module seen.

### Local test page

```bash
npm run testbed      # emits fixtures, serves testbed/ on :8080
```

Ten buttons. Nine are capture paths — streaming, in-memory buffer, compile +
instantiate, the `Module` constructor, a `blob:` URL, a dedup check, a classic
Worker, a module Worker, and a Worker inside a Worker. Expect a red badge, one
notification for `miner.wasm` at 63/100, the feed filling in live, and the
worker modules tagged **in a Worker** rather than listed as not analysed.

The tenth is Phase 4: **grind for 25s across every core**. It starts one worker
per two cores running a fixture that really spins, and after twenty seconds
`sustained-kernel.wasm` should move from its ambiguous static verdict to
`mining-runtime-corroborated`, with the popup showing the seconds executed and
the core-equivalents behind it.

### Looking at the interface without installing anything

```bash
npm run build -w extension
npm run preview:ui                      # http://localhost:8090/?scene=miner
```

Serves `extension/dist` and injects a stubbed `chrome` API in front of it, so
the real built popup and dashboard render against fixed data in an ordinary
tab. Scenes: `miner`, `clean`, `empty`, `loading` -- the last one answers no
messages at all, which is how the skeleton states get looked at.

This exists because a packed extension cannot be loaded in headless Chrome at
all — `--load-extension` is ignored under `--headless=new`, with no error — and
because the alternative loop for a one-line style change was build, reload the
unpacked extension, find a page that runs WebAssembly, open the popup. It
renders the interface and nothing else: it proves nothing about capture, which
is what `standalone.html` below is for.

### Checking capture in a real browser, without installing anything

```bash
npm run build && npm run testbed        # then open /standalone.html
```

`standalone.html` loads the built `extension/dist/injector.js` with a plain
script tag — exactly what the extension injects at `document_start` — and checks
every capture path itself. It covers only the first hop, but that is the hop
worker instrumentation lives in.

It can be driven headlessly, which is how the nested-worker race in gotcha 8 was
found. **Do not use `--virtual-time-budget`**: virtual time does not advance
inside worker threads, so the page's timeouts fire instantly while the workers
never get real time to load, and every worker check fails for a reason that does
not exist. Drive it over CDP and wait on wall-clock time instead:

```bash
chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/p about:blank
# then navigate to http://localhost:8080/standalone?auto, wait ~15s,
# and read document.getElementById("log").innerText
```

Expect five captures from the worker checks: one `page`, and four `worker` — a
classic worker, a module worker, a worker nested inside one, and that nested
worker's own parent. The runtime checks then start one grinding worker per two
cores and assert that each reports under its own identity and that the busiest
measured close to a full core of execution.

### Command line

```bash
npm run dev -w backend                                          # the upload API on :3000
npm run train     -w @wasm-sentry/core -- corpus/ --out m.json  # train + evaluate a classifier
npm run inspect   -w @wasm-sentry/core -- path/to/module.wasm   # full report + risk
npm run calibrate -w @wasm-sentry/core -- path/to/module.wasm   # kernel candidates
npm run fixtures                                                # regenerate testbed/*.wasm
node extension/scripts/make-icons.mjs                           # regenerate icons
```

Calibration modules (not committed — re-fetch when needed):

```bash
npm pack sql.js && tar xzf sql.js-*.tgz          # package/dist/sql-wasm.wasm  (C/Emscripten)
npm pack @resvg/resvg-wasm && tar xzf resvg*.tgz # package/index_bg.wasm       (Rust/wasm-bindgen)
```

Expected: SQLite → 6/100 benign. resvg → 21/100 low. If either moves
significantly a threshold changed, and `docs/detection.md` needs updating with it.

---

## Repository map

```
core/                    @wasm-sentry/core -- zero runtime dependencies
  src/
    types.ts             shared vocabulary; everything JSON-serialisable
    sniff.ts             magic-byte format detection
    hash.ts              SHA-256 via WebCrypto (works in SW, page and Node)
    base64.ts            transport encoding for chrome.runtime messages
    analysis.ts          analyzeWasm(): entry point, never throws
    report.ts            summarise(): full analysis -> storable record
    heuristics.ts        12 static + 5 runtime rules, + the classifier's opinion
    runtime.ts           runtime vocabulary; folding reports into features
    js/features.ts       lexical scan; escape density is what separates
                         minified from obfuscated
    js/heuristics.ts     7 JavaScript and supply-chain rules
    js/analysis.ts       analyzeJs(): never throws; summariseJs() keeps no source
    ml/features.ts       versioned feature vector; order is part of the model
    ml/model.ts          the model type, inference, and strict parsing
    ml/train.ts          logistic regression, no dependencies
    ml/evaluate.ts       k-fold, metrics, and the heuristic baseline
    scoring.ts           saturating score, bands, page scorecard
    wasm/
      reader.ts          bounds-checked LEB128 / vector reads
      opcodes.ts         opcode names + immediate shapes (incl. FC/FD/FE)
      decode.ts          instruction decoding; total, stops rather than guesses
      module.ts          section walk; resynchronises on section boundaries
      cfg.ts             exact control flow graph
      features.ts        feature vector; kernel candidate selection
      wat.ts             WAT rendering as a view over our own decode
  test/fixtures.ts       hand-assembled modules, validated by the real engine
  scripts/               inspect, calibrate, emit-fixtures, train-model

extension/
  src/
    content/injector.ts       MAIN-world entry
    content/runtime-monitor.ts  export timing, timer drift, per-context reports
    content/socket-hooks.ts   WebSocket open/message counts (counts only)
    content/script-hooks.ts   inline scripts + `new Function`; opt-in, no source stored
    content/capture-hooks.ts  interception logic (globals injected -> testable)
    content/worker-hooks.ts   Worker constructor wrapper, shim source, message intake
    content/worker-prelude.ts what runs inside a worker; bundled to a string
    content/worker-scope.ts   puts the worker's base URL back after the blob swap
    content/bridge.ts         ISOLATED-world relay, base64 encodes
    background/service-worker.ts  trust boundary, analysis, scorecard, badge
    background/alerts.ts      notification policy as a pure function
    popup/                    per-page Privacy Scorecard
    popup/load-report.ts      message fetching with every failure mode named
    dashboard/                cross-tab activity, status, modules, settings
    ui/theme.css              every colour, size, curve and duration, declared once
    ui/layers.tsx             the three detection layers, rendered the same everywhere
    ui/motion.ts              count-up, easing, and the reduced-motion decision
    ui/sparkline.ts           bucketing and path construction for the activity chart
    ui/gauge.ts               score-ring geometry
    ui/measure.ts             observed element width; why the chart is not stretched
    ui/scroll-spy.ts          which dashboard section is being read
    shared/protocol.ts        message types + caps
    utils/db.ts               IndexedDB (schema v5)
    utils/settings.ts         local-first defaults
  scripts/build-scripts.mjs   esbuild; builds the prelude to a string first
  scripts/make-icons.mjs      renders + encodes the PNG icons
  test/pipeline.test.ts       end-to-end through the real service worker
  test/worker-prelude.test.ts builds the prelude and runs it in a fake worker scope
  test/runtime-monitor.test.ts  what the page sees, and what measuring costs
  test/ui.test.ts             the arithmetic behind the animated parts

backend/                 SQLite + job queue + upload API, ESM + tsx
  src/app.ts               routes, built as a factory so tests drive the real ones
  src/db/                  node:sqlite store and schema
  src/queue.ts             one job at a time, resumable across restarts
testbed/                 local page exercising every capture path
scripts/preview-ui.mjs   serves the built popup and dashboard with a stubbed
                         chrome API, so the interface can be looked at without
                         installing anything
docs/                    architecture, detection, design, api-spec, this file
```

---

## Conventions in force

- **Commit messages carry no co-author trailer.** All work is attributed to the
  team.
- Strict TypeScript everywhere, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Optional properties are set with
  `...(value !== undefined ? { key: value } : {})`, never `key: value ?? undefined`.
- **`core` has zero runtime dependencies.** Keep it that way: it is what lets the
  same engine run in the extension, the backend and the tests.
- Comments explain *why*, not *what*. Several carry measurements; if a threshold
  changes, the comment changes with it.
- Every detection rule must state the numbers that triggered it. A test enforces
  this.
- New Wasm fixtures must pass `WebAssembly.validate` inside the test, so a broken
  encoder fails at the fixture rather than proving the parser agrees with our own
  mistake.
- **No colour, size, radius, duration or easing curve is written in a component
  stylesheet.** They live in `extension/src/ui/theme.css` and are used through
  custom properties. Before this rule the popup and the dashboard kept separate
  copies of the palette and had already drifted; see [`DESIGN.md`](DESIGN.md).
- Generated artifacts are gitignored: `dist/`, `testbed/*.wasm`.

---

## Gotchas worth remembering

1. **Reload both** the extension and the page under test. The hook installs at
   `document_start`, so a page open before the extension loaded is invisible.
2. **`crypto.subtle` is undefined on plain-http pages.** That is why page-side
   de-duplication uses FNV-1a, not SHA-256. Do not "fix" it — the service
   worker's SHA-256 is the authoritative one.
3. **`chrome.runtime.sendMessage` is JSON-shaped, not structured clone.** A
   `Uint8Array` silently becomes `{0: 1, 1: 2, …}` at ~4x the size. Hence base64.
4. **`Response.clone()` throws once the body is draining.** The streaming hooks
   await the response, clone, *then* call through. Do not reorder this.
5. **An empty reply from the service worker is a failure, not a loading state.**
   This caused a popup that hung forever. `popup/load-report.ts` exists to keep
   that from recurring; keep new UI paths going through it.
6. **Unpacked extensions get no permission prompt.** New manifest permissions
   apply silently on reload. Chrome's own OS-level notification permission is
   separate — the dashboard status panel reports it.
7. **Workers are instrumented, and that is the one intrusive thing we do.**
   Content scripts do not run in workers, so each worker is started from a
   `blob:` shim that loads the hooks and then the real script. Three things to
   know before touching it: the worker's base URL has to be restored
   (`worker-scope.ts`), module workers need their startup messages buffered
   because their loads are awaited, and the fallback path must never run after
   the worker exists — that once produced two live workers. A CSP that forbids
   `blob:` workers still leaves a `network-only` note, as before.
8. **A worker terminated the instant it replies can lose its capture.** The
   streaming capture is posted after the cloned response has been read, which
   can land after instantiation finishes, so the reply and the capture race.
   Found in the real browser, not in a unit test — the testbed fixtures wait a
   beat before `terminate()` so they demonstrate capture rather than the race.
   Nothing is silently lost: the network observer still notes the module.
9. **IndexedDB is at schema v5.** Upgrades drop all stores rather than
   migrating; the contents are a cache of things the browser can observe again.
   Bump `DB_VERSION` in `extension/src/utils/db.ts` when stores change.
10. **A `Proxy` over an instance's exports throws.** The namespace is frozen with
    a null prototype, so a `get` trap may not return anything but the target's
    own value -- the invariant check raises a `TypeError` inside the page's first
    call into its own module. `runtime-monitor.ts` reproduces the namespace
    instead. Do not "simplify" it back to a proxy.
11. **The backend needs Node 22.13+**, which is where `node:sqlite` stopped
    needing a flag. That is the floor CI runs, and why the matrix starts there
    rather than at 22.12.
12. **Bump `FEATURE_SCHEMA_VERSION` whenever the feature vector changes** —
    added, removed, reordered or rescaled. Inference refuses a model trained on
    a different version rather than scoring the wrong columns, which is the one
    failure here that produces confident nonsense with no way to notice.
13. **JavaScript analysis is off by default, and that is the design, not an
    oversight.** It is the only capture path that reads something the page has
    not published to anyone else. External script contents are never fetched,
    source is never stored, and `eval` is deliberately not hooked -- wrapping it
    turns direct eval into indirect eval and changes scoping.
14. **Runtime thresholds are not corpus-calibrated, and the docs say so.** The
    mechanism is measured; the lines drawn on it are conservative. If you tune
    them, `docs/detection.md` has to change with them, and no detection rate may
    be claimed either way.

---

## Next steps, in order

### The corpus — the only thing Phase 5 is waiting on

The pipeline is built, tested and documented. What does not exist is a labelled
corpus, and it is not a code problem.

```
corpus/
  benign/       WasmBench, npm packages, anything you can vouch for
  malicious/    verified samples -- the hard half
```

```bash
npm run train -w @wasm-sentry/core -- corpus/ --out extension/public/model.json
```

That cross-validates against the heuristics on the same folds, prints both rows,
and says plainly when the model loses to the rules. Drop the model into
`extension/public/`, rebuild, and `classifier-opinion` starts contributing;
without one, nothing in the extension changes.

- **Benign samples are easy. Malicious ones are the blocker.** They may need
  requesting from the authors of the cryptojacking papers in the synopsis.
- **The baseline to beat is now much stronger than it was**, because it includes
  runtime evidence. A classifier trained on static features alone is being
  compared against something that can see more than it can, and it should be
  expected to lose. That is a fair comparison, not a rigged one — but say which
  it is when reporting.
- **Do not ship a model trained on a small corpus** to make the phase look
  finished. The trainer warns below fifty modules and the CLI disclaims every
  run; those exist to be listened to.

### Smaller items

Nothing on the original list is outstanding. What is left is the corpus above,
and whatever the next person finds.

---

## Where the reasoning lives

- [`design-decisions.md`](design-decisions.md) — every significant choice with
  its rationale and the alternatives rejected.
- [`detection.md`](detection.md) — rules, scoring maths, the calibration corpus,
  and the false positive that reshaped the design.
- [`architecture.md`](architecture.md) — the seven stages and which are done.
- [`DESIGN.md`](DESIGN.md) — the visual system: the direction, the tokens, what
  is deliberately banned from it, and the motion brief.
- [`api-spec.md`](api-spec.md) — extension message protocol and backend HTTP API.
- `git log` — every decision with the reasoning that produced it.
