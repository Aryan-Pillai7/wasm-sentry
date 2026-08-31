/**
 * The animation the interface does in JavaScript rather than in CSS.
 *
 * Almost everything that moves here is a CSS transition, which is the right
 * default. Counting a figure up from its previous value to its new one is the
 * exception: there is no property to transition, because the thing changing is
 * the text content of a node.
 *
 * The arithmetic is separated from the hook so the part with the edge cases --
 * what a half-finished count reads as, what happens when the target moves
 * mid-flight -- can be tested without a renderer or a frame clock.
 */

import { useEffect, useState } from "react";

/**
 * Whether the reader has asked for less motion.
 *
 * Checked in JavaScript as well as in CSS because the CSS half cannot do this
 * correctly on its own. A blanket `animation-duration: 0.01ms` freezes a
 * count-up at whatever it was showing when it started, which for a figure that
 * animates from zero means a permanent zero -- the reader who asked for less
 * motion ends up with less information. Here the same query means "skip to the
 * real value", which is what was actually wanted.
 *
 * Guarded for the non-browser case so this module stays importable from tests.
 */
export function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== "function") return false;
  return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Decelerating ease, matching `--ease-out` closely enough that a figure
 * counting up and a bar filling beside it appear to settle together.
 *
 * Clamped rather than extrapolated: a frame can arrive after the deadline when
 * the tab was throttled, and an unclamped curve would overshoot the true value
 * and then come back, which reads as the number being unsure of itself.
 */
export function easeOutCubic(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - Math.pow(1 - clamped, 3);
}

/**
 * Where a count-up sits at `progress` through its run.
 *
 * Rounded to a whole number because every figure this drives is a count or a
 * score out of 100, and a fractional intermediate would render as noise.
 */
export function countUpValue(from: number, to: number, progress: number): number {
  return Math.round(from + (to - from) * easeOutCubic(progress));
}

/**
 * A figure that counts to `target` instead of jumping to it.
 *
 * Counts from wherever it currently is rather than from zero. That matters
 * more than it sounds: both surfaces poll every 1.5 seconds, and a hook that
 * restarted at zero on every update would leave the numbers permanently
 * scrambling upward and never actually readable.
 */
export function useCountUp(target: number, durationMs = 900): number {
  // A reader who asked for less motion is served entirely by derivation: the
  // true value is returned straight from render, no state and no effect. That
  // is not just tidier than setting state in an effect, it is the behaviour
  // that is actually wanted -- the figure is correct on the very first paint
  // rather than correct one render later.
  const reduced = prefersReducedMotion();
  const [value, setValue] = useState(reduced ? target : 0);

  useEffect(() => {
    if (reduced) return;

    let frame = 0;
    let started = 0;
    // Where this run counts from. Read on the first frame through the state
    // updater rather than captured from the render that scheduled the effect:
    // the effect closes over a `value` that is already stale by the time the
    // frame arrives, and reading a ref during render to work around that is
    // the thing `react-hooks/refs` is right to refuse.
    let from: number | null = null;

    const step = (now: number): void => {
      if (started === 0) started = now;
      const progress = (now - started) / durationMs;
      setValue((current) => {
        if (from === null) from = current;
        return countUpValue(from, target, progress);
      });
      if (progress < 1) frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduced]);

  return reduced ? target : value;
}

/**
 * Whether the browser has painted a starting state yet.
 *
 * A CSS transition needs something to move *from*. An element rendered
 * straight into its final state has no previous computed value to interpolate
 * against, so it simply appears there: the ring is already full, the trace is
 * already drawn, the bar is already sized. The fix is to render the empty
 * state once, let it paint, and only then set the real value -- which is what
 * the two nested frames below are for. One frame is not reliably enough; the
 * first can be batched into the same paint as the initial render.
 *
 * This was written out three times -- the score ring, the sparkline, the risk
 * bar -- and each copy had to remember the reduced-motion case separately.
 * Here it is remembered once: a reader who asked for less motion is armed from
 * the very first render, so the value is simply correct rather than animated
 * to, and nothing is left sitting at zero.
 */
export function useArmed(): boolean {
  const reduced = prefersReducedMotion();
  const [armed, setArmed] = useState(reduced);

  useEffect(() => {
    if (reduced) return;

    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setArmed(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [reduced]);

  return armed;
}
