/**
 * Electron Main Process for OpenCode Studio (Windows / macOS / Linux).
 *
 * Guarantees:
 *  - Single-instance local server + native OS directory picker + multi-window collaboration
 *  - Native Transparent Wallpaper Engine Passthrough Mode (`transparent: true, frame: false`):
 *    Lets the user's real Wallpaper Engine (DirectX 4K 60fps Scene / Video / Web / Application)
 *    shine directly behind OpenCode Studio with 0% quality loss, 0% content modification,
 *    and 0 MB extra disk/VRAM duplication!
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllSettings, setSetting } from "../server/db.mjs";
import { startServer } from "../server/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverHandle = null;
let mainWindow = null;
let passthroughEnabled = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (serverHandle?.url) {
      createWindow(serverHandle.url, passthroughEnabled);
    }
  });
}

function createWindow(url, transparentMode = false, restoreBounds = null) {
  const winOpts = {
    width: restoreBounds?.width || 1360,
    height: restoreBounds?.height || 860,
    ...(restoreBounds?.x !== undefined ? { x: restoreBounds.x, y: restoreBounds.y } : {}),
    minWidth: 960,
    minHeight: 620,
    title: "OpenCode Studio",
    autoHideMenuBar: true,
    frame: !transparentMode,
    transparent: Boolean(transparentMode),
    hasShadow: !transparentMode,
    backgroundColor: transparentMode ? "#00000000" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  const win = new BrowserWindow(winOpts);
  const targetUrl = transparentMode ? `${url}${url.includes("?") ? "&" : "?"}desktop_passthrough=1` : url;
  win.loadURL(targetUrl);

  win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (/^https?:\/\//i.test(nextUrl) && !nextUrl.startsWith(url)) {
      shell.openExternal(nextUrl);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = win;
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });
  }
  return win;
}

function toggleDesktopPassthrough(enable) {
  const next = Boolean(enable);
  passthroughEnabled = next;
  try {
    const curWe = getAllSettings().wallpaper_engine || {};
    setSetting("wallpaper_engine", { ...curWe, passthrough: next });
  } catch {}

  if (!serverHandle?.url) return { ok: true, passthrough: next };
  const oldWin = BrowserWindow.getFocusedWindow() || mainWindow;
  const bounds = oldWin && !oldWin.isDestroyed() ? oldWin.getBounds() : null;
  const nextWin = createWindow(serverHandle.url, next, bounds);
  mainWindow = nextWin;
  nextWin.on("closed", () => {
    if (mainWindow === nextWin) mainWindow = null;
  });
  if (oldWin && !oldWin.isDestroyed() && oldWin !== nextWin) {
    oldWin.destroy();
  }
  return { ok: true, passthrough: next };
}

function buildAppMenu(url) {
  const template = [
    ...(process.platform === "darwin"
      ? [{ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] }]
      : []),
    {
      label: "窗口",
      submenu: [
        {
          label: "新建协作窗口（共享同一本地服务）",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => createWindow(url, passthroughEnabled),
        },
        {
          label: "切换 Wallpaper Engine 原生无损透视背景",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => toggleDesktopPassthrough(!passthroughEnabled),
        },
        {
          label: "在系统浏览器中打开",
          click: () => shell.openExternal(url),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("dialog:pickDirectory", async () => {
  const parent = BrowserWindow.getFocusedWindow() || mainWindow || undefined;
  const opts = {
    properties: ["openDirectory", "createDirectory"],
    title: "选择 OpenCode Studio 工作目录",
  };
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths?.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("window:getPassthrough", () => passthroughEnabled);

ipcMain.handle("window:setPassthrough", (_ev, enabled) => toggleDesktopPassthrough(Boolean(enabled)));

ipcMain.handle("window:control", (ev, action) => {
  const win = BrowserWindow.fromWebContents(ev.sender) || mainWindow;
  if (!win || win.isDestroyed()) return false;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === "close") win.close();
  return true;
});

app.whenReady().then(async () => {
  try {
    try {
      serverHandle = await startServer({ host: "127.0.0.1", port: 17620 });
    } catch {
      serverHandle = await startServer({ host: "127.0.0.1", port: 0 });
    }
    try {
      passthroughEnabled = Boolean(getAllSettings().wallpaper_engine?.passthrough);
    } catch {
      passthroughEnabled = false;
    }
    buildAppMenu(serverHandle.url);
    createWindow(serverHandle.url, passthroughEnabled);
  } catch (err) {
    dialog.showErrorBox("OpenCode Studio 启动失败", String(err?.stack || err));
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverHandle?.url) {
      createWindow(serverHandle.url, passthroughEnabled);
    }
  });
});

app.on("before-quit", async () => {
  if (serverHandle) {
    await serverHandle.stop().catch(() => {});
    serverHandle = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
