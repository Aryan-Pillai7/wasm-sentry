import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TabReport, TabArtifactView } from "../shared/protocol";
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

function ArtifactCard({ artifact }: { artifact: TabArtifactView }): React.JSX.Element {
  const label = artifact.url.startsWith("inline:")
    ? `compiled from memory (${artifact.api})`
    : artifact.url;
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
        <span className="pending">awaiting analysis</span>
      </div>
    </li>
  );
}

function Popup(): React.JSX.Element {
  const [report, setReport] = useState<TabReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("no active tab");
        const next = (await chrome.runtime.sendMessage({
          type: "wasm-sentry:tab-report",
          tabId: tab.id,
        })) as TabReport;
        if (!cancelled) setReport(next);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    }

    void load();
    // The service worker keeps writing while the popup is open.
    const timer = setInterval(() => void load(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error) return <div className="panel error">{error}</div>;
  if (!report) return <div className="panel muted">Reading capture log…</div>;

  // A network sighting for a URL we also captured is the same module seen
  // twice; only surface the ones that are genuinely a blind spot.
  const capturedUrls = new Set(report.artifacts.map((a) => a.url));
  const notes = report.notes.filter((note) => !capturedUrls.has(note.url));

  return (
    <div className="panel">
      <header>
        <h1>Wasm-Sentry</h1>
        <span className="count">{report.artifacts.length} modules</span>
      </header>

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
