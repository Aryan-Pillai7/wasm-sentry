import { test } from "node:test";
import assert from "node:assert/strict";
import { countUpValue, easeOutCubic } from "../src/ui/motion";
import { bucketByTime, sparklinePath } from "../src/ui/sparkline";
import { ringGeometry } from "../src/ui/gauge";
import { pickActive } from "../src/ui/scroll-spy";

/**
 * The arithmetic behind the animated parts of the interface.
 *
 * These are tested for the same reason the formatting helpers are: they are
 * the only part of the presentation layer with edge cases, and every one of
 * those edge cases is a state a real reader can land in -- an empty feed, a
 * single event, a page where nothing scored, a clock that read fractionally
 * ahead. A component test would exercise none of them.
 */

/* ------------------------------------------------------------------ */
/* Easing and counting                                                 */
/* ------------------------------------------------------------------ */

test("the easing curve starts and ends where it must", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
});

test("a frame arriving late does not overshoot the value", () => {
  // A throttled tab can deliver the next frame well after the deadline. An
  // unclamped cubic would carry the figure past its true value and then walk
  // it back, which reads as the number correcting itself.
  assert.equal(easeOutCubic(1.8), 1);
  assert.equal(easeOutCubic(-0.4), 0);
});

test("the curve decelerates rather than running at a constant rate", () => {
  // The half of the distance covered in the first half of the time is what
  // makes this read as settling rather than as sliding.
  assert.ok(easeOutCubic(0.5) > 0.5, "more than half the distance by half time");
  assert.ok(easeOutCubic(0.9) > easeOutCubic(0.8));
  assert.ok(easeOutCubic(0.9) - easeOutCubic(0.8) < easeOutCubic(0.1) - easeOutCubic(0));
});

test("a count-up begins at its start value and lands exactly on its target", () => {
  assert.equal(countUpValue(0, 63, 0), 0);
  assert.equal(countUpValue(0, 63, 1), 63);
  assert.equal(countUpValue(12, 63, 1), 63);
});

test("a count-up runs downwards too", () => {
  // Both surfaces poll, so a figure can fall -- a page's score dropping when a
  // module is cleared. Counting down to it is the same animation.
  assert.equal(countUpValue(80, 20, 0), 80);
  assert.equal(countUpValue(80, 20, 1), 20);
  assert.ok(countUpValue(80, 20, 0.5) < 80);
  assert.ok(countUpValue(80, 20, 0.5) > 20);
});

test("intermediate counts are whole numbers", () => {
  for (const progress of [0.13, 0.37, 0.62, 0.88]) {
    const value = countUpValue(0, 63, progress);
    assert.equal(value, Math.round(value), `${progress} produced ${value}`);
  }
});

/* ------------------------------------------------------------------ */
/* Bucketing                                                           */
/* ------------------------------------------------------------------ */

const NOW = 1_700_000_000_000;
const SPAN = 300_000; // five minutes

test("events land in the bucket their timestamp falls in", () => {
  const counts = bucketByTime(
    [NOW - SPAN + 1, NOW - SPAN / 2 + 1, NOW - 1, NOW - 1],
    { now: NOW, spanMs: SPAN, buckets: 4 },
  );
  assert.deepEqual(counts, [1, 0, 1, 2]);
});

test("the window's own edges fall inside it", () => {
  // Off-by-one at either edge is the classic bucketing bug: the oldest event
  // vanishing, or the newest one landing in a bucket that does not exist.
  assert.deepEqual(bucketByTime([NOW - SPAN], { now: NOW, spanMs: SPAN, buckets: 5 }), [1, 0, 0, 0, 0]);
  assert.deepEqual(bucketByTime([NOW], { now: NOW, spanMs: SPAN, buckets: 5 }), [0, 0, 0, 0, 1]);
});

test("anything older than the window is dropped", () => {
  assert.deepEqual(bucketByTime([NOW - SPAN - 1], { now: NOW, spanMs: SPAN, buckets: 3 }), [0, 0, 0]);
});

test("a timestamp slightly in the future is counted, not discarded", () => {
  // The service worker stamps events from its own clock reading and the
  // dashboard reads ours. A few milliseconds of disagreement means the newest
  // event is momentarily in the future, and dropping it would make the feed
  // and the chart contradict each other on screen.
  assert.deepEqual(bucketByTime([NOW + 40], { now: NOW, spanMs: SPAN, buckets: 3 }), [0, 0, 1]);
});

test("degenerate windows return an empty series rather than throwing", () => {
  assert.deepEqual(bucketByTime([NOW], { now: NOW, spanMs: SPAN, buckets: 0 }), []);
  assert.deepEqual(bucketByTime([NOW], { now: NOW, spanMs: 0, buckets: 3 }), [0, 0, 0]);
  assert.deepEqual(bucketByTime([], { now: NOW, spanMs: SPAN, buckets: 3 }), [0, 0, 0]);
});

/* ------------------------------------------------------------------ */
/* Sparkline geometry                                                  */
/* ------------------------------------------------------------------ */

test("an empty series draws nothing at all", () => {
  const geometry = sparklinePath([], { width: 100, height: 20 });
  assert.equal(geometry.line, "");
  assert.equal(geometry.area, "");
  assert.equal(geometry.length, 0);
});

test("a series of all zeros is a flat line on the baseline, not a crash", () => {
  // Nothing happened in the last five minutes is a real reading and the most
  // common one. Scaling against a peak of zero must not divide by it.
  const geometry = sparklinePath([0, 0, 0, 0], { width: 120, height: 24, pad: 2 });
  assert.equal(geometry.peak, 0);
  assert.match(geometry.line, /^M 0 22 L 40 22 L 80 22 L 120 22$/);
  assert.equal(geometry.length, 120);
});

test("the peak bucket reaches the top of the box and the trough sits on the floor", () => {
  const geometry = sparklinePath([0, 4], { width: 10, height: 20, pad: 2 });
  assert.equal(geometry.peak, 4);
  // pad 2 in a box 20 tall: the floor is y=18 and the ceiling is y=2.
  assert.equal(geometry.line, "M 0 18 L 10 2");
});

test("a single sample draws a short flat segment rather than an invisible point", () => {
  const geometry = sparklinePath([3], { width: 40, height: 20, pad: 2 });
  assert.equal(geometry.line, "M 14 2 L 26 2");
  assert.equal(geometry.length, 12);
});

test("the fill closes down to the baseline under the line", () => {
  const geometry = sparklinePath([1, 2], { width: 10, height: 20, pad: 0 });
  assert.equal(geometry.line, "M 0 10 L 10 0");
  assert.equal(geometry.area, "M 0 10 L 10 0 L 10 20 L 0 20 Z");
});

test("the reported length matches the segments actually drawn", () => {
  // This is what `stroke-dasharray` is set from during the first render. If it
  // is short the line finishes drawing early; if it is long it never arrives.
  const geometry = sparklinePath([0, 3, 0], { width: 8, height: 5, pad: 1 });
  const expected = Math.hypot(4, 3) * 2;
  assert.ok(Math.abs(geometry.length - expected) < 0.001, `${geometry.length} vs ${expected}`);
});

/* ------------------------------------------------------------------ */
/* Score ring                                                          */
/* ------------------------------------------------------------------ */

test("the viewBox leaves room for the whole stroke, not just the radius", () => {
  // The stroke straddles the radius, so half of it hangs outside. Sizing the
  // box to the diameter alone clips the ring against its own edge.
  const ring = ringGeometry(50, { radius: 22, stroke: 6 });
  assert.equal(ring.size, 50);
  assert.equal(ring.centre, 25);
});

test("the drawn arc is the score", () => {
  const ring = ringGeometry(0, { radius: 20, stroke: 4 });
  assert.equal(ring.offset, ring.circumference, "nothing drawn at zero");

  const full = ringGeometry(100, { radius: 20, stroke: 4 });
  assert.equal(full.offset, 0, "a closed ring at a hundred");

  const half = ringGeometry(50, { radius: 20, stroke: 4 });
  assert.ok(Math.abs(half.offset - half.circumference / 2) < 1e-9);
});

test("an impossible score clamps instead of unwinding the ring", () => {
  // Nothing in the pipeline should hand this a score outside 0-100, but an arc
  // that wound backwards or wrapped past its own start would misreport one.
  assert.equal(ringGeometry(-20, { radius: 10, stroke: 2 }).offset, 2 * Math.PI * 10);
  assert.equal(ringGeometry(140, { radius: 10, stroke: 2 }).offset, 0);
});

/* ------------------------------------------------------------------ */
/* Section nav                                                         */
/* ------------------------------------------------------------------ */

const IDS = ["status", "activity", "modules", "settings"];

test("the most visible section wins", () => {
  const ratios = new Map([
    ["status", 0.1],
    ["activity", 0.8],
    ["modules", 0.3],
  ]);
  assert.equal(pickActive(IDS, ratios, "status"), "activity");
});

test("a tie goes to the section earlier in the page", () => {
  // Two short sections equally in view is ordinary, not exotic. Without a
  // stated rule the winner would depend on the order the observer happened to
  // deliver its entries in, and the nav would flicker between them while the
  // page sat still.
  const ratios = new Map([
    ["status", 0.5],
    ["activity", 0.5],
  ]);
  assert.equal(pickActive(IDS, ratios, "settings"), "status");
});

test("scrolling somewhere with nothing in view keeps the current section", () => {
  // The gap below a long section reports every ratio as zero. Clearing the
  // highlight there would blank the nav mid-scroll.
  const ratios = new Map([["status", 0], ["activity", 0]]);
  assert.equal(pickActive(IDS, ratios, "modules"), "modules");
});

test("a section the observer has not reported on yet counts as unseen", () => {
  assert.equal(pickActive(IDS, new Map([["settings", 0.4]]), "status"), "settings");
});
