#!/usr/bin/env node
/**
 * OpenCode Studio Local Singleton Server (HTTP + WebSocket).
 * Zero framework bloat: uses Node 24 native http + node:sqlite + ws.
 * Can run standalone (`npm start`) or embedded inside Electron (`electron/main.mjs`).
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";

import { handleProviderProxyRequest } from "./api_proxy.mjs";
import {
  checkClaudeVersions,
  cleanupClaudeSessionFiles,
  clearRuntimeCache,
  getClaudeRuntimeAndAuth,
  installOrSwitchClaudeVersion,
  refreshClaudeRuntimeAndAuthAsync,
  resetToBundledClaudeRuntime,
  runClaudeAuthLogin,
  runClaudeAuthLogout,
  submitClaudeAuthCode,
} from "./claude_runtime.mjs";
import {
  activateProvider,
  addCustomBackground,
  clearAllClaudeCliSids,
  closeDb,
  createSession,
  deleteCustomBackground,
  deleteInstalledMcp,
  deleteInstalledSkill,
  deleteMemory,
  deleteProvider,
  deleteSession,
  getActiveProvider,
  getAllSettings,
  getDatabaseStats,
  getDb,
  getProvider,
  getSessionMeta,
  getSessionTimeline,
  listCustomBackgrounds,
  listInstalledMcps,
  listInstalledSkills,
  listMemories,
  listProviders,
  listSessions,
  optimizeDatabase,
  saveInstalledMcp,
  saveInstalledSkill,
  saveMemory,
  saveProvider,
  setSetting,
  switchBranch,
  updateSessionMeta,
} from "./db.mjs";
import {
  buildAiDiagnosticBundle,
  classifyError,
  logEvent,
  newReqId,
  readTurnLog,
  tailLogs,
} from "./logger.mjs";
import { McpManager } from "./mcp_client.mjs";
import { recordDeletedDiskMemory, resetMemorySyncCache, syncDiskMemoriesToDb, syncMemoryToDisk } from "./memory_sync.mjs";
import { enrichProviderForClient, fetchProviderModels, testProviderConnection } from "./model_registry.mjs";
import { SessionOrchestrator } from "./orchestrator.mjs";
import { getPaths, PUBLIC_DIR } from "./paths.mjs";
import { killProcessTree, proxyFetch } from "./runtime_utils.mjs";
import {
  atomicWriteFileSync,
  capMapSize,
  isRealPathInsideDir,
  isSafePublicUrl,
  isValidInternalRequest,
  parseCookies,
  safeTokenEqual,
  streamFileWithRange,
} from "./security.mjs";
import {
  downloadRemoteSkillContent,
  importPublicSkillFromUrl,
  resolvePublicMcpImport,
  searchMcpStore,
  searchSkillsStore,
  searchWallpaperStore,
} from "./stores.mjs";
import { checkForUpdates, getAppVersion } from "./updater.mjs";
import { searchWebLive } from "./web_search.mjs";
import {
  detectSteamWallpaperEngineDirs,
  getAuthorizedWallpaperItem,
  scanAuthorizedWallpaperLibrary,
  serializeWeItemForClient,
  serveAuthorizedWebAsset,
  streamAuthorizedMedia,
} from "./wallpaper_engine.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
};

const ALLOWED_IMAGE_MIMES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const ALLOWED_BG_MIMES = {
  ...ALLOWED_IMAGE_MIMES,
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

const TEXT_FILE_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".pyw", ".java", ".kt", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs",
  ".rb", ".php", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".sql", ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte",
  ".svg", ".tex", ".r", ".lua", ".dart", ".swift", ".gradle", ".properties", ".dockerfile", ".gitignore", ".editorconfig",
]);

function isLikelyUtf8TextBuffer(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (!sample.length) return true;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return false; // NUL byte => binary
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) bad++;
  }
  return bad / sample.length < 0.05;
}

function enforceUploadsBudget(dir, maxBytes = 200 * 1024 * 1024) {
  try {
    const files = fs
      .readdirSync(dir)
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return st.isFile() ? { full, size: st.size, mtimeMs: st.mtimeMs } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((s, f) => s + f.size, 0);
    while (total > maxBytes && files.length > 0) {
      const oldest = files.shift();
      try { fs.unlinkSync(oldest.full); } catch {}
      total -= oldest.size;
    }
  } catch {}
}

let _wpStorageCache = { at: 0, dir: "", data: null };

function invalidateWallpaperStorageCache() {
  _wpStorageCache.at = 0;
  _wpStorageCache.data = null;
}

function cleanupOldActiveWallpapers(dir, keepName = "") {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("active_wallpaper_") && f !== keepName) {
        try {
          fs.unlinkSync(path.join(dir, f));
          removed++;
        } catch {}
      }
    }
  } catch {}
  if (removed > 0) invalidateWallpaperStorageCache();
  return removed;
}

function getWallpaperStorageStats(dir, force = false) {
  if (!force && _wpStorageCache.data && _wpStorageCache.dir === dir && Date.now() - _wpStorageCache.at < 30_000) {
    return _wpStorageCache.data;
  }
  let activeBytes = 0;
  let uploadBytes = 0;
  let cacheBytes = 0;
  let cacheCount = 0;
  let uploadCount = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      if (f.startsWith("active_wallpaper_")) {
        activeBytes += st.size;
      } else if (f.startsWith("wp_cache_")) {
        cacheBytes += st.size;
        if (!f.endsWith(".mime")) cacheCount++;
      } else if (f.startsWith("bg_")) {
        uploadBytes += st.size;
        uploadCount++;
      }
    }
  } catch {}
  const toMb = (b) => Math.round((b / (1024 * 1024)) * 100) / 100;
  const stats = {
    active_mb: toMb(activeBytes),
    uploads_mb: toMb(uploadBytes),
    cache_mb: toMb(cacheBytes),
    total_mb: toMb(activeBytes + uploadBytes + cacheBytes),
    cache_count: cacheCount,
    upload_count: uploadCount,
    cache_limit_mb: 35,
  };
  _wpStorageCache = { at: Date.now(), dir, data: stats };
  return stats;
}

function clearWallpaperPreviewCache(dir) {
  let removed = 0;
  let freedBytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("wp_cache_")) continue;
      const full = path.join(dir, f);
      try {
        freedBytes += fs.statSync(full).size || 0;
        fs.unlinkSync(full);
        if (!f.endsWith(".mime")) removed++;
      } catch {}
    }
  } catch {}
  invalidateWallpaperStorageCache();
  return { removed, freed_mb: Math.round((freedBytes / (1024 * 1024)) * 100) / 100 };
}

function cleanupLegacyResidues(paths, activeSessionIds = [], purgeArchived = false) {
  let portableDirsRemoved = 0;
  let tempFreedBytes = 0;
  const currentExecDir = path.resolve(path.dirname(process.execPath || "")).toLowerCase();

  const dirSizeBytes = (dirPath, depth = 0) => {
    if (depth > 4) return 0;
    let sum = 0;
    try {
      for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (ent.isSymbolicLink()) continue;
        const full = path.join(dirPath, ent.name);
        if (ent.isFile()) {
          try {
            sum += fs.statSync(full).size || 0;
          } catch {}
        } else if (ent.isDirectory()) {
          sum += dirSizeBytes(full, depth + 1);
        }
      }
    } catch {}
    return sum;
  };

  // 1. Clean exited electron-builder portable temp extraction folders (`%TEMP%/...` containing `OpenCode Studio.exe` + `resources/app.asar`)
  try {
    const tmpRoot = os.tmpdir();
    for (const ent of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      const candDir = path.join(tmpRoot, ent.name);
      if (path.resolve(candDir).toLowerCase() === currentExecDir) continue;
      const markerExe = path.join(candDir, "OpenCode Studio.exe");
      const markerAsar = path.join(candDir, "resources", "app.asar");
      if (!fs.existsSync(markerExe) || !fs.existsSync(markerAsar)) continue;
      // Verify EXE is not locked by a running instance before removing directory
      let isLocked = false;
      try {
        const fd = fs.openSync(markerExe, "r+");
        fs.closeSync(fd);
      } catch {
        isLocked = true;
      }
      if (isLocked) continue;
      const bytes = dirSizeBytes(candDir);
      try {
        fs.rmSync(candDir, { recursive: true, force: true });
        if (!fs.existsSync(candDir)) {
          portableDirsRemoved += 1;
          tempFreedBytes += bytes;
        }
      } catch {
        // Still running / locked by OS — safely skip
      }
    }
  } catch {}

  // 2. Clean leftover temporary system prompt & MCP config files older than 5 minutes
  let orphanPromptsRemoved = 0;
  try {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const f of fs.readdirSync(paths.mcpDir)) {
      if (!/^mcp_cfg_.*\.json$/i.test(f)) continue;
      const fp = path.join(paths.mcpDir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
    for (const f of fs.readdirSync(paths.logsDir)) {
      if (!/^prompt_.*\.txt$/i.test(f)) continue;
      const fp = path.join(paths.logsDir, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) {
          tempFreedBytes += st.size || 0;
          fs.unlinkSync(fp);
          orphanPromptsRemoved += 1;
        }
      } catch {}
    }
  } catch {}

  // 3. Clear wallpaper preview cache (`wp_cache_*`, keeps active offline wallpaper & user uploads intact)
  const wpCleared = clearWallpaperPreviewCache(paths.backgroundsDir);

  // 4. Purge 0-turn empty shell sessions (+ optional archived sessions) & compact SQLite WAL
  const dbRes = optimizeDatabase({
    purgeArchived: Boolean(purgeArchived),
    purgeEmptyShells: true,
    activeSessionIds,
  });

  const tempFreedMb = Math.round((tempFreedBytes / (1024 * 1024)) * 100) / 100;
  const totalFreedMb = Math.round(((tempFreedMb + (wpCleared.freed_mb || 0) + (dbRes.freed_mb || 0))) * 100) / 100;

  return {
    ok: true,
    portable_dirs_removed: portableDirsRemoved,
    orphan_prompts_removed: orphanPromptsRemoved,
    wp_cache_removed: wpCleared.removed || 0,
    purged_empty_shells: dbRes.purged_empty_shells || 0,
    purged_sessions: dbRes.purged_sessions || 0,
    temp_freed_mb: tempFreedMb,
    wp_cache_freed_mb: wpCleared.freed_mb || 0,
    db_freed_mb: dbRes.freed_mb || 0,
    total_freed_mb: totalFreedMb,
    after_db: dbRes.after,
    wallpaper_storage: getWallpaperStorageStats(paths.backgroundsDir, true),
  };
}

function extFromMediaMime(mime, urlHint = "") {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  if (map[m]) return map[m];
  const extMatch = String(urlHint || "").match(/\.(jpg|jpeg|png|webp|gif|mp4|webm)(?:[?#]|$)/i);
  return extMatch ? `.${extMatch[1].toLowerCase()}` : ".jpg";
}

const _inflightMediaFetches = new Map();

async function fetchPublicMediaBuffer(rawUrl, fbUrl = "") {
  const inflightKey = `${rawUrl}||${fbUrl}`;
  if (_inflightMediaFetches.has(inflightKey)) {
    return await _inflightMediaFetches.get(inflightKey);
  }
  const task = (async () => {
    const proxyUrl = getAllSettings().search_engine?.proxy_url || "";
    const tryFetch = async (targetUrl) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const originRef = new URL(targetUrl).origin + "/";
        const upstream = await proxyFetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
            Referer: originRef,
            Accept: "image/avif,image/webp,image/apng,image/gif,image/*,video/webm,video/mp4,*/*;q=0.8",
          },
          signal: controller.signal,
          proxyUrl,
        });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        const mime = (upstream.headers.get("content-type") || "image/jpeg").split(";")[0];
        if (!mime.startsWith("image/") && !mime.startsWith("video/")) throw new Error(`不支持的媒体类型 ${mime}`);
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > 35 * 1024 * 1024) throw new Error("超过 35MB 限制");
        return { buf, mime };
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await tryFetch(rawUrl);
    } catch (e1) {
      if (fbUrl && isPublicMediaUrl(fbUrl)) return await tryFetch(fbUrl);
      throw e1;
    }
  })();

  _inflightMediaFetches.set(inflightKey, task);
  try {
    return await task;
  } finally {
    _inflightMediaFetches.delete(inflightKey);
  }
}

async function pinActiveWallpaperIfNeeded(appearance, bgDir) {
  if (!appearance || typeof appearance !== "object") return appearance;
  const next = { ...appearance };
  const bgType = next.bgType || "none";
  const bgUrl = String(next.bgUrl || "");

  // When switching to solid color, local 60fps Canvas, gradient, or user upload, immediately remove old pinned online wallpaper
  if (bgType === "none" || bgType === "live" || bgType === "gradient" || !bgUrl) {
    cleanupOldActiveWallpapers(bgDir, "");
    next.sourceUrl = "";
    return next;
  }
  if (bgUrl.startsWith("/api/bg-files/active_wallpaper_")) {
    const keep = path.basename(bgUrl);
    cleanupOldActiveWallpapers(bgDir, keep);
    return next;
  }
  if (bgUrl.startsWith("/api/bg-files/")) {
    cleanupOldActiveWallpapers(bgDir, "");
    next.sourceUrl = bgUrl;
    return next;
  }
  if (bgUrl.startsWith("/api/we/")) {
    // Zero-copy Wallpaper Engine / local 4K video streaming: NEVER duplicate multi-hundred-MB files!
    cleanupOldActiveWallpapers(bgDir, "");
    next.sourceUrl = bgUrl;
    next.offlineReady = true;
    return next;
  }

  // Online wallpaper via `/api/wallpaper-proxy?url=...` or direct `https://...` -> pin ONE offline local copy & delete old one!
  let rawUrl = bgUrl;
  let fbUrl = "";
  if (bgUrl.startsWith("/api/wallpaper-proxy?")) {
    try {
      const sp = new URL(bgUrl, "http://127.0.0.1").searchParams;
      rawUrl = sp.get("url") || "";
      fbUrl = sp.get("fb") || "";
    } catch {}
  }
  if (!isPublicMediaUrl(rawUrl)) return next;

  try {
    const hash = crypto.createHash("sha1").update(rawUrl).digest("hex");
    const cachePath = path.join(bgDir, `wp_cache_${hash}`);
    const metaPath = `${cachePath}.mime`;
    let buf;
    let mime;
    if (fs.existsSync(cachePath) && fs.existsSync(metaPath)) {
      buf = fs.readFileSync(cachePath);
      mime = fs.readFileSync(metaPath, "utf8").trim() || "image/jpeg";
    } else {
      const fetched = await fetchPublicMediaBuffer(rawUrl, fbUrl);
      buf = fetched.buf;
      mime = fetched.mime;
    }
    const ext = extFromMediaMime(mime, rawUrl);
    const keepName = `active_wallpaper_${hash.slice(0, 12)}${ext}`;
    fs.writeFileSync(path.join(bgDir, keepName), buf);
    cleanupOldActiveWallpapers(bgDir, keepName);
    next.sourceUrl = bgUrl;
    next.bgUrl = `/api/bg-files/${keepName}`;
    next.offlineReady = true;
  } catch (err) {
    logEvent("WARN", "wallpapers", "pin_offline_failed", `固化离线壁纸失败: ${err.message}`);
  }
  return next;
}

function spawnAsyncStdout(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve({ status: -1, stdout, stderr: stderr + " timeout" });
    }, opts.timeout || 180000);
    proc.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    proc.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("error", (err) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: err.message }); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ status: code ?? 0, stdout, stderr }); });
  });
}

/**
 * Async, non-blocking, FOREGROUND native OS directory picker dialog.
 * Windows: first checks Win32 GetThreadDesktop name:
 *  - If running on the user's visible "Default" desktop: shows Win32 modern IFileOpenDialog
 *    parented to a TopMost transparent owner Form so Explorer pops strictly ABOVE the browser!
 *  - If running inside a non-interactive / background virtual desktop (e.g., exebox / service):
 *    fails fast (<300ms) with `non_interactive: true` so the UI immediately opens the built-in
 *    interactive full-disk folder explorer instead of hanging!
 */
async function pickNativeDirectoryDialog(initialDir = "") {
  if (process.platform === "win32") {
    const safeInit = String(initialDir || "").replace(/'/g, "''");
    const ps = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$cs = @'
using System;
using System.Text;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public static class ModernFolderPicker {
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialog {}

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler(); void GetParent();
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    public static string GetDesktopName() {
        var sb = new StringBuilder(256); int n;
        GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, sb, sb.Capacity * 2, out n);
        return sb.ToString();
    }

    public static string Pick(string initialDir) {
        string desk = GetDesktopName();
        if (!Environment.UserInteractive || (!string.IsNullOrEmpty(desk) && !string.Equals(desk, "Default", StringComparison.OrdinalIgnoreCase))) {
            return "__NON_INTERACTIVE__:" + desk;
        }
        using (var owner = new Form()) {
            owner.FormBorderStyle = FormBorderStyle.None;
            owner.ShowInTaskbar = false;
            owner.TopMost = true;
            owner.Opacity = 0.01;
            owner.StartPosition = FormStartPosition.Manual;
            owner.Location = new Point(-2000, -2000);
            owner.Size = new Size(1, 1);
            owner.Show();
            owner.Activate();
            SetForegroundWindow(owner.Handle);

            var dlg = (IFileOpenDialog)new FileOpenDialog();
            uint opts;
            dlg.GetOptions(out opts);
            // FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40) | FOS_PATHMUSTEXIST (0x800)
            dlg.SetOptions(opts | 0x20u | 0x40u | 0x800u);
            dlg.SetTitle("选择 OpenCode Studio 工作目录");
            if (!string.IsNullOrEmpty(initialDir)) {
                try {
                    Guid g = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                    IShellItem item;
                    SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref g, out item);
                    if (item != null) dlg.SetFolder(item);
                } catch {}
            }
            int hr = dlg.Show(owner.Handle);
            if (hr == 0) {
                IShellItem res;
                dlg.GetResult(out res);
                if (res != null) {
                    string path;
                    res.GetDisplayName(0x80058000u, out path);
                    return path;
                }
            }
            return "";
        }
    }
}
'@
Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms,System.Drawing
$init = '${safeInit}'
if ($init -and -not (Test-Path -LiteralPath $init)) { $init = '' }
$picked = [ModernFolderPicker]::Pick($init)
if ($picked) { Write-Output $picked }
`;
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const res = await spawnAsyncStdout("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded], {
      windowsHide: false,
      timeout: 180000,
    });
    const out = res.stdout.trim();
    if (out.startsWith("__NON_INTERACTIVE__:")) {
      const desk = out.slice("__NON_INTERACTIVE__:".length);
      logEvent("INFO", "dirs", "pick_native_non_interactive", `服务运行于非交互桌面 (${desk})，已自动切至内置本地文件夹浏览器`);
      return {
        ok: false,
        path: null,
        non_interactive: true,
        desktop: desk,
        error: "当前本地服务由后台会话启动，系统弹窗被隔离在后台桌面；已为您自动展开下方全盘本地文件夹浏览器（双击桌面 OpenCode Studio.bat 或使用桌面安装包可恢复原生资源管理器弹窗）。",
      };
    }
    if (res.stderr.trim()) {
      logEvent("WARN", "dirs", "pick_native_stderr", res.stderr.trim().slice(0, 300));
    }
    return { ok: Boolean(out), path: out || null, non_interactive: false };
  }
  if (process.platform === "darwin") {
    const res = await spawnAsyncStdout("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择工作目录")']);
    const out = res.stdout.trim();
    return { ok: Boolean(out), path: out || null, non_interactive: false };
  }
  const z = await spawnAsyncStdout("zenity", ["--file-selection", "--directory", "--title=选择工作目录"]);
  if (z.status === 0 && z.stdout.trim()) return { ok: true, path: z.stdout.trim(), non_interactive: false };
  const k = await spawnAsyncStdout("kdialog", ["--getexistingdirectory"]);
  if (k.status === 0 && k.stdout.trim()) return { ok: true, path: k.stdout.trim(), non_interactive: false };
  return { ok: false, path: null, non_interactive: !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY };
}

function isPublicMediaUrl(rawUrl) {
  return isSafePublicUrl(rawUrl);
}

function enforceWallpaperCacheBudget(dir, maxBytes = 80 * 1024 * 1024) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("wp_cache_") && !f.endsWith(".mime"))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { full, size: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((s, f) => s + f.size, 0);
    while (total > maxBytes && files.length > 0) {
      const oldest = files.shift();
      try { fs.unlinkSync(oldest.full); } catch {}
      try { fs.unlinkSync(`${oldest.full}.mime`); } catch {}
      total -= oldest.size;
    }
  } catch {}
}

function listAvailableDrives() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const drives = [];
    for (let code = 67; code <= 90; code++) {
      const root = `${String.fromCharCode(code)}:\\`;
      try {
        if (fs.existsSync(root)) drives.push(root);
      } catch {}
    }
    return { platform: "win32", home, drives: drives.length ? drives : ["C:\\"] };
  }
  return { platform: process.platform, home, drives: [home, "/"] };
}

const _staticAssetCache = new Map();

function acceptsGzip(req) {
  const enc = String(req?.headers?.["accept-encoding"] || "");
  return /\bgzip\b/i.test(enc);
}

function serveStaticFile(req, res, fp) {
  const st = fs.statSync(fp);
  const ext = path.extname(fp).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const compressible = /\.(html|css|js|mjs|json|svg)$/i.test(ext);
  const secHeaders = {
    "X-Content-Type-Options": "nosniff",
    ...(ext === ".html"
      ? {
          "X-Frame-Options": "SAMEORIGIN",
          "Referrer-Policy": "no-referrer",
        }
      : {}),
  };

  if (st.size <= 2 * 1024 * 1024) {
    let cached = _staticAssetCache.get(fp);
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      const raw = fs.readFileSync(fp);
      const gzip = compressible && raw.length >= 512 ? zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED }) : null;
      const etag = `W/"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
      cached = { mtimeMs: st.mtimeMs, size: st.size, etag, raw, gzip };
      _staticAssetCache.set(fp, cached);
      capMapSize(_staticAssetCache, 64);
    }

    if (req.headers["if-none-match"] === cached.etag) {
      res.writeHead(304, { ETag: cached.etag, "Cache-Control": "no-cache", ...secHeaders });
      return res.end();
    }

    const useGzip = Boolean(cached.gzip && acceptsGzip(req));
    const outBuf = useGzip ? cached.gzip : cached.raw;
    const headers = {
      "Content-Type": contentType,
      "Content-Length": outBuf.length,
      ETag: cached.etag,
      "Cache-Control": "no-cache",
      Vary: "Accept-Encoding",
      ...secHeaders,
    };
    if (useGzip) headers["Content-Encoding"] = "gzip";
    res.writeHead(200, headers);
    return res.end(outBuf);
  }

  return streamFileWithRange(req, res, fp, {
    contentType,
    cacheControl: "no-cache",
    extraHeaders: secHeaders,
  });
}

function sendJson(res, status, data) {
  const rawBuf = Buffer.from(JSON.stringify(data), "utf8");
  const useGzip = rawBuf.length >= 2048 && acceptsGzip(res._req);
  const outBuf = useGzip ? zlib.gzipSync(rawBuf, { level: zlib.constants.Z_BEST_SPEED }) : rawBuf;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": outBuf.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (useGzip) {
    headers["Content-Encoding"] = "gzip";
    headers.Vary = "Accept-Encoding";
  }
  res.writeHead(status, headers);
  res.end(outBuf);
}

async function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  const ctype = String(req.headers?.["content-type"] || "").toLowerCase();
  if (ctype && !ctype.includes("application/json")) {
    const err = new Error("仅接受 Content-Type: application/json 请求");
    err.code = "ERR_UNSUPPORTED_MEDIA_TYPE";
    throw err;
  } else if (!ctype && Number(req.headers?.["content-length"] || 0) > 0) {
    const err = new Error("缺少 Content-Type: application/json 请求头");
    err.code = "ERR_UNSUPPORTED_MEDIA_TYPE";
    throw err;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("请求体超过限制 (25MB)");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function listDirectorySafe(targetPath) {
  const home = os.homedir();
  const shortcuts = [
    { label: `用户主目录 (${home})`, path: home },
    { label: "桌面 (Desktop)", path: path.join(home, "Desktop") },
    { label: "文档 (Documents)", path: path.join(home, "Documents") },
  ].filter((s) => fs.existsSync(s.path));

  // On Windows, also list available drive roots (C:\, D:\, ...)
  if (process.platform === "win32") {
    for (const letter of ["C", "D", "E", "F"]) {
      const root = `${letter}:\\`;
      if (fs.existsSync(root)) shortcuts.push({ label: `本地磁盘 (${root})`, path: root });
    }
  }

  const target = targetPath ? path.resolve(targetPath) : home;
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return { ok: false, path: target, parent: path.dirname(target), shortcuts, children: [], error: `目录不存在: ${target}` };
  }

  const children = [];
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name.startsWith("$")) continue;
      if (e.isDirectory()) {
        children.push({ name: e.name, path: path.join(target, e.name) });
      }
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // ignore permission denied
  }

  return {
    ok: true,
    path: target,
    parent: path.dirname(target),
    shortcuts,
    children: children.slice(0, 150),
  };
}

function scanWorkspaceFiles(cwd, query = "") {
  const q = String(query || "").toLowerCase();
  if (!cwd || !fs.existsSync(cwd)) return [];
  const out = [];
  const deadline = Date.now() + 300;
  const ignore = new Set([".git", "node_modules", "__pycache__", "dist", "build", ".venv", "AppData"]);

  const walk = (cur, depth) => {
    if (out.length >= 35 || depth > 3 || Date.now() > deadline) return;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 35 || Date.now() > deadline) return;
      if (ignore.has(e.name) || (e.name.startsWith(".") && e.name !== ".env")) continue;
      const full = path.join(cur, e.name);
      const rel = path.relative(cwd, full).replace(/\\/g, "/");
      if (!q || rel.toLowerCase().includes(q)) {
        out.push({ path: full, rel, is_dir: e.isDirectory() });
      }
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(cwd, 0);
  return out;
}

export async function startServer({
  host = "127.0.0.1",
  port = Number(process.env.OPENCODE_PORT || 17620),
  desktopMode = process.env.OPENCODE_DESKTOP_MODE === "1",
  requireAuth = true,
} = {}) {
  const paths = getPaths();
  getDb(); // initialize SQLite WAL schema

  // Instance-scoped cryptographic session token (prevents CSWSH, CSRF, DNS rebinding & external browser snooping!)
  const authToken = crypto.randomBytes(32).toString("hex");
  let desktopBootNonce = crypto.randomBytes(24).toString("hex");
  const localTokenFile = path.join(paths.dataRoot, ".local_session_token");
  if (!desktopMode && requireAuth) {
    try {
      atomicWriteFileSync(localTokenFile, authToken, { encoding: "utf8", mode: 0o600 });
    } catch {}
  }

  const mcpManager = new McpManager();
  mcpManager.syncFromDb().catch(() => {});

  const wsClients = new Set();
  const broadcast = (payload) => {
    if (!wsClients.size) return;
    const raw = JSON.stringify(payload);
    for (const ws of wsClients) {
      if (ws.readyState === 1) {
        try {
          ws.send(raw);
        } catch {}
      }
    }
  };

  let boundPort = port;
  const orchestrator = new SessionOrchestrator({ broadcast, mcpManager, getPort: () => boundPort });
  const appVersion = getAppVersion();

  const isAllowedHostHeader = (rawHost) => {
    if (!rawHost) return false;
    const h = String(rawHost).trim().toLowerCase();
    return (
      h === `127.0.0.1:${boundPort}` ||
      h === `localhost:${boundPort}` ||
      (boundPort === 80 && (h === "127.0.0.1" || h === "localhost"))
    );
  };

  const isAllowedOriginHeader = (rawOrigin) => {
    if (!rawOrigin) return true;
    const o = String(rawOrigin).trim().toLowerCase();
    return o === `http://127.0.0.1:${boundPort}` || o === `http://localhost:${boundPort}`;
  };

  const isRequestAuthenticated = (req) => {
    if (!requireAuth) return true;
    const headerTok = String(req.headers?.["x-ocs-token"] || "").trim();
    if (headerTok && safeTokenEqual(headerTok, authToken)) return true;
    const cookies = parseCookies(req.headers?.cookie);
    if (cookies.ocs_session && safeTokenEqual(cookies.ocs_session, authToken)) return true;
    return false;
  };

  // Warm up Claude runtime & auth status asynchronously in background so first `/api/bootstrap` never blocks!
  refreshClaudeRuntimeAndAuthAsync(false)
    .then((status) => broadcast({ type: "claude_status_updated", claude_native: status }))
    .catch(() => {});

  const server = http.createServer(async (req, res) => {
    res._req = req;
    const reqId = newReqId();
    try {
      // 1. Strict Host validation against DNS rebinding attacks
      if (requireAuth && !isAllowedHostHeader(req.headers.host)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Forbidden: Invalid Host header");
      }

      const urlObj = new URL(req.url || "/", `http://${host}:${boundPort || port}`);
      let pathname;
      try {
        pathname = decodeURIComponent(urlObj.pathname);
      } catch {
        return sendJson(res, 400, { ok: false, error: "Invalid URL encoding" });
      }
      const method = (req.method || "GET").toUpperCase();

      // ==================== BUILT-IN TRANSPARENT API PROXY FOR NATIVE CLAUDE CODE ====================
      const proxyMatch = pathname.match(/^\/proxy\/provider\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(\/v1\/.*)$/);
      if (method === "POST" && proxyMatch) {
        const thinkingHint = proxyMatch[2] ? decodeURIComponent(proxyMatch[2]) : "";
        const sessionIdHint = proxyMatch[3] ? decodeURIComponent(proxyMatch[3]) : "";
        return await handleProviderProxyRequest(
          req,
          res,
          proxyMatch[1],
          proxyMatch[4],
          thinkingHint,
          sessionIdHint,
          requireAuth,
        );
      }

      // ==================== INTERNAL PERMISSION GUARD CALLBACK ====================
      if (method === "POST" && pathname === "/api/internal/confirm") {
        if (!isValidInternalRequest(req)) {
          return sendJson(res, 401, { ok: false, error: "Unauthorized internal guard call" });
        }
        const body = await readJsonBody(req);
        const approved = await orchestrator.requestExternalConfirm(String(body.session_id || ""), {
          tool: String(body.tool || "Bash"),
          command: String(body.command || ""),
          reason: String(body.reason || "检测到高风险操作，请确认是否允许执行："),
        });
        return sendJson(res, 200, { ok: true, approved: Boolean(approved) });
      }

      // ==================== ONE-TIME BOOTSTRAP COOKIE HANDSHAKE ====================
      if (method === "GET" && pathname === "/") {
        const bootParam = urlObj.searchParams.get("ocs_boot") || "";
        const authParam = urlObj.searchParams.get("ocs_auth") || "";
        const validDesktopBoot = desktopMode && bootParam && safeTokenEqual(bootParam, desktopBootNonce);
        const validLocalAuth = !desktopMode && authParam && safeTokenEqual(authParam, authToken);
        if (validDesktopBoot || validLocalAuth) {
          if (validDesktopBoot) {
            desktopBootNonce = crypto.randomBytes(24).toString("hex");
          }
          res.writeHead(302, {
            Location: "/",
            "Set-Cookie": `ocs_session=${authToken}; Path=/; HttpOnly; SameSite=Strict`,
            "Cache-Control": "no-store",
          });
          return res.end();
        }
      }

      // ==================== HEALTH PROBE (MINIMAL WHEN UNAUTHENTICATED) ====================
      if (method === "GET" && pathname === "/api/health") {
        if (!isRequestAuthenticated(req)) {
          return sendJson(res, 200, { ok: true, app: "OpenCode Studio", version: appVersion });
        }
        const activeProv = enrichProviderForClient(getActiveProvider(false));
        return sendJson(res, 200, {
          ok: true,
          app: "OpenCode Studio",
          version: appVersion,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          data_root: paths.dataRoot,
          active_provider: activeProv,
          running_sessions: orchestrator.runningSessionIds(),
        });
      }

      // ==================== ORIGIN & SESSION AUTH GATE ====================
      // Allow read-only sandboxed Wallpaper Engine Web assets (`Origin: null` inside `<iframe sandbox="allow-scripts">`)
      const isSandboxedWeReadOnly =
        method === "GET" && (pathname.startsWith("/api/we/web/") || pathname === "/api/we/media");

      if (requireAuth && !isSandboxedWeReadOnly) {
        if (req.headers.origin && !isAllowedOriginHeader(req.headers.origin)) {
          return sendJson(res, 403, { ok: false, error: "拒绝跨站 Origin 请求" });
        }
        if (pathname.startsWith("/api/")) {
          if (!isRequestAuthenticated(req)) {
            return sendJson(res, 401, { ok: false, error: "未授权访问本地服务，请通过应用窗口或官方启动器打开。" });
          }
        } else if (desktopMode && !isRequestAuthenticated(req)) {
          // Pure Desktop Mode: strictly block external web browsers from loading the UI!
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          return res.end(
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>OpenCode Studio 桌面安全隔离</title></head>` +
              `<body style="font-family:system-ui,sans-serif;background:#0f1116;color:#e5e7eb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">` +
              `<div style="max-width:460px;padding:28px;border-radius:16px;background:#181b23;border:1px solid rgba(255,255,255,0.1);text-align:center;">` +
              `<h3 style="margin:0 0 10px;">OpenCode Studio 独立桌面客户端</h3>` +
              `<p style="margin:0;color:#9ca3af;font-size:14px;line-height:1.6;">当前运行于非网页独立桌面安全隔离模式，已禁止任何外部浏览器或网页访问内部进程端口。</p>` +
              `</div></body></html>`,
          );
        }
      }

      if (method === "GET" && pathname === "/api/bootstrap") {
        const providers = listProviders(false).map(enrichProviderForClient);
        return sendJson(res, 200, {
          version: appVersion,
          platform: process.platform,
          settings: getAllSettings(),
          providers,
          active_provider: providers.find((p) => p.is_active) || providers[0] || null,
          claude_native: getClaudeRuntimeAndAuth(false),
          installed_mcps: mcpManager.getStatusList(),
          installed_skills: listInstalledSkills(),
          custom_backgrounds: listCustomBackgrounds(),
          wallpaper_storage: getWallpaperStorageStats(paths.backgroundsDir),
          db_stats: getDatabaseStats(),
          running_sessions: orchestrator.runningSessionIds(),
        });
      }

      // ==================== DATABASE STATS & ONE-CLICK MAINTENANCE ====================
      if (method === "GET" && pathname === "/api/db/stats") {
        return sendJson(res, 200, { ok: true, stats: getDatabaseStats() });
      }
      if (method === "POST" && pathname === "/api/db/optimize") {
        const body = await readJsonBody(req).catch(() => ({}));
        const result = optimizeDatabase({
          purgeArchived: Boolean(body.purge_archived),
          purgeEmptyShells: Boolean(body.purge_empty_shells),
          activeSessionIds: orchestrator.runningSessionIds(),
        });
        if (result.purged_empty_shells > 0) {
          broadcast({ type: "session_meta_updated" });
        }
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/api/system/cleanup-legacy") {
        const body = await readJsonBody(req).catch(() => ({}));
        const result = cleanupLegacyResidues(paths, orchestrator.runningSessionIds(), Boolean(body.purge_archived));
        if (result.purged_empty_shells > 0 || result.purged_sessions > 0) {
          broadcast({ type: "session_meta_updated" });
        }
        return sendJson(res, 200, result);
      }

      // ==================== NATIVE CLAUDE CODE AUTH & VERSION MANAGEMENT ====================
      if (method === "GET" && pathname === "/api/claude/status") {
        const force = urlObj.searchParams.get("refresh") === "1";
        return sendJson(res, 200, await refreshClaudeRuntimeAndAuthAsync(force));
      }
      if (method === "GET" && pathname === "/api/claude/versions") {
        return sendJson(res, 200, await checkClaudeVersions());
      }
      if (method === "POST" && pathname === "/api/claude/auth/login") {
        const body = await readJsonBody(req);
        const result = await runClaudeAuthLogin({
          mode: body.mode || "claudeai",
          email: body.email || "",
          onProgress: (ev) => broadcast({ type: "claude_auth_progress", ...ev }),
        });
        broadcast({ type: "claude_status_updated", claude_native: getClaudeRuntimeAndAuth(true) });
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/api/claude/auth/submit-code") {
        const body = await readJsonBody(req);
        const result = await submitClaudeAuthCode(body.code || "");
        if (result.runtime) broadcast({ type: "claude_status_updated", claude_native: result.runtime });
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/api/claude/auth/logout") {
        const result = runClaudeAuthLogout();
        broadcast({ type: "claude_status_updated", claude_native: result.runtime });
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/api/claude/install") {
        const body = await readJsonBody(req);
        const result = await installOrSwitchClaudeVersion({
          channel: body.channel === "latest" ? "latest" : "stable",
          forceNativeWin: Boolean(body.force_native_win),
          onProgress: (chunk) => broadcast({ type: "claude_install_log", text: chunk }),
          onPercent: (prog) => broadcast({ type: "claude_install_progress", ...prog }),
        });
        broadcast({ type: "claude_status_updated", claude_native: result.runtime || getClaudeRuntimeAndAuth(true) });
        return sendJson(res, 200, result);
      }
      if (method === "POST" && pathname === "/api/claude/reset-bundled") {
        await readJsonBody(req).catch(() => ({}));
        const rt = await resetToBundledClaudeRuntime();
        broadcast({ type: "claude_status_updated", claude_native: rt });
        return sendJson(res, 200, { ok: true, runtime: rt });
      }

      // ==================== SETTINGS ====================
      if (method === "GET" && pathname === "/api/settings") {
        return sendJson(res, 200, getAllSettings());
      }
      if (method === "PUT" && pathname === "/api/settings") {
        const body = await readJsonBody(req);
        if (body.appearance && typeof body.appearance === "object") {
          body.appearance = await pinActiveWallpaperIfNeeded(body.appearance, paths.backgroundsDir);
        }
        const prevSettings = getAllSettings();
        const prevIsolation = prevSettings.claude_isolation;
        const isolationChanged =
          body.claude_isolation !== undefined && body.claude_isolation !== prevIsolation;
        const promptChanged =
          (body.system_prompt !== undefined && String(body.system_prompt) !== String(prevSettings.system_prompt)) ||
          (body.prompt_mode !== undefined && String(body.prompt_mode) !== String(prevSettings.prompt_mode));
        for (const key of [
          "system_prompt",
          "prompt_mode",
          "permission_mode",
          "claude_isolation",
          "update_channel",
          "web_search_enabled",
          "favorite_wallpapers",
          "appearance",
          "search_engine",
          "wallpaper_engine",
          "default_cwd",
        ]) {
          if (body[key] !== undefined) setSetting(key, body[key]);
        }
        if (promptChanged) {
          // Reset cached CLI session IDs so ongoing conversations immediately adopt the new system prompt!
          const staleCliSids = clearAllClaudeCliSids();
          if (staleCliSids.length) {
            try {
              cleanupClaudeSessionFiles(staleCliSids);
            } catch {}
          }
        }
        const next = getAllSettings();
        broadcast({ type: "settings_updated", settings: next });
        if (isolationChanged) {
          clearRuntimeCache();
          resetMemorySyncCache();
          // Refresh Claude runtime & sync active Claude directory memories asynchronously
          setImmediate(async () => {
            try {
              syncDiskMemoriesToDb({ force: true });
              broadcast({ type: "memories_updated" });
              const refreshed = await refreshClaudeRuntimeAndAuthAsync(true);
              broadcast({ type: "claude_status_updated", claude_native: refreshed });
            } catch {}
          });
        }
        return sendJson(res, 200, {
          ok: true,
          settings: next,
          wallpaper_storage: getWallpaperStorageStats(paths.backgroundsDir),
          ...(isolationChanged ? { claude_native: getClaudeRuntimeAndAuth(false) } : {}),
        });
      }

      // ==================== PROVIDERS & MODEL CAPABILITIES ====================
      if (method === "GET" && pathname === "/api/providers") {
        return sendJson(res, 200, {
          providers: listProviders(false).map(enrichProviderForClient),
          claude_native: getClaudeRuntimeAndAuth(false),
        });
      }
      if (method === "POST" && pathname === "/api/providers/test") {
        const body = await readJsonBody(req);
        const existing = body.id ? getProvider(body.id, true) : null;
        const kind = body.kind || existing?.kind || "openai";
        if (kind === "claude_native") {
          const rt = await refreshClaudeRuntimeAndAuthAsync(true);
          return sendJson(res, 200, {
            ok: Boolean(rt.installed && rt.auth?.loggedIn),
            latency_ms: 0,
            model: body.default_model || existing?.default_model || "sonnet",
            message: rt.installed
              ? rt.auth?.loggedIn
                ? `原生 Claude Code (${rt.version}) 已登录就绪`
                : `原生 Claude Code (${rt.version}) 已安装，但尚未登录官方账号`
              : "未检测到本机原生 Claude Code，请先在设置中安装",
            error: !rt.installed ? "未安装原生 Claude Code" : !rt.auth?.loggedIn ? "尚未完成官方 OAuth 登录" : "",
          });
        }
        const merged = {
          id: body.id || existing?.id || "temp",
          name: body.name || existing?.name || "测试供应商",
          kind,
          base_url: body.base_url !== undefined ? String(body.base_url).trim() : existing?.base_url || "",
          api_key: body.api_key ? String(body.api_key).trim() : existing?.api_key || "",
          default_model: body.default_model || existing?.default_model || "",
          models: Array.isArray(body.models) && body.models.length ? body.models : existing?.models || [],
        };
        return sendJson(res, 200, await testProviderConnection(merged));
      }
      if (method === "POST" && pathname === "/api/providers") {
        const body = await readJsonBody(req);
        const saved = enrichProviderForClient(saveProvider(body));
        const all = listProviders(false).map(enrichProviderForClient);
        broadcast({ type: "providers_updated", providers: all, active_provider: all.find((p) => p.is_active) || all[0] || null });
        return sendJson(res, 200, { ok: true, provider: saved, providers: all });
      }
      if (method === "POST" && pathname.match(/^\/api\/providers\/([^/]+)\/activate$/)) {
        const id = pathname.split("/")[3];
        const body = await readJsonBody(req);
        const prov = enrichProviderForClient(activateProvider(id, body.model || ""));
        const all = listProviders(false).map(enrichProviderForClient);
        broadcast({ type: "providers_updated", providers: all, active_provider: prov });
        return sendJson(res, 200, { ok: true, provider: prov, providers: all });
      }
      if (method === "POST" && pathname.match(/^\/api\/providers\/([^/]+)\/models$/)) {
        const id = pathname.split("/")[3];
        const prov = getProvider(id, true);
        if (!prov) return sendJson(res, 404, { ok: false, error: "供应商不存在" });
        const result = await fetchProviderModels(prov);
        if (result.ok && result.models.length) {
          saveProvider({
            id: prov.id,
            name: prov.name,
            kind: prov.kind,
            base_url: prov.base_url,
            models: result.models,
            default_model: prov.default_model || result.models[0],
            extra: {
              ...(prov.extra || {}),
              remote_meta: {
                ...(prov.extra?.remote_meta || {}),
                ...(result.remote_meta || {}),
              },
            },
          });
        }
        const all = listProviders(false).map(enrichProviderForClient);
        broadcast({ type: "providers_updated", providers: all, active_provider: all.find((p) => p.is_active) || all[0] || null });
        return sendJson(res, 200, { ...result, providers: all });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/providers\/([^/]+)$/)) {
        const id = pathname.split("/")[3];
        deleteProvider(id);
        const all = listProviders(false).map(enrichProviderForClient);
        broadcast({ type: "providers_updated", providers: all, active_provider: all.find((p) => p.is_active) || all[0] || null });
        return sendJson(res, 200, { ok: true, providers: all });
      }

      // ==================== SESSIONS & BRANCHING ====================
      if (method === "GET" && pathname === "/api/sessions") {
        const q = urlObj.searchParams.get("q") || "";
        const cwd = urlObj.searchParams.get("cwd") || "";
        const data = listSessions({ query: q, cwd });
        return sendJson(res, 200, { ...data, running_sessions: orchestrator.runningSessionIds() });
      }
      if (method === "POST" && pathname === "/api/sessions") {
        const body = await readJsonBody(req);
        const sess = createSession(body);
        broadcast({ type: "session_created", session: sess });
        return sendJson(res, 200, { ok: true, session: sess });
      }
      if (method === "GET" && pathname.match(/^\/api\/sessions\/([^/]+)$/)) {
        const sid = pathname.split("/")[3];
        const timeline = getSessionTimeline(sid);
        if (!timeline) return sendJson(res, 404, { ok: false, error: "会话不存在" });
        return sendJson(res, 200, {
          ...timeline,
          live: orchestrator.getLiveState(sid),
        });
      }
      if (method === "PATCH" && pathname.match(/^\/api\/sessions\/([^/]+)$/)) {
        const sid = pathname.split("/")[3];
        const body = await readJsonBody(req);
        const updated = updateSessionMeta(sid, body);
        broadcast({ type: "session_meta_updated", session: updated });
        return sendJson(res, 200, { ok: true, session: updated });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/sessions\/([^/]+)$/)) {
        const sid = pathname.split("/")[3];
        const meta = getSessionMeta(sid);
        orchestrator.stopTurn(sid);
        if (meta?.claude_cli_sid) cleanupClaudeSessionFiles([meta.claude_cli_sid]);
        deleteSession(sid);
        broadcast({ type: "session_deleted", session_id: sid });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/switch-branch$/)) {
        const sid = pathname.split("/")[3];
        if (orchestrator.runningSessionIds().includes(sid)) {
          return sendJson(res, 409, { ok: false, error: "当前会话正在运行，请等待完成或点击停止后再切换历史分支" });
        }
        const body = await readJsonBody(req);
        const timeline = switchBranch(sid, body.message_id);
        broadcast({ type: "timeline_updated", session_id: sid, timeline });
        return sendJson(res, 200, { ok: true, timeline });
      }

      // ==================== MEMORIES (CONCURRENCY-SAFE & DISK-SYNCED) ====================
      if (method === "GET" && pathname === "/api/memories") {
        syncDiskMemoriesToDb();
        const q = urlObj.searchParams.get("q") || "";
        const scope = urlObj.searchParams.get("scope") || "";
        const cwd = urlObj.searchParams.get("cwd") || "";
        return sendJson(res, 200, { memories: listMemories({ scope, cwd, query: q }) });
      }
      if (method === "POST" && pathname === "/api/memories") {
        const body = await readJsonBody(req);
        const saved = saveMemory(body);
        const diskSync = syncMemoryToDisk(saved);
        broadcast({ type: "memories_updated" });
        return sendJson(res, 200, { ok: true, memory: saved, disk_synced: Boolean(diskSync.written) });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/memories\/([^/]+)$/)) {
        const id = pathname.split("/")[3];
        recordDeletedDiskMemory(id);
        deleteMemory(id);
        broadcast({ type: "memories_updated" });
        return sendJson(res, 200, { ok: true });
      }

      // ==================== DUAL-ENGINE LIVE WEB SEARCH ====================
      if (method === "GET" && pathname === "/api/web-search") {
        const q = urlObj.searchParams.get("q") || "";
        const eng = urlObj.searchParams.get("engine") || "";
        const limit = Number(urlObj.searchParams.get("limit") || 8);
        return sendJson(res, 200, await searchWebLive(q, { maxResults: limit, mode: eng }));
      }

      // ==================== ONLINE OPEN-SOURCE STORES (DUAL-ENGINE CN DIRECT / PROXY GLOBAL) ====================
      if (method === "GET" && pathname === "/api/stores/mcp") {
        const q = urlObj.searchParams.get("q") || "";
        const eng = urlObj.searchParams.get("engine") || "";
        return sendJson(res, 200, await searchMcpStore(q, eng));
      }
      if (method === "GET" && pathname === "/api/mcp") {
        return sendJson(res, 200, { items: mcpManager.getStatusList() });
      }
      if (method === "POST" && pathname === "/api/mcp/import") {
        const body = await readJsonBody(req);
        const parsed = await resolvePublicMcpImport(body.input || "");
        const saved = saveInstalledMcp({ ...parsed, enabled: true });
        await mcpManager.restartServer(saved.id);
        const items = mcpManager.getStatusList();
        broadcast({ type: "mcp_updated", items });
        return sendJson(res, 200, { ok: true, item: saved, items });
      }
      if (method === "POST" && pathname === "/api/mcp") {
        const body = await readJsonBody(req);
        const saved = saveInstalledMcp(body);
        await mcpManager.restartServer(saved.id);
        const items = mcpManager.getStatusList();
        broadcast({ type: "mcp_updated", items });
        return sendJson(res, 200, { ok: true, item: saved, items });
      }
      if (method === "POST" && pathname.match(/^\/api\/mcp\/([^/]+)\/restart$/)) {
        const id = pathname.split("/")[3];
        const items = await mcpManager.restartServer(id);
        broadcast({ type: "mcp_updated", items });
        return sendJson(res, 200, { ok: true, items });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/mcp\/([^/]+)$/)) {
        const id = pathname.split("/")[3];
        deleteInstalledMcp(id);
        await mcpManager.syncFromDb();
        const items = mcpManager.getStatusList();
        broadcast({ type: "mcp_updated", items });
        return sendJson(res, 200, { ok: true, items });
      }

      if (method === "GET" && pathname === "/api/stores/skills") {
        const q = urlObj.searchParams.get("q") || "";
        const eng = urlObj.searchParams.get("engine") || "";
        return sendJson(res, 200, await searchSkillsStore(q, eng));
      }
      if (method === "GET" && pathname === "/api/skills") {
        return sendJson(res, 200, { items: listInstalledSkills() });
      }
      if (method === "POST" && pathname === "/api/skills/import-url") {
        const body = await readJsonBody(req);
        const imported = await importPublicSkillFromUrl(body.url || "");
        const saved = saveInstalledSkill(imported);
        const items = listInstalledSkills();
        broadcast({ type: "skills_updated", items });
        return sendJson(res, 200, { ok: true, item: saved, items });
      }
      if (method === "POST" && pathname === "/api/skills") {
        const body = await readJsonBody(req);
        const content = body.content || (await downloadRemoteSkillContent(body));
        const saved = saveInstalledSkill({ ...body, content });
        const items = listInstalledSkills();
        broadcast({ type: "skills_updated", items });
        return sendJson(res, 200, { ok: true, item: saved, items });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/skills\/([^/]+)$/)) {
        const id = pathname.split("/")[3];
        deleteInstalledSkill(id);
        const items = listInstalledSkills();
        broadcast({ type: "skills_updated", items });
        return sendJson(res, 200, { ok: true, items });
      }

      if (method === "GET" && pathname === "/api/stores/wallpapers") {
        const q = urlObj.searchParams.get("q") || "";
        const page = Number(urlObj.searchParams.get("page") || 1);
        const category = urlObj.searchParams.get("category") || "all";
        const eng = urlObj.searchParams.get("engine") || "";
        return sendJson(res, 200, await searchWallpaperStore(q, page, category, eng));
      }
      if (method === "GET" && pathname === "/api/wallpaper-proxy") {
        const rawUrl = urlObj.searchParams.get("url") || "";
        const fbUrl = urlObj.searchParams.get("fb") || "";
        if (!isPublicMediaUrl(rawUrl)) {
          return sendJson(res, 400, { error: "仅允许代理公网公开图片与动态视频资源" });
        }
        const hash = crypto.createHash("sha1").update(rawUrl).digest("hex");
        const cachePath = path.join(paths.backgroundsDir, `wp_cache_${hash}`);
        const metaPath = `${cachePath}.mime`;

        const serveCachedFile = () => {
          const mime = fs.readFileSync(metaPath, "utf8").trim() || "application/octet-stream";
          return streamFileWithRange(req, res, cachePath, {
            contentType: mime,
            cacheControl: "public, max-age=86400",
            supportRange: true,
          });
        };

        if (fs.existsSync(cachePath) && fs.existsSync(metaPath)) {
          return serveCachedFile();
        }

        try {
          const fetched = await fetchPublicMediaBuffer(rawUrl, fbUrl);
          atomicWriteFileSync(cachePath, fetched.buf);
          atomicWriteFileSync(metaPath, fetched.mime, "utf8");
          // Strictly cap browse thumbnail cache to 35MB (NEVER touches active_wallpaper_* or user uploads!)
          enforceWallpaperCacheBudget(paths.backgroundsDir, 35 * 1024 * 1024);
          return serveCachedFile();
        } catch (err) {
          return sendJson(res, 502, { error: `拉取壁纸资源失败: ${err.message}` });
        }
      }
      if (method === "GET" && pathname === "/api/backgrounds/storage") {
        return sendJson(res, 200, { ok: true, storage: getWallpaperStorageStats(paths.backgroundsDir) });
      }
      if (method === "POST" && pathname === "/api/backgrounds/clear-cache") {
        const cleared = clearWallpaperPreviewCache(paths.backgroundsDir);
        return sendJson(res, 200, { ok: true, ...cleared, storage: getWallpaperStorageStats(paths.backgroundsDir) });
      }

      // ==================== WALLPAPER ENGINE (STEAM 431960) & LOCAL 4K INDEPENDENT ZERO-COPY LIBRARY ====================
      // Strictly read-only & 100% independent from the user's Windows desktop wallpaper!
      if (method === "GET" && pathname === "/api/we/status") {
        const weCfg = getAllSettings().wallpaper_engine || { authorized: false, dirs: [], video_muted: true };
        const force = urlObj.searchParams.get("refresh") === "1";
        const q = (urlObj.searchParams.get("q") || "").trim().toLowerCase();
        const items =
          weCfg.authorized && weCfg.dirs?.length
            ? scanAuthorizedWallpaperLibrary(weCfg.dirs, force)
                .map(serializeWeItemForClient)
                .filter((it) => !q || it.title.toLowerCase().includes(q) || (it.tags || []).some((t) => t.toLowerCase().includes(q)))
            : [];
        return sendJson(res, 200, {
          ok: true,
          authorized: Boolean(weCfg.authorized),
          dirs: weCfg.dirs || [],
          video_muted: weCfg.video_muted !== false,
          count: items.length,
          playable_count: items.filter((i) => i.playable).length,
          items,
        });
      }
      if (method === "POST" && pathname === "/api/we/authorize") {
        const body = await readJsonBody(req);
        const cur = getAllSettings().wallpaper_engine || { authorized: false, dirs: [], video_muted: true };
        const dirSet = new Set((cur.dirs || []).map((d) => path.resolve(d)).filter((d) => fs.existsSync(d)));
        let detected = [];
        if (body.auto_detect) {
          detected = detectSteamWallpaperEngineDirs();
          for (const d of detected) dirSet.add(path.resolve(d.path));
        }
        if (body.add_dir) {
          const target = path.resolve(String(body.add_dir).trim());
          if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
            return sendJson(res, 400, { ok: false, error: `目录不存在或不是有效文件夹：${target}` });
          }
          dirSet.add(target);
        }
        const nextDirs = [...dirSet];
        const nextCfg = {
          authorized: nextDirs.length > 0,
          dirs: nextDirs,
          video_muted: body.video_muted !== undefined ? Boolean(body.video_muted) : cur.video_muted !== false,
        };
        setSetting("wallpaper_engine", nextCfg);
        const items = nextDirs.length ? scanAuthorizedWallpaperLibrary(nextDirs, true).map(serializeWeItemForClient) : [];
        const playableCount = items.filter((i) => i.playable).length;
        broadcast({ type: "settings_updated", settings: getAllSettings() });
        return sendJson(res, 200, {
          ok: true,
          authorized: nextCfg.authorized,
          dirs: nextDirs,
          detected_count: detected.length,
          video_muted: nextCfg.video_muted,
          count: items.length,
          playable_count: playableCount,
          items,
          message:
            nextDirs.length === 0
              ? "未在本机 Steam 默认路径检测到 Wallpaper Engine (431960)，可点击「添加本地 4K 目录」授权任意本地壁纸文件夹。"
              : `已只读授权 ${nextDirs.length} 个目录：发现 ${playableCount} 个可 0 损耗独立播放的原版视频/Web/原图壁纸（绝不影响您的系统桌面壁纸）。`,
        });
      }
      if (method === "POST" && pathname === "/api/we/revoke") {
        const body = await readJsonBody(req).catch(() => ({}));
        const cur = getAllSettings().wallpaper_engine || { authorized: false, dirs: [], video_muted: true };
        let nextDirs = [];
        if (body.remove_dir) {
          const rm = path.resolve(String(body.remove_dir)).toLowerCase();
          nextDirs = (cur.dirs || []).filter((d) => path.resolve(d).toLowerCase() !== rm);
        }
        const nextCfg = {
          authorized: nextDirs.length > 0,
          dirs: nextDirs,
          video_muted: cur.video_muted !== false,
        };
        setSetting("wallpaper_engine", nextCfg);
        const items = nextDirs.length ? scanAuthorizedWallpaperLibrary(nextDirs, true).map(serializeWeItemForClient) : [];
        broadcast({ type: "settings_updated", settings: getAllSettings() });
        return sendJson(res, 200, {
          ok: true,
          authorized: nextCfg.authorized,
          dirs: nextDirs,
          count: items.length,
          playable_count: items.filter((i) => i.playable).length,
          items,
        });
      }
      if (method === "GET" && pathname === "/api/we/media") {
        const weCfg = getAllSettings().wallpaper_engine || {};
        if (!weCfg.authorized || !weCfg.dirs?.length) {
          return sendJson(res, 403, { error: "尚未授权访问 Wallpaper Engine / 本地壁纸库" });
        }
        const id = urlObj.searchParams.get("id") || "";
        const kind = urlObj.searchParams.get("kind") || "file";
        const item = getAuthorizedWallpaperItem(id, weCfg.dirs);
        return streamAuthorizedMedia(req, res, item, kind, weCfg.dirs);
      }
      if (method === "GET" && pathname.startsWith("/api/we/web/")) {
        const weCfg = getAllSettings().wallpaper_engine || {};
        if (!weCfg.authorized || !weCfg.dirs?.length) {
          return sendJson(res, 403, { error: "尚未授权访问 Wallpaper Engine 壁纸库" });
        }
        const rest = pathname.slice("/api/we/web/".length);
        const slashIdx = rest.indexOf("/");
        const itemId = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
        const subRel = slashIdx >= 0 ? rest.slice(slashIdx + 1) : "index.html";
        const item = getAuthorizedWallpaperItem(itemId, weCfg.dirs);
        return serveAuthorizedWebAsset(req, res, item, subRel, weCfg.dirs);
      }
      if (method === "POST" && pathname === "/api/backgrounds/upload") {
        const body = await readJsonBody(req, 65 * 1024 * 1024);
        const mediaType = String(body.media_type || "image/png").toLowerCase();
        const ext = ALLOWED_BG_MIMES[mediaType];
        if (!ext) return sendJson(res, 400, { ok: false, error: `不支持的壁纸格式: ${mediaType}（支持 PNG/JPG/WebP/GIF/MP4/WebM）` });
        const b64 = String(body.data || "").replace(/^data:[^,]+,/, "");
        const buf = Buffer.from(b64, "base64");
        if (buf.length > 50 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: "壁纸文件不能超过 50MB" });
        const isVideo = mediaType.startsWith("video/");
        const fileName = `bg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
        fs.writeFileSync(path.join(paths.backgroundsDir, fileName), buf);
        const bg = addCustomBackground({
          name: String(body.name || (isVideo ? "动态视频壁纸" : "自定义背景")).slice(0, 60),
          url: `/api/bg-files/${fileName}`,
          source: isVideo ? "video" : "upload",
        });
        invalidateWallpaperStorageCache();
        return sendJson(res, 200, {
          ok: true,
          is_video: isVideo,
          background: bg,
          backgrounds: listCustomBackgrounds(),
          storage: getWallpaperStorageStats(paths.backgroundsDir, true),
        });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/backgrounds\/([^/]+)$/)) {
        const id = pathname.split("/")[3];
        const deleted = deleteCustomBackground(id);
        // Also remove the physical file from disk so deleting custom wallpapers frees 100% space!
        if (deleted?.url?.startsWith("/api/bg-files/")) {
          const fname = path.basename(deleted.url.slice("/api/bg-files/".length));
          const fp = path.join(paths.backgroundsDir, fname);
          if (fname.startsWith("bg_") && fs.existsSync(fp)) {
            try { fs.unlinkSync(fp); } catch {}
          }
        }
        invalidateWallpaperStorageCache();
        return sendJson(res, 200, {
          ok: true,
          backgrounds: listCustomBackgrounds(),
          storage: getWallpaperStorageStats(paths.backgroundsDir, true),
        });
      }
      if (method === "GET" && pathname.startsWith("/api/bg-files/")) {
        const fname = path.basename(pathname.slice("/api/bg-files/".length));
        const fp = path.join(paths.backgroundsDir, fname);
        if (!isRealPathInsideDir(fp, paths.backgroundsDir) || !fs.existsSync(fp)) {
          return sendJson(res, 404, { error: "not found" });
        }
        const ext = path.extname(fp).toLowerCase();
        const mime = MIME[ext] || "application/octet-stream";
        return streamFileWithRange(req, res, fp, {
          contentType: mime,
          cacheControl: "public, max-age=31536000",
          supportRange: true,
        });
      }

      // ==================== UNIVERSAL CHAT ATTACHMENTS (IMAGES + TXT/CODE + ANY FILES) ====================
      if (method === "POST" && pathname === "/api/upload") {
        const body = await readJsonBody(req, 36 * 1024 * 1024);
        const rawName = String(body.name || "attachment").trim() || "attachment";
        const origExt = path.extname(rawName).toLowerCase();
        const mediaType = String(body.media_type || "").toLowerCase().split(";")[0].trim();
        const b64 = String(body.data || "").replace(/^data:[^,]*,/, "");
        const buf = Buffer.from(b64, "base64");

        const imgExt = ALLOWED_IMAGE_MIMES[mediaType] || ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(origExt) ? origExt : "");
        let kind = "file";
        let finalExt = origExt && /^\.[a-z0-9]{1,12}$/i.test(origExt) ? origExt : ".bin";
        let finalMime = mediaType || "application/octet-stream";

        if (imgExt) {
          kind = "image";
          finalExt = imgExt === ".jpeg" ? ".jpg" : imgExt;
          finalMime = mediaType && mediaType.startsWith("image/") ? mediaType : MIME[finalExt] || "image/png";
          if (buf.length > 15 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: "图片不能超过 15MB" });
        } else {
          const isTextByType =
            TEXT_FILE_EXTS.has(origExt) ||
            mediaType.startsWith("text/") ||
            mediaType === "application/json" ||
            mediaType === "application/xml" ||
            mediaType === "application/javascript" ||
            mediaType === "application/x-sh";
          const isTextByContent = !origExt && buf.length <= 2 * 1024 * 1024 && isLikelyUtf8TextBuffer(buf);
          if (isTextByType || isTextByContent) {
            kind = "text";
            if (!origExt) finalExt = ".txt";
            if (!mediaType || mediaType === "application/octet-stream") finalMime = "text/plain; charset=utf-8";
            if (buf.length > 20 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: "文本/代码文件不能超过 20MB" });
          } else {
            kind = "file";
            if (buf.length > 25 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: "附件文件不能超过 25MB" });
          }
        }

        const safeBase = path
          .basename(rawName, origExt)
          .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
          .slice(0, 48) || "file";
        const fname = `${Date.now()}_${crypto.randomBytes(3).toString("hex")}_${safeBase}${finalExt}`;
        const dest = path.join(paths.uploadsDir, fname);
        fs.writeFileSync(dest, buf);
        enforceUploadsBudget(paths.uploadsDir, 200 * 1024 * 1024);

        const preview = kind === "text" ? buf.subarray(0, 240).toString("utf8").replace(/\s+/g, " ").trim() : "";
        return sendJson(res, 200, {
          ok: true,
          kind,
          id: fname,
          name: rawName,
          media_type: finalMime,
          size: buf.length,
          path: dest,
          url: `/api/uploads/${encodeURIComponent(fname)}`,
          preview,
        });
      }
      if (method === "GET" && pathname.startsWith("/api/uploads/")) {
        const fname = path.basename(pathname.slice("/api/uploads/".length));
        const fp = path.join(paths.uploadsDir, fname);
        if (!isRealPathInsideDir(fp, paths.uploadsDir) || !fs.existsSync(fp)) {
          return sendJson(res, 404, { error: "not found" });
        }
        const ext = path.extname(fp).toLowerCase();
        const safeInlineImage = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext);
        // Never serve uploaded .html/.svg/.xml/.js as executable inline documents on our origin!
        const contentType = safeInlineImage
          ? MIME[ext]
          : TEXT_FILE_EXTS.has(ext) || [".html", ".htm", ".svg", ".xml", ".js", ".mjs"].includes(ext)
            ? "text/plain; charset=utf-8"
            : "application/octet-stream";
        const extraHeaders = {
          "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          ...(safeInlineImage
            ? {}
            : { "Content-Disposition": `inline; filename="${encodeURIComponent(fname)}"` }),
        };
        if (!safeInlineImage && contentType === "application/octet-stream") {
          extraHeaders["Content-Disposition"] = `attachment; filename="${encodeURIComponent(fname)}"`;
        }
        return streamFileWithRange(req, res, fp, {
          contentType,
          cacheControl: "private, max-age=3600",
          extraHeaders,
          supportRange: false,
        });
      }

      // ==================== WORKDIR & FILES ====================
      if (method === "GET" && pathname === "/api/dirs") {
        const target = urlObj.searchParams.get("path") || "";
        return sendJson(res, 200, listDirectorySafe(target));
      }
      if (method === "GET" && pathname === "/api/dirs/drives") {
        return sendJson(res, 200, listAvailableDrives());
      }
      if (method === "POST" && pathname === "/api/dirs/ensure") {
        const body = await readJsonBody(req);
        const drive = String(body.drive || "").trim();
        const subpath = String(body.subpath || "").trim().replace(/^[\\/]+/, "");
        const fullRaw = String(body.full_path || "").trim();
        let target = fullRaw || (drive ? path.join(drive, subpath) : subpath);
        if (!target) return sendJson(res, 400, { ok: false, error: "请输入文件夹名称或路径" });
        target = path.resolve(target);
        const existed = fs.existsSync(target);
        if (existed && !fs.statSync(target).isDirectory()) {
          return sendJson(res, 400, { ok: false, error: "该路径已存在同名文件，无法作为文件夹" });
        }
        fs.mkdirSync(target, { recursive: true });
        return sendJson(res, 200, { ok: true, path: target, created: !existed });
      }
      if (method === "POST" && pathname === "/api/dirs/pick-native") {
        const body = await readJsonBody(req).catch(() => ({}));
        const result = await pickNativeDirectoryDialog(body.initial_dir || "");
        return sendJson(res, 200, result);
      }
      if (method === "GET" && pathname === "/api/files") {
        const cwd = urlObj.searchParams.get("cwd") || paths.defaultCwd;
        const q = urlObj.searchParams.get("q") || "";
        return sendJson(res, 200, { cwd, files: scanWorkspaceFiles(cwd, q) });
      }

      // ==================== DUAL-CHANNEL UPDATER ====================
      if (method === "GET" && pathname === "/api/updater/check") {
        const ch = urlObj.searchParams.get("channel") || null;
        return sendJson(res, 200, await checkForUpdates(ch));
      }

      // ==================== LOGS & AI DIAGNOSTICS ====================
      if (method === "GET" && pathname === "/api/logs") {
        const limit = Math.min(Number(urlObj.searchParams.get("limit") || 150), 500);
        const level = urlObj.searchParams.get("level") || "ALL";
        const sid = urlObj.searchParams.get("session_id") || "";
        return sendJson(res, 200, {
          entries: tailLogs({ limit, level, sessionId: sid }),
          paths: { server_jsonl: paths.jsonlLog, server_text: paths.textLog, data_root: paths.dataRoot },
        });
      }
      if (method === "GET" && pathname.match(/^\/api\/logs\/turn\/([^/]+)$/)) {
        const sid = pathname.split("/")[4];
        return sendJson(res, 200, readTurnLog(sid, 250));
      }
      if (method === "GET" && pathname === "/api/diagnostics") {
        const sid = urlObj.searchParams.get("session_id") || "";
        return sendJson(
          res,
          200,
          buildAiDiagnosticBundle({
            appVersion,
            sessionId: sid,
            activeProvider: getActiveProvider(false),
            lastError: orchestrator.lastError,
          }),
        );
      }

      // ==================== STATIC FRONTEND (MEMORY-CACHED + ETAG 304 + GZIP) ====================
      if (method === "GET") {
        const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const fp = path.join(PUBLIC_DIR, rel);
        if (isRealPathInsideDir(fp, PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          return serveStaticFile(req, res, fp);
        }
      }

      sendJson(res, 404, { ok: false, error: `Not Found: ${pathname}` });
    } catch (err) {
      const code =
        err.code === "ERR_MEMORY_CONFLICT"
          ? 409
          : err.code === "ERR_UNSUPPORTED_MEDIA_TYPE"
            ? 415
            : 500;
      logEvent("ERROR", "http", "unhandled", `${req.method} ${req.url}: ${err.message}`, { reqId, layer: "web-server" });
      sendJson(res, code, {
        ok: false,
        error: classifyError({ message: err.message, reqId, codeHint: err.code || "ERR_HTTP" }),
      });
    }
  });

  // ==================== WEBSOCKET MULTIPLEXER (PROTECTED AGAINST CSWSH) ====================
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, cb) => {
      if (!requireAuth) return cb(true);
      const req = info.req;
      if (!isAllowedHostHeader(req.headers.host)) {
        return cb(false, 403, "Forbidden Host");
      }
      if (!isAllowedOriginHeader(req.headers.origin) || req.headers.origin === "null") {
        return cb(false, 403, "Forbidden Origin");
      }
      if (!isRequestAuthenticated(req)) {
        try {
          const u = new URL(req.url || "/ws", `http://${host}:${boundPort || port}`);
          const qTok = u.searchParams.get("token") || "";
          if (qTok && safeTokenEqual(qTok, authToken)) return cb(true);
        } catch {}
        return cb(false, 401, "Unauthorized WebSocket");
      }
      return cb(true);
    },
  });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    const providers = listProviders(false).map(enrichProviderForClient);
    ws.send(
      JSON.stringify({
        type: "hello",
        version: appVersion,
        running_sessions: orchestrator.runningSessionIds(),
        providers,
        active_provider: providers.find((p) => p.is_active) || providers[0] || null,
      }),
    );

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      try {
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (msg.type === "send_message") {
          const r = await orchestrator.sendMessage({
            sessionId: msg.session_id || "",
            text: msg.text || "",
            images: msg.images || [],
            cwd: msg.cwd || "",
            providerId: msg.provider_id || "",
            model: msg.model || "",
            thinkingLevel: msg.thinking_level || "auto",
            webSearchEnabled: msg.web_search !== undefined ? Boolean(msg.web_search) : null,
            clientReqId: msg.client_req_id || "",
          });
          if (r?.busy) ws.send(JSON.stringify({ type: "busy_notice", session_id: msg.session_id || "", message: r.error }));
        } else if (msg.type === "edit_resend") {
          const r = await orchestrator.editAndResend({
            sessionId: msg.session_id,
            messageId: msg.message_id,
            newText: msg.new_text,
            images: msg.images ?? null,
            providerId: msg.provider_id || "",
            model: msg.model || "",
            thinkingLevel: msg.thinking_level || "",
            webSearchEnabled: msg.web_search !== undefined ? Boolean(msg.web_search) : null,
          });
          if (r?.busy) ws.send(JSON.stringify({ type: "busy_notice", session_id: msg.session_id || "", message: r.error }));
        } else if (msg.type === "regenerate_reply") {
          const r = await orchestrator.regenerateReply({
            sessionId: msg.session_id,
            assistantMessageId: msg.assistant_message_id,
            providerId: msg.provider_id || "",
            model: msg.model || "",
            thinkingLevel: msg.thinking_level || "",
            webSearchEnabled: msg.web_search !== undefined ? Boolean(msg.web_search) : null,
          });
          if (r?.busy) ws.send(JSON.stringify({ type: "busy_notice", session_id: msg.session_id || "", message: r.error }));
        } else if (msg.type === "stop_turn") {
          orchestrator.stopTurn(msg.session_id);
        } else if (msg.type === "confirm_response") {
          orchestrator.resolveConfirm(msg.confirm_id, Boolean(msg.approved));
        }
      } catch (err) {
        const sid = msg?.session_id || "";
        const classified = classifyError({
          message: err?.message || String(err),
          sessionId: sid,
          codeHint: err?.code || "ERR_WS_HANDLER",
        });
        logEvent("ERROR", "ws", "handler_error", `WS ${msg?.type || "unknown"} 异常: ${classified.cause}`, {
          sessionId: sid,
          layer: "websocket",
        });
        try {
          ws.send(JSON.stringify({ type: "turn_error", session_id: sid, error: classified }));
        } catch {}
      }
    });

    ws.on("close", () => wsClients.delete(ws));
    ws.on("error", () => wsClients.delete(ws));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  boundPort = actualPort;
  const url = `http://${host}:${actualPort}`;
  logEvent(
    "INFO",
    "server",
    "started",
    `OpenCode Studio v${appVersion} 启动于 ${url} (mode=${desktopMode ? "desktop-isolated" : "local"}, data=${paths.dataRoot})`,
  );

  return {
    server,
    wss,
    url,
    get desktopBootUrl() {
      return `${url}/?ocs_boot=${desktopBootNonce}`;
    },
    authToken,
    port: actualPort,
    mcpManager,
    orchestrator,
    async stop() {
      orchestrator.stopAll();
      mcpManager.stopAll();
      for (const ws of wsClients) {
        try {
          ws.close();
        } catch {}
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// Run directly when executed via `node server/index.mjs`
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  process.on("exit", () => closeDb());
  startServer()
    .then((handle) => {
      console.log(`[OpenCode Studio] Listening on ${handle.url}`);
      const shutdown = () => {
        handle.stop().finally(() => {
          closeDb();
          process.exit(0);
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("[OpenCode Studio] Failed to start:", err);
      closeDb();
      process.exit(1);
    });
}
