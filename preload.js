const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hud", {
  onState: (cb) => {
    if (typeof cb !== "function") return;
    ipcRenderer.removeAllListeners("hud-state");
    ipcRenderer.on("hud-state", (_event, data) => cb(data));
  },
  sendSpotlightQuery: (query) => ipcRenderer.send("hud-spotlight-query", query),
  sendFollowup: (query) => ipcRenderer.send("hud-followup", query),
  saveApiKey: (key) => ipcRenderer.send("hud-save-key", key),
  copyText: (text) => ipcRenderer.send("hud-copy", text),
  selectHistory: (idx) => ipcRenderer.send("hud-select-history", idx),
  closeSpotlight: () => ipcRenderer.send("hud-close-spotlight"),
  closeSidecar: () => ipcRenderer.send("hud-close-sidecar"),
  hideHud: () => ipcRenderer.send("hud-hide"),
  openUpdate: () => ipcRenderer.send("hud-open-update"),
  dismissUpdate: (version) => ipcRenderer.send("hud-dismiss-update", version),
  checkUpdate: () => ipcRenderer.send("hud-check-update"),
});
