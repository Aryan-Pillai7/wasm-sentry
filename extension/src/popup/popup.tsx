import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AnalysisSummary, Finding, PageScorecard, RiskAssessment } from "@wasm-sentry/core";
import type { TabReport, TabArtifactView } from "../shared/protocol";
import { loadReport } from "./load-report";
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
      <div className="score-row">
        <span className="level">{LEVEL_LABELS[card.level] ?? card.level}</span>
        {card.moduleCount > 0 && <span className="score">{card.score}/100</span>}
      </div>
      <p className="headline">{card.headline}</p>
      {card.unanalysedCount > 0 && (
        <p className="caveat">
          {card.unanalysedCount} module(s) were seen but not analysed — this verdict does not cover
          them.
        </p>
      )}
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }): React.JSX.Element {
  return (
    <li className={`finding sev-${finding.severity}`}>
      <div className="finding-head">
        <span className="finding-title">{finding.title}</span>
        <span className="confidence">{Math.round(finding.confidence * 100)}%</span>
      </div>
      <p className="evidence">{finding.evidence}</p>
      {finding.reference && <p className="reference">{finding.reference}</p>}
    </li>
  );
}

function Findings({ risk }: { risk: RiskAssessment }): React.JSX.Element | null {
  if (risk.findings.length === 0) return null;
  return (
    <ul className="findings">
      {risk.findings.map((finding) => (
        <FindingRow key={finding.id} finding={finding} />
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
          <dd>
            {summary.memoryInitialPages}p
            {summary.memoryMaxPages !== null ? ` / ${summary.memoryMaxPages}p` : ""}
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

function ArtifactCard({ artifact }: { artifact: TabArtifactView }): React.JSX.Element {
  const label = artifact.url.startsWith("inline:")
    ? `compiled from memory (${artifact.api})`
    : artifact.url;
  const analysis = artifact.analysis;

  return (
    <li className="artifact">
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

      {analysis?.risk && <Findings risk={analysis.risk} />}
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
          <h1>Wasm-Sentry</h1>
        </header>
        <p className="error">{failure.message}</p>
        {failure.hint && <p className="caveat">{failure.hint}</p>}
        <p>
          <button onClick={() => setAttempt((value) => value + 1)}>Retry</button>
        </p>
      </div>
    );
  }

  if (!report) return <div className="panel muted">Reading capture log…</div>;

  const notes = report.notes;

  return (
    <div className="panel">
      <header>
        <h1>Wasm-Sentry</h1>
        <span className="count">{report.artifacts.length} modules</span>
      </header>

      {failure && <p className="caveat">Last refresh failed: {failure.message}</p>}

      <Scorecard card={report.scorecard} />

      {report.artifacts.length === 0 ? (
        <p className="muted">
          No WebAssembly captured on this page yet. Reload the page if it was already open when the
          extension started.
        </p>
      ) : (
        <ul className="artifacts">
          {report.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.hash} artifact={artifact} />
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <section className="notes">
          <h2>Not analysed ({notes.length})</h2>
          <ul>
            {notes.map((note, index) => (
              <li key={`${note.url}-${index}`}>
                <span className="reason">{NOTE_LABELS[note.reason] ?? note.reason}</span>
                <span className="note-url" title={note.url}>
                  {note.url || "unknown URL"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<Popup />);
