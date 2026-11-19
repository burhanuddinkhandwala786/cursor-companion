const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  onState: (cb) => ipcRenderer.on("hud-state", (_e, data) => cb(data)),
  onSnipInit: (cb) => ipcRenderer.on("snip-init", (_e, data) => cb(data)),
  completeSnip: (rect) => ipcRenderer.send("snip-complete", rect),
  cancelSnip: () => ipcRenderer.send("snip-cancel"),
  sendFollowUp: (text) => ipcRenderer.send("hud-followup", text),
  sendSpotlightQuery: (text) => ipcRenderer.send("hud-spotlight-query", text),
  saveApiKey: (key) => ipcRenderer.send("hud-save-key", key),
  copyText: (text) => ipcRenderer.send("hud-copy", text),
  selectHistory: (idx) => ipcRenderer.send("hud-select-history", idx),
  closeSpotlight: () => ipcRenderer.send("hud-close-spotlight"),
  closeSidecar: () => ipcRenderer.send("hud-close-sidecar"),
  hideHud: () => ipcRenderer.send("hud-hide"),
});