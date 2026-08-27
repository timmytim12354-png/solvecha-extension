// Premium live-solve overlay. Pulls logs over a long-lived port so the
// panel keeps updating even while the solve request is in flight.

(() => {
  "use strict";

  try {
    if (window.top !== window) return;
  } catch {
    /* stay and show the panel in this frame */
  }

  const KIND = {
    screenshot: { label: "shot", tone: "sky" },
    click: { label: "click", tone: "violet" },
    vision: { label: "read", tone: "pink" },
    nav: { label: "open", tone: "blue" },
    proxy: { label: "proxy", tone: "zinc" },
    detect: { label: "find", tone: "amber" },
    queue: { label: "send", tone: "zinc" },
    done: { label: "done", tone: "green" },
    error: { label: "fail", tone: "red" },
    log: { label: "log", tone: "zinc" },
  };

  let root = null;
  let shadow = null;
  let minimized = false;
  let drag = null;
  let hideTimer = null;
  let startedAt = 0;
  let sessionAt = 0;
  let renderedN = 0;
  let timerIv = null;
  let pollIv = null;
  let lastSig = "";
  let hideAfterDone = false;
  let sawActive = false;
  let logPort = null;
  let reconnectTimer = null;

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .panel {
      position: fixed;
      top: 18px;
      right: 18px;
      width: 348px;
      max-width: calc(100vw - 24px);
      color: #f4f4f5;
      font: 12.5px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: -0.01em;
      z-index: 2147483646;
      border-radius: 14px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.045), transparent 28%),
        #0c0c0e;
      border: 1px solid rgba(255,255,255,.08);
      box-shadow:
        0 0 0 1px rgba(0,0,0,.4),
        0 18px 50px rgba(0,0,0,.48),
        0 2px 6px rgba(0,0,0,.3);
      overflow: hidden;
      opacity: 0;
      transform: translateY(-8px) scale(.985);
      animation: enter 240ms cubic-bezier(.2,.75,.2,1) forwards;
    }
    .panel.leaving {
      animation: leave 180ms ease-in forwards;
    }
    @keyframes enter {
      to { opacity: 1; transform: none; }
    }
    @keyframes leave {
      to { opacity: 0; transform: translateY(-6px) scale(.99); }
    }

    .head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 10px 10px 12px;
      cursor: grab;
      user-select: none;
    }
    .head:active { cursor: grabbing; }

    .mark {
      width: 22px; height: 22px; flex: none;
      border-radius: 7px;
      background: #fafafa;
      color: #09090b;
      font: 720 11px/22px ui-sans-serif, system-ui, sans-serif;
      letter-spacing: -0.04em;
      text-align: center;
    }

    .meta { flex: 1; min-width: 0; }
    .name {
      font-weight: 620;
      font-size: 12.5px;
      color: #fafafa;
    }
    .sub {
      color: #71717a;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .clock {
      font: 500 11.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      color: #a1a1aa;
      padding: 4px 7px;
      border-radius: 999px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.06);
    }
    .panel.is-run .clock { color: #fbbf24; }
    .panel.is-done .clock { color: #4ade80; }
    .panel.is-fail .clock { color: #f87171; }

    .btn {
      background: transparent;
      border: 0;
      color: #71717a;
      width: 24px; height: 24px;
      border-radius: 7px;
      cursor: pointer;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .btn:hover { background: rgba(255,255,255,.06); color: #fafafa; }
    .btn svg { width: 12px; height: 12px; display: block; }

    .rail {
      height: 1px;
      background: rgba(255,255,255,.06);
      position: relative;
      overflow: hidden;
    }
    .rail i {
      position: absolute;
      inset: 0 auto 0 0;
      width: 36%;
      background: linear-gradient(90deg, transparent, rgba(250,204,21,.85), transparent);
      animation: sweep 1.7s ease-in-out infinite;
    }
    .panel.is-done .rail i {
      width: 100%;
      background: #22c55e;
      animation: none;
    }
    .panel.is-fail .rail i {
      width: 100%;
      background: #ef4444;
      animation: none;
    }
    @keyframes sweep {
      from { transform: translateX(-110%); }
      to { transform: translateX(320%); }
    }

    .body {
      max-height: 248px;
      overflow-y: auto;
      padding: 6px 6px 4px;
      scrollbar-width: thin;
      scrollbar-color: #27272a transparent;
    }
    .panel.is-min .body,
    .panel.is-min .foot { display: none; }
    .panel.is-min { width: 248px; }

    .panel.needs-key .rail i,
    .panel:not(.has-logs) .rail i {
      animation: none;
      width: 0;
    }
    .panel.needs-key.is-run .rail i { animation: none; width: 0; }
    .panel:not(.has-logs) .clock,
    .panel.needs-key .clock { display: none; }
    .panel:not(.has-logs) .count { display: none; }

    .empty {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #71717a;
      font-size: 11.5px;
      padding: 14px 10px 16px;
    }
    .empty-block {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 10px 14px;
    }
    .empty-block p {
      margin: 0;
      color: #d4d4d8;
      font-size: 12.5px;
      line-height: 1.45;
    }
    .cta {
      appearance: none;
      border: 0;
      background: #fafafa;
      color: #09090b;
      font: 620 11.5px/1 ui-sans-serif, system-ui, sans-serif;
      padding: 8px 11px;
      border-radius: 8px;
      cursor: pointer;
    }
    .cta:hover { background: #e4e4e7; }
    .pulse {
      width: 6px; height: 6px; border-radius: 50%;
      background: #eab308;
      box-shadow: 0 0 0 0 rgba(234,179,8,.45);
      animation: pulse 1.6s ease-out infinite;
      flex: none;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(234,179,8,.4); }
      70% { box-shadow: 0 0 0 7px rgba(234,179,8,0); }
      100% { box-shadow: 0 0 0 0 rgba(234,179,8,0); }
    }

    .row {
      display: grid;
      grid-template-columns: 38px 40px 1fr;
      gap: 8px;
      align-items: start;
      padding: 5px 8px;
      border-radius: 8px;
      animation: rowin 160ms ease-out;
    }
    .row:hover { background: rgba(255,255,255,.03); }
    @keyframes rowin {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: none; }
    }

    .t {
      color: #3f3f46;
      font: 500 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      padding-top: 1px;
    }
    .k {
      font-size: 9.5px;
      font-weight: 650;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding-top: 2px;
      color: #52525b;
    }
    .k.sky { color: #7dd3fc; }
    .k.violet { color: #c4b5fd; }
    .k.pink { color: #f9a8d4; }
    .k.blue { color: #93c5fd; }
    .k.amber { color: #fcd34d; }
    .k.green { color: #86efac; }
    .k.red { color: #fca5a5; }
    .k.zinc { color: #a1a1aa; }

    .m {
      color: #d4d4d8;
      font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
      word-break: break-word;
    }
    .row.ok .m { color: #bbf7d0; }
    .row.warn .m { color: #fde68a; }
    .row.error .m { color: #fecaca; }

    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 12px 9px;
      color: #52525b;
      font-size: 10.5px;
    }
    .foot b { color: #a1a1aa; font-weight: 550; }

    @media (prefers-reduced-motion: reduce) {
      .panel, .row, .rail i, .pulse { animation: none !important; }
      .panel { opacity: 1; transform: none; }
    }
  `;

  const ICO = {
    min: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 6h6"/></svg>',
    max: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 6h6M6 3v6"/></svg>',
    close: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>',
  };

  function ensure() {
    if (root) return;
    root = document.createElement("div");
    root.id = "solvecha-live-host";
    shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${css}</style>
      <div class="panel is-run" part="panel">
        <div class="head">
          <span class="mark">S</span>
          <div class="meta">
            <div class="name">Solvecha</div>
            <div class="sub">Connecting</div>
          </div>
          <span class="clock">0.0s</span>
          <button class="btn min" title="Minimize">${ICO.min}</button>
          <button class="btn close" title="Close">${ICO.close}</button>
        </div>
        <div class="rail"><i></i></div>
        <div class="body"></div>
        <div class="foot"><span class="count"></span><span class="hint">Drag to move</span></div>
      </div>`;
    (document.documentElement || document.body).appendChild(root);

    const panel = shadow.querySelector(".panel");
    const head = shadow.querySelector(".head");
    shadow.querySelector(".min").addEventListener("click", (e) => {
      e.stopPropagation();
      minimized = !minimized;
      panel.classList.toggle("is-min", minimized);
      shadow.querySelector(".min").innerHTML = minimized ? ICO.max : ICO.min;
      shadow.querySelector(".min").title = minimized ? "Expand" : "Minimize";
    });
    shadow.querySelector(".close").addEventListener("click", (e) => {
      e.stopPropagation();
      stopPolling();
      hide(true);
    });

    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    head.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = Math.min(window.innerWidth - 80, Math.max(0, e.clientX - drag.dx));
      const y = Math.min(window.innerHeight - 40, Math.max(0, e.clientY - drag.dy));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = "auto";
    });
    head.addEventListener("pointerup", () => {
      drag = null;
    });
  }

  function fmtClock(ms) {
    const t = Math.max(0, ms) / 1000;
    return `${t.toFixed(1)}s`;
  }

  function fmtRel(ts, start) {
    const s = Math.max(0, (Number(ts) || Date.now()) - (start || Date.now())) / 1000;
    return s.toFixed(1).padStart(4, " ");
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function hasStoredKey(cb) {
    chrome.storage.local.get("apiKey", (stored) => {
      cb(Boolean(String(stored?.apiKey || "").trim()));
    });
  }

  function bindConnectButton() {
    const btn = shadow.querySelector(".cta");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }, () => {
        void chrome.runtime.lastError;
      });
    });
  }

  function showNeedKey() {
    ensure();
    clearTimeout(hideTimer);
    hideAfterDone = false;
    stopPolling();
    startedAt = 0;
    sessionAt = 0;
    renderedN = 0;
    lastSig = "";
    const panel = shadow.querySelector(".panel");
    panel.classList.add("needs-key");
    panel.classList.remove("is-run", "is-done", "is-fail", "has-logs", "is-min", "leaving");
    shadow.querySelector(".sub").textContent = "Key required";
    shadow.querySelector(".hint").textContent = "Open settings to continue";
    shadow.querySelector(".count").textContent = "";
    shadow.querySelector(".body").innerHTML =
      `<div class="empty-block"><p>Connect a key to the extension</p><button class="cta" type="button">Open settings</button></div>`;
    bindConnectButton();
    root.hidden = false;
  }

  function resetSession() {
    const body = shadow.querySelector(".body");
    const panel = shadow.querySelector(".panel");
    panel.classList.remove("needs-key", "has-logs");
    body.innerHTML = `<div class="empty"><span class="pulse"></span>Sending request…</div>`;
    renderedN = 0;
    shadow.querySelector(".count").textContent = "";
    shadow.querySelector(".hint").textContent = "Drag to move";
  }

  function appendRow(entry) {
    const body = shadow.querySelector(".body");
    const empty = body.querySelector(".empty");
    if (empty) empty.remove();
    const kind = KIND[entry.kind] || KIND.log;
    const row = document.createElement("div");
    row.className = `row ${entry.level || "info"} ${entry.kind || "log"}`;
    row.innerHTML = `<span class="t">${esc(fmtRel(entry.ts, startedAt))}</span><span class="k ${kind.tone}">${kind.label}</span><span class="m">${esc(entry.msg)}</span>`;
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }

  function setState(meta) {
    const panel = shadow.querySelector(".panel");
    const sub = shadow.querySelector(".sub");
    const hint = shadow.querySelector(".hint");
    panel.classList.toggle("is-run", !meta.done && !meta.needsKey);
    panel.classList.toggle("is-done", Boolean(meta.done && !meta.failed));
    panel.classList.toggle("is-fail", Boolean(meta.failed));
    panel.classList.toggle("needs-key", Boolean(meta.needsKey));
    if (meta.done && startedAt) {
      shadow.querySelector(".clock").textContent = fmtClock(Date.now() - startedAt);
    }
    if (meta.label && !meta.done) sub.textContent = meta.label;
    if (meta.done && meta.failed) {
      sub.textContent = meta.label || "Solve failed";
      hint.textContent = "Dismisses shortly";
    } else if (meta.done) {
      sub.textContent = "Solved";
      hint.textContent = "Token injected";
    } else {
      hint.textContent = "Drag to move";
    }
  }

  function render(entries, meta) {
    ensure();
    root.hidden = false;
    const panel = shadow.querySelector(".panel");
    panel.classList.remove("leaving");
    setState(meta || {});

    const list = entries || [];
    if (startedAt && startedAt !== sessionAt) {
      sessionAt = startedAt;
      resetSession();
    }
    if (!list.length) {
      if (renderedN === 0) resetSession();
      return;
    }
    if (list.length < renderedN) resetSession();
    for (let i = renderedN; i < list.length; i += 1) appendRow(list[i]);
    renderedN = list.length;
    const panelNow = shadow.querySelector(".panel");
    if (renderedN > 0) {
      panelNow.classList.add("has-logs");
      panelNow.classList.remove("needs-key");
      const n = renderedN;
      shadow.querySelector(".count").textContent = n === 1 ? "1 event" : `${n} events`;
    } else {
      panelNow.classList.remove("has-logs");
      shadow.querySelector(".count").textContent = "";
    }
  }

  function tick() {
    if (!shadow || !startedAt) return;
    const el = shadow.querySelector(".clock");
    if (el) el.textContent = fmtClock(Date.now() - startedAt);
  }

  function applyLogs(logs) {
    if (!logs) return;
    const entries = logs.entries || [];
    const hasRows = entries.length > 0;
    const active = logs.done === false;
    if (active) sawActive = true;
    const last = hasRows ? entries[entries.length - 1] : null;
    const sig = `${logs.startedAt || 0}:${entries.length}:${logs.done}:${last?.msg || ""}:${last?.ts || 0}`;
    if (sig !== lastSig) {
      lastSig = sig;
      if (logs.startedAt) startedAt = logs.startedAt;
      if (hasRows || active) {
        render(entries, {
          label: logs.label,
          done: logs.done,
          failed: logs.failed,
        });
      }
    }
    if (logs.done && (sawActive || hasRows)) scheduleHide();
  }

  function connectLogPort() {
    if (logPort) return;
    try {
      logPort = chrome.runtime.connect({ name: "solvecha-logs" });
    } catch {
      logPort = null;
      return;
    }
    logPort.onMessage.addListener((msg) => {
      if (msg?.type === "SOLVE_LOG" || Array.isArray(msg?.entries)) applyLogs(msg);
    });
    logPort.onDisconnect.addListener(() => {
      logPort = null;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (root && !root.hidden) connectLogPort();
      }, 400);
    });
  }

  function pullLogs() {
    connectLogPort();
    chrome.runtime.sendMessage({ type: "GET_LOGS" }, (logs) => {
      if (chrome.runtime.lastError || !logs) return;
      applyLogs(logs);
    });
  }

  function startPolling() {
    if (hideAfterDone) return;
    clearTimeout(hideTimer);
    pullLogs();
    if (pollIv) return;
    pollIv = setInterval(pullLogs, 400);
    if (timerIv) clearInterval(timerIv);
    timerIv = setInterval(tick, 80);
  }

  function stopPolling() {
    if (pollIv) {
      clearInterval(pollIv);
      pollIv = null;
    }
    if (timerIv) {
      clearInterval(timerIv);
      timerIv = null;
    }
  }

  function scheduleHide() {
    if (hideAfterDone) return;
    hideAfterDone = true;
    stopPolling();
    hideTimer = setTimeout(() => hide(true), 9000);
  }

  function open(label) {
    ensure();
    clearTimeout(hideTimer);
    hideAfterDone = false;
    sawActive = false;
    lastSig = "";
    minimized = false;
    const panel = shadow.querySelector(".panel");
    panel.classList.remove("is-min", "leaving", "needs-key");
    shadow.querySelector(".min").innerHTML = ICO.min;
    root.hidden = false;
    if (label) shadow.querySelector(".sub").textContent = label;
    if (renderedN === 0) {
      startedAt = 0;
      sessionAt = 0;
      resetSession();
    }
    startPolling();
  }

  function hide(immediate) {
    const go = () => {
      if (root) root.hidden = true;
      stopPolling();
      if (logPort) {
        try {
          logPort.disconnect();
        } catch {
          /* ignore */
        }
        logPort = null;
      }
    };
    if (immediate) {
      clearTimeout(hideTimer);
      const panel = shadow?.querySelector(".panel");
      if (panel && !root.hidden) {
        panel.classList.add("leaving");
        setTimeout(go, 180);
        return;
      }
      go();
      return;
    }
    hideTimer = setTimeout(() => hide(true), 8000);
  }

  globalThis.__solvechaPanel = {
    open,
    hide,
    needKey: showNeedKey,
    refresh: pullLogs,
    setLogs(entries, meta) {
      if (meta?.startedAt) startedAt = meta.startedAt;
      render(entries || [], meta || {});
      if (meta && meta.done) scheduleHide();
    },
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SOLVE_PANEL_OPEN") open(msg.label || "Live solve");
    if (msg?.type === "SOLVE_LOG") {
      if (msg.done === false) sawActive = true;
      if (msg.entries && msg.entries.length) applyLogs(msg);
      else if (msg.done === false) open(msg.label || "Live solve");
      if (!hideAfterDone && shadow && !root.hidden && !shadow.querySelector(".panel")?.classList.contains("needs-key")) {
        startPolling();
      }
    }
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      if (!t || typeof t.closest !== "function") return;
      if (
        !t.closest(
          '.cf-turnstile, #cf-turnstile, .h-captcha, iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"]',
        )
      ) {
        return;
      }
      hasStoredKey((ok) => {
        if (!ok) showNeedKey();
      });
    },
    true,
  );
})();
