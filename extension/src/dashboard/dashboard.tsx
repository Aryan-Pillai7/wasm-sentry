/**
 * The dashboard.
 *
 * Capture and analysis run on every page load with no interaction, but all of
 * that is invisible: hooks fire inside pages, work happens in a worker that
 * Chrome keeps killing, and the only ambient output is a badge that is hidden
 * unless the extension is pinned. This page exists so the extension can show
 * its own work -- what it saw, when, and whether its moving parts are alive.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityEvent, ActivityReport, ModuleRow } from "../shared/protocol";
import { duration, formatBytes, hostOf, relativeTime } from "./format";
import { CaughtByStrip, KindBadge, LayerLegend } from "../ui/layers";
import { useArmed, useCountUp } from "../ui/motion";
import { bucketByTime, sparklinePath } from "../ui/sparkline";
import { useScrollSpy } from "../ui/scroll-spy";
import { useElementWidth } from "../ui/measure";
import "./dashboard.css";

const POLL_MS = 1500;

/** The window the activity sparkline covers, and how finely it is sliced. */
const SPARK_SPAN_MS = 5 * 60 * 1000;
const SPARK_BUCKETS = 60;
const SPARK_HEIGHT = 52;
const SPARK_PAD = 3;

/**
 * The sections the nav offers, in page order.
 *
 * Module-level so the reference is stable: `useScrollSpy` rebuilds its
 * observer whenever this changes, and an array built during render changes on
 * every one of the twice-a-second polls.
 */
const SECTIONS = ["status", "activity", "modules", "settings"] as const;

/* ------------------------------------------------------------------ */
/* Hero: the top line, and the shape of the last five minutes          */
/* ------------------------------------------------------------------ */

const FLAGGED_LEVELS = new Set(["medium", "high", "critical"]);

/** One large figure. The value counts rather than jumping -- see `useCountUp`. */
function HeroFigure({
  label,
  value,
  unit,
  foot,
  tone = "neutral",
  index,
}: {
  label: string;
  value: number;
  unit?: string;
  foot: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  index: number;
}): React.JSX.Element {
  const shown = useCountUp(value);
  return (
    <div className={`hero-figure tone-${tone}`} style={{ "--i": index } as React.CSSProperties}>
      <span className="label">{label}</span>
      <span className="value">
        {shown}
        {unit && <span className="unit">{unit}</span>}
      </span>
      <span className="foot">{foot}</span>
    </div>
  );
}

/**
 * Captures per five-second slice over the last five minutes.
 *
 * The feed below answers "what happened"; this answers "how busy has this
 * been", which is the question an audience actually has and the only thing on
 * the page with a shape rather than a value. It is drawn from the same events
 * the table lists -- there is no separate accounting that could disagree with
 * it.
 */
function ActivitySpark({ events, now }: { events: ActivityEvent[]; now: number }): React.JSX.Element {
  // Drawn at the real pixel width of its container rather than into a fixed
  // viewBox that is then stretched -- see `useElementWidth` for why the
  // stretched version cannot animate its own stroke correctly.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(host);

  const geometry = useMemo(() => {
    const counts = bucketByTime(
      events.map((event) => event.timestamp),
      { now, spanMs: SPARK_SPAN_MS, buckets: SPARK_BUCKETS },
    );
    return sparklinePath(counts, { width, height: SPARK_HEIGHT, pad: SPARK_PAD });
  }, [events, now, width]);

  // The trace draws itself in by walking the dash offset down from the full
  // path length, once the undrawn state has painted.
  const drawn = useArmed();

  const floor = SPARK_HEIGHT - SPARK_PAD;

  return (
    <div className="spark">
      <div className="spark-head">
        <span className="legend">Activity · last 5 min</span>
        <span className="peak">
          {geometry.peak === 0 ? "quiet" : `peak ${geometry.peak}/5s`}
        </span>
      </div>
      <div className="spark-box" ref={setHost}>
        <svg
          className="spark-chart"
          width={width}
          height={SPARK_HEIGHT}
          viewBox={`0 0 ${width} ${SPARK_HEIGHT}`}
          role="img"
          aria-label={
            geometry.peak === 0
              ? "No captures in the last five minutes"
              : `Capture activity over the last five minutes, peaking at ${geometry.peak} in one five-second slice`
          }
        >
          <defs>
            <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.24" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line className="spark-baseline" x1="0" y1={floor} x2={width} y2={floor} />
          {geometry.peak > 0 && <path className="spark-area" d={geometry.area} />}
          <path
            className="spark-line"
            d={geometry.line}
            strokeDasharray={geometry.length}
            strokeDashoffset={drawn ? 0 : geometry.length}
          />
        </svg>
      </div>
    </div>
  );
}

function Hero({
  modules,
  events,
  now,
}: {
  modules: ModuleRow[];
  events: ActivityEvent[];
  now: number;
}): React.JSX.Element {
  const flagged = modules.filter((module) =>
    FLAGGED_LEVELS.has(module.analysis?.risk?.level ?? ""),
  ).length;

  const peak = modules.reduce(
    (highest, module) => Math.max(highest, module.analysis?.risk?.score ?? 0),
    0,
  );

  const sites = new Set(modules.map((module) => hostOf(module.lastPageUrl))).size;

  return (
    <div className="hero">
      <div className="hero-figures">
        <HeroFigure
          index={0}
          label="Modules"
          value={modules.length}
          foot="captured and stored"
        />
        <HeroFigure
          index={1}
          label="Flagged"
          value={flagged}
          tone={flagged > 0 ? "warn" : "good"}
          foot={flagged > 0 ? "scored medium or above" : "nothing above low"}
        />
        <HeroFigure
          index={2}
          label="Peak score"
          value={peak}
          unit="/100"
          tone={peak >= 60 ? "bad" : peak >= 30 ? "warn" : "good"}
          foot="the worst single module"
        />
        <HeroFigure index={3} label="Sites" value={sites} foot="distinct hosts seen" />
      </div>
      <ActivitySpark events={events} now={now} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

function StatusCard({
  label,
  value,
  tone = "neutral",
  note,
  index,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
  note?: string | undefined;
  index: number;
}): React.JSX.Element {
  return (
    <div className={`card tone-${tone}`} style={{ "--i": index } as React.CSSProperties}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {note && <div className="card-note">{note}</div>}
    </div>
  );
}

function Status({ report, now }: { report: ActivityReport; now: number }): React.JSX.Element {
  const { status } = report;
  const notificationsOk = status.notificationLevel === "granted";

  return (
    <section id="status">
      <h2>Status</h2>
      <div className="cards">
        <StatusCard
          index={0}
          label="Watching"
          value="Active"
          tone="good"
          note={`worker up ${duration(now - status.workerStartedAt)}`}
        />
        <StatusCard
          index={1}
          label="Last capture"
          value={status.lastCaptureAt ? relativeTime(status.lastCaptureAt, now) : "none yet"}
          tone={status.lastCaptureAt ? "good" : "neutral"}
          note={status.lastCaptureAt ? undefined : "visit a page that uses WebAssembly"}
        />
        <StatusCard index={2} label="Modules stored" value={String(status.artifactCount)} />
        <StatusCard
          index={3}
          label="Network observer"
          value={status.networkObserver ? "On" : "Unavailable"}
          tone={status.networkObserver ? "good" : "warn"}
          note={status.networkObserver ? undefined : "worker-loaded modules will not be noticed"}
        />
        <StatusCard
          index={4}
          label="Notifications"
          value={status.notificationLevel}
          tone={notificationsOk ? "good" : "warn"}
          note={
            notificationsOk
              ? undefined
              : "Chrome is blocking them; check the OS notification settings for Chrome"
          }
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Activity feed                                                       */
/* ------------------------------------------------------------------ */

const KIND_LABELS: Record<ActivityEvent["kind"], string> = {
  captured: "captured",
  analysed: "analysed",
  skipped: "skipped",
  alerted: "alerted",
  cleared: "cleared",
};

function LevelChip({ level, score }: { level?: string; score?: number }): React.JSX.Element | null {
  if (!level) return null;
  return (
    <span className={`chip level-${level}`}>
      {level}
      {score !== undefined ? ` ${score}` : ""}
    </span>
  );
}

function Activity({ events, now }: { events: ActivityEvent[]; now: number }): React.JSX.Element {
  return (
    <section id="activity">
      <h2>
        Activity <span className="muted">({events.length})</span>
      </h2>
      {events.length === 0 ? (
        <p className="empty">Nothing yet. Open a page that uses WebAssembly — this fills in on its own.</p>
      ) : (
        <div className="feed-wrap">
          <table className="feed">
            <tbody>
              {events.map((event, index) => (
                <tr key={`${event.timestamp}-${index}`}>
                  <td className="when">{relativeTime(event.timestamp, now)}</td>
                  <td>
                    <span className={`kind kind-${event.kind}`}>{KIND_LABELS[event.kind]}</span>
                  </td>
                  <td className="site" title={event.pageUrl}>
                    {hostOf(event.pageUrl)}
                  </td>
                  <td className="mono">{event.hash ? event.hash.slice(0, 10) : "—"}</td>
                  <td className="size">{event.size !== undefined ? formatBytes(event.size) : ""}</td>
                  <td className="detail">
                    {event.context === "worker" && <span className="chip">worker</span>}
                    <LevelChip
                      {...(event.level !== undefined ? { level: event.level } : {})}
                      {...(event.score !== undefined ? { score: event.score } : {})}
                    />
                    {event.detail ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Modules                                                             */
/* ------------------------------------------------------------------ */

function ModuleCard({
  module,
  now,
  index,
}: {
  module: ModuleRow;
  now: number;
  index: number;
}): React.JSX.Element {
  const risk = module.analysis?.risk;
  const summary = module.analysis?.summary;

  return (
    <details className="module" style={{ "--i": index } as React.CSSProperties}>
      <summary>
        <span className="mono">{module.hash.slice(0, 12)}</span>
        <span className="site">{hostOf(module.lastPageUrl)}</span>
        <span className="size">{formatBytes(module.size)}</span>
        <span className="when">{relativeTime(module.lastSeen, now)}</span>
        {risk ? (
          <span className={`chip level-${risk.level}`}>
            {risk.level} {risk.score}
          </span>
        ) : (
          <span className="chip">unanalysed</span>
        )}
      </summary>

      <div className="module-body">
        {risk && <p className="headline">{risk.headline}</p>}
        {risk && <CaughtByStrip findings={risk.findings} />}

        {module.analysis?.runtime && (
          <dl className="facts">
            <div>
              <dt>observed</dt>
              <dd>{(module.analysis.runtime.observedMs / 1000).toFixed(0)}s</dd>
            </div>
            <div>
              <dt>executing</dt>
              <dd>{(module.analysis.runtime.wasmTimeMs / 1000).toFixed(1)}s</dd>
            </div>
            <div>
              <dt>cores</dt>
              <dd>{module.analysis.runtime.cpuShare.toFixed(2)}</dd>
            </div>
            <div>
              <dt>contexts</dt>
              <dd>{module.analysis.runtime.contextCount}</dd>
            </div>
            <div>
              <dt>calls</dt>
              <dd>{module.analysis.runtime.callCount}</dd>
            </div>
            <div>
              <dt>timer lag</dt>
              <dd>{module.analysis.runtime.meanDriftMs.toFixed(0)}ms</dd>
            </div>
          </dl>
        )}

        {summary && (
          <dl className="facts">
            <div><dt>functions</dt><dd>{summary.functionCount}</dd></div>
            <div><dt>instructions</dt><dd>{summary.instructionCount}</dd></div>
            <div><dt>loops</dt><dd>{summary.totalLoops}</dd></div>
            <div><dt>max nesting</dt><dd>{summary.maxNesting}</dd></div>
            <div><dt>bitwise</dt><dd>{(summary.bitwiseRatio * 100).toFixed(1)}%</dd></div>
            <div><dt>float</dt><dd>{(summary.floatRatio * 100).toFixed(1)}%</dd></div>
            <div><dt>memory</dt><dd>{summary.memoryInitialPages}p{summary.memoryShared ? " shared" : ""}</dd></div>
            <div><dt>seen</dt><dd>{module.seenCount}x</dd></div>
          </dl>
        )}

        {risk && risk.findings.length > 0 && (
          <ul className="findings">
            {risk.findings.map((finding, findingIndex) => (
              <li
                key={finding.id}
                className={`finding sev-${finding.severity}`}
                style={{ "--i": findingIndex } as React.CSSProperties}
              >
                <div className="finding-head">
                  <span className="finding-title">
                    <KindBadge kind={finding.kind} />
                    {finding.plainSummary || finding.title}
                  </span>
                  <span className="muted">{Math.round(finding.confidence * 100)}%</span>
                </div>
                <details className="tech">
                  <summary>Technical details</summary>
                  <p className="tech-title">{finding.title}</p>
                  <p className="evidence">{finding.evidence}</p>
                  {finding.reference && <p className="reference">{finding.reference}</p>}
                </details>
              </li>
            ))}
          </ul>
        )}

        {module.analysis?.watHeader && (
          <details className="wat">
            <summary>disassembly</summary>
            <pre>{module.analysis.watHeader}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

/**
 * The bar's own palette, stated in tokens rather than in hex.
 *
 * These were literal hex values, which meant the one bar on the page that is
 * meant to be read from across a room used a red that did not match the red on
 * every chip beside it, and did not change with the theme at all.
 *
 * `unanalysed` is named explicitly. It used to fall through to a `var(--tag)`
 * default that no longer exists, so the segment for every module the analyser
 * has not reached yet drew as nothing -- silently under-reporting the part of
 * the bar that says how much is still unknown.
 */
const RISK_LEVEL_COLORS: Record<string, string> = {
  critical: "var(--crit)",
  high: "var(--bad)",
  medium: "var(--warn)",
  low: "var(--good)",
  benign: "var(--good)",
  unanalysed: "var(--line-strong)",
};

const RISK_LEVEL_ORDER = ["critical", "high", "medium", "low", "benign", "unanalysed"] as const;

const RISK_LEVEL_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  benign: "Benign",
  unanalysed: "Unanalysed",
};

/**
 * The one visual a presenter can point at from across a room: every captured
 * module, at a glance, as a single bar instead of a list to be read.
 */
function RiskBreakdown({ modules }: { modules: ModuleRow[] }): React.JSX.Element | null {
  const filled = useArmed();

  if (modules.length === 0) return null;

  const counts: Record<string, number> = {};
  for (const module of modules) {
    const key = module.analysis?.risk?.level ?? "unanalysed";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const total = modules.length;
  const segments = RISK_LEVEL_ORDER.filter((level) => (counts[level] ?? 0) > 0);

  return (
    <div className="risk-bar-wrap">
      <div className="risk-bar">
        {segments.map((level) => (
          <span
            key={level}
            className="risk-bar-seg"
            style={{
              width: filled ? `${((counts[level] ?? 0) / total) * 100}%` : "0%",
              background: RISK_LEVEL_COLORS[level] ?? "var(--line-strong)",
            }}
            title={`${counts[level]} ${RISK_LEVEL_LABELS[level]}`}
          />
        ))}
      </div>
      <div className="risk-bar-legend">
        {segments.map((level) => (
          <span key={level} className="risk-bar-legend-item">
            <span className="dot" style={{ background: RISK_LEVEL_COLORS[level] ?? "var(--line-strong)" }} />
            {counts[level]} {RISK_LEVEL_LABELS[level]}
          </span>
        ))}
      </div>
    </div>
  );
}

function Modules({ modules, now }: { modules: ModuleRow[]; now: number }): React.JSX.Element {
  return (
    <section id="modules">
      <h2>
        Modules <span className="muted">({modules.length})</span>
      </h2>
      <RiskBreakdown modules={modules} />
      {modules.length === 0 ? (
        <p className="empty">No modules captured yet.</p>
      ) : (
        modules.map((module, index) => (
          <ModuleCard key={module.hash} module={module} now={now} index={index} />
        ))
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const TOGGLES: Array<{ key: string; label: string; description: string }> = [
  {
    key: "notifyOnHighRisk",
    label: "Notify on high-risk pages",
    description: "Raises a desktop notification for the high and critical bands only.",
  },
  {
    key: "instrumentWorkers",
    label: "Analyse WebAssembly inside Web Workers",
    description:
      "Carries the capture hooks into workers, which is where a miner would put its kernel. It is the only setting that changes how a page loads its own code, so turn it off if a site misbehaves; the change applies from the next page load.",
  },
  {
    key: "monitorRuntime",
    label: "Measure how modules behave once they run",
    description:
      "Times the exported functions a module hands the page, which is what separates a hashing kernel from an image codec. Timing switches itself off for modules called in a hot loop, so the measurement never becomes the cost.",
  },
  {
    key: "trackNetworkSightings",
    label: "Record blind spots",
    description:
      "Notes Wasm seen on the network that the page hook could not reach, such as modules compiled inside a Web Worker.",
  },
  {
    key: "analyseJavaScript",
    label: "Analyse JavaScript as well as WebAssembly",
    description:
      "Off by default, and the only capture path that is. It reads the source of scripts the page wrote itself, which on a signed-in page can hold far more of your business than a compiled module does. External scripts are never fetched or read — only their origin and whether they are pinned. Source is measured and thrown away; it is never stored and never uploaded.",
  },
  {
    key: "uploadEnabled",
    label: "Upload artifacts to the backend",
    description:
      "Off by default. The modules a page runs can be private, so nothing leaves the browser unless you turn this on.",
  },
];

function Settings({
  settings,
  onChange,
  onClear,
}: {
  settings: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  onClear: () => void;
}): React.JSX.Element {
  return (
    <section id="settings">
      <h2>Settings</h2>
      <div className="settings-panel">
        {TOGGLES.map((toggle) => (
          <label key={toggle.key} className="toggle">
            <input
              type="checkbox"
              checked={settings[toggle.key] === true}
              onChange={(event) => onChange({ [toggle.key]: event.target.checked })}
            />
            <span>
              <strong>{toggle.label}</strong>
              <span className="muted">{toggle.description}</span>
            </span>
          </label>
        ))}
      </div>

      {/* Set apart from the toggles above it. Everything in that panel is
          reversible with a second click; this is not, and a destructive
          control sitting in the same rhythm as six harmless ones is how it
          gets pressed by accident. */}
      <div className="danger-zone">
        <button className="danger" onClick={onClear}>
          Clear stored data
        </button>
        <span className="muted">Removes every captured module, verdict and activity entry.</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Page shell                                                          */
/* ------------------------------------------------------------------ */

/**
 * The pulse is only shown once a report has actually arrived. A heartbeat
 * beside a page that has not heard from the service worker would be claiming
 * something the page does not know yet.
 */
function Masthead({ live }: { live: boolean }): React.JSX.Element {
  return (
    <header className="masthead">
      <h1>
        {live && <span className="pulse" />}
        <span className="brand-a">Wasm</span>
        <span className="brand-b">-Sentry</span>
      </h1>
      <span className="tagline">auditing every page you open · refreshes automatically</span>
    </header>
  );
}

const SECTION_LABELS: Record<(typeof SECTIONS)[number], string> = {
  status: "Status",
  activity: "Activity",
  modules: "Modules",
  settings: "Settings",
};

/**
 * Plain anchors, so the nav works before React has hydrated anything and
 * keyboard and middle-click behave the way they do everywhere else. The
 * scroll-spy only decorates it.
 */
function SectionNav(): React.JSX.Element {
  const active = useScrollSpy(SECTIONS);
  return (
    <nav className="sections" aria-label="Sections">
      {SECTIONS.map((id) => (
        <a key={id} href={`#${id}`} aria-current={active === id ? "true" : undefined}>
          {SECTION_LABELS[id]}
        </a>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

function Dashboard(): React.JSX.Element {
  const [report, setReport] = useState<ActivityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every relative time on the page is rendered against this one clock reading,
  // taken when the report arrived, so a row cannot say "2s ago" while the row
  // under it says "3s ago" for the same instant. Zero until the first report
  // lands, which is also the point at which anything using it starts rendering.
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const next = (await chrome.runtime.sendMessage({ type: "wasm-sentry:activity" })) as
        | ActivityReport
        | undefined;
      if (!next || !Array.isArray(next.events)) {
        setError("The background service worker did not return a usable report.");
        return;
      }
      setReport(next);
      setError(null);
      setNow(Date.now());
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  // Chained timeouts rather than setInterval: the next poll is scheduled only
  // once the previous one has answered, so a slow or sleeping service worker
  // cannot accumulate a backlog of overlapping requests that all resolve at
  // once and fight over the same state.
  useEffect(() => {
    let live = true;
    let timer = 0;

    const tick = async (): Promise<void> => {
      if (!live) return;
      await load();
      if (live) timer = self.setTimeout(() => void tick(), POLL_MS);
    };

    timer = self.setTimeout(() => void tick(), 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [load]);

  const update = useCallback(
    (patch: Record<string, unknown>) => {
      void chrome.runtime
        .sendMessage({ type: "wasm-sentry:update-settings", patch })
        .then(() => load());
    },
    [load],
  );

  const clear = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "wasm-sentry:clear-all" }).then(() => load());
  }, [load]);

  if (!report) {
    return (
      <main>
        <Masthead live={false} />
        {error ? (
          <p className="error">{error}</p>
        ) : (
          // Shaped like the hero and status cards it is standing in for, so
          // the page does not jump when the first poll answers.
          <div className="loading" aria-label="Loading">
            <div className="skeleton sk-hero" />
            <div className="sk-cards">
              <div className="skeleton sk-card" />
              <div className="skeleton sk-card" />
              <div className="skeleton sk-card" />
              <div className="skeleton sk-card" />
            </div>
          </div>
        )}
      </main>
    );
  }

  return (
    <main>
      <Masthead live />

      <Hero modules={report.modules} events={report.events} now={now} />

      <SectionNav />

      <LayerLegend />

      {error && <p className="error">Last refresh failed: {error}</p>}

      <Status report={report} now={now} />
      <Activity events={report.events} now={now} />
      <Modules modules={report.modules} now={now} />
      <Settings settings={report.settings} onChange={update} onClear={clear} />
    </main>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<Dashboard />);
