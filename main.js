const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// Force the menu-bar / About / Quit labels to "HotSpot" regardless of the npm
// package `name`. Must run before app.whenReady().
app.setName("HotSpot");

let mainWindow;
let settingsWindow = null;
let tray = null;
let preferredBleName = "";

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

function loadSettings() {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) {
      const saved = JSON.parse(fs.readFileSync(p, "utf-8"));
      // Treat empty objects as "not set" so defaults are used instead
      if (!saved.talkgroupInfo || !Object.keys(saved.talkgroupInfo).length)
        delete saved.talkgroupInfo;
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
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
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.setMenuBarVisibility(false);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Kick off silent BLE auto-reconnect after the renderer is ready.
  // executeJavaScript with userGesture=true lets requestDevice() run without a click.
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(
      "typeof window.bleAutoReconnectOnStartup === 'function' && window.bleAutoReconnectOnStartup();",
      true
    ).catch(() => {});
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Web Bluetooth picker — auto-select the last-paired device, or the first
  // match. requestDevice() already filtered by our service UUID, so anything
  // in `devices` is a HotSpot-protocol peer — picking the first after a short
  // grace period is safe even if the saved name doesn't show up (renamed box,
  // a different unit at a club site, etc.). Without that fallback the picker
  // would wait the full timeout and then cancel, hiding an in-range hotspot
  // whose advertised name simply differs from the one we saw last time.
  let bleScanTimeout = null;
  let bleFallbackTimeout = null;
  let bleCurrentCallback = null;
  let bleLatestDevices = [];
  const clearBleTimers = () => {
    if (bleScanTimeout)     { clearTimeout(bleScanTimeout);     bleScanTimeout = null; }
    if (bleFallbackTimeout) { clearTimeout(bleFallbackTimeout); bleFallbackTimeout = null; }
  };
  mainWindow.webContents.on("select-bluetooth-device", (event, devices, callback) => {
    event.preventDefault();
    bleCurrentCallback = callback;
    bleLatestDevices = devices;
    const preferred = preferredBleName;
    const exact = preferred && devices.find((d) => d.deviceName === preferred);
    if (exact) {
      clearBleTimers();
      bleCurrentCallback = null;
      return callback(exact.deviceId);
    }
    if (devices.length > 0 && !preferred) {
      clearBleTimers();
      bleCurrentCallback = null;
      return callback(devices[0].deviceId);
    }
    // Saved name set but not (yet) seen: wait briefly in case it advertises
    // late, then fall back to whatever HotSpot device is already visible.
    if (devices.length > 0 && preferred && !bleFallbackTimeout) {
      bleFallbackTimeout = setTimeout(() => {
        bleFallbackTimeout = null;
        const cb = bleCurrentCallback;
        bleCurrentCallback = null;
        if (!cb) return;
        const list = bleLatestDevices;
        const pick = (preferred && list.find((d) => d.deviceName === preferred)) || list[0];
        try { cb(pick ? pick.deviceId : ""); } catch (_) {}
      }, 3000);
    }
    // Hard cap: cancel after 15 s if we never see any device.
    if (!bleScanTimeout) {
      bleScanTimeout = setTimeout(() => {
        bleScanTimeout = null;
        const cb = bleCurrentCallback;
        bleCurrentCallback = null;
        if (cb) try { cb(""); } catch (_) {}
      }, 15000);
    }
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === "bluetooth";
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return ["bluetooth", "bluetooth-devices", "geolocation", "clipboard-sanitized-write"].includes(permission);
  });
  // Auto-grant geolocation requests (the Map screen uses navigator.geolocation
  // to seed Home QTH). Electron's default handler denies without prompting.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
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
  // Pull at least 32px into the work area so the titlebar is always grabbable.
  const minVisible = 32;
  let x = bounds.x;
  let y = bounds.y;
  if (x + w < wa.x + minVisible) x = wa.x;
  if (y + minVisible > wa.y + wa.height) y = wa.y;
  if (x > wa.x + wa.width - minVisible) x = wa.x + wa.width - w;
  if (y < wa.y) y = wa.y;
  // Shrink if larger than the chosen display.
  const cw = Math.min(w, wa.width);
  const ch = Math.min(h, wa.height);
  return { x: Math.round(x), y: Math.round(y), width: cw, height: ch };
}

// ── Update check ──────────────────────────────────────────────────────────────
// Poll GitHub's "latest release" endpoint at startup and once a day after.
// If the tag (stripped of its leading "v") is higher than app.getVersion(),
// the renderer is told to show a red "update available" pill in the title
// bar. Click → main process opens the landing page in the system browser.
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_RELEASES_URL = "https://api.github.com/repos/Guru-RF/Analog-HotSPOT-App/releases/latest";
const UPDATE_LANDING_URL = "https://svxlink-hotspot.app";

function isNewerVersion(remote, local) {
  const pa = String(remote).split(".").map((n) => Number(n) || 0);
  const pb = String(local).split(".").map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const a = pa[i] || 0;
    const b = pb[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function checkForUpdates() {
  try {
    const res = await fetch(UPDATE_RELEASES_URL, {
      headers: {
        "User-Agent": "HotSpot-Desktop-App",
        "Accept": "application/vnd.github+json",
      },
    });
    if (!res.ok) return;
    const json = await res.json();
    const latest = String(json.tag_name || "").replace(/^v/, "").trim();
    if (!latest) return;
    const current = app.getVersion();
    if (!isNewerVersion(latest, current)) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update:available", {
        version: latest,
        url: UPDATE_LANDING_URL,
      });
    }
  } catch (_) {}
}

function startUpdateChecking() {
  // Slight delay so the renderer's IPC listener is registered before the
  // first broadcast fires.
  setTimeout(checkForUpdates, 5000);
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
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
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));

  // Persist bounds so we can clamp + restore next time.
  const persistBounds = () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    try {
      const b = settingsWindow.getBounds();
      const current = loadSettings();
      saveSettings({ ...current, settingsWindowBounds: b });
    } catch (_) {}
  };
  settingsWindow.on("move",   persistBounds);
  settingsWindow.on("resize", persistBounds);
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
  createWindow();
  createTray();
  startUpdateChecking();
});

// Renderer asks us to open the landing page when the user clicks the
// update pill. URL is hardcoded so the renderer can't be tricked into
// asking us to open an arbitrary site.
ipcMain.on("update:open", () => {
  shell.openExternal(UPDATE_LANDING_URL).catch(() => {});
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle("settings:load", () => loadSettings());
ipcMain.handle("settings:defaults", () => ({ ...DEFAULT_SETTINGS }));
ipcMain.handle("settings:save", (_event, partial) => {
  const current = loadSettings();
  const updated = { ...current, ...partial };
  saveSettings(updated);
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
ipcMain.handle("geo:lookup", async (_e, query) => {
  if (!query || typeof query !== "string") return null;
  const q = query.trim();
  if (!q) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=1`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "HotSpot-Desktop-App/1.0 (+https://github.com/Guru-RF/Analog-HotSPOT-App)",
        "Accept": "application/json",
        "Accept-Language": "en",
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!Array.isArray(json) || !json.length) return null;
    const top = json[0];
    const lat = parseFloat(top.lat);
    const lon = parseFloat(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, displayName: top.display_name || "" };
  } catch (_) {
    return null;
  }
});

ipcMain.handle("window:toggleOnTop", () => {
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  const s = loadSettings();
  s.alwaysOnTop = next;
  saveSettings(s);
  return next;
});
ipcMain.handle("window:getOnTop", () => mainWindow.isAlwaysOnTop());

ipcMain.on("window:minimize", () => mainWindow.minimize());
ipcMain.on("window:close", () => mainWindow.close());

ipcMain.on("ble:preferred-name", (_event, name) => {
  preferredBleName = name || "";
});

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

  // Windows toast: only when a *new* talker keys up
  if (process.platform === "win32" && tk && tk !== prevTalkerText) {
    tray.displayBalloon({
      title: "HotSpot",
      content: `Talking: ${tk}`,
      iconType: "info",
    });
  }
  prevTalkerText = tk || "";

  rebuildTrayMenu(state);
});
