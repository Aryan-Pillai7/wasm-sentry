/**
 * The rendered width of an element, kept current as it changes.
 *
 * Needed by exactly one thing: the activity sparkline, which is drawn at the
 * real pixel width of its container rather than into a fixed `viewBox` that is
 * then stretched to fit.
 *
 * The stretched version is the usual way to make an SVG chart responsive and it
 * is wrong for this one, in a way that is worth writing down because it looks
 * like it works. A fixed `viewBox` with `preserveAspectRatio="none"` scales the
 * drawing non-uniformly, which also scales the stroke -- so the line comes out
 * thicker horizontally than vertically. The usual fix for *that* is
 * `vector-effect: non-scaling-stroke`, which moves stroke geometry into screen
 * space. But `stroke-dasharray` is stroke geometry: with the effect on, a dash
 * length computed in `viewBox` units is then interpreted as screen pixels, and
 * the draw-on animation lays down a line of the wrong length entirely. On a
 * 600-unit box rendered 1400px wide, the trace stopped a little over half way
 * across and simply ended.
 *
 * Measuring sidesteps all of it. One unit is one pixel, the stroke is the width
 * it is declared to be, and the dash length means what it says.
 */

import { useEffect, useState } from "react";

/**
 * Observe `element` and report its content-box width in CSS pixels.
 *
 * Takes the element rather than a ref so that a caller using a callback ref
 * re-runs when the node actually attaches -- a `useRef` would still be null on
 * the render that schedules the effect.
 *
 * Returns 0 before the first measurement, which callers should treat as "not
 * ready to draw yet" rather than as a zero-width chart.
 */
export function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!element) return;

    // No feature check. The extension targets Chrome 111 and `ResizeObserver`
    // has shipped since 64, so the only thing a fallback would add here is a
    // branch that sets state synchronously from an effect and is never taken.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // `contentRect` rather than `borderBoxSize`: the chart is drawn inside
      // the padding box, and rounding to whole pixels keeps a fractional
      // layout width from re-rendering the path on every scrollbar twitch.
      setWidth(Math.round(entry.contentRect.width));
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return width;
}
