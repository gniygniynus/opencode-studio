"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Fetch per-instance desktop session token synchronously or via promise from main process
let cachedTokenPromise = null;
function getAuthToken() {
  if (!cachedTokenPromise) {
    cachedTokenPromise = ipcRenderer.invoke("desktop:getAuthToken").catch(() => "");
  }
  return cachedTokenPromise;
}

ipcRenderer.on("updater:progress", (_ev, payload) => {
  window.dispatchEvent(new CustomEvent("ocs-updater-progress", { detail: payload }));
});

contextBridge.exposeInMainWorld("opencodeDesktop", {
  isDesktop: true,
  platform: process.platform,
  getAuthToken,
  pickDirectory: (defaultPath = "") => ipcRenderer.invoke("dialog:pickDirectory", String(defaultPath || "")),
  saveMarkdownFile: (defaultName, content) =>
    ipcRenderer.invoke("dialog:saveMarkdownFile", {
      defaultName: String(defaultName || "conversation.md"),
      content: String(content || ""),
    }),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", String(url || "")),
  setTheme: (theme) => ipcRenderer.invoke("window:setTheme", String(theme || "light")),
  downloadAndInstallUpdate: (url, fileName) =>
    ipcRenderer.invoke("updater:downloadAndInstall", {
      url: String(url || ""),
      fileName: String(fileName || "OpenCode-Studio-Setup.exe"),
    }),
});
