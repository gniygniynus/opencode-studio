/**
 * Open-source online stores for OpenCode Studio:
 *   1. MCP Store       — curated open-source MCP servers + live npm/GitHub online search
 *   2. Skills Store    — curated open-source Agent Skills + live GitHub SKILL.md search & download
 *   3. Wallpaper Store — curated CC0/Public-Domain open-source wallpapers + live Wikimedia Commons search
 */

import { logEvent } from "./logger.mjs";

const USER_AGENT = "OpenCodeStudio/1.0 (+https://github.com/gniygniynus/opencode-studio)";

// ==================== 1. CURATED OPEN-SOURCE MCP CATALOG ====================
export const CURATED_MCPS = [
  {
    id: "mcp-filesystem",
    name: "filesystem",
    title: "Filesystem (官方开源)",
    description: "官方安全文件系统 MCP，支持按授权目录读写、搜索与查看元信息。",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE_DIR}"],
    env_hints: [],
    repo_url: "https://github.com/modelcontextprotocol/servers",
    tags: ["official", "files"],
    featured: true,
  },
  {
    id: "mcp-fetch",
    name: "fetch",
    title: "Web Fetch (官方开源)",
    description: "联网抓取网页并转为适合大模型阅读的 Markdown 内容。",
    command: "uvx",
    args: ["mcp-server-fetch"],
    env_hints: [],
    repo_url: "https://github.com/modelcontextprotocol/servers",
    tags: ["official", "web"],
    featured: true,
  },
  {
    id: "mcp-memory",
    name: "memory-graph",
    title: "Knowledge Graph Memory (官方开源)",
    description: "基于本地知识图谱的持久化记忆 MCP，适合长期复杂项目。",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env_hints: [],
    repo_url: "https://github.com/modelcontextprotocol/servers",
    tags: ["official", "memory"],
    featured: true,
  },
  {
    id: "mcp-sequential-thinking",
    name: "sequential-thinking",
    title: "Sequential Thinking (官方开源)",
    description: "结构化分步深度推理与多路径反思工具。",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    env_hints: [],
    repo_url: "https://github.com/modelcontextprotocol/servers",
    tags: ["official", "reasoning"],
    featured: true,
  },
  {
    id: "mcp-playwright",
    name: "playwright",
    title: "Playwright Browser (微软开源)",
    description: "驱动真实浏览器自动化点击、截图、调试网页与抓取动态页面。",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    env_hints: [],
    repo_url: "https://github.com/microsoft/playwright-mcp",
    tags: ["browser", "automation"],
    featured: true,
  },
  {
    id: "mcp-context7",
    name: "context7",
    title: "Context7 Docs (开源最新文档)",
    description: "实时检索各大编程框架最新官方文档与代码示例，告别过时 API。",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"],
    env_hints: [],
    repo_url: "https://github.com/upstash/context7",
    tags: ["docs", "coding"],
    featured: true,
  },
  {
    id: "mcp-github",
    name: "github",
    title: "GitHub MCP (开源)",
    description: "直接操作 GitHub 仓库、Issue、PR 与代码搜索。",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env_hints: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    repo_url: "https://github.com/modelcontextprotocol/servers",
    tags: ["git", "github"],
    featured: true,
  },
  {
    id: "mcp-sqlite",
    name: "sqlite",
    title: "SQLite Explorer (开源)",
    description: "查询与分析本地 SQLite 数据库表结构与 SQL 结果。",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "${DB_PATH}"],
    env_hints: [],
    repo_url: "https://github.com/modelcontextprotocol/servers",
    tags: ["database", "sql"],
    featured: true,
  },
];

// ==================== 2. CURATED OPEN-SOURCE SKILLS CATALOG ====================
export const CURATED_SKILLS = [
  {
    id: "skill-code-review",
    slug: "code-review",
    name: "深度代码审查专家",
    description: "按安全隐患、边界条件、性能瓶颈与可维护性四个维度审查改动并给出精准补丁。",
    source_url: "https://github.com/gniygniynus/opencode-studio",
    tags: ["coding", "review"],
    content: `# 深度代码审查专家\n\n当用户请求审查代码或 PR 时，按以下顺序执行：\n1. 使用工具先读取改动文件和上下文调用链，禁止脱离上下文猜测。\n2. 重点排查：安全漏洞（注入/越权/密钥泄漏）、并发与空指针边界、资源泄漏、逻辑回归。\n3. 输出按「严重 / 建议 / 细节」分级，每条必须附精确文件名、行号与可直接应用的修改方案。`,
  },
  {
    id: "skill-student-tutor",
    slug: "student-tutor",
    name: "编程教学导师（苏格拉底式）",
    description: "面向学生的编程辅导技能：先讲透原理与思路，分步引导理解，再用可运行最小示例验证。",
    source_url: "https://github.com/gniygniynus/opencode-studio",
    tags: ["education", "learning"],
    content: `# 编程教学导师\n\n辅导学生学习编程与调试时：\n1. 先用通俗直白的比喻解释核心概念，避免一上来堆砌术语。\n2. 遇到报错时，教学生看懂报错堆栈的第一行与根因，而不是只丢一段黑盒代码。\n3. 给出最小可运行示例，并用简短注释说明每一行关键逻辑，最后留 1 个小练习巩固。`,
  },
  {
    id: "skill-bug-hunter",
    slug: "bug-hunter",
    name: "系统化排障猎手",
    description: "复现 → 查日志/证据 → 定位根因 → 最小修复 → 回归测试五步排障法。",
    source_url: "https://github.com/gniygniynus/opencode-studio",
    tags: ["debug", "ops"],
    content: `# 系统化排障猎手\n\n处理任何 Bug 时严格遵守：\n1. 先收集真实报错堆栈、日志与环境状态，绝不凭印象瞎改。\n2. 列出最可能的 2-3 个假设并用最小命令逐一证伪。\n3. 找到根因后做外科手术式最小修复，并补充自动化验证确认问题彻底消失。`,
  },
  {
    id: "skill-git-workflow",
    slug: "git-workflow",
    name: "Git 提交与分支助手",
    description: "自动检查 git diff、规避敏感文件误提交，生成规范 Conventional Commits 提交信息。",
    source_url: "https://github.com/gniygniynus/opencode-studio",
    tags: ["git"],
    content: `# Git 提交助手\n\n协助提交代码前：\n1. 先运行 git status 和 git diff --stat，检查是否混入 .env / 密钥 / 大体积临时文件。\n2. 按 feat / fix / refactor / docs / chore 规范总结简洁清晰的中文 Commit Message。\n3. 绝不擅自执行 git push --force 或 git reset --hard，除非用户明确确认。`,
  },
  {
    id: "skill-doc-writer",
    slug: "doc-writer",
    name: "技术文档与 README 撰写",
    description: "根据真实代码结构生成清晰、新手友好的安装指南、架构说明与 API 参考文档。",
    source_url: "https://github.com/gniygniynus/opencode-studio",
    tags: ["docs"],
    content: `# 技术文档撰写\n\n撰写 README 或文档时：\n1. 先读取 package.json / 核心入口代码，确保命令与参数 100% 与代码一致。\n2. 结构清晰：项目亮点 → 快速开始（3步内跑起来）→ 核心功能 → 常见问题排查。\n3. 面向零基础读者，不省略前置依赖和常见坑说明。`,
  },
  {
    id: "skill-test-gen",
    slug: "test-gen",
    name: "单元测试与回归用例生成",
    description: "为关键函数与 API 编写覆盖正常路径、边界输入和异常分支的自动化测试。",
    source_url: "https://github.com/gniygniynus/opencode-studio",
    tags: ["testing"],
    content: `# 单元测试生成\n\n编写测试时：\n1. 优先覆盖核心业务逻辑、边界条件（空值/超长/并发/非法格式）和错误处理。\n2. 隔离外部网络和真实磁盘副作用（使用临时目录或 Mock），保证测试快速可重复。\n3. 写完必须实际运行测试命令验证全绿。`,
  },
];

function proxyImageUrl(raw) {
  return `/api/wallpaper-proxy?url=${encodeURIComponent(raw)}`;
}

// Built-in 60fps Canvas live wallpapers (zero bandwidth, super smooth, optional pause)
export const LIVE_WALLPAPERS = [
  {
    id: "live-aurora",
    name: "动态 · 极光流影",
    author: "Live Canvas",
    license: "MIT",
    type: "live",
    liveBg: "live-aurora",
    url: "",
    preview_css: "linear-gradient(135deg, #0f2027 0%, #203a43 45%, #2c5364 100%)",
  },
  {
    id: "live-starfield",
    name: "动态 · 深空星河",
    author: "Live Canvas",
    license: "MIT",
    type: "live",
    liveBg: "live-starfield",
    url: "",
    preview_css: "radial-gradient(circle at 30% 30%, #1b2845 0%, #090c14 75%)",
  },
  {
    id: "live-mesh",
    name: "动态 · 莫兰迪柔雾",
    author: "Live Canvas",
    license: "MIT",
    type: "live",
    liveBg: "live-mesh",
    url: "",
    preview_css: "linear-gradient(125deg, #dfe9f3 0%, #f3e7e9 50%, #e3eeff 100%)",
  },
  {
    id: "live-waves",
    name: "动态 · 深海光波",
    author: "Live Canvas",
    license: "MIT",
    type: "live",
    liveBg: "live-waves",
    url: "",
    preview_css: "linear-gradient(160deg, #134e5e 0%, #1a2a6c 60%, #0f172a 100%)",
  },
  {
    id: "live-constellation",
    name: "动态 · 几何呼吸星网",
    author: "Live Canvas",
    license: "MIT",
    type: "live",
    liveBg: "live-constellation",
    url: "",
    preview_css: "linear-gradient(135deg, #16222a 0%, #3a6073 100%)",
  },
  {
    id: "live-matrix",
    name: "动态 · 赛博微光代码雨",
    author: "Live Canvas",
    license: "MIT",
    type: "live",
    liveBg: "live-matrix",
    url: "",
    preview_css: "linear-gradient(180deg, #07140d 0%, #0d2b1d 60%, #050a08 100%)",
  },
];

// ==================== 3. CURATED OPEN-SOURCE WALLPAPERS ====================
export const CURATED_WALLPAPERS = [
  {
    id: "wp-none",
    name: "纯色极简（无背景）",
    author: "OpenCode Studio",
    license: "MIT",
    type: "none",
    thumb: "",
    url: "",
    preview_css: "linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)",
  },
  {
    id: "wp-grad-nordic",
    name: "北欧晨雾（轻量渐变）",
    author: "OpenCode Studio",
    license: "MIT",
    type: "gradient",
    thumb: "",
    url: "linear-gradient(135deg, #e0eafc 0%, #cfdef3 48%, #f5f7fa 100%)",
    preview_css: "linear-gradient(135deg, #e0eafc 0%, #cfdef3 48%, #f5f7fa 100%)",
  },
  {
    id: "wp-grad-dusk",
    name: "静谧暮蓝（深色友好）",
    author: "OpenCode Studio",
    license: "MIT",
    type: "gradient",
    thumb: "",
    url: "radial-gradient(circle at 20% 20%, #1e3a5f 0%, #111827 55%, #090d16 100%)",
    preview_css: "radial-gradient(circle at 20% 20%, #1e3a5f 0%, #111827 55%, #090d16 100%)",
  },
  {
    id: "wp-grad-sage",
    name: "青瓷柔光（护眼低饱和）",
    author: "OpenCode Studio",
    license: "MIT",
    type: "gradient",
    thumb: "",
    url: "linear-gradient(125deg, #e6f4ea 0%, #eef6f9 52%, #f4f1ea 100%)",
    preview_css: "linear-gradient(125deg, #e6f4ea 0%, #eef6f9 52%, #f4f1ea 100%)",
  },
  ...LIVE_WALLPAPERS,
  {
    id: "wp-wm-alps",
    name: "雪峰晨曦（Wikimedia CC）",
    author: "Wikimedia Commons",
    license: "CC BY-SA",
    type: "image",
    thumb: proxyImageUrl("https://commons.wikimedia.org/wiki/Special:FilePath/Everest_North_Face_toward_Base_Camp_Tibet_Luca_Galuzzi_2006.jpg?width=640"),
    url: proxyImageUrl("https://commons.wikimedia.org/wiki/Special:FilePath/Everest_North_Face_toward_Base_Camp_Tibet_Luca_Galuzzi_2006.jpg?width=1920"),
  },
  {
    id: "wp-wm-aurora",
    name: "极光夜空（Wikimedia CC）",
    author: "Wikimedia Commons",
    license: "CC BY",
    type: "image",
    thumb: proxyImageUrl("https://commons.wikimedia.org/wiki/Special:FilePath/Polarlicht_2.jpg?width=640"),
    url: proxyImageUrl("https://commons.wikimedia.org/wiki/Special:FilePath/Polarlicht_2.jpg?width=1920"),
  },
];

// Chinese -> English wallpaper keyword mapping so Wallhaven returns rich 4K hits for Chinese queries
const ZH_WALLPAPER_DICT = {
  星空: "stars galaxy night sky",
  宇宙: "space nebula universe",
  动漫: "anime scenery landscape",
  二次元: "anime art wallpaper",
  赛博朋克: "cyberpunk neon city",
  赛博: "cyberpunk neon",
  风景: "landscape nature mountains",
  山水: "mountains lake landscape",
  雪山: "snow mountains alps",
  森林: "forest mist nature",
  海洋: "ocean sea waves",
  海边: "beach ocean sunset",
  日落: "sunset clouds sky",
  日出: "sunrise mountain",
  城市: "cityscape night lights",
  夜景: "night city neon",
  极简: "minimalism abstract clean",
  极光: "aurora borealis northern lights",
  樱花: "cherry blossom japan sakura",
  猫: "cat cute",
  暗黑: "dark abstract minimal",
  科幻: "sci-fi futuristic",
  建筑: "architecture minimal",
  治愈: "pastel sky clouds calm",
  古风: "traditional chinese landscape",
};

function translateWallpaperQuery(q) {
  let out = String(q || "").trim();
  for (const [zh, en] of Object.entries(ZH_WALLPAPER_DICT)) {
    if (out.includes(zh)) {
      out = out.replaceAll(zh, ` ${en} `);
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

async function fetchJsonWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ==================== ONLINE SEARCH: MCP STORE ====================
export async function searchMcpStore(query = "") {
  const q = String(query || "").trim();
  if (!q) {
    return { ok: true, mode: "curated", items: CURATED_MCPS, online_note: "输入关键词可联网搜索 npm 与 GitHub 开源 MCP 服务" };
  }

  const localHits = CURATED_MCPS.filter((m) =>
    `${m.name} ${m.title} ${m.description} ${(m.tags || []).join(" ")}`.toLowerCase().includes(q.toLowerCase()),
  );

  const onlineItems = [];
  let onlineError = "";

  // Search npm registry for open-source MCP servers (fast, no auth needed, directly npx-installable!)
  try {
    const npmUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`mcp ${q}`)}&size=14`;
    const npmData = await fetchJsonWithTimeout(npmUrl, 9000);
    for (const obj of npmData.objects || []) {
      const pkg = obj.package || {};
      if (!pkg.name) continue;
      onlineItems.push({
        id: `npm-${pkg.name.replace(/[^a-z0-9]/gi, "-")}`,
        name: pkg.name.split("/").pop().replace(/^mcp-server-|^server-/, "") || pkg.name,
        title: `${pkg.name} (v${pkg.version || "latest"})`,
        description: pkg.description || "开源 npm MCP 包",
        command: "npx",
        args: ["-y", pkg.name],
        env_hints: [],
        repo_url: pkg.links?.repository || pkg.links?.npm || "",
        tags: ["npm", "online"],
        source: "npm",
      });
    }
  } catch (err) {
    onlineError = `npm 联网搜索失败: ${err.message}`;
    logEvent("WARN", "stores", "mcp_npm_search_err", onlineError);
  }

  // Also search GitHub open-source MCP repos
  try {
    const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} mcp server`)}&sort=stars&per_page=8`;
    const ghData = await fetchJsonWithTimeout(ghUrl, 9000);
    for (const repo of ghData.items || []) {
      onlineItems.push({
        id: `gh-${repo.id}`,
        name: repo.name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase(),
        title: `${repo.full_name} (★ ${repo.stargazers_count || 0})`,
        description: repo.description || "GitHub 开源 MCP 仓库",
        command: "npx",
        args: ["-y", repo.name],
        env_hints: [],
        repo_url: repo.html_url,
        tags: ["github", `★${repo.stargazers_count || 0}`],
        source: "github",
      });
    }
  } catch (err) {
    if (!onlineError) onlineError = `GitHub 联网搜索受限: ${err.message}`;
  }

  const dedup = new Map();
  for (const item of [...localHits, ...onlineItems]) {
    if (!dedup.has(item.id)) dedup.set(item.id, item);
  }
  return {
    ok: true,
    mode: "online",
    query: q,
    items: [...dedup.values()].slice(0, 24),
    online_error: onlineError,
  };
}

// ==================== ONLINE SEARCH: SKILLS STORE ====================
export async function searchSkillsStore(query = "") {
  const q = String(query || "").trim();
  if (!q) {
    return { ok: true, mode: "curated", items: CURATED_SKILLS, online_note: "输入关键词可联网搜索 GitHub 开源 Agent Skills" };
  }

  const localHits = CURATED_SKILLS.filter((s) =>
    `${s.name} ${s.slug} ${s.description} ${(s.tags || []).join(" ")}`.toLowerCase().includes(q.toLowerCase()),
  );

  const onlineItems = [];
  let onlineError = "";
  try {
    const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} claude skill OR agent skill`)}&sort=stars&per_page=10`;
    const ghData = await fetchJsonWithTimeout(ghUrl, 9000);
    for (const repo of ghData.items || []) {
      onlineItems.push({
        id: `gh-skill-${repo.id}`,
        slug: repo.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
        name: `${repo.name} (★ ${repo.stargazers_count || 0})`,
        description: repo.description || `来自 ${repo.full_name} 的开源 Skill 仓库`,
        source_url: repo.html_url,
        github_full_name: repo.full_name,
        default_branch: repo.default_branch || "main",
        tags: ["github", "online"],
        content: "", // fetched live upon install
      });
    }
  } catch (err) {
    onlineError = `GitHub Skills 联网搜索失败: ${err.message}`;
    logEvent("WARN", "stores", "skills_search_err", onlineError);
  }

  return {
    ok: true,
    mode: "online",
    query: q,
    items: [...localHits, ...onlineItems].slice(0, 20),
    online_error: onlineError,
  };
}

/**
 * Download SKILL.md (or README.md fallback) from an open-source GitHub repo when user clicks Install.
 */
export async function downloadRemoteSkillContent(item) {
  if (item.content && item.content.trim()) return item.content;
  if (!item.github_full_name) return `# ${item.name}\n\n${item.description || ""}`;

  const branch = item.default_branch || "main";
  const candidates = [
    `https://raw.githubusercontent.com/${item.github_full_name}/${branch}/SKILL.md`,
    `https://raw.githubusercontent.com/${item.github_full_name}/${branch}/skill.md`,
    `https://raw.githubusercontent.com/${item.github_full_name}/${branch}/README.md`,
  ];
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        if (text.trim().length > 20) return text.slice(0, 20000);
      }
    } catch {
      // try next candidate
    }
  }
  return `# ${item.name}\n\n来源: ${item.source_url}\n\n${item.description || ""}`;
}

// ==================== ONLINE SEARCH: MASSIVE OPEN WALLPAPER STORE (WALLHAVEN 4K + WIKIMEDIA + LIVE) ====================
export async function searchWallpaperStore(query = "", page = 1, category = "all") {
  const q = String(query || "").trim();
  const pageNum = Math.max(1, Number(page) || 1);
  const translated = translateWallpaperQuery(q);

  // Category filter for live wallpapers only
  if (category === "live") {
    const liveList = LIVE_WALLPAPERS.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()));
    return { ok: true, mode: "live", page: 1, has_more: false, items: liveList };
  }

  const onlineItems = [];
  let onlineError = "";
  let lastPage = 1;
  let totalCount = 0;

  // Query Wallhaven public 4K wallpaper API (24 HD wallpapers per page, infinite pagination, SFW purity=100)
  try {
    const whParams = new URLSearchParams({
      purity: "100",
      page: String(pageNum),
      sorting: translated ? "relevance" : "toplist",
      ratios: "16x9,16x10,21x9",
    });
    if (translated) {
      whParams.set("q", translated);
    } else if (category === "anime") {
      whParams.set("categories", "010");
    } else if (category === "scenery") {
      whParams.set("q", "landscape nature");
    } else {
      whParams.set("categories", "110"); // general + anime (clean wallpapers)
    }

    const whUrl = `https://wallhaven.cc/api/v1/search?${whParams.toString()}`;
    const data = await fetchJsonWithTimeout(whUrl, 10000);
    lastPage = Number(data?.meta?.last_page || 1);
    totalCount = Number(data?.meta?.total || 0);

    for (const item of data?.data || []) {
      // Wallhaven's `thumbs.small` (300x200) and `path` (full 4K) are publicly accessible 200 OK
      // without hotlink 403 (unlike `thumbs.large`/`thumbs.original`).
      const thumb = item.thumbs?.small || item.path;
      const full = item.path;
      if (!thumb || !full) continue;
      onlineItems.push({
        id: `wh-${item.id}`,
        name: `${item.category || "HD"} · ${item.resolution || "4K"}`,
        author: "Wallhaven",
        license: item.resolution || "HD",
        type: "image",
        thumb: proxyImageUrl(thumb),
        url: proxyImageUrl(full),
        resolution: item.resolution || "",
        colors: item.colors || [],
      });
    }
  } catch (err) {
    onlineError = `Wallhaven 联网搜索失败: ${err.message}`;
    logEvent("WARN", "stores", "wallhaven_err", onlineError);
  }

  // Fallback / supplement with Wikimedia Commons if Wallhaven returned few hits
  if (onlineItems.length < 6 && q) {
    try {
      const wmUrl =
        `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
        `&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(`${translated || q} filetype:bitmap`)}&gsrlimit=12` +
        `&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=640`;
      const data = await fetchJsonWithTimeout(wmUrl, 9000);
      for (const pg of Object.values(data?.query?.pages || {})) {
        const info = pg.imageinfo?.[0];
        if (!info?.url || !info?.thumburl) continue;
        if ((info.width || 0) < 900) continue;
        const cleanName = String(pg.title || "").replace(/^File:/i, "").replace(/\.[^.]+$/, "").replace(/_/g, " ").slice(0, 50);
        onlineItems.push({
          id: `wm-${pg.pageid}`,
          name: cleanName || "Wikimedia 壁纸",
          author: "Wikimedia",
          license: info.extmetadata?.LicenseShortName?.value || "CC",
          type: "image",
          thumb: proxyImageUrl(info.thumburl),
          url: proxyImageUrl(info.url),
        });
      }
    } catch {
      // ignore fallback err
    }
  }

  const baseItems = pageNum === 1 && !q && category === "all" ? CURATED_WALLPAPERS : [];
  return {
    ok: true,
    mode: q ? "online" : "curated+online",
    query: q,
    translated_query: translated,
    page: pageNum,
    last_page: lastPage,
    total_online: totalCount,
    has_more: pageNum < lastPage,
    items: [...baseItems, ...onlineItems],
    online_error: onlineError,
  };
}
