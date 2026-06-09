const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  getDefaults: () => ipcRenderer.invoke("settings:defaults"),
  updateTrayState: (state) => ipcRenderer.send("tray:state", state),
  setPreferredBleId: (id) => ipcRenderer.send("ble:preferred-id", id),

  // BLE picker — multi-hotspot flow (mirrors mobile)
  onBleCandidates: (cb) =>
    ipcRenderer.on("ble:candidates", (_e, payload) => cb(payload)),
  bleChoose: (deviceId) => ipcRenderer.send("ble:choose", deviceId),
  bleCancelScan: () => ipcRenderer.send("ble:cancel-scan"),
  bleForget: () => ipcRenderer.send("ble:forget"),

  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),

  toggleOnTop: () => ipcRenderer.invoke("window:toggleOnTop"),
  getOnTop: () => ipcRenderer.invoke("window:getOnTop"),

  // Settings window
  openSettingsWindow: () => ipcRenderer.send("settings:open-window"),
  closeSettingsWindow: () => ipcRenderer.send("settings:close-window"),
  onSettingsChanged: (cb) =>
    ipcRenderer.on("settings:changed", (_e, cfg) => cb(cfg)),

  // Forward-geocode a freeform address via Nominatim (main process owns the
  // User-Agent header so we comply with the OSM usage policy).
  geoLookup: (query) => ipcRenderer.invoke("geo:lookup", query),

  // Tray → renderer: request to send a DTMF string (e.g. "91<tg>#") over BLE
  onSendDtmfRequest: (cb) =>
    ipcRenderer.on("ble:send-dtmf", (_e, dtmf) => cb(dtmf)),

  // Update pill
  onUpdateAvailable: (cb) =>
    ipcRenderer.on("update:available", (_e, info) => cb(info)),
  openUpdateUrl: () => ipcRenderer.send("update:open"),
  checkUpdateNow: () => ipcRenderer.invoke("update:check-now"),

  // "I'm ready" — drains any update broadcast that fired before the
  // renderer's listener was wired.
  rendererReady: () => ipcRenderer.send("renderer:ready"),

  // Power state — give the BLE/WSS code a chance to flush/reconnect cleanly
  // around OS sleep/wake.
  onPowerSuspend: (cb) => ipcRenderer.on("power:suspend", () => cb()),
  onPowerResume:  (cb) => ipcRenderer.on("power:resume",  () => cb()),

  // Last-chance signal before main quits — close WSS + BLE cleanly.
  onBeforeQuit: (cb) => ipcRenderer.on("app:before-quit", () => cb()),
});
