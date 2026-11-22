/**
 * Steam Wallpaper Engine (AppID 431960) & Local 4K Large-Video Independent Zero-Copy Bridge.
 *
 * Strict Non-Interference & Lossless Guarantees:
 *  - 100% INDEPENDENT from the user's Windows desktop wallpaper: NEVER spawns `wallpaper64.exe`,
 *    NEVER calls `-control openWallpaper`, NEVER alters or syncs the user's OS desktop!
 *  - Explicit opt-in ONLY: never reads Steam or local folders until the user clicks Authorize.
 *  - Zero-copy lossless streaming: 4K/8K `video` (.mp4/.webm/.mov/.mkv — hundreds of MB to multi-GB),
 *    `web` (HTML5/WebGL), and `image` files stay in their original directory (0 MB duplicated)
 *    and stream bit-for-bit via HTTP 206 Byte-Range with zero transcoding or content modification.
 *  - Honest about proprietary DirectX `.pkg` `scene` items: never fakes 4K with low-res preview.gif
 *    or incomplete textures; clearly marks them as Wallpaper-Engine-native-only.
 */

import { spawnSync } from "node:child_process";
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
 * Read-only detection of Steam Wallpaper Engine (AppID 431960) content folders.
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

  // 1. VIDEO Wallpaper: 100% lossless independent original-file streaming (hundreds of MB ~ multi-GB 4K/8K!)
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
      playable: true,
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
      description: `独立播放原文件 (${ext.slice(1).toUpperCase()} · 0 压缩 0 拷贝，不影响桌面壁纸)`,
    };
  }

  // 2. WEB Wallpaper: 100% lossless independent HTML5 / WebGL interactive rendering
  if (rawType === "web" || (filePath && /\.(html?|xhtml)$/i.test(filePath))) {
    if (!filePath || !isPathInsideDir(filePath, dirPath) || !fs.existsSync(filePath)) return null;
    const relWeb = path.relative(dirPath, filePath).replace(/\\/g, "/");
    return {
      id,
      title,
      we_type: "web",
      play_mode: "web",
      playable: true,
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
      description: "独立运行 HTML5 / WebGL 原版互动壁纸（0 损耗，不影响桌面壁纸）",
    };
  }

  // 3. SCENE (.pkg DirectX 3D engine): honestly mark as native-only — NEVER fake 4K with preview.gif, NEVER alter desktop!
  if (rawType === "scene" || fs.existsSync(path.join(dirPath, "scene.pkg")) || fs.existsSync(path.join(dirPath, "scene.json"))) {
    const pkgPath = path.join(dirPath, "scene.pkg");
    const sceneTarget = fs.existsSync(pkgPath) ? pkgPath : fs.existsSync(filePath) ? filePath : "";
    if (!sceneTarget) return null;
    const pkgSizeMb = Math.round((fs.statSync(sceneTarget).size / (1024 * 1024)) * 10) / 10;
    return {
      id,
      title,
      we_type: "scene",
      play_mode: "unsupported_scene",
      playable: false,
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
      badge: "🔒 DirectX 3D (.pkg)",
      description: "专有 DirectX 场景包（为保证不降质且不改您桌面，请在创意工坊选「视频 / 网页」类型壁纸）",
    };
  }

  return null;
}

/**
 * Scan all user-authorized Wallpaper Engine & custom local 4K media folders (strictly read-only).
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
            playable: true,
            lossless_in_browser: true,
            dir_path: rootDir,
            file_path: full,
            preview_path: isVid ? "" : full,
            size_bytes: st.size,
            size_mb: sizeMb,
            ext,
            tags: [isVid ? "本地原版视频" : "本地无损原图"],
            source_label: label,
            stream_url: `/api/we/media?id=${id}&kind=file`,
            preview_url: `/api/we/media?id=${id}&kind=file`,
            badge: isVid
              ? `🎬 原版视频 · ${sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(2)} GB` : `${sizeMb} MB`}`
              : `🖼️ 无损原图 · ${sizeMb} MB`,
            description: "本地原文件零拷贝直读（0 压缩 0 额外占用，与桌面壁纸完全独立）",
          });
        } catch {}
      }
    }
  }

  // Playable lossless items (video/web/image) first, unsupported DirectX .pkg scenes last
  const order = { video: 0, web: 1, image: 2, scene: 3 };
  items.sort((a, b) => (order[a.we_type] ?? 9) - (order[b.we_type] ?? 9) || b.size_bytes - a.size_bytes || a.title.localeCompare(b.title));

  _itemIndex = nextIndex;
  _lastScanDirsKey = key;
  _lastScanItems = items;
  logEvent("INFO", "wallpaper_engine", "scan_done", `已只读扫描授权壁纸库 (${dirs.length} 个目录, 共 ${items.length} 个条目)`);
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
    playable: Boolean(it.playable),
    lossless_in_browser: Boolean(it.lossless_in_browser),
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
