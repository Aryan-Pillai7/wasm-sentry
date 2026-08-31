import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AnalysisSummary,
  Finding,
  PageScorecard,
  RiskAssessment,
  RuntimeFeatures,
} from "@wasm-sentry/core";
import type { TabReport, TabArtifactView, TabScriptView } from "../shared/protocol";
import { loadReport } from "./load-report";
import { CaughtByStrip, KindBadge, LayerLegend } from "../ui/layers";
import { ringGeometry } from "../ui/gauge";
import { useArmed, useCountUp } from "../ui/motion";
import "./popup.css";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

const NOTE_LABELS: Record<string, string> = {
  "too-large": "exceeded the size cap",
  "rate-limited": "rate limited",
  "read-failed": "could not be read",
  "network-only": "loaded outside the page world",
};

const LEVEL_LABELS: Record<string, string> = {
  benign: "No concerns",
  low: "Minor notes",
  medium: "Worth a look",
  high: "Likely unwanted",
  critical: "Almost certainly unwanted",
};

/**
 * The score, as a dial.
 *
 * A stroked SVG arc rather than the `conic-gradient` this used to be. The
 * gradient could not draw a track behind the unfilled portion, could not round
 * the end of the arc, and could only be animated through a registered custom
 * property; the arc gets all three and animates on `stroke-dashoffset`.
 *
 * The arc and the figure inside it are driven separately -- CSS transition and
 * `useCountUp` -- but over the same duration and matched curves, so they
 * arrive together.
 */
function ScoreGauge({ score }: { score: number }): React.JSX.Element {
  const ring = ringGeometry(score, { radius: 23, stroke: 5 });
  const shown = useCountUp(score);

  // The first paint must show an empty ring for the transition to have
  // somewhere to animate from, or the arc is simply present at its final
  // length. `useArmed` handles that, and the reduced-motion case with it.
  const armed = useArmed();

  return (
    <div className="gauge" title={`${score} out of 100`}>
      <svg width={ring.size} height={ring.size} aria-hidden="true">
        <circle
          className="gauge-track"
          cx={ring.centre}
          cy={ring.centre}
          r={ring.radius}
          fill="none"
          strokeWidth={ring.stroke}
        />
        <circle
          className="gauge-arc"
          cx={ring.centre}
          cy={ring.centre}
          r={ring.radius}
          fill="none"
          strokeWidth={ring.stroke}
          strokeDasharray={ring.circumference}
          strokeDashoffset={armed ? ring.offset : ring.circumference}
        />
      </svg>
      <span className="gauge-value">{shown}</span>
      <span className="gauge-of">/100</span>
    </div>
  );
}

/**
 * The Privacy Scorecard.
 *
 * The score is never shown on its own. It sits above the findings that produced
 * it and states its own coverage, because a verdict a user cannot interrogate
 * is a verdict they cannot act on -- which is the failure mode this project set
 * out to fix.
 */
function Scorecard({ card }: { card: PageScorecard }): React.JSX.Element {
  return (
    <section className={`scorecard level-${card.level}`}>
      {card.moduleCount > 0 && <ScoreGauge score={card.score} />}
      <div className="score-text">
        <div className="level">{LEVEL_LABELS[card.level] ?? card.level}</div>
        <p className="headline">{card.headline}</p>
        {card.unanalysedCount > 0 && (
          <p className="caveat">
            {card.unanalysedCount} module(s) were seen but not analysed — this verdict does not
            cover them.
          </p>
        )}
      </div>
    </section>
  );
}

function FindingRow({ finding, index }: { finding: Finding; index: number }): React.JSX.Element {
  return (
    <li className={`finding sev-${finding.severity}`} style={{ "--i": index } as React.CSSProperties}>
      <div className="finding-head">
        <span className="finding-head-main">
          <KindBadge kind={finding.kind} />
          <span className="finding-title">{finding.plainSummary || finding.title}</span>
        </span>
        <span className="confidence">{Math.round(finding.confidence * 100)}%</span>
      </div>
      <details className="tech">
        <summary>Technical details</summary>
        <p className="tech-title">{finding.title}</p>
        <p className="evidence">{finding.evidence}</p>
        {finding.reference && <p className="reference">{finding.reference}</p>}
      </details>
    </li>
  );
}

function Findings({ risk }: { risk: RiskAssessment }): React.JSX.Element | null {
  if (risk.findings.length === 0) return null;
  return (
    <ul className="findings">
      {risk.findings.map((finding, index) => (
        <FindingRow key={finding.id} finding={finding} index={index} />
      ))}
    </ul>
  );
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * The structural facts, stated plainly. There is no verdict yet -- risk scoring
 * is the next phase -- and showing the evidence without one is deliberate:
 * a number a user can check beats a banner they have to trust.
 */
function StaticFacts({ summary }: { summary: AnalysisSummary }): React.JSX.Element {
  const flags: string[] = [];
  if (summary.memoryShared) flags.push("shared memory");
  if (summary.memoryGrowSites > 0) flags.push(`${summary.memoryGrowSites} memory.grow`);
  if (summary.indirectCalls > 0) flags.push(`${summary.indirectCalls} indirect calls`);
  if (summary.stripped) flags.push("stripped");
  if (summary.truncatedFunctions > 0) flags.push(`${summary.truncatedFunctions} undecodable`);

  return (
    <div className="facts">
      <dl>
        <div><dt>functions</dt><dd>{summary.functionCount}</dd></div>
        <div><dt>loops</dt><dd>{summary.totalLoops}</dd></div>
        <div><dt>max nesting</dt><dd>{summary.maxNesting}</dd></div>
        <div><dt>bitwise</dt><dd>{percent(summary.bitwiseRatio)}</dd></div>
        <div><dt>float</dt><dd>{percent(summary.floatRatio)}</dd></div>
        <div>
          <dt>memory</dt>
          {/* "256p / 512p" does not fit a third of a 380px popup and was being
              ellipsised down to "256p / ...", losing the ceiling -- which is
              the half that says how far the module is allowed to grow. */}
          <dd>
            {summary.memoryMaxPages !== null
              ? `${summary.memoryInitialPages}/${summary.memoryMaxPages}p`
              : `${summary.memoryInitialPages}p`}
          </dd>
        </div>
      </dl>

      {flags.length > 0 && (
        <div className="flags">
          {flags.map((flag) => (
            <span key={flag} className="flag">{flag}</span>
          ))}
        </div>
      )}

      {summary.importNames.length > 0 && (
        <div className="imports" title={summary.importNames.join("\n")}>
          imports {summary.importNames.slice(0, 3).join(", ")}
          {summary.importNames.length > 3 ? ` +${summary.importNames.length - 3} more` : ""}
        </div>
      )}
    </div>
  );
}

/**
 * What the module has actually been seen doing.
 *
 * Shown next to the static facts rather than folded into them, because the two
 * answer different questions and a reader needs to know which is which: the
 * static numbers describe what the module *is*, these describe what it *did*.
 */
function RuntimeFacts({ runtime }: { runtime: RuntimeFeatures }): React.JSX.Element {
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;

  return (
    <div className="facts">
      <dl>
        <div><dt>watched</dt><dd>{seconds(runtime.observedMs)}</dd></div>
        <div><dt>executing</dt><dd>{seconds(runtime.wasmTimeMs)}</dd></div>
        <div><dt>cores</dt><dd>{runtime.cpuShare.toFixed(2)}</dd></div>
        <div><dt>contexts</dt><dd>{runtime.contextCount}</dd></div>
      </dl>
      {runtime.timingStopped && (
        <div className="caveat">
          timing stopped for this module — it is called too often to measure each call, so the
          figure above is a floor
        </div>
      )}
    </div>
  );
}

function ArtifactCard({
  artifact,
  index,
}: {
  artifact: TabArtifactView;
  index: number;
}): React.JSX.Element {
  const label = artifact.url.startsWith("inline:")
    ? `compiled from memory (${artifact.api})`
    : artifact.url;
  const analysis = artifact.analysis;

  return (
    <li className="artifact" style={{ "--i": index } as React.CSSProperties}>
      <div className="artifact-head">
        <code className="hash">{artifact.hash.slice(0, 12)}</code>
        <span className="size">{formatBytes(artifact.size)}</span>
      </div>
      <div className="artifact-url" title={artifact.url}>
        {label}
      </div>
      <div className="artifact-meta">
        <span className="tag">{artifact.kind}</span>
        {artifact.api ? <span className="tag">{artifact.api}</span> : null}
        {artifact.context === "worker" ? <span className="tag">in a Worker</span> : null}
        {artifact.sightings > 1 ? <span className="tag">x{artifact.sightings}</span> : null}
        {analysis?.risk && (
          <span className={`verdict level-${analysis.risk.level}`}>{analysis.risk.score}</span>
        )}
        {analysis?.ok ? (
          <span className="pending">parsed in {analysis.elapsedMs}ms</span>
        ) : (
          <span className="pending">{analysis ? analysis.reason : "awaiting analysis"}</span>
        )}
      </div>

      {analysis?.risk && <CaughtByStrip findings={analysis.risk.findings} />}
      {analysis?.risk && <Findings risk={analysis.risk} />}
      {analysis?.runtime && <RuntimeFacts runtime={analysis.runtime} />}
      {analysis?.summary && <StaticFacts summary={analysis.summary} />}

      {analysis?.watHeader && (
        <details className="wat">
          <summary>disassembly</summary>
          <pre>{analysis.watHeader}</pre>
        </details>
      )}
    </li>
  );
}

const SCRIPT_ORIGIN_LABELS: Record<string, string> = {
  inline: "inline script",
  "injected-inline": "script injected at runtime",
  Function: "code built with new Function",
};

/**
 * An analysed piece of JavaScript.
 *
 * Deliberately shows measurements and never source. The extension does not
 * keep the source -- see the consent note in `script-hooks.ts` -- so there is
 * nothing here to show even if it were wanted.
 */
function ScriptCard({
  script,
  index,
}: {
  script: TabScriptView;
  index: number;
}): React.JSX.Element {
  const analysis = script.analysis;
  const summary = analysis.summary;

  return (
    <li className="artifact" style={{ "--i": index } as React.CSSProperties}>
      <div className="artifact-head">
        <code className="hash">{script.hash.slice(0, 12)}</code>
        <span className="size">{formatBytes(script.byteLength)}</span>
      </div>
      <div className="artifact-url">
        {SCRIPT_ORIGIN_LABELS[script.origin] ?? script.origin}
      </div>
      <div className="artifact-meta">
        <span className="tag">js</span>
        {analysis.truncated ? <span className="tag">partly scanned</span> : null}
        {analysis.risk && (
          <span className={`verdict level-${analysis.risk.level}`}>{analysis.risk.score}</span>
        )}
      </div>

      {analysis.risk && <CaughtByStrip findings={analysis.risk.findings} />}
      {analysis.risk && <Findings risk={analysis.risk} />}

      {summary && (
        <div className="facts">
          <dl>
            <div><dt>lines</dt><dd>{summary.lineCount}</dd></div>
            <div><dt>escapes</dt><dd>{percent(summary.escapeDensity)}</dd></div>
            <div><dt>entropy</dt><dd>{summary.entropy.toFixed(2)}</dd></div>
            <div><dt>eval sites</dt><dd>{summary.evalSites}</dd></div>
          </dl>
        </div>
      )}
    </li>
  );
}

function Popup(): React.JSX.Element {
  const [report, setReport] = useState<TabReport | null>(null);
  const [failure, setFailure] = useState<{ message: string; hint?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const outcome = await loadReport({
        queryActiveTab: async () =>
          (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
        sendMessage: (message) => chrome.runtime.sendMessage(message),
      });
      if (cancelled) return;

      if (outcome.status === "ok") {
        setReport(outcome.report);
        setFailure(null);
      } else {
        // Keep the last good report on screen if we have one: a single dropped
        // poll should not blank out the findings the user is reading.
        setFailure({ message: outcome.message, ...(outcome.hint ? { hint: outcome.hint } : {}) });
      }
    }

    void load();
    // The service worker keeps writing while the popup is open.
    const timer = setInterval(() => void load(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [attempt]);

  if (failure && !report) {
    return (
      <div className="panel">
        <header>
          <h1>
            <span className="brand-a">Wasm</span>
            <span className="brand-b">-Sentry</span>
          </h1>
        </header>
        <p className="error">{failure.message}</p>
        {failure.hint && <p className="caveat">{failure.hint}</p>}
        <p>
          <button className="primary" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </p>
      </div>
    );
  }

  // Shaped like the report that is about to replace it, so the panel does not
  // resize under the pointer when the first poll answers. A line of text
  // reading "Reading capture log…" was honest and told the reader nothing.
  if (!report) {
    return (
      <div className="panel">
        <header>
          <h1>
            <span className="pulse" />
            <span className="brand-a">Wasm</span>
            <span className="brand-b">-Sentry</span>
          </h1>
        </header>
        <div className="loading" aria-label="Reading capture log">
          <div className="skeleton sk-card" />
          <div className="skeleton sk-row" />
          <div className="skeleton sk-row" />
        </div>
      </div>
    );
  }

  const notes = report.notes;

  // A module that scored 0 has nothing to say -- clutter, not a finding. A module
  // still awaiting analysis has no score yet at all, which is not the same thing
  // as a score of 0, so it stays visible until it is actually scored.
  const scoredArtifacts = report.artifacts.filter(
    (artifact) => (artifact.analysis?.risk?.score ?? 1) > 0,
  );
  const scoredScripts = (report.scripts ?? []).filter(
    (script) => (script.analysis.risk?.score ?? 1) > 0,
  );

  return (
    <div className="panel">
      <header>
        <h1>
          <span className="pulse" />
          <span className="brand-a">Wasm</span>
          <span className="brand-b">-Sentry</span>
        </h1>
        <span className="count">{scoredArtifacts.length} modules</span>
      </header>

      {failure && <p className="caveat">Last refresh failed: {failure.message}</p>}

      <LayerLegend />

      <Scorecard card={report.scorecard} />

      {scoredArtifacts.length === 0 ? (
        <p className="empty">
          {report.artifacts.length === 0
            ? "No WebAssembly captured on this page yet. Reload the page if it was already open when the extension started."
            : `${report.artifacts.length} module(s) captured, none scored above zero.`}
        </p>
      ) : (
        <ul className="artifacts">
          {scoredArtifacts.map((artifact, index) => (
            <ArtifactCard key={artifact.hash} artifact={artifact} index={index} />
          ))}
        </ul>
      )}

      {scoredScripts.length > 0 && (
        <section className="notes">
          <h2>JavaScript ({scoredScripts.length})</h2>
          <ul className="artifacts">
            {scoredScripts.map((script, index) => (
              <ScriptCard key={script.hash} script={script} index={index} />
            ))}
          </ul>
        </section>
      )}

      {report.supplyChain && report.supplyChain.findings.length > 0 && (
        <section className="notes">
          <h2>Supply chain</h2>
          <Findings risk={report.supplyChain} />
        </section>
      )}


      {notes.length > 0 && (
        <section className="notes">
          <h2>Not analysed ({notes.length})</h2>
          <ul>
            {notes.map((note, index) => (
              <li key={`${note.url}-${index}`} className="note-row">
                <span className="reason">{NOTE_LABELS[note.reason] ?? note.reason}</span>
                <span className="note-url" title={note.url}>
                  {note.url || "unknown URL"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="footer">
        <button className="primary" onClick={() => void chrome.runtime.openOptionsPage()}>
          Open dashboard
        </button>
        <span className="caveat">Runs on every page automatically.</span>
      </p>
    </div>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<Popup />);
