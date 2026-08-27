const $ = (id) => document.getElementById(id);
let logPollTimer = null;
let logStartTime = 0;

const LEVEL_ICONS = { info: '▸', ok: '✓', warn: '✗', error: '!' };

function renderLogs(logs) {
  const panel = $("log-panel");
  const entries = logs?.entries || [];
  if (entries.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const container = $("log-entries");
  container.innerHTML = entries.map((e) => {
    const t = new Date(e.ts);
    const time = `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
    const icon = LEVEL_ICONS[e.level] || '·';
    return `<div class="log-entry ${e.level}"><span class="log-time">${time}</span><span class="log-icon">${icon}</span><span class="log-msg">${escHtml(e.msg)}</span></div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
  // Update timer
  if (logStartTime) {
    const sec = Math.round((Date.now() - logStartTime) / 1000);
    $("log-timer").textContent = `${sec}s`;
  }
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function pollLogs() {
  const logs = await chrome.runtime.sendMessage({ type: "GET_LOGS" });
  renderLogs(logs);
}

function startLogDisplay() {
  logStartTime = Date.now();
  logPollTimer = setInterval(pollLogs, 400);
  pollLogs();
}

function stopLogDisplay() {
  if (logPollTimer) {
    clearInterval(logPollTimer);
    logPollTimer = null;
  }
  // Keep showing final logs for a moment
  setTimeout(() => { $("log-panel").hidden = true; }, 3000);
}

// Listen for log update notifications from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "LOGS_UPDATED") pollLogs();
});

function render(status) {
  $("toggle").checked = Boolean(status.enabled);
  const label = $("status-text");
  if (!status.enabled) {
    label.textContent = "Off";
    label.className = "warn";
  } else if (status.hasKey) {
    label.textContent = "Active";
    label.className = "on";
  } else {
    label.textContent = "Needs key";
    label.className = "warn";
  }

  $("no-key").hidden = status.hasKey;
  $("has-key").hidden = !status.hasKey;

  if (status.hasKey) {
    $("key-masked").textContent = status.keyMasked;
    const quota = status.lastStatus?.quota;
    $("quota-text").textContent = quota
      ? `${quota.monthlyUsed} / ${quota.monthlyLimit}`
      : "—";
    const pct =
      quota && quota.monthlyLimit
        ? Math.min(100, (quota.monthlyUsed / quota.monthlyLimit) * 100)
        : 0;
    const fill = $("quota-fill");
    fill.style.width = `${pct}%`;
    fill.classList.toggle("full", pct >= 100);
    $("quota-reset").textContent = quota?.resetsAt
      ? new Date(quota.resetsAt).toLocaleDateString()
      : "—";
  }

  const err = status.lastStatus?.error;
  const banner = $("error-banner");
  banner.hidden = !err;
  if (err) banner.textContent = err.message;

  const paused = (status.pausedSites || []).length;
  const note = $("paused-note");
  note.hidden = paused === 0;
  note.textContent = paused ? `${paused} site${paused > 1 ? "s" : ""} paused` : "";
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  render(status);
  // If a solve was recently active, show live logs
  const logs = await chrome.runtime.sendMessage({ type: "GET_LOGS" });
  if (logs?.entries?.length > 0) {
    const lastEntry = logs.entries[logs.entries.length - 1];
    const isRecent = Date.now() - lastEntry.ts < 30_000;
    if (isRecent) {
      logStartTime = logs.entries[0].ts;
      renderLogs(logs);
      startLogDisplay();
    }
  }
}

$("toggle").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "TOGGLE", enabled: e.target.checked });
  refresh();
});

$("btn-get-key").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://solvecha.net/" });
});

$("btn-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://solvecha.net/dashboard" });
});

$("btn-connect").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
