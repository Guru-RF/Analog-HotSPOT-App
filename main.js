const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// Force the menu-bar / About / Quit labels to "HotSpot" regardless of the npm
// package `name`. Must run before app.whenReady().
app.setName("HotSpot");

let mainWindow;
let tray = null;
let preferredBleName = "";

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

const DEFAULT_SETTINGS = {
  title: "HotSpot",
  alwaysOnTop: false,
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
  // Map / home QTH
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
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle("settings:load", () => loadSettings());
ipcMain.handle("settings:defaults", () => ({ ...DEFAULT_SETTINGS }));
ipcMain.handle("settings:save", (_event, settings) => {
  const current = loadSettings();
  saveSettings({ ...current, ...settings });
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
