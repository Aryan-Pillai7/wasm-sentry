/**
 * User-controlled settings.
 *
 * The defaults are deliberately local-first. Wasm-Sentry sees every module a
 * page executes, and some of those are private by nature (an internal build,
 * an authenticated app). Shipping those bytes to a server by default would be
 * an exfiltration channel wearing a security tool's badge, and would not
 * survive Chrome Web Store review. Analysis therefore runs in the extension,
 * and uploading is something the user turns on.
 */
export interface Settings {
  /** Send captured artifacts to the backend for deeper analysis. */
  uploadEnabled: boolean;
  /** Backend base URL, used only when `uploadEnabled`. */
  backendUrl: string;
  /** Record network sightings of Wasm that the main-world hook missed. */
  trackNetworkSightings: boolean;
  /**
   * Raise a desktop notification when a page reaches the high or critical band.
   * The badge is always updated regardless; this is the interrupting channel.
   */
  notifyOnHighRisk: boolean;
  /**
   * Carry the capture hooks into Web Workers.
   *
   * On by default, because worker fan-out is how one page saturates every core
   * and an uninstrumented worker is the blind spot a miner would choose. It is
   * also the only part of the extension that changes how a page loads its own
   * code -- workers start from a shim that loads their real script -- so it has
   * an off switch that the rest of the capture layer does not need.
   */
  instrumentWorkers: boolean;
  /**
   * Measure how modules behave once they are running.
   *
   * Static analysis cannot tell a hashing kernel from an image codec; how long
   * a module runs can. The cost is that a module's exported functions are
   * handed to the page wrapped in a timer, which is the second and last place
   * the extension gives a page something other than what the engine produced --
   * so, like worker instrumentation, it has a switch.
   */
  monitorRuntime: boolean;
  /**
   * Analyse the JavaScript a page runs, as well as its WebAssembly.
   *
   * **Off by default, and the only capture path that is.** Every other one sees
   * things the page has already published to itself; this one reads the source
   * of inline scripts, which on an authenticated page can carry far more of
   * somebody's private business than a compiled module does. External scripts
   * are never fetched or read either way -- only their origin and whether they
   * are pinned with Subresource Integrity, which is already in the markup.
   *
   * Source is measured and the measurements are stored. The text itself is not
   * stored and is never uploaded, whatever `uploadEnabled` says.
   */
  analyseJavaScript: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  uploadEnabled: false,
  backendUrl: "http://localhost:3000",
  trackNetworkSightings: true,
  notifyOnHighRisk: true,
  instrumentWorkers: true,
  monitorRuntime: true,
  // The one default that is off. See the note above.
  analyseJavaScript: false,
};

const KEY = "settings";

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...((stored[KEY] as Partial<Settings> | undefined) ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
