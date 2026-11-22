import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("opencodeDesktop", {
  isDesktop: true,
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", String(url || "")),
});
