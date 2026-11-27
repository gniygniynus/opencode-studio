/**
 * Lightweight, standards-compliant MCP (Model Context Protocol) JSON-RPC 2.0 over stdio client.
 * Manages installed MCP servers, discovers their tools, and dispatches tool calls live.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { listInstalledMcps } from "./db.mjs";
import { logEvent } from "./logger.mjs";
import { killProcessTree } from "./runtime_utils.mjs";

const MAX_MCP_STDOUT_BUF = 16 * 1024 * 1024;
const CMD_UNSAFE_ARG_RE = /[&|<>^%\r\n]/;

class StdioMcpConnection {
  constructor(config) {
    this.config = config;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.tools = [];
    this.status = "stopped"; // stopped | starting | ready | remote_ready | error
    this.lastError = "";
    this._startingPromise = null;
  }

  async start() {
    if (this.status === "ready" && this.proc) return;
    if (this.status === "starting" && this._startingPromise) {
      return await this._startingPromise;
    }

    this._startingPromise = this._doStart();
    try {
      await this._startingPromise;
    } finally {
      this._startingPromise = null;
    }
  }

  async _doStart() {
    this.stop();
    if (["http", "sse", "streamable-http"].includes(String(this.config.command || "").toLowerCase())) {
      this.status = "remote_ready";
      this.lastError = "";
      logEvent("INFO", "mcp", "remote_ready", `远程 MCP [${this.config.name}] 已挂载 (${this.config.args?.[0] || ""})`);
      return;
    }
    this.status = "starting";
    this.lastError = "";

    try {
      const isWin = process.platform === "win32";
      const rawCmd = String(this.config.command || "").trim();
      const useWinCmdShim = isWin && (["npx", "npm", "uvx"].includes(rawCmd) || /\.(cmd|bat)$/i.test(rawCmd));
      const cmd = isWin && ["npx", "npm", "uvx"].includes(rawCmd) ? `${rawCmd}.cmd` : rawCmd;
      const rawArgs = Array.isArray(this.config.args) ? this.config.args.map((a) => String(a)) : [];

      if (useWinCmdShim && rawArgs.some((a) => CMD_UNSAFE_ARG_RE.test(a))) {
        throw new Error("MCP 启动参数包含不安全的命令行控制字符，已拒绝执行");
      }

      const proc = spawn(cmd, rawArgs, {
        env: { ...process.env, ...(this.config.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: !isWin,
        shell: useWinCmdShim,
      });
      this.proc = proc;

      proc.stdin?.on("error", () => {});
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");

      proc.stdout.on("data", (chunk) => {
        if (this.proc !== proc) return;
        this._onStdout(outDecoder.write(chunk));
      });
      proc.stderr.on("data", (chunk) => {
        if (this.proc !== proc) return;
        const msg = errDecoder.write(chunk).trim();
        if (msg) logEvent("INFO", "mcp", "stderr", `[${this.config.name}] ${msg.slice(0, 300)}`);
      });
      proc.on("error", (err) => {
        if (this.proc !== proc) return;
        this.status = "error";
        this.lastError = err.message;
        this._rejectAll(err);
      });
      proc.on("close", (code) => {
        if (this.proc !== proc) return;
        if (this.status !== "stopped") {
          this.status = code === 0 ? "stopped" : "error";
          if (code !== 0) this.lastError = `进程退出 (code=${code})`;
        }
        this._rejectAll(new Error(`MCP server exited (${code})`));
        this.proc = null;
      });

      // Standard MCP handshake
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "OpenCode Studio", version: "2.3.0" },
      });
      this.notify("notifications/initialized", {});

      const listRes = await this.request("tools/list", {});
      this.tools = Array.isArray(listRes?.tools) ? listRes.tools : [];
      this.status = "ready";
      logEvent("INFO", "mcp", "ready", `MCP [${this.config.name}] 就绪，发现 ${this.tools.length} 个工具`);
    } catch (err) {
      this.status = "error";
      this.lastError = err.message;
      logEvent("WARN", "mcp", "start_failed", `MCP [${this.config.name}] 启动失败: ${err.message}`);
      this.stop(true);
    }
  }

  _onStdout(text) {
    this.buffer += text;
    if (this.buffer.length > MAX_MCP_STDOUT_BUF) {
      logEvent("WARN", "mcp", "buffer_overflow", `MCP [${this.config.name}] 输出行超过 16MB，已重置缓冲区`);
      this.buffer = "";
      return;
    }
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer, cleanupAbort } = this.pending.get(msg.id);
        clearTimeout(timer);
        cleanupAbort?.();
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = 20000, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new Error("MCP 请求已取消"));
      }
      if (!this.proc?.stdin?.writable) {
        return reject(new Error("MCP stdin 不可写"));
      }
      const id = this.nextId++;
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "User stopped turn" });
        reject(new Error("MCP 请求已由用户取消"));
      };
      const cleanupAbort = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        cleanupAbort();
        this.pending.delete(id);
        // Reset wedged child process so subsequent calls start fresh instead of hanging repeatedly
        this.lastError = `MCP 请求超时: ${method}`;
        this.stop(true);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, cleanupAbort });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      try {
        this.proc.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        cleanupAbort();
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {}
  }

  async callTool(toolName, args, signal = null) {
    if (this.status !== "ready") await this.start();
    if (this.status !== "ready") {
      return { ok: false, output: `MCP [${this.config.name}] 未就绪: ${this.lastError}` };
    }
    try {
      const res = await this.request("tools/call", { name: toolName, arguments: args || {} }, 45000, signal);
      const parts = Array.isArray(res?.content)
        ? res.content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
        : [JSON.stringify(res)];
      return { ok: !res?.isError, output: parts.join("\n") };
    } catch (err) {
      return { ok: false, output: `MCP 调用失败: ${err.message}` };
    }
  }

  _rejectAll(err) {
    for (const { reject, timer, cleanupAbort } of this.pending.values()) {
      clearTimeout(timer);
      cleanupAbort?.();
      reject(err);
    }
    this.pending.clear();
  }

  stop(keepError = false) {
    if (!keepError) this.status = "stopped";
    if (this.proc) {
      killProcessTree(this.proc);
      this.proc = null;
    }
  }
}

export class McpManager {
  constructor() {
    this.conns = new Map();
    this.toolRouteMap = new Map();
  }

  async syncFromDb() {
    const configs = listInstalledMcps();
    const enabledIds = new Set();
    for (const cfg of configs) {
      if (!cfg.enabled) continue;
      enabledIds.add(cfg.id);
      if (!this.conns.has(cfg.id)) {
        const conn = new StdioMcpConnection(cfg);
        this.conns.set(cfg.id, conn);
        conn.start().catch(() => {});
      }
    }
    for (const [id, conn] of this.conns.entries()) {
      if (!enabledIds.has(id)) {
        conn.stop();
        this.conns.delete(id);
      }
    }
  }

  async restartServer(id) {
    const cfg = listInstalledMcps().find((m) => m.id === id);
    if (this.conns.has(id)) {
      this.conns.get(id).stop();
      this.conns.delete(id);
    }
    if (cfg && cfg.enabled) {
      const conn = new StdioMcpConnection(cfg);
      this.conns.set(id, conn);
      await conn.start();
    }
    return this.getStatusList();
  }

  getStatusList() {
    return listInstalledMcps().map((cfg) => {
      const conn = this.conns.get(cfg.id);
      return {
        ...cfg,
        runtime_status: conn ? conn.status : cfg.enabled ? "idle" : "disabled",
        last_error: conn?.lastError || "",
        tools_count: conn?.tools?.length || 0,
        tools: (conn?.tools || []).map((t) => ({ name: t.name, description: t.description || "" })),
      };
    });
  }

  _buildSafeNamespace(conn) {
    const asciiBase = String(conn.config.name || "")
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 18);
    const idTail = String(conn.config.id || "").replace(/[^A-Za-z0-9]/g, "").slice(-5) || "srv";
    return asciiBase ? `${asciiBase}_${idTail}` : `mcp_${idTail}`;
  }

  getToolDefinitions() {
    const defs = [];
    this.toolRouteMap.clear();
    for (const [id, conn] of this.conns.entries()) {
      if (conn.status !== "ready") continue;
      const ns = this._buildSafeNamespace(conn);
      for (const t of conn.tools) {
        const fullToolName = `mcp__${ns}__${t.name}`;
        this.toolRouteMap.set(fullToolName, { conn, rawToolName: t.name });
        defs.push({
          name: fullToolName,
          description: `[MCP:${conn.config.name}] ${t.description || t.name}`,
          input_schema: t.inputSchema || { type: "object", properties: {} },
          _mcpId: id,
          _rawToolName: t.name,
        });
      }
    }
    return defs;
  }

  async callTool(namespacedName, args, signal = null) {
    if (!this.toolRouteMap.has(namespacedName)) {
      this.getToolDefinitions();
    }
    const route = this.toolRouteMap.get(namespacedName);
    if (route) {
      return await route.conn.callTool(route.rawToolName, args, signal);
    }
    // Backwards-compatible fallback prefix match
    for (const conn of this.conns.values()) {
      const legacyServer = String(conn.config.name || "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24);
      const prefix = `mcp__${legacyServer}__`;
      if (namespacedName.startsWith(prefix)) {
        return await conn.callTool(namespacedName.slice(prefix.length), args, signal);
      }
    }
    return { ok: false, output: `未找到对应的 MCP 工具: ${namespacedName}` };
  }

  stopAll() {
    for (const conn of this.conns.values()) conn.stop();
    this.conns.clear();
    this.toolRouteMap.clear();
  }
}
