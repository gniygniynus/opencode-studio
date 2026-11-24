/**
 * Unified SQLite (WAL) storage layer using Node's built-in node:sqlite (zero native compilation!).
 *
 * Guarantees & Optimizations:
 *  - Safe multi-window concurrency via WAL mode + busy_timeout + atomic transactions + versioned memory writes.
 *  - Tuned 32MB page cache, 256MB mmap I/O, prepared-statement cache, and automatic WAL bloat checkpointing.
 *  - Covering indexes + FTS5 (trigram) full-text search with instant CJK/ASCII substring fallback (<3 chars).
 *  - Tree-structured messages supporting Edit & Resend with single-query recursive CTE branch switching
 *    and metadata-first timeline loading (inactive branches never deserialize heavy JSON payloads).
 *  - Write-through in-memory kv_settings cache (0 SQL queries on hot bootstrap/turn paths).
 *  - Local AES-256-GCM encryption for stored API keys (never exported or sent to frontend).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getPaths } from "./paths.mjs";
import { logEvent, nowIso } from "./logger.mjs";

let _db = null;
let _secretKey = null;
let _ftsEnabled = false;
let _txDepth = 0;
let _settingsCache = null; // Map<string, string> write-through cache
const _stmtCache = new WeakMap();

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
  authorized: false,        // 必须用户显式授权后才只读读取本地 Steam 431960 / 4K 目录（绝不修改桌面壁纸）
  dirs: [],                 // 已授权的绝对目录列表（零拷贝只读流式播放）
  video_muted: true,        // 视频壁纸默认静音循环，可随时手动开关声音
};

function stmt(db, sql) {
  let map = _stmtCache.get(db);
  if (!map) {
    map = new Map();
    _stmtCache.set(db, map);
  }
  let s = map.get(sql);
  if (!s) {
    s = db.prepare(sql);
    map.set(sql, s);
  }
  return s;
}

function withTransaction(db, fn) {
  if (_txDepth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  _txDepth += 1;
  try {
    const res = fn();
    db.exec("COMMIT");
    return res;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    _txDepth -= 1;
  }
}

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

function healUnsupportedFtsSchema(db, dbFilePath) {
  let hasFtsArtifacts = false;
  try {
    hasFtsArtifacts = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name LIKE 'messages_fts%' OR tbl_name = 'messages_fts' OR name LIKE 'trg_messages_fts_%' LIMIT 1",
        )
        .get(),
    );
  } catch {
    hasFtsArtifacts = false;
  }
  if (!hasFtsArtifacts) return { db, healed: false };

  try {
    db.prepare("SELECT rowid FROM messages_fts LIMIT 0").all();
    return { db, healed: false };
  } catch (probeErr) {
    // Current SQLite runtime (e.g. Electron's Chromium SQLite) lacks `fts5` while the DB file
    // contains virtual table / triggers created earlier under standalone Node.js.
    // Cleanly strip FTS triggers + shadow tables + virtual schema entry and reopen cleanly!
    try {
      db.exec(`
        DROP TRIGGER IF EXISTS trg_messages_fts_ai;
        DROP TRIGGER IF EXISTS trg_messages_fts_ad;
        DROP TRIGGER IF EXISTS trg_messages_fts_au;
      `);
    } catch {}

    try {
      db.exec("DROP TABLE IF EXISTS messages_fts");
    } catch {
      for (const sub of [
        "messages_fts_data",
        "messages_fts_idx",
        "messages_fts_docsize",
        "messages_fts_config",
        "messages_fts_content",
      ]) {
        try {
          db.exec(`DROP TABLE IF EXISTS ${sub}`);
        } catch {}
      }
      try {
        db.exec("PRAGMA writable_schema = ON");
        db.exec("DELETE FROM sqlite_master WHERE name LIKE 'messages_fts%' OR tbl_name = 'messages_fts'");
        db.exec("PRAGMA writable_schema = OFF");
      } catch {}
    }

    try {
      db.exec("DELETE FROM kv_settings WHERE key = 'fts_backfilled_v1'");
    } catch {}

    try {
      db.close();
    } catch {}
    const reopened = new DatabaseSync(dbFilePath);
    // Also remove 0-message broken shell sessions left behind by the prior FTS trigger failure
    try {
      reopened.exec(`
        DELETE FROM sessions
        WHERE claude_cli_sid = ''
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)
      `);
    } catch {}
    return { db: reopened, healed: true, reason: probeErr?.message || "fts5 unavailable" };
  }
}

function runSchemaMigrations(db, dbFilePath) {
  // 1. Non-destructive column additions on existing databases
  const sessCols = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name));
  if (!sessCols.has("pinned")) {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }

  // 2. High-selectivity covering indexes (eliminates table-page scans on large message blobs)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_pinned_updated ON sessions(archived, pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_active_role ON messages(session_id, is_active, role, created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_lookup ON memories(pinned DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_scope_cwd ON memories(scope, cwd);
  `);

  // 3. FTS5 (trigram) full-text index — only enabled when the current SQLite build genuinely supports fts5
  //    (Skip creating virtual tables inside Electron builds where Chromium SQLite omits fts5)
  _ftsEnabled = false;
  const isElectronRuntime = Boolean(process.versions?.electron);
  if (!isElectronRuntime) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content_text,
          session_id UNINDEXED,
          message_id UNINDEXED,
          tokenize = 'trigram'
        );

        CREATE TRIGGER IF NOT EXISTS trg_messages_fts_ai AFTER INSERT ON messages
        WHEN length(new.content_text) > 0
        BEGIN
          INSERT INTO messages_fts(content_text, session_id, message_id)
          VALUES (new.content_text, new.session_id, new.id);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_messages_fts_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE message_id = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_messages_fts_au AFTER UPDATE OF content_text ON messages BEGIN
          DELETE FROM messages_fts WHERE message_id = old.id;
          INSERT INTO messages_fts(content_text, session_id, message_id)
          SELECT new.content_text, new.session_id, new.id WHERE length(new.content_text) > 0;
        END;
      `);
      const backfilled = db.prepare("SELECT value FROM kv_settings WHERE key='fts_backfilled_v1'").get();
      if (!backfilled) {
        withTransaction(db, () => {
          db.exec("DELETE FROM messages_fts");
          db.exec(`
            INSERT INTO messages_fts(content_text, session_id, message_id)
            SELECT content_text, session_id, id FROM messages WHERE length(content_text) > 0
          `);
          db.prepare("INSERT OR REPLACE INTO kv_settings (key, value, updated_at) VALUES ('fts_backfilled_v1', '1', ?)").run(nowIso());
        });
      }
      _ftsEnabled = true;
    } catch (err) {
      _ftsEnabled = false;
      try {
        db.exec(`
          DROP TRIGGER IF EXISTS trg_messages_fts_ai;
          DROP TRIGGER IF EXISTS trg_messages_fts_ad;
          DROP TRIGGER IF EXISTS trg_messages_fts_au;
        `);
      } catch {}
      logEvent("WARN", "db", "fts_unavailable", `FTS5 全文索引未启用，已自动回退标准索引: ${err.message}`);
    }
  }

  // 4. Reclaim bloated WAL files (>8 MB) on startup + update query planner statistics
  try {
    const walPath = `${dbFilePath}-wal`;
    if (fs.existsSync(walPath) && fs.statSync(walPath).size > 8 * 1024 * 1024) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    db.exec("PRAGMA optimize");
  } catch {}
}

export function getDb() {
  if (_db) return _db;
  const p = getPaths();
  const healRes = healUnsupportedFtsSchema(new DatabaseSync(p.dbFile), p.dbFile);
  const db = healRes.db;
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA cache_size = -32000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    PRAGMA wal_autocheckpoint = 1000;

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
      pinned INTEGER NOT NULL DEFAULT 0,
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
  _settingsCache = null;
  if (healRes.healed) {
    logEvent(
      "INFO",
      "db",
      "fts_schema_healed",
      `检测到跨运行时 SQLite FTS5 差异，已自动无损修复索引与触发器 (${healRes.reason})`,
    );
  }
  runSchemaMigrations(db, p.dbFile);
  seedInitialData(db);
  return _db;
}

export function closeDb() {
  if (_db) {
    try {
      _db.exec("PRAGMA optimize");
    } catch {}
    try {
      _db.close();
    } catch {}
    _db = null;
    _settingsCache = null;
    _txDepth = 0;
  }
}

function seedInitialData(db) {
  withTransaction(db, () => {
    const now = nowIso();
    const sel = stmt(db, "SELECT key FROM kv_settings WHERE key=?");
    const ins = stmt(db, "INSERT INTO kv_settings (key, value, updated_at) VALUES (?, ?, ?)");
    const ensureKv = (key, val) => {
      if (!sel.get(key)) {
        ins.run(key, typeof val === "string" ? val : JSON.stringify(val), now);
      }
    };

    ensureKv("system_prompt", DEFAULT_SYSTEM_PROMPT);
    ensureKv("prompt_mode", "replace"); // replace | append | native
    ensureKv("permission_mode", "auto"); // auto | confirm_dangerous
    ensureKv("claude_isolation", "isolated"); // isolated (零冲突独立目录) | shared (共享系统 ~/.claude)
    ensureKv("update_channel", "stable"); // stable | latest
    ensureKv("web_search_enabled", true); // 对话框实时联网搜索开关
    ensureKv("favorite_wallpapers", []); // 收藏的壁纸列表
    ensureKv("appearance", DEFAULT_APPEARANCE);
    ensureKv("search_engine", DEFAULT_SEARCH_ENGINE);
    ensureKv("wallpaper_engine", DEFAULT_WALLPAPER_ENGINE);
    ensureKv("default_cwd", getPaths().defaultCwd);

    // Ensure the optional "Claude 原生登录" provider entry exists out of the box (inactive until chosen)
    const nativeExists = stmt(db, "SELECT id FROM providers WHERE kind='claude_native'").get();
    if (!nativeExists) {
      stmt(
        db,
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
  });
  _settingsCache = null;
}

// ==================== KV SETTINGS (WRITE-THROUGH MEMORY CACHE) ====================

const RAW_STRING_SETTING_KEYS = new Set([
  "system_prompt",
  "prompt_mode",
  "permission_mode",
  "claude_isolation",
  "update_channel",
  "default_cwd",
]);

function ensureSettingsCache() {
  const db = getDb();
  if (_settingsCache) return _settingsCache;
  _settingsCache = new Map();
  const rows = stmt(db, "SELECT key, value FROM kv_settings").all();
  for (const r of rows) {
    _settingsCache.set(r.key, r.value);
  }
  return _settingsCache;
}

export function getSetting(key, fallback = null) {
  const cache = ensureSettingsCache();
  if (!cache.has(key)) return fallback;
  const rawVal = cache.get(key);
  if (RAW_STRING_SETTING_KEYS.has(key)) {
    return typeof rawVal === "string" ? rawVal : String(rawVal ?? "");
  }
  try {
    return JSON.parse(rawVal);
  } catch {
    return rawVal;
  }
}

export function setSetting(key, value) {
  const db = getDb();
  const cache = ensureSettingsCache();
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  stmt(
    db,
    `INSERT INTO kv_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, serialized, nowIso());
  cache.set(key, serialized);
  return value;
}

function resolveValidDefaultCwd() {
  const fallback = getPaths().defaultCwd;
  const saved = String(getSetting("default_cwd", fallback) || "").trim();
  if (!saved) return fallback;
  try {
    if (fs.existsSync(saved) && fs.statSync(saved).isDirectory()) return saved;
  } catch {}
  return fallback;
}

export function getAllSettings() {
  return {
    system_prompt: getSetting("system_prompt", DEFAULT_SYSTEM_PROMPT),
    prompt_mode: getSetting("prompt_mode", "replace"),
    permission_mode: getSetting("permission_mode", "auto"),
    claude_isolation: getSetting("claude_isolation", "isolated"),
    update_channel: getSetting("update_channel", "stable"),
    web_search_enabled: getSetting("web_search_enabled", true) !== false,
    favorite_wallpapers: Array.isArray(getSetting("favorite_wallpapers", [])) ? getSetting("favorite_wallpapers", []) : [],
    appearance: { ...DEFAULT_APPEARANCE, ...(getSetting("appearance", DEFAULT_APPEARANCE) || {}) },
    search_engine: { ...DEFAULT_SEARCH_ENGINE, ...(getSetting("search_engine", DEFAULT_SEARCH_ENGINE) || {}) },
    wallpaper_engine: { ...DEFAULT_WALLPAPER_ENGINE, ...(getSetting("wallpaper_engine", DEFAULT_WALLPAPER_ENGINE) || {}) },
    default_cwd: resolveValidDefaultCwd(),
  };
}

// ==================== DATABASE DIAGNOSTICS & MAINTENANCE ====================

export function getDatabaseStats() {
  const db = getDb();
  const p = getPaths();
  const fileBytes = (fp) => {
    try {
      return fs.existsSync(fp) ? fs.statSync(fp).size : 0;
    } catch {
      return 0;
    }
  };
  const dbBytes = fileBytes(p.dbFile);
  const walBytes = fileBytes(`${p.dbFile}-wal`);
  const toMb = (b) => Math.round((b / (1024 * 1024)) * 100) / 100;

  const activeSessions = stmt(db, "SELECT COUNT(*) AS c FROM sessions WHERE archived=0").get().c;
  const archivedSessions = stmt(db, "SELECT COUNT(*) AS c FROM sessions WHERE archived=1").get().c;
  const totalMessages = stmt(db, "SELECT COUNT(*) AS c FROM messages").get().c;
  const totalMemories = stmt(db, "SELECT COUNT(*) AS c FROM memories").get().c;

  return {
    db_file: p.dbFile,
    db_mb: toMb(dbBytes),
    wal_mb: toMb(walBytes),
    total_mb: toMb(dbBytes + walBytes),
    sessions_active: activeSessions,
    sessions_archived: archivedSessions,
    messages_total: totalMessages,
    memories_total: totalMemories,
    fts_enabled: _ftsEnabled,
  };
}

export function optimizeDatabase({ purgeArchived = false, purgeEmptyShells = false, activeSessionIds = [] } = {}) {
  const db = getDb();
  const before = getDatabaseStats();
  let purgedSessions = 0;
  let purgedEmptyShells = 0;

  if (purgeArchived || purgeEmptyShells) {
    withTransaction(db, () => {
      if (purgeArchived) {
        const res = stmt(db, "DELETE FROM sessions WHERE archived=1").run();
        purgedSessions = Number(res?.changes || 0);
      }
      if (purgeEmptyShells) {
        const activeSet = new Set(activeSessionIds || []);
        const candidates = stmt(
          db,
          `SELECT s.id FROM sessions s
           WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`,
        ).all();
        const delStmt = stmt(db, "DELETE FROM sessions WHERE id=?");
        for (const row of candidates) {
          if (!activeSet.has(row.id)) {
            delStmt.run(row.id);
            purgedEmptyShells += 1;
          }
        }
      }
    });
  }

  if (_ftsEnabled) {
    try {
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
    } catch {}
  }
  try {
    db.exec("PRAGMA optimize");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (purgedSessions > 0 || purgedEmptyShells > 0) {
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
  } catch (err) {
    logEvent("WARN", "db", "optimize_partial", `数据库维护部分完成: ${err.message}`);
  }

  const after = getDatabaseStats();
  const savedMb = Math.max(0, Math.round((before.total_mb - after.total_mb) * 100) / 100);
  logEvent(
    "INFO",
    "db",
    "optimized",
    `SQLite 维护完成: ${before.total_mb}MB -> ${after.total_mb}MB (释放 ${savedMb}MB, 清理归档=${purgedSessions}, 空壳=${purgedEmptyShells})`,
  );
  return {
    ok: true,
    purged_sessions: purgedSessions,
    purged_empty_shells: purgedEmptyShells,
    freed_mb: savedMb,
    before,
    after,
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
  const rows = stmt(db, "SELECT * FROM providers ORDER BY is_active DESC, created_at ASC").all();
  return rows.map((r) => rowToProvider(r, includeSecret));
}

export function getProvider(id, includeSecret = false) {
  const db = getDb();
  const row = stmt(db, "SELECT * FROM providers WHERE id=?").get(id);
  return rowToProvider(row, includeSecret);
}

export function getActiveProvider(includeSecret = false) {
  const db = getDb();
  let row = stmt(db, "SELECT * FROM providers WHERE is_active=1 LIMIT 1").get();
  if (!row) {
    row = stmt(db, "SELECT * FROM providers ORDER BY created_at ASC LIMIT 1").get();
  }
  return rowToProvider(row, includeSecret);
}

export function saveProvider(input) {
  const db = getDb();
  const now = nowIso();
  const id = input.id || `prov_${crypto.randomBytes(6).toString("hex")}`;

  let logName = "";
  let logKind = "";
  let logCount = 0;

  withTransaction(db, () => {
    const existing = stmt(db, "SELECT * FROM providers WHERE id=?").get(id);

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
      (!existing && stmt(db, "SELECT COUNT(*) AS c FROM providers WHERE is_active=1").get().c === 0);

    if (shouldActivate) {
      stmt(db, "UPDATE providers SET is_active=0").run();
    }

    if (existing) {
      stmt(
        db,
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
      stmt(
        db,
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

    logName = name;
    logKind = kind;
    logCount = models.length;
  });

  logEvent("INFO", "providers", "saved", `保存供应商 ${logName} (${logKind}), 模型数=${logCount}`);
  return getProvider(id, false);
}

export function activateProvider(id, model = "") {
  const db = getDb();
  const existing = stmt(db, "SELECT * FROM providers WHERE id=?").get(id);
  if (!existing) throw new Error("供应商不存在");

  withTransaction(db, () => {
    stmt(db, "UPDATE providers SET is_active=0").run();
    if (model && model.trim()) {
      stmt(db, "UPDATE providers SET is_active=1, default_model=?, updated_at=? WHERE id=?").run(
        model.trim(),
        nowIso(),
        id,
      );
    } else {
      stmt(db, "UPDATE providers SET is_active=1, updated_at=? WHERE id=?").run(nowIso(), id);
    }
  });

  logEvent("INFO", "providers", "activated", `切换当前供应商 -> ${existing.name}${model ? " / " + model : ""}`);
  return getProvider(id, false);
}

export function deleteProvider(id) {
  const db = getDb();
  if (id === "claude-native-oauth") {
    throw new Error("内置「Claude 原生订阅登录」模板不可删除");
  }
  const row = stmt(db, "SELECT * FROM providers WHERE id=?").get(id);
  if (!row) return false;

  withTransaction(db, () => {
    stmt(db, "DELETE FROM providers WHERE id=?").run(id);
    if (row.is_active) {
      const first = stmt(db, "SELECT id FROM providers ORDER BY created_at ASC LIMIT 1").get();
      if (first) stmt(db, "UPDATE providers SET is_active=1 WHERE id=?").run(first.id);
    }
  });

  logEvent("INFO", "providers", "deleted", `删除供应商 ${row.name}`);
  return true;
}

// ==================== SESSIONS & BRANCHING MESSAGE TREE ====================

function rowToSession(row) {
  if (!row) return null;
  return {
    ...row,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
  };
}

export function createSession({ title = "新会话", cwd = "", providerId = "", model = "", thinkingLevel = "auto", pinned = false } = {}) {
  const db = getDb();
  const now = nowIso();
  const id = crypto.randomUUID();
  const activeProv = providerId ? getProvider(providerId) : getActiveProvider();
  const finalCwd = cwd || resolveValidDefaultCwd();
  stmt(
    db,
    `INSERT INTO sessions (id, title, cwd, provider_id, model, thinking_level, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title,
    finalCwd,
    activeProv?.id || "",
    model || activeProv?.default_model || "",
    thinkingLevel || "auto",
    pinned ? 1 : 0,
    now,
    now,
  );
  return getSessionMeta(id);
}

export function getSessionMeta(id) {
  const db = getDb();
  return rowToSession(stmt(db, "SELECT * FROM sessions WHERE id=?").get(id));
}

export function updateSessionMeta(id, patch) {
  const db = getDb();
  const allowed = ["title", "cwd", "provider_id", "model", "thinking_level", "claude_cli_sid", "compact_count", "pinned", "archived"];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k}=?`);
      if (k === "pinned" || k === "archived") vals.push(patch[k] ? 1 : 0);
      else vals.push(patch[k]);
    }
  }
  if (!sets.length) return getSessionMeta(id);
  // Toggling pin alone shouldn't scramble chronological updated_at order unless requested
  const onlyPinChange = Object.keys(patch).every((k) => k === "pinned");
  if (!onlyPinChange) {
    sets.push("updated_at=?");
    vals.push(nowIso());
  }
  vals.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  return getSessionMeta(id);
}

export function deleteSession(id) {
  const db = getDb();
  stmt(db, "UPDATE sessions SET archived=1, updated_at=? WHERE id=?").run(nowIso(), id);
  return true;
}

export function hardDeleteSession(id) {
  const db = getDb();
  stmt(db, "DELETE FROM sessions WHERE id=?").run(id);
  return true;
}

function makeSnippet(text, qlc, rawLen) {
  const idx = text.toLowerCase().indexOf(qlc);
  if (idx < 0) return "";
  const start = Math.max(0, idx - 32);
  const end = Math.min(text.length, idx + rawLen + 52);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

export function listSessions({ query = "", cwd = "", limit = 200 } = {}) {
  const db = getDb();
  const q = String(query || "").trim();
  const cwdFilter = String(cwd || "").trim();

  const cwds = stmt(
    db,
    "SELECT cwd, COUNT(*) AS count FROM sessions WHERE archived=0 GROUP BY cwd ORDER BY count DESC",
  ).all();

  if (!q) {
    const rows = cwdFilter
      ? stmt(
          db,
          `SELECT s.*,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
           FROM sessions s
           WHERE s.archived=0 AND s.cwd=?
           ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?`,
        ).all(cwdFilter, limit)
      : stmt(
          db,
          `SELECT s.*,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
           FROM sessions s
           WHERE s.archived=0
           ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?`,
        ).all(limit);
    return { sessions: rows.map(rowToSession), cwds };
  }

  const qlc = q.toLowerCase();
  const codepointLen = [...q].length;

  // Fast FTS5 trigram path for queries with >= 3 Unicode codepoints
  if (_ftsEnabled && codepointLen >= 3) {
    const ftsPhrase = `"${q.replace(/"/g, '""')}"`;
    try {
      const ftsHits = stmt(
        db,
        `SELECT m.session_id, m.id AS message_id, m.content_text, m.created_at
         FROM messages_fts f
         JOIN messages m ON m.id = f.message_id
         WHERE messages_fts MATCH ? AND m.is_active = 1
         ORDER BY m.created_at DESC
         LIMIT 600`,
      ).all(ftsPhrase);

      const hitBySess = new Map();
      for (const h of ftsHits) {
        if (!hitBySess.has(h.session_id)) hitBySess.set(h.session_id, h);
      }

      const titleSql = cwdFilter
        ? `SELECT s.*,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
           FROM sessions s
           WHERE s.archived=0 AND s.cwd=? AND instr(lower(s.title), ?) > 0
           ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?`
        : `SELECT s.*,
             (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
           FROM sessions s
           WHERE s.archived=0 AND instr(lower(s.title), ?) > 0
           ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?`;
      const titleRows = cwdFilter
        ? db.prepare(titleSql).all(cwdFilter, qlc, limit)
        : db.prepare(titleSql).all(qlc, limit);

      const mergedById = new Map();
      for (const r of titleRows) mergedById.set(r.id, rowToSession(r));

      const missingSids = [...hitBySess.keys()].filter((sid) => !mergedById.has(sid)).slice(0, limit);
      if (missingSids.length) {
        const placeholders = missingSids.map(() => "?").join(",");
        const sessSql = cwdFilter
          ? `SELECT s.*,
               (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
             FROM sessions s
             WHERE s.archived=0 AND s.cwd=? AND s.id IN (${placeholders})`
          : `SELECT s.*,
               (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.is_active=1 AND m.role='user') AS user_turns
             FROM sessions s
             WHERE s.archived=0 AND s.id IN (${placeholders})`;
        const extraRows = cwdFilter
          ? db.prepare(sessSql).all(cwdFilter, ...missingSids)
          : db.prepare(sessSql).all(...missingSids);
        for (const r of extraRows) mergedById.set(r.id, rowToSession(r));
      }

      const finalRows = [...mergedById.values()]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit);

      for (const s of finalRows) {
        const h = hitBySess.get(s.id);
        if (h) {
          s.match_snippet = makeSnippet(h.content_text, qlc, q.length);
          s.match_message_id = h.message_id;
        }
      }
      return { sessions: finalRows, cwds };
    } catch {
      // Fall through to exact substring query if FTS syntax encounters edge cases
    }
  }

  // Exact substring fallback (used for 1-2 char short CJK/ASCII queries or when FTS5 is absent)
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
  sql += " ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params).map(rowToSession);
  if (rows.length) {
    const placeholders = rows.map(() => "?").join(",");
    const hits = db
      .prepare(
        `SELECT id, session_id, content_text, created_at FROM messages
         WHERE session_id IN (${placeholders}) AND is_active=1 AND instr(lower(content_text), ?) > 0
         ORDER BY created_at DESC`,
      )
      .all(...rows.map((r) => r.id), qlc);
    const firstHitBySess = new Map();
    for (const h of hits) {
      if (!firstHitBySess.has(h.session_id)) firstHitBySess.set(h.session_id, h);
    }
    for (const s of rows) {
      const hit = firstHitBySess.get(s.id);
      if (hit) {
        s.match_snippet = makeSnippet(hit.content_text, qlc, q.length);
        s.match_message_id = hit.id;
      }
    }
  }
  return { sessions: rows, cwds };
}

function setSubtreeActive(db, sessionId, rootId, activeVal) {
  stmt(
    db,
    `WITH RECURSIVE subtree(id) AS (
       VALUES(?)
       UNION ALL
       SELECT m.id FROM messages m
       JOIN subtree st ON m.parent_id = st.id
       WHERE m.session_id = ?
     )
     UPDATE messages SET is_active = ?
     WHERE session_id = ? AND id IN (SELECT id FROM subtree)`,
  ).run(rootId, sessionId, activeVal, sessionId);
}

/**
 * Append a message under parentId. If sibling branches exist at this parentId,
 * automatically deactivate sibling subtrees atomically so the newly added branch is active.
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

  withTransaction(db, () => {
    const siblings = parentId
      ? stmt(db, "SELECT id FROM messages WHERE session_id=? AND parent_id=? AND is_active=1").all(sessionId, parentId)
      : stmt(db, "SELECT id FROM messages WHERE session_id=? AND parent_id IS NULL AND is_active=1").all(sessionId);

    for (const sib of siblings) {
      setSubtreeActive(db, sessionId, sib.id, 0);
    }

    stmt(
      db,
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

    stmt(db, "UPDATE sessions SET updated_at=? WHERE id=?").run(now, sessionId);
  });

  return getMessageById(id);
}

export function getMessageById(id) {
  const db = getDb();
  const r = stmt(db, "SELECT * FROM messages WHERE id=?").get(id);
  if (!r) return null;
  return {
    ...r,
    is_active: Boolean(r.is_active),
    blocks: safeJsonParse(r.blocks_json, []),
    images: safeJsonParse(r.images_json, []),
    usage: safeJsonParse(r.usage_json, {}),
  };
}

/**
 * Switch to an alternative branch sibling at a given message node,
 * reactivating the latest path inside that branch cleanly & atomically.
 */
export function switchBranch(sessionId, targetMessageId) {
  const db = getDb();
  const target = stmt(db, "SELECT id, parent_id FROM messages WHERE id=? AND session_id=?").get(targetMessageId, sessionId);
  if (!target) throw new Error("目标分支消息不存在");

  withTransaction(db, () => {
    const siblings = target.parent_id
      ? stmt(db, "SELECT id FROM messages WHERE session_id=? AND parent_id=?").all(sessionId, target.parent_id)
      : stmt(db, "SELECT id FROM messages WHERE session_id=? AND parent_id IS NULL").all(sessionId);

    for (const sib of siblings) {
      setSubtreeActive(db, sessionId, sib.id, 0);
    }

    // Walk down from target activating the most recently created child at each hop
    let curId = targetMessageId;
    const stmtActivate = stmt(db, "UPDATE messages SET is_active=1 WHERE id=?");
    const stmtNext = stmt(
      db,
      "SELECT id FROM messages WHERE session_id=? AND parent_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    );
    while (curId) {
      stmtActivate.run(curId);
      const next = stmtNext.get(sessionId, curId);
      curId = next ? next.id : null;
    }

    stmt(db, "UPDATE sessions SET updated_at=? WHERE id=?").run(nowIso(), sessionId);
  });

  return getSessionTimeline(sessionId);
}

/**
 * Reconstruct the active linear timeline for a session, annotated with sibling branch info
 * (e.g. branch_index: 2, branch_total: 2, sibling_ids: [...]) so the UI can show ◀ 2/2 ▶.
 *
 * Optimization: loads lightweight skeleton headers for inactive branches without deserializing
 * multi-MB `blocks_json` / `images_json`, and orders active nodes strictly by parent->child topology.
 */
export function getSessionTimeline(sessionId) {
  const db = getDb();
  const meta = getSessionMeta(sessionId);
  if (!meta) return null;

  // 1. Lightweight tree skeleton (index-friendly, zero large blob reads for inactive branches)
  const skeletonRows = stmt(
    db,
    "SELECT id, parent_id, is_active, created_at FROM messages WHERE session_id=? ORDER BY created_at ASC, rowid ASC",
  ).all(sessionId);

  const siblingsByParent = new Map();
  for (const r of skeletonRows) {
    const pk = r.parent_id || "__ROOT__";
    let arr = siblingsByParent.get(pk);
    if (!arr) {
      arr = [];
      siblingsByParent.set(pk, arr);
    }
    arr.push(r.id);
  }

  // 2. Full payload ONLY for active branch messages
  const rawActive = stmt(
    db,
    "SELECT * FROM messages WHERE session_id=? AND is_active=1 ORDER BY created_at ASC, rowid ASC",
  ).all(sessionId);

  // Order strictly along parent_id -> child topological chain (immune to identical-millisecond timestamps)
  const activeById = new Map(rawActive.map((r) => [r.id, r]));
  const activeChildByParent = new Map();
  for (const r of rawActive) {
    const pk = r.parent_id && activeById.has(r.parent_id) ? r.parent_id : "__ROOT__";
    if (!activeChildByParent.has(pk)) activeChildByParent.set(pk, []);
    activeChildByParent.get(pk).push(r);
  }

  const activeRows = [];
  const visited = new Set();
  const walkActive = (pk) => {
    const kids = activeChildByParent.get(pk);
    if (!kids) return;
    for (const k of kids) {
      if (visited.has(k.id)) continue;
      visited.add(k.id);
      activeRows.push(k);
      walkActive(k.id);
    }
  };
  walkActive("__ROOT__");
  for (const r of rawActive) {
    if (!visited.has(r.id)) activeRows.push(r);
  }

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
    const siblingIds = siblingsByParent.get(pk) || [r.id];
    const branchIndex = Math.max(1, siblingIds.indexOf(r.id) + 1);

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
      branch_total: siblingIds.length,
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

export function getMemoryById(id) {
  const db = getDb();
  const r = stmt(db, "SELECT * FROM memories WHERE id=?").get(id);
  return r ? { ...r, pinned: Boolean(r.pinned) } : null;
}

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

  return withTransaction(db, () => {
    const existing = stmt(db, "SELECT * FROM memories WHERE id=?").get(id);

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
      stmt(
        db,
        `UPDATE memories SET scope=?, cwd=?, title=?, category=?, content=?, pinned=?, version=version+1, updated_at=? WHERE id=?`,
      ).run(scope, cwd, title, category, content, pinned, now, id);
    } else {
      stmt(
        db,
        `INSERT INTO memories (id, scope, cwd, title, category, content, pinned, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(id, scope, cwd, title, category, content, pinned, now);
    }
    const saved = stmt(db, "SELECT * FROM memories WHERE id=?").get(id);
    return saved ? { ...saved, pinned: Boolean(saved.pinned) } : null;
  });
}

export function deleteMemory(id) {
  const db = getDb();
  const existing = stmt(db, "SELECT * FROM memories WHERE id=?").get(id);
  stmt(db, "DELETE FROM memories WHERE id=?").run(id);
  return existing || null;
}

// ==================== INSTALLED MCPS & SKILLS & BACKGROUNDS ====================

export function listInstalledMcps() {
  const db = getDb();
  return stmt(db, "SELECT * FROM installed_mcps ORDER BY installed_at DESC")
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
  const existing = stmt(db, "SELECT * FROM installed_mcps WHERE id=?").get(id);
  const name = String(input.name || "mcp-server").trim();
  const sourceId = String(input.source_id || "");
  const description = String(input.description || "");
  const command = String(input.command || "npx").trim();
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const env = input.env && typeof input.env === "object" ? input.env : {};
  const enabled = input.enabled === false ? 0 : 1;

  if (existing) {
    stmt(
      db,
      `UPDATE installed_mcps SET name=?, source_id=?, description=?, command=?, args_json=?, env_json=?, enabled=? WHERE id=?`,
    ).run(name, sourceId, description, command, JSON.stringify(args), JSON.stringify(env), enabled, id);
  } else {
    stmt(
      db,
      `INSERT INTO installed_mcps (id, name, source_id, description, command, args_json, env_json, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, sourceId, description, command, JSON.stringify(args), JSON.stringify(env), enabled, now);
  }
  return listInstalledMcps().find((m) => m.id === id);
}

export function deleteInstalledMcp(id) {
  const db = getDb();
  stmt(db, "DELETE FROM installed_mcps WHERE id=?").run(id);
  return true;
}

export function listInstalledSkills() {
  const db = getDb();
  return stmt(db, "SELECT * FROM installed_skills ORDER BY installed_at DESC")
    .all()
    .map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
}

export function saveInstalledSkill(input) {
  const db = getDb();
  const now = nowIso();
  const slug =
    String(input.slug || input.name || "skill")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "") || `skill-${Date.now()}`;
  const existing = stmt(db, "SELECT * FROM installed_skills WHERE slug=? OR id=?").get(slug, input.id || "");
  const id = existing?.id || input.id || `sk_${crypto.randomBytes(5).toString("hex")}`;
  const name = String(input.name || slug).trim();
  const description = String(input.description || "");
  const content = String(input.content || "");
  const sourceUrl = String(input.source_url || "");
  const enabled = input.enabled === false ? 0 : 1;

  if (existing) {
    stmt(
      db,
      `UPDATE installed_skills SET name=?, slug=?, description=?, content=?, source_url=?, enabled=? WHERE id=?`,
    ).run(name, slug, description, content, sourceUrl, enabled, id);
  } else {
    stmt(
      db,
      `INSERT INTO installed_skills (id, name, source_url, slug, description, content, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, sourceUrl, slug, description, content, enabled, now);
  }
  return listInstalledSkills().find((s) => s.id === id);
}

export function deleteInstalledSkill(id) {
  const db = getDb();
  stmt(db, "DELETE FROM installed_skills WHERE id=?").run(id);
  return true;
}

export function listCustomBackgrounds() {
  const db = getDb();
  return stmt(db, "SELECT * FROM custom_backgrounds ORDER BY created_at DESC").all();
}

export function addCustomBackground({ name, url, source = "upload" }) {
  const db = getDb();
  const id = `bg_${crypto.randomBytes(5).toString("hex")}`;
  stmt(db, "INSERT INTO custom_backgrounds (id, name, url, source, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    name,
    url,
    source,
    nowIso(),
  );
  return stmt(db, "SELECT * FROM custom_backgrounds WHERE id=?").get(id);
}

export function deleteCustomBackground(id) {
  const db = getDb();
  const row = stmt(db, "SELECT * FROM custom_backgrounds WHERE id=?").get(id);
  stmt(db, "DELETE FROM custom_backgrounds WHERE id=?").run(id);
  return row || null;
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
