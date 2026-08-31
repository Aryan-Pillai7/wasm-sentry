/**
 * Which section of the dashboard is currently being read.
 *
 * The dashboard is one long scroll and is used two ways: to change a setting,
 * and to demonstrate the extension to somebody. The second use is what this is
 * for -- a sticky nav that jumps between sections and keeps up with where the
 * page actually is beats scrolling past three sections hunting for the fourth
 * while an audience watches.
 *
 * The choice of which section wins is separated from the observer so it can be
 * tested. It is the part with a judgement call in it; wiring up an
 * `IntersectionObserver` is not.
 */

import { useEffect, useState } from "react";

/**
 * The most-visible section, ties going to the one earliest in the page.
 *
 * Ties are common rather than exotic: two short sections can easily be equally
 * visible, and without a stated rule the winner would depend on the order the
 * observer happened to deliver its entries in. That would make the nav flicker
 * between two items while the page sits still.
 *
 * A page scrolled somewhere with nothing observed visible -- which happens in
 * the gap below a long section -- keeps the previous selection rather than
 * clearing it, so `previous` is returned unchanged when nothing qualifies.
 */
export function pickActive(
  ids: readonly string[],
  ratios: ReadonlyMap<string, number>,
  previous: string,
): string {
  let best = previous;
  let bestRatio = 0;

  for (const id of ids) {
    const ratio = ratios.get(id) ?? 0;
    // Strictly greater, so the first id at a given ratio keeps it.
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = id;
    }
  }

  return best;
}

/**
 * Track the section in view.
 *
 * `ids` must be a stable reference -- a module-level constant, not an array
 * built in render -- or the effect tears down and rebuilds its observer on
 * every poll.
 */
export function useScrollSpy(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");

  useEffect(() => {
    if (typeof IntersectionObserver !== "function") return;

    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (sections.length === 0) return;

    // Ratios accumulate across callbacks: the observer only reports sections
    // whose visibility changed, so a section that scrolled out of the picture
    // several callbacks ago still needs its zero remembered.
    const ratios = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) ratios.set(entry.target.id, entry.intersectionRatio);
        setActive((previous) => pickActive(ids, ratios, previous));
      },
      {
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
        // Discount the top strip the sticky nav sits over, and most of the
        // lower half of the viewport: the section being read is the one near
        // the top of the window, not the one merely visible at the bottom.
        rootMargin: "-72px 0px -45% 0px",
      },
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [ids]);

  return active;
}
