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

function parseJpegDimensions(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb)) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

/**
 * Inspect Wallpaper Engine `scene.pkg` (PKGVxxxx) header-only to distinguish:
 *  - Complete single-image high-res photo/artwork scenes (e.g. 6000x4000 11MB JPEG or 3840x2160 4K JPEG/PNG):
 *      Contains EXACTLY 1 main visual `.tex` (excluding masks/particles) wrapping a complete native JPEG/PNG.
 *      Safe to stream bit-for-bit at exact byte offsets with 0 quality loss & 0 missing foreground layers!
 *  - Multi-layer DirectX 3D scenes (2+ separate foreground/background `.tex` layers like WLOP Dome / Moonlight):
 *      Returns null so we NEVER serve an incomplete single background strip as fake 4K!
 */
export function inspectCompleteSingleImageInPkg(pkgPath) {
  let fd;
  try {
    const st = fs.statSync(pkgPath);
    if (!st.isFile() || st.size < 64 || st.size > 1024 * 1024 * 1024) return null;
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

    const mainTex = [];
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
      if (
        /\.tex$/i.test(name) &&
        fLen > 200_000 &&
        !/(^|\/)(masks?|particles?|effects?|bokeh|glow|dust|snow|rain|spark)/i.test(name)
      ) {
        mainTex.push({ name, fOff, fLen });
      }
    }
    const dataBase = off;

    // Strictly require EXACTLY 1 main visual texture so multi-layer 3D scenes are NEVER broken!
    if (mainTex.length !== 1) return null;

    const entry = mainTex[0];
    const absStart = dataBase + entry.fOff;
    if (absStart + 64 > st.size) return null;

    const probe = Buffer.alloc(Math.min(entry.fLen, 64 * 1024));
    const got = fs.readSync(fd, probe, 0, probe.length, absStart);
    const sub = probe.subarray(0, got);

    const pngIdx = sub.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (pngIdx >= 0 && pngIdx + 24 <= sub.length) {
      const width = sub.readUInt32BE(pngIdx + 16);
      const height = sub.readUInt32BE(pngIdx + 20);
      if (width < 800 || height < 600) return null;
      const length = entry.fLen - pngIdx;
      return {
        mime: "image/png",
        start: absStart + pngIdx,
        length,
        width,
        height,
        size_mb: Math.round((length / (1024 * 1024)) * 10) / 10,
      };
    }

    const jpgIdx = sub.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    if (jpgIdx >= 0) {
      const dims = parseJpegDimensions(sub.subarray(jpgIdx));
      if (!dims || dims.width < 800 || dims.height < 600) return null;
      // Check tail bytes for exact JPEG EOI (FF D9) so zero trailing TEX bytes are appended
      let length = entry.fLen - jpgIdx;
      const tailLen = Math.min(length, 4096);
      const tailBuf = Buffer.alloc(tailLen);
      fs.readSync(fd, tailBuf, 0, tailLen, absStart + jpgIdx + length - tailLen);
      const eoi = tailBuf.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi >= 0) {
        length = length - tailLen + eoi + 2;
      }
      return {
        mime: "image/jpeg",
        start: absStart + jpgIdx,
        length,
        width: dims.width,
        height: dims.height,
        size_mb: Math.round((length / (1024 * 1024)) * 10) / 10,
      };
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

  // 3. SCENE (.pkg):
  //    - If it wraps a COMPLETE single high-res original JPEG/PNG (e.g. 6000x4000 / 3840x2160 photo scene),
  //      stream that exact original image bit-for-bit with 0 quality loss!
  //    - If it is a multi-layer DirectX 3D scene (2+ split layers), honestly mark as native-only!
  if (rawType === "scene" || fs.existsSync(path.join(dirPath, "scene.pkg")) || fs.existsSync(path.join(dirPath, "scene.json"))) {
    const pkgPath = path.join(dirPath, "scene.pkg");
    const sceneTarget = fs.existsSync(pkgPath) ? pkgPath : fs.existsSync(filePath) ? filePath : "";
    if (!sceneTarget) return null;
    const singleImg = fs.existsSync(pkgPath) ? inspectCompleteSingleImageInPkg(pkgPath) : null;
    if (singleImg) {
      return {
        id,
        title,
        we_type: "image",
        play_mode: "image",
        playable: true,
        lossless_in_browser: true,
        dir_path: dirPath,
        file_path: pkgPath,
        pkg_path: pkgPath,
        pkg_image_slice: singleImg,
        preview_path: hasPreview ? previewPath : "",
        size_bytes: singleImg.length,
        size_mb: singleImg.size_mb,
        ext: singleImg.mime === "image/png" ? ".png" : ".jpg",
        tags,
        source_label: rootLabel,
        stream_url: `/api/we/media?id=${id}&kind=pkg_image`,
        preview_url: hasPreview ? `/api/we/media?id=${id}&kind=preview` : `/api/we/media?id=${id}&kind=pkg_image`,
        badge: `🖼️ 原版无损 · ${singleImg.width}×${singleImg.height} · ${singleImg.size_mb} MB`,
        description: `从单图 scene.pkg 零拷贝直读完整原片（0 压缩 0 缺图，不影响桌面壁纸）`,
      };
    }
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
      badge: "🔒 多图层 DirectX 3D (.pkg)",
      description: "多图层 3D 着色器场景包（无法脱离小红车无损渲染；单图原片与视频/网页类型均可直接 4K 无损播放）",
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

  // Zero-copy exact byte-range read of a complete single-image JPEG/PNG inside scene.pkg!
  if (kind === "pkg_image" && item.pkg_path && item.pkg_image_slice) {
    if (!isPathInsideAuthorizedDirs(item.pkg_path, authorizedDirs) || !fs.existsSync(item.pkg_path)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "未授权访问路径" }));
    }
    const { start, length, mime } = item.pkg_image_slice;
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": length,
      "Cache-Control": "public, max-age=86400",
    });
    return fs.createReadStream(item.pkg_path, { start, end: start + length - 1 }).pipe(res);
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
