# Working Context

Read this first if you are picking the project up on a different machine or
after a break. It is the handover note: current state, how to run things,
conventions in force, the gotchas that waste time, and what to do next.

Last updated after the dashboard landed.

---

## Where things stand

| Phase | Scope | Status |
|---|---|---|
| 1 | Capture layer | complete, tested |
| 2 | Disassembly + static analysis | complete, tested |
| 3 | Heuristics + Privacy Scorecard | complete, tested |
| 4 | Runtime behavioural monitoring | not started |
| 5 | ML classifier | not started |
| — | JS bundle / supply-chain analysis | not started |
| — | Backend SQLite + job queue | not started (health endpoint only) |

Beyond the three phases, the extension has since gained a dashboard, desktop
notifications, generated icons, a testbed page, CI, and worker instrumentation
that closed the last capture blind spot. 118 tests, all green: 41 in `core`,
77 in `extension`.

```
d83f408  Add a dashboard so the extension can show its own work
61ef96f  Notify on high-risk pages, and give the extension a real icon
f805222  Fix the popup hanging on "Reading capture log" and make failures diagnosable
71f0dfc  Add an end-to-end testbed exercising every capture path
4c18abf  Remove stray file and replace the Vite template extension README
3b337b3  Phase 3: heuristic detection and the Privacy Scorecard
0f562de  Phase 2: static analysis pipeline -- parser, CFG, WAT and features
d42780a  Phase 1: rebuild the capture layer around main-world API hooks
```

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

Nine buttons, one per capture path — streaming, in-memory buffer, compile +
instantiate, the `Module` constructor, a `blob:` URL, a dedup check, a classic
Worker, a module Worker, and a Worker inside a Worker. Expect a red badge, one
notification for `miner.wasm` at 63/100, the feed filling in live, and the
worker modules tagged **in a Worker** rather than listed as not analysed.

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

Expect five captures: one `page`, and four `worker` — a classic worker, a module
worker, a worker nested inside one, and that nested worker's own parent.

### Command line

```bash
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
    heuristics.ts        the 12 detection rules
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
  scripts/               inspect, calibrate, emit-fixtures

extension/
  src/
    content/injector.ts       MAIN-world entry
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
    shared/protocol.ts        message types + caps
    utils/db.ts               IndexedDB (schema v3)
    utils/settings.ts         local-first defaults
  scripts/build-scripts.mjs   esbuild; builds the prelude to a string first
  scripts/make-icons.mjs      renders + encodes the PNG icons
  test/pipeline.test.ts       end-to-end through the real service worker
  test/worker-prelude.test.ts builds the prelude and runs it in a fake worker scope

backend/                 health endpoint only, ESM + tsx
testbed/                 local page exercising every capture path
docs/                    architecture, detection, api-spec, this file
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
9. **IndexedDB is at schema v3.** Upgrades drop all stores rather than migrating;
   the contents are a cache of things the browser can observe again. Bump
   `DB_VERSION` in `extension/src/utils/db.ts` when stores change.

---

## Next steps, in order

### Phase 4 — runtime behavioural monitoring

The most valuable remaining work, because calibration established that **static
density cannot separate mining from compression** (see `docs/detection.md`) —
runtime CPU is what settles it. This is also what MINOS does.

1. Extend the main-world injector to sample:
   - wall-clock time inside exported Wasm functions (wrap the instantiated
     module's `exports` object);
   - `requestAnimationFrame` / `performance.now()` drift as a CPU-saturation
     proxy;
   - `Worker` constructor calls and their count (worker fan-out);
   - `WebSocket` opens and message volume, attributed to the frame.
2. Attribute samples back to the artifact hash — the instantiation that produced
   the exports is the same call the hook already sees, so carry the hash through.
3. Add runtime rules to `heuristics.ts`, taking a `RuntimeFeatures` input
   alongside `ModuleFeatures`.
4. Feed them into the existing `assessRisk()`. The aggregation already takes an
   arbitrary finding list, so nothing there needs redesigning.
5. Expect `mining-corroborated` to become far stronger: kernel plus sustained CPU
   is close to conclusive.

Watch out for: sampling must not itself burn CPU, and a busy page is not a mining
page — use sustained load over tens of seconds, not a spike.

### Phase 5 — ML classifier

Blocked on data, not code.

- **A labelled corpus is the blocker.** WasmBench for benign; malicious samples
  are the hard part and may need requesting from the authors of the cryptojacking
  papers in the synopsis. Until then no detection rate can be claimed honestly,
  and none is claimed anywhere in this repository.
- The feature pipeline is already done: `ModuleFeatures` plus the per-function
  rows is the training input, and `opcodeCounts` gives the opcode-sequence view
  Deep-Wasm uses.
- Train outside the extension; ship inference only.
- **The heuristics are the baseline to beat.** Report the model against them, not
  against nothing.

### Smaller items

- Backend Phase 2: SQLite, job queue, `POST /api/artifacts` taking raw bytes as
  `application/octet-stream`. Spec already written in `docs/api-spec.md`.
- JS bundle analysis — needs its own consent design first; shipping page scripts
  anywhere is a bigger privacy question than Wasm modules.

---

## Where the reasoning lives

- [`design-decisions.md`](design-decisions.md) — every significant choice with
  its rationale and the alternatives rejected.
- [`detection.md`](detection.md) — rules, scoring maths, the calibration corpus,
  and the false positive that reshaped the design.
- [`architecture.md`](architecture.md) — the seven stages and which are done.
- [`api-spec.md`](api-spec.md) — extension message protocol and backend HTTP API.
- `git log` — every decision with the reasoning that produced it.
