/**
 * Pure Standalone Native Desktop Shell for OpenCode Studio (Windows / macOS / Linux).
 *
 * Security & Native Desktop Guarantees:
 *  - Isolated dynamic loopback port (`port: 0`) + cryptographic boot handshake (`desktopMode: true`):
 *    blocks all external web browsers and cross-site attacks (0 web-wrapper exposure).
 *  - Hardware renderer sandbox (`sandbox: true` + `contextIsolation: true`) with strict sender origin checks.
 *  - Immersive native frameless titleBarOverlay (Windows/Linux) & hiddenInset traffic lights (macOS)
 *    with persistent window bounds & maximize state.
 *  - Built-in native OS folder picker, native Save-As dialog, and in-app installer download & launch.
 *  - Automatic `--no-sandbox` compatibility switch on Linux (Ubuntu 24.04+ AppImage / deb).
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getAllSettings } from "../server/db.mjs";
import { startServer } from "../server/index.mjs";
import { getPaths } from "../server/paths.mjs";
import { proxyFetch } from "../server/runtime_utils.mjs";
import { isSafePublicUrl } from "../server/security.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure local 127.0.0.1 / localhost traffic NEVER detours through Clash / OS HTTP proxy
app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>;127.0.0.1;localhost");
// Ubuntu 24.04+ / Debian 13 AppArmor restricts unprivileged userns inside FUSE AppImage mounts
if (process.platform === "linux") {
  app.commandLine.appendSwitch("no-sandbox");
}

let serverHandle = null;
let mainWindow = null;
let allowedOrigin = "";

function getWindowStatePath() {
  return path.join(getPaths().dataRoot, "window-state.json");
}

function loadWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(getWindowStatePath(), "utf8"));
    const width = Math.max(960, Number(raw.width) || 1380);
    const height = Math.max(640, Number(raw.height) || 860);
    const state = { width, height, isMaximized: Boolean(raw.isMaximized) };
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      state.x = raw.x;
      state.y = raw.y;
    }
    return state;
  } catch {
    return { width: 1380, height: 860, isMaximized: false };
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(
      getWindowStatePath(),
      JSON.stringify({ ...bounds, isMaximized }, null, 2),
      "utf8",
    );
  } catch {}
}

function isSameTrustedOrigin(rawUrl) {
  if (!allowedOrigin || !rawUrl) return false;
  try {
    return new URL(rawUrl).origin === allowedOrigin;
  } catch {
    return false;
  }
}

function isTrustedSender(ev) {
  const frameUrl = ev?.senderFrame?.url || ev?.sender?.getURL?.() || "";
  return isSameTrustedOrigin(frameUrl);
}

function isSafeExternalProtocol(rawUrl) {
  try {
    const p = new URL(rawUrl).protocol.toLowerCase();
    return p === "https:" || p === "http:" || p === "steam:";
  } catch {
    return false;
  }
}

function resolveWindowIcon() {
  const ext = process.platform === "win32" ? "icon.ico" : "icon.png";
  const candidate = path.resolve(__dirname, "..", "build", ext);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function getTitleBarOverlayOptions(isDark) {
  return {
    color: "#00000000",
    symbolColor: isDark ? "#e5e7eb" : "#1f2937",
    height: 53,
  };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const targetWin = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
    if (targetWin) {
      if (targetWin.isMinimized()) targetWin.restore();
      targetWin.focus();
    } else if (serverHandle?.desktopBootUrl) {
      createWindow(serverHandle.desktopBootUrl);
    }
  });
}

function createWindow(bootUrl) {
  const saved = loadWindowState();
  const isDark = nativeTheme.shouldUseDarkColors;
  const iconPath = resolveWindowIcon();

  const winOpts = {
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: isDark ? "#0f1116" : "#f9fafb",
    title: "OpenCode Studio",
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 18 },
        }
      : {
          titleBarStyle: "hidden",
          titleBarOverlay: getTitleBarOverlayOptions(isDark),
        }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };

  const win = new BrowserWindow(winOpts);
  win.setMenuBarVisibility(false);

  win.once("ready-to-show", () => {
    if (saved.isMaximized) win.maximize();
    win.show();
  });

  let saveTimer = null;
  const scheduleBoundsSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 250);
  };
  win.on("resize", scheduleBoundsSave);
  win.on("move", scheduleBoundsSave);
  win.on("close", () => saveWindowState(win));

  win.loadURL(bootUrl);

  // Strictly deny any child BrowserWindow creation; route safe external URLs to OS desktop
  win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (!isSameTrustedOrigin(nextUrl) && isSafeExternalProtocol(nextUrl)) {
      shell.openExternal(nextUrl).catch(() => {});
    }
    return { action: "deny" };
  });

  // Strictly block top-level navigation away from the isolated desktop app origin
  win.webContents.on("will-navigate", (ev, nextUrl) => {
    if (!isSameTrustedOrigin(nextUrl)) {
      ev.preventDefault();
      if (isSafeExternalProtocol(nextUrl)) {
        shell.openExternal(nextUrl).catch(() => {});
      }
    }
  });

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = win;
  }
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
    }
  });
  return win;
}

function buildAppMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [{ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] }]
      : []),
    {
      label: "窗口",
      submenu: [
        {
          label: "新建独立工作窗口",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            if (serverHandle?.desktopBootUrl) createWindow(serverHandle.desktopBootUrl);
          },
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

ipcMain.handle("desktop:getAuthToken", (ev) => {
  if (!isTrustedSender(ev)) return "";
  return serverHandle?.authToken || "";
});

ipcMain.handle("window:setTheme", (ev, theme) => {
  if (!isTrustedSender(ev)) return false;
  const isDark = theme === "dark";
  if (process.platform !== "darwin") {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && typeof w.setTitleBarOverlay === "function") {
        try {
          w.setTitleBarOverlay(getTitleBarOverlayOptions(isDark));
        } catch {}
      }
    }
  }
  return true;
});

ipcMain.handle("dialog:pickDirectory", async (ev, defaultPath = "") => {
  if (!isTrustedSender(ev)) return null;
  const parent = BrowserWindow.fromWebContents(ev.sender) || mainWindow || undefined;
  const opts = {
    properties: ["openDirectory", "createDirectory"],
    title: "选择工作目录",
    ...(defaultPath && fs.existsSync(defaultPath) ? { defaultPath } : {}),
  };
  const res = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths?.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("dialog:saveMarkdownFile", async (ev, { defaultName = "conversation.md", content = "" } = {}) => {
  if (!isTrustedSender(ev)) return { ok: false, canceled: true };
  const parent = BrowserWindow.fromWebContents(ev.sender) || mainWindow || undefined;
  const safeBase = path.basename(String(defaultName || "conversation.md"));
  const opts = {
    title: "导出对话记录 (Markdown)",
    defaultPath: path.join(app.getPath("documents"), safeBase.endsWith(".md") ? safeBase : `${safeBase}.md`),
    filters: [{ name: "Markdown 文档", extensions: ["md"] }],
  };
  const res = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(res.filePath, String(content || ""), "utf8");
  return { ok: true, filePath: res.filePath };
});

ipcMain.handle("shell:openExternal", async (ev, targetUrl) => {
  if (!isTrustedSender(ev)) return false;
  if (isSafeExternalProtocol(targetUrl)) {
    await shell.openExternal(targetUrl);
    return true;
  }
  return false;
});

ipcMain.handle("updater:downloadAndInstall", async (ev, { url, fileName } = {}) => {
  if (!isTrustedSender(ev)) return { ok: false, error: "未授权请求" };
  if (!isSafePublicUrl(url)) return { ok: false, error: "安装包下载链接无效" };

  const safeName = path.basename(String(fileName || "OpenCode-Studio-Update")).replace(/[^\w.-]+/g, "_");
  const destDir = path.join(os.tmpdir(), "opencode-studio-updates");
  fs.mkdirSync(destDir, { recursive: true });
  const tmpFile = path.join(destDir, `${safeName}.part`);
  const finalFile = path.join(destDir, safeName);

  const sendProgress = (data) => {
    try {
      if (!ev.sender.isDestroyed()) ev.sender.send("updater:progress", data);
    } catch {}
  };

  try {
    const proxyUrl = getAllSettings().search_engine?.proxy_url || "";
    let curUrl = url;
    let res = null;
    for (let hop = 0; hop <= 5; hop++) {
      res = await proxyFetch(curUrl, {
        headers: { "User-Agent": "OpenCodeStudio-DesktopUpdater/2.3" },
        proxyUrl,
        maxBytes: 600 * 1024 * 1024,
        streamBody: true,
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel?.(); } catch {}
        if (!loc || hop === 5) throw new Error(`重定向异常 (HTTP ${res.status})`);
        curUrl = new URL(loc, curUrl).toString();
        if (!isSafePublicUrl(curUrl)) throw new Error("更新重定向地址不安全");
        continue;
      }
      break;
    }
    if (!res || !res.ok || !res.body) {
      throw new Error(`下载返回 HTTP ${res?.status || "ERR"}`);
    }

    const totalBytes = Number(res.headers.get("content-length") || 0);
    const ws = fs.createWriteStream(tmpFile);
    const reader = res.body.getReader();
    let downloaded = 0;
    const t0 = Date.now();
    let lastEmit = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (!ws.write(chunk)) {
          await new Promise((r) => ws.once("drain", r));
        }
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 120) {
          lastEmit = now;
          const speedMbps = Number((downloaded / (1024 * 1024) / Math.max(0.1, (now - t0) / 1000)).toFixed(2));
          const pct = totalBytes > 0 ? Math.min(99, Math.round((downloaded / totalBytes) * 100)) : 50;
          sendProgress({
            percent: pct,
            downloaded_mb: Number((downloaded / (1024 * 1024)).toFixed(1)),
            total_mb: totalBytes > 0 ? Number((totalBytes / (1024 * 1024)).toFixed(1)) : null,
            speed_mbps: speedMbps,
          });
        }
      }
    }
    await new Promise((resolve, reject) => {
      ws.end(() => resolve());
      ws.on("error", reject);
    });
    try { if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile); } catch {}
    fs.renameSync(tmpFile, finalFile);
    if (process.platform !== "win32") {
      try { fs.chmodSync(finalFile, 0o755); } catch {}
    }
    sendProgress({ percent: 100 });
    const openErr = await shell.openPath(finalFile);
    if (openErr) {
      shell.showItemInFolder(finalFile);
      return { ok: true, filePath: finalFile, openedFolder: true };
    }
    return { ok: true, filePath: finalFile, launched: true };
  } catch (err) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
    return { ok: false, error: err.message };
  }
});

let isQuitting = false;
app.on("before-quit", async (ev) => {
  if (isQuitting) return;
  isQuitting = true;
  if (serverHandle) {
    ev.preventDefault();
    try {
      await serverHandle.stop();
    } catch {}
    serverHandle = null;
    closeDb();
    app.quit();
  } else {
    closeDb();
  }
});

app.whenReady().then(async () => {
  try {
    // Pure Desktop Isolation: bind to ephemeral port 0 + require instance auth token
    serverHandle = await startServer({
      host: "127.0.0.1",
      port: 0,
      desktopMode: true,
      requireAuth: true,
    });
    allowedOrigin = new URL(serverHandle.url).origin;
    buildAppMenu();
    createWindow(serverHandle.desktopBootUrl);
  } catch (err) {
    dialog.showErrorBox("OpenCode Studio 启动失败", String(err?.stack || err));
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverHandle?.desktopBootUrl) {
      createWindow(serverHandle.desktopBootUrl);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
