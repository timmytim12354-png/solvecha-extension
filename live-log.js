// Draggable live-solve log overlay. Runs in the page (isolated world).
// The background worker pushes SOLVE_LOG events while a solve is in flight.

(() => {
  "use strict";

  try {
    if (window.top !== window) return;
  } catch {
    /* framed without access to top — still show a panel in this frame */
  }

  const KIND_ICON = {
    screenshot: "▣",
    click: "➤",
    vision: "◎",
    nav: "→",
    proxy: "⬡",
    detect: "◉",
    queue: "…",
    done: "✓",
    error: "!",
    log: "·",
  };

  let root = null;
  let shadow = null;
  let minimized = false;
  let drag = null;
  let hideTimer = null;
  let startedAt = 0;
  let timerIv = null;

  const css = `
    :host { all: initial; }
    .panel {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 340px;
      max-width: calc(100vw - 24px);
      background: #09090b;
      color: #fafafa;
      border: 1px solid #27272a;
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.45);
      font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      z-index: 2147483646;
      overflow: hidden;
    }
    .panel.minimized { width: 220px; }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: #18181b;
      cursor: grab;
      user-select: none;
    }
    .head:active { cursor: grabbing; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #eab308; flex: none;
    }
    .dot.ok { background: #22c55e; }
    .dot.err { background: #ef4444; }
    .title { font-weight: 650; font-size: 12px; flex: 1; min-width: 0; }
    .title small { display: block; color: #a1a1aa; font-weight: 500; font-size: 10px; }
    .timer { color: #eab308; font-variant-numeric: tabular-nums; font-size: 11px; }
    .btn {
      background: transparent; border: 0; color: #a1a1aa;
      width: 22px; height: 22px; border-radius: 6px; cursor: pointer;
      font-size: 14px; line-height: 1;
    }
    .btn:hover { background: #27272a; color: #fff; }
    .body { max-height: 240px; overflow-y: auto; padding: 8px 10px 10px; }
    .panel.minimized .body { display: none; }
    .row {
      display: grid;
      grid-template-columns: 42px 14px 1fr;
      gap: 6px;
      align-items: start;
      padding: 2px 0;
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .t { color: #52525b; }
    .i { color: #71717a; text-align: center; }
    .m { color: #d4d4d8; word-break: break-word; }
    .row.ok .m { color: #4ade80; }
    .row.warn .m { color: #fbbf24; }
    .row.error .m { color: #f87171; }
    .row.screenshot .i { color: #38bdf8; }
    .row.click .i { color: #c084fc; }
    .row.vision .i { color: #f472b6; }
    .empty { color: #71717a; font-size: 11px; padding: 6px 0; }
  `;

  function ensure() {
    if (root) return;
    root = document.createElement("div");
    root.id = "solvecha-live-host";
    shadow = root.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${css}</style>
      <div class="panel" part="panel">
        <div class="head">
          <span class="dot"></span>
          <div class="title">Solvecha <small class="sub">Live solve</small></div>
          <span class="timer">0s</span>
          <button class="btn min" title="Minimize">–</button>
          <button class="btn close" title="Close">×</button>
        </div>
        <div class="body"><div class="empty">Waiting for solver…</div></div>
      </div>`;
    (document.documentElement || document.body).appendChild(root);

    const panel = shadow.querySelector(".panel");
    const head = shadow.querySelector(".head");
    shadow.querySelector(".min").addEventListener("click", (e) => {
      e.stopPropagation();
      minimized = !minimized;
      panel.classList.toggle("minimized", minimized);
      shadow.querySelector(".min").textContent = minimized ? "+" : "–";
      shadow.querySelector(".min").title = minimized ? "Expand" : "Minimize";
    });
    shadow.querySelector(".close").addEventListener("click", (e) => {
      e.stopPropagation();
      hide(true);
    });

    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      drag = {
        dx: e.clientX - r.left,
        dy: e.clientY - r.top,
        pointer: e.pointerId,
      };
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

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function render(entries, meta) {
    ensure();
    root.hidden = false;
    const panel = shadow.querySelector(".panel");
    const sub = shadow.querySelector(".sub");
    const dot = shadow.querySelector(".dot");
    const body = shadow.querySelector(".body");
    sub.textContent = meta.label || "Live solve";
    dot.className = "dot" + (meta.done ? (meta.failed ? " err" : " ok") : "");
    if (!entries || !entries.length) {
      body.innerHTML = `<div class="empty">Waiting for solver…</div>`;
      return;
    }
    body.innerHTML = entries
      .map((e) => {
        const d = new Date(e.ts || Date.now());
        const time = `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const kind = e.kind || "log";
        const icon = KIND_ICON[kind] || KIND_ICON.log;
        const msg = String(e.msg || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<div class="row ${e.level || "info"} ${kind}"><span class="t">${time}</span><span class="i">${icon}</span><span class="m">${msg}</span></div>`;
      })
      .join("");
    body.scrollTop = body.scrollHeight;
  }

  function tick() {
    if (!shadow || !startedAt) return;
    const el = shadow.querySelector(".timer");
    if (el) el.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s`;
  }

  function open(label) {
    ensure();
    clearTimeout(hideTimer);
    startedAt = Date.now();
    minimized = false;
    const panel = shadow.querySelector(".panel");
    panel.classList.remove("minimized");
    shadow.querySelector(".min").textContent = "–";
    root.hidden = false;
    render([], { label, done: false });
    if (timerIv) clearInterval(timerIv);
    timerIv = setInterval(tick, 500);
    tick();
  }

  function hide(immediate) {
    const go = () => {
      if (root) root.hidden = true;
      if (timerIv) {
        clearInterval(timerIv);
        timerIv = null;
      }
    };
    if (immediate) {
      go();
      return;
    }
    hideTimer = setTimeout(go, 8000);
  }

  globalThis.__solvechaPanel = {
    open,
    hide,
    setLogs(entries, meta) {
      render(entries || [], meta || {});
      if (meta && meta.done) {
        if (timerIv) {
          clearInterval(timerIv);
          timerIv = null;
        }
        tick();
        hide(false);
      }
    },
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "SOLVE_PANEL_OPEN") {
      open(msg.label || "Live solve");
    }
    if (msg?.type === "SOLVE_LOG") {
      if (root?.hidden !== false) open(msg.label || "Live solve");
      globalThis.__solvechaPanel.setLogs(msg.entries, {
        label: msg.label,
        done: msg.done,
        failed: msg.failed,
      });
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
      if (root && !root.hidden) {
        minimized = false;
        shadow.querySelector(".panel")?.classList.remove("minimized");
        shadow.querySelector(".min").textContent = "–";
      } else {
        open("Solvecha");
      }
    },
    true,
  );
})();
