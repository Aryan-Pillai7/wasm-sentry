/**
 * The dashboard.
 *
 * Capture and analysis run on every page load with no interaction, but all of
 * that is invisible: hooks fire inside pages, work happens in a worker that
 * Chrome keeps killing, and the only ambient output is a badge that is hidden
 * unless the extension is pinned. This page exists so the extension can show
 * its own work -- what it saw, when, and whether its moving parts are alive.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityEvent, ActivityReport, ModuleRow } from "../shared/protocol";
import type { Finding } from "@wasm-sentry/core";
import { duration, formatBytes, hostOf, relativeTime } from "./format";
import "./dashboard.css";

const POLL_MS = 1500;

const FINDING_KIND_LABELS: Record<Finding["kind"], string> = {
  static: "Rule",
  runtime: "Behavior",
  model: "AI",
};

const FINDING_KIND_TITLES: Record<Finding["kind"], string> = {
  static: "Static rule — the bytes, before anything runs",
  runtime: "Runtime rule — what the module was observed doing",
  model: "Trained classifier — a model's opinion, not a measurement",
};

function KindBadge({ kind }: { kind: Finding["kind"] }): React.JSX.Element {
  return (
    <span className={`kind-badge k-${kind}`} title={FINDING_KIND_TITLES[kind]}>
      {FINDING_KIND_LABELS[kind]}
    </span>
  );
}

/** The three detection layers, stated once so a badge on a finding is legible without a lookup. */
function LayerLegend(): React.JSX.Element {
  return (
    <div className="layers">
      {(["static", "runtime", "model"] as const).map((kind) => (
        <span key={kind} className={`layer-chip k-${kind}`} title={FINDING_KIND_TITLES[kind]}>
          <span className="dot" />
          {FINDING_KIND_LABELS[kind]}
        </span>
      ))}
    </div>
  );
}

/**
 * Per-module "caught by" counts, for a presenter who wants to point at one
 * spot and say which layer found what -- without scrolling and reading
 * every finding's badge individually.
 */
function CaughtByStrip({ findings }: { findings: readonly Finding[] }): React.JSX.Element | null {
  if (findings.length === 0) return null;
  const counts = { static: 0, runtime: 0, model: 0 } as Record<Finding["kind"], number>;
  for (const finding of findings) counts[finding.kind]++;

  return (
    <div className="caught-by">
      {(["static", "runtime", "model"] as const)
        .filter((kind) => counts[kind] > 0)
        .map((kind) => (
          <span key={kind} className={`caught-by-item k-${kind}`} title={FINDING_KIND_TITLES[kind]}>
            <span className="dot" />
            {counts[kind]} {FINDING_KIND_LABELS[kind]}
          </span>
        ))}
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
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
  note?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={`card tone-${tone}`}>
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
    <section>
      <h2>Status</h2>
      <div className="cards">
        <StatusCard
          label="Watching"
          value="Active"
          tone="good"
          note={`worker up ${duration(now - status.workerStartedAt)}`}
        />
        <StatusCard
          label="Last capture"
          value={status.lastCaptureAt ? relativeTime(status.lastCaptureAt, now) : "none yet"}
          tone={status.lastCaptureAt ? "good" : "neutral"}
          note={status.lastCaptureAt ? undefined : "visit a page that uses WebAssembly"}
        />
        <StatusCard label="Modules stored" value={String(status.artifactCount)} />
        <StatusCard
          label="Network observer"
          value={status.networkObserver ? "On" : "Unavailable"}
          tone={status.networkObserver ? "good" : "warn"}
          note={status.networkObserver ? undefined : "worker-loaded modules will not be noticed"}
        />
        <StatusCard
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
    <section>
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

const RISK_LEVEL_COLORS: Record<string, string> = {
  critical: "#a40e26",
  high: "#d1242f",
  medium: "#bf8700",
  low: "#2da44e",
  benign: "#2da44e",
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
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setFilled(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [modules.length]);

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
              background: RISK_LEVEL_COLORS[level] ?? "var(--tag)",
            }}
            title={`${counts[level]} ${RISK_LEVEL_LABELS[level]}`}
          />
        ))}
      </div>
      <div className="risk-bar-legend">
        {segments.map((level) => (
          <span key={level} className="risk-bar-legend-item">
            <span className="dot" style={{ background: RISK_LEVEL_COLORS[level] ?? "var(--muted)" }} />
            {counts[level]} {RISK_LEVEL_LABELS[level]}
          </span>
        ))}
      </div>
    </div>
  );
}

function Modules({ modules, now }: { modules: ModuleRow[]; now: number }): React.JSX.Element {
  return (
    <section>
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
    <section>
      <h2>Settings</h2>
      {TOGGLES.map((toggle) => (
        <label key={toggle.key} className="toggle">
          <input
            type="checkbox"
            checked={settings[toggle.key] === true}
            onChange={(event) => onChange({ [toggle.key]: event.target.checked })}
          />
          <span>
            <strong>{toggle.label}</strong>
            <span className="muted"> {toggle.description}</span>
          </span>
        </label>
      ))}

      <p>
        <button className="danger" onClick={onClear}>
          Clear stored data
        </button>
        <span className="muted"> Removes every captured module, verdict and activity entry.</span>
      </p>
    </section>
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
        <h1>
          <span className="brand-a">Wasm</span>
          <span className="brand-b">-Sentry</span>
        </h1>
        <p className={error ? "error" : "muted"}>{error ?? "Loading…"}</p>
      </main>
    );
  }

  return (
    <main>
      <header className="page-head">
        <h1>
          <span className="pulse" />
          <span className="brand-a">Wasm</span>
          <span className="brand-b">-Sentry</span>
        </h1>
        <span className="muted">auditing every page you open · refreshes automatically</span>
      </header>

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
