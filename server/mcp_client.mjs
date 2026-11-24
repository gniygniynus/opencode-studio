/**
 * Lightweight, standards-compliant MCP (Model Context Protocol) JSON-RPC 2.0 over stdio client.
 * Manages installed MCP servers, discovers their tools, and dispatches tool calls live.
 */

import { spawn } from "node:child_process";
import { listInstalledMcps } from "./db.mjs";
import { logEvent } from "./logger.mjs";
import { killProcessTree } from "./runtime_utils.mjs";

class StdioMcpConnection {
  constructor(config) {
    this.config = config;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.tools = [];
    this.status = "stopped"; // stopped | starting | ready | error
    this.lastError = "";
  }

  async start() {
    if (this.status === "ready" && this.proc) return;
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
      const cmd = isWin && ["npx", "npm", "uvx"].includes(this.config.command)
        ? `${this.config.command}.cmd`
        : this.config.command;

      this.proc = spawn(cmd, this.config.args || [], {
        env: { ...process.env, ...(this.config.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: isWin && cmd.endsWith(".cmd"),
      });

      this.proc.stdout.on("data", (chunk) => this._onStdout(chunk.toString("utf8")));
      this.proc.stderr.on("data", (chunk) => {
        const msg = chunk.toString("utf8").trim();
        if (msg) logEvent("INFO", "mcp", "stderr", `[${this.config.name}] ${msg.slice(0, 300)}`);
      });
      this.proc.on("error", (err) => {
        this.status = "error";
        this.lastError = err.message;
        this._rejectAll(err);
      });
      this.proc.on("close", (code) => {
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
        clientInfo: { name: "OpenCode Studio", version: "1.0.0" },
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
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        return reject(new Error("MCP stdin 不可写"));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(toolName, args) {
    if (this.status !== "ready") await this.start();
    if (this.status !== "ready") {
      return { ok: false, output: `MCP [${this.config.name}] 未就绪: ${this.lastError}` };
    }
    try {
      const res = await this.request("tools/call", { name: toolName, arguments: args || {} }, 45000);
      const parts = Array.isArray(res?.content)
        ? res.content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
        : [JSON.stringify(res)];
      return { ok: !res?.isError, output: parts.join("\n") };
    } catch (err) {
      return { ok: false, output: `MCP 调用失败: ${err.message}` };
    }
  }

  _rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
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

  getToolDefinitions() {
    const defs = [];
    for (const [id, conn] of this.conns.entries()) {
      if (conn.status !== "ready") continue;
      const safeServer = conn.config.name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24);
      for (const t of conn.tools) {
        defs.push({
          name: `mcp__${safeServer}__${t.name}`,
          description: `[MCP:${conn.config.name}] ${t.description || t.name}`,
          input_schema: t.inputSchema || { type: "object", properties: {} },
          _mcpId: id,
          _rawToolName: t.name,
        });
      }
    }
    return defs;
  }

  async callTool(namespacedName, args) {
    for (const conn of this.conns.values()) {
      const safeServer = conn.config.name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24);
      const prefix = `mcp__${safeServer}__`;
      if (namespacedName.startsWith(prefix)) {
        const rawTool = namespacedName.slice(prefix.length);
        return await conn.callTool(rawTool, args);
      }
    }
    return { ok: false, output: `未找到对应的 MCP 工具: ${namespacedName}` };
  }

  stopAll() {
    for (const conn of this.conns.values()) conn.stop();
    this.conns.clear();
  }
}
