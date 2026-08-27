// Shared config + storage helpers for background.js, popup.js and options.js.
//
// Security model: this extension deliberately contains NO shared secret.
// Any key baked into an extension can be extracted (an extension is a zip
// anyone can unpack), so instead each user pastes their OWN solvecha.net API
// key — a key that can only be minted after linking a Discord account. The
// key lives in chrome.storage.local (never synced to the cloud, never sent
// anywhere except solvecha.net itself), and every solve is billed to the
// account that key belongs to.

export const DEFAULT_API_BASE = "https://solvecha.net";

export const DEFAULT_CONFIG = {
  // Master auto-solve toggle (popup + options).
  enabled: true,
  // The user's personal solvecha.net API key (hk_…).
  apiKey: "",
  // API base URL. Only change this when self-hosting solvecha.
  apiBase: DEFAULT_API_BASE,
  // Hostname suffixes that should never be auto-solved.
  pausedSites: [],
};

export async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
  return { ...DEFAULT_CONFIG, ...stored };
}

export async function setConfig(patch) {
  await chrome.storage.local.set(patch);
}

export function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function sitePaused(hostname, pausedSites) {
  const host = String(hostname || "").toLowerCase();
  return (pausedSites || []).some((entry) => {
    const e = String(entry)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!e) return false;
    return host === e || host.endsWith("." + e);
  });
}
