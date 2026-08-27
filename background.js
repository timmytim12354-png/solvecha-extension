// Background service worker — the only place that talks to solvecha.net.
// Content scripts never see the API key; they ask this worker to solve and
// receive a ready-to-use token.
//
// Every request uses the USER's OWN API key (stored in chrome.storage.local).
// There is no shared key in this extension to steal.

import { DEFAULT_API_BASE, getConfig, maskKey, setConfig } from "./shared.js";

// A fresh hCaptcha token is valid for ~110s server-side; Turnstile ~300s.
const HCAPTCHA_TTL_MS = 90_000;
const TURNSTILE_TTL_MS = 240_000;
// Stay under Cloudflare's ~100s origin timeout. Busy/unavailable retries
// happen inside this window with short backoffs, not by stacking 90s calls.
const SOLVE_TIMEOUT_MS = 95_000;
const tokenCache = new Map(); // `${sitekey}|${host}` -> { token, expiresAt }
const inFlight = new Map(); // `${sitekey}|${host}` -> Promise<solve result>

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const liveLogs = {
  entries: [],
  done: true,
  failed: false,
  label: "",
  startedAt: 0,
  tabId: null,
  trace: null,
};
let logPollTimer = null;
const logPorts = new Set();

function newTraceId() {
  const raw = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/-/g, "");
  return `sc_${raw.slice(0, 20)}`;
}

function getLiveLogs() {
  return {
    entries: liveLogs.entries,
    done: liveLogs.done,
    failed: liveLogs.failed,
    label: liveLogs.label,
    startedAt: liveLogs.startedAt,
  };
}

function logPayload() {
  return {
    type: "SOLVE_LOG",
    entries: liveLogs.entries,
    done: liveLogs.done,
    failed: liveLogs.failed,
    label: liveLogs.label,
    startedAt: liveLogs.startedAt,
  };
}

function broadcastLogs() {
  const payload = logPayload();
  for (const port of [...logPorts]) {
    try {
      port.postMessage(payload);
    } catch {
      logPorts.delete(port);
    }
  }
  const tabId = liveLogs.tabId;
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, payload, { frameId: 0 }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* tab closed */
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "solvecha-logs") return;
  logPorts.add(port);
  try {
    port.postMessage(logPayload());
  } catch {
    logPorts.delete(port);
    return;
  }
  port.onDisconnect.addListener(() => logPorts.delete(port));
});

function addLog(level, kind, msg) {
  liveLogs.entries.push({ ts: Date.now(), level, kind, msg });
  if (liveLogs.entries.length > 250) liveLogs.entries.splice(0, liveLogs.entries.length - 250);
  broadcastLogs();
}

function mergeRemote(events) {
  const seen = new Set(liveLogs.entries.map((e) => `${e.ts}|${e.msg}`));
  let added = 0;
  for (const e of events || []) {
    const msg = String(e.msg || "");
    const ts = Number(e.ts) || Date.now();
    const key = `${ts}|${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    liveLogs.entries.push({
      ts,
      level: e.level || "info",
      kind: e.kind || "log",
      msg,
    });
    added += 1;
  }
  if (added) {
    liveLogs.entries.sort((a, b) => a.ts - b.ts);
    broadcastLogs();
  }
}

function stopLogPoll() {
  if (logPollTimer) {
    clearInterval(logPollTimer);
    logPollTimer = null;
  }
}

function startLogSession(tabId, captchaType, trace) {
  stopLogPoll();
  liveLogs.entries = [];
  liveLogs.done = false;
  liveLogs.failed = false;
  liveLogs.label = captchaType === "turnstile" ? "Solving Turnstile" : "Solving hCaptcha";
  liveLogs.startedAt = Date.now();
  liveLogs.tabId = tabId ?? null;
  liveLogs.trace = trace;
  broadcastLogs();
  if (tabId != null) {
    try {
      chrome.tabs.sendMessage(tabId, { type: "SOLVE_PANEL_OPEN", label: liveLogs.label }, { frameId: 0 }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      /* tab closed */
    }
  }
}

async function pollTraceOnce(config, trace) {
  const base = config.apiBase || DEFAULT_API_BASE;
  try {
    const res = await fetch(`${base}/api/v1/trace?id=${encodeURIComponent(trace)}`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    const data = await res.json().catch(() => ({}));
    if (Array.isArray(data.events)) mergeRemote(data.events);
    if (data.done && liveLogs.done) stopLogPoll();
  } catch {
    /* keep local logs */
  }
}

function startLogPoll(config, trace) {
  stopLogPoll();
  setTimeout(() => pollTraceOnce(config, trace), 250);
  logPollTimer = setInterval(() => pollTraceOnce(config, trace), 450);
}

function notifyTabsKeyChanged(hasKey) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type: "KEY_CHANGED", hasKey: Boolean(hasKey) }, { frameId: 0 }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.apiKey) return;
  notifyTabsKeyChanged(Boolean(String(changes.apiKey.newValue || "").trim()));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) =>
      sendResponse(result ?? { ok: false, code: "empty", message: "No response from solver." }),
    )
    .catch((err) =>
      sendResponse({
        ok: false,
        code: "internal",
        message: err?.message || "Extension solver crashed. Reload the extension.",
      }),
    );
  return true; // keep the message port open for 30-90s solves
});

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case "SOLVE":
      return solve(msg, sender);
    case "GET_LOGS":
      return getLiveLogs();
    case "VALIDATE_KEY":
      return validateKey(msg.key);
    case "GET_STATUS":
      return getStatus();
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
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
    case "INJECT_TOKEN":
      return injectTokenMain(msg, sender);
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

async function solve(msg, sender) {
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
  const captchaType = msg.captchaType === "turnstile" ? "turnstile" : "hcaptcha";
  if (!sitekey) {
    return { ok: false, code: "no_sitekey", message: "Couldn't read the captcha sitekey." };
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
  const cacheKey = `${captchaType}|${sitekey}|${host}`;
  const tabId = sender?.tab?.id ?? null;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    startLogSession(tabId, captchaType, null);
    addLog("ok", "done", "Using a cached token");
    liveLogs.done = true;
    broadcastLogs();
    return { ok: true, token: cached.token, fromCache: true };
  }

  // Dedupe: several frames on the same page can ask for the same sitekey at
  // once — share one in-flight solve instead of burning quota per frame.
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const trace = newTraceId();
  startLogSession(tabId, captchaType, trace);
  addLog("info", "detect", `Detected ${captchaType} (${sitekey.slice(0, 10)}…)`);
  addLog("info", "queue", "Sending solve to Solvecha…");
  startLogPoll(config, trace);

  const pending = performSolve(config, sitekey, pageurl, captchaType, 1, trace).then((res) => {
    if (res.ok && res.token) {
      const ttl = captchaType === "turnstile" ? TURNSTILE_TTL_MS : HCAPTCHA_TTL_MS;
      tokenCache.set(cacheKey, { token: res.token, expiresAt: Date.now() + ttl });
      addLog("ok", "done", "Token received — injecting into the page");
      liveLogs.failed = false;
    } else {
      addLog("error", "error", res.message || "Solve failed");
      liveLogs.failed = true;
    }
    liveLogs.done = true;
    pollTraceOnce(config, trace).finally(() => {
      stopLogPoll();
      broadcastLogs();
    });
    return res;
  });
  inFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function performSolve(config, sitekey, pageurl, captchaType, attempt = 1, trace = null) {
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
      body: JSON.stringify({ sitekey, pageurl, type: captchaType, ...(trace ? { trace } : {}) }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.token) {
      await setStatus({ error: null, lastSolveAt: Date.now(), usage: data.usage });
      return { ok: true, token: data.token };
    }

    const code =
      data.code ||
      (res.status === 524 || res.status === 504 || res.status === 408
        ? "solve_timeout"
        : res.status === 503
          ? "solver_unavailable"
          : res.status === 429
            ? "rate_limited"
            : "solver_error");
    const message = friendlyError(code, data);

    const busy = code === "rate_limited" || code === "solver_unavailable";
    const retryable = new Set(["rate_limited", "solver_unavailable", "network"]);
    const maxAttempts = busy ? 3 : 1;
    if (retryable.has(code) && attempt < maxAttempts) {
      const wait = busy ? (Number(data.retryAfter) || 8) * 1000 : code === "solve_timeout" ? 4000 : 800;
      addLog("warn", "queue", `Solver busy — retry ${attempt + 1} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      return performSolve(config, sitekey, pageurl, captchaType, attempt + 1, trace);
    }

    await setStatus({ error: { code, message }, lastErrorAt: Date.now() });
    return { ok: false, code, message };
  } catch (err) {
    if (err?.name === "AbortError") {
      if (attempt < 3) {
        await sleep(5000);
        return performSolve(config, sitekey, pageurl, captchaType, attempt + 1, trace);
      }
      const message = `The solve is taking longer than ${Math.round(
        SOLVE_TIMEOUT_MS / 1000,
      )}s — the solver may be busy. Please try again.`;
      await setStatus({ error: { code: "timeout", message }, lastErrorAt: Date.now() });
      return { ok: false, code: "timeout", message };
    }
    if (attempt < 3) {
      await sleep(1500 * attempt);
      return performSolve(config, sitekey, pageurl, captchaType, attempt + 1, trace);
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
    case "solve_timeout":
    case "timeout":
      return data?.error || "This captcha took too long. Retrying…";
    case "rate_limited":
      return "Solvecha is busy — retrying shortly.";
    case "solver_unavailable":
      return "Solver is busy or restarting — retrying shortly.";
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


async function injectTokenMain(msg, sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId ?? 0;
  const token = String(msg?.token || "");
  if (tabId == null || !token) {
    return { ok: false, code: "bad_request", message: "Missing tab or token." };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: (tok) => {
        const write = () => {
          for (const sel of [
            'textarea[name="h-captcha-response"]',
            'textarea[name="g-recaptcha-response"]',
            'input[name="g-recaptcha-response"]',
            '[name="cf-turnstile-response"]',
            "[data-hcaptcha-response]",
          ]) {
            for (const el of document.querySelectorAll(sel)) {
              if ("value" in el) el.value = tok;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
        };
        write();
        for (const el of document.querySelectorAll("[data-callback]")) {
          const name = el.getAttribute("data-callback");
          if (!name) continue;
          try {
            const fn = name.split(".").reduce((o, k) => (o ? o[k] : undefined), window);
            if (typeof fn === "function") fn(tok);
          } catch {
            /* page callback threw */
          }
        }
        try {
          if (window.hcaptcha && typeof window.hcaptcha.setResponse === "function") {
            window.hcaptcha.setResponse(tok);
          }
        } catch {
          /* ignore */
        }
        try {
          if (window.__solvechaTs) window.__solvechaTs.token = tok;
        } catch {
          /* ignore */
        }
        for (const iframe of document.querySelectorAll(
          'iframe[src*="hcaptcha.com"][src*="frame=checkbox"], iframe[data-hcaptcha-widget-id]',
        )) {
          const widgetId =
            iframe.getAttribute("data-hcaptcha-widget-id") ||
            (iframe.src.match(/[?&#]id=([^&]+)/) || [])[1];
          if (!widgetId || !iframe.contentWindow) continue;
          iframe.contentWindow.postMessage(
            JSON.stringify({ source: "hcaptcha", label: "checkbox-tick", id: widgetId }),
            "*",
          );
        }
      },
      args: [token],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "injection_failed", message: String(err?.message || err) };
  }
}

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
