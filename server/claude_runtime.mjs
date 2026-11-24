/**
 * True Native Claude Code Runtime Controller (Cross-Platform).
 *
 * Drives the REAL Claude Code CLI as the primary engine across:
 *   - Windows native (`claude.exe` / verified `.cmd`)
 *   - Windows with WSL2 native Claude Code fallback (seamless path & localhost proxy bridging!)
 *   - macOS & Linux native (`claude`)
 *
 * Provides full lifecycle management directly inside OpenCode Studio:
 *   1. Real `claude auth status` / `claude auth login` / `claude auth logout`
 *   2. Real `claude install stable` / `claude install latest` (+ one-click fresh install for students!)
 *   3. Driving native Claude Code with either Official Auth Login OR any built-in API provider
 *      via our local transparent proxy (`/proxy/provider/:id`), with full MCP, Skills,
 *      custom system prompt, fork-session branching, and privacy flags.
 */

import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAllSettings, listInstalledMcps, listInstalledSkills } from "./db.mjs";
import { appendTurnLog, classifyError, logEvent } from "./logger.mjs";
import { buildUnifiedMemoryContext, syncDiskMemoriesToDb } from "./memory_sync.mjs";
import { detectModelCapabilities } from "./model_registry.mjs";
import { getPaths, PROJECT_ROOT } from "./paths.mjs";
import { killProcessTree, proxyFetch } from "./runtime_utils.mjs";

const RUNTIME_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_CACHE_TTL_MS = 90 * 1000;

let _cachedRuntime = null;
let _cachedAt = 0;
let _cachedStatusSnapshot = null;
let _cachedStatusAt = 0;
let _cachedStatusIsoMode = "";
let _inflightStatusPromise = null;

// Track last injected memory digest per CLI session so memories are injected once per session
// and re-injected automatically whenever disk or Web UI memories change.
const _lastSessionMemHash = new Map();

export function clearRuntimeCache() {
  _cachedRuntime = null;
  _cachedAt = 0;
  _cachedStatusSnapshot = null;
  _cachedStatusAt = 0;
  _cachedStatusIsoMode = "";
}

export function winPathToWsl(winPath) {
  const norm = String(winPath || "").replace(/\\/g, "/");
  const m = norm.match(/^([A-Za-z]):\/(.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  return norm;
}

function testNativeCandidate(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return null;
  const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath);
  const res = isCmd
    ? spawnSync("cmd.exe", ["/c", binPath, "--version"], { encoding: "utf8", timeout: 4000, windowsHide: true })
    : spawnSync(binPath, ["--version"], { encoding: "utf8", timeout: 4000, windowsHide: true });
  if (res.status === 0 && /claude|\d+\.\d+/i.test(res.stdout || "")) {
    return {
      mode: "native",
      binary: binPath,
      isCmd,
      version: (res.stdout || "").trim(),
    };
  }
  return null;
}

function wslScriptArgs(bashScript) {
  // Base64 + bash process substitution avoids Windows CreateProcess quote-mangling completely
  // while preserving stdin passthrough for `exec claude ...`!
  const b64 = Buffer.from(bashScript, "utf8").toString("base64");
  return ["bash", "-lc", `source <(echo ${b64} | base64 -d)`];
}

function testWslClaude() {
  if (process.platform !== "win32") return null;
  const script = [
    'BIN=$(command -v claude || ls -1 "$HOME/.local/bin/claude" 2>/dev/null | head -n1)',
    'if [ -n "$BIN" ]; then',
    '  echo "BIN=$BIN"',
    '  "$BIN" --version',
    'fi',
  ].join("\n");
  const res = spawnSync("wsl.exe", wslScriptArgs(script), { encoding: "utf8", timeout: 8000, windowsHide: true });
  if (res.status !== 0 || !res.stdout) return null;
  const lines = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const binLine = lines.find((l) => l.startsWith("BIN="));
  const verLine = lines.find((l) => !l.startsWith("BIN="));
  if (!binLine || !verLine) return null;
  return {
    mode: "wsl",
    binary: binLine.slice(4),
    isCmd: false,
    version: verLine,
  };
}

export function getClaudeIsolationConfig() {
  let mode = "isolated";
  try {
    mode = getAllSettings().claude_isolation === "shared" ? "shared" : "isolated";
  } catch {
    mode = "isolated";
  }
  const paths = getPaths();
  return {
    mode,
    configDir: mode === "isolated" ? paths.claudeConfigDir : null,
    runtimeDir: paths.claudeRuntimeDir,
  };
}

function getManagedClaudeCandidates() {
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  const platPkg = `@anthropic-ai/claude-code-${process.platform}-${process.arch}`;
  const r = getPaths().claudeRuntimeDir;
  const out = [path.join(r, "node_modules", platPkg, binName)];
  if (process.platform === "linux") {
    out.push(path.join(r, "node_modules", `${platPkg}-musl`, binName));
  }
  out.push(path.join(r, "node_modules", "@anthropic-ai", "claude-code", "bin", binName));
  return out;
}

function getBundledClaudeCandidates() {
  const binName = process.platform === "win32" ? "claude.exe" : "claude";
  const platPkg = `@anthropic-ai/claude-code-${process.platform}-${process.arch}`;
  const roots = [PROJECT_ROOT];
  // When packaged inside Electron app.asar, native binaries live in app.asar.unpacked!
  if (PROJECT_ROOT.includes("app.asar") && !PROJECT_ROOT.includes("app.asar.unpacked")) {
    roots.unshift(PROJECT_ROOT.replace("app.asar", "app.asar.unpacked"));
  }
  const out = [];
  for (const r of roots) {
    out.push(path.join(r, "node_modules", platPkg, binName));
    if (process.platform === "linux") {
      out.push(path.join(r, "node_modules", `${platPkg}-musl`, binName));
    }
    out.push(path.join(r, "node_modules", "@anthropic-ai", "claude-code", "bin", binName));
  }
  return out;
}

/**
 * Detect a genuinely working native Claude Code CLI with strict zero-conflict priority
 * and short-circuit evaluation (never spawns `where.exe` or `wsl.exe` when managed/bundled binary exists!):
 *  1. OpenCode Studio private managed upgrade binary (<dataRoot>/claude-runtime) — never overwrites user's system CLI!
 *  2. Bundled official native binary shipped INSIDE OpenCode Studio installer (out-of-the-box!)
 *  3. System PATH / WSL2 fallback (only when neither managed nor bundled exists)
 */
export function detectClaudeRuntime(force = false) {
  if (!force && _cachedRuntime && Date.now() - _cachedAt < RUNTIME_CACHE_TTL_MS) {
    if (_cachedRuntime.mode === "missing" || _cachedRuntime.mode === "wsl" || fs.existsSync(_cachedRuntime.binary)) {
      return _cachedRuntime;
    }
  }

  const managedCandidates = getManagedClaudeCandidates();
  const bundledCandidates = getBundledClaudeCandidates();
  const managedSet = new Set(managedCandidates.map((p) => path.resolve(p)));
  const bundledSet = new Set(bundledCandidates.map((p) => path.resolve(p)));

  const fixedSystemCandidates =
    process.platform === "win32"
      ? [
          path.join(os.homedir(), ".local", "bin", "claude.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
        ]
      : [path.join(os.homedir(), ".local", "bin", "claude")];

  const markTier = (cand, hit) => {
    const abs = path.resolve(cand);
    hit.managed = managedSet.has(abs);
    hit.bundled = bundledSet.has(abs);
    return hit;
  };

  let found = null;
  // Tier 1 & 2 & 3: direct filesystem check without spawning `where.exe` / `which`
  for (const c of [...new Set([...managedCandidates, ...bundledCandidates, ...fixedSystemCandidates])]) {
    if (!c || !fs.existsSync(c)) continue;
    found = testNativeCandidate(c);
    if (found) {
      markTier(c, found);
      break;
    }
  }

  // Tier 4: Only probe PATH via where/which if direct tiers found nothing
  if (!found) {
    const pathCandidates = [];
    if (process.platform === "win32") {
      const w = spawnSync("where.exe", ["claude.exe"], { encoding: "utf8", timeout: 2500, windowsHide: true });
      if (w.status === 0 && w.stdout) pathCandidates.push(...w.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      if (!pathCandidates.length) {
        const wc = spawnSync("where.exe", ["claude"], { encoding: "utf8", timeout: 2500, windowsHide: true });
        if (wc.status === 0 && wc.stdout) pathCandidates.push(...wc.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      }
    } else {
      const w = spawnSync("which", ["claude"], { encoding: "utf8", timeout: 2500 });
      if (w.status === 0 && w.stdout.trim()) pathCandidates.push(w.stdout.trim());
    }
    for (const c of [...new Set(pathCandidates)]) {
      found = testNativeCandidate(c);
      if (found) {
        markTier(c, found);
        break;
      }
    }
  }

  // Tier 5: WSL2 fallback on Windows
  if (!found && process.platform === "win32") {
    found = testWslClaude();
  }

  _cachedRuntime = found || { mode: "missing", binary: null, isCmd: false, version: null, bundled: false, managed: false };
  _cachedAt = Date.now();
  return _cachedRuntime;
}

function spawnClaudeProcess(rt, args, { cwd, env, stdio = ["pipe", "pipe", "pipe"] }) {
  const iso = getClaudeIsolationConfig();
  const mergedEnv = { ...(env || {}) };
  if (iso.configDir && mergedEnv.CLAUDE_CONFIG_DIR === undefined) {
    mergedEnv.CLAUDE_CONFIG_DIR = rt.mode === "wsl" ? winPathToWsl(iso.configDir) : iso.configDir;
  }

  if (rt.mode === "wsl") {
    const wslCwd = winPathToWsl(cwd || os.homedir());
    // Pass isolated env vars safely into WSL
    const envLines = [];
    for (const [k, v] of Object.entries(mergedEnv)) {
      if (v === undefined) continue;
      if (v === null) {
        envLines.push(`unset ${k}`);
      } else {
        const escaped = String(v).replace(/'/g, "'\\''");
        envLines.push(`export ${k}='${escaped}'`);
      }
    }
    const quotedArgs = args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    const bashScript = [
      `cd '${wslCwd.replace(/'/g, "'\\''")}' 2>/dev/null || cd /`,
      ...envLines,
      `exec '${rt.binary.replace(/'/g, "'\\''")}' ${quotedArgs}`,
    ].join("\n");
    return spawn("wsl.exe", wslScriptArgs(bashScript), { stdio, windowsHide: true });
  }

  const finalEnv = { ...process.env };
  for (const [k, v] of Object.entries(mergedEnv)) {
    if (v === null || v === undefined) delete finalEnv[k];
    else finalEnv[k] = String(v);
  }

  if (rt.isCmd) {
    return spawn("cmd.exe", ["/c", rt.binary, ...args], { cwd, env: finalEnv, stdio, windowsHide: true });
  }
  return spawn(rt.binary, args, { cwd, env: finalEnv, stdio, windowsHide: true });
}

function runClaudeSync(rt, args, timeoutMs = 8000) {
  if (rt.mode === "missing") return { status: 127, stdout: "", stderr: "Claude Code 未安装" };
  const iso = getClaudeIsolationConfig();
  if (rt.mode === "wsl") {
    const quoted = args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    const isoLine = iso.configDir ? `export CLAUDE_CONFIG_DIR='${winPathToWsl(iso.configDir).replace(/'/g, "'\\''")}'` : "";
    const script = [
      "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY",
      isoLine,
      `'${rt.binary.replace(/'/g, "'\\''")}' ${quoted}`,
    ].filter(Boolean).join("\n");
    return spawnSync("wsl.exe", wslScriptArgs(script), { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  }
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTHROPIC_BASE_URL;
  delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
  delete cleanEnv.ANTHROPIC_API_KEY;
  if (iso.configDir) cleanEnv.CLAUDE_CONFIG_DIR = iso.configDir;
  if (rt.isCmd) {
    return spawnSync("cmd.exe", ["/c", rt.binary, ...args], { encoding: "utf8", env: cleanEnv, timeout: timeoutMs, windowsHide: true });
  }
  return spawnSync(rt.binary, args, { encoding: "utf8", env: cleanEnv, timeout: timeoutMs, windowsHide: true });
}

function readInstalledPkgVersionFast(rootDir) {
  try {
    const pkgPath = path.join(rootDir, "node_modules", "@anthropic-ai", "claude-code", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg?.version) return `${pkg.version} (Claude Code)`;
    }
  } catch {}
  return "installed";
}

function buildStatusObjectFromRuntime(rt, iso, auth) {
  if (!rt || rt.mode === "missing") {
    return {
      installed: false,
      mode: "missing",
      binary: null,
      version: null,
      isolation_mode: iso.mode,
      config_dir: iso.configDir || path.join(os.homedir(), ".claude"),
      auth: { loggedIn: false },
      note: "未检测到原生 Claude Code，可点击下方「一键安装稳定版 / 最新版」自动安装。",
    };
  }
  const isoNote =
    iso.mode === "isolated"
      ? "独立配置沙盒已开启（绝不修改或冲突本机原有 ~/.claude 与命令行 Claude Code）"
      : "当前为共享系统 ~/.claude 模式（复用系统原有登录态，仍通过独立启动参数保护原有配置）";

  return {
    installed: true,
    mode: rt.mode,
    bundled: Boolean(rt.bundled),
    managed: Boolean(rt.managed),
    isolation_mode: iso.mode,
    config_dir: iso.configDir || path.join(os.homedir(), ".claude"),
    binary: rt.binary,
    version: rt.version,
    auth: auth || { loggedIn: false },
    note: rt.managed
      ? `已启用工作台独立升级的原生 Claude Code (${rt.version}) · ${isoNote}`
      : rt.bundled
        ? `已开箱启用随安装包内置的原生 Claude Code (${rt.version}) · ${isoNote}`
        : rt.mode === "wsl"
          ? `已接入 WSL2 原生 Claude Code (${rt.version}) · ${isoNote}`
          : `已接入本机原生 Claude Code (${rt.version}) · ${isoNote}`,
  };
}

function spawnAsyncText(cmd, args, { env, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc;
    try {
      proc = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return resolve({ status: -1, stdout: "", stderr: err.message });
    }
    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve({ status: -1, stdout, stderr: stderr + " timeout" });
    }, timeoutMs);
    proc.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    proc.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("error", (err) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: err.message }); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ status: code ?? 0, stdout, stderr }); });
  });
}

async function detectClaudeRuntimeAsync(force = false) {
  if (!force && _cachedRuntime && Date.now() - _cachedAt < RUNTIME_CACHE_TTL_MS) {
    if (_cachedRuntime.mode === "missing" || _cachedRuntime.mode === "wsl" || fs.existsSync(_cachedRuntime.binary)) {
      return _cachedRuntime;
    }
  }

  const managedCandidates = getManagedClaudeCandidates();
  const bundledCandidates = getBundledClaudeCandidates();
  const managedSet = new Set(managedCandidates.map((p) => path.resolve(p)));
  const bundledSet = new Set(bundledCandidates.map((p) => path.resolve(p)));
  const fixedSystemCandidates =
    process.platform === "win32"
      ? [
          path.join(os.homedir(), ".local", "bin", "claude.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"),
        ]
      : [path.join(os.homedir(), ".local", "bin", "claude")];

  const probeBinAsync = async (binPath) => {
    if (!binPath || !fs.existsSync(binPath)) return null;
    const isCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath);
    const res = isCmd
      ? await spawnAsyncText("cmd.exe", ["/c", binPath, "--version"], { timeoutMs: 4000 })
      : await spawnAsyncText(binPath, ["--version"], { timeoutMs: 4000 });
    if (res.status === 0 && /claude|\d+\.\d+/i.test(res.stdout || "")) {
      const abs = path.resolve(binPath);
      return {
        mode: "native",
        binary: binPath,
        isCmd,
        version: (res.stdout || "").trim(),
        managed: managedSet.has(abs),
        bundled: bundledSet.has(abs),
      };
    }
    return null;
  };

  let found = null;
  for (const c of [...new Set([...managedCandidates, ...bundledCandidates, ...fixedSystemCandidates])]) {
    found = await probeBinAsync(c);
    if (found) break;
  }

  if (!found) {
    const pathCandidates = [];
    if (process.platform === "win32") {
      const w = await spawnAsyncText("where.exe", ["claude.exe"], { timeoutMs: 2500 });
      if (w.status === 0 && w.stdout) pathCandidates.push(...w.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      if (!pathCandidates.length) {
        const wc = await spawnAsyncText("where.exe", ["claude"], { timeoutMs: 2500 });
        if (wc.status === 0 && wc.stdout) pathCandidates.push(...wc.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      }
    } else {
      const w = await spawnAsyncText("which", ["claude"], { timeoutMs: 2500 });
      if (w.status === 0 && w.stdout.trim()) pathCandidates.push(w.stdout.trim());
    }
    for (const c of [...new Set(pathCandidates)]) {
      found = await probeBinAsync(c);
      if (found) break;
    }
  }

  if (!found && process.platform === "win32") {
    const script = [
      'BIN=$(command -v claude || ls -1 "$HOME/.local/bin/claude" 2>/dev/null | head -n1)',
      'if [ -n "$BIN" ]; then',
      '  echo "BIN=$BIN"',
      '  "$BIN" --version',
      "fi",
    ].join("\n");
    const res = await spawnAsyncText("wsl.exe", wslScriptArgs(script), { timeoutMs: 6000 });
    if (res.status === 0 && res.stdout) {
      const lines = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const binLine = lines.find((l) => l.startsWith("BIN="));
      const verLine = lines.find((l) => !l.startsWith("BIN="));
      if (binLine && verLine) {
        found = { mode: "wsl", binary: binLine.slice(4), isCmd: false, version: verLine, managed: false, bundled: false };
      }
    }
  }

  _cachedRuntime = found || { mode: "missing", binary: null, isCmd: false, version: null, bundled: false, managed: false };
  _cachedAt = Date.now();
  return _cachedRuntime;
}

async function probeClaudeAuthAsync(rt, iso) {
  if (!rt || rt.mode === "missing") return { loggedIn: false };
  try {
    let res;
    if (rt.mode === "wsl") {
      const isoLine = iso.configDir ? `export CLAUDE_CONFIG_DIR='${winPathToWsl(iso.configDir).replace(/'/g, "'\\''")}'` : "";
      const script = [
        "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY",
        isoLine,
        `'${rt.binary.replace(/'/g, "'\\''")}' 'auth' 'status'`,
      ].filter(Boolean).join("\n");
      res = await spawnAsyncText("wsl.exe", wslScriptArgs(script), { timeoutMs: 6000 });
    } else {
      const cleanEnv = { ...process.env };
      delete cleanEnv.ANTHROPIC_BASE_URL;
      delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
      delete cleanEnv.ANTHROPIC_API_KEY;
      if (iso.configDir) cleanEnv.CLAUDE_CONFIG_DIR = iso.configDir;
      res = rt.isCmd
        ? await spawnAsyncText("cmd.exe", ["/c", rt.binary, "auth", "status"], { env: cleanEnv, timeoutMs: 6000 })
        : await spawnAsyncText(rt.binary, ["auth", "status"], { env: cleanEnv, timeoutMs: 6000 });
    }
    const out = (res.stdout || "").trim();
    const jsonStart = out.indexOf("{");
    if (jsonStart >= 0) return JSON.parse(out.slice(jsonStart));
  } catch {}
  return { loggedIn: false };
}

/**
 * Non-blocking async probe of Claude runtime + `claude auth status` (never blocks Node event loop!).
 */
export async function refreshClaudeRuntimeAndAuthAsync(force = false) {
  const iso = getClaudeIsolationConfig();
  if (
    !force &&
    _cachedStatusSnapshot &&
    _cachedStatusIsoMode === iso.mode &&
    Date.now() - _cachedStatusAt < AUTH_CACHE_TTL_MS
  ) {
    return _cachedStatusSnapshot;
  }
  if (_inflightStatusPromise && !force) {
    return await _inflightStatusPromise;
  }

  const run = (async () => {
    const rt = await detectClaudeRuntimeAsync(force);
    const curIso = getClaudeIsolationConfig();
    const auth = await probeClaudeAuthAsync(rt, curIso);
    const snapshot = buildStatusObjectFromRuntime(rt, curIso, auth);
    _cachedStatusSnapshot = snapshot;
    _cachedStatusAt = Date.now();
    _cachedStatusIsoMode = curIso.mode;
    return snapshot;
  })();

  _inflightStatusPromise = run;
  try {
    return await run;
  } finally {
    if (_inflightStatusPromise === run) _inflightStatusPromise = null;
  }
}

/**
 * Zero-latency (<1ms) snapshot for `/api/bootstrap` and `/api/providers` when `force=false`.
 * Uses SWR (stale-while-revalidate) + instant filesystem inspection on cold boot so UI opens instantaneously!
 */
export function getClaudeRuntimeAndAuth(force = false) {
  const iso = getClaudeIsolationConfig();

  if (!force) {
    if (_cachedStatusSnapshot && _cachedStatusIsoMode === iso.mode) {
      if (Date.now() - _cachedStatusAt >= AUTH_CACHE_TTL_MS) {
        refreshClaudeRuntimeAndAuthAsync(false).catch(() => {});
      }
      return _cachedStatusSnapshot;
    }

    // Cold-start sub-millisecond fast path: inspect managed/bundled files without spawning any child process!
    const managedHit = getManagedClaudeCandidates().find((p) => fs.existsSync(p));
    if (managedHit) {
      const fastRt = {
        mode: "native",
        binary: managedHit,
        isCmd: /\.(cmd|bat)$/i.test(managedHit),
        version: readInstalledPkgVersionFast(iso.runtimeDir),
        managed: true,
        bundled: false,
      };
      refreshClaudeRuntimeAndAuthAsync(false).catch(() => {});
      return buildStatusObjectFromRuntime(fastRt, iso, { loggedIn: false });
    }
    const bundledHit = getBundledClaudeCandidates().find((p) => fs.existsSync(p));
    if (bundledHit) {
      const fastRt = {
        mode: "native",
        binary: bundledHit,
        isCmd: /\.(cmd|bat)$/i.test(bundledHit),
        version: readInstalledPkgVersionFast(PROJECT_ROOT),
        managed: false,
        bundled: true,
      };
      refreshClaudeRuntimeAndAuthAsync(false).catch(() => {});
      return buildStatusObjectFromRuntime(fastRt, iso, { loggedIn: false });
    }

    if (_cachedRuntime) {
      refreshClaudeRuntimeAndAuthAsync(false).catch(() => {});
      return buildStatusObjectFromRuntime(_cachedRuntime, iso, { loggedIn: false });
    }

    // Kick off async background discovery and return optimistic placeholder without blocking HTTP!
    refreshClaudeRuntimeAndAuthAsync(true).catch(() => {});
    return {
      installed: false,
      probing: true,
      mode: "probing",
      binary: null,
      version: null,
      isolation_mode: iso.mode,
      config_dir: iso.configDir || path.join(os.homedir(), ".claude"),
      auth: { loggedIn: false },
      note: "正在后台检测原生 Claude Code 运行环境…",
    };
  }

  // Synchronous forced fallback when caller explicitly requires blocking probe
  const rt = detectClaudeRuntime(true);
  if (rt.mode === "missing") {
    const miss = buildStatusObjectFromRuntime(rt, iso, { loggedIn: false });
    _cachedStatusSnapshot = miss;
    _cachedStatusAt = Date.now();
    _cachedStatusIsoMode = iso.mode;
    return miss;
  }

  let auth = { loggedIn: false };
  try {
    const res = runClaudeSync(rt, ["auth", "status"], 6000);
    const out = (res.stdout || "").trim();
    const jsonStart = out.indexOf("{");
    if (jsonStart >= 0) {
      auth = JSON.parse(out.slice(jsonStart));
    }
  } catch {
    // keep default
  }

  const snap = buildStatusObjectFromRuntime(rt, iso, auth);
  _cachedStatusSnapshot = snap;
  _cachedStatusAt = Date.now();
  _cachedStatusIsoMode = iso.mode;
  return snap;
}

const CLAUDE_DIST_BASE = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
let _activeAuthSession = null; // { proc, oauthUrl, timer }

function parseSemverString(raw) {
  const m = String(raw || "").match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  return m ? m[1] : "";
}

function stripAnsi(s) {
  return String(s || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function openExternalUrlInHost(url) {
  if (!/^https:\/\//i.test(url || "")) return;
  try {
    if (process.platform === "win32") {
      // Single-quoted PowerShell Start-Process is 100% immune to `&` query-string truncation!
      const escaped = url.replace(/'/g, "''");
      const encoded = Buffer.from(`Start-Process -FilePath '${escaped}'`, "utf16le").toString("base64");
      spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // frontend link button also opens it
  }
}

/**
 * Ensure native Claude Code can run direct-API mode WITHOUT hanging on first-run onboarding
 * (especially for students on fresh machines without any VPN/proxy).
 * Only merges `"hasCompletedOnboarding": true` if missing — never overwrites existing auth/keys!
 */
export function ensureClaudeDirectReady(rt) {
  try {
    if (!rt || rt.mode === "missing") return;
    const iso = getClaudeIsolationConfig();
    if (iso.configDir) {
      // Strictly write onboarding flag ONLY inside OpenCode Studio's isolated CLAUDE_CONFIG_DIR!
      fs.mkdirSync(iso.configDir, { recursive: true });
      const cfgPath = path.join(iso.configDir, ".claude.json");
      let data = {};
      if (fs.existsSync(cfgPath)) {
        try {
          data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        } catch {
          data = {};
        }
      }
      if (!data.hasCompletedOnboarding) {
        data.hasCompletedOnboarding = true;
        fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2), "utf8");
      }
      return;
    }
    if (rt.mode === "wsl") {
      const script = `python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude.json")
data = {}
if os.path.exists(p):
    try:
        data = json.load(open(p, "r", encoding="utf-8"))
    except Exception:
        data = {}
if not data.get("hasCompletedOnboarding"):
    data["hasCompletedOnboarding"] = True
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
PY`;
      spawnSync("wsl.exe", wslScriptArgs(script), { encoding: "utf8", timeout: 5000, windowsHide: true });
      return;
    }
    const cfgPath = path.join(os.homedir(), ".claude.json");
    let data = {};
    if (fs.existsSync(cfgPath)) {
      try {
        data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      } catch {
        data = {};
      }
    }
    if (!data.hasCompletedOnboarding) {
      data.hasCompletedOnboarding = true;
      fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2), "utf8");
    }
  } catch {
    // non-fatal
  }
}

/**
 * Start real `claude auth login` flow:
 *  - Captures OAuth URL across platform.claude.com / claude.ai / console.anthropic.com
 *  - Immediately launches the host browser to that URL
 *  - Keeps stdin open so users can paste the authorization code if prompted!
 */
export async function runClaudeAuthLogin({ mode = "claudeai", email = "", onProgress } = {}) {
  const rt = detectClaudeRuntime(true);
  if (rt.mode === "missing") {
    return { ok: false, error: "本机尚未安装原生 Claude Code，请先在「设置 → 版本管理」中安装原生 Claude Code。" };
  }

  // Terminate any stale previous login process
  if (_activeAuthSession?.proc) {
    try {
      clearTimeout(_activeAuthSession.timer);
      _activeAuthSession.proc.kill();
    } catch {}
    _activeAuthSession = null;
  }

  const args = ["auth", "login", mode === "console" ? "--console" : "--claudeai"];
  if (email && email.trim()) args.push("--email", email.trim());

  logEvent("INFO", "claude_auth", "login_start", `发起原生 Claude Code 登录 (${mode})`);

  return await new Promise((resolve) => {
    // On WSL/Linux, wrap inside Python PTY so Claude CLI flushes OAuth URL immediately (<0.5s) instead of buffering!
    let proc;
    const iso = getClaudeIsolationConfig();
    if (rt.mode === "wsl") {
      const pyArgs = JSON.stringify([rt.binary, ...args]);
      const pyIsoDir = iso.configDir ? JSON.stringify(winPathToWsl(iso.configDir)) : "None";
      const pyScript = `python3 -u - <<'PY'
import os, pty, select, subprocess, sys
m, s = pty.openpty()
env = os.environ.copy()
for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
    env.pop(k, None)
env["DISABLE_TELEMETRY"] = "1"
iso_dir = ${pyIsoDir}
if iso_dir:
    env["CLAUDE_CONFIG_DIR"] = iso_dir
p = subprocess.Popen(${pyArgs}, stdin=s, stdout=s, stderr=s, env=env, close_fds=True)
os.close(s)
while True:
    if p.poll() is not None:
        break
    r, _, _ = select.select([m, sys.stdin.fileno()], [], [], 0.15)
    if m in r:
        try:
            d = os.read(m, 4096)
            if not d: break
            sys.stdout.buffer.write(d)
            sys.stdout.buffer.flush()
        except OSError:
            break
    if sys.stdin.fileno() in r:
        line = os.read(sys.stdin.fileno(), 4096)
        if not line: break
        os.write(m, line)
sys.exit(p.wait())
PY`;
      proc = spawn("wsl.exe", wslScriptArgs(pyScript), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } else {
      // Native Windows / macOS binary: runs directly & flushes OAuth URL in ~0.3s + launches browser!
      const authEnv = {
        ANTHROPIC_BASE_URL: null,
        ANTHROPIC_AUTH_TOKEN: null,
        ANTHROPIC_API_KEY: null,
        DISABLE_TELEMETRY: "1",
      };
      // Forward configured search proxy to official Claude OAuth if user set one
      const se = getAllSettings().search_engine || {};
      if (se.proxy_url) {
        authEnv.HTTP_PROXY = se.proxy_url;
        authEnv.HTTPS_PROXY = se.proxy_url;
      }
      proc = spawnClaudeProcess(rt, args, {
        cwd: os.homedir(),
        env: authEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    const expireTimer = setTimeout(() => {
      if (_activeAuthSession?.proc === proc) {
        try { proc.kill(); } catch {}
        _activeAuthSession = null;
      }
    }, 10 * 60 * 1000);

    _activeAuthSession = { proc, oauthUrl: "", timer: expireTimer, combined: "" };

    let combined = "";
    let oauthUrl = "";
    let resolved = false;
    let browserOpened = false;

    const finishEarlyWithUrl = () => {
      if (resolved || !oauthUrl) return;
      resolved = true;
      resolve({
        ok: true,
        pending_browser: true,
        needs_code_input: true,
        oauth_url: oauthUrl,
        output: combined.trim(),
        message: "已为您打开官方授权页面。完成网页登录后，如页面显示授权码 (Code)，请粘贴到下方输入框点击提交；如自动跳转成功，直接点击「刷新状态」即可。",
      });
    };

    const inspectChunk = (chunk) => {
      const txt = stripAnsi(chunk.toString("utf8"));
      combined += txt;
      if (_activeAuthSession?.proc === proc) _activeAuthSession.combined = combined;

      // Match ALL official Claude OAuth hosts: claude.com, platform.claude.com, claude.ai, console.anthropic.com!
      const cleanCombined = combined.replace(/\r/g, "");
      const m =
        cleanCombined.match(/https:\/\/(?:claude\.com|platform\.claude\.com|claude\.ai|console\.anthropic\.com)\/[^\s"'<>]+/i);
      if (m && !oauthUrl) {
        oauthUrl = m[0].replace(/[.,;)]+$/, "");
        if (_activeAuthSession?.proc === proc) _activeAuthSession.oauthUrl = oauthUrl;
        if (!browserOpened) {
          browserOpened = true;
          openExternalUrlInHost(oauthUrl);
        }
        onProgress?.({ stage: "oauth_url", url: oauthUrl, needs_code_input: true, text: txt });
        setTimeout(finishEarlyWithUrl, 350);
      } else {
        onProgress?.({ stage: "output", text: txt });
      }
    };

    proc.stdout?.on("data", inspectChunk);
    proc.stderr?.on("data", inspectChunk);

    // Safety timeout so HTTP endpoint NEVER hangs indefinitely even if CLI stalls
    const urlTimer = setTimeout(() => {
      if (!resolved) {
        if (oauthUrl) return finishEarlyWithUrl();
        resolved = true;
        resolve({
          ok: false,
          error: "等待官方授权链接超时（请检查网络/代理连接，或查看下方输出）。",
          output: combined.trim(),
        });
      }
    }, 10000);

    proc.on("close", (code) => {
      clearTimeout(urlTimer);
      clearTimeout(expireTimer);
      if (_activeAuthSession?.proc === proc) _activeAuthSession = null;
      clearRuntimeCache();
      const status = getClaudeRuntimeAndAuth(true);
      onProgress?.({ stage: "done", code, auth: status.auth });
      if (!resolved) {
        resolved = true;
        resolve({
          ok: code === 0 || Boolean(status.auth?.loggedIn),
          oauth_url: oauthUrl,
          output: combined.trim(),
          auth: status.auth,
          runtime: status,
          message: status.auth?.loggedIn ? "Claude 官方账号登录成功！" : combined.trim() || `登录命令退出码 ${code}`,
        });
      }
    });
  });
}

/**
 * Submit pasted OAuth authorization code back to the waiting `claude auth login` process!
 */
export async function submitClaudeAuthCode(codeText) {
  const clean = String(codeText || "").trim();
  if (!clean) return { ok: false, error: "授权码不能为空" };
  const sess = _activeAuthSession;
  if (!sess?.proc || sess.proc.killed || sess.proc.exitCode !== null) {
    return { ok: false, error: "当前没有等待输入授权码的登录会话，请先重新点击登录按钮。" };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const done = (ok, msg) => {
      if (settled) return;
      settled = true;
      clearRuntimeCache();
      const runtime = getClaudeRuntimeAndAuth(true);
      resolve({
        ok: ok || Boolean(runtime.auth?.loggedIn),
        message: runtime.auth?.loggedIn ? "官方账号授权登录成功！" : msg,
        runtime,
      });
    };

    const timer = setTimeout(() => done(false, "已提交授权码，请点击「刷新状态」确认结果。"), 12000);
    sess.proc.once("close", (rc) => {
      clearTimeout(timer);
      done(rc === 0, rc === 0 ? "登录完成" : `授权进程退出码 ${rc}，请检查授权码是否有效或已过期。`);
    });

    try {
      sess.proc.stdin.write(clean + "\n");
    } catch (err) {
      clearTimeout(timer);
      done(false, `提交授权码失败: ${err.message}`);
    }
  });
}

export function runClaudeAuthLogout() {
  if (_activeAuthSession?.proc) {
    try { _activeAuthSession.proc.kill(); } catch {}
    _activeAuthSession = null;
  }
  const rt = detectClaudeRuntime(true);
  if (rt.mode === "missing") return { ok: false, error: "未安装 Claude Code" };
  const res = runClaudeSync(rt, ["auth", "logout"], 8000);
  clearRuntimeCache();
  return {
    ok: res.status === 0,
    output: (res.stdout || res.stderr || "").trim(),
    runtime: getClaudeRuntimeAndAuth(true),
  };
}

/**
 * Check installed Claude Code version vs official `stable` and `latest` channels!
 */
export async function checkClaudeVersions() {
  const runtime = await refreshClaudeRuntimeAndAuthAsync(true);
  const currentVer = parseSemverString(runtime.version);
  const proxyUrl = getAllSettings().search_engine?.proxy_url || "";

  let stableVer = "";
  let latestVer = "";
  let source = "";
  let error = "";

  const fetchText = async (url, timeoutMs = 6000) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await proxyFetch(url, {
        headers: { "User-Agent": "OpenCodeStudio/2.1" },
        signal: c.signal,
        proxyUrl,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.text()).trim();
    } finally {
      clearTimeout(t);
    }
  };

  try {
    const [s, l] = await Promise.all([
      fetchText(`${CLAUDE_DIST_BASE}/stable`),
      fetchText(`${CLAUDE_DIST_BASE}/latest`),
    ]);
    stableVer = parseSemverString(s);
    latestVer = parseSemverString(l);
    source = "official-gcs";
  } catch (e1) {
    // Fallback to npm registry (works cleanly even on restricted networks)
    try {
      const raw = await fetchText("https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags", 7000);
      const tags = JSON.parse(raw);
      stableVer = parseSemverString(tags.stable || tags.latest);
      latestVer = parseSemverString(tags.latest || tags.next);
      source = "npm-registry";
    } catch (e2) {
      error = `无法联网查询官方版本通道: ${e2.message || e1.message}`;
    }
  }

  let status = "not_installed";
  let statusText = "本机尚未安装原生 Claude Code（未安装时会自动使用内置直连引擎，也可一键安装原生内核）";
  if (runtime.installed && currentVer) {
    if (latestVer && currentVer === latestVer && stableVer && currentVer === stableVer) {
      status = "both";
      statusText = `当前 v${currentVer} 已同时是最新稳定版与最新版`;
    } else if (latestVer && currentVer === latestVer) {
      status = "latest";
      statusText = `当前已是最新版 (latest: v${latestVer})；官方稳定版为 v${stableVer || "-"}`;
    } else if (stableVer && currentVer === stableVer) {
      status = "stable";
      statusText = `当前已是官方稳定版 (stable: v${stableVer})；官方最新版为 v${latestVer || "-"}`;
    } else {
      status = "outdated";
      statusText = `当前版本 v${currentVer}（可切换至稳定版 v${stableVer || "-"} 或最新版 v${latestVer || "-"}）`;
    }
  }

  return {
    ok: !error,
    installed: runtime.installed,
    mode: runtime.mode,
    binary: runtime.binary,
    current_version: currentVer || null,
    stable_version: stableVer || null,
    latest_version: latestVer || null,
    channel_status: status,
    status_text: statusText,
    source,
    error: error || null,
    runtime,
  };
}

/**
 * After switching Claude Code versions, preserve user config & credentials and clean up
 * older unused binaries under `~/.local/share/claude/versions/` to prevent disk bloat.
 */
function cleanupOldClaudeVersions(rt) {
  try {
    if (!rt || rt.mode === "missing") return { removed: 0, freed_mb: 0 };
    if (rt.mode === "wsl") {
      const script = `python3 - <<'PY'
import os, json, shutil
bin_link = os.path.expanduser("~/.local/bin/claude")
ver_dir = os.path.expanduser("~/.local/share/claude/versions")
active = os.path.realpath(bin_link) if os.path.exists(bin_link) else ""
removed = 0
freed = 0
if os.path.isdir(ver_dir):
    for name in os.listdir(ver_dir):
        full = os.path.join(ver_dir, name)
        if active and os.path.realpath(full) == active:
            continue
        try:
            if os.path.isfile(full) or os.path.islink(full):
                freed += os.path.getsize(full) if not os.path.islink(full) else 0
                os.unlink(full)
                removed += 1
            elif os.path.isdir(full):
                for r, _, fs in os.walk(full):
                    for fn in fs:
                        fp = os.path.join(r, fn)
                        if os.path.isfile(fp): freed += os.path.getsize(fp)
                shutil.rmtree(full, ignore_errors=True)
                removed += 1
        except Exception:
            pass
print(json.dumps({"removed": removed, "freed_mb": round(freed / (1024*1024), 1)}))
PY`;
      const r = spawnSync("wsl.exe", wslScriptArgs(script), { encoding: "utf8", timeout: 8000, windowsHide: true });
      const m = (r.stdout || "").match(/\{.*\}/);
      return m ? JSON.parse(m[0]) : { removed: 0, freed_mb: 0 };
    }
    const verDir = path.join(os.homedir(), ".local", "share", "claude", "versions");
    const activeReal = rt.binary && fs.existsSync(rt.binary) ? fs.realpathSync(rt.binary) : "";
    let removed = 0;
    let freed = 0;
    if (fs.existsSync(verDir)) {
      for (const name of fs.readdirSync(verDir)) {
        const full = path.join(verDir, name);
        try {
          if (activeReal && fs.realpathSync(full) === activeReal) continue;
          const st = fs.statSync(full);
          freed += st.size || 0;
          fs.rmSync(full, { recursive: true, force: true });
          removed += 1;
        } catch {}
      }
    }
    return { removed, freed_mb: Math.round((freed / (1024 * 1024)) * 10) / 10 };
  } catch {
    return { removed: 0, freed_mb: 0 };
  }
}

/**
 * Clean up native Claude CLI `.jsonl` session files associated with deleted Studio sessions
 * so repeated branching never leaves stray files behind.
 */
export function cleanupClaudeSessionFiles(cliSessionIds = []) {
  const sids = [...new Set((cliSessionIds || []).filter((s) => typeof s === "string" && /^[a-z0-9-]{8,}$/i.test(s)))];
  if (!sids.length) return 0;
  let removed = 0;
  const iso = getClaudeIsolationConfig();
  const rt = detectClaudeRuntime(false);

  if (iso.configDir) {
    // Only clean session jsonl inside OpenCode Studio's isolated config dir!
    const projRoot = path.join(iso.configDir, "projects");
    if (fs.existsSync(projRoot)) {
      for (const dir of fs.readdirSync(projRoot)) {
        const sub = path.join(projRoot, dir);
        for (const sid of sids) {
          const fp = path.join(sub, `${sid}.jsonl`);
          if (fs.existsSync(fp)) {
            try {
              fs.unlinkSync(fp);
              removed += 1;
            } catch {}
          }
        }
      }
    }
    return removed;
  }

  if (rt.mode === "wsl") {
    const script = `python3 - <<'PY'
import os, glob
sids = ${JSON.stringify(sids)}
root = os.path.expanduser("~/.claude/projects")
n = 0
if os.path.isdir(root):
    for sid in sids:
        for p in glob.glob(os.path.join(root, "*", f"{sid}.jsonl")):
            try:
                os.unlink(p)
                n += 1
            except Exception:
                pass
print(n)
PY`;
    const r = spawnSync("wsl.exe", wslScriptArgs(script), { encoding: "utf8", timeout: 5000, windowsHide: true });
    return Number((r.stdout || "").trim()) || 0;
  }

  const projRoot = path.join(os.homedir(), ".claude", "projects");
  if (fs.existsSync(projRoot)) {
    for (const dir of fs.readdirSync(projRoot)) {
      const sub = path.join(projRoot, dir);
      for (const sid of sids) {
        const fp = path.join(sub, `${sid}.jsonl`);
        if (fs.existsSync(fp)) {
          try {
            fs.unlinkSync(fp);
            removed += 1;
          } catch {}
        }
      }
    }
  }
  return removed;
}

/**
 * Install or switch Claude Code between `stable` and `latest` channels,
 * preserve config/auth migration, and automatically clean up unused old versions!
 */
export async function installOrSwitchClaudeVersion({ channel = "stable", forceNativeWin = false, onProgress } = {}) {
  const target = channel === "latest" ? "latest" : "stable";
  const iso = getClaudeIsolationConfig();
  const rt = detectClaudeRuntime(true);

  logEvent("INFO", "claude_install", "start", `安装/切换原生 Claude Code -> ${target} (current=${rt.mode}, isolation=${iso.mode})`);
  onProgress?.(
    iso.mode === "isolated"
      ? `正在 OpenCode Studio 私有隔离目录 (${iso.runtimeDir}) 中安装/切换原生 Claude Code (${target})，绝不影响系统原有 Claude Code…\n`
      : `正在安装/切换原生 Claude Code (${target})，将保留您的账号与配置…\n`,
  );

  const runCmd = (spawnFn) =>
    new Promise((resolve) => {
      let output = "";
      const proc = spawnFn();
      const push = (chunk) => {
        const s = chunk.toString("utf8");
        output += s;
        onProgress?.(s);
      };
      proc.stdout?.on("data", push);
      proc.stderr?.on("data", push);
      proc.on("error", (err) => resolve({ code: 1, output: output + `\n${err.message}` }));
      proc.on("close", (code) => resolve({ code: code ?? 1, output }));
    });

  let runRes;
  if (iso.mode === "isolated") {
    // Strictly install/upgrade inside OpenCode Studio's private runtime folder — NEVER touches user's ~/.local/bin/claude or global npm!
    fs.mkdirSync(iso.runtimeDir, { recursive: true });
    const pkgJsonPath = path.join(iso.runtimeDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: "opencode-studio-claude-runtime", private: true }, null, 2), "utf8");
    }
    const se = getAllSettings().search_engine || {};
    const npmArgs = ["install", "--prefix", iso.runtimeDir, "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${target}`];
    if (se.mode === "cn") {
      npmArgs.push("--registry=https://registry.npmmirror.com");
    }
    onProgress?.(`执行私有隔离安装：npm ${npmArgs.join(" ")}\n`);
    runRes = await runCmd(() =>
      process.platform === "win32"
        ? spawn("cmd.exe", ["/c", "npm", ...npmArgs], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("npm", npmArgs, { stdio: ["ignore", "pipe", "pipe"] }),
    );
    // Remove duplicate bin/claude.exe hardlink inside private dir to keep footprint minimal
    try {
      const dupBin = path.join(iso.runtimeDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (fs.existsSync(dupBin)) fs.unlinkSync(dupBin);
    } catch {}
  } else if (rt.mode !== "missing" && !(forceNativeWin && rt.mode === "wsl")) {
    runRes = await runCmd(() =>
      spawnClaudeProcess(rt, ["install", target, "--force"], {
        cwd: os.homedir(),
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } else if (process.platform === "win32") {
    onProgress?.("正在调用官方 Windows 安装脚本（若无代理受限将自动回退 npm 安装）…\n");
    runRes = await runCmd(() =>
      spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm https://claude.ai/install.ps1 | iex`], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (runRes.code !== 0) {
      onProgress?.(`\n官方直连安装未成功，正在自动回退 npm 安装 @anthropic-ai/claude-code@${target}…\n`);
      runRes = await runCmd(() =>
        spawn("cmd.exe", ["/c", "npm", "install", "-g", `@anthropic-ai/claude-code@${target}`], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    }
  } else {
    onProgress?.("正在调用官方安装脚本（若无代理受限将自动回退 npm 安装）…\n");
    runRes = await runCmd(() =>
      spawn("bash", ["-lc", `curl -fsSL https://claude.ai/install.sh | bash -s ${target}`], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (runRes.code !== 0) {
      onProgress?.(`\n官方直连安装未成功，正在自动回退 npm 安装 @anthropic-ai/claude-code@${target}…\n`);
      runRes = await runCmd(() =>
        spawn("npm", ["install", "-g", `@anthropic-ai/claude-code@${target}`], {
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    }
  }

  clearRuntimeCache();
  const nextRt = getClaudeRuntimeAndAuth(true);
  let cleanup = { removed: 0, freed_mb: 0 };
  if (runRes.code === 0 && nextRt.installed) {
    ensureClaudeDirectReady(nextRt);
    if (iso.mode === "isolated") {
      onProgress?.("\n[隔离切换完成] 已在工作台私有目录完成版本更新，您的系统原有 Claude Code 与配置完全未受影响。\n");
    } else {
      cleanup = cleanupOldClaudeVersions(nextRt);
      if (cleanup.removed > 0) {
        onProgress?.(`\n[自动清理] 已保留现有配置完成迁移，并清理 ${cleanup.removed} 个旧版本二进制，释放约 ${cleanup.freed_mb} MB 空间。\n`);
      } else {
        onProgress?.("\n[迁移完成] 已保留原有账号与配置，无冗余旧版本残留。\n");
      }
    }
  }

  logEvent("INFO", "claude_install", "done", `Claude Code (${target}) 切换结束 rc=${runRes.code}, version=${nextRt.version}, cleaned=${cleanup.removed}`);
  return {
    ok: runRes.code === 0 && nextRt.installed,
    code: runRes.code,
    channel: target,
    cleanup,
    output: runRes.output.slice(-4000),
    runtime: nextRt,
  };
}

export function buildCustomPromptAndMcp(cwd, rtMode, { webSearchEnabled = null } = {}) {
  const settings = getAllSettings();
  const basePrompt = String(settings.system_prompt || "").trim();
  const mode = settings.prompt_mode || "replace"; // replace | append | native
  const useWebSearch = webSearchEnabled !== null ? Boolean(webSearchEnabled) : settings.web_search_enabled !== false;

  const extraSections = [];
  if (useWebSearch) {
    extraSections.push(
      "[实时全网搜索已启用]\n当前会话已挂载内置免配置联网工具 `mcp__opencode_web__web_search` 与 `mcp__opencode_web__web_read_page`。遇到时效性资讯、最新技术文档、外部网址或不确定事实时，请主动调用联网搜索并在回答末尾附上参考来源链接。",
    );
  }
  const memoryBlock = buildUnifiedMemoryContext({ cwd, rtMode });
  if (memoryBlock) {
    extraSections.push(memoryBlock);
  }
  const skills = listInstalledSkills().filter((s) => s.enabled);
  if (skills.length) {
    extraSections.push(
      "[已启用的自定义 Skills]\n" +
        skills.slice(0, 8).map((s) => `## /${s.slug} (${s.name})\n${s.content.slice(0, 1800)}`).join("\n\n"),
    );
  }

  const extraContext = extraSections.filter(Boolean).join("\n\n");
  // In native mode, preserve Claude's built-in system prompt while still appending unified memories & Skills!
  const effectiveFlag =
    mode === "replace"
      ? "--system-prompt-file"
      : extraContext || (mode === "append" && basePrompt)
        ? "--append-system-prompt-file"
        : "";
  const effectivePromptText =
    mode === "replace"
      ? [basePrompt, extraContext].filter(Boolean).join("\n\n")
      : mode === "append"
        ? [basePrompt, extraContext].filter(Boolean).join("\n\n")
        : extraContext;

  // Sync enabled Skills into managed SKILL.md folder for full portability
  const skillsDir = getPaths().skillsDir;
  for (const s of skills) {
    try {
      const safeSlug = String(s.slug || s.id || "skill").replace(/[^a-z0-9_-]/gi, "-");
      const dir = path.join(skillsDir, safeSlug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), s.content || `# ${s.name}\n\n${s.description || ""}`, "utf8");
    } catch {}
  }

  // Materialize enabled installed MCPs + built-in live web search MCP into active_mcp_config.json
  const mcps = listInstalledMcps().filter((m) => m.enabled);
  let mcpConfigPath = null;
  if (mcps.length || useWebSearch) {
    const mcpObj = { mcpServers: {} };
    if (useWebSearch) {
      let webMcpScript = path.join(PROJECT_ROOT, "server", "websearch_mcp_stdio.mjs");
      if (webMcpScript.includes("app.asar") && !webMcpScript.includes("app.asar.unpacked") && fs.existsSync(webMcpScript.replace("app.asar", "app.asar.unpacked"))) {
        webMcpScript = webMcpScript.replace("app.asar", "app.asar.unpacked");
      }
      const nodeCmd = rtMode === "wsl" ? winPathToWsl(process.execPath) : process.execPath;
      mcpObj.mcpServers.opencode_web = {
        command: nodeCmd,
        args: [webMcpScript],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          OPENCODE_DATA_DIR: getPaths().dataRoot,
          NO_PROXY: "127.0.0.1,localhost,::1",
        },
      };
    }
    for (const m of mcps) {
      if ((m.command === "http" || m.command === "sse" || m.command === "streamable-http") && m.args?.[0]) {
        mcpObj.mcpServers[m.name] = {
          type: m.command === "sse" ? "sse" : "http",
          url: m.args[0],
          ...(m.env && Object.keys(m.env).length ? { headers: m.env } : {}),
        };
      } else {
        mcpObj.mcpServers[m.name] = {
          command: m.command,
          args: m.args || [],
          env: m.env || {},
        };
      }
    }
    const fp = path.join(getPaths().mcpDir, "active_mcp_config.json");
    fs.writeFileSync(fp, JSON.stringify(mcpObj, null, 2), "utf8");
    mcpConfigPath = rtMode === "wsl" ? winPathToWsl(fp) : fp;
  }

  return {
    promptMode: mode,
    basePrompt,
    memoryBlock,
    extraContext,
    promptFlag: effectiveFlag,
    promptText: effectivePromptText,
    mcpConfigPath,
  };
}

function buildBridgeHistoryPrefix(historyItems) {
  const prior = historyItems.slice(0, -1).slice(-16);
  if (!prior.length) return "";
  const lines = ["[以下是当前对话此前的历史上下文，请自然衔接继续回答最后一条提问]"];
  for (const m of prior) {
    if (m.role === "compact") lines.push(`[历史压缩摘要]: ${m.content_text.slice(0, 1200)}`);
    else if (m.role === "user") lines.push(`用户: ${(m.content_text || "").slice(0, 800)}`);
    else if (m.role === "assistant") lines.push(`助手: ${(m.content_text || "").slice(0, 1000)}`);
  }
  return lines.join("\n") + "\n\n[当前用户提问]\n";
}

/**
 * Execute one real native Claude Code turn (supports Official Auth Login + ALL built-in API providers!).
 */
export async function runNativeClaudeCodeTurn({
  sessionId,
  reqId,
  provider,
  model,
  thinkingLevel,
  webSearchEnabled = null,
  cwd,
  historyItems,
  resumeCliSid,
  forkSession = false,
  localServerPort,
  signal,
  onEvent,
}) {
  const rt = detectClaudeRuntime(false);
  if (rt.mode === "missing") {
    throw classifyError({
      message: "未检测到原生 Claude Code CLI，请在设置或供应商面板点击「一键安装 Claude Code」。",
      engine: "claude_native",
      providerName: provider.name,
      model,
      sessionId,
      reqId,
    });
  }

  if (provider.kind !== "claude_native") {
    ensureClaudeDirectReady(rt);
  }

  const latestUser = historyItems[historyItems.length - 1];
  const cap = detectModelCapabilities(
    model,
    provider.kind === "claude_native" ? "anthropic" : provider.kind,
    provider.extra?.remote_meta?.[model] || null,
    provider.model_overrides?.[model],
  );
  const effectiveThinking =
    thinkingLevel && thinkingLevel !== "auto" ? thinkingLevel : (cap.thinking_supported ? cap.default_thinking : "off");
  const { memoryBlock, promptFlag, promptText, mcpConfigPath } = buildCustomPromptAndMcp(cwd, rt.mode, {
    webSearchEnabled,
  });

  // Build strictly isolated environment so native auth & API providers NEVER collide
  const env = {
    CLAUDECODE: null,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "120000",
    CLAUDE_CODE_MAX_RETRIES: "3",
  };

  if (provider.kind === "claude_native") {
    // True official Claude Auth login: strip any API overrides, preserve system proxy for official access!
    env.ANTHROPIC_BASE_URL = null;
    env.ANTHROPIC_AUTH_TOKEN = null;
    env.ANTHROPIC_API_KEY = null;
    env.ANTHROPIC_MODEL = null;
  } else {
    // Route native Claude Code cleanly through our built-in local protocol proxy (must bypass HTTP_PROXY!)
    env.HTTP_PROXY = null;
    env.HTTPS_PROXY = null;
    env.http_proxy = null;
    env.https_proxy = null;
    env.ALL_PROXY = null;
    env.all_proxy = null;
    const proxyBase = `http://127.0.0.1:${localServerPort}/proxy/provider/${provider.id}/${encodeURIComponent(effectiveThinking || "auto")}`;
    env.ANTHROPIC_BASE_URL = proxyBase;
    env.ANTHROPIC_AUTH_TOKEN = "OPENCODE_STUDIO_PROXY";
    env.ANTHROPIC_API_KEY = null;
    env.ANTHROPIC_MODEL = model;
    if (cap.context_window && !String(model).toLowerCase().startsWith("claude-")) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(cap.context_window);
    }
  }

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    // Ensure custom system prompt changes take effect immediately even on resumed sessions!
    "--system-prompt-snapshot", "off",
    // Isolate from any legacy CC Switch / ~/.claude/settings.json overrides WITHOUT modifying user's files!
    "--setting-sources", "",
  ];

  // Build isolated per-turn settings JSON so Claude Code uses OUR built-in provider & privacy settings cleanly
  const inlineSettingsEnv = {
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: "120000",
    CLAUDE_CODE_MAX_RETRIES: "3",
  };
  if (provider.kind !== "claude_native") {
    inlineSettingsEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${localServerPort}/proxy/provider/${provider.id}/${encodeURIComponent(effectiveThinking || "auto")}`;
    inlineSettingsEnv.ANTHROPIC_AUTH_TOKEN = "OPENCODE_STUDIO_PROXY";
    if (model) {
      inlineSettingsEnv.ANTHROPIC_MODEL = model;
      inlineSettingsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      inlineSettingsEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      inlineSettingsEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      inlineSettingsEnv.ANTHROPIC_SMALL_FAST_MODEL = model;
    }
    if (cap.context_window && !String(model).toLowerCase().startsWith("claude-")) {
      inlineSettingsEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(cap.context_window);
    }
  }
  args.push("--settings", JSON.stringify({ env: inlineSettingsEnv }));

  if (resumeCliSid) {
    args.push("--resume", resumeCliSid);
    if (forkSession) args.push("--fork-session");
  }
  if (model) {
    args.push("--model", model);
  }
  if (["low", "medium", "high", "xhigh", "max"].includes(effectiveThinking)) {
    args.push("--effort", effectiveThinking);
  } else if (effectiveThinking === "on") {
    args.push("--effort", "high");
  }
  let tempPromptFile = null;
  if (promptFlag && promptText) {
    try {
      const safeReq = String(reqId || Date.now()).replace(/[^a-z0-9_-]/gi, "_");
      tempPromptFile = path.join(getPaths().logsDir, `prompt_${safeReq}.txt`);
      fs.writeFileSync(tempPromptFile, promptText, "utf8");
      const cliPromptPath = rt.mode === "wsl" ? winPathToWsl(tempPromptFile) : tempPromptFile;
      args.push(promptFlag, cliPromptPath);
    } catch {
      const fallbackFlag = promptFlag === "--system-prompt-file" ? "--system-prompt" : "--append-system-prompt";
      const safePrompt = rt.isCmd ? promptText.replace(/\r?\n/g, " ") : promptText;
      args.push(fallbackFlag, safePrompt);
      tempPromptFile = null;
    }
  }
  const cleanupTempPrompt = () => {
    if (!tempPromptFile) return;
    try {
      fs.unlinkSync(tempPromptFile);
    } catch {}
    tempPromptFile = null;
  };
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  const promptBody =
    resumeCliSid ? latestUser.content_text || "" : buildBridgeHistoryPrefix(historyItems) + (latestUser.content_text || "");

  // Inject unified memories as a clean <system-reminder> in the first turn (or whenever memories change).
  // Many OpenAI-compatible relays truncate Claude Code's ~28KB system prompt tail; placing memories
  // in <system-reminder> matches Claude Code's own dynamic memory delivery and guarantees 100% recall!
  let memoryReminderPrefix = "";
  let injectedMemHash = "";
  if (memoryBlock) {
    injectedMemHash = crypto.createHash("sha1").update(memoryBlock).digest("hex").slice(0, 12);
    const sessionKey = resumeCliSid || sessionId || "default";
    const needInject = !resumeCliSid || _lastSessionMemHash.get(sessionKey) !== injectedMemHash;
    if (needInject) {
      memoryReminderPrefix = `<system-reminder>\n${memoryBlock}\n</system-reminder>\n\n`;
      _lastSessionMemHash.set(sessionKey, injectedMemHash);
      if (sessionId) _lastSessionMemHash.set(sessionId, injectedMemHash);
    }
  }

  const contentBlocks = [];
  const attachedFileNotes = [];
  for (const im of latestUser.images || []) {
    const isImg = im.kind === "image" || (!im.kind && String(im.media_type || "").startsWith("image/"));
    if (isImg) {
      if (im.path && fs.existsSync(im.path)) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: im.media_type || "image/png",
            data: fs.readFileSync(im.path).toString("base64"),
          },
        });
      }
    } else if (im.kind === "text" && im.path && fs.existsSync(im.path)) {
      const hostPath = rt.mode === "wsl" ? winPathToWsl(im.path) : im.path;
      try {
        const raw = fs.readFileSync(im.path, "utf8");
        if (raw.length <= 65536) {
          attachedFileNotes.push(
            `[用户附带文件: ${im.name || path.basename(im.path)} | 本地路径: ${hostPath}]\n\`\`\`\n${raw}\n\`\`\``,
          );
        } else {
          attachedFileNotes.push(
            `[用户附带大型文本文件: ${im.name || path.basename(im.path)} (${Math.round(raw.length / 1024)} KB) | 完整路径: ${hostPath}]\n前 8KB 预览如下，如需完整内容请使用 Read 工具读取上述路径：\n\`\`\`\n${raw.slice(0, 8192)}\n\`\`\``,
          );
        }
      } catch {
        attachedFileNotes.push(`[用户附带文件: ${im.name || path.basename(im.path)} | 本地路径: ${hostPath}]`);
      }
    } else if (im.path || im.name) {
      const hostPath = im.path ? (rt.mode === "wsl" ? winPathToWsl(im.path) : im.path) : "";
      const sizeKb = im.size ? `${(im.size / 1024).toFixed(1)} KB` : "";
      attachedFileNotes.push(
        `[用户附带文件: ${im.name || "attachment"}${sizeKb ? ` (${sizeKb})` : ""} | 类型: ${im.media_type || "application/octet-stream"} | 本地路径: ${hostPath} — 请直接读取并分析该文件]`,
      );
    }
  }
  const finalUserText =
    memoryReminderPrefix +
    ([promptBody, ...attachedFileNotes].filter(Boolean).join("\n\n") || "请查看附带的文件或图片。");
  contentBlocks.push({ type: "text", text: finalUserText });

  appendTurnLog(
    sessionId,
    `=== NATIVE CLAUDE CODE (${rt.mode} ${rt.version}) req=${reqId} provider=${provider.name}(${provider.kind}) model=${model} resume=${resumeCliSid || "none"} fork=${forkSession} ===`,
  );

  return await new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(rt, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    const killProc = () => {
      killProcessTree(proc, "SIGINT", 1800);
    };
    if (signal) {
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }

    const stdinPayload = {
      type: "user",
      message: {
        role: "user",
        content: contentBlocks.length === 1 ? contentBlocks[0].text : contentBlocks,
      },
    };
    proc.stdin.write(JSON.stringify(stdinPayload) + "\n");
    proc.stdin.end();

    let buf = "";
    let stderr = "";
    let cliSessionId = resumeCliSid || "";
    const blocks = [];
    const blockByIdx = new Map();
    const toolById = new Map();
    let usage = {};
    let resultErrorText = "";

    proc.stderr?.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stderr += s;
      appendTurnLog(sessionId, `[claude-stderr] ${s.trim()}`);
    });

    const processStreamLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.session_id) cliSessionId = ev.session_id;

      if (ev.type === "stream_event") {
        const inner = ev.event || {};
        if (inner.type === "message_start") {
          blockByIdx.clear();
        } else if (inner.type === "content_block_start") {
          const cb = inner.content_block || {};
          let blk;
          if (cb.type === "thinking") blk = { type: "thinking", text: "" };
          else if (cb.type === "tool_use") {
            blk = {
              type: "tool_use",
              id: cb.id || `tu_${Date.now()}_${blocks.length}`,
              name: cb.name || "Tool",
              input: {},
              status: "running",
              is_error: false,
              result: null,
            };
            toolById.set(blk.id, blk);
          } else {
            blk = { type: "text", text: "" };
          }
          blocks.push(blk);
          blockByIdx.set(inner.index, blk);
          onEvent({ type: "step_blocks", blocks, usage });
        } else if (inner.type === "content_block_delta") {
          const blk = blockByIdx.get(inner.index);
          const d = inner.delta || {};
          if (blk && d.type === "text_delta" && d.text) {
            blk.text += d.text;
            onEvent({ type: "delta", kind: "text_delta", text: d.text });
          } else if (blk && d.type === "thinking_delta" && d.thinking) {
            blk.text += d.thinking;
            onEvent({ type: "delta", kind: "thinking_delta", text: d.thinking });
          }
        }
      } else if (ev.type === "assistant" && ev.message) {
        if (ev.message.usage) usage = ev.message.usage;
        for (const b of ev.message.content || []) {
          if (b.type === "tool_use" && b.id) {
            const ex = toolById.get(b.id);
            if (ex) {
              ex.input = b.input || ex.input;
            } else {
              const nb = {
                type: "tool_use",
                id: b.id,
                name: b.name || "Tool",
                input: b.input || {},
                status: "running",
                is_error: false,
                result: null,
              };
              toolById.set(b.id, nb);
              blocks.push(nb);
            }
          }
        }
        onEvent({ type: "step_blocks", blocks, usage });
      } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "tool_result" && b.tool_use_id && toolById.has(b.tool_use_id)) {
            const tu = toolById.get(b.tool_use_id);
            tu.result = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            tu.is_error = Boolean(b.is_error);
            tu.status = tu.is_error ? "error" : "done";
            onEvent({ type: "tool_result", tool_id: tu.id, result: tu.result, is_error: tu.is_error, blocks });
          }
        }
      } else if (ev.type === "result" && ev.is_error) {
        resultErrorText = String(ev.result || "Claude Code 返回错误");
      }
    };

    proc.stdout?.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const raw of lines) processStreamLine(raw);
    });

    proc.on("error", (err) => {
      cleanupTempPrompt();
      reject(
        classifyError({
          message: err.message,
          stderr,
          engine: "claude_native",
          providerName: provider.name,
          model,
          sessionId,
          reqId,
        }),
      );
    });

    proc.on("close", (code) => {
      if (buf.trim()) {
        processStreamLine(buf);
        buf = "";
      }
      cleanupTempPrompt();
      if (cliSessionId && injectedMemHash) {
        _lastSessionMemHash.set(cliSessionId, injectedMemHash);
      }
      try {
        // Keep SQLite memory library automatically in sync if Claude created/updated disk .md memories during this turn
        syncDiskMemoriesToDb({ force: true });
      } catch {}
      appendTurnLog(sessionId, `=== CLAUDE EXIT rc=${code} blocks=${blocks.length} cli_sid=${cliSessionId} ===`);
      if (signal?.aborted) {
        return resolve({
          blocks,
          content_text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim(),
          usage,
          model,
          engine: "claude_code",
          cli_session_id: cliSessionId,
        });
      }
      if ((code !== 0 || resultErrorText) && !blocks.some((b) => b.type === "text" && b.text.trim())) {
        return reject(
          classifyError({
            message: resultErrorText || `Claude Code 退出码 ${code}`,
            stderr,
            engine: "claude_native",
            providerName: provider.name,
            model,
            sessionId,
            reqId,
          }),
        );
      }
      resolve({
        blocks,
        content_text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim(),
        usage,
        model,
        engine: "claude_code",
        cli_session_id: cliSessionId,
      });
    });
  });
}
