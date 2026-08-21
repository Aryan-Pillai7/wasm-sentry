/**
 * Proactive alerting.
 *
 * The badge is the ambient channel and costs the user nothing. A desktop
 * notification interrupts, so it is reserved for the bands where interrupting
 * is justified, and is de-duplicated hard: the same module on the same site must
 * not notify twice, or the tool trains the user to dismiss it without reading.
 *
 * The decision is a pure function so the policy can be tested without Chrome.
 */
import type { PageScorecard, RiskLevel } from "@wasm-sentry/core";

/** Bands worth interrupting for. Medium is a "worth a look", not an alarm. */
const ALERTABLE: ReadonlySet<RiskLevel> = new Set<RiskLevel>(["high", "critical"]);

export interface AlertInput {
  scorecard: PageScorecard;
  /** Hash of the module that produced the verdict, for de-duplication. */
  topHash: string | undefined;
  /** The single most significant finding's title, if there is one. */
  topFinding: string | undefined;
  enabled: boolean;
  /** Keys already alerted on this session. */
  seen: ReadonlySet<string>;
}

export type AlertDecision =
  | { notify: false; reason: string }
  | { notify: true; key: string; title: string; message: string; contextMessage: string };

/** Host of a page URL, or the raw string if it will not parse. */
export function originOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).host || pageUrl;
  } catch {
    return pageUrl || "unknown page";
  }
}

/**
 * Alert identity: site plus module plus band.
 *
 * Keying on the module hash rather than the site alone means a site that later
 * loads a *different* bad module still alerts, while a reload of the same page
 * stays quiet.
 */
export function alertKey(origin: string, level: RiskLevel, topHash: string | undefined): string {
  return `${origin}|${level}|${topHash ?? "none"}`;
}

const TITLES: Partial<Record<RiskLevel, string>> = {
  high: "Wasm-Sentry: likely unwanted computation",
  critical: "Wasm-Sentry: almost certainly unwanted computation",
};

export function decideAlert(input: AlertInput): AlertDecision {
  if (!input.enabled) return { notify: false, reason: "alerts disabled" };

  const { level, score } = input.scorecard;
  if (!ALERTABLE.has(level)) return { notify: false, reason: `level ${level} is below the bar` };

  const origin = originOf(input.scorecard.pageUrl);
  const key = alertKey(origin, level, input.topHash);
  if (input.seen.has(key)) return { notify: false, reason: "already alerted for this module" };

  return {
    notify: true,
    key,
    title: TITLES[level] ?? "Wasm-Sentry",
    // The finding, not just the number: a score with no reason attached is the
    // interpretability problem this project exists to avoid, and it does not
    // stop being one because it arrives in a notification.
    message: input.topFinding
      ? `${input.topFinding} (${score}/100)`
      : `${input.scorecard.headline} (${score}/100)`,
    contextMessage: origin,
  };
}
