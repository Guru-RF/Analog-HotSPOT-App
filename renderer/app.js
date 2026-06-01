"use strict";

/**
 * HotSpot — Renderer
 *
 * BLE GATT client for the hotspot's Feed / DTMF / Command / Status characteristics,
 * plus a WSS reflector feed for the live talker/node map, and a tabbed UI
 * (Home / Map / Info / Reflector) ported from the Flutter mobile app.
 *
 * Feed JSON fields (Analog-HotSPOT-SVXLink/BLE.md):
 *   ip, cs, fq, ctx, tg, tk, ltk, tx, rx, sg, rf, mt, ct
 */

// ── BLE UUIDs ─────────────────────────────────────────────────────────────────
const BLE_SVC_UUID    = "6b1d6a10-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_WRITE_UUID  = "6b1d6a11-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_STATUS_UUID = "6b1d6a12-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_CMD_UUID    = "6b1d6a13-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_FEED_UUID   = "6b1d6a14-c50f-4d86-a7f3-7f2a3a1b2c3d";
const BLE_CCCD_UUID   = "00002902-0000-1000-8000-00805f9b34fb";

const HISTORY_KEY        = "ahs-app-talker-history-v1";
const BLE_LAST_DEVICE    = "ahs-app-ble-last-device";
const SCREEN_KEY         = "ahs-app-screen";

// Reflector / portal constants — match Flutter mobile app constants.dart.
const TG_REFRESH_INTERVAL_MS    = 8 * 60 * 60 * 1000; // 8 h
const REFLECTOR_RECONNECT_MS    = 15 * 1000;
const REFLECTOR_SNAPSHOT_TO_MS  = 7 * 1000;
const REFLECTOR_SESSION_LIMIT   = 200;
const DEFAULT_HOME_RADIUS_KM    = 150;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const titleEl = document.getElementById("title");
const titlebarStatusEl = document.getElementById("titlebar-status");
const tbody = document.getElementById("tbody");
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

const reflectorStatusEl = document.getElementById("reflector-status");
const reflectorTbody = document.getElementById("reflector-tbody");

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  cfg: null,
  feed: {},
  history: [],
  currentSession: null,
  historyLimit: 50,
  talkgroupInfo: {},
  bleConnected: false,
  activeScreen: "home",
  // WSS reflector feed
  reflector: {
    domain: "",
    enabled: false,
    available: false,
    nodes: new Map(),      // callsign → ReflectorNode
    sessions: new Map(),   // session.id → ReflectorSession
  },
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
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m${rs}s` : `${m}m`;
}

// Strip scheme + path + port, lower-case, prepend `reflector.` if needed.
function normalizeReflectorHost(input) {
  let h = String(input || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("wss://")) h = h.slice(6);
  if (h.startsWith("ws://"))  h = h.slice(5);
  if (h.startsWith("https://")) h = h.slice(8);
  if (h.startsWith("http://"))  h = h.slice(7);
  const slash = h.indexOf("/");
  if (slash >= 0) h = h.slice(0, slash);
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  const comma = h.indexOf(",");
  if (comma >= 0) h = h.slice(0, comma);
  if (!h) return "";
  if (h.startsWith("reflector.")) return h;
  return `reflector.${h}`;
}

// Same input as above, but yields the canonical portal.<domain> host used for
// the talkgroups.json probe and auto-update.
function portalHostFor(input) {
  let h = String(input || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("wss://"))   h = h.slice(6);
  if (h.startsWith("ws://"))    h = h.slice(5);
  if (h.startsWith("https://")) h = h.slice(8);
  if (h.startsWith("http://"))  h = h.slice(7);
  const slash = h.indexOf("/");
  if (slash >= 0) h = h.slice(0, slash);
  if (h.startsWith("portal.")) return h;
  if (h.startsWith("reflector.")) h = h.slice("reflector.".length);
  return `portal.${h}`;
}

function portalTalkgroupsUrlFor(domain) {
  const host = portalHostFor(domain);
  return host ? `https://${host}/talkgroups.json` : "";
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

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
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
    closeCurrentSession(now);
    state.currentSession = { cs: nextTk, tg, fq, startedAt: now, endedAt: null };
    state.history.unshift(state.currentSession);
    trimHistory();
    saveHistory();
  } else if (!nextTk && prevTk && state.currentSession) {
    closeCurrentSession(now);
    saveHistory();
  } else if (nextTk && state.currentSession && state.currentSession.cs === nextTk) {
    state.currentSession.tg = tg || state.currentSession.tg;
    state.currentSession.fq = fq || state.currentSession.fq;
  }

  // Seed a historical entry from `ltk` on initial snapshot (no live session yet).
  if (!state.currentSession && nextLtk) {
    const top = state.history[0];
    if (!top || top.cs !== nextLtk) {
      state.history.unshift({
        cs: nextLtk, tg, fq,
        startedAt: now, endedAt: now,
        historical: true,
      });
      trimHistory();
      saveHistory();
    }
  }

  // If the hotspot advertises its reflector domain via `rf` and the user
  // hasn't pinned one in Settings, auto-adopt + probe.
  maybeAdoptReflectorFromFeed((json.rf || "").toString().trim());

  renderFeed();
  renderTable();
  renderInfo();
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

// Parse `mt` raw — e.g. "8++, 23+, 50" → ["8","23","50"] (strips priority `+`).
function parseMonitoredTgs(mt) {
  if (!mt) return [];
  return String(mt)
    .split(",")
    .map((s) => s.trim().replace(/\++$/, ""))
    .filter(Boolean);
}

// Parse `ct` raw — e.g. "67.0:8400,69.3:8" → [{ctcss:"67.0", tg:"8400"}, …]
function parseCtcssMappings(ct) {
  if (!ct) return [];
  const out = [];
  for (const pair of String(ct).split(",")) {
    const parts = pair.trim().split(":");
    if (parts.length !== 2) continue;
    const c = parts[0].trim();
    const t = parts[1].trim();
    if (!c || !t) continue;
    out.push({ ctcss: c, tg: t });
  }
  return out;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function updateSignalMeter(sg) {
  const meter = document.getElementById("signal-meter");
  if (!meter) return;
  if (sg === "" || sg == null) { meter.style.display = "none"; return; }
  const dbm = Number(sg);
  if (!Number.isFinite(dbm)) { meter.style.display = "none"; return; }
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
  hsCsEl.textContent = f.cs || "—";
  hsFqEl.textContent = f.fq ? `${f.fq} MHz` : "—";
  hsTgEl.textContent = f.tg || "—";
  hsIpEl.textContent = f.ip || "—";

  const tk = (f.tk || "").toString().trim();
  const ltk = (f.ltk || "").toString().trim();
  const talking = !!tk;

  hsTkEl.textContent = tk || (ltk ? `${ltk} (last)` : "—");
  hsActiveEl.classList.toggle("talking", talking);

  flagRxEl.classList.toggle("on", Number(f.rx) === 1);
  flagRxEl.classList.toggle("rx", Number(f.rx) === 1);
  flagTxEl.classList.toggle("on", Number(f.tx) === 1);
  flagTxEl.classList.toggle("tx", Number(f.tx) === 1);

  updateSignalMeter(f.sg);

  const active = (f.tg || "").toString().trim();
  document.querySelectorAll("#tg-bar-buttons .tg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tg === active);
  });
}

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

  renderFeed();
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
        : s.historical ? "—" : durationLabel((s.endedAt || now) - s.startedAt);
      const heard = active ? `<span class="timeNow">Now</span>` : msAgoLabel(now - (s.endedAt || s.startedAt));
      const tg = s.tg ? escapeHtml(s.tg) : "—";
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

// ── Info screen rendering ─────────────────────────────────────────────────────
function signalLabel(dbm) {
  if (!Number.isFinite(dbm)) return "—";
  if (dbm === 0) return "Searching…";
  let bars;
  if (dbm >= -70)      bars = "excellent";
  else if (dbm >= -85) bars = "good";
  else if (dbm >= -100) bars = "fair";
  else if (dbm >= -110) bars = "weak";
  else                  bars = "very poor";
  return `${dbm} dBm · ${bars}`;
}

function renderInfo() {
  const grid = document.getElementById("info-grid");
  const hint = document.getElementById("info-hint");
  if (!grid) return;
  const f = state.feed || {};
  const tiles = [
    { icon: "📻", label: "Callsign",    value: f.cs || "—", mono: false, copyable: false },
    { icon: "📈", label: "Frequency",   value: f.fq ? `${f.fq} MHz` : "—" },
    { icon: "👥", label: "Talkgroup",   value: f.tg || "—" },
    { icon: "🌐", label: "IP address",  value: f.ip || "—", mono: true, copyable: !!f.ip },
    { icon: "🛰️", label: "Reflector",   value: f.rf || "—", mono: true, copyable: !!f.rf },
  ];
  if (f.sg != null && f.sg !== "") {
    tiles.push({ icon: "📶", label: "4G signal", value: signalLabel(Number(f.sg)) });
  }
  if (f.ctx) tiles.push({ icon: "🔉", label: "Output CTCSS", value: `${f.ctx} Hz` });

  grid.innerHTML = tiles
    .map((t) => `
      <div class="info-tile">
        <span class="info-tile-icon">${t.icon}</span>
        <div class="info-tile-body">
          <span class="info-tile-label">${escapeHtml(t.label)}</span>
          <span class="info-tile-value${t.mono ? " mono" : ""}">${escapeHtml(t.value)}</span>
        </div>
        ${t.copyable ? `<button class="info-copy" data-copy="${escapeHtml(t.value)}" title="Copy">⧉</button>` : ""}
      </div>`)
    .join("");

  // Monitored TGs
  const mts = parseMonitoredTgs(f.mt);
  const mtCard = document.getElementById("info-monitored");
  const mtChips = document.getElementById("info-mt-chips");
  if (mts.length) {
    mtCard.style.display = "";
    mtChips.innerHTML = mts.map((tg) => {
      const label = state.talkgroupInfo[tg] || "";
      const title = label ? `TG ${tg} · ${label}` : `TG ${tg}`;
      return `<span class="info-chip" title="${escapeHtml(title)}">${escapeHtml(tg)}</span>`;
    }).join("");
  } else {
    mtCard.style.display = "none";
  }

  // CTCSS mappings
  const mappings = parseCtcssMappings(f.ct);
  const ctCard = document.getElementById("info-ctcss");
  const ctRows = document.getElementById("info-ctcss-rows");
  if (mappings.length) {
    ctCard.style.display = "";
    ctRows.innerHTML = mappings.map((m) => {
      const label = state.talkgroupInfo[m.tg];
      const tgLabel = label ? `TG ${m.tg} · ${label}` : `TG ${m.tg}`;
      return `<div class="info-ctcss-row"><span class="mono">${escapeHtml(m.ctcss)} Hz</span><span>→</span><span>${escapeHtml(tgLabel)}</span></div>`;
    }).join("");
  } else {
    ctCard.style.display = "none";
  }

  if (hint) hint.style.display = state.bleConnected ? "none" : "";
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

  // Always offer a way to scan when we're not connected — saved or not. On a
  // fresh install with no saved name we'd otherwise have no manual entry point
  // now that Settings lives in its own window.
  const quick = document.getElementById("btn-ble-quickconnect");
  if (quick) {
    const saved = getSavedDeviceName();
    quick.style.display = connected ? "none" : "";
    quick.title = saved ? `Reconnect to ${saved}` : "Scan for HotSpot";
  }

  const bar = document.getElementById("dtmf-bar");
  if (bar) bar.style.display = connected ? "" : "none";

  const connectBtn = document.getElementById("btn-ble-connect");
  const disconnectBtn = document.getElementById("btn-ble-disconnect");
  if (connectBtn) connectBtn.style.display = connected ? "none" : "";
  if (disconnectBtn) disconnectBtn.style.display = connected ? "" : "none";

  if (!connected) {
    state.feed = {};
    renderFeed();
    renderInfo();
    updateSignalMeter("");
  }
  updateTray();

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

function startKeepalive() {
  stopKeepalive();
  ble.keepaliveTimer = setInterval(async () => {
    const ch = ble.statusChar;
    const dev = ble.device;
    if (!dev?.gatt?.connected || !ch) return;
    try {
      const cccd = await ch.getDescriptor(BLE_CCCD_UUID);
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
  setBleStatus("Reconnecting…", "connecting");
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

  tgBarButtonsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest(".tg-btn[data-tg]");
    if (!btn) return;
    const tg = btn.dataset.tg;
    if (!tg) return;
    bleSendDTMF(`91${tg}#`);
  });
}

// ── Reflector WSS feed ────────────────────────────────────────────────────────
// Ports lib/services/reflector_feed.dart. Connects to wss://reflector.<domain>/,
// processes snapshot / node_upsert / talk_start / talk_stop frames, exposes
// nodes + sessions via state.reflector.
const reflectorFeed = {
  ws: null,
  snapshotTimer: null,
  reconnectTimer: null,
  gotSnapshot: false,
  disposed: false,
};

function setReflectorAvailable(v) {
  if (state.reflector.available === v) return;
  state.reflector.available = v;
  renderReflectorScreen();
  renderMap();
}

function reflectorReset() {
  reflectorFeed.gotSnapshot = false;
  if (reflectorFeed.reconnectTimer) { clearTimeout(reflectorFeed.reconnectTimer); reflectorFeed.reconnectTimer = null; }
  if (reflectorFeed.snapshotTimer)  { clearTimeout(reflectorFeed.snapshotTimer);  reflectorFeed.snapshotTimer = null; }
  if (reflectorFeed.ws) {
    try { reflectorFeed.ws.close(1000); } catch (_) {}
    reflectorFeed.ws = null;
  }
  state.reflector.nodes.clear();
  state.reflector.sessions.clear();
  setReflectorAvailable(false);
  renderReflectorScreen();
  renderMap();
}

function reflectorSetDomain(domain, enabled) {
  const d = String(domain || "").trim();
  const next = !!enabled;
  // Idempotent — applyConfig() is invoked on every settings:changed
  // broadcast (which the TG auto-update also fires), and a stale "reset +
  // reconnect" would kick a healthy WSS off its already-open connection,
  // looping forever on transient close codes.
  if (d === state.reflector.domain && next === state.reflector.enabled) return;
  state.reflector.domain = d;
  state.reflector.enabled = next;
  reflectorReset();
  if (!d || !next) return;
  reflectorConnect();
}

function reflectorConnect() {
  if (reflectorFeed.disposed) return;
  if (!state.reflector.domain || !state.reflector.enabled) return;

  const host = normalizeReflectorHost(state.reflector.domain);
  if (!host) { setReflectorAvailable(false); return; }

  let ws;
  try {
    ws = new WebSocket(`wss://${host}/`);
  } catch (_) {
    reflectorScheduleReconnect();
    return;
  }
  reflectorFeed.ws = ws;

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let obj;
    try { obj = JSON.parse(ev.data); } catch (_) { return; }
    if (!obj || typeof obj !== "object") return;
    const type = String(obj.type || "");
    if      (type === "snapshot")    reflectorHandleSnapshot(obj);
    else if (type === "node_upsert") reflectorHandleNodeUpsert(obj.node);
    else if (type === "talk_start" || type === "talk_stop") reflectorHandleTalkEvent(obj.session);
  };
  ws.onerror = () => reflectorScheduleReconnect();
  ws.onclose = () => reflectorScheduleReconnect();

  if (reflectorFeed.snapshotTimer) clearTimeout(reflectorFeed.snapshotTimer);
  reflectorFeed.snapshotTimer = setTimeout(() => {
    if (!reflectorFeed.gotSnapshot) {
      setReflectorAvailable(false);
      reflectorScheduleReconnect();
    }
  }, REFLECTOR_SNAPSHOT_TO_MS);
}

function reflectorScheduleReconnect() {
  if (reflectorFeed.disposed) return;
  if (!state.reflector.domain || !state.reflector.enabled) return;
  if (!reflectorFeed.gotSnapshot) setReflectorAvailable(false);
  if (reflectorFeed.ws) {
    try { reflectorFeed.ws.close(); } catch (_) {}
    reflectorFeed.ws = null;
  }
  if (reflectorFeed.reconnectTimer) clearTimeout(reflectorFeed.reconnectTimer);
  reflectorFeed.reconnectTimer = setTimeout(reflectorConnect, REFLECTOR_RECONNECT_MS);
}

function numOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function intOrZero(v) {
  const n = numOrNull(v);
  return n == null ? 0 : Math.trunc(n);
}

function parseReflectorNode(d) {
  if (!d || typeof d !== "object") return null;
  const cs = String(d.callsign || "").trim();
  if (!cs) return null;
  const monitored = [];
  if (Array.isArray(d.monitoredTGs)) {
    for (const v of d.monitoredTGs) {
      const n = numOrNull(v);
      if (n != null) monitored.push(Math.trunc(n));
    }
  }
  return {
    callsign: cs.toUpperCase(),
    online: d.online === true,
    isTalker: d.isTalker === true,
    tg: intOrZero(d.tg),
    monitoredTGs: monitored,
    location: String(d.location || ""),
    lat: numOrNull(d.lat),
    lon: numOrNull(d.lon),
  };
}

function parseReflectorSession(d) {
  if (!d || typeof d !== "object") return null;
  const cs = String(d.callsign || "").trim();
  if (!cs) return null;
  const startMs = intOrZero(d.start_ms);
  const hasEnd = ("end_ms" in d) && d.end_ms != null;
  const endMs = hasEnd ? intOrZero(d.end_ms) : null;
  const active = ("active" in d) ? d.active === true : endMs == null;
  let loc = "", tg = 0;
  if (d.node && typeof d.node === "object") {
    loc = String(d.node.nodeLocation || "");
    tg = intOrZero(d.node.tg);
  }
  return {
    id: `${cs.toUpperCase()}-${startMs}`,
    callsign: cs.toUpperCase(),
    startMs,
    endMs: active ? null : endMs,
    location: loc,
    tg,
    isActive: active,
    lastActivityMs: endMs ?? startMs,
  };
}

// Pull lat/lon out of session.node.qth (mobile model: lat / long not lon).
function extractSessionGeo(session) {
  if (!session || typeof session !== "object") return { lat: null, lon: null };
  let nodeObj = null, qth = null;
  if (session.node && typeof session.node === "object") nodeObj = session.node;
  if (nodeObj && nodeObj.qth && typeof nodeObj.qth === "object") qth = nodeObj.qth;
  else if (session.qth && typeof session.qth === "object") qth = session.qth;
  const lat = numOrNull(qth?.lat) ?? numOrNull(nodeObj?.lat) ?? numOrNull(session.lat);
  const lon = numOrNull(qth?.long) ?? numOrNull(qth?.lon) ?? numOrNull(nodeObj?.lon) ?? numOrNull(session.lon);
  return { lat, lon };
}

function mergeReflectorNode(existing, incoming, raw) {
  if (!existing) return incoming;
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] != null;
  return {
    callsign: incoming.callsign,
    online:   has("online")   ? incoming.online   : existing.online,
    isTalker: has("isTalker") ? incoming.isTalker : existing.isTalker,
    tg:       has("tg")       ? incoming.tg       : existing.tg,
    monitoredTGs: has("monitoredTGs") ? incoming.monitoredTGs : existing.monitoredTGs,
    location: has("location") ? incoming.location : existing.location,
    lat: incoming.lat ?? existing.lat,
    lon: incoming.lon ?? existing.lon,
  };
}

function reflectorHandleSnapshot(obj) {
  reflectorFeed.gotSnapshot = true;
  if (reflectorFeed.snapshotTimer) { clearTimeout(reflectorFeed.snapshotTimer); reflectorFeed.snapshotTimer = null; }
  state.reflector.nodes.clear();
  state.reflector.sessions.clear();

  const nodesArr = obj.nodes;
  if (Array.isArray(nodesArr)) {
    for (const n of nodesArr) {
      const node = parseReflectorNode(n);
      if (node) state.reflector.nodes.set(node.callsign, node);
    }
  }
  for (const key of ["sessions", "active"]) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      const session = parseReflectorSession(s);
      if (session) state.reflector.sessions.set(session.id, session);
      // Synthesize a node when the session arrived without one (AI callsigns).
      if (session && !state.reflector.nodes.has(session.callsign)) {
        const geo = extractSessionGeo(s);
        if (geo.lat != null && geo.lon != null) {
          state.reflector.nodes.set(session.callsign, {
            callsign: session.callsign,
            online: true,
            isTalker: session.isActive,
            tg: session.tg,
            monitoredTGs: [],
            location: session.location,
            lat: geo.lat,
            lon: geo.lon,
          });
        }
      }
    }
  }
  setReflectorAvailable(true);
  renderReflectorScreen();
  renderMap();
}

function reflectorHandleNodeUpsert(data) {
  if (!data || typeof data !== "object") return;
  const node = parseReflectorNode(data);
  if (!node) return;
  const existing = state.reflector.nodes.get(node.callsign);
  state.reflector.nodes.set(node.callsign, mergeReflectorNode(existing, node, data));
  renderReflectorScreen();
  renderMap();
}

function reflectorHandleTalkEvent(data) {
  if (!data || typeof data !== "object") return;
  const session = parseReflectorSession(data);
  if (!session) return;
  state.reflector.sessions.set(session.id, session);
  // Cap memory.
  if (state.reflector.sessions.size > REFLECTOR_SESSION_LIMIT * 3) {
    const sorted = sortedReflectorSessions();
    state.reflector.sessions.clear();
    for (const s of sorted.slice(0, REFLECTOR_SESSION_LIMIT)) {
      state.reflector.sessions.set(s.id, s);
    }
  }
  renderReflectorScreen();
}

function sortedReflectorSessions() {
  const list = Array.from(state.reflector.sessions.values());
  list.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.lastActivityMs - a.lastActivityMs;
  });
  return list.slice(0, REFLECTOR_SESSION_LIMIT);
}

function renderReflectorScreen() {
  if (!reflectorStatusEl || !reflectorTbody) return;
  const enabled = state.reflector.enabled;
  const domain = state.reflector.domain;
  const avail = state.reflector.available;

  if (!domain || !enabled) {
    reflectorStatusEl.textContent = "Reflector feed disabled. Add a reflector domain in Settings.";
    reflectorStatusEl.className = "reflector-status";
    reflectorTbody.innerHTML = "";
    return;
  }
  if (!avail) {
    reflectorStatusEl.textContent = `Connecting to reflector.${normalizeReflectorHost(domain).replace(/^reflector\./, "")}…`;
    reflectorStatusEl.className = "reflector-status connecting";
  } else {
    reflectorStatusEl.textContent = `Live — ${state.reflector.nodes.size} nodes`;
    reflectorStatusEl.className = "reflector-status connected";
  }

  const sessions = sortedReflectorSessions();
  if (sessions.length === 0) {
    reflectorTbody.innerHTML = `<tr class="emptyRow"><td colspan="6">No talkers on the reflector right now.</td></tr>`;
    return;
  }
  const now = Date.now();
  reflectorTbody.innerHTML = sessions.map((s) => {
    const active = s.isActive;
    const dotCls = active ? "dotOnline" : "dotOffline";
    const dur = active ? `<span class="timeNow">Now</span>`
                       : durationLabel((s.endMs ?? now) - s.startMs);
    const heard = active ? `<span class="timeNow">Now</span>`
                         : msAgoLabel(now - (s.endMs ?? s.startMs));
    const tgLabel = s.tg ? `TG ${s.tg}` : "—";
    return `
      <tr class="${active ? "talkingRow" : ""}">
        <td class="narrow center"><span class="${dotCls}"></span></td>
        <td><strong>${escapeHtml(s.callsign)}</strong></td>
        <td>${escapeHtml(tgLabel)}</td>
        <td>${escapeHtml(s.location || "—")}</td>
        <td class="center">${dur}</td>
        <td class="center">${heard}</td>
      </tr>`;
  }).join("");
}

// ── Talkgroups portal probe / auto-update ─────────────────────────────────────
let tgUpdateTimer = null;

async function fetchTalkgroupsFromUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || typeof json !== "object") return null;
    const out = {};
    for (const [k, v] of Object.entries(json)) {
      const key = String(k).trim();
      if (key) out[key] = String(v ?? "");
    }
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

async function probeReflectorWss(domain) {
  // We can't do a raw HTTP Upgrade probe from a renderer without CORS issues,
  // so we attempt an actual WebSocket open with a short timeout instead.
  const host = normalizeReflectorHost(domain);
  if (!host) return false;
  return await new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (ok) => { if (done) return; done = true; try { ws && ws.close(); } catch (_) {} resolve(ok); };
    try { ws = new WebSocket(`wss://${host}/`); } catch (_) { return resolve(false); }
    ws.onopen  = () => finish(true);
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
    setTimeout(() => finish(false), 4000);
  });
}

// Schedule talkgroup auto-refresh — fires immediately, then every 8 h.
function rescheduleTgAutoUpdate() {
  if (tgUpdateTimer) { clearInterval(tgUpdateTimer); tgUpdateTimer = null; }
  const cfg = state.cfg || {};
  if (!cfg.tgAutoUpdate) return;
  const url = (cfg.tgUpdateUrl || "").trim() || portalTalkgroupsUrlFor(cfg.reflectorDomain || "");
  if (!url) return;
  const tick = async () => {
    const fetched = await fetchTalkgroupsFromUrl(url);
    if (!fetched || !Object.keys(fetched).length) return;
    // Only persist when the data actually changed — otherwise we get
    // settings:changed → applyConfig → rescheduleTgAutoUpdate → tick →
    // save again, churning the WSS connection and re-fetching forever.
    const before = JSON.stringify(state.talkgroupInfo || {});
    const after = JSON.stringify(fetched);
    state.talkgroupInfo = fetched;
    state.cfg = { ...state.cfg, talkgroupInfo: fetched };
    renderTgBar();
    renderInfo();
    refreshTrayTgs();
    if (before !== after) {
      window.api.saveSettings({ talkgroupInfo: fetched }).catch(() => {});
    }
  };
  tick();
  tgUpdateTimer = setInterval(tick, TG_REFRESH_INTERVAL_MS);
}

// When the hotspot exposes its reflector domain via `rf` and the user hasn't
// configured one yet, adopt it silently and start probing.
function maybeAdoptReflectorFromFeed(rfDomain) {
  if (!rfDomain) return;
  const cfg = state.cfg || {};
  if (cfg.reflectorDomain) return;
  state.cfg = { ...state.cfg, reflectorDomain: rfDomain };
  window.api.saveSettings({ reflectorDomain: rfDomain }).catch(() => {});
  reflectorSetDomain(rfDomain, cfg.wssEnabled !== false);
  if (state.cfg.tgAutoUpdate) rescheduleTgAutoUpdate();
}

// ── Screen navigation ─────────────────────────────────────────────────────────
function showScreen(name) {
  if (!["home", "map", "info", "reflector"].includes(name)) name = "home";
  state.activeScreen = name;
  try { localStorage.setItem(SCREEN_KEY, name); } catch {}
  document.querySelectorAll(".screen").forEach((el) => {
    el.dataset.active = el.id === `screen-${name}` ? "true" : "false";
  });
  document.querySelectorAll("#tabbar .tab").forEach((el) => {
    const active = el.dataset.screen === name;
    el.classList.toggle("active", active);
    el.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (name === "map") ensureMap();
  if (name === "info") renderInfo();
  if (name === "reflector") renderReflectorScreen();
}

function initTabBar() {
  document.querySelectorAll("#tabbar .tab").forEach((tab) => {
    tab.addEventListener("click", () => showScreen(tab.dataset.screen));
  });
  let saved = "home";
  try { saved = localStorage.getItem(SCREEN_KEY) || "home"; } catch {}
  showScreen(saved);
}

// ── Map (Leaflet) ─────────────────────────────────────────────────────────────
const mapState = {
  map: null,
  markersLayer: null,
  homeMarker: null,
  initialized: false,
};

const NODE_COLOR_TALKER  = "#D92929";
const NODE_COLOR_SUFFIX  = "#2D9CDB";
const NODE_COLOR_OFFLINE = "#8C8C8C";
const NODE_COLOR_REPEATER = "#36C58D";
const NODE_COLOR_NODE    = "#FFA600";

function nodeColor(n) {
  if (n.isTalker) return NODE_COLOR_TALKER;
  if (!n.online) return NODE_COLOR_OFFLINE;
  if (n.callsign.includes("/")) return NODE_COLOR_SUFFIX;
  if (n.callsign.startsWith("ON0")) return NODE_COLOR_REPEATER;
  return NODE_COLOR_NODE;
}

function ensureMap() {
  if (mapState.initialized) { setTimeout(() => mapState.map.invalidateSize(), 50); return; }
  if (typeof L === "undefined") return;
  const host = document.getElementById("map-host");
  if (!host) return;
  mapState.map = L.map(host, {
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
  }).setView([50.85, 4.35], 6); // Brussels-ish default
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(mapState.map);
  mapState.markersLayer = L.layerGroup().addTo(mapState.map);
  mapState.initialized = true;

  // refitMap() handles the "open map while someone is already qualified"
  // case — it zooms to the talker(s) instead of dropping you back at home.
  refitMap();
  renderMap();
}

function setHomeLatLng(lat, lng, persist) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  state.cfg = { ...state.cfg, homeLat: lat, homeLng: lng };
  if (persist) window.api.saveSettings({ homeLat: lat, homeLng: lng }).catch(() => {});
  updateHomeMarker();
  document.getElementById("btn-map-center")?.removeAttribute("disabled");
}

function updateHomeMarker() {
  if (!mapState.map) return;
  const lat = Number(state.cfg?.homeLat);
  const lng = Number(state.cfg?.homeLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    if (mapState.homeMarker) { mapState.map.removeLayer(mapState.homeMarker); mapState.homeMarker = null; }
    return;
  }
  if (mapState.homeMarker) {
    mapState.homeMarker.setLatLng([lat, lng]);
  } else {
    const icon = L.divIcon({
      className: "home-marker",
      html: `<div class="home-dot"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    mapState.homeMarker = L.marker([lat, lng], { icon, title: "Home QTH", zIndexOffset: 1000 }).addTo(mapState.map);
  }
}

function fitMapInitial() {
  if (!mapState.map) return;
  const lat = Number(state.cfg?.homeLat);
  const lng = Number(state.cfg?.homeLng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    fitToHome(lat, lng, Number(state.cfg?.homeRadiusKm) || DEFAULT_HOME_RADIUS_KM);
    updateHomeMarker();
    document.getElementById("btn-map-center")?.removeAttribute("disabled");
    return;
  }
  // Else: try fit-to-nodes once nodes arrive.
  const geoNodes = Array.from(state.reflector.nodes.values()).filter((n) => n.lat != null && n.lon != null);
  if (geoNodes.length) {
    const bounds = L.latLngBounds(geoNodes.map((n) => [n.lat, n.lon]));
    mapState.map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function fitToHome(lat, lng, radiusKm) {
  if (!mapState.map) return;
  const dLat = radiusKm / 111.32;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLng = radiusKm / (111.32 * Math.max(Math.abs(cosLat), 1e-6));
  const bounds = L.latLngBounds([lat - dLat, lng - dLng], [lat + dLat, lng + dLng]);
  mapState.map.fitBounds(bounds, { padding: [40, 40] });
}

// ── Talker map auto-zoom (matches SVXConnect-iOS) ─────────────────────────
// A station has to be on-air for 1.5 s before its location earns a camera
// move — short PTT hits don't drag the map around. When the qualified set
// changes, the camera re-fits to all qualified talkers (~20 km radius for
// a single station, bounding box for multiple) and returns to the home
// view once everyone has dropped.
const TALKER_QUALIFY_MS = 1500;
const TALKER_ZOOM_RADIUS_KM = 20;
const talkerQual = new Map(); // callsign → { timer, qualified }

function collectQualifiedTalkers() {
  const out = [];
  for (const [cs, q] of talkerQual) {
    if (!q.qualified) continue;
    const n = state.reflector.nodes.get(cs);
    if (n && n.lat != null && n.lon != null) out.push(n);
  }
  return out;
}

function fitToTalkers(talkers) {
  if (!mapState.map || !talkers.length) return;
  if (talkers.length === 1) {
    fitToHome(talkers[0].lat, talkers[0].lon, TALKER_ZOOM_RADIUS_KM);
    return;
  }
  const bounds = L.latLngBounds(talkers.map((n) => [n.lat, n.lon]));
  mapState.map.fitBounds(bounds, { padding: [40, 40] });
}

function refitMap() {
  if (!mapState.map) return;
  const qualified = collectQualifiedTalkers();
  if (qualified.length) fitToTalkers(qualified);
  else fitMapInitial();
}

function updateTalkerQualifications() {
  const active = new Set();
  for (const n of state.reflector.nodes.values()) {
    if (n.isTalker && n.lat != null && n.lon != null) active.add(n.callsign);
  }
  // Drop entries for stations that stopped — and remember if any of them
  // were already qualified, because losing a qualified talker means the
  // camera should re-fit (back to home if the qualified set is now empty).
  let droppedQualified = false;
  for (const [cs, q] of talkerQual) {
    if (active.has(cs)) continue;
    if (q.timer) clearTimeout(q.timer);
    if (q.qualified) droppedQualified = true;
    talkerQual.delete(cs);
  }
  // Arm a 1.5 s qualifier on newly-active stations. If they're still on
  // the air when the timer fires, mark them qualified and re-fit.
  for (const cs of active) {
    if (talkerQual.has(cs)) continue;
    const entry = { timer: null, qualified: false };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const n = state.reflector.nodes.get(cs);
      if (!n || !n.isTalker) return;
      entry.qualified = true;
      refitMap();
    }, TALKER_QUALIFY_MS);
    talkerQual.set(cs, entry);
  }
  if (droppedQualified) refitMap();
}

// Classify a reflector node into a SVXConnect-iOS badge type.
//   - AI       — callsign contains "/" (slash-suffixed mobile/portable; the
//                feed always reports these offline so this check sits ABOVE
//                the offline branch).
//   - OFFLINE  — node.online === false and not slash-suffixed.
//   - REPEATER — callsign starts with "ON0" (Belgian repeater convention).
//   - NODE     — everything else.
function nodeBadge(n) {
  if (n.callsign.includes("/"))   return { label: "AI",       bg: "#2D9CDB" };
  if (!n.online)                  return { label: "OFFLINE",  bg: "#8C8C8C" };
  if (n.callsign.startsWith("ON0")) return { label: "REPEATER", bg: "#36C58D" };
  return { label: "NODE", bg: "#FFA600" };
}

function renderMap() {
  // Talker qualification runs even when the map view hasn't been opened
  // yet — that way, by the time the user switches to the Map tab, the
  // 1.5 s timers already reflect what's on the air.
  updateTalkerQualifications();
  if (!mapState.map || !mapState.markersLayer) return;
  mapState.markersLayer.clearLayers();
  const nodes = Array.from(state.reflector.nodes.values()).filter((n) => n.lat != null && n.lon != null);
  for (const n of nodes) {
    const isTalker = !!n.isTalker;
    const color = nodeColor(n);
    const size = isTalker ? 16 : 10;
    const marker = L.circleMarker([n.lat, n.lon], {
      radius: size / 2,
      color,
      fillColor: color,
      fillOpacity: isTalker ? 0.95 : 0.85,
      weight: isTalker ? 2 : 1,
    });
    const monitored = n.monitoredTGs?.length ? `Monitors: ${n.monitoredTGs.join(", ")}` : "";
    const badge = nodeBadge(n);
    const badgeHtml = `<span class="map-badge" style="background:${badge.bg}">${badge.label}</span>`;
    const talkingHtml = isTalker ? `<span class="map-badge map-badge-talking">TALKING</span>` : "";
    const tgLabel = n.tg && state.talkgroupInfo[String(n.tg)] ? ` — ${escapeHtml(state.talkgroupInfo[String(n.tg)])}` : "";
    const html = `
      <div class="map-popup">
        <div class="map-popup-head">
          <span class="map-popup-cs">${escapeHtml(n.callsign)}</span>
          ${badgeHtml}${talkingHtml}
        </div>
        ${n.location ? `<div class="map-popup-loc">${escapeHtml(n.location)}</div>` : ""}
        ${n.tg ? `<div class="map-popup-tg">TG ${n.tg}${tgLabel}</div>` : ""}
        ${monitored ? `<div class="map-popup-mt">${escapeHtml(monitored)}</div>` : ""}
      </div>`;
    marker.bindPopup(html);
    marker.addTo(mapState.markersLayer);
  }
  updateHomeMarker();
}

function initMapButtons() {
  document.getElementById("btn-map-home")?.addEventListener("click", async () => {
    if (!navigator.geolocation) {
      const hint = document.getElementById("map-hint");
      if (hint) hint.textContent = "Geolocation unavailable — set the address in Settings.";
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setHomeLatLng(pos.coords.latitude, pos.coords.longitude, true);
        fitToHome(pos.coords.latitude, pos.coords.longitude, Number(state.cfg?.homeRadiusKm) || DEFAULT_HOME_RADIUS_KM);
      },
      (err) => {
        const hint = document.getElementById("map-hint");
        if (hint) hint.textContent = `No GPS fix (${err.message || "denied"}). Set the address in Settings.`;
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  });
  document.getElementById("btn-map-center")?.addEventListener("click", () => {
    const lat = Number(state.cfg?.homeLat);
    const lng = Number(state.cfg?.homeLng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      fitToHome(lat, lng, Number(state.cfg?.homeRadiusKm) || DEFAULT_HOME_RADIUS_KM);
    }
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

  // Update pill — main process polls GitHub daily and pushes this event
  // when a newer release tag is available. Click opens the download page.
  const updateBtn = document.getElementById("btn-update");
  const updateLabel = document.getElementById("update-pill-label");
  window.api.onUpdateAvailable?.((info) => {
    if (!updateBtn) return;
    if (updateLabel) updateLabel.textContent = `v${info.version} available`;
    updateBtn.title = `New version ${info.version} — click to open ${info.url || "the download page"}`;
    updateBtn.style.display = "";
  });
  updateBtn?.addEventListener("click", () => window.api.openUpdateUrl?.());
}

// ── Settings ──────────────────────────────────────────────────────────────────
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
  applyTheme(cfg.theme !== "light");
  state.talkgroupInfo = normalizeTgInfo(cfg.talkgroupInfo || {});
  state.historyLimit = Number(cfg.historyLimit) > 0 ? Number(cfg.historyLimit) : 50;
  renderTgBar();
  refreshTrayTgs();
  renderInfo();
  renderMap();
  renderTable();

  // Reflector / WSS
  reflectorSetDomain(cfg.reflectorDomain || "", cfg.wssEnabled !== false);
  rescheduleTgAutoUpdate();
}

function initSettings() {
  document.getElementById("btn-settings")?.addEventListener("click", () => {
    window.api.openSettingsWindow();
  });
  // Main window listens for save broadcasts so the settings window can stay
  // simple (it just calls saveSettings and closes itself).
  window.api.onSettingsChanged?.((cfg) => applyConfig(cfg));

  // Info copy buttons (delegated).
  document.getElementById("info-grid")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".info-copy[data-copy]");
    if (!btn) return;
    const val = btn.getAttribute("data-copy");
    if (val) navigator.clipboard?.writeText(val).catch(() => {});
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Theme/title/limit are applied via applyConfig() once settings load.
  initTitleBar();
  initTabBar();
  initSettings();
  initBLE();
  initMapButtons();

  try {
    window.api.onSendDtmfRequest?.((dtmf) => bleSendDTMF(dtmf));
  } catch {}

  state.history = loadHistory();

  const cfg = await window.api.loadSettings();
  applyConfig(cfg);

  try { window.api.setPreferredBleName?.(getSavedDeviceName()); } catch {}
  setBleStatus("Not connected", "");

  renderFeed();
  renderTable();
  renderInfo();
  renderReflectorScreen();

  setInterval(() => {
    renderTable();
    if (state.activeScreen === "reflector") renderReflectorScreen();
  }, 1000);
}

main().catch((err) => {
  console.error("HotSpot startup failed:", err);
  if (titlebarStatusEl) {
    titlebarStatusEl.textContent = "Error";
    titlebarStatusEl.className = "bad";
  }
});
