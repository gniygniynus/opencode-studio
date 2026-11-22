/**
 * Steam Wallpaper Engine (AppID 431960) Live Sync & Zero-Copy Lossless Bridge.
 *
 * Core Principles (Zero Quality Loss, Zero Content Tampering):
 *  1. Launch official Wallpaper Engine (`steam://rungameid/431960` or `wallpaper64.exe`)
 *     so the user logs into Steam and chooses any wallpaper directly inside Wallpaper Engine.
 *  2. After explicit user authorization, read & live-watch Wallpaper Engine's `config.json`
 *     (`selectedwallpapers.Monitor0.file`) to automatically detect the user's active wallpaper.
 *  3. True Lossless Rendering:
 *     - `video` (.mp4/.webm/.mov/.mkv — hundreds of MB to multi-GB 4K/8K animations):
 *         Served directly from its original disk location via HTTP 206 Byte-Range streaming
 *         (0 MB copied, 0 transcoding, 0 downscaling, 0 content modification).
 *     - `web` (HTML5/WebGL/Canvas):
 *         Served directly from its original project folder inside a sandboxed iframe (100% original).
 *     - `image` (original local 4K PNG/JPG/WebP):
 *         Served directly from disk with zero compression or downscaling.
 *     - `scene` (Wallpaper Engine proprietary DirectX 3D `.pkg` engine):
 *         NEVER fakes 4K with low-res `preview.gif` or incomplete single-layer textures!
 *         Uses Desktop Native Transparent Passthrough so Wallpaper Engine itself renders the
 *         100% original 4K 60fps 3D scene/particles/shaders/audio directly behind OpenCode Studio.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logEvent } from "./logger.mjs";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

const STREAM_MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

let _itemIndex = new Map();
let _lastScanDirsKey = "";
let _lastScanItems = [];
let _configWatcher = null;
let _watchedConfigDir = "";

function hashId(str) {
  return crypto.createHash("sha1").update(String(str)).digest("hex").slice(0, 14);
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isPathInsideDir(targetPath, rootDir) {
  if (!targetPath || !rootDir) return false;
  const realTarget = safeRealpath(targetPath);
  const realRoot = safeRealpath(rootDir);
  const a = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
  const b = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  if (a === b) return true;
  const sep = path.sep;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export function isPathInsideAuthorizedDirs(targetPath, authorizedDirs = []) {
  for (const dir of authorizedDirs || []) {
    if (dir && fs.existsSync(dir) && isPathInsideDir(targetPath, dir)) return true;
  }
  return false;
}

function discoverSteamLibraries() {
  const steamRoots = new Set();

  if (process.platform === "win32") {
    for (const regKey of [
      "HKCU\\Software\\Valve\\Steam",
      "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam",
      "HKLM\\SOFTWARE\\Valve\\Steam",
    ]) {
      for (const valName of ["SteamPath", "InstallPath"]) {
        try {
          const r = spawnSync("reg.exe", ["query", regKey, "/v", valName], {
            encoding: "utf8",
            timeout: 3000,
            windowsHide: true,
          });
          if (r.status === 0 && r.stdout) {
            const m = r.stdout.match(/REG_SZ\s+(.+)/i);
            if (m && m[1]) {
              const p = path.resolve(m[1].trim().replace(/\//g, "\\"));
              if (fs.existsSync(p)) steamRoots.add(p);
            }
          }
        } catch {}
      }
    }
    for (const drive of ["C", "D", "E", "F", "G"]) {
      for (const sub of ["Program Files (x86)\\Steam", "Program Files\\Steam", "Steam", "SteamLibrary"]) {
        const cand = `${drive}:\\${sub}`;
        if (fs.existsSync(cand)) steamRoots.add(path.resolve(cand));
      }
    }
  } else if (process.platform === "darwin") {
    const p = path.join(os.homedir(), "Library", "Application Support", "Steam");
    if (fs.existsSync(p)) steamRoots.add(p);
  } else {
    for (const p of [
      path.join(os.homedir(), ".local", "share", "Steam"),
      path.join(os.homedir(), ".steam", "steam"),
    ]) {
      if (fs.existsSync(p)) steamRoots.add(p);
    }
  }

  const libraries = new Set(steamRoots);
  for (const root of steamRoots) {
    const vdf = path.join(root, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(vdf)) continue;
    try {
      const txt = fs.readFileSync(vdf, "utf8");
      for (const m of txt.matchAll(/"path"\s+"([^"]+)"/gi)) {
        const libPath = path.resolve(m[1].replace(/\\\\/g, "\\"));
        if (fs.existsSync(libPath)) libraries.add(libPath);
      }
    } catch {}
  }

  return [...libraries];
}

/**
 * Locate Wallpaper Engine installation root, `config.json`, and `wallpaper64.exe`.
 */
export function findWallpaperEngineInstall(extraDirs = []) {
  const libs = discoverSteamLibraries();
  const candidates = [];
  for (const lib of libs) {
    candidates.push(path.join(lib, "steamapps", "common", "wallpaper_engine"));
  }
  for (const d of extraDirs || []) {
    if (!d) continue;
    const norm = path.resolve(d);
    if (norm.toLowerCase().includes("wallpaper_engine")) {
      const idx = norm.toLowerCase().indexOf("wallpaper_engine");
      candidates.push(norm.slice(0, idx + "wallpaper_engine".length));
    }
  }

  for (const dir of [...new Set(candidates)]) {
    if (!fs.existsSync(dir)) continue;
    const cfg = path.join(dir, "config.json");
    const exe64 = path.join(dir, "wallpaper64.exe");
    const exe32 = path.join(dir, "wallpaper32.exe");
    const exe = fs.existsSync(exe64) ? exe64 : fs.existsSync(exe32) ? exe32 : "";
    if (fs.existsSync(cfg) || exe) {
      return {
        install_dir: dir,
        config_path: fs.existsSync(cfg) ? cfg : "",
        exe_path: exe,
      };
    }
  }
  return { install_dir: "", config_path: "", exe_path: "" };
}

/**
 * Detect Steam libraries and locate Wallpaper Engine (AppID 431960) directories.
 * Only called after explicit user authorization action!
 */
export function detectSteamWallpaperEngineDirs() {
  const libraries = discoverSteamLibraries();
  const foundDirs = [];
  const seenReal = new Set();
  const pushIfValid = (dirPath, label) => {
    if (!fs.existsSync(dirPath)) return;
    try {
      if (!fs.statSync(dirPath).isDirectory()) return;
      const real = safeRealpath(dirPath).toLowerCase();
      if (seenReal.has(real)) return;
      seenReal.add(real);
      foundDirs.push({ path: path.resolve(dirPath), label });
    } catch {}
  };

  for (const lib of libraries) {
    pushIfValid(path.join(lib, "steamapps", "workshop", "content", "431960"), "Steam 创意工坊 (431960)");
    pushIfValid(path.join(lib, "steamapps", "common", "wallpaper_engine", "projects", "myprojects"), "Wallpaper Engine 我的项目");
    pushIfValid(path.join(lib, "steamapps", "common", "wallpaper_engine", "projects", "defaultprojects"), "Wallpaper Engine 内置壁纸");
  }

  return foundDirs;
}

/**
 * Launch official Steam Wallpaper Engine (AppID 431960) so the user can log into Steam
 * and pick/browse wallpapers directly in Wallpaper Engine!
 */
export function launchWallpaperEngineApp(openFile = "") {
  const install = findWallpaperEngineInstall();
  try {
    if (openFile && install.exe_path && process.platform === "win32") {
      // Official Wallpaper Engine CLI: seamlessly switch active desktop wallpaper!
      spawn(install.exe_path, ["-control", "openWallpaper", "-file", path.resolve(openFile)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return { ok: true, method: "cli_openWallpaper", file: openFile };
    }
    if (process.platform === "win32") {
      // Open Steam Wallpaper Engine UI via official steam://rungameid/431960 protocol
      const encoded = Buffer.from("Start-Process -FilePath 'steam://rungameid/431960'", "utf16le").toString("base64");
      spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return { ok: true, method: "steam_uri", uri: "steam://rungameid/431960", installed: Boolean(install.install_dir) };
    }
    if (process.platform === "darwin") {
      spawn("open", ["steam://rungameid/431960"], { detached: true, stdio: "ignore" }).unref();
      return { ok: true, method: "steam_uri", uri: "steam://rungameid/431960" };
    }
    spawn("xdg-open", ["steam://rungameid/431960"], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, method: "steam_uri", uri: "steam://rungameid/431960" };
  } catch (err) {
    return { ok: false, error: `启动 Wallpaper Engine 失败: ${err.message}` };
  }
}

/**
 * Read the user's CURRENTLY SELECTED wallpaper directly from Wallpaper Engine `config.json`!
 * Automatically identifies Video (4K/8K original), Web (HTML5/WebGL), Image, or Scene (DirectX 3D .pkg).
 */
export function readCurrentWallpaperEngineSelection(authorizedDirs = []) {
  const install = findWallpaperEngineInstall(authorizedDirs);
  if (!install.config_path || !fs.existsSync(install.config_path)) {
    return {
      found: false,
      install_dir: install.install_dir,
      config_path: "",
      reason: "未检测到本机 Wallpaper Engine 配置文件 (config.json)",
    };
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(install.config_path, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    return { found: false, install_dir: install.install_dir, config_path: install.config_path, reason: `解析 config.json 失败: ${err.message}` };
  }

  const curUser = os.userInfo().username;
  const userKeys = Object.keys(cfg).filter((k) => !k.startsWith("?") && typeof cfg[k] === "object");
  const chosenKey = userKeys.find((k) => k.toLowerCase() === curUser.toLowerCase()) || userKeys[0];
  const userCfg = chosenKey ? cfg[chosenKey] : null;
  const selMap = userCfg?.general?.wallpaperconfig?.selectedwallpapers || {};
  const monitors = Object.keys(selMap).sort();
  const primaryMonitor = monitors[0] || "";
  const rawFile = primaryMonitor ? String(selMap[primaryMonitor]?.file || "").trim() : "";
  const playbackMaximized = String(userCfg?.general?.user?.playbackmaximized || "");

  if (!rawFile) {
    return {
      found: false,
      install_dir: install.install_dir,
      config_path: install.config_path,
      reason: "Wallpaper Engine 当前未选中任何壁纸，请先打开 Wallpaper Engine 选择一张壁纸。",
    };
  }

  const absFile = path.resolve(rawFile.replace(/\//g, path.sep));
  const projDir = path.dirname(absFile);
  const exists = fs.existsSync(absFile);
  const ext = path.extname(absFile).toLowerCase();

  // Read project.json metadata if present
  let proj = {};
  const pjPath = path.join(projDir, "project.json");
  if (fs.existsSync(pjPath)) {
    try {
      proj = JSON.parse(fs.readFileSync(pjPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {}
  }

  const title = String(proj.title || path.basename(absFile, ext) || path.basename(projDir)).trim();
  const projType = String(proj.type || "").toLowerCase();
  const st = exists ? fs.statSync(absFile) : null;
  const sizeMb = st ? Math.round((st.size / (1024 * 1024)) * 10) / 10 : 0;

  let weType = "unknown";
  let playMode = "passthrough";
  let losslessInBrowser = false;
  let streamUrl = "";

  // Ensure the selected file is indexed and authorized before giving a direct stream URL
  const id = hashId(safeRealpath(projDir));
  const isAuthorized = isPathInsideAuthorizedDirs(absFile, authorizedDirs);

  if (VIDEO_EXTS.has(ext) || projType === "video") {
    weType = "video";
    playMode = "video";
    losslessInBrowser = true;
    if (exists && isAuthorized) {
      const fileItem = {
        id,
        title,
        we_type: "video",
        play_mode: "video",
        dir_path: projDir,
        file_path: absFile,
        preview_path: proj.preview ? path.resolve(projDir, proj.preview) : "",
        size_bytes: st.size,
        size_mb: sizeMb,
        ext,
        tags: Array.isArray(proj.tags) ? proj.tags : [],
        source_label: "Wallpaper Engine 当前选用",
        stream_url: `/api/we/media?id=${id}&kind=file`,
        preview_url: `/api/we/media?id=${id}&kind=file`,
        badge: `🎬 原版视频 · ${sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(2)} GB` : `${sizeMb} MB`}`,
        description: "Wallpaper Engine 原版无损视频（零拷贝 0 处理直出）",
      };
      _itemIndex.set(id, fileItem);
      streamUrl = fileItem.stream_url;
    }
  } else if (ext === ".html" || ext === ".htm" || projType === "web") {
    weType = "web";
    playMode = "web";
    losslessInBrowser = true;
    if (exists && isAuthorized) {
      const relWeb = path.relative(projDir, absFile).replace(/\\/g, "/");
      const webItem = {
        id,
        title,
        we_type: "web",
        play_mode: "web",
        dir_path: projDir,
        file_path: absFile,
        preview_path: proj.preview ? path.resolve(projDir, proj.preview) : "",
        size_bytes: 0,
        size_mb: 0,
        ext,
        tags: Array.isArray(proj.tags) ? proj.tags : [],
        source_label: "Wallpaper Engine 当前选用",
        stream_url: `/api/we/web/${id}/${relWeb.split("/").map(encodeURIComponent).join("/")}`,
        preview_url: "",
        badge: "🌐 原版 Web 互动壁纸",
        description: "Wallpaper Engine 原版 HTML5/WebGL 互动壁纸（0 处理直出）",
      };
      _itemIndex.set(id, webItem);
      streamUrl = webItem.stream_url;
    }
  } else if (IMAGE_EXTS.has(ext)) {
    weType = "image";
    playMode = "image";
    losslessInBrowser = true;
    if (exists && isAuthorized) {
      const imgItem = {
        id,
        title,
        we_type: "image",
        play_mode: "image",
        dir_path: projDir,
        file_path: absFile,
        preview_path: absFile,
        size_bytes: st.size,
        size_mb: sizeMb,
        ext,
        tags: [],
        source_label: "Wallpaper Engine 当前选用",
        stream_url: `/api/we/media?id=${id}&kind=file`,
        preview_url: `/api/we/media?id=${id}&kind=file`,
        badge: `🖼️ 原版无损图片 · ${sizeMb} MB`,
        description: "原版无损图片（0 压缩 0 处理直出）",
      };
      _itemIndex.set(id, imgItem);
      streamUrl = imgItem.stream_url;
    }
  } else if (ext === ".pkg" || ext === ".json" || projType === "scene") {
    weType = "scene";
    playMode = "passthrough";
    losslessInBrowser = false; // DirectX 3D engine: ONLY native Desktop Passthrough gives 100% lossless 4K 60fps!
  } else {
    weType = projType || "application";
    playMode = "passthrough";
    losslessInBrowser = false;
  }

  return {
    found: true,
    id,
    monitor: primaryMonitor,
    title,
    we_type: weType,
    play_mode: playMode,
    lossless_in_browser: losslessInBrowser,
    requires_desktop_passthrough: !losslessInBrowser,
    file_path: absFile,
    dir_path: projDir,
    exists,
    authorized: isAuthorized,
    size_mb: sizeMb,
    ext,
    stream_url: streamUrl,
    install_dir: install.install_dir,
    config_path: install.config_path,
    playback_maximized: playbackMaximized,
    note: losslessInBrowser
      ? `已识别您当前在 Wallpaper Engine 选用的原版${weType === "video" ? "视频" : weType === "web" ? "互动网页" : "原图"}「${title}」，支持 100% 原画质 0 损耗零拷贝直连！`
      : `已识别您当前在 Wallpaper Engine 选用的 DirectX 3D 实时场景「${title}」（${ext || "scene"}）。为保证清晰度 0 损耗、粒子与人物内容不做任何删减处理，请使用 OpenCode Studio 桌面版开启「✨ 原生无损透视」，由 Wallpaper Engine 原生引擎直接 4K 60fps 呈现！`,
  };
}

/**
 * Watch Wallpaper Engine's `config.json` in real time so any wallpaper switch inside
 * Wallpaper Engine immediately pushes an update to OpenCode Studio (<500ms)!
 */
export function syncWallpaperEngineWatcher({ enabled, authorizedDirs, onSelectionChange }) {
  if (!enabled || !authorizedDirs?.length) {
    stopWallpaperEngineWatcher();
    return;
  }
  const install = findWallpaperEngineInstall(authorizedDirs);
  if (!install.install_dir || !install.config_path) return;
  if (_configWatcher && _watchedConfigDir.toLowerCase() === install.install_dir.toLowerCase()) {
    return;
  }
  stopWallpaperEngineWatcher();

  let debounce = null;
  let lastFileSig = "";
  try {
    const initial = readCurrentWallpaperEngineSelection(authorizedDirs);
    if (initial.found) lastFileSig = `${initial.file_path}|${initial.we_type}`;

    _watchedConfigDir = install.install_dir;
    _configWatcher = fs.watch(install.install_dir, { persistent: false }, (_ev, filename) => {
      if (filename && !String(filename).toLowerCase().startsWith("config.json")) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          const next = readCurrentWallpaperEngineSelection(authorizedDirs);
          const sig = next.found ? `${next.file_path}|${next.we_type}` : "";
          if (sig && sig !== lastFileSig) {
            lastFileSig = sig;
            logEvent("INFO", "wallpaper_engine", "selection_changed", `检测到 Wallpaper Engine 切换壁纸: ${next.title} (${next.we_type})`);
            onSelectionChange?.(next);
          }
        } catch {}
      }, 450);
    });
    _configWatcher.on("error", () => {});
    logEvent("INFO", "wallpaper_engine", "watcher_started", `已开启 Wallpaper Engine 实时壁纸变动监听: ${install.config_path}`);
  } catch {
    stopWallpaperEngineWatcher();
  }
}

export function stopWallpaperEngineWatcher() {
  if (_configWatcher) {
    try { _configWatcher.close(); } catch {}
    _configWatcher = null;
    _watchedConfigDir = "";
  }
}

function scanWallpaperProjectFolder(dirPath, rootLabel) {
  const projJsonPath = path.join(dirPath, "project.json");
  if (!fs.existsSync(projJsonPath)) return null;

  let proj;
  try {
    proj = JSON.parse(fs.readFileSync(projJsonPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }

  const rawType = String(proj.type || "").toLowerCase();
  const relFile = String(proj.file || "").trim();
  const relPreview = String(proj.preview || "").trim();
  const title = String(proj.title || path.basename(dirPath)).trim();
  const tags = Array.isArray(proj.tags) ? proj.tags.map(String) : [];

  const filePath = relFile ? path.resolve(dirPath, relFile) : "";
  const previewPath = relPreview ? path.resolve(dirPath, relPreview) : "";
  const hasPreview = previewPath && isPathInsideDir(previewPath, dirPath) && fs.existsSync(previewPath);
  const id = hashId(safeRealpath(dirPath));

  // 1. VIDEO Wallpaper (100% lossless original file streaming — hundreds of MB to multi-GB 4K/8K!)
  if (rawType === "video" || (filePath && VIDEO_EXTS.has(path.extname(filePath).toLowerCase()))) {
    if (!filePath || !isPathInsideDir(filePath, dirPath) || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    const sizeMb = Math.round((st.size / (1024 * 1024)) * 10) / 10;
    const ext = path.extname(filePath).toLowerCase();
    return {
      id,
      title,
      we_type: "video",
      play_mode: "video",
      lossless_in_browser: true,
      dir_path: dirPath,
      file_path: filePath,
      preview_path: hasPreview ? previewPath : "",
      size_bytes: st.size,
      size_mb: sizeMb,
      ext,
      tags,
      source_label: rootLabel,
      stream_url: `/api/we/media?id=${id}&kind=file`,
      preview_url: hasPreview ? `/api/we/media?id=${id}&kind=preview` : `/api/we/media?id=${id}&kind=file`,
      badge: `🎬 原版视频 · ${sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(2)} GB` : `${sizeMb} MB`}`,
      description: `原文件零拷贝流式直读 (${ext.slice(1).toUpperCase()}，0 压缩 0 损耗)`,
    };
  }

  // 2. WEB Wallpaper (100% original HTML5 / WebGL / Canvas interactive)
  if (rawType === "web" || (filePath && /\.(html?|xhtml)$/i.test(filePath))) {
    if (!filePath || !isPathInsideDir(filePath, dirPath) || !fs.existsSync(filePath)) return null;
    const relWeb = path.relative(dirPath, filePath).replace(/\\/g, "/");
    return {
      id,
      title,
      we_type: "web",
      play_mode: "web",
      lossless_in_browser: true,
      dir_path: dirPath,
      file_path: filePath,
      preview_path: hasPreview ? previewPath : "",
      size_bytes: 0,
      size_mb: 0,
      ext: ".html",
      tags,
      source_label: rootLabel,
      stream_url: `/api/we/web/${id}/${relWeb.split("/").map(encodeURIComponent).join("/")}`,
      preview_url: hasPreview ? `/api/we/media?id=${id}&kind=preview` : "",
      badge: "🌐 原版 Web 互动",
      description: "HTML5 / WebGL 原版动态互动壁纸（0 损耗，断网可用）",
    };
  }

  // 3. SCENE Wallpaper (DirectX 3D .pkg — NEVER degraded to preview.gif! Uses native Desktop Passthrough!)
  if (rawType === "scene" || fs.existsSync(path.join(dirPath, "scene.pkg")) || fs.existsSync(path.join(dirPath, "scene.json"))) {
    const pkgPath = path.join(dirPath, "scene.pkg");
    const sceneTarget = fs.existsSync(pkgPath) ? pkgPath : fs.existsSync(filePath) ? filePath : "";
    if (!sceneTarget) return null;
    const pkgSizeMb = Math.round((fs.statSync(sceneTarget).size / (1024 * 1024)) * 10) / 10;
    return {
      id,
      title,
      we_type: "scene",
      play_mode: "passthrough",
      lossless_in_browser: false,
      dir_path: dirPath,
      file_path: sceneTarget,
      preview_path: hasPreview ? previewPath : "",
      size_bytes: fs.statSync(sceneTarget).size,
      size_mb: pkgSizeMb,
      ext: path.extname(sceneTarget).toLowerCase(),
      tags,
      source_label: rootLabel,
      stream_url: "",
      preview_url: hasPreview ? `/api/we/media?id=${id}&kind=preview` : "",
      badge: "✨ 3D Scene · 原生无损透视",
      description: "DirectX 3D 实时场景（桌面版开启无损透视 100% 4K 原版呈现，不做任何降质）",
    };
  }

  return null;
}

/**
 * Scan all user-authorized Wallpaper Engine & custom local 4K media folders.
 */
export function scanAuthorizedWallpaperLibrary(authorizedDirs = [], force = false) {
  const dirs = (authorizedDirs || []).filter((d) => d && fs.existsSync(d));
  const key = dirs.map((d) => safeRealpath(d)).sort().join("|");
  if (!force && key === _lastScanDirsKey && _lastScanItems.length) {
    return _lastScanItems;
  }

  const items = [];
  const nextIndex = new Map();
  const seenIds = new Set();

  const registerItem = (it) => {
    if (!it || seenIds.has(it.id)) return;
    seenIds.add(it.id);
    nextIndex.set(it.id, it);
    items.push(it);
  };

  for (const rootDir of dirs) {
    const label = rootDir.includes("431960")
      ? "Steam 创意工坊"
      : rootDir.toLowerCase().includes("wallpaper_engine")
        ? "Wallpaper Engine"
        : path.basename(rootDir) || rootDir;

    if (fs.existsSync(path.join(rootDir, "project.json"))) {
      registerItem(scanWallpaperProjectFolder(rootDir, label));
      continue;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(rootDir, e.name);
      if (e.isDirectory()) {
        const projItem = scanWallpaperProjectFolder(full, label);
        if (projItem) registerItem(projItem);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!VIDEO_EXTS.has(ext) && !IMAGE_EXTS.has(ext)) continue;
        try {
          const st = fs.statSync(full);
          const sizeMb = Math.round((st.size / (1024 * 1024)) * 10) / 10;
          const id = hashId(safeRealpath(full));
          const isVid = VIDEO_EXTS.has(ext);
          registerItem({
            id,
            title: path.basename(e.name, ext),
            we_type: isVid ? "video" : "image",
            play_mode: isVid ? "video" : "image",
            lossless_in_browser: true,
            dir_path: rootDir,
            file_path: full,
            preview_path: isVid ? "" : full,
            size_bytes: st.size,
            size_mb: sizeMb,
            ext,
            tags: [isVid ? "本地原版视频" : "本地原图"],
            source_label: label,
            stream_url: `/api/we/media?id=${id}&kind=file`,
            preview_url: `/api/we/media?id=${id}&kind=file`,
            badge: isVid
              ? `🎬 原版视频 · ${sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(2)} GB` : `${sizeMb} MB`}`
              : `🖼️ 原版无损图 · ${sizeMb} MB`,
            description: "本地原文件零拷贝直读（0 压缩 0 额外占用，断网可用）",
          });
        } catch {}
      }
    }
  }

  const order = { video: 0, web: 1, image: 2, scene: 3 };
  items.sort((a, b) => (order[a.we_type] ?? 9) - (order[b.we_type] ?? 9) || b.size_bytes - a.size_bytes || a.title.localeCompare(b.title));

  _itemIndex = nextIndex;
  _lastScanDirsKey = key;
  _lastScanItems = items;
  logEvent("INFO", "wallpaper_engine", "scan_done", `已扫描授权壁纸库 (${dirs.length} 个目录, 共 ${items.length} 个壁纸)`);
  return items;
}

export function getAuthorizedWallpaperItem(id, authorizedDirs = []) {
  if (!_itemIndex.has(id) && authorizedDirs?.length) {
    scanAuthorizedWallpaperLibrary(authorizedDirs, false);
  }
  const it = _itemIndex.get(id);
  if (!it) return null;
  if (!isPathInsideAuthorizedDirs(it.dir_path, authorizedDirs)) return null;
  return it;
}

/**
 * Zero-copy HTTP 206 Byte-Range streamer for arbitrarily large (hundreds of MB to multi-GB)
 * original 4K/8K videos and lossless images directly from their authorized original path.
 */
export function streamAuthorizedMedia(req, res, item, kind = "file", authorizedDirs = []) {
  if (!item) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "壁纸项不存在或未授权" }));
  }

  const targetPath = kind === "preview" && item.preview_path ? item.preview_path : item.file_path;
  if (!targetPath || !isPathInsideAuthorizedDirs(targetPath, authorizedDirs) || !fs.existsSync(targetPath)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "壁纸文件不存在或不在已授权目录内" }));
  }

  const st = fs.statSync(targetPath);
  const total = st.size;
  const ext = path.extname(targetPath).toLowerCase();
  const mime = STREAM_MIME[ext] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? Number(m[1]) : 0;
    const requestedEnd = m && m[2] ? Number(m[2]) : Math.min(start + 4 * 1024 * 1024 - 1, total - 1);
    const end = Math.min(requestedEnd, total - 1);
    if (start >= total || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": "public, max-age=3600",
    });
    return fs.createReadStream(targetPath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": total,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  });
  return fs.createReadStream(targetPath).pipe(res);
}

export function serveAuthorizedWebAsset(req, res, item, relSubpath, authorizedDirs = []) {
  if (!item || item.we_type !== "web") {
    res.writeHead(404);
    return res.end("Not Found");
  }
  const cleanRel = String(relSubpath || "index.html").replace(/^\/+/, "");
  const fullPath = path.resolve(item.dir_path, cleanRel);
  if (!isPathInsideDir(fullPath, item.dir_path) || !isPathInsideAuthorizedDirs(fullPath, authorizedDirs)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    res.writeHead(404);
    return res.end("Not Found");
  }
  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": STREAM_MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  return fs.createReadStream(fullPath).pipe(res);
}

export function serializeWeItemForClient(it) {
  return {
    id: it.id,
    title: it.title,
    we_type: it.we_type,
    play_mode: it.play_mode,
    lossless_in_browser: Boolean(it.lossless_in_browser),
    file_path: it.file_path,
    size_mb: it.size_mb,
    ext: it.ext,
    tags: it.tags,
    source_label: it.source_label,
    stream_url: it.stream_url,
    preview_url: it.preview_url,
    badge: it.badge,
    description: it.description,
  };
}
