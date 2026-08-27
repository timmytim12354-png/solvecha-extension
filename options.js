import { DEFAULT_API_BASE, getConfig, setConfig } from "./shared.js";

const $ = (id) => document.getElementById(id);

function setAlert(html, kind = "error") {
  const box = $("key-alert");
  box.innerHTML = "";
  if (!html) return;
  const div = document.createElement("div");
  div.className = `alert alert-${kind}`;
  div.innerHTML = html;
  box.appendChild(div);
}

function renderUsage(status) {
  const quota = status.lastStatus?.quota;
  $("usage-key").textContent = status.keyMasked || "—";
  $("usage-quota").textContent = quota
    ? `${quota.monthlyUsed} / ${quota.monthlyLimit}`
    : "—";
  const pct =
    quota && quota.monthlyLimit
      ? Math.min(100, (quota.monthlyUsed / quota.monthlyLimit) * 100)
      : 0;
  const fill = $("usage-fill");
  fill.style.width = `${pct}%`;
  fill.classList.toggle("full", pct >= 100);
  $("usage-reset").textContent = quota?.resetsAt
    ? new Date(quota.resetsAt).toLocaleDateString()
    : "—";
  $("usage-total").textContent = String(status.lastStatus?.totalSolves ?? "—");
  const plan = status.lastStatus?.account?.planName;
  const badge = $("plan-badge");
  badge.hidden = !plan;
  if (plan) badge.textContent = plan;
}

function renderPaused(status) {
  const sites = status.pausedSites || [];
  const list = $("pause-list");
  list.textContent = "";
  $("pause-empty").hidden = sites.length > 0;
  for (const site of sites) {
    const li = document.createElement("li");
    li.textContent = site;
    const rm = document.createElement("button");
    rm.className = "btn btn-danger";
    rm.textContent = "Unpause";
    rm.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "UNPAUSE_SITE", site });
      apply(await chrome.runtime.sendMessage({ type: "GET_STATUS" }));
    });
    li.appendChild(rm);
    list.appendChild(li);
  }
}

function apply(status) {
  $("toggle").checked = Boolean(status.enabled);
  $("api-base").value = status.apiBase || DEFAULT_API_BASE;
  $("btn-remove-key").hidden = !status.hasKey;
  renderUsage(status);
  renderPaused(status);
}

async function load() {
  const config = await getConfig();
  $("api-key").value = config.apiKey || "";
  apply(await chrome.runtime.sendMessage({ type: "GET_STATUS" }));
}

$("btn-save-key").addEventListener("click", async () => {
  const key = $("api-key").value.trim();
  const btn = $("btn-save-key");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  setAlert(null);
  try {
    const res = await chrome.runtime.sendMessage({ type: "VALIDATE_KEY", key });
    if (res.ok) {
      await setConfig({ apiKey: key });
      setAlert(
        `Connected — <strong>${res.data.account.name || "account"}</strong> · ${res.data.account.planName} plan`,
        "success",
      );
    } else {
      setAlert(res.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Check & save";
  }
  apply(await chrome.runtime.sendMessage({ type: "GET_STATUS" }));
});

$("btn-remove-key").addEventListener("click", async () => {
  await setConfig({ apiKey: "" });
  $("api-key").value = "";
  setAlert(null);
  apply(await chrome.runtime.sendMessage({ type: "GET_STATUS" }));
});

$("toggle").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "TOGGLE", enabled: e.target.checked });
});

$("btn-save-base").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SET_API_BASE", apiBase: $("api-base").value });
  apply(await chrome.runtime.sendMessage({ type: "GET_STATUS" }));
});

$("btn-pause").addEventListener("click", async () => {
  const site = $("pause-input").value.trim().toLowerCase();
  if (!site) return;
  $("pause-input").value = "";
  await chrome.runtime.sendMessage({ type: "PAUSE_SITE", site });
  apply(await chrome.runtime.sendMessage({ type: "GET_STATUS" }));
});

$("pause-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-pause").click();
});

$("btn-open-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://solvecha.net/dashboard" });
});

load();
