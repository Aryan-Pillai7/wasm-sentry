/**
 * Risk aggregation and the Privacy Scorecard.
 *
 * Combining findings by simply adding their weights would let a pile of weak,
 * common signals -- stripped names, a large data section, one socket import --
 * add up to an accusation. The score therefore saturates: each additional
 * finding moves it less than the last, so reaching the top band takes evidence
 * that is individually strong rather than merely plentiful.
 *
 * The score is never presented alone. It ships with the findings that produced
 * it and with a coverage figure, because a number without its evidence is the
 * interpretability problem this project exists to fix.
 */
import type { Finding } from "./heuristics.js";
import type { RiskLevel } from "./types.js";

export interface RiskAssessment {
  /** 0-100. */
  score: number;
  level: RiskLevel;
  /** Findings that produced the score, strongest first. */
  findings: Finding[];
  /** One sentence a non-specialist can act on. */
  headline: string;
  /** Share of the module the analysis actually covered, 0..1. */
  coverage: number;
}

/**
 * Saturation constant, in raw weight points.
 *
 * At 50, a single high-weight rule at full confidence lands in "high" and two
 * independent ones are needed for "critical" -- which matches the intent that
 * the top band means corroborated evidence, not an accumulation of hints.
 */
const SATURATION = 50;

const BANDS: Array<{ min: number; level: RiskLevel }> = [
  { min: 75, level: "critical" },
  { min: 50, level: "high" },
  { min: 25, level: "medium" },
  { min: 10, level: "low" },
  { min: 0, level: "benign" },
];

function band(score: number): RiskLevel {
  return BANDS.find((entry) => score >= entry.min)?.level ?? "benign";
}

function headlineFor(level: RiskLevel, findings: Finding[]): string {
  const top = findings.find((finding) => finding.weight > 0);
  switch (level) {
    case "critical":
    case "high":
      return top
        ? `Behaves like cryptomining code: ${top.title.toLowerCase()}.`
        : "Strong indicators of unwanted computation.";
    case "medium":
      return top
        ? `Worth a closer look: ${top.title.toLowerCase()}.`
        : "Some indicators worth a closer look.";
    case "low":
      return top
        ? `Mostly ordinary, with one thing to note: ${top.title.toLowerCase()}.`
        : "Mostly ordinary, with minor notes.";
    case "benign":
      return "Nothing unusual found. This looks like ordinary compiled code.";
  }
}

export interface CoverageInput {
  functionCount: number;
  truncatedFunctions: number;
  skippedFunctions: number;
}

/** How much of the module the analysis actually saw. */
export function coverageOf(input: CoverageInput): number {
  if (input.functionCount === 0) return 1;
  const missed = input.truncatedFunctions + input.skippedFunctions;
  return Math.max(0, Math.min(1, 1 - missed / input.functionCount));
}

/** Combine findings into a banded score with its evidence attached. */
export function assessRisk(findings: Finding[], coverage: number): RiskAssessment {
  const raw = findings.reduce((sum, finding) => sum + finding.weight * finding.confidence, 0);
  const saturated = 100 * (1 - Math.exp(-raw / SATURATION));
  const score = Math.round(saturated);
  const level = band(score);

  return {
    score,
    level,
    findings,
    headline: headlineFor(level, findings),
    coverage: Number(coverage.toFixed(3)),
  };
}

/** The worst level among a set, for rolling artifacts up to a page verdict. */
const ORDER: RiskLevel[] = ["benign", "low", "medium", "high", "critical"];

export function worstLevel(levels: readonly RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (worst, level) => (ORDER.indexOf(level) > ORDER.indexOf(worst) ? level : worst),
    "benign",
  );
}

export interface PageScorecard {
  pageUrl: string;
  /** Worst level across every module on the page. */
  level: RiskLevel;
  /** Highest single-module score. */
  score: number;
  moduleCount: number;
  /** Modules seen but not analysed, so the card can say what it does not know. */
  unanalysedCount: number;
  headline: string;
}

/** Roll per-module assessments up into the card shown for the page. */
export function buildScorecard(
  pageUrl: string,
  assessments: readonly RiskAssessment[],
  unanalysedCount: number,
): PageScorecard {
  const level = worstLevel(assessments.map((assessment) => assessment.level));
  const score = assessments.reduce((max, assessment) => Math.max(max, assessment.score), 0);
  const worst = assessments.find((assessment) => assessment.level === level);

  const headline =
    assessments.length === 0
      ? unanalysedCount > 0
        ? `${unanalysedCount} module(s) seen but not analysed.`
        : "No WebAssembly on this page."
      : (worst?.headline ?? "");

  return {
    pageUrl,
    level,
    score,
    moduleCount: assessments.length,
    unanalysedCount,
    headline,
  };
}
