/**
 * Electron Main Process for OpenCode Studio (Windows / macOS / Linux).
 *
 * Guarantees single-instance local server + native OS directory picker +
 * multi-window support sharing one singleton backend over localhost.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverHandle = null;
let mainWindow = null;

// Single-instance lock guarantees no duplicate backend processes or DB races
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (serverHandle?.url) {
      createWindow(serverHandle.url);
    }
  });
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: "OpenCode Studio",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadURL(url);

  // Open external http(s) links in user's default system browser
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:\/\//i.test(targetUrl) && !targetUrl.startsWith(url)) {
      shell.openExternal(targetUrl);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (!mainWindow) {
    mainWindow = win;
    win.on("closed", () => {
      mainWindow = null;
    });
  }
  return win;
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
          click: () => createWindow(url),
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

app.whenReady().then(async () => {
  try {
    try {
      serverHandle = await startServer({ host: "127.0.0.1", port: 17620 });
    } catch {
      serverHandle = await startServer({ host: "127.0.0.1", port: 0 });
    }
    buildAppMenu(serverHandle.url);
    createWindow(serverHandle.url);
  } catch (err) {
    dialog.showErrorBox("OpenCode Studio 启动失败", String(err?.stack || err));
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverHandle?.url) {
      createWindow(serverHandle.url);
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
