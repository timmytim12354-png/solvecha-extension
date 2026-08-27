// Content script — runs in every frame of every page.
//
// What it does:
//   1. Watches the DOM for hCaptcha widgets (visible checkbox iframes and/or
//      challenge iframes that appear when a captcha "pops up").
//   2. When a captcha is detected and auto-solve is on, asks the background
//      worker to solve it via the solvecha.net API (the API key never leaves
//      the background worker).
//   3. Injects the returned token into the widget (textarea + iframe message)
//      and shows a tiny status toast.
//
// The content script holds no credentials and no shared secret.

(() => {
  "use strict";

  // Never run inside hCaptcha's own widget/challenge frames (the checkbox and
  // challenge iframes served from newassets.hcaptcha.com) — nothing to solve
  // there. The TOP-LEVEL page must still run even when it's hosted on an
  // hcaptcha.com domain (e.g. the official demo at accounts.hcaptcha.com/demo).
  if (window.top !== window && /(^|\.)hcaptcha\.com$/.test(location.hostname)) return;

  const CONTAINER_SELECTOR =
    'div.h-captcha, div[data-sitekey][class*="h-captcha"], iframe[src*="hcaptcha.com"], iframe[title*="hCaptcha"]';
  const CHALLENGE_IFRAME_SELECTOR =
    'iframe[src*="hcaptcha.com"][src*="challenge"], iframe[src*="hcaptcha.com"][src*="frame=challenge"]';
  const SITEKEY_IN_SRC = /[?&]sitekey=([^&]+)/;

  const MAX_RETRIES = 3;
  const state = new Map(); // sitekey -> { phase, retries }

  let config = { enabled: true, apiKey: "", pausedSites: [] };
  chrome.storage.local.get(["enabled", "apiKey", "pausedSites"], (stored) => {
    config = { ...config, ...stored };
    scan();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of ["enabled", "apiKey", "pausedSites"]) {
      if (changes[key]) config[key] = changes[key].newValue;
    }
  });

  // ---- detection ---------------------------------------------------------

  function extractSitekeys() {
    const keys = new Set();
    for (const el of document.querySelectorAll('div.h-captcha, div[data-sitekey][class*="h-captcha"]')) {
      const k = el.getAttribute("data-sitekey");
      if (k) keys.add(k.trim());
    }
    for (const iframe of document.querySelectorAll('iframe[src*="hcaptcha.com"]')) {
      const m = iframe.src.match(SITEKEY_IN_SRC);
      if (m && m[1]) keys.add(decodeURIComponent(m[1]));
    }
    return keys;
  }

  function widgetFor(sitekey) {
    for (const el of document.querySelectorAll(CONTAINER_SELECTOR)) {
      const k = el.getAttribute("data-sitekey");
      if (k && k.trim() === sitekey) return el;
    }
    for (const iframe of document.querySelectorAll('iframe[src*="hcaptcha.com"]')) {
      const m = iframe.src.match(SITEKEY_IN_SRC);
      if (m && decodeURIComponent(m[1]) === sitekey) return iframe;
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function challengePresent() {
    return !!document.querySelector(CHALLENGE_IFRAME_SELECTOR);
  }

  function tokenPresent() {
    const ta = document.querySelector('textarea[name="h-captcha-response"]');
    return Boolean(ta && ta.value);
  }

  function isPaused() {
    const hostname = location.hostname.toLowerCase();
    return (config.pausedSites || []).some((entry) => {
      const e = String(entry)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
      return e && (hostname === e || hostname.endsWith("." + e));
    });
  }

  function scan() {
    if (!config.enabled) return;
    const keys = extractSitekeys();
    if (!keys.size) return;
    const paused = isPaused();

    for (const sitekey of keys) {
      const s = state.get(sitekey) || { phase: "idle", retries: 0 };
      state.set(sitekey, s);
      if (s.phase === "solving") continue;

      // A new challenge popped up for an already-solved widget whose token
      // was consumed (form submitted, widget reset) — allow a re-solve.
      if (s.phase === "solved" && challengePresent() && !tokenPresent()) {
        s.retries += 1;
        s.phase = s.retries <= MAX_RETRIES ? "idle" : "failed";
        if (s.phase !== "idle") continue;
      }
      // Failed solves are retried on a timer below; scan() never re-arms
      // them so we don't hammer a still-open challenge.
      if (s.phase !== "idle") continue;
      if (paused) continue;

      const widget = widgetFor(sitekey);
      if (!widget) continue;

      // Only trigger when a challenge iframe is actually open.
      // Previously this also fired when the checkbox was visible, which
      // caused false-positive "Solving hCaptcha…" toasts on pages that
      // just had a dormant widget with no challenge.
      if (challengePresent()) {
        triggerSolve(sitekey);
      }
    }
  }

  // ---- solving -----------------------------------------------------------

  function triggerSolve(sitekey) {
    const s = state.get(sitekey) || { phase: "idle", retries: 0 };
    if (s.phase === "solving" || s.phase === "solved") return;
    s.phase = "solving";
    state.set(sitekey, s);

    toast("Solving hCaptcha…", "busy");
    // Solves run in a real browser on the solver service and can legitimately
    // take 30-90s+. Keep the toast alive with elapsed time so a long solve
    // doesn't look frozen.
    const solveStartedAt = Date.now();
    const elapsedTimer = setInterval(() => {
      const sec = Math.round((Date.now() - solveStartedAt) / 1000);
      toast(`Solving hCaptcha… (${sec}s)`, "busy");
    }, 5000);

    chrome.runtime.sendMessage(
      { type: "SOLVE", sitekey, pageurl: (function () {
          try { return window.top.location.href; } catch { return location.href; }
        })() },
      (res) => {
        clearInterval(elapsedTimer);
        if (chrome.runtime.lastError || !res) {
          s.phase = "failed";
          toast("Extension error — reload the page", "error");
          return;
        }
        if (res.ok && res.token) {
          s.phase = "solved";
          clearTimeout(s.retryTimer);
          injectToken(res.token);
          chrome.runtime.sendMessage({ type: "INJECT_TOKEN", token: res.token }, () => {});
          return;
        }
        s.phase = "failed";
        s.retries += 1;
        toast(res.message || "Solve failed", "error");
        const busy =
          res.code === "rate_limited" ||
          res.code === "solver_unavailable" ||
          res.code === "timeout" ||
          res.code === "solve_timeout";
        if (s.retries < MAX_RETRIES && challengePresent()) {
          clearTimeout(s.retryTimer);
          s.retryTimer = setTimeout(() => {
            const cur = state.get(sitekey);
            if (cur && cur.phase === "failed" && cur.retries < MAX_RETRIES && challengePresent()) {
              triggerSolve(sitekey);
            }
          }, busy ? 10000 : 4000);
        }
      },
    );
  }

  // ---- token injection ----------------------------------------------------

  function injectToken(token) {
    let injectedNow = false;

    const writeTextareas = () => {
      let wrote = 0;
      for (const ta of document.querySelectorAll('textarea[name="h-captcha-response"]')) {
        ta.value = token;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        wrote += 1;
      }
      return wrote > 0;
    };

    injectedNow = writeTextareas();
    if (!injectedNow) {
      // hCaptcha creates the textarea lazily; watch briefly for it.
      const mo = new MutationObserver(() => {
        if (writeTextareas()) mo.disconnect();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 6000);
    }

    // Flip the checkbox to verified using hCaptcha's own iframe chat protocol.
    // The checkbox iframe listens for a "checkbox-tick" message carrying the
    // widget id (a plain {type:"hcaptcha-token"} message is NOT part of the
    // protocol and does nothing). The widget id lives on the iframe element
    // (data-hcaptcha-widget-id) or in the iframe src hash (#frame=checkbox&id=…).
    //
    // The widget iframe boots its chat listener asynchronously, so a solve
    // that returns fast can post the tick before the listener exists and the
    // message is silently dropped. Re-send the tick a few times to cover that
    // window (idempotent — hCaptcha ignores ticks it can't use).
    const tickCheckboxes = () => {
      for (const iframe of document.querySelectorAll(
        'iframe[src*="hcaptcha.com"][src*="frame=checkbox"], iframe[data-hcaptcha-widget-id]',
      )) {
        const widgetId =
          iframe.getAttribute("data-hcaptcha-widget-id") ||
          (iframe.src.match(/[?&#]id=([^&]+)/) || [])[1];
        if (!widgetId) continue;
        // Deliver with "*": the checkbox frame can be a same-origin wrapper
        // whose real origin differs from its src, and the payload is a plain
        // chat message the frame itself validates (it accepts ticks from its
        // own parent page, which is what we are).
        iframe.contentWindow?.postMessage(
          JSON.stringify({ source: "hcaptcha", label: "checkbox-tick", id: widgetId }),
          "*",
        );
      }
    };
    tickCheckboxes();
    let tickTries = 0;
    const tickRetry = setInterval(() => {
      tickTries += 1;
      if (tickTries >= 6) {
        clearInterval(tickRetry);
        return;
      }
      tickCheckboxes();
    }, 500);

    // Fire the widget's own callback (data-callback="onSuccess" etc.) with the
    // token so the page's JS knows the captcha passed. Without this, the form
    // may stay disabled even though the hidden textarea holds a valid token.
    //
    // This must run in the page's MAIN world: content scripts live in an
    // isolated world where page globals (e.g. `var onSuccess = ...`) are not
    // visible, and inline <script> injection is blocked by many sites' CSP
    // (the hCaptcha demo page included). The background worker runs it via
    // chrome.scripting.executeScript({ world: "MAIN" }), which is exempt from
    // page CSP.
    const fired = new Set();
    for (const el of document.querySelectorAll("[data-callback]")) {
      const cbName = el.getAttribute("data-callback");
      if (!cbName || fired.has(cbName)) continue;
      fired.add(cbName);
      chrome.runtime.sendMessage({ type: "FIRE_CALLBACK", cbName, token }, () => {});
    }

    toast("Captcha solved ✓", "ok");
  }

  // ---- toast ----------------------------------------------------------------

  let toastEl = null;
  function toast(message, kind) {
    if (!toastEl) {
      const style = document.createElement("style");
      style.textContent =
        "#solvecha-toast{position:fixed;top:12px;right:12px;z-index:2147483647;" +
        "font:12px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;" +
        "background:#09090b;color:#fafafa;box-shadow:0 4px 16px rgba(0,0,0,.35);" +
        "max-width:320px;pointer-events:none;border-left:3px solid #71717a}" +
        "#solvecha-toast.busy{border-left-color:#eab308}" +
        "#solvecha-toast.ok{border-left-color:#15803d}" +
        "#solvecha-toast.error{border-left-color:#dc2626}";
      (document.head || document.documentElement).appendChild(style);
      toastEl = document.createElement("div");
      toastEl.id = "solvecha-toast";
      toastEl.hidden = true;
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.className = `solvecha-toast ${kind || "info"}`;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    if (kind === "busy") return; // stay visible for the whole solve
    toastEl._t = setTimeout(() => {
      toastEl.hidden = true;
    }, kind === "error" ? 12000 : 5000);
  }

  // ---- wiring -------------------------------------------------------------

  let scanPending = false;
  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scan();
    }, 100); // Faster: was 250ms, now 100ms for quicker challenge detection
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Re-solve hook: if a token we injected gets consumed while a new challenge
  // is open, let scan() re-arm that widget (cheap 2s poll, no quota risk).
  setInterval(() => {
    if (!config.enabled) return;
    if (!challengePresent() || tokenPresent()) return;
    scan();
  }, 2000); // Faster: was 4000ms, now 2000ms for quicker re-solve

  scan();
})();
