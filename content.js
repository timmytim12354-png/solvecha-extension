// Content script — runs in every frame of every page.
//
// What it does:
//   1. Watches the DOM for hCaptcha and Cloudflare Turnstile widgets
//      (visible checkboxes, challenge iframes, and invisible widgets).
//   2. When a captcha is detected and auto-solve is on, asks the background
//      worker to solve it via the solvecha.net API (the API key never leaves
//      the background worker).
//   3. Injects the returned token into the widget and shows a tiny status toast.
//
// The content script holds no credentials and no shared secret.

(() => {
  "use strict";

  // Never run inside the captcha provider's own frames. The TOP-LEVEL page
  // must still run even when it's hosted on those domains (official demos).
  if (window.top !== window) {
    const host = location.hostname;
    if (/(^|\.)hcaptcha\.com$/.test(host)) return;
    if (/(^|\.)challenges\.cloudflare\.com$/.test(host)) return;
  }

  const HCAPTCHA_CONTAINER =
    'div.h-captcha, div[data-sitekey][class*="h-captcha"], iframe[src*="hcaptcha.com"], iframe[title*="hCaptcha"]';
  const CHALLENGE_IFRAME_SELECTOR =
    'iframe[src*="hcaptcha.com"][src*="challenge"], iframe[src*="hcaptcha.com"][src*="frame=challenge"]';
  const SITEKEY_IN_SRC = /[?&]sitekey=([^&]+)/;
  const TURNSTILE_SITEKEY = /^(0x[0-9A-Za-z]+|[123]x[0-9A-Fa-f]+)$/;

  const MAX_RETRIES = 3;
  const state = new Map(); // `${kind}:${sitekey}` -> { phase, retries }

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

  function isTurnstileSitekey(k) {
    return TURNSTILE_SITEKEY.test(String(k || "").trim());
  }

  function isHcaptchaEl(el) {
    if (!el) return false;
    if (el.classList && el.classList.contains("h-captcha")) return true;
    if (typeof el.closest === "function" && el.closest(".h-captcha")) return true;
    const src = el.src || "";
    return src.includes("hcaptcha.com");
  }

  function sitekeyFromCfSrc(src) {
    const q = String(src || "").match(/[?&]k=([^&]+)/);
    if (q && q[1]) return decodeURIComponent(q[1]);
    const p = String(src || "").match(/\/(0x[0-9A-Za-z]+|[123]x[0-9A-Fa-f]+)(?:\/|$|\?)/);
    return p ? p[1] : "";
  }

  function extractCaptchas() {
    const found = [];
    const add = (sitekey, kind) => {
      const k = String(sitekey || "").trim();
      if (!k) return;
      if (!found.some((x) => x.sitekey === k && x.kind === kind)) {
        found.push({ sitekey: k, kind });
      }
    };

    for (const el of document.querySelectorAll('div.h-captcha, div[data-sitekey][class*="h-captcha"]')) {
      add(el.getAttribute("data-sitekey"), "hcaptcha");
    }
    for (const iframe of document.querySelectorAll('iframe[src*="hcaptcha.com"]')) {
      const m = iframe.src.match(SITEKEY_IN_SRC);
      if (m && m[1]) add(decodeURIComponent(m[1]), "hcaptcha");
    }

    for (const el of document.querySelectorAll(".cf-turnstile, #cf-turnstile")) {
      add(el.getAttribute("data-sitekey"), "turnstile");
    }
    for (const el of document.querySelectorAll("[data-sitekey]")) {
      if (isHcaptchaEl(el)) continue;
      const k = el.getAttribute("data-sitekey");
      if (isTurnstileSitekey(k) || (el.classList && el.classList.contains("cf-turnstile"))) {
        add(k, "turnstile");
      }
    }
    for (const iframe of document.querySelectorAll(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="cdn-cgi/challenge-platform"]',
    )) {
      const k = sitekeyFromCfSrc(iframe.src);
      if (k) add(k, "turnstile");
    }
    return found;
  }

  function widgetFor(sitekey, kind) {
    if (kind === "turnstile") {
      for (const el of document.querySelectorAll(".cf-turnstile, #cf-turnstile, [data-sitekey]")) {
        if (isHcaptchaEl(el)) continue;
        const k = el.getAttribute("data-sitekey");
        if (k && k.trim() === sitekey) return el;
      }
      for (const iframe of document.querySelectorAll(
        'iframe[src*="challenges.cloudflare.com"], iframe[src*="cdn-cgi/challenge-platform"]',
      )) {
        if (sitekeyFromCfSrc(iframe.src) === sitekey) return iframe;
      }
      return document.querySelector(".cf-turnstile, #cf-turnstile");
    }
    for (const el of document.querySelectorAll(HCAPTCHA_CONTAINER)) {
      const k = el.getAttribute("data-sitekey");
      if (k && k.trim() === sitekey) return el;
    }
    for (const iframe of document.querySelectorAll('iframe[src*="hcaptcha.com"]')) {
      const m = iframe.src.match(SITEKEY_IN_SRC);
      if (m && decodeURIComponent(m[1]) === sitekey) return iframe;
    }
    return null;
  }

  function challengePresent() {
    return !!document.querySelector(CHALLENGE_IFRAME_SELECTOR);
  }

  function hcaptchaTokenPresent() {
    const ta = document.querySelector('textarea[name="h-captcha-response"]');
    return Boolean(ta && ta.value);
  }

  function turnstileTokenPresent() {
    const el = document.querySelector('[name="cf-turnstile-response"]');
    return Boolean(el && el.value && el.value.length > 40);
  }

  function turnstileWidgetPresent() {
    return !!document.querySelector(
      '.cf-turnstile, #cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="cdn-cgi/challenge-platform"]',
    );
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

  function stateKey(kind, sitekey) {
    return `${kind}:${sitekey}`;
  }

  function scan() {
    if (!config.enabled) return;
    const captchas = extractCaptchas();
    if (!captchas.length) return;
    const paused = isPaused();

    for (const { sitekey, kind } of captchas) {
      const key = stateKey(kind, sitekey);
      const s = state.get(key) || { phase: "idle", retries: 0 };
      state.set(key, s);
      if (s.phase === "solving") continue;

      if (kind === "hcaptcha") {
        if (s.phase === "solved" && challengePresent() && !hcaptchaTokenPresent()) {
          s.retries += 1;
          s.phase = s.retries <= MAX_RETRIES ? "idle" : "failed";
          if (s.phase !== "idle") continue;
        }
      } else if (s.phase === "solved" && turnstileWidgetPresent() && !turnstileTokenPresent()) {
        s.retries += 1;
        s.phase = s.retries <= MAX_RETRIES ? "idle" : "failed";
        if (s.phase !== "idle") continue;
      }

      if (s.phase !== "idle") continue;
      if (paused) continue;

      const widget = widgetFor(sitekey, kind);
      if (!widget && kind === "hcaptcha") continue;

      if (kind === "hcaptcha") {
        if (challengePresent()) triggerSolve(sitekey, kind);
        continue;
      }

      if (turnstileTokenPresent()) {
        s.phase = "solved";
        continue;
      }
      triggerSolve(sitekey, kind);
    }
  }

  function pageUrl() {
    try {
      return window.top.location.href;
    } catch {
      return location.href;
    }
  }

  function triggerSolve(sitekey, captchaType) {
    const key = stateKey(captchaType, sitekey);
    const s = state.get(key) || { phase: "idle", retries: 0 };
    if (s.phase === "solving" || s.phase === "solved") return;
    s.phase = "solving";
    state.set(key, s);

    const label = captchaType === "turnstile" ? "Turnstile" : "hCaptcha";
    toast(`Solving ${label}…`, "busy");
    const solveStartedAt = Date.now();
    const elapsedTimer = setInterval(() => {
      const sec = Math.round((Date.now() - solveStartedAt) / 1000);
      toast(`Solving ${label}… (${sec}s)`, "busy");
    }, 5000);

    const startApi = () => {
      chrome.runtime.sendMessage(
        { type: "SOLVE", sitekey, pageurl: pageUrl(), captchaType },
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
            injectToken(res.token, captchaType);
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
          const stillOpen =
            captchaType === "turnstile"
              ? turnstileWidgetPresent() && !turnstileTokenPresent()
              : challengePresent();
          if (s.retries < MAX_RETRIES && stillOpen) {
            clearTimeout(s.retryTimer);
            s.retryTimer = setTimeout(() => {
              const cur = state.get(key);
              if (cur && cur.phase === "failed" && cur.retries < MAX_RETRIES) {
                triggerSolve(sitekey, captchaType);
              }
            }, busy ? 10000 : 4000);
          }
        },
      );
    };

    // Invisible / managed Turnstile often mints a token in this browser
    // before the remote solver would. Use it if it appears quickly.
    if (captchaType === "turnstile") {
      const started = Date.now();
      const poll = () => {
        if (turnstileTokenPresent()) {
          clearInterval(elapsedTimer);
          const el = document.querySelector('[name="cf-turnstile-response"]');
          s.phase = "solved";
          injectToken(el.value, "turnstile");
          return;
        }
        if (Date.now() - started >= 1600) {
          startApi();
          return;
        }
        setTimeout(poll, 200);
      };
      poll();
      return;
    }

    startApi();
  }

  function injectToken(token, captchaType) {
    if (captchaType === "turnstile") {
      injectTurnstile(token);
    } else {
      injectHcaptcha(token);
    }
    toast("Captcha solved ✓", "ok");
  }

  function injectTurnstile(token) {
    const write = () => {
      let wrote = 0;
      for (const sel of [
        '[name="cf-turnstile-response"]',
        'input[name="g-recaptcha-response"]',
        'textarea[name="g-recaptcha-response"]',
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          el.value = token;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          wrote += 1;
        }
      }
      return wrote > 0;
    };

    if (!write()) {
      const mo = new MutationObserver(() => {
        if (write()) mo.disconnect();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 6000);
    }

    chrome.runtime.sendMessage(
      { type: "INJECT_TOKEN", token, captchaType: "turnstile" },
      () => {},
    );

    const fired = new Set();
    for (const el of document.querySelectorAll(
      ".cf-turnstile[data-callback], #cf-turnstile[data-callback], [data-sitekey][data-callback]",
    )) {
      if (isHcaptchaEl(el)) continue;
      const cbName = el.getAttribute("data-callback");
      if (!cbName || fired.has(cbName)) continue;
      fired.add(cbName);
      chrome.runtime.sendMessage({ type: "FIRE_CALLBACK", cbName, token }, () => {});
    }
  }

  function injectHcaptcha(token) {
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

    if (!writeTextareas()) {
      const mo = new MutationObserver(() => {
        if (writeTextareas()) mo.disconnect();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 6000);
    }

    const tickCheckboxes = () => {
      for (const iframe of document.querySelectorAll(
        'iframe[src*="hcaptcha.com"][src*="frame=checkbox"], iframe[data-hcaptcha-widget-id]',
      )) {
        const widgetId =
          iframe.getAttribute("data-hcaptcha-widget-id") ||
          (iframe.src.match(/[?&#]id=([^&]+)/) || [])[1];
        if (!widgetId) continue;
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

    chrome.runtime.sendMessage({ type: "INJECT_TOKEN", token, captchaType: "hcaptcha" }, () => {});

    const fired = new Set();
    for (const el of document.querySelectorAll("[data-callback]")) {
      const cbName = el.getAttribute("data-callback");
      if (!cbName || fired.has(cbName)) continue;
      fired.add(cbName);
      chrome.runtime.sendMessage({ type: "FIRE_CALLBACK", cbName, token }, () => {});
    }
  }

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
    if (kind === "busy") return;
    toastEl._t = setTimeout(() => {
      toastEl.hidden = true;
    }, kind === "error" ? 12000 : 5000);
  }

  let scanPending = false;
  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scan();
    }, 100);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  setInterval(() => {
    if (!config.enabled) return;
    const hNeed = challengePresent() && !hcaptchaTokenPresent();
    const tNeed = turnstileWidgetPresent() && !turnstileTokenPresent();
    if (hNeed || tNeed) scan();
  }, 2000);

  scan();
})();
