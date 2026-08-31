/**
 * The three detection layers, rendered the same way wherever they appear.
 *
 * These three components existed twice -- once in the popup and once in the
 * dashboard -- with the label maps copied alongside them. That is a bad thing
 * to duplicate specifically: the whole point of the colour and label mapping
 * is that a reader learns it once, so the two surfaces disagreeing about what
 * "Behavior" means or which teal it is drawn in would undo the thing the
 * badges are for.
 *
 * The maps are deliberately not exported. They are an implementation detail of
 * these three components, and a caller reaching for the label text directly is
 * a caller about to render a fourth variant of the same badge.
 */

import type { Finding } from "@wasm-sentry/core";

const LAYERS = ["static", "runtime", "model"] as const;

const LABELS: Record<Finding["kind"], string> = {
  static: "Rule",
  runtime: "Behavior",
  model: "AI",
};

/** The tooltip is where the honesty lives: a model's opinion is not a measurement. */
const TITLES: Record<Finding["kind"], string> = {
  static: "Static rule — the bytes, before anything runs",
  runtime: "Runtime rule — what the module was observed doing",
  model: "Trained classifier — a model's opinion, not a measurement",
};

/** The badge on a single finding, naming which layer produced it. */
export function KindBadge({ kind }: { kind: Finding["kind"] }): React.JSX.Element {
  return (
    <span className={`kind-badge k-${kind}`} title={TITLES[kind]}>
      {LABELS[kind]}
    </span>
  );
}

/** The key, stated once per surface, so a badge is legible without a lookup. */
export function LayerLegend(): React.JSX.Element {
  return (
    <div className="layers">
      {LAYERS.map((kind) => (
        <span key={kind} className={`layer-chip k-${kind}`} title={TITLES[kind]}>
          <span className="dot" />
          {LABELS[kind]}
        </span>
      ))}
    </div>
  );
}

/**
 * Per-module counts of which layer caught what.
 *
 * For a presenter who wants to point at one place and say "the static rules
 * found two of these and the runtime measurement found the third", rather than
 * scrolling the findings and reading every badge in turn.
 */
export function CaughtByStrip({
  findings,
}: {
  findings: readonly Finding[];
}): React.JSX.Element | null {
  if (findings.length === 0) return null;

  const counts: Record<Finding["kind"], number> = { static: 0, runtime: 0, model: 0 };
  for (const finding of findings) counts[finding.kind]++;

  return (
    <div className="caught-by">
      {LAYERS.filter((kind) => counts[kind] > 0).map((kind) => (
        <span key={kind} className={`caught-by-item k-${kind}`} title={TITLES[kind]}>
          <span className="dot" />
          {counts[kind]} {LABELS[kind]}
        </span>
      ))}
    </div>
  );
}
