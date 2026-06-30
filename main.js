const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, nativeImage, powerMonitor, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// Force the menu-bar / About / Quit labels to "HotSpot" regardless of the npm
// package `name`. Must run before app.whenReady().
app.setName("HotSpot");
// Without this Windows toasts attribute to "Electron", taskbar pinning breaks
// across upgrades, and grouping is wrong. macOS/Linux ignore.
if (process.platform === "win32") {
  app.setAppUserModelId("com.gururf.hotspot-app");
}

// Single-instance lock — prevents a second double-click of the Dock/Taskbar
// icon during slow first launch from racing against the original on the
// settings.json write and the BLE peripheral lock.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

let mainWindow;
let settingsWindow = null;
let creatingSettingsWindow = false; // lock guarding rapid gear-click race
let tray = null;
// True once `before-quit` fires — distinguishes "user pressed Cmd+Q / quit
// from tray" from "user clicked the red close circle" so the close handler
// can hide-instead-of-close on macOS without trapping a real quit.
let isQuitting = false;
// Stable platform BLE identifier (Electron's `deviceId`) for the last hotspot
// the user connected to. Survives firmware re-flashes that change the
// advertised name. Empty = no saved preference, the user gets the picker.
let preferredBleId = "";

// Module-scoped picker state — the IPC handlers at the bottom need access,
// but the chooser event itself is registered per-window in createWindow().
const BLE_RESOLUTION_WINDOW_MS = 3000;
const BLE_INTERACTIVE_SCAN_MS = 30000;
let bleScanTimeout = null;
let bleResolutionTimeout = null;
let bleCurrentCallback = null;
let bleLatestDevices = [];
let blePickerActive = false;

function clearBleTimers() {
  if (bleScanTimeout) { clearTimeout(bleScanTimeout); bleScanTimeout = null; }
  if (bleResolutionTimeout) { clearTimeout(bleResolutionTimeout); bleResolutionTimeout = null; }
}
function pushBleCandidates() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("ble:candidates", {
    devices: bleLatestDevices.map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName || "",
    })),
    preferredId: preferredBleId || "",
  });
}
function resolveBleCallback(deviceId) {
  const cb = bleCurrentCallback;
  clearBleTimers();
  bleCurrentCallback = null;
  blePickerActive = false;
  if (cb) try { cb(deviceId || ""); } catch (_) {}
}
function decideBleAfterResolution() {
  bleResolutionTimeout = null;
  const list = bleLatestDevices;
  if (list.length === 1) {
    const only = list[0];
    if (!preferredBleId || only.deviceId === preferredBleId) {
      resolveBleCallback(only.deviceId);
      return;
    }
  }
  // Multiple candidates / saved id absent / zero hits → open the picker.
  blePickerActive = true;
  pushBleCandidates();
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

const DEFAULT_SETTINGS = {
  title: "HotSpot",
  alwaysOnTop: false,
  // Settings window owns these too — keeping them in cfg makes the main and
  // settings windows agree without needing a shared localStorage origin.
  theme: "dark",          // "dark" | "light"
  historyLimit: 50,
  talkgroupInfo: {
    "4": "4m Repeaters",
    "6": "6m Repeaters",
    "8": "70cm Repeaters",
    "23": "23cm Repeaters",
    "50": "Talkgroup 0",
    "51": "Talkgroup 1",
    "52": "Talkgroup 2",
    "53": "Talkgroup 3",
    "54": "Talkgroup 4",
    "55": "Talkgroup 5",
    "1745": "ON0ORA Local off-net",
    "8400": "145.400 Simplex Club Oostende",
    "8401": "145.7125 VHF Repeater Oostende",
    "9000": "145.7 VHF Repeater Gent",
  },
  // Reflector / WSS — feature unlocks when the user sets a domain.
  reflectorDomain: "",
  wssEnabled: true,
  // Talkgroups auto-update via portal.<domain>/talkgroups.json
  tgAutoUpdate: false,
  tgUpdateUrl: "",
  // Map / home QTH — structured address kept alongside lat/lng so users can
  // edit and re-geocode without losing what they typed.
  homeStreet: "",
  homeNumber: "",
  homeZip: "",
  homeCity: "",
  homeCountry: "",
  homeLat: null,
  homeLng: null,
  homeRadiusKm: 150,
};

// `fs.writeFileSync` is NOT atomic — a crash mid-write leaves a half-written
// JSON file that fails to parse on next launch, silently falling back to
// defaults and wiping the user's entire configuration. POSIX `rename` IS
// atomic; on Windows `fs.renameSync` calls ReplaceFileW which is atomic
// enough for our needs.
function atomicWriteFileSync(target, data) {
  const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // Cleanup the tmp file before re-throwing so we don't litter userData.
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function loadSettings() {
  const p = getSettingsPath();
  let raw = null;
  try {
    if (fs.existsSync(p)) raw = fs.readFileSync(p, "utf-8");
  } catch (e) {
    console.warn("[settings] read failed:", e && e.message);
  }
  if (!raw) {
    // Try the previous-good backup before giving up.
    try {
      const bak = p + ".bak";
      if (fs.existsSync(bak)) raw = fs.readFileSync(bak, "utf-8");
    } catch (_) {}
  }
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      if (!saved.talkgroupInfo || !Object.keys(saved.talkgroupInfo).length)
        delete saved.talkgroupInfo;
      return { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
      // Quarantine the corrupt file so the user can recover their talkgroups
      // list (and we have something to inspect during support). Do NOT
      // overwrite an existing quarantine.
      try {
        const q = p + ".corrupt-" + Date.now();
        if (fs.existsSync(p)) fs.copyFileSync(p, q);
        console.error("[settings] parse failed; quarantined to", q, e && e.message);
      } catch (qe) {
        console.error("[settings] parse failed AND quarantine failed:", e && e.message, qe && qe.message);
      }
    }
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  const target = getSettingsPath();
  const bak = target + ".bak";
  // Roll the previous good file aside before writing the new one. After the
  // rename the .bak still exists for crash recovery in loadSettings.
  try {
    if (fs.existsSync(target)) fs.copyFileSync(target, bak);
  } catch (_) {}
  atomicWriteFileSync(target, JSON.stringify(settings, null, 2));
}

// Allowlist + type/length checks for the settings:save IPC. Any field not
// listed here gets dropped; anything failing its check falls back to the
// existing saved value so a hostile/corrupted renderer can't poison disk.
// `caps` defends against unbounded talkgroups list / multi-MB strings.
const REFLECTOR_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
function validateSettingsPartial(partial) {
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) return {};
  const out = {};
  const setStr = (k, max) => {
    const v = partial[k];
    if (typeof v === "string" && v.length <= max) out[k] = v;
  };
  const setBool = (k) => { if (typeof partial[k] === "boolean") out[k] = partial[k]; };
  const setNumOrNull = (k, min, max) => {
    const v = partial[k];
    if (v === null) { out[k] = null; return; }
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) out[k] = v;
  };
  setStr("title", 64);
  setBool("alwaysOnTop");
  if (partial.theme === "dark" || partial.theme === "light") out.theme = partial.theme;
  setNumOrNull("historyLimit", 1, 1000);
  if (partial.talkgroupInfo && typeof partial.talkgroupInfo === "object" && !Array.isArray(partial.talkgroupInfo)) {
    const tg = {};
    const keys = Object.keys(partial.talkgroupInfo).slice(0, 500);
    for (const k of keys) {
      const key = String(k).trim().slice(0, 32);
      const val = String(partial.talkgroupInfo[k] ?? "").slice(0, 128);
      if (key) tg[key] = val;
    }
    out.talkgroupInfo = tg;
  }
  // Reflector domain — must look like a hostname (no schemes, no path, no @).
  if (typeof partial.reflectorDomain === "string") {
    const d = partial.reflectorDomain.trim().toLowerCase();
    if (d === "" || REFLECTOR_DOMAIN_RE.test(d.replace(/^reflector\./, "").replace(/^portal\./, ""))) {
      out.reflectorDomain = d;
    }
  }
  setBool("wssEnabled");
  setBool("tgAutoUpdate");
  setStr("tgUpdateUrl", 512);
  setStr("homeStreet",  128);
  setStr("homeNumber",  32);
  setStr("homeZip",     32);
  setStr("homeCity",    128);
  setStr("homeCountry", 64);
  setNumOrNull("homeLat", -90, 90);
  setNumOrNull("homeLng", -180, 180);
  setNumOrNull("homeRadiusKm", 1, 5000);
  // Window-bounds passthrough (we wrote it ourselves, so trust shape).
  if (partial.settingsWindowBounds && typeof partial.settingsWindowBounds === "object") {
    out.settingsWindowBounds = partial.settingsWindowBounds;
  }
  return out;
}

function createWindow() {
  const settings = loadSettings();

  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 900,
    minHeight: 720,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    alwaysOnTop: settings.alwaysOnTop || false,
    frame: false,
    transparent: false,
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.setMenuBarVisibility(false);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Renderer-driven update-pill broadcast happens AFTER did-finish-load; until
  // then we cache any update available so a late-bound listener still picks
  // it up. See ipcMain.handle("renderer:ready") below.
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(
      "typeof window.bleAutoReconnectOnStartup === 'function' && window.bleAutoReconnectOnStartup();",
      true
    ).catch(() => {});
  });

  // Renderer-driven external links: footer / info copy / etc. The setName
  // check rejects any non-https URL outright (no javascript:, no file:, no
  // mixed-content http). Domain allowlist defends against an injected script
  // opening a credential-phishing site.
  const EXTERNAL_ALLOWLIST = [
    /^https:\/\/(www\.)?qrz\.com(\/|$)/,
    /^https:\/\/(www\.)?rf\.guru(\/|$)/,
    /^https:\/\/svxlink-hotspot\.app(\/|$)/,
    /^https:\/\/github\.com\/Guru-RF\//,
  ];
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_ALLOWLIST.some((re) => re.test(url))) {
      shell.openExternal(url).catch(() => {});
    } else {
      console.warn("[window-open] blocked", url);
    }
    return { action: "deny" };
  });

  // Belt-and-braces: refuse in-renderer navigation away from index.html.
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) e.preventDefault();
  });

  // Frameless windows on Win/Linux give the user no Maximize affordance.
  // Double-clicking the title bar drag region toggles maximize, matching the
  // native expectation.
  ipcMain.on("window:toggle-maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  // Surface renderer/GPU crashes instead of leaving a white window forever.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer crashed]", details);
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Reload once; if it crashes again the user will see the same dialog
      // and can quit manually.
      mainWindow.webContents.reload();
    }
  });

  // Hide on close (macOS dock-style) so a misclick on the close button doesn't
  // also tear down BLE + WSS. window-all-closed handler quits on Win/Linux but
  // skips on darwin (handled below) so the tray + cmd-tab still work.
  mainWindow.on("close", (e) => {
    if (!isQuitting && process.platform === "darwin") {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Web Bluetooth picker — mirrors the Flutter mobile app's
  // `BleService.scanAndConnect`:
  //   1. Phase 1 ("resolution window", 3 s): let advertisements accumulate.
  //   2. After the window, if EXACTLY ONE HotSpot is in range AND its
  //      deviceId matches preferredBleId (or no preference is saved),
  //      auto-connect.
  //   3. Otherwise hand the candidate list to the renderer's picker overlay
  //      and keep the scan alive for up to 30 s so late-arriving hotspots
  //      show up.
  //   4. Renderer responds with `ble:choose` / `ble:cancel-scan`, else the
  //      30 s cap fires cb("") and aborts.
  // Module-level helpers do the heavy lifting; this handler is just the
  // chooser-event entrypoint.
  mainWindow.webContents.on("select-bluetooth-device", (event, devices, callback) => {
    event.preventDefault();
    // Defense in depth against the renderer somehow firing two
    // requestDevice() calls concurrently — the renderer already gates on
    // `ble.scanning`, but if that ever leaks (DevTools, future refactor),
    // releasing the orphaned callback prevents the first promise from
    // hanging forever and pinning the UI on "Scanning…".
    if (bleCurrentCallback && bleCurrentCallback !== callback) {
      try { bleCurrentCallback(""); } catch (_) {}
    }
    bleCurrentCallback = callback;
    bleLatestDevices = devices;
    if (blePickerActive) {
      pushBleCandidates();
      return;
    }
    if (!bleResolutionTimeout && !bleScanTimeout) {
      bleResolutionTimeout = setTimeout(decideBleAfterResolution, BLE_RESOLUTION_WINDOW_MS);
      bleScanTimeout = setTimeout(() => resolveBleCallback(""), BLE_INTERACTIVE_SCAN_MS);
    }
  });

  // Only the bundled file:// renderer should be able to use any of these
  // privileged APIs. A future XSS in a remote iframe can't request them.
  const isOurOrigin = (wc) => {
    try { return (wc && wc.getURL() || "").startsWith("file://"); } catch { return false; }
  };
  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === "bluetooth";
  });
  mainWindow.webContents.session.setPermissionCheckHandler((wc, permission) => {
    if (!isOurOrigin(wc)) return false;
    return ["bluetooth", "bluetooth-devices", "geolocation", "clipboard-sanitized-write"].includes(permission);
  });
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (!isOurOrigin(wc)) return callback(false);
    if (permission === "geolocation" || permission === "clipboard-sanitized-write") {
      return callback(true);
    }
    callback(false);
  });

}

// Constrain a saved (x,y,w,h) bounds rectangle to whichever display can
// actually fit it. Used when reopening Settings so a window that was last on
// a now-disconnected monitor / a different macOS Space doesn't vanish — a
// known gotcha when restoring window state across sessions.
function clampBoundsToDisplay(bounds, defaults) {
  const { screen } = require("electron");
  if (!bounds || typeof bounds !== "object") return { ...defaults };
  const w = Number.isFinite(bounds.width)  ? bounds.width  : defaults.width;
  const h = Number.isFinite(bounds.height) ? bounds.height : defaults.height;
  // If either x or y is missing, fall back to "centered on primary display".
  const hasXY = Number.isFinite(bounds.x) && Number.isFinite(bounds.y);
  if (!hasXY) {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h };
  }
  const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: w, height: h });
  const wa = display.workArea;
  // Shrink FIRST so the visibility math below has the real dimensions to
  // clamp against. With the prior order, w/h were used at full saved size
  // even when the chosen display was smaller.
  const cw = Math.min(w, wa.width);
  const ch = Math.min(h, wa.height);
  // Pull at least 32 px into the work area so the title bar stays grabbable.
  const minVisible = 32;
  let x = bounds.x;
  let y = bounds.y;
  if (x + cw < wa.x + minVisible) x = wa.x;
  if (x > wa.x + wa.width - minVisible) x = wa.x + wa.width - cw;
  if (y < wa.y) y = wa.y;
  if (y > wa.y + wa.height - minVisible) y = wa.y + wa.height - ch;
  return { x: Math.round(x), y: Math.round(y), width: cw, height: ch };
}

// ── Update check ──────────────────────────────────────────────────────────────
// Poll GitHub's "latest release" endpoint at startup and once a day after.
// If the tag (stripped of its leading "v") is higher than app.getVersion(),
// the renderer is told to show a red "update available" pill in the title
// bar. Click → main process opens the landing page in the system browser.
//
// Only runs on Linux — Windows users get updates via the Microsoft Store
// (AppX) and macOS users via the Mac App Store / pkg distribution. On those
// platforms the in-app pill would just compete with the OS-level updater.
// The handlers below stay registered (they're cheap no-ops without a fresh
// checkForUpdates call) so removing the renderer-side update UI is optional.
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_RELEASES_URL = "https://api.github.com/repos/Guru-RF/Analog-HotSPOT-App/releases/latest";
const UPDATE_LANDING_URL = "https://svxlink-hotspot.app";

// Parses a semver-shaped string into [major, minor, patch, preRank].
// preRank is 1 for stable releases and 0 for prerelease tags ("1.0.8-beta"),
// so a stable release is always considered greater than its own prereleases.
// Returns null for unparseable input — we then refuse to compare.
function parseVersion(s) {
  const m = String(s || "").trim().replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-(.+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), m[5] ? 0 : 1];
}
function isNewerVersion(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Last update info we successfully detected, so a renderer that registers
// its listener LATE (or reloads) still picks up the pill. Cleared once the
// renderer signals readiness and we re-send.
let cachedUpdateAvailable = null;

async function checkForUpdates() {
  // Store-managed platforms — skip the GitHub poll entirely.
  if (process.platform !== "linux") return;
  let res;
  const ac = new AbortController();
  const tmo = setTimeout(() => ac.abort(), 15000);
  try {
    res = await fetch(UPDATE_RELEASES_URL, {
      headers: {
        "User-Agent": "HotSpot-Desktop-App",
        "Accept": "application/vnd.github+json",
      },
      signal: ac.signal,
    });
  } catch (_) {
    clearTimeout(tmo);
    return;
  }
  clearTimeout(tmo);
  if (!res.ok) {
    // Respect GitHub's primary rate-limit when offered.
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(reset) && reset * 1000 > Date.now()) {
        console.warn("[update] GitHub rate-limited; retry after", new Date(reset * 1000).toISOString());
      }
    }
    return;
  }
  let json;
  try { json = await res.json(); } catch (_) { return; }
  const latest = String(json.tag_name || "").replace(/^v/i, "").trim();
  if (!latest) return;
  const current = app.getVersion();
  if (!isNewerVersion(latest, current)) return;
  const payload = { version: latest, url: UPDATE_LANDING_URL };
  cachedUpdateAvailable = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update:available", payload);
  }
}

function startUpdateChecking() {
  // Slight delay so the renderer's listener is up. The renderer also calls
  // ipcMain.handle("update:check-now") on ready so the timing is
  // race-resilient regardless of disk/CPU load.
  setTimeout(checkForUpdates, 5000);
  // Add 0–30 min jitter so coordinated launches (corporate machine pool, dev
  // restarts) don't all hit api.github.com at the same wall-clock minute.
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS + Math.floor(Math.random() * 30 * 60 * 1000));
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // If it's hiding on another macOS Space, this hauls it onto the active
    // one. On other platforms it just brings it to front.
    if (process.platform === "darwin") {
      settingsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      settingsWindow.setVisibleOnAllWorkspaces(false);
    }
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  // Two near-simultaneous gear-clicks both pass the !isDestroyed check
  // before either reaches the `new BrowserWindow` below — the lock blocks
  // the second one until the window actually exists.
  if (creatingSettingsWindow) return;
  creatingSettingsWindow = true;
  const defaults = { width: 620, height: 820 };
  const savedCfg = loadSettings();
  const bounds = clampBoundsToDisplay(savedCfg.settingsWindowBounds, defaults);
  settingsWindow = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 600,
    // Top-level (no `parent`) — a parented child window on macOS follows the
    // parent across Spaces and can become unreachable. Independent window
    // shows up in Mission Control / Cmd+~ like any other.
    modal: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: "HotSpot — Settings",
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  creatingSettingsWindow = false;
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));

  // Persist bounds — debounced 500 ms trailing so a drag burst (dozens of
  // events/sec) doesn't write the settings.json over and over. Sync disk I/O
  // on every event also blocked every other IPC handler.
  let persistTimer = null;
  let lastSerializedBounds = "";
  const persistBounds = () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    let b;
    try { b = settingsWindow.getBounds(); } catch { return; }
    const sig = b.x + "," + b.y + "," + b.width + "," + b.height;
    if (sig === lastSerializedBounds) return;
    lastSerializedBounds = sig;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        const current = loadSettings();
        saveSettings({ ...current, settingsWindowBounds: b });
      } catch (_) {}
    }, 500);
  };
  settingsWindow.on("move",   persistBounds);
  settingsWindow.on("resize", persistBounds);
  // Final flush on close — the trailing-edge timer might be pending.
  settingsWindow.on("close", () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      try {
        const b = settingsWindow.getBounds();
        const current = loadSettings();
        saveSettings({ ...current, settingsWindowBounds: b });
      } catch (_) {}
    }
  });
  settingsWindow.on("closed", () => { settingsWindow = null; });

  if (!app.isPackaged) settingsWindow.webContents.openDevTools({ mode: "detach" });
}

function createTray() {
  if (process.platform === "linux") return;
  try {
    const iconPath = path.join(__dirname, "build", "tray-icon.png");
    const iconData = fs.readFileSync(iconPath);
    const icon = nativeImage.createFromBuffer(iconData, {
      width: 16, height: 16, scaleFactor: 2.0,
    });
    if (process.platform === "darwin") {
      // Template image = pure black with alpha; macOS auto-inverts for dark
      // menu bar. Without this the icon is stuck at one tone in either theme.
      icon.setTemplateImage(true);
    }
    tray = new Tray(icon);
    tray.setToolTip("HotSpot — not connected");
    rebuildTrayMenu({ connected: false });

    // Left-click (macOS) → show / focus the window
    tray.on("click", () => {
      if (!mainWindow) return;
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    });
  } catch (e) {
    console.warn("Tray creation failed:", e.message);
  }
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(
        path.join(__dirname, "build", "icon.png")
      );
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    } catch (_) {}
  }
  buildApplicationMenu();
  createWindow();
  createTray();
  startUpdateChecking();

  // After OS sleep/wake, BLE keepalive timers may have been throttled to
  // ~1/min and the GATT link is often silently dead. Forcing a reconnect
  // tick on resume gets us back faster than the next watchdog cycle.
  powerMonitor.on("resume", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("power:resume");
    }
  });
  powerMonitor.on("suspend", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("power:suspend");
    }
  });
});

// Dock click on macOS → reopen the hidden window. window-all-closed never
// fires here because we hide-instead-of-close.
app.on("activate", () => {
  if (process.platform !== "darwin") return;
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// Renderer asks us to open the landing page when the user clicks the
// update pill. URL is hardcoded so the renderer can't be tricked into
// asking us to open an arbitrary site.
ipcMain.on("update:open", () => {
  shell.openExternal(UPDATE_LANDING_URL).catch(() => {});
});

// Renderer-pull alternative to the broadcast above — fixes the race where
// the renderer's listener wasn't yet registered when the first checkForUpdates
// fired. The renderer calls this AFTER its onUpdateAvailable handler is up.
ipcMain.handle("update:check-now", async () => {
  if (cachedUpdateAvailable) return cachedUpdateAvailable;
  await checkForUpdates();
  return cachedUpdateAvailable;
});

// "I'm ready, replay anything that was waiting." Used by the renderer to
// drain late-arriving boot-time broadcasts (update pill, etc.).
ipcMain.on("renderer:ready", (e) => {
  if (cachedUpdateAvailable && e.sender) {
    e.sender.send("update:available", cachedUpdateAvailable);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Give the renderer a chance to close WSS + BLE cleanly before main exits.
    mainWindow.webContents.send("app:before-quit");
  }
});

app.on("window-all-closed", () => {
  // On macOS the convention is to leave the app running in the dock/tray
  // until the user explicitly Cmd+Q's; everywhere else, close = quit.
  if (process.platform !== "darwin") app.quit();
});

// Application menu — until now we suppressed the menu bar entirely on
// Win/Linux, which also killed Cmd+,/Ctrl+, → Settings and Cmd+R → Reload
// (dev). Build a small, platform-aware menu so the standard accelerators
// fire even when setMenuBarVisibility(false) hides the bar.
function buildApplicationMenu() {
  const isMac = process.platform === "darwin";
  const macApp = isMac ? [{
    label: "HotSpot",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { label: "Settings…", accelerator: "Cmd+,", click: () => createSettingsWindow() },
      { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  }] : [];
  const file = {
    label: "File",
    submenu: isMac ? [{ role: "close" }] : [
      { label: "Settings…", accelerator: "Ctrl+,", click: () => createSettingsWindow() },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const view = {
    label: "View",
    submenu: [
      { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    ],
  };
  const win = {
    label: "Window",
    submenu: [
      { role: "minimize" }, { role: "zoom" },
      ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]),
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([...macApp, file, view, win]));
}

ipcMain.handle("settings:load", () => loadSettings());
ipcMain.handle("settings:defaults", () => ({ ...DEFAULT_SETTINGS }));
ipcMain.handle("settings:save", (_event, partial) => {
  const current = loadSettings();
  // Allowlist + type/length validation — a hostile or compromised renderer
  // cannot poison disk or extend the persisted schema.
  const safe = validateSettingsPartial(partial);
  const updated = { ...current, ...safe };
  try {
    saveSettings(updated);
  } catch (e) {
    console.error("[settings] save failed:", e && e.message);
    return current;
  }
  // Live-broadcast to the main window so it can re-apply config without a
  // restart. The settings window already has the data it sent up.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("settings:changed", updated);
  }
  return updated;
});

ipcMain.on("settings:open-window", () => createSettingsWindow());
ipcMain.on("settings:close-window", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.close();
});

// Forward-geocode a freeform address via OpenStreetMap Nominatim.
// Lives in the main process so we can set a proper User-Agent (browsers
// block Renderer-side User-Agent overrides) and respect Nominatim policy.
// Nominatim's usage policy asks for max 1 req/s and a sensible User-Agent.
// Cap query length to stop a hostile renderer from sending megabyte-sized
// queries, and rate-limit to one call per 1500 ms.
let lastGeoLookupMs = 0;
ipcMain.handle("geo:lookup", async (_e, query) => {
  if (!query || typeof query !== "string") return null;
  const q = query.trim();
  if (!q || q.length > 200) return null;
  const now = Date.now();
  if (now - lastGeoLookupMs < 1500) return null;
  lastGeoLookupMs = now;
  const ac = new AbortController();
  const tmo = setTimeout(() => ac.abort(), 15000);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=1`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "HotSpot-Desktop-App/1.0 (+https://github.com/Guru-RF/Analog-HotSPOT-App)",
        "Accept": "application/json",
        "Accept-Language": "en",
      },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json) || !json.length) return null;
    const top = json[0];
    const lat = parseFloat(top.lat);
    const lon = parseFloat(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon, displayName: String(top.display_name || "").slice(0, 256) };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(tmo);
  }
});

ipcMain.handle("window:toggleOnTop", () => {
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  // Route through the same broadcast path the rest of settings uses so the
  // settings window (if open) sees the new value in real time too.
  const updated = { ...loadSettings(), alwaysOnTop: next };
  try { saveSettings(updated); } catch (_) {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("settings:changed", updated);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("settings:changed", updated);
  }
  return next;
});
ipcMain.handle("window:getOnTop", () => mainWindow.isAlwaysOnTop());

ipcMain.on("window:minimize", () => mainWindow.minimize());
ipcMain.on("window:close", () => mainWindow.close());

// Stable platform deviceId of the saved hotspot. Replaces the legacy
// `ble:preferred-name` channel — a name change on the hotspot side no
// longer breaks auto-connect.
ipcMain.on("ble:preferred-id", (_event, id) => {
  preferredBleId = id || "";
});

// Renderer's picker UI sends one of these. `choose` resolves the still-
// pending requestDevice() callback with the selected deviceId; `cancel`
// resolves it with "" to abort the scan. The `blePickerActive` flag used
// to gate both handlers, but the renderer now opens the picker eagerly
// (so the user sees a "Looking…" state even on macOS where Chromium's
// select-bluetooth-device event only fires when a peripheral matches the
// filter — zero matches → no event → previously no picker either). We
// resolve unconditionally; resolveBleCallback is safe when there's no
// pending callback (`if (cb)` guard inside).
ipcMain.on("ble:choose", (_event, deviceId) => {
  // The candidate list can change between render and click — a peripheral
  // that went away during the user's reaction time would no longer be in
  // `bleLatestDevices`. Resolving with a stale id makes Chromium reject
  // with NotFoundError; rejecting it ourselves with cb("") gives the
  // renderer a clean error path and keeps the picker open for retry.
  const known = bleLatestDevices.some((d) => d.deviceId === deviceId);
  resolveBleCallback(known ? deviceId : "");
});
ipcMain.on("ble:cancel-scan", () => {
  resolveBleCallback("");
});
// "Forget HotSpot" → clear the saved id so the next scan opens the picker
// even if a single hotspot is in range.
ipcMain.on("ble:forget", () => { preferredBleId = ""; });

// Tray ticker + dropdown — macOS: current talker shows next to the tray icon
// in the menu bar; right-click opens a menu with live state and actions.
// Windows: balloon notifications on new talker + the same dropdown menu.
let prevTalkerText = "";

function rebuildTrayMenu(state) {
  if (!tray) return;
  const { connected, cs, tk, ltk, tg, talkgroups } = state || {};
  const dash = "\u2014";

  const template = [];
  if (connected) {
    template.push(
      { label: `HotSpot: ${cs || dash}`, enabled: false },
      { label: `TG ${tg || dash}`, enabled: false },
      { type: "separator" },
      { label: `Current: ${tk || dash}`, enabled: false },
      { label: `Last: ${ltk || dash}`, enabled: false },
    );

    // Talkgroup quick-switch submenu. Clicking sends `91<tg>#` via DTMF,
    // same convention as the in-app TG bar.
    if (Array.isArray(talkgroups) && talkgroups.length) {
      template.push(
        { type: "separator" },
        {
          label: "Switch talkgroup",
          submenu: talkgroups.map((t) => ({
            label: t.label ? `${t.tg} — ${t.label}` : t.tg,
            type: "checkbox",
            checked: String(tg || "") === String(t.tg),
            click: () => {
              if (!mainWindow || mainWindow.isDestroyed()) return;
              mainWindow.webContents.send("ble:send-dtmf", `91${t.tg}#`);
            },
          })),
        },
      );
    }
  } else {
    template.push({ label: "Not connected", enabled: false });
  }
  template.push(
    { type: "separator" },
    {
      label: "Show HotSpot",
      click: () => {
        if (!mainWindow) return;
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      },
    },
    { label: "Quit HotSpot", role: "quit" },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

ipcMain.on("tray:state", (_event, state) => {
  if (!tray) return;
  const { connected, tk, ltk } = state || {};

  // Menu bar title: only show the active talker's callsign. Blank when nobody
  // is keying or when we're disconnected — avoids a constant "·" next to the icon.
  if (process.platform === "darwin") tray.setTitle(connected && tk ? tk : "");

  tray.setToolTip(
    !connected
      ? "HotSpot — not connected"
      : tk
        ? `Talking: ${tk}`
        : ltk
          ? `Last: ${ltk}`
          : "HotSpot",
  );

  // Toast on new-talker. tray.displayBalloon is the legacy Win32 balloon
  // API and is silently dead on Win10/11 in many configurations; the
  // Notification API drives the proper OS toast pipeline on every platform.
  if (tk && tk !== prevTalkerText && Notification.isSupported()) {
    try {
      new Notification({
        title: "HotSpot",
        body: `Talking: ${tk}`,
        silent: true,
      }).show();
    } catch (_) {}
  }
  prevTalkerText = tk || "";

  rebuildTrayMenu(state);
});
