// Background service worker — the only place that talks to solvecha.net.
// Content scripts never see the API key; they ask this worker to solve and
// receive a ready-to-use token.
//
// Every request uses the USER's OWN API key (stored in chrome.storage.local).
// There is no shared key in this extension to steal.

import { DEFAULT_API_BASE, getConfig, maskKey, setConfig } from "./shared.js";

// A fresh hCaptcha token is valid for ~110s server-side; cache a bit less.
const TOKEN_TTL_MS = 90_000;
// The solver now caps at ~90s, plus web-app overhead (~10s). Stay under
// Cloudflare's ~100s origin timeout so the response arrives before
// Cloudflare kills the connection.
const SOLVE_TIMEOUT_MS = 100_000;
const tokenCache = new Map(); // `${sitekey}|${host}` -> { token, expiresAt }
const inFlight = new Map(); // `${sitekey}|${host}` -> Promise<solve result>

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, sender) => handleMessage(msg, sender));

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case "SOLVE":
      return solve(msg);
    case "VALIDATE_KEY":
      return validateKey(msg.key);
    case "GET_STATUS":
      return getStatus();
    case "TOGGLE":
      await setConfig({ enabled: Boolean(msg.enabled) });
      return getStatus();
    case "SET_API_BASE":
      await setConfig({
        apiBase: String(msg.apiBase || DEFAULT_API_BASE)
          .trim()
          .replace(/\/+$/, ""),
      });
      return getStatus();
    case "FIRE_CALLBACK":
      return fireCallback(msg, sender);
    case "PAUSE_SITE": {
      const config = await getConfig();
      const site = String(msg.site || "").trim().toLowerCase();
      const paused = config.pausedSites || [];
      if (site && !paused.includes(site)) paused.push(site);
      await setConfig({ pausedSites: paused });
      return getStatus();
    }
    case "UNPAUSE_SITE": {
      const config = await getConfig();
      const site = String(msg.site || "").trim().toLowerCase();
      await setConfig({
        pausedSites: (config.pausedSites || []).filter((s) => s !== site),
      });
      return getStatus();
    }
    default:
      return { ok: false, code: "unknown_message", message: "Unknown message type." };
  }
}

// ---- solving ---------------------------------------------------------------

async function solve(msg) {
  const config = await getConfig();
  if (!config.enabled) {
    return { ok: false, code: "disabled", message: "Auto-solve is turned off." };
  }
  if (!config.apiKey) {
    return {
      ok: false,
      code: "no_key",
      message: "No API key configured. Open the extension settings.",
    };
  }
  const sitekey = String(msg.sitekey || "").trim();
  const pageurl = String(msg.pageurl || "").trim();
  if (!sitekey) {
    return { ok: false, code: "no_sitekey", message: "Couldn't read the hCaptcha sitekey." };
  }
  if (!pageurl) {
    return { ok: false, code: "no_pageurl", message: "Couldn't read the page URL." };
  }

  let host = "unknown";
  try {
    host = new URL(pageurl).hostname;
  } catch {
    /* keep fallback */
  }
  const cacheKey = `${sitekey}|${host}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, token: cached.token, fromCache: true };
  }

  // Dedupe: several frames on the same page can ask for the same sitekey at
  // once — share one in-flight solve instead of burning quota per frame.
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const pending = performSolve(config, sitekey, pageurl).then((res) => {
    if (res.ok && res.token) {
      tokenCache.set(cacheKey, { token: res.token, expiresAt: Date.now() + TOKEN_TTL_MS });
    }
    return res;
  });
  inFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function performSolve(config, sitekey, pageurl, attempt = 1) {
  const base = config.apiBase || DEFAULT_API_BASE;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOLVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/v1/solve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ sitekey, pageurl }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.token) {
      await setStatus({ error: null, lastSolveAt: Date.now(), usage: data.usage });
      return { ok: true, token: data.token };
    }

    const code = data.code || "solver_error";
    const message = friendlyError(code, data);

    // Only `rate_limited` (busy solver) and transient failures deserve a
    // retry — never `quota_exceeded` or bad keys.
    if (code === "rate_limited" && attempt < 3) {
      await sleep(1500 * attempt); // Faster retry: was 2000ms, now 1500ms
      return performSolve(config, sitekey, pageurl, attempt + 1);
    }
    if ((code === "solver_error" || code === "network") && attempt < 2) {
      await sleep(1000); // Faster retry: was 1500ms, now 1000ms
      return performSolve(config, sitekey, pageurl, attempt + 1);
    }

    await setStatus({ error: { code, message }, lastErrorAt: Date.now() });
    return { ok: false, code, message };
  } catch (err) {
    if (err?.name === "AbortError") {
      // The server keeps solving in the background for up to 5 minutes, so an
      // abort means the solve is unusually slow — not that solvecha.net is
      // down. Fail fast with an honest message instead of silently retrying
      // and risking a double charge for the same challenge.
      const message = `The solve is taking longer than ${Math.round(
        SOLVE_TIMEOUT_MS / 1000,
      )}s — the solver may be busy. Please try again.`;
      await setStatus({ error: { code: "timeout", message }, lastErrorAt: Date.now() });
      return { ok: false, code: "timeout", message };
    }
    const message = "Couldn't reach solvecha.net. Check your connection.";
    await setStatus({ error: { code: "network", message }, lastErrorAt: Date.now() });
    return { ok: false, code: "network", message };
  } finally {
    clearTimeout(timer);
  }
}

function friendlyError(code, data) {
  switch (code) {
    case "missing_key":
    case "invalid_key":
      return "Your API key is missing or invalid. Re-enter it in the extension settings.";
    case "account_unverified":
      return "This solvecha.net account isn't verified yet — link your Discord account on the dashboard, then refresh the key.";
    case "quota_exceeded":
      return `Monthly solve quota reached (${data?.limit ?? "limit"}). It resets ${
        data?.resetAt ? new Date(data.resetAt).toLocaleDateString() : "next month"
      }.`;
    case "rate_limited":
      return "Solvecha is busy — retrying shortly.";
    case "provider_not_configured":
      return "Solvecha's solver isn't configured on the server yet.";
    default:
      return data?.error || "Solvecha couldn't solve this captcha. Please try again.";
  }
}

// ---- firing the page's own captcha callback --------------------------------
//
// After a token is injected, the widget's data-callback (e.g. onSuccess) must
// run in the PAGE's main world so the site's JS enables its form. Content
// scripts live in an isolated world where page globals are invisible, and
// inline <script> injection is blocked by many sites' CSP (including the
// hCaptcha demo page). chrome.scripting.executeScript with world "MAIN" is
// not subject to the page's CSP, so that's the reliable path.

async function fireCallback(msg, sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  const cbName = String(msg?.cbName || "").trim();
  const token = String(msg?.token || "");
  if (tabId == null || !cbName || !token) {
    return { ok: false, code: "bad_request", message: "Missing tab, callback name, or token." };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId ?? 0] },
      world: "MAIN",
      func: (name, tok) => {
        try {
          const fn = window[name];
          if (typeof fn === "function") fn(tok);
        } catch (e) {
          /* the page's own callback threw — not ours to fix */
        }
      },
      args: [cbName, token],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "injection_failed", message: String(err?.message || err) };
  }
}

// ---- validation & status ----------------------------------------------------

async function validateKey(key) {
  const config = await getConfig();
  const base = config.apiBase || DEFAULT_API_BASE;
  const k = String(key || "").trim();
  if (!k) return { ok: false, code: "missing_key", message: "Paste your API key first." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${base}/api/v1/me`, {
      headers: { authorization: `Bearer ${k}` },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === "ok") {
      await setStatus({
        error: null,
        checkedAt: Date.now(),
        quota: data.quota,
        account: data.account,
        keyPrefix: data.key?.prefix,
        totalSolves: data.usage?.totalSolves ?? data.key?.totalSolves,
      });
      return { ok: true, data };
    }
    const code = data.code || "invalid_key";
    return { ok: false, code, message: friendlyError(code, data) };
  } catch {
    return {
      ok: false,
      code: "network",
      message: "Couldn't reach solvecha.net. Check your connection.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getStatus() {
  const config = await getConfig();
  const { lastStatus } = await chrome.storage.local.get("lastStatus");
  const hasKey = Boolean(config.apiKey);

  let status = {
    enabled: config.enabled,
    hasKey,
    keyMasked: maskKey(config.apiKey),
    apiBase: config.apiBase || DEFAULT_API_BASE,
    pausedSites: config.pausedSites || [],
    lastStatus: lastStatus || null,
  };

  // Keep quota fresh for the popup/options: re-check when data is stale or
  // missing, but never more often than once a minute.
  if (hasKey && (!lastStatus?.checkedAt || Date.now() - lastStatus.checkedAt > 60_000)) {
    const v = await validateKey(config.apiKey).catch(() => ({ ok: false }));
    if (v.ok) {
      status.lastStatus = (await chrome.storage.local.get("lastStatus")).lastStatus;
    }
  }
  return status;
}

async function setStatus(patch) {
  const { lastStatus } = await chrome.storage.local.get("lastStatus");
  await chrome.storage.local.set({ lastStatus: { ...(lastStatus || {}), ...patch } });
}
