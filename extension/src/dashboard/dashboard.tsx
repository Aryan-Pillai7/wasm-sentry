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
import { duration, formatBytes, hostOf, relativeTime } from "./format";
import "./dashboard.css";

const POLL_MS = 1500;

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
        <p className="muted">
          Nothing yet. Open a page that uses WebAssembly — this fills in on its own.
        </p>
      ) : (
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
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Modules                                                             */
/* ------------------------------------------------------------------ */

function ModuleCard({ module, now }: { module: ModuleRow; now: number }): React.JSX.Element {
  const risk = module.analysis?.risk;
  const summary = module.analysis?.summary;

  return (
    <details className="module">
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
            {risk.findings.map((finding) => (
              <li key={finding.id} className={`finding sev-${finding.severity}`}>
                <div className="finding-head">
                  <span>{finding.title}</span>
                  <span className="muted">{Math.round(finding.confidence * 100)}%</span>
                </div>
                <p className="evidence">{finding.evidence}</p>
                {finding.reference && <p className="reference">{finding.reference}</p>}
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

function Modules({ modules, now }: { modules: ModuleRow[]; now: number }): React.JSX.Element {
  return (
    <section>
      <h2>
        Modules <span className="muted">({modules.length})</span>
      </h2>
      {modules.length === 0 ? (
        <p className="muted">No modules captured yet.</p>
      ) : (
        modules.map((module) => <ModuleCard key={module.hash} module={module} now={now} />)
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
        <h1>Wasm-Sentry</h1>
        <p className={error ? "error" : "muted"}>{error ?? "Loading…"}</p>
      </main>
    );
  }

  return (
    <main>
      <header className="page-head">
        <h1>
          <span className="pulse" /> Wasm-Sentry
        </h1>
        <span className="muted">auditing every page you open · refreshes automatically</span>
      </header>

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
