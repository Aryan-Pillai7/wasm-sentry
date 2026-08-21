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
}

export const DEFAULT_SETTINGS: Settings = {
  uploadEnabled: false,
  backendUrl: "http://localhost:3000",
  trackNetworkSightings: true,
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
