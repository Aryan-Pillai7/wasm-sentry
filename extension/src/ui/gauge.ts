/**
 * Geometry for the score ring.
 *
 * The scorecard's ring used to be a `conic-gradient` animated through a
 * registered custom property. That worked, and it could not do three things
 * the ring needs: draw a track behind the empty portion, round the cap at the
 * end of the arc, or start anywhere other than the top-right. All three are
 * ordinary for a stroked SVG circle, so it is one of those now, and the arc is
 * animated on `stroke-dashoffset` -- a property the compositor handles well.
 *
 * The arithmetic is here rather than inline in the component because a ring
 * that is a pixel out of its own viewBox is clipped on one side only, which is
 * a maddening thing to debug from a screenshot and a trivial thing to assert.
 */

export interface RingOptions {
  /** Radius of the circle the stroke is centred on. */
  radius: number;
  /** Width of the stroke, which straddles that circle. */
  stroke: number;
}

export interface RingGeometry {
  /** Width and height of the square viewBox, with room for the full stroke. */
  size: number;
  /** Centre, on both axes. */
  centre: number;
  radius: number;
  stroke: number;
  circumference: number;
  /**
   * `stroke-dashoffset` for this score, given a dash array of one full
   * circumference: the length of arc to leave undrawn.
   */
  offset: number;
}

/**
 * Lay out a ring showing `score` out of 100.
 *
 * The stroke is centred on the radius, so it overhangs it by half its width on
 * each side -- which is why the viewBox is the diameter *plus* one full stroke
 * width rather than the diameter alone. Getting this wrong clips the ring
 * against the edge of its own box.
 *
 * Scores outside 0-100 are clamped rather than rejected. Nothing in the
 * pipeline should produce one, but a ring that wraps past its own start or
 * unwinds backwards would misreport a score, and silently drawing a full or
 * empty ring is the safer failure.
 */
export function ringGeometry(score: number, options: RingOptions): RingGeometry {
  const { radius, stroke } = options;
  const size = radius * 2 + stroke;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(1, Math.max(0, score / 100));

  return {
    size,
    centre: size / 2,
    radius,
    stroke,
    circumference,
    offset: circumference * (1 - fraction),
  };
}
