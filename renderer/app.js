"use strict";

/**
 * HotSpot — Renderer
 *
 * Subscribes to the HotSpot's BLE "Feed" characteristic, parses JSON state,
 * renders the current state + a running list of last talkers.
 *
 * Feed fields (see Analog-HotSPOT-SVXLink/BLE.md):
 *   ip, cs, fq, tg, tk (active talker), ltk (last talker), tx, rx
 */

// ── BLE UUIDs ─────────────────────────────────────────────────────────────────
const BLE_SVC_UUID    = "6b1d6a10-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_WRITE_UUID  = "6b1d6a11-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_STATUS_UUID = "6b1d6a12-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_CMD_UUID    = "6b1d6a13-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_FEED_UUID   = "6b1d6a14-c50f-4d86-a7f3-7f2a3a1b2c3d";

const THEME_KEY          = "ahs-app-theme";
const HISTORY_KEY        = "ahs-app-talker-history-v1";
const HISTORY_LIMIT_KEY  = "ahs-app-history-limit";
const BLE_LAST_DEVICE    = "ahs-app-ble-last-device";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const titleEl = document.getElementById("title");
const titlebarStatusEl = document.getElementById("titlebar-status");
const tbody = document.getElementById("tbody");
const themeToggleEl = document.getElementById("themeToggle");
const inputAppTitle = document.getElementById("input-app-title");
const inputTgInfo = document.getElementById("input-tg-info");
const historyLimitEl = document.getElementById("history-limit");
const tgBarEl = document.getElementById("tg-bar");
const tgBarButtonsEl = document.getElementById("tg-bar-buttons");

const hsCsEl = document.getElementById("hs-cs");
const hsFqEl = document.getElementById("hs-fq");
const hsTgEl = document.getElementById("hs-tg");
const hsIpEl = document.getElementById("hs-ip");
const hsTkEl = document.getElementById("hs-tk");
const hsActiveEl = document.getElementById("hs-active");
const flagRxEl = document.getElementById("flag-rx");
const flagTxEl = document.getElementById("flag-tx");

const settingsPanelEl = document.getElementById("settings-overlay");

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  cfg: null,
  feed: {},             // last parsed feed object
  history: [],          // [{cs, tg, fq, startedAt, endedAt}] newest first
  currentSession: null, // active talker session being accumulated
  historyLimit: 50,
  talkgroupInfo: {},    // {tgId: "label"}
  bleConnected: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function msAgoLabel(deltaMs) {
  const s = Math.floor(deltaMs / 1000);
  if (!Number.isFinite(s) || s < 0) return "\u2014";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "\u2014";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m${rs}s` : `${m}m`;
}

// ── History persistence ───────────────────────────────────────────────────────
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, 500)));
  } catch {}
}

function loadHistoryLimit() {
  try {
    const v = Number(localStorage.getItem(HISTORY_LIMIT_KEY));
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return 50;
}

function saveHistoryLimit(v) {
  try { localStorage.setItem(HISTORY_LIMIT_KEY, String(v)); } catch {}
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  if (themeToggleEl) themeToggleEl.checked = dark;
  try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch {}
}

function initTheme() {
  let dark = true;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light") dark = false;
  } catch {}
  applyTheme(dark);
}

// ── Feed handling ─────────────────────────────────────────────────────────────
function ingestFeed(json) {
  const prev = state.feed || {};
  state.feed = json || {};

  const now = Date.now();
  const prevTk = (prev.tk || "").toString().trim();
  const nextTk = (json.tk || "").toString().trim();
  const nextLtk = (json.ltk || "").toString().trim();
  const tg = (json.tg || "").toString().trim();
  const fq = (json.fq || "").toString().trim();

  if (nextTk && nextTk !== prevTk) {
    // A new talker started. Close any lingering session first.
    closeCurrentSession(now);
    state.currentSession = {
      cs: nextTk,
      tg,
      fq,
      startedAt: now,
      endedAt: null,
    };
    state.history.unshift(state.currentSession);
    trimHistory();
    saveHistory();
  } else if (!nextTk && prevTk && state.currentSession) {
    // Talker finished.
    closeCurrentSession(now);
    saveHistory();
  } else if (nextTk && state.currentSession && state.currentSession.cs === nextTk) {
    // Continuing — update tg/fq if they changed, but keep startedAt.
    state.currentSession.tg = tg || state.currentSession.tg;
    state.currentSession.fq = fq || state.currentSession.fq;
  }

  // If we're not tracking a live session but ltk is present and not in history,
  // seed a short historical entry. This covers the initial snapshot on connect.
  if (!state.currentSession && nextLtk) {
    const top = state.history[0];
    if (!top || top.cs !== nextLtk) {
      state.history.unshift({
        cs: nextLtk,
        tg,
        fq,
        startedAt: now,
        endedAt: now,
        historical: true,
      });
      trimHistory();
      saveHistory();
    }
  }

  renderFeed();
  renderTable();
  updateTray();
}

function closeCurrentSession(ts) {
  if (state.currentSession) {
    state.currentSession.endedAt = ts;
    state.currentSession = null;
  }
}

function trimHistory() {
  const cap = 500;
  if (state.history.length > cap) state.history.length = cap;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
// 4G/LTE signal meter — buckets per Analog-HotSPOT-SVXLink/BLE.md (modem RSSI):
//   ≥-70 excellent (4 bars), -85..-70 good (3), -100..-85 fair (2),
//   -110..-100 weak (1), <-110 very poor (1, red).
function updateSignalMeter(sg) {
  const meter = document.getElementById("signal-meter");
  if (!meter) return;
  if (sg === "" || sg == null) {
    meter.style.display = "none";
    return;
  }
  const dbm = Number(sg);
  if (!Number.isFinite(dbm)) {
    meter.style.display = "none";
    return;
  }
  let level, label;
  if (dbm >= -70)        { level = 4; label = "excellent"; }
  else if (dbm >= -85)   { level = 3; label = "good"; }
  else if (dbm >= -100)  { level = 2; label = "fair"; }
  else if (dbm >= -110)  { level = 1; label = "weak"; }
  else                   { level = 1; label = "very poor"; }
  meter.style.display = "";
  meter.dataset.level = String(level);
  meter.classList.toggle("very-poor", dbm < -110);
  meter.title = `4G signal: ${dbm} dBm (${label})`;
}

function renderFeed() {
  const f = state.feed || {};
  hsCsEl.textContent = f.cs || "\u2014";
  hsFqEl.textContent = f.fq ? `${f.fq} MHz` : "\u2014";
  hsTgEl.textContent = f.tg || "\u2014";
  hsIpEl.textContent = f.ip || "\u2014";

  const tk = (f.tk || "").toString().trim();
  const ltk = (f.ltk || "").toString().trim();
  const talking = !!tk;

  hsTkEl.textContent = tk || (ltk ? `${ltk} (last)` : "\u2014");
  hsActiveEl.classList.toggle("talking", talking);

  flagRxEl.classList.toggle("on", Number(f.rx) === 1);
  flagRxEl.classList.toggle("rx", Number(f.rx) === 1);
  flagTxEl.classList.toggle("on", Number(f.tx) === 1);
  flagTxEl.classList.toggle("tx", Number(f.tx) === 1);

  updateSignalMeter(f.sg);

  // Highlight the TG button matching the hotspot's current talkgroup
  const active = (f.tg || "").toString().trim();
  document.querySelectorAll("#tg-bar-buttons .tg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tg === active);
  });
}

// Whenever the TG list changes (config save / startup), push the new list
// to the tray so the context menu stays in sync.
function refreshTrayTgs() { updateTray(); }

function renderTgBar() {
  if (!tgBarButtonsEl) return;
  const tgs = Object.keys(state.talkgroupInfo || {})
    .map((k) => k.trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));

  tgBarButtonsEl.innerHTML = tgs
    .map((tg) => {
      const label = escapeHtml(state.talkgroupInfo[tg] || "");
      return `<button class="tg-btn" data-tg="${escapeHtml(tg)}" title="${label}">${escapeHtml(tg)}</button>`;
    })
    .join("");

  // Keep the active highlight in sync after rebuild
  renderFeed();

  // Only show the bar when BLE is connected AND we have TGs
  if (tgBarEl) {
    tgBarEl.style.display = state.bleConnected && tgs.length ? "" : "none";
  }
}

function renderTable() {
  if (!tbody) return;
  const limit = state.historyLimit;
  const rows = state.history.slice(0, limit);
  const now = Date.now();

  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="emptyRow"><td colspan="5">No talkers yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((s) => {
      const active = !s.endedAt && !s.historical;
      const dotCls = active ? "dotOnline" : "dotOffline";
      const dur = active
        ? `<span class="timeNow">Now</span>`
        : s.historical
          ? "\u2014"
          : durationLabel((s.endedAt || now) - s.startedAt);
      const heard = active ? `<span class="timeNow">Now</span>` : msAgoLabel(now - (s.endedAt || s.startedAt));
      const tg = s.tg ? escapeHtml(s.tg) : "\u2014";
      return `
        <tr class="${active ? "talkingRow" : ""}">
          <td class="narrow center"><span class="${dotCls}"></span></td>
          <td><strong>${escapeHtml(s.cs)}</strong></td>
          <td>${tg}</td>
          <td class="center">${dur}</td>
          <td class="center">${heard}</td>
        </tr>`;
    })
    .join("");
}

function updateTray() {
  const f = state.feed || {};
  const talkgroups = Object.keys(state.talkgroupInfo || {})
    .map((k) => k.trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))
    .map((tg) => ({ tg, label: state.talkgroupInfo[tg] || "" }));
  try {
    window.api.updateTrayState({
      connected: !!state.bleConnected,
      cs:  (f.cs  || "").toString().trim(),
      tk:  (f.tk  || "").toString().trim(),
      ltk: (f.ltk || "").toString().trim(),
      tg:  (f.tg  || "").toString().trim(),
      talkgroups,
    });
  } catch {}
}

// ── BLE client ────────────────────────────────────────────────────────────────
const ble = {
  device: null,
  writeChar: null,
  statusChar: null,
  cmdChar: null,
  feedChar: null,
  userDisconnected: false,
  reconnectTimer: null,
  reconnectAttempt: 0,
  reconnecting: false,
  keepaliveTimer: null,
};

function getSavedDeviceName() {
  try { return localStorage.getItem(BLE_LAST_DEVICE) || ""; }
  catch { return ""; }
}

function saveDeviceName(name) {
  if (!name) return;
  try { localStorage.setItem(BLE_LAST_DEVICE, name); } catch {}
  try { window.api.setPreferredBleName?.(name); } catch {}
}

function setBleStatus(text, cls) {
  const el = document.getElementById("ble-status");
  if (el) {
    if (!cls && text === "Not connected") {
      const saved = getSavedDeviceName();
      el.textContent = saved ? `Not connected (last: ${saved})` : "Not connected";
    } else {
      el.textContent = text;
    }
    el.className = cls || "";
  }

  if (titlebarStatusEl) {
    titlebarStatusEl.textContent = text || "Not connected";
    titlebarStatusEl.className = cls || "";
  }

  const connected = cls === "connected";
  state.bleConnected = connected;

  const quick = document.getElementById("btn-ble-quickconnect");
  if (quick) {
    const saved = getSavedDeviceName();
    quick.style.display = !connected && saved ? "" : "none";
    quick.title = saved ? `Reconnect to ${saved}` : "Reconnect";
  }

  const bar = document.getElementById("dtmf-bar");
  if (bar) bar.style.display = connected ? "" : "none";

  const connectBtn = document.getElementById("btn-ble-connect");
  const disconnectBtn = document.getElementById("btn-ble-disconnect");
  if (connectBtn) connectBtn.style.display = connected ? "none" : "";
  if (disconnectBtn) disconnectBtn.style.display = connected ? "" : "none";

  if (!connected) {
    // Wipe live feed view when disconnected, but keep history
    state.feed = {};
    renderFeed();
    updateSignalMeter("");
  }
  // Always push the new connection state to the tray
  updateTray();

  // Show/hide the TG quick-dial bar with connection state
  if (tgBarEl) {
    const hasTgs = Object.keys(state.talkgroupInfo || {}).length > 0;
    tgBarEl.style.display = connected && hasTgs ? "" : "none";
  }
}

function setDtmfResponse(text, cls) {
  const el = document.getElementById("dtmf-response");
  if (!el) return;
  el.textContent = text || "";
  el.className = cls || "";
}

async function bleSetupCharacteristics(device) {
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_SVC_UUID);
  const writeChar = await service.getCharacteristic(BLE_WRITE_UUID);
  const statusChar = await service.getCharacteristic(BLE_STATUS_UUID);

  let cmdChar = null;
  try { cmdChar = await service.getCharacteristic(BLE_CMD_UUID); } catch (_) {}

  let feedChar = null;
  try { feedChar = await service.getCharacteristic(BLE_FEED_UUID); } catch (_) {}

  await statusChar.startNotifications();
  statusChar.addEventListener("characteristicvaluechanged", (e) => {
    const text = new TextDecoder().decode(e.target.value);
    const isErr = text.startsWith("err");
    setDtmfResponse(text, isErr ? "bad" : "ok");
  });

  if (feedChar) {
    await feedChar.startNotifications();
    feedChar.addEventListener("characteristicvaluechanged", (e) => {
      const text = new TextDecoder().decode(e.target.value);
      try {
        const json = JSON.parse(text);
        ingestFeed(json);
      } catch (err) {
        console.warn("Feed parse failed:", err, text);
      }
    });
  }

  ble.device = device;
  ble.writeChar = writeChar;
  ble.statusChar = statusChar;
  ble.cmdChar = cmdChar;
  ble.feedChar = feedChar;
}

function bleClearReconnect() {
  if (ble.reconnectTimer) { clearTimeout(ble.reconnectTimer); ble.reconnectTimer = null; }
  ble.reconnectAttempt = 0;
  ble.reconnecting = false;
}

function stopKeepalive() {
  if (ble.keepaliveTimer) { clearInterval(ble.keepaliveTimer); ble.keepaliveTimer = null; }
}

// Keepalive: every 8s read the status CCCD. Prevents CoreBluetooth idle-parking.
function startKeepalive() {
  stopKeepalive();
  ble.keepaliveTimer = setInterval(async () => {
    const ch = ble.statusChar;
    const dev = ble.device;
    if (!dev?.gatt?.connected || !ch) return;
    try {
      const cccd = await ch.getDescriptor("00002902-0000-1000-8000-00805f9b34fb");
      await cccd.readValue();
    } catch (_) {}
  }, 8000);
}

function scheduleReconnect(delayMs) {
  if (ble.userDisconnected || !ble.device) return;
  if (ble.reconnectTimer) clearTimeout(ble.reconnectTimer);
  ble.reconnectTimer = setTimeout(bleTryReconnect, delayMs);
}

async function bleTryReconnect() {
  ble.reconnectTimer = null;
  if (ble.userDisconnected || !ble.device) return;
  if (ble.reconnecting) return;

  ble.reconnecting = true;
  ble.reconnectAttempt += 1;
  const n = ble.reconnectAttempt;
  setBleStatus("Reconnecting\u2026", "connecting");
  try {
    await bleSetupCharacteristics(ble.device);
    ble.reconnecting = false;
    ble.reconnectAttempt = 0;
    if (ble.device.name) saveDeviceName(ble.device.name);
    setBleStatus(ble.device.name || "Connected", "connected");
    startKeepalive();
  } catch (_) {
    ble.reconnecting = false;
    const delay = Math.min(15000, 1000 * Math.pow(1.6, n - 1));
    scheduleReconnect(delay);
  }
}

// Watchdog: revive the reconnect loop if state gets stuck.
setInterval(() => {
  if (ble.userDisconnected || !ble.device) return;
  const connected = !!ble.device.gatt?.connected && !!ble.writeChar;
  const busy = ble.reconnectTimer || ble.reconnecting;
  if (!connected && !busy) scheduleReconnect(500);
}, 15000);

async function bleConnect() {
  if (!navigator.bluetooth) {
    setBleStatus("Web Bluetooth not available", "error");
    return;
  }

  bleClearReconnect();
  if (ble.device) {
    try { if (ble.device.gatt.connected) ble.device.gatt.disconnect(); } catch (_) {}
    ble.device = null;
  }
  ble.writeChar = ble.statusChar = ble.cmdChar = ble.feedChar = null;
  ble.userDisconnected = false;

  try {
    setBleStatus("Scanning…", "connecting");
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SVC_UUID] }],
    });

    setBleStatus(`Connecting to ${device.name || "device"}…`, "connecting");
    device.addEventListener("gattserverdisconnected", () => {
      stopKeepalive();
      ble.writeChar = ble.statusChar = ble.cmdChar = ble.feedChar = null;
      if (ble.userDisconnected) {
        ble.device = null;
        setBleStatus("Not connected", "");
      } else {
        setBleStatus("Connection lost, retrying…", "connecting");
        scheduleReconnect(1000);
      }
    });

    await bleSetupCharacteristics(device);
    if (device.name) saveDeviceName(device.name);
    setBleStatus(device.name || "Connected", "connected");
    startKeepalive();
  } catch (err) {
    console.error("BLE connect failed:", err);
    const msg = err.message || "Connect failed";
    const cancelled = /cancel/i.test(msg) || err.name === "NotFoundError";
    setBleStatus(cancelled ? "Not connected" : msg, cancelled ? "" : "error");
  }
}

async function bleAutoReconnectOnStartup() {
  if (!getSavedDeviceName()) return;
  await bleConnect();
}
window.bleAutoReconnectOnStartup = bleAutoReconnectOnStartup;

async function bleDisconnect() {
  ble.userDisconnected = true;
  bleClearReconnect();
  stopKeepalive();
  try {
    if (ble.device && ble.device.gatt.connected) ble.device.gatt.disconnect();
  } catch (_) {}
  ble.device = null;
  ble.writeChar = ble.statusChar = ble.cmdChar = ble.feedChar = null;
  setBleStatus("Not connected", "");
}

async function bleSendDTMF(text) {
  if (!ble.writeChar) return;
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  if (!/^[0-9A-Da-d*#]+$/.test(trimmed)) {
    setDtmfResponse("Invalid DTMF chars", "bad");
    return;
  }
  try {
    const bytes = new TextEncoder().encode(trimmed);
    await ble.writeChar.writeValueWithoutResponse(bytes);
    setDtmfResponse(`→ ${trimmed}`, "");
  } catch (err) {
    console.error("DTMF send failed:", err);
    setDtmfResponse(err.message || "Send failed", "bad");
  }
}

async function bleSendCommand(cmd) {
  if (!ble.cmdChar) {
    setDtmfResponse("Command channel not available", "bad");
    return;
  }
  try {
    const bytes = new TextEncoder().encode(cmd);
    await ble.cmdChar.writeValue(bytes);
    setDtmfResponse(`→ ${cmd}`, "");
  } catch (err) {
    console.error("Command send failed:", err);
    setDtmfResponse(err.message || "Command failed", "bad");
  }
}

function initBLE() {
  document.getElementById("btn-ble-connect")?.addEventListener("click", bleConnect);
  document.getElementById("btn-ble-disconnect")?.addEventListener("click", bleDisconnect);
  document.getElementById("btn-ble-quickconnect")?.addEventListener("click", bleConnect);

  const input = document.getElementById("dtmf-input");
  const send = document.getElementById("dtmf-send");
  const doSend = () => {
    if (!input) return;
    bleSendDTMF(input.value);
    input.value = "";
  };
  send?.addEventListener("click", doSend);
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });

  document.querySelectorAll(".dtmf-quick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.getAttribute("data-dtmf");
      if (code) bleSendDTMF(code);
    });
  });

  const cmdSelect = document.getElementById("ble-cmd-select");
  cmdSelect?.addEventListener("change", () => {
    const cmd = cmdSelect.value;
    if (!cmd) return;
    if (["reboot", "poweroff"].includes(cmd) && !confirm(`Send "${cmd}" to the hotspot?`)) {
      cmdSelect.selectedIndex = 0;
      return;
    }
    bleSendCommand(cmd);
    cmdSelect.selectedIndex = 0;
  });

  // TG bar — click sends 91<tg># via DTMF (same as the original portal app)
  tgBarButtonsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tg-btn[data-tg]");
    if (!btn) return;
    const tg = btn.dataset.tg;
    if (!tg) return;
    bleSendDTMF(`91${tg}#`);
  });
}

// ── Title bar ─────────────────────────────────────────────────────────────────
function initTitleBar() {
  document.getElementById("btn-minimize")?.addEventListener("click", () => window.api.minimize());
  document.getElementById("btn-close")?.addEventListener("click", () => window.api.close());

  const btnOnTop = document.getElementById("btn-ontop");
  window.api.getOnTop().then((v) => {
    if (v && btnOnTop) btnOnTop.classList.add("active");
  });
  btnOnTop?.addEventListener("click", async () => {
    const v = await window.api.toggleOnTop();
    if (v) btnOnTop.classList.add("active");
    else btnOnTop.classList.remove("active");
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────
function openSettings() {
  if (!settingsPanelEl) return;
  const cfg = state.cfg || {};
  if (inputAppTitle) inputAppTitle.value = cfg.title || "";
  if (historyLimitEl) historyLimitEl.value = String(state.historyLimit);
  if (inputTgInfo) {
    const tg = state.talkgroupInfo;
    inputTgInfo.value = tg && Object.keys(tg).length ? JSON.stringify(tg, null, 2) : "";
  }
  settingsPanelEl.classList.remove("hidden");
}

function closeSettings() {
  settingsPanelEl?.classList.add("hidden");
}

function normalizeTgInfo(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = String(k).trim();
    if (key) out[key] = v;
  }
  return out;
}

function applyConfig(cfg) {
  state.cfg = cfg;
  if (titleEl && cfg.title) titleEl.textContent = cfg.title;
  document.title = cfg.title || "HotSpot";
  state.talkgroupInfo = normalizeTgInfo(cfg.talkgroupInfo || {});
  renderTgBar();
  refreshTrayTgs();
}

function initSettings() {
  document.getElementById("btn-settings")?.addEventListener("click", () => {
    if (settingsPanelEl?.classList.contains("hidden")) openSettings();
    else closeSettings();
  });
  settingsPanelEl?.addEventListener("click", (e) => {
    if (e.target === settingsPanelEl) closeSettings();
  });
  document.getElementById("btn-cancel-settings")?.addEventListener("click", closeSettings);

  document.getElementById("btn-restore-defaults")?.addEventListener("click", async () => {
    const defaults = await window.api.getDefaults();
    if (inputAppTitle) inputAppTitle.value = defaults.title || "";
    if (historyLimitEl) historyLimitEl.value = "50";
    if (inputTgInfo) {
      const tg = defaults.talkgroupInfo;
      inputTgInfo.value = tg && Object.keys(tg).length ? JSON.stringify(tg, null, 2) : "";
    }
  });

  document.getElementById("btn-clear-history")?.addEventListener("click", () => {
    if (!confirm("Clear the talker history?")) return;
    state.history = [];
    state.currentSession = null;
    saveHistory();
    renderTable();
  });

  document.getElementById("btn-save-settings")?.addEventListener("click", async () => {
    const title = (inputAppTitle?.value || "").trim() || "HotSpot";
    const limit = Number(historyLimitEl?.value) || 50;

    let talkgroupInfo = {};
    try {
      const raw = (inputTgInfo?.value || "").trim();
      if (raw) talkgroupInfo = JSON.parse(raw);
    } catch {
      alert("Talkgroups JSON is not valid.");
      return;
    }

    state.historyLimit = limit;
    saveHistoryLimit(limit);

    const newCfg = { title, talkgroupInfo };
    await window.api.saveSettings(newCfg);
    applyConfig(newCfg);

    closeSettings();
    renderTable();
  });

  themeToggleEl?.addEventListener("change", () => applyTheme(themeToggleEl.checked));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  initTheme();
  initTitleBar();
  initSettings();
  initBLE();

  // Tray-menu TG clicks — main process asks us to send a DTMF string.
  try {
    window.api.onSendDtmfRequest?.((dtmf) => bleSendDTMF(dtmf));
  } catch {}

  state.history = loadHistory();
  state.historyLimit = loadHistoryLimit();
  if (historyLimitEl) historyLimitEl.value = String(state.historyLimit);

  const cfg = await window.api.loadSettings();
  applyConfig(cfg);

  try { window.api.setPreferredBleName?.(getSavedDeviceName()); } catch {}
  setBleStatus("Not connected", "");

  renderFeed();
  renderTable();

  // Tick the "ago" labels once a second
  setInterval(() => renderTable(), 1000);
}

main().catch((err) => {
  console.error("HotSpot startup failed:", err);
  if (titlebarStatusEl) {
    titlebarStatusEl.textContent = "Error";
    titlebarStatusEl.className = "bad";
  }
});
