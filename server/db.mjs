/**
 * Unified SQLite (WAL) storage layer using Node's built-in node:sqlite (zero native compilation!).
 *
 * Guarantees:
 *  - Safe multi-window concurrency via WAL mode + busy_timeout + versioned memory writes.
 *  - Tree-structured messages supporting Edit & Resend with non-destructive branch switching.
 *  - Local AES-256-GCM encryption for stored API keys (never exported or sent to frontend).
 *  - Single source of truth shared by both OpenCode Native API Engine & Claude Official Login Adapter.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getPaths } from "./paths.mjs";
import { logEvent, nowIso } from "./logger.mjs";

let _db = null;
let _secretKey = null;

export const DEFAULT_SYSTEM_PROMPT = `你是 OpenCode Studio 内置的开源透明 AI 编程与效率助手。
核心工作原则：
1. 默认使用简体中文与用户清晰交流，结论先行、简洁精准。
2. 修改文件或执行有副作用的命令前，先查看现状，做到精准最小改动。
3. 善用工具读取文件、编辑代码、搜索项目和运行验证命令，不要凭空臆测文件内容或运行结果。
4. 如遇报错，清晰说明根因、影响范围和下一步修复方案。`;

export const DEFAULT_APPEARANCE = {
  theme: "light",           // light | dark
  fontFamily: "system",
  fontSize: 14.5,
  lineHeight: 1.72,
  bgType: "none",           // none | gradient | image | live | video | upload
  bgMode: "subtle",         // hd (高清原版清晰呈现) | subtle (隐性护眼柔和氛围)
  bgUrl: "",
  liveBg: "",               // live-aurora | live-starfield | live-sakura | ...
  bgBlur: 10,
  bgOpacity: 0.88,          // legacy / card opacity alias
  bubbleStyle: "card",      // card (有边框卡片) | text (纯文字无边框)
  bubbleOpacity: 0.88,      // 0.00 ~ 1.00 对话框独立透明度
  sidebarOpacity: 0.82,     // 0.00 ~ 0.98 两侧栏与顶栏独立透明度
  bgName: "",
};

export const DEFAULT_SEARCH_ENGINE = {
  mode: "auto",             // auto (自动探测) | cn (国内直连引擎) | proxy (代理全网引擎)
  proxy_url: "",            // 可选代理地址，如 http://127.0.0.1:7897
};

export const DEFAULT_WALLPAPER_ENGINE = {
  authorized: false,        // 必须用户显式授权后才读取 Steam 431960 config.json 与原文件目录
  dirs: [],                 // 已授权的绝对目录列表（零拷贝只读流式播放）
  auto_sync: true,          // 自动实时识别并同步用户在 Wallpaper Engine 中选择的壁纸
  passthrough: false,       // Electron 桌面版原生无损透视 Wallpaper Engine 模式（100% 4K 60fps 0 损耗 0 处理）
  video_muted: true,        // 视频壁纸默认静音循环，可随时手动开关声音
};

function getLocalKey() {
  if (_secretKey) return _secretKey;
  const p = getPaths();
  if (fs.existsSync(p.secretFile)) {
    const raw = fs.readFileSync(p.secretFile, "utf8").trim();
    if (raw.length === 64) {
      _secretKey = Buffer.from(raw, "hex");
      return _secretKey;
    }
  }
  _secretKey = crypto.randomBytes(32);
  fs.writeFileSync(p.secretFile, _secretKey.toString("hex"), { mode: 0o600 });
  return _secretKey;
}

export function encryptSecret(plain) {
  if (!plain) return "";
  const key = getLocalKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(stored) {
  if (!stored) return "";
  if (!stored.startsWith("v1:")) return stored;
  try {
    const [, ivHex, tagHex, encHex] = stored.split(":");
    const key = getLocalKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function maskSecret(plain) {
  if (!plain) return "";
  if (plain.length <= 8) return "****";
  return `${plain.slice(0, 4)}••••${plain.slice(-4)}`;
}

export function getDb() {
  if (_db) return _db;
  const p = getPaths();
  const db = new DatabaseSync(p.dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS kv_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      api_key_enc TEXT NOT NULL DEFAULT '',
      default_model TEXT NOT NULL DEFAULT '',
      models_json TEXT NOT NULL DEFAULT '[]',
      model_overrides_json TEXT NOT NULL DEFAULT '{}',
      extra_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      thinking_level TEXT NOT NULL DEFAULT 'auto',
      claude_cli_sid TEXT NOT NULL DEFAULT '',
      compact_count INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL,
      content_text TEXT NOT NULL DEFAULT '',
      blocks_json TEXT NOT NULL DEFAULT '[]',
      images_json TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL DEFAULT '',
      provider_name TEXT NOT NULL DEFAULT '',
      engine TEXT NOT NULL DEFAULT 'api',
      usage_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_sess ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(session_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'global',
      cwd TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installed_mcps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS installed_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_backgrounds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'upload',
      created_at TEXT NOT NULL
    );
  `);

  _db = db;
  seedInitialData(db);
  return _db;
}

export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {}
    _db = null;
  }
}

function seedInitialData(db) {
  const now = nowIso();
  const ensureKv = (key, val) => {
    const existing = db.prepare("SELECT key FROM kv_settings WHERE key=?").get(key);
    if (!existing) {
      db.prepare("INSERT INTO kv_settings (key, value, updated_at) VALUES (?, ?, ?)").run(
        key,
        typeof val === "string" ? val : JSON.stringify(val),
        now,
      );
    }
  };

  ensureKv("system_prompt", DEFAULT_SYSTEM_PROMPT);
  ensureKv("prompt_mode", "replace"); // replace | append | native
  ensureKv("permission_mode", "auto"); // auto | confirm_dangerous
  ensureKv("claude_isolation", "isolated"); // isolated (零冲突独立目录) | shared (共享系统 ~/.claude)
  ensureKv("update_channel", "stable"); // stable | latest
  ensureKv("appearance", DEFAULT_APPEARANCE);
  ensureKv("search_engine", DEFAULT_SEARCH_ENGINE);
  ensureKv("wallpaper_engine", DEFAULT_WALLPAPER_ENGINE);
  ensureKv("default_cwd", getPaths().defaultCwd);

  // Ensure the optional "Claude 原生登录" provider entry exists out of the box (inactive until chosen)
  const nativeExists = db.prepare("SELECT id FROM providers WHERE kind='claude_native'").get();
  if (!nativeExists) {
    db.prepare(
      `INSERT INTO providers (id, name, kind, base_url, api_key_enc, default_model, models_json, is_active, created_at, updated_at)
       VALUES (?, ?, 'claude_native', '', '', 'sonnet', ?, 0, ?, ?)`,
    ).run(
      "claude-native-oauth",
      "Claude 原生订阅登录 (本地 CLI)",
      JSON.stringify(["sonnet", "opus", "haiku"]),
      now,
      now,
    );
  }
}

// ==================== KV SETTINGS ====================

export function getSetting(key, fallback = null) {
  const db = getDb();
  const row = db.prepare("SELECT value FROM kv_settings WHERE key=?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  const db = getDb();
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  db.prepare(
    `INSERT INTO kv_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, serialized, nowIso());
  return value;
}

export function getAllSettings() {
  return {
    system_prompt: getSetting("system_prompt", DEFAULT_SYSTEM_PROMPT),
    prompt_mode: getSetting("prompt_mode", "replace"),
    permission_mode: getSetting("permission_mode", "auto"),
    claude_isolation: getSetting("claude_isolation", "isolated"),
    update_channel: getSetting("update_channel", "stable"),
    appearance: { ...DEFAULT_APPEARANCE, ...(getSetting("appearance", DEFAULT_APPEARANCE) || {}) },
    search_engine: { ...DEFAULT_SEARCH_ENGINE, ...(getSetting("search_engine", DEFAULT_SEARCH_ENGINE) || {}) },
    wallpaper_engine: { ...DEFAULT_WALLPAPER_ENGINE, ...(getSetting("wallpaper_engine", DEFAULT_WALLPAPER_ENGINE) || {}) },
    default_cwd: getSetting("default_cwd", getPaths().defaultCwd),
  };
}

// ==================== PROVIDERS ====================

function rowToProvider(row, includeSecret = false) {
  if (!row) return null;
  const plainKey = decryptSecret(row.api_key_enc);
  const obj = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    base_url: row.base_url,
    has_api_key: Boolean(plainKey),
    api_key_masked: maskSecret(plainKey),
    default_model: row.default_model,
    models: safeJsonParse(row.models_json, []),
    model_overrides: safeJsonParse(row.model_overrides_json, {}),
    extra: safeJsonParse(row.extra_json, {}),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includeSecret) obj.api_key = plainKey;
  return obj;
}

export function listProviders(includeSecret = false) {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM providers ORDER BY is_active DESC, created_at ASC").all();
  return rows.map((r) => rowToProvider(r, includeSecret));
}

export function getProvider(id, includeSecret = false) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM providers WHERE id=?").get(id);
  return rowToProvider(row, includeSecret);
}

export function getActiveProvider(includeSecret = false) {
  const db = getDb();
  let row = db.prepare("SELECT * FROM providers WHERE is_active=1 LIMIT 1").get();
  if (!row) {
    row = db.prepare("SELECT * FROM providers ORDER BY created_at ASC LIMIT 1").get();
  }
  return rowToProvider(row, includeSecret);
}

export function saveProvider(input) {
  const db = getDb();
  const now = nowIso();
  const id = input.id || `prov_${crypto.randomBytes(6).toString("hex")}`;
  const existing = db.prepare("SELECT * FROM providers WHERE id=?").get(id);

  const name = String(input.name || "未命名供应商").trim();
  const kind = ["anthropic", "openai", "claude_native"].includes(input.kind) ? input.kind : "openai";
  const baseUrl = String(input.base_url || "").trim().replace(/\/+$/, "");
  const apiKeyEnc =
    input.api_key !== undefined && input.api_key !== ""
      ? encryptSecret(String(input.api_key).trim())
      : existing
        ? existing.api_key_enc
        : "";
  const models = Array.isArray(input.models)
    ? [...new Set(input.models.map((m) => String(m).trim()).filter(Boolean))]
    : existing
      ? safeJsonParse(existing.models_json, [])
      : [];
  const defaultModel = String(input.default_model || models[0] || existing?.default_model || "").trim();
  const overrides = input.model_overrides ?? (existing ? safeJsonParse(existing.model_overrides_json, {}) : {});
  const extra = input.extra ?? (existing ? safeJsonParse(existing.extra_json, {}) : {});

  const shouldActivate =
    input.is_active === true ||
    (!existing && db.prepare("SELECT COUNT(*) AS c FROM providers WHERE is_active=1").get().c === 0);

  if (shouldActivate) {
    db.prepare("UPDATE providers SET is_active=0").run();
  }

  if (existing) {
    db.prepare(
      `UPDATE providers SET name=?, kind=?, base_url=?, api_key_enc=?, default_model=?,
       models_json=?, model_overrides_json=?, extra_json=?, is_active=?, updated_at=? WHERE id=?`,
    ).run(
      name,
      kind,
      baseUrl,
      apiKeyEnc,
      defaultModel,
      JSON.stringify(models),
      JSON.stringify(overrides),
      JSON.stringify(extra),
      shouldActivate ? 1 : existing.is_active,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO providers (id, name, kind, base_url, api_key_enc, default_model, models_json, model_overrides_json, extra_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      kind,
      baseUrl,
      apiKeyEnc,
      defaultModel,
      JSON.stringify(models),
      JSON.stringify(overrides),
      JSON.stringify(extra),
      shouldActivate ? 1 : 0,
      now,
      now,
    );
  }
  logEvent("INFO", "providers", "saved", `保存供应商 ${name} (${kind}), 模型数=${models.length}`);
  return getProvider(id, false);
}

export function activateProvider(id, model = "") {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM providers WHERE id=?").get(id);
  if (!existing) throw new Error("供应商不存在");
  db.prepare("UPDATE providers SET is_active=0").run();
  if (model && model.trim()) {
    db.prepare("UPDATE providers SET is_active=1, default_model=?, updated_at=? WHERE id=?").run(
      model.trim(),
      nowIso(),
      id,
    );
  } else {
    db.prepare("UPDATE providers SET is_active=1, updated_at=? WHERE id=?").run(nowIso(), id);
  }
  logEvent("INFO", "providers", "activated", `切换当前供应商 -> ${existing.name}${model ? " / " + model : ""}`);
  return getProvider(id, false);
}

export function deleteProvider(id) {
  const db = getDb();
  if (id === "claude-native-oauth") {
    throw new Error("内置「Claude 原生订阅登录」模板不可删除");
  }
  const row = db.prepare("SELECT * FROM providers WHERE id=?").get(id);
  if (!row) return false;
  db.prepare("DELETE FROM providers WHERE id=?").run(id);
  if (row.is_active) {
    const first = db.prepare("SELECT id FROM providers ORDER BY created_at ASC LIMIT 1").get();
    if (first) db.prepare("UPDATE providers SET is_active=1 WHERE id=?").run(first.id);
  }
  logEvent("INFO", "providers", "deleted", `删除供应商 ${row.name}`);
  return true;
}

// ==================== SESSIONS & BRANCHING MESSAGE TREE ====================

export function createSession({ title = "新会话", cwd = "", providerId = "", model = "", thinkingLevel = "auto" } = {}) {
  const db = getDb();
  const now = nowIso();
  const id = crypto.randomUUID();
  const activeProv = providerId ? getProvider(providerId) : getActiveProvider();
  const finalCwd = cwd || getSetting("default_cwd", getPaths().defaultCwd);
  db.prepare(
    `INSERT INTO sessions (id, title, cwd, provider_id, model, thinking_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title,
    finalCwd,
    activeProv?.id || "",
    model || activeProv?.default_model || "",
    thinkingLevel || "auto",
    now,
    now,
  );
  return getSessionMeta(id);
}

export function getSessionMeta(id) {
  const db = getDb();
  return db.prepare("SELECT * FROM sessions WHERE id=?").get(id) || null;
}

export function updateSessionMeta(id, patch) {
  const db = getDb();
  const allowed = ["title", "cwd", "provider_id", "model", "thinking_level", "claude_cli_sid", "compact_count", "archived"];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k}=?`);
      vals.push(patch[k]);
    }
  }
  if (!sets.length) return getSessionMeta(id);
  sets.push("updated_at=?");
  vals.push(nowIso(), id);
  db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  return getSessionMeta(id);
}

export function deleteSession(id) {
  const db = getDb();
  db.prepare("UPDATE sessions SET archived=1, updated_at=? WHERE id=?").run(nowIso(), id);
  return true;
}

export function listSessions({ query = "", cwd = "", limit = 200 } = {}) {
  const db = getDb();
  const q = String(query || "").trim();
  const cwdFilter = String(cwd || "").trim();

  const cwds = db
    .prepare("SELECT cwd, COUNT(*) AS count FROM sessions WHERE archived=0 GROUP BY cwd ORDER BY count DESC")
    .all();

  if (!q) {
    let sql = `
      SELECT s.*,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
      FROM sessions s
      WHERE s.archived=0
    `;
    const params = [];
    if (cwdFilter) {
      sql += " AND s.cwd=?";
      params.push(cwdFilter);
    }
    sql += " ORDER BY s.updated_at DESC LIMIT ?";
    params.push(limit);
    return { sessions: db.prepare(sql).all(...params), cwds };
  }

  const qlc = q.toLowerCase();
  let sql = `
    SELECT s.*,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
    FROM sessions s
    WHERE s.archived=0
      AND (
        instr(lower(s.title), ?) > 0
        OR EXISTS (
          SELECT 1 FROM messages m
          WHERE m.session_id=s.id AND m.is_active=1 AND instr(lower(m.content_text), ?) > 0
        )
      )
  `;
  const params = [qlc, qlc];
  if (cwdFilter) {
    sql += " AND s.cwd=?";
    params.push(cwdFilter);
  }
  sql += " ORDER BY s.updated_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  for (const s of rows) {
    const hit = db
      .prepare(
        `SELECT id, role, content_text FROM messages
         WHERE session_id=? AND is_active=1 AND instr(lower(content_text), ?) > 0
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(s.id, qlc);
    if (hit) {
      const idx = hit.content_text.toLowerCase().indexOf(qlc);
      const start = Math.max(0, idx - 32);
      const end = Math.min(hit.content_text.length, idx + q.length + 52);
      s.match_snippet =
        (start > 0 ? "…" : "") + hit.content_text.slice(start, end).replace(/\s+/g, " ") + (end < hit.content_text.length ? "…" : "");
      s.match_message_id = hit.id;
    }
  }
  return { sessions: rows, cwds };
}

/**
 * Append a message under parentId. If sibling branches exist at this parentId,
 * automatically deactivate sibling subtrees so the newly added branch is active.
 */
export function addMessage({
  sessionId,
  parentId = null,
  role,
  contentText = "",
  blocks = [],
  images = [],
  model = "",
  providerName = "",
  engine = "api",
  usage = {},
}) {
  const db = getDb();
  const id = `msg_${crypto.randomBytes(8).toString("hex")}`;
  const now = nowIso();

  // Deactivate any active siblings sharing the same parent_id
  const siblings = parentId
    ? db.prepare("SELECT id FROM messages WHERE session_id=? AND parent_id=? AND is_active=1").all(sessionId, parentId)
    : db.prepare("SELECT id FROM messages WHERE session_id=? AND parent_id IS NULL AND is_active=1").all(sessionId);

  for (const sib of siblings) {
    setSubtreeActive(db, sessionId, sib.id, 0);
  }

  db.prepare(
    `INSERT INTO messages (id, session_id, parent_id, is_active, role, content_text, blocks_json, images_json, model, provider_name, engine, usage_json, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    parentId,
    role,
    contentText,
    JSON.stringify(blocks || []),
    JSON.stringify(images || []),
    model,
    providerName,
    engine,
    JSON.stringify(usage || {}),
    now,
  );

  db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
  return getMessageById(id);
}

export function getMessageById(id) {
  const db = getDb();
  const r = db.prepare("SELECT * FROM messages WHERE id=?").get(id);
  if (!r) return null;
  return {
    ...r,
    is_active: Boolean(r.is_active),
    blocks: safeJsonParse(r.blocks_json, []),
    images: safeJsonParse(r.images_json, []),
    usage: safeJsonParse(r.usage_json, {}),
  };
}

function setSubtreeActive(db, sessionId, rootId, activeVal) {
  const queue = [rootId];
  const stmtChildren = db.prepare("SELECT id FROM messages WHERE session_id=? AND parent_id=?");
  const stmtUpdate = db.prepare("UPDATE messages SET is_active=? WHERE id=?");
  while (queue.length) {
    const cur = queue.shift();
    stmtUpdate.run(activeVal, cur);
    const children = stmtChildren.all(sessionId, cur);
    for (const c of children) queue.push(c.id);
  }
}

/**
 * Switch to an alternative branch sibling at a given message node,
 * reactivating the latest path inside that branch cleanly.
 */
export function switchBranch(sessionId, targetMessageId) {
  const db = getDb();
  const target = db.prepare("SELECT * FROM messages WHERE id=? AND session_id=?").get(targetMessageId, sessionId);
  if (!target) throw new Error("目标分支消息不存在");

  const siblings = target.parent_id
    ? db.prepare("SELECT id FROM messages WHERE session_id=? AND parent_id=?").all(sessionId, target.parent_id)
    : db.prepare("SELECT id FROM messages WHERE session_id=? AND parent_id IS NULL").all(sessionId);

  for (const sib of siblings) {
    setSubtreeActive(db, sessionId, sib.id, 0);
  }

  // Walk down from target activating the most recently created child at each hop
  let curId = targetMessageId;
  const stmtUpdate = db.prepare("UPDATE messages SET is_active=1 WHERE id=?");
  const stmtNext = db.prepare(
    "SELECT id FROM messages WHERE session_id=? AND parent_id=? ORDER BY created_at DESC LIMIT 1",
  );
  while (curId) {
    stmtUpdate.run(curId);
    const next = stmtNext.get(sessionId, curId);
    curId = next ? next.id : null;
  }

  db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(nowIso(), sessionId);
  return getSessionTimeline(sessionId);
}

/**
 * Reconstruct the active linear timeline for a session, annotated with sibling branch info
 * (e.g. branch_index: 2, branch_total: 2, sibling_ids: [...]) so the UI can show ◀ 2/2 ▶.
 */
export function getSessionTimeline(sessionId) {
  const db = getDb();
  const meta = getSessionMeta(sessionId);
  if (!meta) return null;

  const allRows = db
    .prepare("SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC")
    .all(sessionId);

  // Group siblings by parent_id
  const siblingsByParent = new Map();
  for (const r of allRows) {
    const pk = r.parent_id || "__ROOT__";
    if (!siblingsByParent.has(pk)) siblingsByParent.set(pk, []);
    siblingsByParent.get(pk).push(r);
  }

  // Active chain ordered cleanly from root
  const activeRows = allRows.filter((r) => r.is_active === 1);
  const items = [];
  const outline = [];
  const editedFiles = new Map();
  const readFiles = new Set();
  let bashCount = 0;
  let totalToolCalls = 0;
  let latestUsage = {};
  let userTurn = 0;
  let segment = 0;

  for (const r of activeRows) {
    const pk = r.parent_id || "__ROOT__";
    const sibs = siblingsByParent.get(pk) || [r];
    const branchIndex = sibs.findIndex((x) => x.id === r.id) + 1;
    const siblingIds = sibs.map((x) => x.id);

    const blocks = safeJsonParse(r.blocks_json, []);
    const images = safeJsonParse(r.images_json, []);
    const usage = safeJsonParse(r.usage_json, {});

    if (r.role === "compact") {
      segment += 1;
    } else if (r.role === "user") {
      userTurn += 1;
      outline.push({
        message_id: r.id,
        turn_index: userTurn,
        segment,
        timestamp: r.created_at,
        preview: (r.content_text || (images.length ? `[图片 × ${images.length}]` : "")).replace(/\s+/g, " ").slice(0, 90),
        has_images: images.length > 0,
      });
    } else if (r.role === "assistant") {
      if (usage && (usage.input_tokens || usage.prompt_tokens)) {
        latestUsage = usage;
      }
      for (const b of blocks) {
        if (b.type === "tool_use") {
          totalToolCalls += 1;
          const fp = b.input?.file_path || b.input?.path || "";
          if (["edit_file", "write_file", "Edit", "Write"].includes(b.name) && fp) {
            editedFiles.set(fp, (editedFiles.get(fp) || 0) + 1);
          } else if (["read_file", "Read"].includes(b.name) && fp) {
            readFiles.add(fp);
          } else if (["run_shell", "Bash"].includes(b.name)) {
            bashCount += 1;
          }
        }
      }
    }

    items.push({
      id: r.id,
      parent_id: r.parent_id,
      role: r.role,
      turn_index: r.role === "user" ? userTurn : null,
      segment,
      content_text: r.content_text,
      blocks,
      images,
      model: r.model,
      provider_name: r.provider_name,
      engine: r.engine,
      usage,
      created_at: r.created_at,
      branch_index: branchIndex,
      branch_total: sibs.length,
      sibling_ids: siblingIds,
    });
  }

  const contextTokens =
    (latestUsage.input_tokens || latestUsage.prompt_tokens || 0) +
    (latestUsage.cache_read_input_tokens || 0) +
    (latestUsage.cache_creation_input_tokens || 0);

  return {
    session: meta,
    items,
    outline,
    last_message_id: items.length ? items[items.length - 1].id : null,
    activity: {
      edited_files: [...editedFiles.entries()].map(([p, c]) => ({ path: p, edits: c })),
      read_files_count: readFiles.size,
      bash_count: bashCount,
      total_tool_calls: totalToolCalls,
      context_tokens: contextTokens,
      latest_usage: latestUsage,
    },
  };
}

// ==================== MEMORIES (CONCURRENCY-SAFE VERSIONED) ====================

export function listMemories({ scope = "", cwd = "", query = "" } = {}) {
  const db = getDb();
  let sql = "SELECT * FROM memories WHERE 1=1";
  const params = [];
  if (scope) {
    sql += " AND scope=?";
    params.push(scope);
  }
  if (cwd) {
    sql += " AND (scope='global' OR cwd=?)";
    params.push(cwd);
  }
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    sql += " AND (instr(lower(title), ?) > 0 OR instr(lower(content), ?) > 0 OR instr(lower(category), ?) > 0)";
    params.push(q, q, q);
  }
  sql += " ORDER BY pinned DESC, updated_at DESC";
  return db.prepare(sql).all(...params).map((r) => ({ ...r, pinned: Boolean(r.pinned) }));
}

export function saveMemory(input) {
  const db = getDb();
  const now = nowIso();
  const id = input.id || `mem_${crypto.randomBytes(6).toString("hex")}`;
  const existing = db.prepare("SELECT * FROM memories WHERE id=?").get(id);

  // Optimistic concurrency check so two windows never silently overwrite each other
  if (existing && input.expected_version !== undefined && Number(input.expected_version) !== existing.version) {
    const err = new Error("该记忆刚被另一窗口修改，请刷新后重试（已防止覆盖冲突）");
    err.code = "ERR_MEMORY_CONFLICT";
    throw err;
  }

  const scope = input.scope === "project" ? "project" : "global";
  const cwd = scope === "project" ? String(input.cwd || "") : "";
  const title = String(input.title || "未命名记忆").trim();
  const category = String(input.category || "general").trim();
  const content = String(input.content || "");
  const pinned = input.pinned ? 1 : 0;

  if (existing) {
    db.prepare(
      `UPDATE memories SET scope=?, cwd=?, title=?, category=?, content=?, pinned=?, version=version+1, updated_at=? WHERE id=?`,
    ).run(scope, cwd, title, category, content, pinned, now, id);
  } else {
    db.prepare(
      `INSERT INTO memories (id, scope, cwd, title, category, content, pinned, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, scope, cwd, title, category, content, pinned, now);
  }
  return db.prepare("SELECT * FROM memories WHERE id=?").get(id);
}

export function deleteMemory(id) {
  const db = getDb();
  db.prepare("DELETE FROM memories WHERE id=?").run(id);
  return true;
}

// ==================== INSTALLED MCPS & SKILLS & BACKGROUNDS ====================

export function listInstalledMcps() {
  const db = getDb();
  return db
    .prepare("SELECT * FROM installed_mcps ORDER BY installed_at DESC")
    .all()
    .map((r) => ({
      ...r,
      args: safeJsonParse(r.args_json, []),
      env: safeJsonParse(r.env_json, {}),
      enabled: Boolean(r.enabled),
    }));
}

export function saveInstalledMcp(input) {
  const db = getDb();
  const now = nowIso();
  const id = input.id || `mcp_${crypto.randomBytes(5).toString("hex")}`;
  const existing = db.prepare("SELECT * FROM installed_mcps WHERE id=?").get(id);
  const name = String(input.name || "mcp-server").trim();
  const sourceId = String(input.source_id || "");
  const description = String(input.description || "");
  const command = String(input.command || "npx").trim();
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const env = input.env && typeof input.env === "object" ? input.env : {};
  const enabled = input.enabled === false ? 0 : 1;

  if (existing) {
    db.prepare(
      `UPDATE installed_mcps SET name=?, source_id=?, description=?, command=?, args_json=?, env_json=?, enabled=? WHERE id=?`,
    ).run(name, sourceId, description, command, JSON.stringify(args), JSON.stringify(env), enabled, id);
  } else {
    db.prepare(
      `INSERT INTO installed_mcps (id, name, source_id, description, command, args_json, env_json, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, sourceId, description, command, JSON.stringify(args), JSON.stringify(env), enabled, now);
  }
  return listInstalledMcps().find((m) => m.id === id);
}

export function deleteInstalledMcp(id) {
  getDb().prepare("DELETE FROM installed_mcps WHERE id=?").run(id);
  return true;
}

export function listInstalledSkills() {
  const db = getDb();
  return db
    .prepare("SELECT * FROM installed_skills ORDER BY installed_at DESC")
    .all()
    .map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
}

export function saveInstalledSkill(input) {
  const db = getDb();
  const now = nowIso();
  const slug = String(input.slug || input.name || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "") || `skill-${Date.now()}`;
  const existing = db.prepare("SELECT * FROM installed_skills WHERE slug=? OR id=?").get(slug, input.id || "");
  const id = existing?.id || input.id || `sk_${crypto.randomBytes(5).toString("hex")}`;
  const name = String(input.name || slug).trim();
  const description = String(input.description || "");
  const content = String(input.content || "");
  const sourceUrl = String(input.source_url || "");
  const enabled = input.enabled === false ? 0 : 1;

  if (existing) {
    db.prepare(
      `UPDATE installed_skills SET name=?, slug=?, description=?, content=?, source_url=?, enabled=? WHERE id=?`,
    ).run(name, slug, description, content, sourceUrl, enabled, id);
  } else {
    db.prepare(
      `INSERT INTO installed_skills (id, name, slug, description, content, source_url, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, slug, description, content, sourceUrl, enabled, now);
  }
  return listInstalledSkills().find((s) => s.id === id);
}

export function deleteInstalledSkill(id) {
  getDb().prepare("DELETE FROM installed_skills WHERE id=?").run(id);
  return true;
}

export function listCustomBackgrounds() {
  return getDb().prepare("SELECT * FROM custom_backgrounds ORDER BY created_at DESC").all();
}

export function addCustomBackground({ name, url, source = "upload" }) {
  const id = `bg_${crypto.randomBytes(5).toString("hex")}`;
  getDb()
    .prepare("INSERT INTO custom_backgrounds (id, name, url, source, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, url, source, nowIso());
  return getDb().prepare("SELECT * FROM custom_backgrounds WHERE id=?").get(id);
}

export function deleteCustomBackground(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM custom_backgrounds WHERE id=?").get(id);
  db.prepare("DELETE FROM custom_backgrounds WHERE id=?").run(id);
  return row || null;
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
