import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("opencodeDesktop", {
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
});
