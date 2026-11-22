/**
 * Steam Wallpaper Engine (AppID 431960) & Local 4K Large-Video Zero-Copy Library Bridge.
 *
 * Security & Storage Architecture:
 *  - Explicit opt-in ONLY: never scans Steam or local folders until the user clicks Authorize.
 *  - Zero-copy streaming: videos (hundreds of MB to multi-GB 4K animations) stay in their
 *    original Steam / local directory (0 MB duplicated disk usage!) and stream on-demand
 *    over HTTP 206 Byte-Range (`fs.createReadStream({ start, end })`).
 *  - Supports all playable Wallpaper Engine types:
 *      1. `video` (.mp4/.webm/.mov/.mkv/.m4v) -> full 4K 60fps zero-copy streaming
 *      2. `web`   (HTML5/WebGL/Canvas)         -> sandboxed iframe local static serving
 *      3. `scene` (DirectX scene.pkg)          -> animated preview.gif + optional 4K embedded PNG/JPG extraction
 *      4. Direct local media folders           -> standalone .mp4/.webm/.gif/.jpg/.png/.webp
 *  - Strict directory jail: every file read verifies realpath containment inside authorized dirs.
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

// In-memory catalog cache keyed by itemId -> verified metadata & absolute paths
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

/**
 * Detect Steam libraries and locate Wallpaper Engine (AppID 431960) directories.
 * Only called after explicit user authorization action!
 */
export function detectSteamWallpaperEngineDirs() {
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

  // Parse libraryfolders.vdf to discover Steam libraries across ALL disks
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
 * Fast header-only inspection of Wallpaper Engine `scene.pkg` (PKGVxxxx) to check if it
 * contains an embedded high-resolution PNG/JPG background texture inside a `.tex` asset.
 * Reads ONLY the header index + first 128 bytes of candidate `.tex` entries (zero full-file copy!).
 */
function inspectScenePkgForHdTexture(pkgPath) {
  let fd;
  try {
    const st = fs.statSync(pkgPath);
    if (!st.isFile() || st.size < 32 || st.size > 1024 * 1024 * 1024) return null;
    fd = fs.openSync(pkgPath, "r");

    const headBuf = Buffer.alloc(Math.min(st.size, 256 * 1024));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);

    let off = 0;
    const magicLen = headBuf.readInt32LE(off);
    off += 4;
    if (magicLen <= 0 || magicLen > 32) return null;
    const magic = headBuf.subarray(off, off + magicLen).toString("ascii");
    if (!magic.startsWith("PKGV")) return null;
    off += magicLen;

    const count = headBuf.readInt32LE(off);
    off += 4;
    if (count <= 0 || count > 20000) return null;

    const entries = [];
    for (let i = 0; i < count; i++) {
      if (off + 12 > headBuf.length) break;
      const nLen = headBuf.readInt32LE(off);
      off += 4;
      if (nLen <= 0 || nLen > 512 || off + nLen + 8 > headBuf.length) break;
      const name = headBuf.subarray(off, off + nLen).toString("utf8");
      off += nLen;
      const fOff = headBuf.readInt32LE(off);
      off += 4;
      const fLen = headBuf.readInt32LE(off);
      off += 4;
      if (fLen > 80_000 && /\.tex$/i.test(name)) {
        entries.push({ name, fOff, fLen });
      }
    }
    const dataBase = off;
    if (!entries.length) return null;

    // Prefer largest background-like .tex entry that embeds a direct PNG or JPEG stream
    entries.sort((a, b) => {
      const aBg = /bg|back|sky|scene|wall/i.test(a.name) ? 1 : 0;
      const bBg = /bg|back|sky|scene|wall/i.test(b.name) ? 1 : 0;
      if (aBg !== bBg) return bBg - aBg;
      return b.fLen - a.fLen;
    });

    const probe = Buffer.alloc(256);
    for (const e of entries.slice(0, 6)) {
      const absStart = dataBase + e.fOff;
      if (absStart + 64 > st.size) continue;
      const got = fs.readSync(fd, probe, 0, Math.min(probe.length, e.fLen), absStart);
      const sub = probe.subarray(0, got);
      const pngIdx = sub.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (pngIdx >= 0) {
        return {
          name: e.name,
          mime: "image/png",
          start: absStart + pngIdx,
          length: e.fLen - pngIdx,
        };
      }
      const jpgIdx = sub.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
      if (jpgIdx >= 0) {
        return {
          name: e.name,
          mime: "image/jpeg",
          start: absStart + jpgIdx,
          length: e.fLen - jpgIdx,
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
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

  // 1. VIDEO Wallpaper (mp4/webm/mov/mkv — even multi-GB 4K 60fps animations!)
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
      badge: `🎬 原画视频 · ${sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(2)} GB` : `${sizeMb} MB`}`,
      description: `零拷贝本地流式直读 (${ext.slice(1).toUpperCase()}，0 额外占用，断网可用)`,
    };
  }

  // 2. WEB Wallpaper (HTML5 / WebGL / Canvas interactive)
  if (rawType === "web" || (filePath && /\.(html?|xhtml)$/i.test(filePath))) {
    if (!filePath || !isPathInsideDir(filePath, dirPath) || !fs.existsSync(filePath)) return null;
    const relWeb = path.relative(dirPath, filePath).replace(/\\/g, "/");
    return {
      id,
      title,
      we_type: "web",
      play_mode: "web",
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
      badge: "🌐 Web 互动壁纸",
      description: "HTML5 / WebGL 本地动态互动壁纸（零拷贝，断网可用）",
    };
  }

  // 3. SCENE Wallpaper (DirectX scene.pkg — supports animated preview.gif AND 4K embedded PNG/JPG extraction!)
  if (rawType === "scene" || fs.existsSync(path.join(dirPath, "scene.pkg")) || fs.existsSync(path.join(dirPath, "scene.json"))) {
    const pkgPath = path.join(dirPath, "scene.pkg");
    const hasPkg = fs.existsSync(pkgPath);
    const pkgSizeMb = hasPkg ? Math.round((fs.statSync(pkgPath).size / (1024 * 1024)) * 10) / 10 : 0;
    const hdSlice = hasPkg ? inspectScenePkgForHdTexture(pkgPath) : null;
    if (!hasPreview && !hdSlice) return null;
    const isAnimPreview = hasPreview && /\.gif$/i.test(previewPath);
    return {
      id,
      title,
      we_type: "scene",
      play_mode: "image",
      dir_path: dirPath,
      file_path: hasPreview ? previewPath : pkgPath,
      preview_path: hasPreview ? previewPath : "",
      pkg_path: hasPkg ? pkgPath : "",
      pkg_hd_slice: hdSlice,
      has_pkg_hd: Boolean(hdSlice),
      size_bytes: hasPkg ? fs.statSync(pkgPath).size : 0,
      size_mb: pkgSizeMb,
      ext: hasPreview ? path.extname(previewPath).toLowerCase() : ".png",
      tags,
      source_label: rootLabel,
      // Prefer animated preview.gif for living motion, or 4K extracted texture when requested
      stream_url: isAnimPreview
        ? `/api/we/media?id=${id}&kind=preview`
        : hdSlice
          ? `/api/we/media?id=${id}&kind=pkg_hd`
          : `/api/we/media?id=${id}&kind=preview`,
      hd_url: hdSlice ? `/api/we/media?id=${id}&kind=pkg_hd` : "",
      preview_url: hasPreview ? `/api/we/media?id=${id}&kind=preview` : `/api/we/media?id=${id}&kind=pkg_hd`,
      badge: isAnimPreview
        ? `✨ Scene 动态${hdSlice ? " · 含4K原画" : ""}`
        : hdSlice
          ? "🖼️ Scene · 4K 原画"
          : "✨ Scene 预览",
      description: isAnimPreview
        ? `Wallpaper Engine 场景壁纸（支持动态预览${hdSlice ? "或切换提取 4K 无损底图" : ""} · 零拷贝）`
        : "Wallpaper Engine 场景壁纸（本地零拷贝读取）",
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

    // Case A: rootDir itself is a single Wallpaper Engine project folder
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
        // Case B: User authorized a regular local folder of 4K videos / GIFs / images!
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
            dir_path: rootDir,
            file_path: full,
            preview_path: isVid ? "" : full,
            size_bytes: st.size,
            size_mb: sizeMb,
            ext,
            tags: [isVid ? "本地视频" : "本地图片"],
            source_label: label,
            stream_url: `/api/we/media?id=${id}&kind=file`,
            preview_url: `/api/we/media?id=${id}&kind=file`,
            badge: isVid
              ? `🎬 本地视频 · ${sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(2)} GB` : `${sizeMb} MB`}`
              : `🖼️ 本地原图 · ${sizeMb} MB`,
            description: "本地文件夹零拷贝流式直连（0 额外占用，断网可用）",
          });
        } catch {}
      }
    }
  }

  // Sort: videos & web first (richest live animations), then scene/image by size/title
  const order = { video: 0, web: 1, scene: 2, image: 3 };
  items.sort((a, b) => (order[a.we_type] ?? 9) - (order[b.we_type] ?? 9) || b.size_bytes - a.size_bytes || a.title.localeCompare(b.title));

  _itemIndex = nextIndex;
  _lastScanDirsKey = key;
  _lastScanItems = items;
  logEvent("INFO", "wallpaper_engine", "scan_done", `已扫描授权壁纸库 (${dirs.length} 个目录, 共 ${items.length} 个可用壁纸)`);
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
 * 4K videos and images directly from their authorized original path on disk.
 */
export function streamAuthorizedMedia(req, res, item, kind = "file", authorizedDirs = []) {
  if (!item) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "壁纸项不存在或未授权" }));
  }

  // On-demand slice read of embedded 4K PNG/JPG inside scene.pkg (0 extra disk files!)
  if (kind === "pkg_hd" && item.pkg_path && item.pkg_hd_slice) {
    if (!isPathInsideAuthorizedDirs(item.pkg_path, authorizedDirs) || !fs.existsSync(item.pkg_path)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "未授权访问路径" }));
    }
    const { start, length, mime } = item.pkg_hd_slice;
    const end = start + length - 1;
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": length,
      "Cache-Control": "public, max-age=86400",
    });
    return fs.createReadStream(item.pkg_path, { start, end }).pipe(res);
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
    // Cap chunk to 4MB when open-ended so 2GB 4K video starts instantly (<50ms) with tiny RAM!
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

/**
 * Serve static files for an authorized Wallpaper Engine `web` (HTML5/WebGL) project
 * strictly jailed inside that project's directory.
 */
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
    size_mb: it.size_mb,
    ext: it.ext,
    tags: it.tags,
    source_label: it.source_label,
    stream_url: it.stream_url,
    hd_url: it.hd_url || "",
    has_pkg_hd: Boolean(it.has_pkg_hd),
    preview_url: it.preview_url,
    badge: it.badge,
    description: it.description,
  };
}
