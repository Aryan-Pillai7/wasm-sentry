/**
 * Presentation helpers shared by the dashboard.
 *
 * Kept apart from the components so the formatting rules -- which are the part
 * with edge cases -- can be tested without rendering anything.
 */

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/** Short, stable relative time. Rounds down, so nothing reads as future. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Elapsed time as a duration, for "worker has been up for ...". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Host of a page URL, or a readable placeholder. */
export function hostOf(pageUrl: string): string {
  if (!pageUrl) return "—";
  try {
    return new URL(pageUrl).host || pageUrl;
  } catch {
    return pageUrl;
  }
}

/**
 * A module's origin as shown in the feed. Bytes handed straight to the
 * WebAssembly API have no URL, and saying so is more useful than an empty cell.
 */
export function sourceLabel(url: string | undefined, api: string | undefined): string {
  if (!url) return api ? `via ${api}` : "—";
  if (url.startsWith("inline:")) return `compiled from memory (${api ?? url.slice(7)})`;
  return url;
}
