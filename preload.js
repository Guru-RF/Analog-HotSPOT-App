const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),
  getDefaults: () => ipcRenderer.invoke("settings:defaults"),
  updateTrayState: (state) => ipcRenderer.send("tray:state", state),
  setPreferredBleName: (name) => ipcRenderer.send("ble:preferred-name", name),

  minimize: () => ipcRenderer.send("window:minimize"),
  close: () => ipcRenderer.send("window:close"),

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
});
