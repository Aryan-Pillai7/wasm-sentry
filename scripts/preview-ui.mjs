/**
 * Serve the built popup and dashboard with a stubbed extension API.
 *
 * These two surfaces are the hardest part of the project to look at. They only
 * render inside an installed extension, they talk to a service worker Chrome
 * keeps killing, and -- see gotcha 13 in `docs/CONTEXT.md` -- Chrome will not
 * load the packed extension headlessly at all. So the loop for "I changed a
 * colour, does it look right?" was: build, open `chrome://extensions`, reload
 * the unpacked extension, find a page that runs WebAssembly, open the popup.
 * Every time.
 *
 * This serves `extension/dist` over HTTP and injects a small `chrome` stub in
 * front of each page, so the *real built bundles* -- the real components, the
 * real stylesheet -- render against fixed data in an ordinary browser tab.
 *
 * It is a development tool and is not part of the extension: nothing here is
 * bundled, shipped or referenced by the manifest. It proves the interface
 * renders; it proves nothing about capture, which is what `testbed/` is for.
 *
 *   npm run build -w extension
 *   npm run preview:ui
 *   http://localhost:8090/?scene=miner
 *
 * Scenes: miner (the interesting one), clean, empty, loading.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../extension/dist", import.meta.url));
const PORT = Number(process.env.PORT ?? 8090);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * A miner, as the pipeline actually scores one.
 *
 * The numbers are the ones the committed fixture really produces -- 63, high,
 * mining-corroborated -- rather than invented ones, so a screenshot taken from
 * this page is not quietly claiming a verdict the analyser would not reach.
 */
const findings = [
  {
    id: "tight-integer-loop",
    kind: "static",
    title: "Hot integer loop with heavy bitwise work",
    severity: "high",
    confidence: 0.82,
    weight: 26,
    evidence: "31.2% of instructions are shifts, rotates and xors across 14 loops at nesting depth 3",
    plainSummary: "This module spends nearly all its time scrambling numbers, the way a hash does.",
    reference: "Konoth et al., MineSweeper (CCS 2018)",
  },
  {
    id: "sustained-cpu",
    kind: "runtime",
    title: "Sustained CPU across multiple contexts",
    severity: "high",
    confidence: 0.91,
    weight: 24,
    evidence: "7.94 core-equivalents over 12.0s across 8 contexts; mean timer lateness 41ms",
    plainSummary: "It has been using almost every core on this machine, continuously, since the page loaded.",
  },
  {
    id: "fan-out",
    kind: "runtime",
    title: "Work fanned out to one worker per core",
    severity: "medium",
    confidence: 0.74,
    weight: 12,
    evidence: "8 workers for 8 hardware threads, each holding a 0.99 share",
    plainSummary: "The page started exactly as many background workers as this machine has cores.",
  },
  {
    id: "stripped-binary",
    kind: "static",
    title: "Name section stripped",
    severity: "medium",
    confidence: 0.4,
    weight: 6,
    evidence: "no name section; 0 of 41 functions carry a symbol",
    plainSummary: "The module was built with its function names removed, so it cannot be read easily.",
  },
];

const summary = {
  functionCount: 41,
  instructionCount: 18422,
  totalLoops: 14,
  maxNesting: 3,
  bitwiseRatio: 0.312,
  floatRatio: 0.004,
  memoryInitialPages: 256,
  memoryMaxPages: 512,
  memoryShared: true,
  memoryGrowSites: 0,
  indirectCalls: 12,
  stripped: true,
  truncatedFunctions: 0,
  importNames: ["env.memory", "wasi_snapshot_preview1.fd_write", "env.abort"],
};

const runtime = {
  observedMs: 12_000,
  wasmTimeMs: 11_910,
  cpuShare: 7.94,
  contextCount: 8,
  callCount: 4821,
  meanDriftMs: 41,
  timingStopped: false,
};

const risk = {
  level: "high",
  score: 63,
  headline: "This page is using your processor to mine cryptocurrency.",
  findings,
};

const benignRisk = {
  level: "benign",
  score: 0,
  headline: "Nothing here looks like it is working against you.",
  findings: [],
};

const MINER_HASH = "9f2c41d8ae07b35619cc82a0f4471d3e08b5a6c2d914e7f30ab5c68e2417d9b0";
const CODEC_HASH = "3ac0912ef7d54b8890216cbd7e4a0f13c5992be6108d4a77fe3b0c21d9e84a55";

const analysis = { ok: true, elapsedMs: 34, summary, runtime, risk, watHeader:
  "(module\n  (type (;0;) (func (param i32 i32) (result i32)))\n  (import \"env\" \"memory\" (memory (;0;) 256 512 shared))\n  (func $hash (;0;) (type 0) (param i32 i32) (result i32)\n    local.get 0\n    i32.const 7\n    i32.rotl\n    ..." };

function buildScenes(NOW) {
  return {
  miner: {
    tab: {
      tabId: 1,
      pageUrl: "https://stream.example.com/watch/4471",
      scorecard: {
        pageUrl: "https://stream.example.com/watch/4471",
        level: "high",
        score: 63,
        moduleCount: 2,
        unanalysedCount: 1,
        headline: "This page is using your processor to mine cryptocurrency.",
      },
      artifacts: [
        {
          hash: MINER_HASH,
          kind: "wasm",
          size: 148_992,
          url: "https://cdn.example.net/static/w/k.wasm",
          api: "instantiateStreaming",
          source: "page",
          context: "worker",
          firstSeen: NOW - 12_000,
          lastSeen: NOW - 400,
          sightings: 8,
          analysis,
        },
        {
          hash: CODEC_HASH,
          kind: "wasm",
          size: 61_440,
          url: "https://stream.example.com/assets/decode.wasm",
          api: "instantiate",
          source: "page",
          context: "page",
          firstSeen: NOW - 14_000,
          lastSeen: NOW - 13_800,
          sightings: 1,
          analysis: {
            ok: true,
            elapsedMs: 11,
            summary: { ...summary, bitwiseRatio: 0.06, floatRatio: 0.41, stripped: false, memoryShared: false, memoryMaxPages: null, importNames: ["env.memory"] },
            risk: {
              level: "low",
              score: 8,
              headline: "Ordinary compiled code, most likely a media decoder.",
              findings: [
                {
                  id: "float-heavy",
                  kind: "static",
                  title: "Float-dominated instruction mix",
                  severity: "low",
                  confidence: 0.55,
                  weight: 8,
                  evidence: "41.0% floating point, 6.0% bitwise across 9 loops",
                  plainSummary: "The maths this does looks like audio or video decoding, not hashing.",
                },
              ],
            },
          },
        },
      ],
      notes: [
        {
          url: "https://cdn.example.net/static/w/big.wasm",
          reason: "too-large",
          size: 41_943_040,
          api: "instantiateStreaming",
          timestamp: NOW - 9_000,
        },
      ],
      scripts: [
        {
          hash: "b71e0d4c9a3f2856",
          origin: "injected-inline",
          byteLength: 24_118,
          analysis: {
            ok: true,
            truncated: false,
            summary: { lineCount: 1, escapeDensity: 0.071, entropy: 5.42, evalSites: 3 },
            risk: {
              level: "medium",
              score: 34,
              headline: "A script on this page was written to be hard to read.",
              findings: [
                {
                  id: "obfuscated-source",
                  kind: "static",
                  title: "Escape density far above minification",
                  severity: "medium",
                  confidence: 0.78,
                  weight: 18,
                  evidence: "7.1% escape sequences on one line; minified code sits under 0.5%",
                  plainSummary: "This script was deliberately obscured, not just compressed.",
                },
              ],
            },
          },
        },
      ],
      supplyChain: {
        level: "medium",
        score: 22,
        headline: "Third-party code is loaded without a pin.",
        findings: [
          {
            id: "unpinned-third-party",
            kind: "static",
            title: "Third-party script without subresource integrity",
            severity: "medium",
            confidence: 0.6,
            weight: 14,
            evidence: "cdn.example.net/static/w/loader.js, no integrity attribute",
            plainSummary: "If that other server is ever compromised, this page runs whatever it sends.",
          },
        ],
      },
    },
    activity: buildActivity(NOW, { busy: true }),
  },

  clean: {
    tab: {
      tabId: 1,
      pageUrl: "https://docs.example.org/guide",
      scorecard: {
        pageUrl: "https://docs.example.org/guide",
        level: "benign",
        score: 0,
        moduleCount: 1,
        unanalysedCount: 0,
        headline: "Nothing here looks like it is working against you.",
      },
      artifacts: [
        {
          hash: CODEC_HASH,
          kind: "wasm",
          size: 61_440,
          url: "https://docs.example.org/assets/search.wasm",
          api: "instantiateStreaming",
          source: "page",
          context: "page",
          firstSeen: NOW - 30_000,
          lastSeen: NOW - 29_000,
          sightings: 1,
          analysis: { ok: true, elapsedMs: 9, summary, risk: benignRisk },
        },
      ],
      notes: [],
      scripts: [],
    },
    activity: buildActivity(NOW, { busy: false }),
  },

  empty: {
    tab: {
      tabId: 1,
      pageUrl: "https://example.com/",
      scorecard: {
        pageUrl: "https://example.com/",
        level: "benign",
        score: 0,
        moduleCount: 0,
        unanalysedCount: 0,
        headline: "No WebAssembly on this page.",
      },
      artifacts: [],
      notes: [],
      scripts: [],
    },
    activity: {
      status: {
        workerStartedAt: NOW - 8_000,
        networkObserver: true,
        notificationLevel: "granted",
        artifactCount: 0,
        lastCaptureAt: null,
      },
      settings: defaultSettings(),
      events: [],
      modules: [],
    },
  },
  };
}

function defaultSettings() {
  return {
    notifyOnHighRisk: true,
    instrumentWorkers: true,
    monitorRuntime: true,
    trackNetworkSightings: true,
    analyseJavaScript: false,
    uploadEnabled: false,
  };
}

/**
 * An event feed and module list for the dashboard.
 *
 * The events are spread unevenly across the last five minutes on purpose: an
 * evenly spaced feed makes the sparkline a flat bar, which would hide exactly
 * the bug -- a bucketing off-by-one, a scale that ignores its peak -- that
 * looking at it is meant to catch.
 */
function buildActivity(NOW, { busy }) {
  const events = [];
  // Seconds ago, clustered on purpose: several of these fall in the same
  // five-second bucket so the sparkline has a peak to scale against. An evenly
  // spread feed draws a flat line, which would hide exactly the bugs -- a
  // bucketing off-by-one, a scale that ignores its peak -- that looking at the
  // chart is meant to catch.
  const bursts = busy
    ? [
        3, 4, 6, 7, 9,
        41, 43,
        96, 97, 98, 99, 101, 102, 103,
        144,
        188, 189, 191,
        222, 223, 224, 225, 226, 227, 228, 229,
        271, 274,
      ]
    : [30, 152, 154, 281];

  for (const secondsAgo of bursts) {
    const at = NOW - secondsAgo * 1000;
    events.push({
      timestamp: at,
      kind: secondsAgo % 3 === 0 ? "analysed" : "captured",
      pageUrl: busy ? "https://stream.example.com/watch/4471" : "https://docs.example.org/guide",
      hash: busy ? MINER_HASH : CODEC_HASH,
      size: busy ? 148_992 : 61_440,
      context: busy && secondsAgo > 200 ? "worker" : "page",
      ...(secondsAgo % 3 === 0 ? { level: busy ? "high" : "benign", score: busy ? 63 : 0 } : {}),
    });
  }

  if (busy) {
    events.push({
      timestamp: NOW - 2_000,
      kind: "alerted",
      pageUrl: "https://stream.example.com/watch/4471",
      hash: MINER_HASH,
      level: "high",
      score: 63,
      detail: "desktop notification raised",
    });
    events.push({
      timestamp: NOW - 9_000,
      kind: "skipped",
      pageUrl: "https://stream.example.com/watch/4471",
      size: 41_943_040,
      detail: "exceeded the size cap",
    });
  }

  events.sort((a, b) => b.timestamp - a.timestamp);

  const modules = busy
    ? [
        { hash: MINER_HASH, size: 148_992, seenCount: 8, firstSeen: NOW - 300_000, lastSeen: NOW - 400, lastPageUrl: "https://stream.example.com/watch/4471", analysis },
        { hash: CODEC_HASH, size: 61_440, seenCount: 3, firstSeen: NOW - 280_000, lastSeen: NOW - 13_800, lastPageUrl: "https://stream.example.com/watch/4471", analysis: { ok: true, elapsedMs: 11, summary, risk: { level: "low", score: 8, headline: "Ordinary compiled code.", findings: [] } } },
        { hash: "5d1a7c93fe80b426aa0c1f57e3d982b41c60fa7e", size: 9_216, seenCount: 1, firstSeen: NOW - 120_000, lastSeen: NOW - 118_000, lastPageUrl: "https://ads.example.co/tag" },
      ]
    : [
        { hash: CODEC_HASH, size: 61_440, seenCount: 1, firstSeen: NOW - 300_000, lastSeen: NOW - 29_000, lastPageUrl: "https://docs.example.org/guide", analysis: { ok: true, elapsedMs: 9, summary, risk: benignRisk } },
      ];

  return {
    status: {
      workerStartedAt: NOW - (busy ? 312_000 : 96_000),
      networkObserver: true,
      notificationLevel: busy ? "granted" : "denied",
      artifactCount: modules.length,
      lastCaptureAt: events[0]?.timestamp ?? null,
    },
    settings: { ...defaultSettings(), analyseJavaScript: busy },
    events,
    modules,
  };
}

/* ------------------------------------------------------------------ */
/* The stub                                                            */
/* ------------------------------------------------------------------ */

/**
 * Injected as a classic script in `<head>`, which runs before the deferred
 * module bundle underneath it -- so `chrome` exists by the time React mounts.
 *
 * `loading` answers nothing at all, which is how the skeleton states get seen.
 */
function stub(scene) {
  // Rebuilt per request so the timestamps are relative to *now*, not to when
  // the server booted. Frozen at start-up, a fixture that begins as "3s ago"
  // reads as "8m ago" after a few minutes and every event walks out of the
  // sparkline's own five-minute window -- which is exactly the kind of thing
  // that makes a reviewer distrust the chart rather than the harness.
  const scenes = buildScenes(Date.now());
  const data = scenes[scene] ?? scenes.miner;
  const pending = scene === "loading";

  return `<script>
(() => {
  const TAB = ${JSON.stringify(pending ? null : data.tab)};
  const ACTIVITY = ${JSON.stringify(pending ? null : data.activity)};
  const never = () => new Promise(() => {});

  globalThis.chrome = {
    runtime: {
      sendMessage: (message) => {
        if (${pending}) return never();
        switch (message && message.type) {
          case "wasm-sentry:tab-report": return Promise.resolve(TAB);
          case "wasm-sentry:activity": return Promise.resolve(ACTIVITY);
          case "wasm-sentry:ping": return Promise.resolve({ ok: true });
          default: return Promise.resolve({ ok: true });
        }
      },
      openOptionsPage: () => { location.href = "/src/dashboard/dashboard.html" + location.search; },
      lastError: undefined,
    },
    tabs: { query: () => Promise.resolve([{ id: 1, url: TAB ? TAB.pageUrl : "https://example.com/" }]) },
  };
})();
</script>`;
}

const INDEX = (scene) => `<!doctype html>
<meta charset="utf-8">
<title>Wasm-Sentry UI preview</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #eceff5; color: #14161a; }
  @media (prefers-color-scheme: dark) { body { background: #0b0d11; color: #e6e9ee; } }
  main { max-width: 1180px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font: 700 16px/1 ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; }
  nav { display: flex; gap: 8px; margin: 16px 0 24px; flex-wrap: wrap; }
  nav a { padding: 5px 12px; border: 1px solid #8884; border-radius: 5px; text-decoration: none; color: inherit; font: 600 11px/1.6 ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
  nav a[aria-current] { border-color: #1558d6; color: #1558d6; }
  .frames { display: grid; grid-template-columns: 400px 1fr; gap: 24px; align-items: start; }
  @media (max-width: 900px) { .frames { grid-template-columns: 1fr; } }
  figure { margin: 0; }
  figcaption { font: 600 11px/2 ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; opacity: .6; }
  iframe { width: 100%; border: 1px solid #8884; border-radius: 6px; background: #fff; }
  @media (prefers-color-scheme: dark) { iframe { background: #11151c; } }
  .popup { height: 760px; }
  .dash { height: 1400px; }
</style>
<main>
  <h1>Wasm-Sentry &middot; UI preview</h1>
  <p>The real built bundles, rendered against fixed data. Capture is not running; see <code>testbed/</code> for that.</p>
  <nav>
    ${["miner", "clean", "empty", "loading"].map((name) => `<a href="/?scene=${name}"${name === scene ? ' aria-current="page"' : ""}>${name}</a>`).join("\n    ")}
  </nav>
  <div class="frames">
    <figure>
      <figcaption>Popup &middot; 380px</figcaption>
      <iframe class="popup" src="/src/popup/popup.html?scene=${scene}" title="Popup"></iframe>
    </figure>
    <figure>
      <figcaption>Dashboard</figcaption>
      <iframe class="dash" src="/src/dashboard/dashboard.html?scene=${scene}" title="Dashboard"></iframe>
    </figure>
  </div>
</main>
`;

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

/**
 * Nothing here may be cached.
 *
 * Two things go stale: the bundles, which are rebuilt constantly while working
 * on the interface, and the injected fixtures, whose timestamps are relative
 * to the moment the page was served. A cached page quietly reuses both, and
 * the result is a chart reporting "no captures in the last five minutes" over
 * a feed that is visibly full of them -- which reads as a bug in the chart.
 */
const NO_CACHE = { "cache-control": "no-store, max-age=0" };

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const scene = url.searchParams.get("scene") ?? "miner";

  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, { "content-type": TYPES[".html"], ...NO_CACHE });
    response.end(INDEX(scene));
    return;
  }

  // Contain the served tree to dist/, so a `..` in a path cannot walk out of it.
  const target = normalize(join(ROOT, url.pathname));
  if (!target.startsWith(ROOT + sep)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(target);
    const type = TYPES[extname(target)] ?? "application/octet-stream";

    if (extname(target) === ".html") {
      response.writeHead(200, { "content-type": type, ...NO_CACHE });
      response.end(String(body).replace("<head>", `<head>\n${stub(scene)}`));
      return;
    }

    response.writeHead(200, { "content-type": type, ...NO_CACHE });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`UI preview on http://localhost:${PORT}/?scene=miner`);
  console.log(`serving ${ROOT}`);
  console.log("scenes: miner, clean, empty, loading");
});
