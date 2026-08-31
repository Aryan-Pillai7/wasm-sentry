/**
 * The activity sparkline.
 *
 * The dashboard's event feed is a list of timestamps, which answers "what
 * happened" but not "how busy has this been". The sparkline answers the second
 * one, and it is the only thing on either surface that shows a shape rather
 * than a value -- which is exactly what makes it readable from across a room.
 *
 * Bucketing and path construction live here rather than in the component
 * because they are where the edge cases are: an empty feed, a single event, a
 * feed where every bucket is zero, timestamps from the future because two
 * clocks disagree.
 */

/** A time window sliced into equal buckets, oldest first. */
export interface BucketOptions {
  /** The instant the right-hand edge of the chart represents. */
  now: number;
  /** How far back the left-hand edge reaches, in milliseconds. */
  spanMs: number;
  /** How many columns to slice the window into. */
  buckets: number;
}

/**
 * Count how many of `timestamps` fall into each slice of the window.
 *
 * Anything older than the window is dropped; anything at or after `now` is
 * counted in the final bucket rather than discarded, because a timestamp a few
 * milliseconds in the future means the service worker's clock read fractionally
 * ahead of ours, not that the event has not happened.
 */
export function bucketByTime(timestamps: readonly number[], options: BucketOptions): number[] {
  const { now, spanMs, buckets } = options;
  const counts = new Array<number>(Math.max(0, buckets)).fill(0);
  if (counts.length === 0 || spanMs <= 0) return counts;

  const start = now - spanMs;
  for (const timestamp of timestamps) {
    if (timestamp < start) continue;
    const position = Math.floor(((timestamp - start) / spanMs) * buckets);
    const index = position >= buckets ? buckets - 1 : position < 0 ? 0 : position;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

/** The two paths a sparkline is drawn from, plus the length of the line. */
export interface SparklineGeometry {
  /** The stroked line across the top of the series. */
  line: string;
  /** The same line closed down to the baseline, for the fill underneath. */
  area: string;
  /**
   * Length of the line path, for the draw-on animation.
   *
   * Measured as the sum of the segment lengths rather than read back from the
   * DOM with `getTotalLength`, so the component can set `stroke-dasharray`
   * during its first render instead of after a layout pass -- which is the
   * difference between the line drawing itself in and flashing on complete.
   */
  length: number;
  /** The largest bucket, which the top of the chart represents. */
  peak: number;
}

export interface SparklineOptions {
  width: number;
  height: number;
  /**
   * Room left at the top and bottom for the stroke's own width, so a value at
   * the peak is not sliced in half by the edge of the viewBox.
   */
  pad?: number;
}

/**
 * Turn a series of counts into SVG path data.
 *
 * The line is a polyline, deliberately, and not a smoothed curve. A smoothed
 * curve through five-second bucket counts draws values between the buckets
 * that were never measured, which is a small lie of exactly the kind this
 * project spends its documentation refusing to tell. Straight segments between
 * real samples is also, as it happens, what telemetry actually looks like.
 */
export function sparklinePath(
  values: readonly number[],
  options: SparklineOptions,
): SparklineGeometry {
  const { width, height, pad = 1 } = options;
  const empty: SparklineGeometry = { line: "", area: "", length: 0, peak: 0 };
  if (values.length === 0 || width <= 0 || height <= 0) return empty;

  const peak = values.reduce((max, value) => (value > max ? value : max), 0);
  const top = pad;
  const bottom = height - pad;
  const usable = Math.max(0, bottom - top);

  // A series of all zeros is a real reading -- nothing happened -- and it
  // should draw a flat line along the baseline, not divide by zero.
  const scale = peak > 0 ? usable / peak : 0;

  // One sample cannot make a line, so it is drawn as a short flat segment
  // across the middle instead of a single point that would stroke as nothing.
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  const points = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width / 2;
    const y = bottom - value * scale;
    return [x, y] as const;
  });

  if (points.length === 1) {
    const [x, y] = points[0]!;
    const half = Math.min(6, width / 2);
    return {
      line: `M ${fmt(x - half)} ${fmt(y)} L ${fmt(x + half)} ${fmt(y)}`,
      area: `M ${fmt(x - half)} ${fmt(y)} L ${fmt(x + half)} ${fmt(y)} L ${fmt(x + half)} ${fmt(bottom)} L ${fmt(x - half)} ${fmt(bottom)} Z`,
      length: half * 2,
      peak,
    };
  }

  const line = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"} ${fmt(x)} ${fmt(y)}`)
    .join(" ");

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const area = `${line} L ${fmt(last[0])} ${fmt(bottom)} L ${fmt(first[0])} ${fmt(bottom)} Z`;

  let length = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
  }

  return { line, area, length, peak };
}

/** Two decimals is under a tenth of a pixel and keeps the path data short. */
function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}
