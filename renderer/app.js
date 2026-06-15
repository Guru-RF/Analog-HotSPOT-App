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
// Legacy: advertised name of the last hotspot. Kept only for the friendly
// "(last: <name>)" status string — auto-connect now keys on deviceId.
const BLE_LAST_DEVICE    = "ahs-app-ble-last-device";
// Platform-stable BLE identifier. Survives hotspot rename/reflash.
const BLE_LAST_DEVICE_ID = "ahs-app-ble-last-device-id";
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
// Strip Unicode bidi-control characters that could otherwise flip text
// direction inside the talker table / picker tiles ("RTL override" trick).
// U+202A..U+202E (legacy embedding/override), U+2066..U+2069 (isolates),
// plus the zero-width joiner / non-joiner / BOM / variation selectors that
// can be used for homoglyph-style spoofing.
const BIDI_AND_ZERO_WIDTH = /[​-‏‪-‮⁠-⁩﻿]/g;
function escapeHtml(s) {
  return String(s ?? "")
    .replace(BIDI_AND_ZERO_WIDTH, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Validates that a hostname-only string is safe to use as the host part of a
// wss:// or https:// URL. No schemes, no slashes, no @userinfo, no ports.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
function isSafeHostname(s) {
  if (typeof s !== "string") return false;
  const t = s.trim().toLowerCase();
  if (!t || t.length > 253) return false;
  return HOSTNAME_RE.test(t);
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

// Differential renderer for the last-talkers table. Was previously a wholesale
// innerHTML rebuild every 1 s, which dropped any in-progress text selection,
// allocated ~1 k cell nodes per second forever, and re-parsed all 500 rows of
// HTML on every tick. The keyed approach only touches the cells that actually
// changed (Duration + Heard, plus the dot class when active → ended).
const renderedRows = new Map(); // key → { tr, dur, heard, dot, classes }
const rowKey = (s) => (s.cs || "?") + "|" + (s.startedAt || 0);

function renderTable() {
  if (!tbody) return;
  const limit = state.historyLimit;
  const rows = state.history.slice(0, limit);
  const now = Date.now();

  if (rows.length === 0) {
    if (tbody.firstChild?.classList?.contains("emptyRow")) return;
    tbody.innerHTML = `<tr class="emptyRow"><td colspan="5">No talkers yet.</td></tr>`;
    renderedRows.clear();
    return;
  }

  const seen = new Set();
  // Build the desired order; insert any new rows at the right spot, leave
  // existing rows in place if the order didn't change. innerHTML on the
  // <tr> level only — the <tbody> itself stays the same DOM node so text
  // selection inside an unchanged row survives the tick.
  let prevTr = null;
  for (const s of rows) {
    const key = rowKey(s);
    seen.add(key);
    const active = !s.endedAt && !s.historical;
    const dotCls = active ? "dotOnline" : "dotOffline";
    const dur = active
      ? `<span class="timeNow">Now</span>`
      : s.historical ? "—" : durationLabel((s.endedAt || now) - s.startedAt);
    const heard = active
      ? `<span class="timeNow">Now</span>`
      : msAgoLabel(now - (s.endedAt || s.startedAt));
    const tg = s.tg ? escapeHtml(s.tg) : "—";
    const trClass = active ? "talkingRow" : "";

    let cached = renderedRows.get(key);
    if (!cached) {
      const tr = document.createElement("tr");
      tr.className = trClass;
      tr.innerHTML = `
        <td class="narrow center"><span class="${dotCls}"></span></td>
        <td><strong>${escapeHtml(s.cs)}</strong></td>
        <td>${tg}</td>
        <td class="center">${dur}</td>
        <td class="center">${heard}</td>`;
      cached = {
        tr,
        dotEl: tr.querySelector("td.narrow span"),
        durCell: tr.cells[3],
        heardCell: tr.cells[4],
        tgCell: tr.cells[2],
        signature: dur + "|" + heard + "|" + tg + "|" + trClass,
      };
      renderedRows.set(key, cached);
    } else {
      const sig = dur + "|" + heard + "|" + tg + "|" + trClass;
      if (sig !== cached.signature) {
        if (cached.tr.className !== trClass) cached.tr.className = trClass;
        if (cached.dotEl && cached.dotEl.className !== dotCls) cached.dotEl.className = dotCls;
        if (cached.durCell.innerHTML !== dur) cached.durCell.innerHTML = dur;
        if (cached.heardCell.innerHTML !== heard) cached.heardCell.innerHTML = heard;
        if (cached.tgCell.innerHTML !== tg) cached.tgCell.innerHTML = tg;
        cached.signature = sig;
      }
    }

    const desiredPrev = prevTr ? prevTr.nextSibling : tbody.firstChild;
    if (cached.tr !== desiredPrev) {
      tbody.insertBefore(cached.tr, desiredPrev || null);
    }
    prevTr = cached.tr;
  }

  // Drop rows no longer in view.
  for (const [key, cached] of renderedRows) {
    if (!seen.has(key)) {
      try { cached.tr.remove(); } catch (_) {}
      renderedRows.delete(key);
    }
  }
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
  // True between the moment bleConnect() entered and the requestDevice()
  // promise settled (success or rejection). Prevents a second
  // requestDevice() from going out concurrently — Chromium delivers each
  // chooser callback bound to ONE pending request, so two pending requests
  // means the first callback gets orphaned and its promise hangs forever.
  scanning: false,
  // Monotonic id of the current connection attempt. bleConnect()/
  // bleTryReconnect() each bump this and capture the value; any work whose
  // generation no longer matches must abort (prevents an in-flight
  // bleTryReconnect from overwriting ble.* after bleConnect picked a new
  // device).
  generation: 0,
  // Per-connection AbortController. addEventListener calls signal off this
  // so stale notification handlers from previous reconnects don't pile up.
  abort: null,
};

function getSavedDeviceName() {
  try { return localStorage.getItem(BLE_LAST_DEVICE) || ""; }
  catch { return ""; }
}
function getSavedDeviceId() {
  try { return localStorage.getItem(BLE_LAST_DEVICE_ID) || ""; }
  catch { return ""; }
}

// Called on every successful connect — id is what the picker keys on, name
// is purely cosmetic (status line, picker tile).
function saveDeviceIdentity(id, name) {
  if (id) {
    try { localStorage.setItem(BLE_LAST_DEVICE_ID, id); } catch {}
    try { window.api.setPreferredBleId?.(id); } catch {}
  }
  if (name) {
    try { localStorage.setItem(BLE_LAST_DEVICE, name); } catch {}
  }
}

function forgetSavedDevice() {
  try { localStorage.removeItem(BLE_LAST_DEVICE); } catch {}
  try { localStorage.removeItem(BLE_LAST_DEVICE_ID); } catch {}
  try { window.api.bleForget?.(); } catch {}
  // Block the in-flight bleConnect's saveDeviceIdentity from silently
  // re-saving the id the user just removed. The picker also hides the
  // Forget button while selectedId is set, but this belt-and-braces
  // covers any future code path that might not.
  ble.forgetPending = true;
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

  // Only close the picker on a successful connect. Error / disconnect
  // states keep the picker open so the user can pick a different candidate
  // without re-triggering the whole scan loop (mirrors the mobile sheet
  // which only auto-closes on BleConnState.connected).
  if (connected) hideBlePicker();

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

async function bleSetupCharacteristics(device, generation) {
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  // Bail if the user has since reconnected to a different device.
  if (generation !== ble.generation) return;
  const service = await server.getPrimaryService(BLE_SVC_UUID);
  if (generation !== ble.generation) return;
  const writeChar = await service.getCharacteristic(BLE_WRITE_UUID);
  const statusChar = await service.getCharacteristic(BLE_STATUS_UUID);

  let cmdChar = null;
  try { cmdChar = await service.getCharacteristic(BLE_CMD_UUID); } catch (_) {}

  let feedChar = null;
  try { feedChar = await service.getCharacteristic(BLE_FEED_UUID); } catch (_) {}

  // Tear down any prior connection's listeners. Mobile flutter_blue_plus
  // re-creates the characteristic object on every connect; Web Bluetooth in
  // Chromium reuses the SAME characteristic object across GATT reconnects to
  // the same device, so without removeEventListener (or AbortController) the
  // ingestFeed callback would pile up: N reconnects → N feed callbacks per
  // notification → renderTable runs N times → render thrash + listener leak.
  if (ble.abort) { try { ble.abort.abort(); } catch (_) {} }
  ble.abort = new AbortController();
  const signal = ble.abort.signal;

  try { await statusChar.stopNotifications(); } catch (_) {}
  await statusChar.startNotifications();
  if (generation !== ble.generation) return;
  statusChar.addEventListener("characteristicvaluechanged", (e) => {
    const text = new TextDecoder().decode(e.target.value);
    const isErr = text.startsWith("err");
    setDtmfResponse(text, isErr ? "bad" : "ok");
  }, { signal });

  if (feedChar) {
    try { await feedChar.stopNotifications(); } catch (_) {}
    await feedChar.startNotifications();
    if (generation !== ble.generation) return;
    feedChar.addEventListener("characteristicvaluechanged", (e) => {
      const text = new TextDecoder().decode(e.target.value);
      try {
        const json = JSON.parse(text);
        ingestFeed(json);
      } catch (err) {
        console.warn("Feed parse failed:", err, text);
      }
    }, { signal });
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
  if (ble.scanning) return; // bleConnect is running; let it win

  ble.reconnecting = true;
  ble.reconnectAttempt += 1;
  const n = ble.reconnectAttempt;
  const gen = ++ble.generation;
  setBleStatus("Reconnecting…", "connecting");
  try {
    await bleSetupCharacteristics(ble.device, gen);
    if (gen !== ble.generation) { ble.reconnecting = false; return; }
    ble.reconnecting = false;
    ble.reconnectAttempt = 0;
    saveDeviceIdentity(ble.device.id, ble.device.name);
    setBleStatus(ble.device.name || "Connected", "connected");
    startKeepalive();
  } catch (_) {
    if (gen !== ble.generation) { ble.reconnecting = false; return; }
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

// Race a promise against a deadline. On timeout we reject with a labelled
// Error and let the catch decide cleanup — the inner awaits don't know how
// to disconnect the partially-set-up GATT, but the bleConnect catch does.
// Used to bound device.gatt.connect() on Windows, where the WinRT BLE stack
// can stall the promise indefinitely if the pairing dialog is dismissed.
function bleWithTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function bleConnect() {
  if (!navigator.bluetooth) {
    setBleStatus("Web Bluetooth not available", "error");
    return;
  }
  // Re-entrancy guard — a second click while the first requestDevice() is
  // still pending would clobber characteristics mid-scan AND produce two
  // concurrent Web Bluetooth requests, orphaning the first. Surface a status
  // so the user gets feedback that the click was received — the silent
  // return previously looked identical to a wedged button.
  if (ble.scanning) {
    setBleStatus("Still connecting — please wait…", "connecting");
    return;
  }
  ble.scanning = true;

  // Reset picker state at scan entry so the empty-state copy starts at
  // "Looking…" again and any prior candidate list doesn't flash above the
  // "Scanning…" status. Render is a no-op when the picker isn't visible.
  picker.candidates = [];
  picker.scanEnded = false;
  picker.selectedId = null;
  renderBlePicker();

  bleClearReconnect();
  if (ble.device) {
    try { if (ble.device.gatt.connected) ble.device.gatt.disconnect(); } catch (_) {}
    ble.device = null;
  }
  ble.writeChar = ble.statusChar = ble.cmdChar = ble.feedChar = null;
  ble.userDisconnected = false;
  // Tear down any prior listeners (gattserverdisconnected + characteristic
  // notification handlers from a previous connection cycle).
  if (ble.abort) { try { ble.abort.abort(); } catch (_) {} ble.abort = null; }
  const gen = ++ble.generation;
  let device = null;

  try {
    setBleStatus("Scanning…", "connecting");
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SVC_UUID] }],
    });
    if (gen !== ble.generation) return;

    setBleStatus(`Connecting to ${device.name || "device"}…`, "connecting");
    // The next bleSetupCharacteristics call creates ble.abort; bind the
    // disconnect listener through the SAME signal so the listener is
    // garbage-collected when we re-attach on next reconnect.
    if (!ble.abort) ble.abort = new AbortController();
    device.addEventListener("gattserverdisconnected", () => {
      if (gen !== ble.generation) return; // already replaced by a fresh connect
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

    // 25 s budget covers a slow Windows pair (15-20 s observed) plus headroom
    // for service/characteristic discovery. Without this, a dismissed pairing
    // dialog or a stale bond used to wedge ble.scanning=true indefinitely.
    await bleWithTimeout(bleSetupCharacteristics(device, gen), 25000, "GATT connect");
    if (gen !== ble.generation) return;
    // ForgetSavedDevice may have fired while the GATT connect was in flight;
    // honour the user's intent and DON'T silently re-save the id they just
    // removed. forgetSavedDevice() sets ble.forgetPending = true.
    if (!ble.forgetPending) saveDeviceIdentity(device.id, device.name);
    ble.forgetPending = false;
    setBleStatus(device.name || "Connected", "connected");
    startKeepalive();
  } catch (err) {
    console.error("BLE connect failed:", err);
    const msg = err.message || "Connect failed";
    const cancelled = /cancel/i.test(msg) || err.name === "NotFoundError";
    const timedOut = /timed out/i.test(msg);
    // Stop the half-connected GATT so the next Connect click starts clean.
    if (timedOut && device?.gatt) {
      try { device.gatt.disconnect(); } catch (_) {}
    }
    // Picker stays visible so the user can retry without re-triggering the
    // whole scan loop. Clear the spinner so other tiles re-enable. Flip to
    // the "scan ended" empty state on a cancelled / 30 s NotFoundError, even
    // if some candidates accumulated — clicks on those stale tiles were
    // dropped by the cancelled scan anyway.
    picker.selectedId = null;
    if (picker.visible) {
      if (cancelled) picker.scanEnded = true;
      renderBlePicker();
    }
    if (timedOut) {
      setBleStatus("Pairing took too long — check Windows Bluetooth settings, then retry", "error");
    } else {
      setBleStatus(cancelled ? "Not connected" : msg, cancelled ? "" : "error");
    }
  } finally {
    // Always release the re-entrancy guard. Previously this lived only on
    // the happy-path and catch branches, so any unexpected throw (or the
    // new timeout above) could leave ble.scanning=true forever and the
    // guard at the top of bleConnect would silently swallow every retry.
    ble.scanning = false;
  }
}

// bleAutoReconnectOnStartup is hoisted into the Main section below so the
// startup race (renderer.setPreferredBleId must reach main BEFORE the
// chooser event fires) can be coordinated alongside the rest of bootstrap.

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

// ── BLE multi-hotspot picker (mirrors mobile hotspot_picker_sheet.dart) ──
// Main process pushes `ble:candidates` once the resolution window is up and
// auto-connect didn't apply. Renderer keeps the overlay in sync with the
// streamed list and forwards the user's choice / cancel back via IPC.
const picker = {
  visible: false,
  selectedId: null,   // device the user just tapped (shows spinner)
  candidates: [],
  preferredId: "",
  scanEnded: false,   // 30 s timeout fired with zero results → show Rescan
};

function renderBlePicker() {
  const overlay = document.getElementById("ble-picker-overlay");
  const list = document.getElementById("ble-picker-list");
  const sub = document.getElementById("ble-picker-sub");
  const forget = document.getElementById("btn-ble-forget");
  const rescan = document.getElementById("btn-ble-rescan");
  if (!overlay || !list) return;
  overlay.classList.toggle("hidden", !picker.visible);
  if (!picker.visible) return;

  // Forget hides mid-connect — otherwise the in-flight GATT setup would
  // run saveDeviceIdentity() afterwards and silently re-save the id the
  // user just removed.
  if (forget) {
    const canForget = picker.preferredId && !picker.selectedId;
    forget.style.display = canForget ? "" : "none";
  }
  if (rescan) rescan.style.display = picker.scanEnded ? "" : "none";
  if (sub) {
    if (picker.candidates.length) sub.textContent = "Tap to connect";
    else if (picker.scanEnded)    sub.textContent = "Scan ended";
    else                          sub.textContent = "Scanning…";
  }

  if (picker.candidates.length === 0) {
    if (picker.scanEnded) {
      list.innerHTML = `
        <div class="ble-picker-empty">
          <div class="ble-picker-empty-icon">📡</div>
          <div class="ble-picker-empty-title">No HotSpots found in range.</div>
          <div class="ble-picker-empty-sub">Make sure your HotSpot is powered on, then click <strong>Rescan</strong>.</div>
        </div>`;
    } else {
      list.innerHTML = `
        <div class="ble-picker-empty">
          <div class="ble-picker-empty-icon">🔍</div>
          <div class="ble-picker-empty-title">Looking for HotSpots in range…</div>
          <div class="ble-picker-empty-sub">Make sure your HotSpot is powered on and not already connected to another device.</div>
        </div>`;
    }
    return;
  }

  // Float saved-id match to the top regardless of advertised name.
  const sorted = picker.candidates.slice().sort((a, b) => {
    const aPref = a.deviceId === picker.preferredId ? 0 : 1;
    const bPref = b.deviceId === picker.preferredId ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    return (a.deviceName || "").localeCompare(b.deviceName || "");
  });

  list.innerHTML = sorted.map((d) => {
    const name = d.deviceName || "(no name)";
    const isSaved = d.deviceId === picker.preferredId;
    const connecting = picker.selectedId === d.deviceId;
    const dimmed = picker.selectedId != null && picker.selectedId !== d.deviceId;
    return `
      <button class="ble-picker-tile${connecting ? " connecting" : ""}${dimmed ? " dimmed" : ""}"
              data-id="${escapeHtml(d.deviceId)}"
              ${dimmed ? "disabled" : ""}>
        <span class="ble-picker-tile-icon">${connecting ? "⟳" : "📡"}</span>
        <span class="ble-picker-tile-body">
          <span class="ble-picker-tile-name">
            ${escapeHtml(name)}
            ${isSaved ? `<span class="ble-picker-chip">Last used</span>` : ""}
          </span>
          <span class="ble-picker-tile-id">${escapeHtml(d.deviceId)}</span>
        </span>
      </button>`;
  }).join("");
}

function showBlePicker(payload) {
  // Ignore late candidate-list pushes that arrive AFTER the user already
  // tapped a tile — a stale ble:candidates IPC queued before ble:choose
  // would otherwise reset selectedId, un-spin the chosen tile, and
  // re-enable the others (race the audit flagged as the "two ble:choose
  // IPCs in flight" path).
  if (picker.selectedId) {
    picker.candidates = Array.isArray(payload?.devices) ? payload.devices : picker.candidates;
    picker.preferredId = String(payload?.preferredId || "");
    return;
  }
  const wasVisible = picker.visible;
  picker.candidates = Array.isArray(payload?.devices) ? payload.devices : [];
  picker.preferredId = String(payload?.preferredId || "");
  picker.visible = true;
  picker.scanEnded = false;
  renderBlePicker();
  if (!wasVisible) {
    pickerPrevFocus = document.activeElement;
    // Autofocus the first interactive element so keyboard users land in the
    // dialog without a screen reader announcing "unlabeled dialog open".
    const els = focusableInPicker();
    if (els.length) els[0].focus();
  }
}

function hideBlePicker() {
  const wasVisible = picker.visible;
  picker.visible = false;
  picker.selectedId = null;
  picker.candidates = [];
  picker.scanEnded = false;
  renderBlePicker();
  if (wasVisible && pickerPrevFocus && typeof pickerPrevFocus.focus === "function") {
    try { pickerPrevFocus.focus(); } catch (_) {}
  }
  pickerPrevFocus = null;
}

// Element that had focus when the picker opened — restored on close so the
// keyboard user lands back where they were (typically btn-ble-quickconnect).
let pickerPrevFocus = null;

function focusableInPicker() {
  const overlay = document.getElementById("ble-picker-overlay");
  if (!overlay) return [];
  return Array.from(overlay.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null);
}

function onPickerKeyDown(e) {
  if (!picker.visible) return;
  if (e.key === "Escape") {
    e.preventDefault();
    try { window.api.bleCancelScan?.(); } catch {}
    hideBlePicker();
    return;
  }
  if (e.key === "Tab") {
    // Focus trap so Tab can't drop the user behind the modal backdrop.
    const els = focusableInPicker();
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function initBlePickerUI() {
  document.getElementById("ble-picker-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".ble-picker-tile[data-id]");
    if (!btn || picker.selectedId) return;
    const id = btn.dataset.id;
    picker.selectedId = id;
    renderBlePicker();
    try { window.api.bleChoose?.(id); } catch {}
  });
  document.getElementById("btn-ble-picker-cancel")?.addEventListener("click", () => {
    try { window.api.bleCancelScan?.(); } catch {}
    hideBlePicker();
  });
  document.getElementById("btn-ble-rescan")?.addEventListener("click", () => {
    // Rescan = restart the chooser session. bleConnect() guards re-entrancy,
    // and its first action will reset picker.scanEnded + candidates and
    // re-render to the "Looking…" empty state.
    bleConnect();
  });
  document.getElementById("btn-ble-forget")?.addEventListener("click", () => {
    if (!confirm("Forget the saved HotSpot? The next scan will show the picker again.")) return;
    forgetSavedDevice();
    picker.preferredId = "";
    renderBlePicker();
  });
  window.api.onBleCandidates?.((payload) => showBlePicker(payload));
  // Focus / keyboard a11y — Esc closes, Tab traps inside the dialog.
  document.addEventListener("keydown", onPickerKeyDown);
}

function initBLE() {
  document.getElementById("btn-ble-connect")?.addEventListener("click", bleConnect);
  document.getElementById("btn-ble-disconnect")?.addEventListener("click", bleDisconnect);
  document.getElementById("btn-ble-quickconnect")?.addEventListener("click", bleConnect);
  initBlePickerUI();

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
    // Detach handlers BEFORE close so a fire-and-forget "close" event on the
    // old socket doesn't reschedule a reconnect that races with the new ws.
    try { reflectorFeed.ws.onopen = reflectorFeed.ws.onmessage = reflectorFeed.ws.onerror = reflectorFeed.ws.onclose = null; } catch (_) {}
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

// Frame size cap — a hostile reflector could otherwise stream a multi-MB
// payload that JSON.parse would chew through on the main thread for seconds.
const REFLECTOR_FRAME_MAX_BYTES = 4 * 1024 * 1024;
// Backoff ceiling for sustained failures (typo'd domain → don't hammer the
// real endpoint at 15 s intervals forever).
const REFLECTOR_BACKOFF_MAX_MS = 5 * 60 * 1000;
let reflectorFailures = 0;

function reflectorConnect() {
  if (reflectorFeed.disposed) return;
  if (!state.reflector.domain || !state.reflector.enabled) return;

  const host = normalizeReflectorHost(state.reflector.domain);
  // Hostname allowlist — refuse anything that doesn't parse as a bare host
  // (defeats `javascript:`, `file://`, embedded `@`, etc., that could have
  // slipped past `normalizeReflectorHost`'s scheme-strip).
  if (!host || !isSafeHostname(host)) { setReflectorAvailable(false); return; }

  let ws;
  try {
    ws = new WebSocket(`wss://${host}/`);
  } catch (_) {
    reflectorScheduleReconnect();
    return;
  }
  reflectorFeed.ws = ws;

  // Capture the local reference and guard each handler — if a fresh
  // reflectorConnect re-assigns reflectorFeed.ws while this socket's events
  // are still in flight, we ignore them. Without the guard, a stale close
  // event would call scheduleReconnect that races with the new connection
  // and toggles `available` back to false.
  const isCurrent = () => reflectorFeed.ws === ws;

  ws.onopen = () => { if (isCurrent()) reflectorFailures = 0; };
  ws.onmessage = (ev) => {
    if (!isCurrent()) return;
    if (typeof ev.data !== "string") return;
    if (ev.data.length > REFLECTOR_FRAME_MAX_BYTES) {
      console.warn("[reflector] dropped oversize frame", ev.data.length);
      return;
    }
    let obj;
    try { obj = JSON.parse(ev.data); } catch (_) { return; }
    if (!obj || typeof obj !== "object") return;
    const type = String(obj.type || "");
    if      (type === "snapshot")    reflectorHandleSnapshot(obj);
    else if (type === "node_upsert") reflectorHandleNodeUpsert(obj.node);
    else if (type === "talk_start" || type === "talk_stop") reflectorHandleTalkEvent(obj.session);
  };
  ws.onerror = () => { if (isCurrent()) reflectorScheduleReconnect(); };
  ws.onclose = () => { if (isCurrent()) reflectorScheduleReconnect(); };

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
  // Clear pending snapshot timer too — otherwise a stale snapshot timeout
  // can fire after we've already scheduled a fresh connect and double-flip
  // `available`.
  if (reflectorFeed.snapshotTimer) { clearTimeout(reflectorFeed.snapshotTimer); reflectorFeed.snapshotTimer = null; }
  if (reflectorFeed.ws) {
    try { reflectorFeed.ws.onopen = reflectorFeed.ws.onmessage = reflectorFeed.ws.onerror = reflectorFeed.ws.onclose = null; } catch (_) {}
    try { reflectorFeed.ws.close(); } catch (_) {}
    reflectorFeed.ws = null;
  }
  if (reflectorFeed.reconnectTimer) clearTimeout(reflectorFeed.reconnectTimer);
  // Exponential backoff so a misconfigured (typo'd) domain doesn't hammer the
  // upstream every 15 s indefinitely. Reset on successful onopen.
  reflectorFailures += 1;
  const delay = Math.min(
    REFLECTOR_BACKOFF_MAX_MS,
    REFLECTOR_RECONNECT_MS * Math.pow(1.5, Math.max(0, reflectorFailures - 1))
  );
  reflectorFeed.reconnectTimer = setTimeout(reflectorConnect, delay);
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
  // Refuse anything that isn't an HTTPS URL — `data:` / `javascript:` /
  // `file:` payloads constructed from a hostile reflector domain would
  // otherwise reach fetch() here.
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
  } catch { return null; }
  const ac = new AbortController();
  const tmo = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: ac.signal,
    });
    if (!res.ok) return null;
    // Refuse oversized response bodies — a hostile portal could otherwise
    // stream tens of MB of JSON and stall the renderer.
    const lenHeader = Number(res.headers.get("content-length"));
    if (Number.isFinite(lenHeader) && lenHeader > 2 * 1024 * 1024) return null;
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) return null;
    const json = JSON.parse(text);
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(json)) {
      if (count >= 500) break;
      const key = String(k).trim().slice(0, 32);
      const val = String(v ?? "").slice(0, 128);
      if (key) { out[key] = val; count += 1; }
    }
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(tmo);
  }
}

async function probeReflectorWss(domain) {
  // We can't do a raw HTTP Upgrade probe from a renderer without CORS issues,
  // so we attempt an actual WebSocket open with a short timeout instead.
  const host = normalizeReflectorHost(domain);
  if (!host || !isSafeHostname(host)) return false;
  return await new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        if (ws) {
          ws.onopen = ws.onerror = ws.onclose = null;
          ws.close();
        }
      } catch (_) {}
      resolve(ok);
    };
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
  let tickInFlight = false;
  const tick = async () => {
    if (tickInFlight) return; // 8 h overlaps cannot happen but defend anyway
    tickInFlight = true;
    try {
      const fetched = await fetchTalkgroupsFromUrl(url);
      if (!fetched || !Object.keys(fetched).length) return;
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
    } finally {
      tickInFlight = false;
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
  // Validate the host before persisting: a rogue BLE peripheral within range
  // could otherwise feed `rf: "javascript:..."` or `rf: "evil.tld/path?x="`,
  // and the renderer would open wss://reflector.evil.tld/... and persist the
  // bogus value to settings.json. Bare-hostname allowlist only.
  const candidate = String(rfDomain).trim()
    .replace(/^reflector\./i, "")
    .replace(/^portal\./i, "");
  if (!isSafeHostname(candidate)) {
    console.warn("[reflector] ignoring untrusted rf from feed:", rfDomain);
    return;
  }
  state.cfg = { ...state.cfg, reflectorDomain: candidate };
  window.api.saveSettings({ reflectorDomain: candidate }).catch(() => {});
  reflectorSetDomain(candidate, cfg.wssEnabled !== false);
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
    // animate:false — talker-driven camera moves can fire in bursts during a
    // net; Leaflet's default animation queues these and the map judders.
    mapState.map.setView(
      [talkers[0].lat, talkers[0].lon],
      Math.max(mapState.map.getZoom(), 9),
      { animate: false }
    );
    return;
  }
  const bounds = L.latLngBounds(talkers.map((n) => [n.lat, n.lon]));
  mapState.map.fitBounds(bounds, { padding: [40, 40], animate: false });
}

// Trailing-edge debounce — coalesces bursts of qualify/unqualify events
// during a multi-station net into one camera move per ~250 ms.
let refitMapTimer = null;
function refitMap() {
  if (!mapState.map) return;
  if (refitMapTimer) clearTimeout(refitMapTimer);
  refitMapTimer = setTimeout(() => {
    refitMapTimer = null;
    const qualified = collectQualifiedTalkers();
    if (qualified.length) fitToTalkers(qualified);
    else fitMapInitial();
  }, 250);
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

// callsign → { marker, sigStyle, sigPopup, lat, lon } so we only touch the
// markers whose state actually changed. Previous renderMap cleared every
// circleMarker and rebuilt from scratch on every WSS event, allocating ~200
// SVG nodes/sec during a net.
const markerCache = new Map();

function buildPopupHtml(n) {
  const isTalker = !!n.isTalker;
  const monitored = n.monitoredTGs?.length ? `Monitors: ${n.monitoredTGs.join(", ")}` : "";
  const badge = nodeBadge(n);
  const badgeHtml = `<span class="map-badge" style="background:${badge.bg}">${badge.label}</span>`;
  const talkingHtml = isTalker ? `<span class="map-badge map-badge-talking">TALKING</span>` : "";
  const tgLabel = n.tg && state.talkgroupInfo[String(n.tg)] ? ` — ${escapeHtml(state.talkgroupInfo[String(n.tg)])}` : "";
  return `
    <div class="map-popup">
      <div class="map-popup-head">
        <span class="map-popup-cs">${escapeHtml(n.callsign)}</span>
        ${badgeHtml}${talkingHtml}
      </div>
      ${n.location ? `<div class="map-popup-loc">${escapeHtml(n.location)}</div>` : ""}
      ${n.tg ? `<div class="map-popup-tg">TG ${n.tg}${tgLabel}</div>` : ""}
      ${monitored ? `<div class="map-popup-mt">${escapeHtml(monitored)}</div>` : ""}
    </div>`;
}

function renderMap() {
  // Talker qualification must run on every node update regardless of whether
  // the map is visible — it drives the 1.5 s timers and the camera re-fit.
  updateTalkerQualifications();
  if (!mapState.map || !mapState.markersLayer) return;
  // Skip the heavy marker work entirely while the Map tab isn't active.
  // updateTalkerQualifications already ran above so we don't drop the timer
  // state — only the SVG churn.
  if (state.activeScreen !== "map") return;

  const wanted = new Set();
  for (const n of state.reflector.nodes.values()) {
    if (n.lat == null || n.lon == null) continue;
    wanted.add(n.callsign);
    const isTalker = !!n.isTalker;
    const color = nodeColor(n);
    const size = isTalker ? 16 : 10;
    const styleSig = color + "|" + size + "|" + (isTalker ? 1 : 0) + "|" + (n.online ? 1 : 0);
    const popupSig = (n.callsign || "") + "|" + (n.location || "") + "|" + (n.tg || "") + "|" + (n.monitoredTGs?.join(",") || "") + "|" + isTalker;
    let cached = markerCache.get(n.callsign);
    if (!cached) {
      const marker = L.circleMarker([n.lat, n.lon], {
        radius: size / 2,
        color, fillColor: color,
        fillOpacity: isTalker ? 0.95 : 0.85,
        weight: isTalker ? 2 : 1,
      });
      marker.bindPopup(buildPopupHtml(n));
      marker.addTo(mapState.markersLayer);
      markerCache.set(n.callsign, { marker, styleSig, popupSig, lat: n.lat, lon: n.lon });
    } else {
      if (cached.lat !== n.lat || cached.lon !== n.lon) {
        cached.marker.setLatLng([n.lat, n.lon]);
        cached.lat = n.lat; cached.lon = n.lon;
      }
      if (cached.styleSig !== styleSig) {
        cached.marker.setStyle({
          radius: size / 2,
          color, fillColor: color,
          fillOpacity: isTalker ? 0.95 : 0.85,
          weight: isTalker ? 2 : 1,
        });
        cached.styleSig = styleSig;
      }
      if (cached.popupSig !== popupSig) {
        // setPopupContent updates without closing an open popup.
        cached.marker.setPopupContent(buildPopupHtml(n));
        cached.popupSig = popupSig;
      }
    }
  }
  // Drop markers whose nodes vanished from the feed.
  for (const [cs, cached] of markerCache) {
    if (!wanted.has(cs)) {
      try { mapState.markersLayer.removeLayer(cached.marker); } catch (_) {}
      markerCache.delete(cs);
    }
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
  // when a newer release tag is available. Click opens the download page;
  // pill flips to a muted "Opened" state so the user gets feedback.
  const updateBtn = document.getElementById("btn-update");
  const updateLabel = document.getElementById("update-pill-label");
  const showUpdate = (info) => {
    if (!updateBtn || !info) return;
    if (updateLabel) updateLabel.textContent = `v${info.version} available`;
    updateBtn.title = `New version ${info.version} — click to open ${info.url || "the download page"}`;
    updateBtn.style.display = "";
    updateBtn.classList.remove("opened");
  };
  window.api.onUpdateAvailable?.(showUpdate);
  // Pull on bootstrap in case the broadcast was delivered before this
  // handler registered — race-free path.
  window.api.checkUpdateNow?.().then((info) => { if (info) showUpdate(info); }).catch(() => {});
  updateBtn?.addEventListener("click", () => {
    window.api.openUpdateUrl?.();
    // Visual ack — pill muted with a tick so the user knows the click landed.
    if (updateLabel) updateLabel.textContent = "Opened ↗";
    updateBtn.classList.add("opened");
    updateBtn.title = "Opened in your browser";
  });
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
async function bleAutoReconnectOnStartup() {
  if (!getSavedDeviceId() && !getSavedDeviceName()) return;
  await bleConnect();
}
// Reassign — bleAutoReconnectOnStartup was defined earlier (before the new
// scanning guard) and the window-bound reference at line ~855 points at the
// original. Both refer to the same closure body; this re-binding ensures
// the main process's executeJavaScript("window.bleAutoReconnectOnStartup()")
// goes through the gated path even if the original got re-exported.
window.bleAutoReconnectOnStartup = bleAutoReconnectOnStartup;

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

  // Send the saved-device-id to main BEFORE the cfg load — otherwise the
  // chooser handler could race ahead with preferredBleId="" and auto-connect
  // to whichever HotSpot advertises first (wrong pick in a multi-HS room).
  // setPreferredBleId is a fire-and-forget ipcRenderer.send so it lands on
  // main's event loop ahead of the upcoming executeJavaScript that triggers
  // bleAutoReconnectOnStartup.
  try { window.api.setPreferredBleId?.(getSavedDeviceId()); } catch {}

  const cfg = await window.api.loadSettings();
  applyConfig(cfg);

  setBleStatus("Not connected", "");

  renderFeed();
  renderTable();
  renderInfo();
  renderReflectorScreen();

  // Time-label tick — every second, refresh ONLY the cells whose displayed
  // text could have changed (the differential renderTable handles this
  // cheaply now). 1 s is still the right cadence for the "5s/2m/1h" ladder.
  setInterval(() => {
    renderTable();
    if (state.activeScreen === "reflector") renderReflectorScreen();
  }, 1000);

  // Tell main "I'm here, drain anything you queued." Currently only the
  // update-pill broadcast — see main.js onCachedUpdateAvailable.
  try { window.api.rendererReady?.(); } catch {}

  // On OS resume, the BLE keepalive timers were almost certainly throttled
  // to ~1/min so we discover the dead GATT link only minutes later. Kick the
  // watchdog so we reconnect in <1 s instead.
  window.api.onPowerResume?.(() => {
    if (ble.device && !ble.userDisconnected && !ble.scanning && !ble.reconnecting) {
      scheduleReconnect(500);
    }
    // Reflector WSS — same idea; force a reconnect attempt so we don't sit
    // on a half-open zombie socket waiting for a TCP keepalive to time out.
    if (state.reflector.domain && state.reflector.enabled) {
      reflectorScheduleReconnect();
    }
  });

  // before-quit / beforeunload — flush WSS + BLE so the OS doesn't see a
  // half-closed peer. Mostly cosmetic but it gets us out of "stuck pairing"
  // states on macOS sometimes.
  const teardown = () => {
    try { reflectorReset(); } catch (_) {}
    try { if (ble.abort) ble.abort.abort(); } catch (_) {}
    try { if (ble.device?.gatt?.connected) ble.device.gatt.disconnect(); } catch (_) {}
  };
  window.api.onBeforeQuit?.(teardown);
  window.addEventListener("beforeunload", teardown);
}

main().catch((err) => {
  console.error("HotSpot startup failed:", err);
  if (titlebarStatusEl) {
    titlebarStatusEl.textContent = "Error";
    titlebarStatusEl.className = "bad";
  }
});
