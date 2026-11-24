/**
 * Unified Memory Synchronization & Context Builder (Single Source of Truth).
 *
 * Guarantees memory consistency across:
 *  1. Active Claude Code config directory (`~/.claude` in shared mode, or `<dataDir>/claude-config` in isolated mode)
 *  2. OpenCode Studio SQLite memory library (`memories` table)
 *  3. All prompt modes (`native`, `append`, `replace`) and both engines (Claude Code CLI & Transparent API)
 *  4. Any working directory (`cwd`) — including cross-platform WSL/Windows project memory folders
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAllSettings, getSetting, listMemories, saveMemory, setSetting } from "./db.mjs";
import { getPaths } from "./paths.mjs";

const ROOT_RULE_FILES = [
  { file: "CLAUDE.md", title: "CLAUDE.md (全局核心指令)", category: "rule", pinned: true },
  { file: "GLOBAL_AGENT_RULES.md", title: "GLOBAL_AGENT_RULES (全局工作规则)", category: "rule", pinned: true },
  { file: "WORK_PRINCIPLES.md", title: "WORK_PRINCIPLES (核心工作原则)", category: "rule", pinned: true },
];

const MAX_RULE_CHARS = 4500;
const MAX_INDEX_CHARS = 6500;
const MAX_PINNED_CHARS = 3500;
const MAX_TOTAL_MEMORY_CHARS = 22000;

// In-memory bidirectional mapping between SQLite memory IDs and disk .md files
const diskPathByMemId = new Map();
const relPathByMemId = new Map();
const memIdByDiskPath = new Map();
let lastSyncAt = 0;
let lastSyncRoot = "";
let lastDiscovered = null;

function getIgnoredDiskMemoryMap() {
  const raw = getSetting("ignored_disk_memories", {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
}

function setIgnoredDiskMemoryMap(mapObj) {
  setSetting("ignored_disk_memories", mapObj || {});
}

function winPathToWsl(p) {
  if (!p) return "";
  const m = String(p).match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return String(p).replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function formatForRuntime(filePath, rtMode) {
  if (!filePath) return "";
  return rtMode === "wsl" ? winPathToWsl(filePath) : filePath;
}

function normalizeKey(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[\s_]+/g, "-");
}

function parseFrontmatterAndTitle(content, fallbackName) {
  let metaName = "";
  let metaType = "";
  let body = String(content || "");
  const fmMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const nameM = fm.match(/^name:\s*(.+)$/m);
    const typeM = fm.match(/^type:\s*(.+)$/m);
    if (nameM) metaName = nameM[1].trim().replace(/^["']|["']$/g, "");
    if (typeM) metaType = typeM[1].trim().replace(/^["']|["']$/g, "");
    body = body.slice(fmMatch[0].length);
  }
  let heading = "";
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) heading = h1[1].trim();

  const title = metaName || heading || fallbackName.replace(/\.md$/i, "").replace(/_/g, "-");
  const category = metaType || (fallbackName.startsWith("_index") ? "index" : "project");
  return { title, category };
}

function inferProjectCwdFromSlug(slug) {
  // Windows slug e.g. D--claude -> D:\claude
  const winM = String(slug || "").match(/^([A-Za-z])--(.+)$/);
  if (winM) {
    const drive = winM[1].toUpperCase();
    const rest = winM[2].replace(/-/g, "\\");
    const candidate = `${drive}:\\${rest}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/**
 * Returns the single authoritative Claude config root directory based on current `claude_isolation` setting.
 */
export function getActiveClaudeMemoryRoot() {
  let mode = "isolated";
  try {
    mode = getAllSettings().claude_isolation === "shared" ? "shared" : "isolated";
  } catch {
    mode = "isolated";
  }
  if (mode === "shared") {
    return path.join(os.homedir(), ".claude");
  }
  return getPaths().claudeConfigDir;
}

export function resetMemorySyncCache() {
  lastSyncAt = 0;
  lastSyncRoot = "";
  lastDiscovered = null;
  diskPathByMemId.clear();
  relPathByMemId.clear();
  memIdByDiskPath.clear();
}

/**
 * Discover all Claude rule files & project memory folders inside the active Claude config root.
 */
export function discoverClaudeDiskMemories(rootDir = getActiveClaudeMemoryRoot()) {
  const result = {
    rootDir,
    rootRules: [],
    projectMemoryDirs: [],
    allFiles: [],
  };
  if (!rootDir || !fs.existsSync(rootDir)) return result;

  // 1. Root core instruction files
  for (const spec of ROOT_RULE_FILES) {
    const fp = path.join(rootDir, spec.file);
    if (!fs.existsSync(fp)) continue;
    try {
      const stat = fs.statSync(fp);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(fp, "utf8");
      if (!content.trim()) continue;
      const item = {
        fullPath: fp,
        relPath: spec.file,
        fileName: spec.file,
        slug: "",
        title: spec.title,
        category: spec.category,
        scope: "global",
        cwd: "",
        pinned: spec.pinned,
        content,
        mtimeMs: stat.mtimeMs,
        isRootRule: true,
        isIndex: false,
      };
      result.rootRules.push(item);
      result.allFiles.push(item);
    } catch {}
  }

  // 2. Project memory directories: <rootDir>/projects/<slug>/memory/*.md
  const projectsDir = path.join(rootDir, "projects");
  if (fs.existsSync(projectsDir)) {
    let slugs = [];
    try {
      slugs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {}

    const dirEntries = [];
    for (const slug of slugs) {
      const memDir = path.join(projectsDir, slug, "memory");
      if (!fs.existsSync(memDir)) continue;
      let files = [];
      try {
        files = fs
          .readdirSync(memDir, { withFileTypes: true })
          .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".md"))
          .map((f) => f.name)
          .sort();
      } catch {}
      if (!files.length) continue;

      let indexItem = null;
      const mdItems = [];
      for (const fileName of files) {
        const fp = path.join(memDir, fileName);
        try {
          const stat = fs.statSync(fp);
          const content = fs.readFileSync(fp, "utf8");
          if (!content.trim()) continue;
          const isMemoryIndex = fileName.toUpperCase() === "MEMORY.MD";
          const parsed = parseFrontmatterAndTitle(content, fileName);
          const relPath = `projects/${slug}/memory/${fileName}`;
          const item = {
            fullPath: fp,
            relPath,
            fileName,
            slug,
            title: isMemoryIndex ? `MEMORY 索引 (${slug})` : parsed.title,
            category: isMemoryIndex ? "index" : parsed.category,
            scope: "global",
            cwd: "",
            pinned: isMemoryIndex,
            content,
            mtimeMs: stat.mtimeMs,
            isRootRule: false,
            isIndex: isMemoryIndex,
          };
          if (isMemoryIndex) indexItem = item;
          mdItems.push(item);
        } catch {}
      }

      if (mdItems.length) {
        dirEntries.push({
          slug,
          memDir,
          inferredCwd: inferProjectCwdFromSlug(slug),
          count: mdItems.length,
          indexItem,
          items: mdItems,
        });
      }
    }

    // Sort project memory folders by file count descending so the primary library comes first
    dirEntries.sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

    // Give the primary (largest) project memory index the clean canonical title if applicable
    if (dirEntries.length > 0 && dirEntries[0].indexItem) {
      const primarySlug = dirEntries[0].slug;
      if (dirEntries[0].count >= 5 || primarySlug.startsWith("-mnt-")) {
        dirEntries[0].indexItem.canonicalAltTitle = "MEMORY 索引 (主目录)";
      }
    }

    for (const d of dirEntries) {
      result.projectMemoryDirs.push(d);
      result.allFiles.push(...d.items);
    }
  }

  return result;
}

/**
 * Incrementally synchronize disk `.md` memories from the active Claude config root into SQLite `memories`.
 * Zero duplicates: reuses existing imported or disk-synced rows in-place.
 */
export function syncDiskMemoriesToDb({ force = false } = {}) {
  const rootDir = getActiveClaudeMemoryRoot();
  const now = Date.now();
  if (!force && lastSyncRoot === rootDir && lastDiscovered && now - lastSyncAt < 2000) {
    return { synced: 0, rootDir, discovered: lastDiscovered, skipped: true };
  }
  if (lastSyncRoot !== rootDir) {
    diskPathByMemId.clear();
    relPathByMemId.clear();
    memIdByDiskPath.clear();
  }
  lastSyncRoot = rootDir;
  lastSyncAt = now;

  const discovered = discoverClaudeDiskMemories(rootDir);
  lastDiscovered = discovered;
  if (!discovered.allFiles.length) return { synced: 0, rootDir, discovered, skipped: false };

  const ignoredMap = getIgnoredDiskMemoryMap();
  let ignoredChanged = false;

  const existingAll = listMemories();
  const byId = new Map(existingAll.map((m) => [m.id, m]));
  const byNormTitle = new Map();
  for (const m of existingAll) {
    const k = normalizeKey(m.title);
    if (!byNormTitle.has(k)) byNormTitle.set(k, m);
  }

  let synced = 0;
  for (const item of discovered.allFiles) {
    // Respect explicit Web UI deletions unless the disk file was freshly modified afterwards
    const deletedAtMs = Number(ignoredMap[item.relPath] || 0);
    if (deletedAtMs > 0) {
      if (item.mtimeMs <= deletedAtMs + 1000) {
        continue;
      }
      delete ignoredMap[item.relPath];
      ignoredChanged = true;
    }

    const stableId = `mem_disk_${crypto.createHash("sha1").update(item.relPath).digest("hex").slice(0, 16)}`;

    // Match existing row without creating duplicates
    let existing =
      byId.get(stableId) ||
      (memIdByDiskPath.has(item.fullPath) ? byId.get(memIdByDiskPath.get(item.fullPath)) : null) ||
      byNormTitle.get(normalizeKey(item.title)) ||
      (item.canonicalAltTitle ? byNormTitle.get(normalizeKey(item.canonicalAltTitle)) : null) ||
      (!item.isIndex && !item.isRootRule ? byNormTitle.get(normalizeKey(item.fileName)) : null) ||
      null;

    // Also match root rules even if slightly differently named in older imports
    if (!existing && item.isRootRule) {
      const baseNoExt = normalizeKey(item.fileName);
      existing = existingAll.find((m) => normalizeKey(m.title).startsWith(baseNoExt)) || null;
    }

    if (existing) {
      diskPathByMemId.set(existing.id, item.fullPath);
      relPathByMemId.set(existing.id, item.relPath);
      memIdByDiskPath.set(item.fullPath, existing.id);

      const dbUpdatedMs = Date.parse(existing.updated_at || "") || 0;
      const contentDiffers = String(existing.content || "").trim() !== item.content.trim();
      // Sync disk -> DB when disk file is newer than DB row (or DB row is empty)
      if (contentDiffers && (item.mtimeMs > dbUpdatedMs + 500 || !String(existing.content || "").trim())) {
        try {
          saveMemory({
            id: existing.id,
            scope: existing.scope || item.scope,
            cwd: existing.cwd || item.cwd,
            title: existing.title || item.title,
            category: existing.category || item.category,
            content: item.content,
            pinned: existing.pinned || item.pinned,
          });
          synced += 1;
        } catch {}
      }
    } else {
      const titleToUse = item.canonicalAltTitle || item.title;
      try {
        const saved = saveMemory({
          id: stableId,
          scope: item.scope,
          cwd: item.cwd,
          title: titleToUse,
          category: item.category,
          content: item.content,
          pinned: item.pinned,
        });
        diskPathByMemId.set(saved.id, item.fullPath);
        relPathByMemId.set(saved.id, item.relPath);
        memIdByDiskPath.set(item.fullPath, saved.id);
        byId.set(saved.id, saved);
        byNormTitle.set(normalizeKey(saved.title), saved);
        synced += 1;
      } catch {}
    }
  }

  if (ignoredChanged) {
    setIgnoredDiskMemoryMap(ignoredMap);
  }

  return { synced, rootDir, totalDiskFiles: discovered.allFiles.length, discovered, skipped: false };
}

/**
 * Prevent deleted disk-backed memories from resurrecting on the next `GET /api/memories` sync!
 * Never deletes user's shared `~/.claude` files; in isolated mode removes non-core project `.md` safely.
 */
export function recordDeletedDiskMemory(memId) {
  if (!memId) return;
  const relPath = relPathByMemId.get(memId);
  const fullPath = diskPathByMemId.get(memId);
  if (relPath) {
    const ignoredMap = getIgnoredDiskMemoryMap();
    ignoredMap[relPath] = Date.now();
    setIgnoredDiskMemoryMap(ignoredMap);
  }
  if (fullPath) {
    const isIsolated = getAllSettings().claude_isolation !== "shared";
    const base = path.basename(fullPath).toUpperCase();
    const isProtected = base === "CLAUDE.MD" || base === "GLOBAL_AGENT_RULES.MD" || base === "WORK_PRINCIPLES.MD" || base === "MEMORY.MD";
    if (isIsolated && !isProtected && fullPath.startsWith(getPaths().claudeConfigDir)) {
      try {
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      } catch {}
    }
    memIdByDiskPath.delete(fullPath);
  }
  diskPathByMemId.delete(memId);
  relPathByMemId.delete(memId);
  lastDiscovered = null;
}

/**
 * Bidirectional sync: when a user edits a synced memory inside the OpenCode Studio Web UI,
 * write the updated content straight back to its bound `.md` file on disk so both sides stay identical.
 */
export function syncMemoryToDisk(savedMemory) {
  if (!savedMemory?.id) return { written: false };
  // Ensure mapping table is populated even if this is the very first request after startup
  if (!diskPathByMemId.has(savedMemory.id)) {
    syncDiskMemoriesToDb({ force: true });
  }
  const fp = diskPathByMemId.get(savedMemory.id);
  if (!fp) return { written: false };

  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, String(savedMemory.content || ""), "utf8");
    const rel = relPathByMemId.get(savedMemory.id);
    if (rel) {
      const ignoredMap = getIgnoredDiskMemoryMap();
      if (ignoredMap[rel]) {
        delete ignoredMap[rel];
        setIgnoredDiskMemoryMap(ignoredMap);
      }
    }
    lastSyncAt = Date.now();
    lastDiscovered = null;
    return { written: true, path: fp };
  } catch {
    return { written: false };
  }
}

function truncateClean(text, maxChars) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n...[内容较长已截断，完整内容请用 Read 读取对应文件]`;
}

/**
 * Build the complete, non-truncated unified memory context injected into EVERY turn
 * (works identically across native / append / replace prompt modes and any working directory).
 */
export function buildUnifiedMemoryContext({ cwd = "", rtMode = "native", includeToolHint = false } = {}) {
  const syncRes = syncDiskMemoriesToDb({ force: false });
  const rootDir = syncRes.rootDir;
  const discovered = syncRes.discovered || discoverClaudeDiskMemories(rootDir);
  const allDbMemories = listMemories({ cwd });

  const sections = [];
  let budgetLeft = MAX_TOTAL_MEMORY_CHARS;

  const appendBlock = (block) => {
    if (!block || budgetLeft <= 200) return false;
    const text = block.length > budgetLeft ? truncateClean(block, budgetLeft) : block;
    sections.push(text);
    budgetLeft -= text.length + 2;
    return true;
  };

  // 1. Live disk memory library directory map (works across ANY cwd / WSL / Windows!)
  if (discovered.projectMemoryDirs.length || discovered.rootRules.length) {
    const navLines = [
      "[持久化记忆库与全局规则（单一真相源 · 已自动实时同步）]",
      `- 记忆根目录: ${formatForRuntime(rootDir, rtMode)}`,
    ];
    for (const d of discovered.projectMemoryDirs) {
      const displayDir = formatForRuntime(d.memDir, rtMode);
      const isCurrent = cwd && d.inferredCwd && path.resolve(cwd).toLowerCase() === path.resolve(d.inferredCwd).toLowerCase();
      navLines.push(`- 记忆库 [${d.slug}] (${d.count} 篇)${isCurrent ? " [当前工作目录]" : ""}: ${displayDir}`);
    }
    const primaryMemDir = discovered.projectMemoryDirs[0]?.memDir
      ? formatForRuntime(discovered.projectMemoryDirs[0].memDir, rtMode)
      : "";
    navLines.push(
      `- 使用规则: 无论当前工作目录是什么，涉及历史项目、服务器、经验或配置时，请先对照下方索引并用 Read 工具直接读取上述目录中对应的 .md 文件。` +
        (primaryMemDir
          ? ` 新增或更新长期记忆时，请写入主记忆目录 (${primaryMemDir}) 并同步更新其 MEMORY.md 索引。`
          : ""),
    );
    appendBlock(navLines.join("\n"));
  }

  // Track which DB memory IDs have already been injected verbatim from disk to avoid duplication
  const injectedIds = new Set();

  // 2. Inject full root core rule files (CLAUDE.md / GLOBAL_AGENT_RULES.md / WORK_PRINCIPLES.md)
  for (const r of discovered.rootRules) {
    const mappedId = memIdByDiskPath.get(r.fullPath);
    if (mappedId) injectedIds.add(mappedId);
    appendBlock(`### ${r.title}\n${truncateClean(r.content, MAX_RULE_CHARS)}`);
  }

  // 3. Inject full MEMORY.md indexes from all discovered project memory directories (NEVER truncated to 220 chars!)
  for (const d of discovered.projectMemoryDirs) {
    if (!d.indexItem) continue;
    const mappedId = memIdByDiskPath.get(d.indexItem.fullPath);
    if (mappedId) injectedIds.add(mappedId);
    const label = d.indexItem.canonicalAltTitle || d.indexItem.title;
    const dirNote = formatForRuntime(d.memDir, rtMode);
    appendBlock(`### ${label} (目录: ${dirNote})\n${truncateClean(d.indexItem.content, MAX_INDEX_CHARS)}`);
  }

  // 4. Inject any additional pinned memories stored in OpenCode Studio SQLite (not already covered above)
  const extraPinned = allDbMemories.filter((m) => m.pinned && !injectedIds.has(m.id));
  if (extraPinned.length) {
    const pLines = ["### 工作台附加置顶记忆"];
    for (const m of extraPinned.slice(0, 10)) {
      injectedIds.add(m.id);
      pLines.push(`#### ${m.title} (${m.scope}/${m.category})\n${truncateClean(m.content, MAX_PINNED_CHARS)}`);
    }
    appendBlock(pLines.join("\n\n"));
  }

  // 5. List concise title index of web-only (non-disk) unpinned memories so nothing is invisible
  const webOnlyOthers = allDbMemories.filter((m) => !m.pinned && !diskPathByMemId.has(m.id) && !injectedIds.has(m.id));
  if (webOnlyOthers.length) {
    const hint = includeToolHint ? "（可调用 memory_search 按需读取详情）" : "";
    const oLines = [`### 其他工作台记忆索引${hint}`];
    for (const m of webOnlyOthers.slice(0, 30)) {
      oLines.push(`- [${m.scope}/${m.category}] ${m.title}: ${String(m.content || "").slice(0, 120).replace(/\s+/g, " ")}`);
    }
    appendBlock(oLines.join("\n"));
  }

  return sections.join("\n\n").trim();
}
