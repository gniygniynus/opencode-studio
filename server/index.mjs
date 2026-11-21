#!/usr/bin/env node
/**
 * OpenCode Studio Local Singleton Server (HTTP + WebSocket).
 * Zero framework bloat: uses Node 24 native http + node:sqlite + ws.
 * Can run standalone (`npm start`) or embedded inside Electron (`electron/main.mjs`).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import {
  activateProvider,
  addCustomBackground,
  createSession,
  deleteCustomBackground,
  deleteInstalledMcp,
  deleteInstalledSkill,
  deleteMemory,
  deleteProvider,
  deleteSession,
  getActiveProvider,
  getAllSettings,
  getDb,
  getProvider,
  getSessionTimeline,
  listCustomBackgrounds,
  listInstalledMcps,
  listInstalledSkills,
  listMemories,
  listProviders,
  listSessions,
  saveInstalledMcp,
  saveInstalledSkill,
  saveMemory,
  saveProvider,
  setSetting,
  switchBranch,
  updateSessionMeta,
} from "./db.mjs";
import { probeClaudeNativeStatus } from "./engine_claude_cli.mjs";
import {
  buildAiDiagnosticBundle,
  classifyError,
  logEvent,
  newReqId,
  readTurnLog,
  tailLogs,
} from "./logger.mjs";
import { McpManager } from "./mcp_client.mjs";
import { enrichProviderForClient, fetchProviderModels } from "./model_registry.mjs";
import { SessionOrchestrator } from "./orchestrator.mjs";
import { getPaths, PUBLIC_DIR } from "./paths.mjs";
import {
  downloadRemoteSkillContent,
  searchMcpStore,
  searchSkillsStore,
  searchWallpaperStore,
} from "./stores.mjs";
import { checkForUpdates, getAppVersion } from "./updater.mjs";

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
  ".ico": "image/x-icon",
};

const ALLOWED_IMAGE_MIMES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
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

export async function startServer({ host = "127.0.0.1", port = Number(process.env.OPENCODE_PORT || 17620) } = {}) {
  const paths = getPaths();
  getDb(); // initialize SQLite WAL schema

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

  const orchestrator = new SessionOrchestrator({ broadcast, mcpManager });
  const appVersion = getAppVersion();

  const server = http.createServer(async (req, res) => {
    const reqId = newReqId();
    try {
      const urlObj = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = decodeURIComponent(urlObj.pathname);
      const method = (req.method || "GET").toUpperCase();

      // ==================== HEALTH & BOOTSTRAP ====================
      if (method === "GET" && pathname === "/api/health") {
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

      if (method === "GET" && pathname === "/api/bootstrap") {
        const providers = listProviders(false).map(enrichProviderForClient);
        return sendJson(res, 200, {
          version: appVersion,
          platform: process.platform,
          settings: getAllSettings(),
          providers,
          active_provider: providers.find((p) => p.is_active) || providers[0] || null,
          claude_native: probeClaudeNativeStatus(),
          installed_mcps: mcpManager.getStatusList(),
          installed_skills: listInstalledSkills(),
          custom_backgrounds: listCustomBackgrounds(),
          running_sessions: orchestrator.runningSessionIds(),
        });
      }

      // ==================== SETTINGS ====================
      if (method === "GET" && pathname === "/api/settings") {
        return sendJson(res, 200, getAllSettings());
      }
      if (method === "PUT" && pathname === "/api/settings") {
        const body = await readJsonBody(req);
        for (const key of ["system_prompt", "permission_mode", "update_channel", "appearance", "default_cwd"]) {
          if (body[key] !== undefined) setSetting(key, body[key]);
        }
        const next = getAllSettings();
        broadcast({ type: "settings_updated", settings: next });
        return sendJson(res, 200, { ok: true, settings: next });
      }

      // ==================== PROVIDERS & MODEL CAPABILITIES ====================
      if (method === "GET" && pathname === "/api/providers") {
        return sendJson(res, 200, {
          providers: listProviders(false).map(enrichProviderForClient),
          claude_native: probeClaudeNativeStatus(),
        });
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
        orchestrator.stopTurn(sid);
        deleteSession(sid);
        broadcast({ type: "session_deleted", session_id: sid });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/switch-branch$/)) {
        const sid = pathname.split("/")[3];
        const body = await readJsonBody(req);
        const timeline = switchBranch(sid, body.message_id);
        broadcast({ type: "timeline_updated", session_id: sid, timeline });
        return sendJson(res, 200, { ok: true, timeline });
      }

      // ==================== MEMORIES (CONCURRENCY-SAFE) ====================
      if (method === "GET" && pathname === "/api/memories") {
        const q = urlObj.searchParams.get("q") || "";
        const scope = urlObj.searchParams.get("scope") || "";
        const cwd = urlObj.searchParams.get("cwd") || "";
        return sendJson(res, 200, { memories: listMemories({ scope, cwd, query: q }) });
      }
      if (method === "POST" && pathname === "/api/memories") {
        const body = await readJsonBody(req);
        const saved = saveMemory(body);
        broadcast({ type: "memories_updated" });
        return sendJson(res, 200, { ok: true, memory: saved });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/memories\/([^/]+)$/)) {
        const id = pathname.split("/")[3];
        deleteMemory(id);
        broadcast({ type: "memories_updated" });
        return sendJson(res, 200, { ok: true });
      }

      // ==================== ONLINE OPEN-SOURCE STORES ====================
      if (method === "GET" && pathname === "/api/stores/mcp") {
        const q = urlObj.searchParams.get("q") || "";
        return sendJson(res, 200, await searchMcpStore(q));
      }
      if (method === "GET" && pathname === "/api/mcp") {
        return sendJson(res, 200, { items: mcpManager.getStatusList() });
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
        return sendJson(res, 200, await searchSkillsStore(q));
      }
      if (method === "GET" && pathname === "/api/skills") {
        return sendJson(res, 200, { items: listInstalledSkills() });
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
        return sendJson(res, 200, await searchWallpaperStore(q));
      }
      if (method === "GET" && pathname === "/api/wallpaper-proxy") {
        const rawUrl = urlObj.searchParams.get("url") || "";
        // Strict open-source allowlist: Wikimedia Commons only (prevents SSRF)
        if (!/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//i.test(rawUrl)) {
          return sendJson(res, 400, { error: "仅允许代理 Wikimedia Commons 开源图源" });
        }
        const hash = crypto.createHash("sha1").update(rawUrl).digest("hex");
        const cachePath = path.join(paths.backgroundsDir, `wm_cache_${hash}`);
        const metaPath = `${cachePath}.mime`;
        if (fs.existsSync(cachePath) && fs.existsSync(metaPath)) {
          const mime = fs.readFileSync(metaPath, "utf8").trim() || "image/jpeg";
          res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
          return fs.createReadStream(cachePath).pipe(res);
        }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          const upstream = await fetch(rawUrl, {
            headers: { "User-Agent": "OpenCodeStudio/1.0 (+https://github.com/gniygniynus/opencode-studio)" },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!upstream.ok) return sendJson(res, 502, { error: `上游图源 HTTP ${upstream.status}` });
          const mime = (upstream.headers.get("content-type") || "image/jpeg").split(";")[0];
          if (!mime.startsWith("image/")) return sendJson(res, 502, { error: "上游返回的不是图片" });
          const buf = Buffer.from(await upstream.arrayBuffer());
          fs.writeFileSync(cachePath, buf);
          fs.writeFileSync(metaPath, mime, "utf8");
          res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" });
          return res.end(buf);
        } catch (err) {
          return sendJson(res, 502, { error: `拉取壁纸失败: ${err.message}` });
        }
      }
      if (method === "POST" && pathname === "/api/backgrounds/upload") {
        const body = await readJsonBody(req);
        const mediaType = String(body.media_type || "image/png").toLowerCase();
        const ext = ALLOWED_IMAGE_MIMES[mediaType];
        if (!ext) return sendJson(res, 400, { ok: false, error: `不支持的图片类型: ${mediaType}` });
        const b64 = String(body.data || "").replace(/^data:[^,]+,/, "");
        const buf = Buffer.from(b64, "base64");
        if (buf.length > 18 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: "背景图不能超过 18MB" });
        const fileName = `bg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
        fs.writeFileSync(path.join(paths.backgroundsDir, fileName), buf);
        const bg = addCustomBackground({
          name: String(body.name || "自定义背景").slice(0, 60),
          url: `/api/bg-files/${fileName}`,
          source: "upload",
        });
        return sendJson(res, 200, { ok: true, background: bg, backgrounds: listCustomBackgrounds() });
      }
      if (method === "DELETE" && pathname.match(/^\/api\/backgrounds\/([^/]+)$/)) {
        const id = pathname.split("/")[3];
        deleteCustomBackground(id);
        return sendJson(res, 200, { ok: true, backgrounds: listCustomBackgrounds() });
      }
      if (method === "GET" && pathname.startsWith("/api/bg-files/")) {
        const fname = path.basename(pathname.slice("/api/bg-files/".length));
        const fp = path.join(paths.backgroundsDir, fname);
        if (!fs.existsSync(fp)) return sendJson(res, 404, { error: "not found" });
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "public, max-age=31536000" });
        return fs.createReadStream(fp).pipe(res);
      }

      // ==================== CHAT IMAGE UPLOADS ====================
      if (method === "POST" && pathname === "/api/upload") {
        const body = await readJsonBody(req);
        const mediaType = String(body.media_type || "image/png").toLowerCase();
        const ext = ALLOWED_IMAGE_MIMES[mediaType];
        if (!ext) return sendJson(res, 400, { ok: false, error: `不支持的图片类型: ${mediaType}` });
        const b64 = String(body.data || "").replace(/^data:[^,]+,/, "");
        const buf = Buffer.from(b64, "base64");
        if (buf.length > 15 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: "图片不能超过 15MB" });
        const fname = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
        const dest = path.join(paths.uploadsDir, fname);
        fs.writeFileSync(dest, buf);
        return sendJson(res, 200, {
          ok: true,
          id: fname,
          name: body.name || fname,
          media_type: mediaType,
          size: buf.length,
          path: dest,
          url: `/api/uploads/${fname}`,
        });
      }
      if (method === "GET" && pathname.startsWith("/api/uploads/")) {
        const fname = path.basename(pathname.slice("/api/uploads/".length));
        const fp = path.join(paths.uploadsDir, fname);
        if (!fs.existsSync(fp)) return sendJson(res, 404, { error: "not found" });
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        return fs.createReadStream(fp).pipe(res);
      }

      // ==================== WORKDIR & FILES ====================
      if (method === "GET" && pathname === "/api/dirs") {
        const target = urlObj.searchParams.get("path") || "";
        return sendJson(res, 200, listDirectorySafe(target));
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

      // ==================== STATIC FRONTEND ====================
      if (method === "GET") {
        const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const fp = path.join(PUBLIC_DIR, rel);
        if (fp.startsWith(PUBLIC_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          const ext = path.extname(fp).toLowerCase();
          res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
          return fs.createReadStream(fp).pipe(res);
        }
      }

      sendJson(res, 404, { ok: false, error: `Not Found: ${pathname}` });
    } catch (err) {
      const code = err.code === "ERR_MEMORY_CONFLICT" ? 409 : 500;
      logEvent("ERROR", "http", "unhandled", `${req.method} ${req.url}: ${err.message}`, { reqId, layer: "web-server" });
      sendJson(res, code, {
        ok: false,
        error: classifyError({ message: err.message, reqId, codeHint: err.code || "ERR_HTTP" }),
      });
    }
  });

  // ==================== WEBSOCKET MULTIPLEXER ====================
  const wss = new WebSocketServer({ server, path: "/ws" });
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
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (msg.type === "send_message") {
        await orchestrator.sendMessage({
          sessionId: msg.session_id || "",
          text: msg.text || "",
          images: msg.images || [],
          cwd: msg.cwd || "",
          providerId: msg.provider_id || "",
          model: msg.model || "",
          thinkingLevel: msg.thinking_level || "auto",
        });
      } else if (msg.type === "edit_resend") {
        await orchestrator.editAndResend({
          sessionId: msg.session_id,
          messageId: msg.message_id,
          newText: msg.new_text,
          images: msg.images ?? null,
          providerId: msg.provider_id || "",
          model: msg.model || "",
          thinkingLevel: msg.thinking_level || "",
        });
      } else if (msg.type === "stop_turn") {
        orchestrator.stopTurn(msg.session_id);
      } else if (msg.type === "confirm_response") {
        orchestrator.resolveConfirm(msg.confirm_id, Boolean(msg.approved));
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
  const url = `http://${host}:${actualPort}`;
  logEvent("INFO", "server", "started", `OpenCode Studio v${appVersion} 启动于 ${url} (data=${paths.dataRoot})`);

  return {
    server,
    wss,
    url,
    port: actualPort,
    mcpManager,
    orchestrator,
    async stop() {
      mcpManager.stopAll();
      for (const ws of wsClients) {
        try {
          ws.close();
        } catch {}
      }
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// Run directly when executed via `node server/index.mjs`
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  startServer()
    .then(({ url }) => {
      console.log(`[OpenCode Studio] Listening on ${url}`);
    })
    .catch((err) => {
      console.error("[OpenCode Studio] Failed to start:", err);
      process.exit(1);
    });
}
