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

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAllSettings, listInstalledMcps, listInstalledSkills, listMemories } from "./db.mjs";
import { appendTurnLog, classifyError, logEvent } from "./logger.mjs";
import { detectModelCapabilities } from "./model_registry.mjs";
import { getPaths, PROJECT_ROOT } from "./paths.mjs";

let _cachedRuntime = null;
let _cachedAt = 0;

export function clearRuntimeCache() {
  _cachedRuntime = null;
  _cachedAt = 0;
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
 * Detect a genuinely working native Claude Code CLI:
 *  1. User-upgraded native binary (~/.local/bin/claude[.exe])
 *  2. Bundled official native binary shipped INSIDE OpenCode Studio installer (out-of-the-box!)
 *  3. System PATH / WSL2 fallback
 */
export function detectClaudeRuntime(force = false) {
  if (!force && _cachedRuntime && Date.now() - _cachedAt < 10_000) {
    return _cachedRuntime;
  }

  const bundledSet = new Set(getBundledClaudeCandidates().map((p) => path.resolve(p)));
  const candidates = [];

  if (process.platform === "win32") {
    candidates.push(path.join(os.homedir(), ".local", "bin", "claude.exe"));
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Programs", "claude", "claude.exe"));
    candidates.push(...getBundledClaudeCandidates());
    const w = spawnSync("where.exe", ["claude.exe"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (w.status === 0 && w.stdout) candidates.push(...w.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    const wc = spawnSync("where.exe", ["claude"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (wc.status === 0 && wc.stdout) candidates.push(...wc.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } else {
    candidates.push(path.join(os.homedir(), ".local", "bin", "claude"));
    candidates.push(...getBundledClaudeCandidates());
    const w = spawnSync("which", ["claude"], { encoding: "utf8", timeout: 3000 });
    if (w.status === 0 && w.stdout.trim()) candidates.push(w.stdout.trim());
  }

  let found = null;
  for (const c of [...new Set(candidates)]) {
    found = testNativeCandidate(c);
    if (found) {
      found.bundled = bundledSet.has(path.resolve(c));
      break;
    }
  }
  if (!found && process.platform === "win32") {
    found = testWslClaude();
  }

  _cachedRuntime = found || { mode: "missing", binary: null, isCmd: false, version: null, bundled: false };
  _cachedAt = Date.now();
  return _cachedRuntime;
}

function spawnClaudeProcess(rt, args, { cwd, env, stdio = ["pipe", "pipe", "pipe"] }) {
  if (rt.mode === "wsl") {
    const wslCwd = winPathToWsl(cwd || os.homedir());
    // Pass isolated env vars safely into WSL
    const envLines = [];
    for (const [k, v] of Object.entries(env || {})) {
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
  for (const [k, v] of Object.entries(env || {})) {
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
  if (rt.mode === "wsl") {
    const quoted = args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    const script = [
      "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY",
      `'${rt.binary.replace(/'/g, "'\\''")}' ${quoted}`,
    ].join("\n");
    return spawnSync("wsl.exe", wslScriptArgs(script), { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  }
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTHROPIC_BASE_URL;
  delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
  delete cleanEnv.ANTHROPIC_API_KEY;
  if (rt.isCmd) {
    return spawnSync("cmd.exe", ["/c", rt.binary, ...args], { encoding: "utf8", env: cleanEnv, timeout: timeoutMs, windowsHide: true });
  }
  return spawnSync(rt.binary, args, { encoding: "utf8", env: cleanEnv, timeout: timeoutMs, windowsHide: true });
}

/**
 * Full runtime + real `claude auth status` probe.
 */
export function getClaudeRuntimeAndAuth(force = false) {
  const rt = detectClaudeRuntime(force);
  if (rt.mode === "missing") {
    return {
      installed: false,
      mode: "missing",
      binary: null,
      version: null,
      auth: { loggedIn: false },
      note: "未检测到原生 Claude Code，可点击下方「一键安装稳定版 / 最新版」自动安装。",
    };
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

  return {
    installed: true,
    mode: rt.mode,
    bundled: Boolean(rt.bundled),
    binary: rt.binary,
    version: rt.version,
    auth,
    note: rt.bundled
      ? `已开箱启用随安装包内置的原生 Claude Code (${rt.version})，零配置即用。`
      : rt.mode === "wsl"
        ? `已接入本机 WSL2 原生 Claude Code (${rt.version})。`
        : `已接入本机原生 Claude Code (${rt.version})。`,
  };
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
    if (rt.mode === "wsl") {
      const pyArgs = JSON.stringify([rt.binary, ...args]);
      const pyScript = `python3 -u - <<'PY'
import os, pty, select, subprocess, sys
m, s = pty.openpty()
env = os.environ.copy()
for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
    env.pop(k, None)
env["DISABLE_TELEMETRY"] = "1"
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
  const runtime = getClaudeRuntimeAndAuth(true);
  const currentVer = parseSemverString(runtime.version);

  let stableVer = "";
  let latestVer = "";
  let source = "";
  let error = "";

  const fetchText = async (url, timeoutMs = 6000) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { "User-Agent": "OpenCodeStudio/1.1" }, signal: c.signal });
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
  const rt = detectClaudeRuntime(false);

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
  const rt = detectClaudeRuntime(true);

  logEvent("INFO", "claude_install", "start", `安装/切换原生 Claude Code -> ${target} (current=${rt.mode})`);
  onProgress?.(`正在准备安装/切换原生 Claude Code (${target})，将保留您的账号与配置…\n`);

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
  if (rt.mode !== "missing" && !(forceNativeWin && rt.mode === "wsl")) {
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
    cleanup = cleanupOldClaudeVersions(nextRt);
    if (cleanup.removed > 0) {
      onProgress?.(`\n[自动清理] 已保留现有配置完成迁移，并清理 ${cleanup.removed} 个旧版本二进制，释放约 ${cleanup.freed_mb} MB 空间。\n`);
    } else {
      onProgress?.("\n[迁移完成] 已保留原有账号与配置，无冗余旧版本残留。\n");
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

function buildCustomPromptAndMcp(cwd, rtMode) {
  const settings = getAllSettings();
  const base = String(settings.system_prompt || "").trim();
  const mode = settings.prompt_mode || "replace"; // replace | append | native

  const extraSections = [];
  const mems = listMemories({ cwd });
  const pinned = mems.filter((m) => m.pinned).slice(0, 8);
  if (pinned.length) {
    extraSections.push(
      "[用户置顶记忆]\n" + pinned.map((m) => `- ${m.title}: ${m.content.slice(0, 220).replace(/\s+/g, " ")}`).join("\n"),
    );
  }
  const skills = listInstalledSkills().filter((s) => s.enabled);
  if (skills.length) {
    extraSections.push(
      "[已启用的自定义 Skills]\n" +
        skills.slice(0, 8).map((s) => `## /${s.slug} (${s.name})\n${s.content.slice(0, 1800)}`).join("\n\n"),
    );
  }

  const combined = [base, ...extraSections].filter(Boolean).join("\n\n");

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

  // Materialize enabled installed MCPs (both local stdio AND remote http/sse!) into active_mcp_config.json
  const mcps = listInstalledMcps().filter((m) => m.enabled);
  let mcpConfigPath = null;
  if (mcps.length) {
    const mcpObj = { mcpServers: {} };
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

  return { promptMode: mode, promptText: combined, mcpConfigPath };
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
  const cap = detectModelCapabilities(model, provider.kind === "claude_native" ? "anthropic" : provider.kind, null, provider.model_overrides?.[model]);
  const { promptMode, promptText, mcpConfigPath } = buildCustomPromptAndMcp(cwd, rt.mode);

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
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${localServerPort}/proxy/provider/${provider.id}`;
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
    inlineSettingsEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${localServerPort}/proxy/provider/${provider.id}`;
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
  if (["low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
    args.push("--effort", thinkingLevel);
  }
  if (promptText) {
    if (promptMode === "replace") args.push("--system-prompt", promptText);
    else if (promptMode === "append") args.push("--append-system-prompt", promptText);
  }
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  const promptBody =
    resumeCliSid ? latestUser.content_text || "" : buildBridgeHistoryPrefix(historyItems) + (latestUser.content_text || "");

  const contentBlocks = [];
  for (const im of latestUser.images || []) {
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
  }
  contentBlocks.push({ type: "text", text: promptBody || "请查看图片。" });

  appendTurnLog(
    sessionId,
    `=== NATIVE CLAUDE CODE (${rt.mode} ${rt.version}) req=${reqId} provider=${provider.name}(${provider.kind}) model=${model} resume=${resumeCliSid || "none"} fork=${forkSession} ===`,
  );

  return await new Promise((resolve, reject) => {
    const proc = spawnClaudeProcess(rt, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    const killProc = () => {
      try {
        proc.kill("SIGINT");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 2000);
      } catch {}
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

    proc.stdout?.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
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
      }
    });

    proc.on("error", (err) => {
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
