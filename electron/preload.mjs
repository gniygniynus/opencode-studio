import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("opencodeDesktop", {
  isDesktop: true,
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  getPassthrough: () => ipcRenderer.invoke("window:getPassthrough"),
  setPassthrough: (enabled) => ipcRenderer.invoke("window:setPassthrough", Boolean(enabled)),
  windowControl: (action) => ipcRenderer.invoke("window:control", String(action || "")),
});
