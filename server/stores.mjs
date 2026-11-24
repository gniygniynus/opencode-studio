/**
 * Open-source online stores for OpenCode Studio:
 *   1. MCP Store       — curated open-source MCP servers + live npm/GitHub online search
 *   2. Skills Store    — curated open-source Agent Skills + live GitHub SKILL.md search & download
 *   3. Wallpaper Store — curated CC0/Public-Domain open-source wallpapers + live Wikimedia Commons search
 */

import { getAllSettings } from "./db.mjs";
import { logEvent } from "./logger.mjs";
import { proxyFetch } from "./runtime_utils.mjs";

const USER_AGENT = "OpenCodeStudio/2.1 (+https://github.com/gniygniynus/opencode-studio)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ==================== DUAL SEARCH ENGINE DETECTOR (DOMESTIC DIRECT vs PROXY GLOBAL) ====================
let _globalProbeCache = { reachable: false, checkedAt: 0, proxyKey: "" };
// Short-lived store response cache (45s) so switching store tabs feels instantaneous
const _storeQueryCache = new Map();

function getConfiguredProxyUrl() {
  return String(getAllSettings().search_engine?.proxy_url || "").trim();
}

async function fetchWithTimeout(url, { timeoutMs = 8500, headers = {}, useProxy = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proxyUrl = useProxy ? getConfiguredProxyUrl() : "";
    const res = await proxyFetch(url, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: controller.signal,
      proxyUrl,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = 9000, extraHeaders = {}) {
  const res = await fetchWithTimeout(url, { timeoutMs, headers: { Accept: "application/json", ...extraHeaders } });
  return await res.json();
}

async function fetchTextWithTimeout(url, timeoutMs = 8500, extraHeaders = {}) {
  const res = await fetchWithTimeout(url, { timeoutMs, headers: extraHeaders });
  return await res.text();
}

/**
 * Determine active search engine:
 *  - "cn"    : Domestic Direct Full-Web Engine (Bing CN 4K/Live + npmmirror + jsDelivr CDN, zero proxy needed!)
 *  - "proxy" : Global Proxy Full-Web Engine (Wallhaven 4K + Wikimedia Video + Official MCP Registry + GitHub + Bing)
 *  - "auto"  : Fast 2.2s probe (cached 60s); automatically picks "proxy" if global reachable else "cn"!
 */
export async function resolveSearchEngine(requested = "") {
  const saved = getAllSettings().search_engine || {};
  const pref = ["cn", "proxy", "auto"].includes(requested) ? requested : (saved.mode || "auto");
  if (pref === "cn") {
    return { active: "cn", requested: pref, label: "国内直连" };
  }
  if (pref === "proxy") {
    return { active: "proxy", requested: pref, label: "代理引擎" };
  }

  // Auto-probe global media/store reachability (cached 60s, invalidated immediately if proxy_url changes).
  // Note: `api.github.com` is intermittently reachable in mainland China while `wallhaven.cc` / `wikimedia.org`
  // are blocked without a proxy — probing `wallhaven.cc` when no proxy is configured prevents false-positive
  // 3.5s~14s timeouts on first wallpaper load!
  const proxyKey = String(saved.proxy_url || "").trim();
  if (Date.now() - _globalProbeCache.checkedAt > 60_000 || _globalProbeCache.proxyKey !== proxyKey) {
    try {
      const probeUrl = proxyKey ? "https://api.github.com/zen" : "https://wallhaven.cc/api/v1/tag/1";
      await fetchWithTimeout(probeUrl, { timeoutMs: proxyKey ? 2200 : 1500, useProxy: true });
      _globalProbeCache = { reachable: true, checkedAt: Date.now(), proxyKey };
    } catch {
      _globalProbeCache = { reachable: false, checkedAt: Date.now(), proxyKey };
    }
  }
  return _globalProbeCache.reachable
    ? { active: "proxy", requested: "auto", label: "代理引擎" }
    : { active: "cn", requested: "auto", label: "国内直连" };
}

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

function proxyImageUrl(raw, fallbackUrl = "") {
  const base = `/api/wallpaper-proxy?url=${encodeURIComponent(raw)}`;
  return fallbackUrl ? `${base}&fb=${encodeURIComponent(fallbackUrl)}` : base;
}

// Built-in 60fps Canvas live wallpapers (12 curated themes, zero bandwidth, searchable by Chinese & English)
export const LIVE_WALLPAPERS = [
  {
    id: "live-aurora",
    name: "动态 · 极光流影",
    description: "60fps 北极光柔和丝带流动",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-aurora",
    tags: ["极光", "夜空", "aurora", "渐变"],
    url: "",
    preview_css: "linear-gradient(135deg, #0f2027 0%, #203a43 45%, #2c5364 100%)",
  },
  {
    id: "live-starfield",
    name: "动态 · 深空星河",
    description: "60fps 深空穿梭星尘与流星",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-starfield",
    tags: ["星空", "宇宙", "stars", "galaxy", "暗黑"],
    url: "",
    preview_css: "radial-gradient(circle at 30% 30%, #1b2845 0%, #090c14 75%)",
  },
  {
    id: "live-sakura",
    name: "动态 · 落樱微风",
    description: "60fps 温柔粉色樱花花瓣飘落",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-sakura",
    tags: ["樱花", "治愈", "动漫", "sakura", "粉色", "春季"],
    url: "",
    preview_css: "linear-gradient(135deg, #fde2e4 0%, #fad2e1 48%, #e2ece9 100%)",
  },
  {
    id: "live-rain",
    name: "动态 · 细雨涟漪",
    description: "60fps 宁静雨滴与水面波纹",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-rain",
    tags: ["雨", "治愈", "护眼", "rain", "蓝调"],
    url: "",
    preview_css: "linear-gradient(160deg, #1d3557 0%, #2b4c7e 55%, #162447 100%)",
  },
  {
    id: "live-nebula",
    name: "动态 · 紫金星云",
    description: "60fps 绚丽宇宙星云流体粒子",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-nebula",
    tags: ["星云", "星空", "宇宙", "nebula", "科幻"],
    url: "",
    preview_css: "radial-gradient(circle at 25% 30%, #4c1d95 0%, #1e1b4b 50%, #090a1a 100%)",
  },
  {
    id: "live-mesh",
    name: "动态 · 莫兰迪柔雾",
    description: "60fps 浅色护眼呼吸流光渐变",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-mesh",
    tags: ["极简", "浅色", "护眼", "minimal", "治愈"],
    url: "",
    preview_css: "linear-gradient(125deg, #dfe9f3 0%, #f3e7e9 50%, #e3eeff 100%)",
  },
  {
    id: "live-ink",
    name: "动态 · 水墨山岚",
    description: "60fps 国风远山云雾缓缓流淌",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-ink",
    tags: ["水墨", "古风", "山水", "风景", "浅色", "护眼"],
    url: "",
    preview_css: "linear-gradient(180deg, #eef2f3 0%, #cfd8dc 55%, #78909c 100%)",
  },
  {
    id: "live-waves",
    name: "动态 · 深海光波",
    description: "60fps 幽蓝海浪层叠律动",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-waves",
    tags: ["海洋", "海浪", "ocean", "蓝色"],
    url: "",
    preview_css: "linear-gradient(160deg, #134e5e 0%, #1a2a6c 60%, #0f172a 100%)",
  },
  {
    id: "live-sunset",
    name: "动态 · 日落霓虹波浪",
    description: "60fps 蒸汽波落日与赛博网格",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-sunset",
    tags: ["日落", "赛博", "赛博朋克", "cyberpunk", "sunset"],
    url: "",
    preview_css: "linear-gradient(180deg, #2b1055 0%, #753a88 45%, #f2709c 80%, #ff9472 100%)",
  },
  {
    id: "live-snow",
    name: "动态 · 静谧雪夜",
    description: "60fps 柔光冬夜雪花轻飘",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-snow",
    tags: ["雪", "雪山", "冬日", "snow", "夜空"],
    url: "",
    preview_css: "linear-gradient(180deg, #0f172a 0%, #1e293b 55%, #334155 100%)",
  },
  {
    id: "live-constellation",
    name: "动态 · 几何呼吸星网",
    description: "60fps 极简科技感动态连线星阵",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-constellation",
    tags: ["极简", "科技", "科幻", "几何", "minimal"],
    url: "",
    preview_css: "linear-gradient(135deg, #16222a 0%, #3a6073 100%)",
  },
  {
    id: "live-matrix",
    name: "动态 · 赛博微光代码雨",
    description: "60fps 经典黑客帝国翠绿代码雨",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-matrix",
    tags: ["赛博", "代码", "暗黑", "matrix", "编程"],
    url: "",
    preview_css: "linear-gradient(180deg, #07140d 0%, #0d2b1d 60%, #050a08 100%)",
  },
  {
    id: "live-fireflies",
    name: "动态 · 仲夏森屿流萤",
    description: "60fps 静谧深林微光萤火虫呼吸漂浮",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-fireflies",
    tags: ["森林", "萤火虫", "治愈", "护眼", "夜空", "forest", "fireflies"],
    url: "",
    preview_css: "radial-gradient(circle at 50% 65%, #132a24 0%, #091614 65%, #050b0a 100%)",
  },
  {
    id: "live-cybergrid",
    name: "动态 · 霓虹流光天际线",
    description: "60fps 复古未来主义透视流光网格",
    author: "Live Canvas",
    license: "60fps 动态",
    type: "live",
    liveBg: "live-cybergrid",
    tags: ["赛博", "赛博朋克", "科技", "科幻", "cyberpunk", "neon", "暗黑"],
    url: "",
    preview_css: "linear-gradient(180deg, #090d1e 0%, #1e1b4b 52%, #701a75 88%, #0f172a 100%)",
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

// ==================== OFFICIAL BING DAILY 4K UHD & FILTERED FULL-WEB 2K/4K ENGINES ====================
const LOW_QUALITY_OR_HOTLINK_DOMAINS =
  /(?:zhimg\.com|zhihu\.com|xhscdn\.com|xiaohongshu\.com|duitang\.com|sinaimg\.cn|hdslb\.com|bilibili\.com|toutiaoimg\.com|baijiahao|nipic\.com|photophoto\.cn|58pic\.com|699pic\.com|vcg\.com|huaban\.com)/i;

let _bingOfficialUhdCache = { at: 0, items: [] };

export async function fetchBingOfficialUhdWallpapers() {
  if (_bingOfficialUhdCache.items.length && Date.now() - _bingOfficialUhdCache.at < 30 * 60 * 1000) {
    return _bingOfficialUhdCache.items;
  }
  try {
    const [batch0, batch1] = await Promise.all([
      fetchJsonWithTimeout(
        "https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&uhd=1&uhdwidth=3840&uhdheight=2160&mkt=zh-CN",
        6000,
        { "Accept-Language": "zh-CN,zh;q=0.9" },
      ).catch(() => ({ images: [] })),
      fetchJsonWithTimeout(
        "https://cn.bing.com/HPImageArchive.aspx?format=js&idx=8&n=8&uhd=1&uhdwidth=3840&uhdheight=2160&mkt=zh-CN",
        6000,
        { "Accept-Language": "zh-CN,zh;q=0.9" },
      ).catch(() => ({ images: [] })),
    ]);

    const seen = new Set();
    const items = [];
    for (const img of [...(batch0.images || []), ...(batch1.images || [])]) {
      const base = String(img.urlbase || "").trim();
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const uhdRaw = `https://cn.bing.com${base}_UHD.jpg`;
      const thumbRaw = `https://cn.bing.com${base}_1920x1080.jpg`;
      const copyRaw = String(img.copyright || "").trim();
      const copyMain = copyRaw.replace(/\s*\([^)]*\)\s*$/, "").trim();
      const copyAuthor = copyRaw.match(/\(([^)]+)\)\s*$/)?.[1] || "Microsoft Bing UHD";
      const title = String(img.title || copyMain || "必应每日 4K 精选").trim();
      items.push({
        id: `bing-uhd-${img.startdate || items.length}`,
        name: title,
        description: copyMain && copyMain !== title ? copyMain : copyAuthor,
        author: "必应官方 4K UHD",
        license: "3840×2160",
        type: "image",
        thumb: proxyImageUrl(thumbRaw),
        url: proxyImageUrl(uhdRaw, thumbRaw),
        resolution: "4K UHD",
        tags: ["必应每日4K", "风景", "摄影", title, copyMain],
      });
    }
    if (items.length) {
      _bingOfficialUhdCache = { at: Date.now(), items };
    }
    return items;
  } catch {
    return _bingOfficialUhdCache.items || [];
  }
}

function parseBingImageCards(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/m="(\{[^"]+\})"([\s\S]{0,420})/g)) {
    try {
      const obj = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'"));
      const tail = m[2] || "";
      const full = obj.murl || obj.bmurl;
      const thumb = obj.turl || obj.murl;
      if (!full || !thumb || !/^https?:\/\//i.test(full) || seen.has(full)) continue;
      if (LOW_QUALITY_OR_HOTLINK_DOMAINS.test(full)) continue;
      seen.add(full);

      const dimMatch = tail.match(/(\d{4})\s*[×x]\s*(\d{3,4})/i);
      const w = dimMatch ? Number(dimMatch[1]) : 0;
      const h = dimMatch ? Number(dimMatch[2]) : 0;
      if (w > 0 && w < 1600) continue;
      const resLabel = w >= 3800 ? "4K" : w >= 2500 ? "2K+" : w > 0 && h > 0 ? `${w}×${h}` : "HD";

      const cleanTitle = String(obj.t || obj.desc || "全网超清壁纸")
        .replace(/[-_|—]\s*(知乎|哔哩哔哩|小红书|堆糖|百度|搜狐|网易).*$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 42);

      out.push({
        id: `bing-${String(obj.cid || obj.md5 || out.length).replace(/[^A-Za-z0-9_-]/g, "")}`,
        title: cleanTitle || "超清桌面壁纸",
        thumb,
        full,
        murl: full,
        resolution: resLabel,
      });
    } catch {}
  }
  return out;
}

async function searchBingWallpapers(q, pageNum = 1, category = "all") {
  const catKeywords = {
    all: "4k desktop wallpaper landscape scenery uhd",
    scenery: "自然风景 雪山 极光 森林 4k 超清壁纸",
    anime: "anime scenery aesthetic 4k wallpaper 唯美二次元壁纸",
  };
  const kw = q ? `${q} 4k 超清壁纸 wallpaper` : (catKeywords[category] || catKeywords.all);
  const first = (pageNum - 1) * 28;
  const url =
    `https://cn.bing.com/images/async?q=${encodeURIComponent(kw)}` +
    `&first=${first}&count=28&qft=+filterui:imagesize-custom_2560_1440+filterui:aspect-wide&mmasync=1`;
  const html = await fetchTextWithTimeout(url, 8000, { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" });
  const cards = parseBingImageCards(html);
  return {
    items: cards.map((c) => ({
      id: c.id,
      name: c.title,
      author: "全网超清精选",
      license: c.resolution || "2K/4K",
      type: "image",
      thumb: proxyImageUrl(c.thumb),
      url: proxyImageUrl(c.murl, c.thumb),
      resolution: c.resolution || "2K+",
    })),
    hasMore: cards.length >= 8,
  };
}

async function searchBingLiveGifs(q, pageNum = 1) {
  const kw = q ? `${q} 动态壁纸 唯美 gif` : "唯美 星空 樱花 赛博 风景 动态壁纸 gif";
  const first = (pageNum - 1) * 20;
  const url =
    `https://cn.bing.com/images/async?q=${encodeURIComponent(kw)}` +
    `&first=${first}&count=20&qft=+filterui:photo-animatedgif&mmasync=1`;
  const html = await fetchTextWithTimeout(url, 8000, { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" });
  const cards = parseBingImageCards(html);
  return {
    items: cards.map((c) => ({
      id: `blive-${c.id}`,
      name: c.title,
      description: "必应全网在线动态壁纸",
      author: "必应全网动图",
      license: "动态 GIF",
      type: "gif",
      thumb: proxyImageUrl(c.thumb),
      // Direct original GIF URL (with same-origin Referer in proxy) + Bing CDN thumb fallback
      url: proxyImageUrl(c.murl, c.thumb),
      resolution: "动态",
    })),
    hasMore: cards.length >= 10,
  };
}

async function searchBingGithubRepos(querySuffix, q, limit = 10) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(`site:github.com ${q} ${querySuffix}`)}&count=${limit}`;
  const html = await fetchTextWithTimeout(url, 7000, { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" });
  const repos = [];
  const seen = new Set();
  for (const m of html.matchAll(/href="(https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))"/g)) {
    const [, repoUrl, owner, repo] = m;
    if (["topics", "search", "explore", "features", "marketplace", "orgs", "settings"].includes(owner.toLowerCase())) continue;
    const full = `${owner}/${repo}`;
    if (seen.has(full.toLowerCase())) continue;
    seen.add(full.toLowerCase());
    repos.push({ owner, repo, full_name: full, html_url: repoUrl });
    if (repos.length >= limit) break;
  }
  return repos;
}

// ==================== ONLINE SEARCH: MCP STORE (OFFICIAL REGISTRY + NPM + GITHUB) ====================
function buildSmartMcpDescription(rawName, rawDesc, transportTag) {
  const clean = String(rawDesc || "").replace(/\s+/g, " ").trim();
  const low = `${rawName || ""} ${clean}`.toLowerCase();
  const hints = [
    [/docs|documentation|wiki|readme|guide|academy|learn/, "技术文档检索与知识查询服务"],
    [/browser|playwright|puppeteer|chrome|selenium|snag|devtools/, "浏览器自动化、网页调试与截图诊断工具"],
    [/sql|postgres|mysql|sqlite|mongo|redis|database|supabase/, "数据库结构查看与 SQL 查询分析工具"],
    [/git|github|gitlab|bitbucket|linear|jira/, "代码仓库、Issue 与项目管理协作工具"],
    [/search|fetch|crawl|scrape|tavily|exa|brave|web/, "联网实时搜索与网页内容抓取工具"],
    [/memory|graph|knowledge|rag|vector/, "持久化记忆与知识图谱检索工具"],
    [/file|fs|filesystem|drive|dropbox|s3/, "本地或云端文件读写与目录管理工具"],
    [/figma|canva|image|video|audio|3d|inference|ai/, "多模态 AI 生成与媒体处理工具"],
    [/slack|discord|notion|feishu|lark|mail|gmail|calendar/, "办公协作、消息通知与日程文档工具"],
    [/docker|k8s|kube|aws|cloudflare|vercel|netlify|deploy/, "云原生基础设施与自动化部署工具"],
  ];
  const matched = hints.find(([re]) => re.test(low))?.[1] || "公开 MCP 扩展工具服务";
  const protoNote =
    transportTag === "HTTP远程" || transportTag === "SSE远程"
      ? "远程直连"
      : transportTag === "uvx"
        ? "Python 本地"
        : "npx 本地";

  if (!clean || clean.length < 6) {
    return `${matched}（${protoNote}，一键接入即可供 Claude Code 调用）。`;
  }
  // If already contains Chinese, return concise text directly
  if (/[\u4e00-\u9fa5]/.test(clean)) {
    return clean.length > 120 ? clean.slice(0, 118) + "…" : clean;
  }
  const shortEn = clean.length > 110 ? clean.slice(0, 108) + "…" : clean;
  return `${matched}：${shortEn}`;
}

function parseRegistryMcpEntry(entry) {
  const s = entry?.server || entry;
  if (!s?.name) return null;
  const shortName = s.name.split("/").pop().replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "mcp";

  // 1) Remote Streamable-HTTP / SSE MCP
  const remote = (s.remotes || []).find((r) => r?.url);
  // 2) Local npm / pypi package
  const npmPkg = (s.packages || []).find((p) => p?.registryType === "npm" && p?.identifier);
  const pyPkg = (s.packages || []).find((p) => p?.registryType === "pypi" && p?.identifier);

  let command = "npx";
  let args = [];
  let transportTag = "npx";
  let badge = "npm";
  const envHints = [];

  if (npmPkg) {
    command = "npx";
    args = ["-y", npmPkg.identifier];
    transportTag = "npx";
    badge = "npx";
    for (const ev of npmPkg.environmentVariables || []) {
      if (ev?.name) envHints.push(ev.name);
    }
  } else if (pyPkg) {
    command = "uvx";
    args = [pyPkg.identifier];
    transportTag = "uvx";
    badge = "uvx";
    for (const ev of pyPkg.environmentVariables || []) {
      if (ev?.name) envHints.push(ev.name);
    }
  } else if (remote) {
    command = remote.type === "sse" ? "sse" : "http";
    args = [remote.url];
    transportTag = remote.type === "sse" ? "SSE远程" : "HTTP远程";
    badge = "远程";
  } else {
    return null;
  }

  return {
    id: `reg-${s.name.replace(/[^a-z0-9]/gi, "-")}`,
    name: shortName,
    title: `${s.name}${s.version ? ` · v${s.version}` : ""}`,
    description: buildSmartMcpDescription(s.name, s.description, transportTag),
    command,
    args,
    env_hints: envHints.slice(0, 6),
    repo_url: s.repository?.url || s.websiteUrl || "",
    badge,
    tags: [badge],
    source: "registry",
  };
}

export async function searchMcpStore(query = "", enginePref = "") {
  const q = String(query || "").trim();
  const engine = await resolveSearchEngine(enginePref);
  const cacheKey = `mcp|${engine.active}|${q.toLowerCase()}`;
  const cached = _storeQueryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 45_000) return cached.data;
  const localHits = q
    ? CURATED_MCPS.filter((m) =>
        `${m.name} ${m.title} ${m.description} ${(m.tags || []).join(" ")}`.toLowerCase().includes(q.toLowerCase()),
      )
    : CURATED_MCPS;

  const onlineItems = [];
  const errors = [];
  const tasks = [];

  if (engine.active === "cn") {
    // Domestic Direct Engine: Taobao npmmirror (covers 100% public npm MCPs at 300ms zero-proxy!) + Bing CN web search
    tasks.push(
      (async () => {
        try {
          const term = q ? `mcp ${q}` : "modelcontextprotocol server";
          const url = `https://registry.npmmirror.com/-/v1/search?text=${encodeURIComponent(term)}&size=24`;
          const data = await fetchJsonWithTimeout(url, 8000);
          for (const obj of data.objects || []) {
            const pkg = obj.package || {};
            if (!pkg.name) continue;
            onlineItems.push({
              id: `npmm-${pkg.name.replace(/[^a-z0-9]/gi, "-")}`,
              name: pkg.name.split("/").pop().replace(/^mcp-server-|^server-/, "") || pkg.name,
              title: `${pkg.name} · v${pkg.version || "latest"}`,
              description: buildSmartMcpDescription(pkg.name, pkg.description, "npx"),
              command: "npx",
              args: ["-y", pkg.name],
              env_hints: [],
              repo_url: pkg.links?.repository || pkg.links?.npm || "",
              badge: "npm",
              tags: ["npm"],
              source: "npmmirror",
            });
          }
        } catch (err) {
          errors.push(`国内npm镜像: ${err.message}`);
        }
      })(),
    );
    if (q) {
      tasks.push(
        (async () => {
          try {
            const repos = await searchBingGithubRepos("mcp server", q, 10);
            for (const r of repos) {
              onlineItems.push({
                id: `bmcp-${r.full_name.replace(/[^a-z0-9]/gi, "-")}`,
                name: r.repo.toLowerCase(),
                title: `${r.full_name} (必应全网)`,
                description: `必应全网检索到的 GitHub 公开 MCP 项目 (${r.full_name})，可一键安装或查看仓库。`,
                command: "npx",
                args: ["-y", r.repo],
                env_hints: [],
                repo_url: r.html_url,
                tags: ["必应全网", "GitHub"],
                source: "bing-cn",
              });
            }
          } catch {}
        })(),
      );
    }
  } else {
    // Global Proxy Engine: Official MCP Registry v0.1 (deduped latest versions) + npmjs + GitHub API
    tasks.push(
      (async () => {
        try {
          const regUrl = q
            ? `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(q)}&limit=20&version=latest`
            : `https://registry.modelcontextprotocol.io/v0.1/servers?limit=16&version=latest`;
          const data = await fetchJsonWithTimeout(regUrl, 8000);
          for (const entry of data.servers || []) {
            const parsed = parseRegistryMcpEntry(entry);
            if (parsed) onlineItems.push(parsed);
          }
        } catch (err) {
          errors.push(`官方Registry: ${err.message}`);
        }
      })(),
    );
    if (q) {
      tasks.push(
        (async () => {
          try {
            const npmUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`mcp ${q}`)}&size=14`;
            const npmData = await fetchJsonWithTimeout(npmUrl, 8000);
            for (const obj of npmData.objects || []) {
              const pkg = obj.package || {};
              if (!pkg.name) continue;
              onlineItems.push({
                id: `npm-${pkg.name.replace(/[^a-z0-9]/gi, "-")}`,
                name: pkg.name.split("/").pop().replace(/^mcp-server-|^server-/, "") || pkg.name,
                title: `${pkg.name} · v${pkg.version || "latest"}`,
                description: buildSmartMcpDescription(pkg.name, pkg.description, "npx"),
                command: "npx",
                args: ["-y", pkg.name],
                env_hints: [],
                repo_url: pkg.links?.repository || pkg.links?.npm || "",
                badge: "npm",
                tags: ["npm"],
                source: "npm",
              });
            }
          } catch (err) {
            errors.push(`npm: ${err.message}`);
          }
        })(),
      );
      tasks.push(
        (async () => {
          try {
            const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} mcp server`)}&sort=stars&per_page=10`;
            const ghData = await fetchJsonWithTimeout(ghUrl, 8000);
            for (const repo of ghData.items || []) {
              const isPy = String(repo.language || "").toLowerCase() === "python";
              onlineItems.push({
                id: `gh-${repo.id}`,
                name: repo.name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase(),
                title: repo.full_name,
                description: buildSmartMcpDescription(repo.full_name, repo.description, isPy ? "uvx" : "npx"),
                command: isPy ? "uvx" : "npx",
                args: isPy ? [repo.name] : ["-y", repo.name],
                env_hints: [],
                repo_url: repo.html_url,
                badge: `★${repo.stargazers_count || 0}`,
                tags: ["GitHub"],
                source: "github",
              });
            }
          } catch (err) {
            errors.push(`GitHub: ${err.message}`);
          }
        })(),
      );
    }
  }

  await Promise.all(tasks);

  const dedup = new Map();
  for (const item of [...localHits, ...onlineItems]) {
    const key = item.name + "::" + item.command + "::" + (item.args || []).join(" ");
    if (!dedup.has(key)) dedup.set(key, item);
  }
  const result = {
    ok: true,
    mode: q ? "online" : "curated+online",
    search_engine: engine,
    query: q,
    items: [...dedup.values()].slice(0, 36),
    online_error: errors.length && !onlineItems.length ? errors.join("；") : "",
  };
  if (onlineItems.length > 0) _storeQueryCache.set(cacheKey, { at: Date.now(), data: result });
  return result;
}

/**
 * Parse ANY public MCP input: Remote HTTP/SSE URL, npm package, uvx/PyPI package,
 * GitHub repo URL, or pasted JSON (`{"mcpServers": ...}`).
 */
export async function resolvePublicMcpImport(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("请输入公开 MCP 的包名、URL、GitHub 地址或 JSON 配置");

  // 1) JSON config block
  if (raw.startsWith("{")) {
    const obj = JSON.parse(raw);
    const map = obj.mcpServers || obj;
    const [firstName, cfg] = Object.entries(map)[0] || [];
    if (!firstName || !cfg) throw new Error("JSON 中未找到有效的 MCP 配置对象");
    if (cfg.url) {
      return {
        name: firstName,
        description: `JSON 导入远程 MCP (${cfg.url})`,
        command: cfg.type === "sse" ? "sse" : "http",
        args: [cfg.url],
        env: cfg.headers || cfg.env || {},
      };
    }
    return {
      name: firstName,
      description: `JSON 导入本地 MCP (${cfg.command || "npx"})`,
      command: cfg.command || "npx",
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env || {},
    };
  }

  // 2) Remote HTTP/SSE MCP endpoint (not github.com)
  if (/^https?:\/\//i.test(raw) && !/github\.com\//i.test(raw)) {
    const u = new URL(raw);
    const name = u.hostname.replace(/^mcp\./, "").split(".")[0] || "remote-mcp";
    const isSse = /sse/i.test(u.pathname);
    return {
      name,
      description: `远程公开 MCP 服务 (${raw})`,
      command: isSse ? "sse" : "http",
      args: [raw],
      env: {},
    };
  }

  // 3) GitHub repository URL -> inspect package.json / pyproject.toml
  const ghMatch = raw.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (ghMatch) {
    const owner = ghMatch[1];
    const repo = ghMatch[2].replace(/\.git$/i, "");
    let description = `GitHub 公开 MCP (${owner}/${repo})`;
    let command = "npx";
    let args = ["-y", repo];
    try {
      const meta = await fetchJsonWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, 6000);
      if (meta.description) description = meta.description;
      const br = meta.default_branch || "main";
      try {
        const pkg = await fetchJsonWithTimeout(`https://raw.githubusercontent.com/${owner}/${repo}/${br}/package.json`, 5000);
        if (pkg?.name) {
          command = "npx";
          args = ["-y", pkg.name];
        }
      } catch {
        if (String(meta.language || "").toLowerCase() === "python") {
          command = "uvx";
          args = [repo];
        }
      }
    } catch {}
    return { name: repo.toLowerCase(), description, command, args, env: {} };
  }

  // 4) Direct command line (e.g. `npx -y @org/pkg` or `uvx mcp-server-git`)
  if (/^(npx|uvx|node|python|python3|docker)\s+/i.test(raw)) {
    const parts = raw.split(/\s+/);
    const name = parts[parts.length - 1].split("/").pop().replace(/@.*$/, "").replace(/[^a-z0-9_-]/gi, "-") || "custom-mcp";
    return { name, description: `命令行 MCP: ${raw}`, command: parts[0], args: parts.slice(1), env: {} };
  }

  // 5) Plain npm package name (e.g. `@modelcontextprotocol/server-postgres`)
  const name = raw.split("/").pop().replace(/@.*$/, "").replace(/^mcp-server-|^server-/, "") || "mcp";
  return { name, description: `公开 npm MCP 包 (${raw})`, command: "npx", args: ["-y", raw], env: {} };
}

// ==================== ONLINE SEARCH: SKILLS STORE (OFFICIAL ANTHROPIC + GITHUB + ANY PUBLIC URL) ====================
let _cachedOfficialSkills = null;
let _cachedOfficialAt = 0;

function parseSkillFrontmatter(mdText) {
  const m = String(mdText || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
    if (kv) out[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const OFFICIAL_SKILL_DESC_ZH = {
  "algorithmic-art": "使用 p5.js 创作生成式算法艺术、参数化视觉图案与交互式代码画作。",
  "brand-guidelines": "按统一品牌视觉规范自动整理配色、字体层级与排版设计标准。",
  "canvas-design": "面向海报、封面、信息图与视觉排版的高水准设计创作技能。",
  "claude-api": "基于最新 Anthropic / Claude API、Tool Use 与流式 SDK 编写规范应用。",
  "doc-coauthoring": "结构化协作撰写技术方案、PRD 需求文档与长篇报告。",
  "docx": "专业创建、修改、审阅与格式化 Word (.docx) 文档（支持批注与修订）。",
  "frontend-design": "打造高完成度、拒绝模板味的现代前端界面、微动效与响应式布局。",
  "internal-comms": "高效起草团队周报、项目同步、发布公告与内部沟通文档。",
  "mcp-builder": "按最佳实践设计、开发并调试自定义 Model Context Protocol (MCP) 服务端。",
  "pdf": "提取、合并、拆分、填表与精排版生成 PDF 文档的专业处理技能。",
  "pptx": "自动规划页面结构、排版视觉并生成高质量 PowerPoint (.pptx) 演示文稿。",
  "skill-creator": "快速设计、编写、验证与打磨自定义 Agent SKILL.md 技能包。",
  "slack-gif-creator": "编写代码生成循环流畅、适合聊天分享的精致动态 GIF 动图。",
  "theme-factory": "一键为网页、幻灯片或文档套用风格统一的精选视觉主题方案。",
  "web-artifacts-builder": "构建包含 React/Tailwind/状态交互的独立单页交互式 Web 应用。",
  "webapp-testing": "使用 Playwright 自动启动、操作、截图并端到端测试本地 Web 应用。",
  "xlsx": "专业读取、建模、公式计算、图表可视化并生成 Excel (.xlsx) 电子表格。",
};

function buildSmartSkillDescription(slug, name, rawDesc) {
  const key = String(slug || "").toLowerCase();
  if (OFFICIAL_SKILL_DESC_ZH[key]) return OFFICIAL_SKILL_DESC_ZH[key];
  const clean = String(rawDesc || "").replace(/\s+/g, " ").trim();
  const low = `${slug || ""} ${name || ""} ${clean}`.toLowerCase();
  const hints = [
    [/review|lint|audit|security/, "代码质量审查、安全隐患排查与重构建议技能"],
    [/test|qa|playwright|jest|vitest|pytest/, "自动化测试生成与端到端回归验证技能"],
    [/doc|readme|markdown|write|blog|note/, "技术文档、说明手册与结构化写作技能"],
    [/ui|ux|css|frontend|design|react|vue|tailwind/, "前端界面设计、样式美化与组件开发技能"],
    [/git|pr|commit|release|ci|deploy/, "Git 工作流、发布流程与工程自动化技能"],
    [/debug|fix|bug|trace|log|perf/, "系统化问题定位、日志分析与性能优化技能"],
    [/pdf|docx|pptx|xlsx|csv|excel|word/, "办公文档解析、排版与数据表格处理技能"],
    [/data|sql|chart|plot|python|ml|ai/, "数据分析、脚本处理与可视化建模技能"],
  ];
  const matched = hints.find(([re]) => re.test(low))?.[1] || "公开 Agent 扩展技能（安装后支持 /命令 调用）";
  if (!clean || clean.length < 6) {
    return `${matched}，点击下载 SKILL.md 并立即启用。`;
  }
  if (/[\u4e00-\u9fa5]/.test(clean)) {
    return clean.length > 110 ? clean.slice(0, 108) + "…" : clean;
  }
  const shortEn = clean.length > 100 ? clean.slice(0, 98) + "…" : clean;
  return `${matched}：${shortEn}`;
}

async function fetchAnthropicOfficialSkills(engineActive = "cn") {
  if (_cachedOfficialSkills && Date.now() - _cachedOfficialAt < 30 * 60 * 1000) {
    return _cachedOfficialSkills;
  }
  // 1) Domestic-friendly jsDelivr CDN index (works cleanly without VPN!)
  try {
    const jsd = await fetchJsonWithTimeout("https://data.jsdelivr.com/v1/packages/gh/anthropics/skills@main", 7000);
    const skillsDir = (jsd.files || []).find((f) => f.type === "directory" && f.name === "skills");
    const dirs = (skillsDir?.files || []).filter((f) => f.type === "directory" && f.name);
    if (dirs.length) {
      const list = dirs.slice(0, 20).map((d) => {
        const slug = d.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        return {
          id: `anth-skill-${d.name}`,
          slug,
          name: d.name,
          description: buildSmartSkillDescription(slug, d.name, ""),
          source_url: `https://github.com/anthropics/skills/tree/main/skills/${d.name}`,
          raw_skill_url: `https://cdn.jsdelivr.net/gh/anthropics/skills@main/skills/${d.name}/SKILL.md`,
          github_full_name: "anthropics/skills",
          default_branch: "main",
          badge: "官方",
          tags: ["官方"],
          content: "",
        };
      });
      _cachedOfficialSkills = list;
      _cachedOfficialAt = Date.now();
      return list;
    }
  } catch {}

  if (engineActive === "proxy") {
    try {
      const dirs = await fetchJsonWithTimeout("https://api.github.com/repos/anthropics/skills/contents/skills", 7000);
      if (Array.isArray(dirs)) {
        const list = dirs
          .filter((d) => d.type === "dir" && d.name)
          .slice(0, 20)
          .map((d) => {
            const slug = d.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
            return {
              id: `anth-skill-${d.name}`,
              slug,
              name: d.name,
              description: buildSmartSkillDescription(slug, d.name, ""),
              source_url: d.html_url || `https://github.com/anthropics/skills/tree/main/skills/${d.name}`,
              raw_skill_url: `https://raw.githubusercontent.com/anthropics/skills/main/skills/${d.name}/SKILL.md`,
              github_full_name: "anthropics/skills",
              default_branch: "main",
              badge: "官方",
              tags: ["官方"],
              content: "",
            };
          });
        _cachedOfficialSkills = list;
        _cachedOfficialAt = Date.now();
        return list;
      }
    } catch {}
  }
  return [];
}

export async function searchSkillsStore(query = "", enginePref = "") {
  const q = String(query || "").trim();
  const engine = await resolveSearchEngine(enginePref);
  const official = await fetchAnthropicOfficialSkills(engine.active);
  const baseCatalog = [...CURATED_SKILLS, ...official];

  if (!q) {
    return {
      ok: true,
      mode: "curated+official",
      search_engine: engine,
      items: baseCatalog,
      online_note: "已加载精选与官方开源 Skills，输入关键词可全网实时搜索公开 Skills",
    };
  }

  const localHits = baseCatalog.filter((s) =>
    `${s.name} ${s.slug} ${s.description} ${(s.tags || []).join(" ")}`.toLowerCase().includes(q.toLowerCase()),
  );

  const onlineItems = [];
  let onlineError = "";

  if (engine.active === "cn") {
    // Domestic Direct Engine: Taobao npmmirror Skills + Bing CN web search (zero proxy needed!)
    try {
      const npmData = await fetchJsonWithTimeout(
        `https://registry.npmmirror.com/-/v1/search?text=${encodeURIComponent(`claude skill ${q}`)}&size=18`,
        8000,
      );
      for (const obj of npmData.objects || []) {
        const pkg = obj.package || {};
        if (!pkg.name) continue;
        const repoUrl = pkg.links?.repository || pkg.links?.homepage || pkg.links?.npm || "";
        const ghMatch = repoUrl.match(/github\.com\/([^/]+\/[^/#?]+)/i);
        const slug = pkg.name.split("/").pop().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
        onlineItems.push({
          id: `npmm-sk-${pkg.name.replace(/[^a-z0-9]/gi, "-")}`,
          slug,
          name: `${pkg.name} · v${pkg.version || "latest"}`,
          description: buildSmartSkillDescription(slug, pkg.name, pkg.description),
          source_url: repoUrl,
          github_full_name: ghMatch ? ghMatch[1].replace(/\.git$/i, "") : "",
          default_branch: "main",
          badge: "npm",
          tags: ["npm"],
          content: "",
        });
      }
    } catch (err) {
      onlineError = `国内镜像检索失败: ${err.message}`;
    }
  } else {
    try {
      const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} (claude-skill OR agent-skill OR "SKILL.md" OR claude skill)`)}&sort=stars&per_page=14`;
      const ghData = await fetchJsonWithTimeout(ghUrl, 8500);
      for (const repo of ghData.items || []) {
        onlineItems.push({
          id: `gh-skill-${repo.id}`,
          slug: repo.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
          name: repo.name,
          description: buildSmartSkillDescription(repo.name, repo.full_name, repo.description),
          source_url: repo.html_url,
          github_full_name: repo.full_name,
          default_branch: repo.default_branch || "main",
          badge: `★${repo.stargazers_count || 0}`,
          tags: ["GitHub"],
          content: "",
        });
      }
    } catch (err) {
      onlineError = `GitHub Skills 联网搜索受限: ${err.message}`;
      logEvent("WARN", "stores", "skills_search_err", onlineError);
    }
  }

  const dedup = new Map();
  for (const it of [...localHits, ...onlineItems]) {
    if (!dedup.has(it.slug)) dedup.set(it.slug, it);
  }
  return {
    ok: true,
    mode: "online",
    search_engine: engine,
    query: q,
    items: [...dedup.values()].slice(0, 28),
    online_error: onlineError,
  };
}

/**
 * Download SKILL.md (or README.md fallback) via BOTH jsDelivr CDN (works in China direct!) & GitHub raw.
 */
export async function downloadRemoteSkillContent(item) {
  if (item.content && item.content.trim()) return item.content;
  const candidates = [];
  if (item.raw_skill_url) candidates.push(item.raw_skill_url);
  if (item.github_full_name) {
    const branch = item.default_branch || "main";
    const gh = item.github_full_name;
    // Try domestic-accessible jsDelivr CDN first, then raw.githubusercontent.com
    candidates.push(
      `https://cdn.jsdelivr.net/gh/${gh}@${branch}/SKILL.md`,
      `https://cdn.jsdelivr.net/gh/${gh}@${branch}/skills/${item.slug}/SKILL.md`,
      `https://raw.githubusercontent.com/${gh}/${branch}/SKILL.md`,
      `https://raw.githubusercontent.com/${gh}/${branch}/skills/${item.slug}/SKILL.md`,
      `https://cdn.jsdelivr.net/gh/${gh}@${branch}/README.md`,
      `https://raw.githubusercontent.com/${gh}/${branch}/README.md`,
    );
  }
  for (const url of candidates) {
    try {
      const txt = await fetchTextWithTimeout(url, 7000);
      if (txt.trim().length > 20) return txt.slice(0, 24000);
    } catch {}
  }
  return `# ${item.name}\n\n来源: ${item.source_url || ""}\n\n${item.description || ""}`;
}

export async function importPublicSkillFromUrl(rawUrl) {
  const clean = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error("请输入以 http:// 或 https:// 开头的公开 GitHub 仓库或 SKILL.md 链接");

  let fetchUrls = [clean];
  let fallbackSlug = "imported-skill";

  // Convert github.com/owner/repo/blob/branch/path -> raw.githubusercontent.com
  const blobMatch = clean.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)/i);
  const treeMatch = clean.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/i);
  const repoMatch = clean.match(/github\.com\/([^/]+)\/([^/#?]+)\/?$/i);

  if (blobMatch) {
    fetchUrls = [`https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}/${blobMatch[4]}`];
    fallbackSlug = blobMatch[4].split("/").slice(-2, -1)[0] || blobMatch[2];
  } else if (treeMatch) {
    const sub = treeMatch[4].replace(/\/$/, "");
    fetchUrls = [
      `https://raw.githubusercontent.com/${treeMatch[1]}/${treeMatch[2]}/${treeMatch[3]}/${sub}/SKILL.md`,
      `https://raw.githubusercontent.com/${treeMatch[1]}/${treeMatch[2]}/${treeMatch[3]}/${sub}/README.md`,
    ];
    fallbackSlug = sub.split("/").pop() || treeMatch[2];
  } else if (repoMatch) {
    const [, owner, repoRaw] = repoMatch;
    const repo = repoRaw.replace(/\.git$/i, "");
    fallbackSlug = repo;
    fetchUrls = [
      `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
      `https://raw.githubusercontent.com/${owner}/${repo}/master/SKILL.md`,
      `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`,
    ];
  }

  let content = "";
  for (const u of fetchUrls) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      const r = await fetch(u, { headers: { "User-Agent": USER_AGENT }, signal: c.signal });
      clearTimeout(t);
      if (r.ok) {
        const txt = await r.text();
        if (txt.trim().length > 15) {
          content = txt.slice(0, 24000);
          break;
        }
      }
    } catch {}
  }
  if (!content) throw new Error("未能从该链接读取到 SKILL.md 或 Markdown 说明，请确认链接公开可访问");

  const fm = parseSkillFrontmatter(content);
  const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const slug = String(fm.name || fallbackSlug).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "custom-skill";
  const name = fm.title || h1 || fm.name || fallbackSlug;
  const description = fm.description || content.replace(/^---[\s\S]*?---/, "").replace(/[#>*`\n]+/g, " ").trim().slice(0, 140);

  return { slug, name, description, source_url: clean, content, enabled: true };
}

// ==================== ONLINE SEARCH: MASSIVE OPEN WALLPAPER + LIVE VIDEO STORE ====================
async function searchOnlineLiveVideos(q, translated, pageNum) {
  const words = String(translated || q || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Wikimedia treats spaces as strict AND; use focused OR/single term so video hits are plentiful!
  const searchTerms = !words.length
    ? "timelapse"
    : words.length === 1
      ? words[0]
      : `(${words.slice(0, 3).join(" OR ")})`;
  const offset = (pageNum - 1) * 12;
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*` +
    `&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(`${searchTerms} filetype:video`)}` +
    `&gsrlimit=14&gsroffset=${offset}` +
    `&prop=videoinfo&viprop=url|size|mime&viurlwidth=480`;
  const data = await fetchJsonWithTimeout(url, 9000);
  const items = [];
  for (const pg of Object.values(data?.query?.pages || {})) {
    const info = pg.videoinfo?.[0];
    if (!info?.url || !/webm|mp4|ogv|ogg/i.test(info.mime || info.url)) continue;
    // Prefer modern webm/mp4 playable directly in Chrome/Edge/Electron <video>
    if (!/webm|mp4/i.test(info.mime || info.url)) continue;
    if (info.size && info.size > 65 * 1024 * 1024) continue;
    const cleanUrl = info.url.split("?")[0];
    const cleanThumb = (info.thumburl || "").split("?")[0];
    const cleanName = String(pg.title || "")
      .replace(/^File:/i, "")
      .replace(/\.[^.]+$/, "")
      .replace(/_/g, " ")
      .slice(0, 46);
    const dur = info.duration ? `${Math.round(info.duration)}s` : "";
    const resStr = info.width && info.height ? `${info.width}×${info.height}` : "动态视频";
    items.push({
      id: `wmvid-${pg.pageid}`,
      name: cleanName || "在线动态壁纸",
      author: "Wikimedia Video",
      license: [dur, resStr].filter(Boolean).join(" · ") || "CC",
      type: "video",
      thumb: cleanThumb ? proxyImageUrl(cleanThumb) : "",
      url: proxyImageUrl(cleanUrl),
      resolution: resStr,
    });
  }
  return {
    items,
    hasMore: Boolean(data?.continue?.gsroffset),
  };
}

let _wallhavenCooldownUntil = 0;

export async function searchWallpaperStore(query = "", page = 1, category = "all", enginePref = "") {
  const q = String(query || "").trim();
  const pageNum = Math.max(1, Number(page) || 1);
  const translated = translateWallpaperQuery(q);
  const engine = await resolveSearchEngine(enginePref);

  // ==================== OFFICIAL BING DAILY 4K UHD DEDICATED TAB ====================
  if (category === "bing_uhd") {
    const uhdAll = await fetchBingOfficialUhdWallpapers();
    const ql = q.toLowerCase();
    const filtered = ql
      ? uhdAll.filter((w) => `${w.name} ${w.description || ""} ${(w.tags || []).join(" ")}`.toLowerCase().includes(ql))
      : uhdAll;
    return {
      ok: true,
      mode: "bing-official-uhd",
      search_engine: engine,
      page: 1,
      last_page: 1,
      total_online: filtered.length,
      has_more: false,
      items: filtered,
      online_error: filtered.length ? "" : "暂未获取到必应官方每日 4K 壁纸，请检查网络连接",
    };
  }

  // ==================== LIVE WALLPAPERS (14x 60fps + DOMESTIC BING LIVE GIF / PROXY WIKIMEDIA VIDEO) ====================
  if (category === "live") {
    const ql = q.toLowerCase();
    const localLive =
      pageNum === 1
        ? LIVE_WALLPAPERS.filter(
            (w) =>
              !ql ||
              `${w.name} ${w.description || ""} ${(w.tags || []).join(" ")}`.toLowerCase().includes(ql),
          )
        : [];
    const onlineLive = [];
    let hasMore = false;
    let onlineError = "";

    if (engine.active === "cn") {
      try {
        const bres = await searchBingLiveGifs(q, pageNum);
        onlineLive.push(...bres.items);
        hasMore = bres.hasMore;
      } catch (err) {
        onlineError = `国内动态壁纸搜索失败: ${err.message}`;
      }
    } else {
      // Global Proxy mode: run Wikimedia loop videos + Bing full-web live GIFs in parallel!
      const [wmRes, bingRes] = await Promise.allSettled([
        searchOnlineLiveVideos(q, translated, pageNum),
        searchBingLiveGifs(q, pageNum),
      ]);
      if (wmRes.status === "fulfilled") {
        onlineLive.push(...wmRes.value.items);
        hasMore = hasMore || wmRes.value.hasMore;
      }
      if (bingRes.status === "fulfilled") {
        onlineLive.push(...bingRes.value.items);
        hasMore = hasMore || bingRes.value.hasMore;
      }
      if (!onlineLive.length) {
        onlineError = "在线动态壁纸检索超时，请重试或切换搜索引擎模式";
      }
    }

    return {
      ok: true,
      mode: "live+online",
      search_engine: engine,
      page: pageNum,
      last_page: hasMore ? pageNum + 1 : pageNum,
      total_online: localLive.length + onlineLive.length,
      has_more: hasMore,
      items: [...localLive, ...onlineLive],
      online_error: onlineError,
    };
  }

  // ==================== STATIC 4K WALLPAPERS (DOMESTIC BING CN vs GLOBAL WALLHAVEN + BING) ====================
  const onlineItems = [];
  let onlineError = "";
  let lastPage = pageNum + 1;
  let totalCount = 0;

  if (engine.active === "cn") {
    try {
      const bres = await searchBingWallpapers(q, pageNum, category);
      onlineItems.push(...bres.items);
      lastPage = bres.hasMore ? pageNum + 9 : pageNum;
    } catch (err) {
      onlineError = `国内全网壁纸搜索失败: ${err.message}`;
    }
  } else {
    // Global Proxy Mode: Wallhaven 4K first (with 3.5s fast-fail & 5-min cooldown), seamlessly supplemented by Bing Full-Web!
    if (Date.now() >= _wallhavenCooldownUntil) {
      try {
        const whParams = new URLSearchParams({
          purity: "100",
          page: String(pageNum),
          sorting: translated ? "relevance" : "toplist",
          ratios: "16x9,16x10,21x9",
        });
        if (translated) whParams.set("q", translated);
        else if (category === "anime") whParams.set("categories", "010");
        else if (category === "scenery") whParams.set("q", "landscape nature");
        else whParams.set("categories", "110");

        const whUrl = `https://wallhaven.cc/api/v1/search?${whParams.toString()}`;
        const data = await fetchJsonWithTimeout(whUrl, 3500);
        lastPage = Number(data?.meta?.last_page || 1);
        totalCount = Number(data?.meta?.total || 0);

        for (const item of data?.data || []) {
          const thumb = item.thumbs?.small || item.path;
          const full = item.path;
          if (!thumb || !full) continue;
          onlineItems.push({
            id: `wh-${item.id}`,
            name: `${item.category || "HD"} · ${item.resolution || "4K"}`,
            author: "Wallhaven 4K",
            license: item.resolution || "HD",
            type: "image",
            thumb: proxyImageUrl(thumb),
            url: proxyImageUrl(full),
            resolution: item.resolution || "",
            colors: item.colors || [],
          });
        }
      } catch (err) {
        _wallhavenCooldownUntil = Date.now() + 5 * 60 * 1000;
        onlineError = `Wallhaven 超时，已自动切至必应全网补齐 (${err.message})`;
        logEvent("WARN", "stores", "wallhaven_fallback_bing", onlineError);
      }
    }

    // If Wallhaven timed out or returned few hits, supplement seamlessly with Bing Full-Web!
    if (onlineItems.length < 8) {
      try {
        const bres = await searchBingWallpapers(q, pageNum, category);
        onlineItems.push(...bres.items);
        if (bres.hasMore && lastPage <= pageNum) lastPage = pageNum + 5;
        if (onlineItems.length > 0) onlineError = "";
      } catch {}
    }
  }

  const officialUhd =
    pageNum === 1 && !q && (category === "all" || category === "scenery")
      ? (await fetchBingOfficialUhdWallpapers()).slice(0, category === "scenery" ? 10 : 8)
      : [];
  const baseItems =
    pageNum === 1 && !q && category === "all"
      ? [CURATED_WALLPAPERS[0], ...officialUhd, ...CURATED_WALLPAPERS.slice(1)]
      : officialUhd;
  return {
    ok: true,
    mode: q ? "online" : "curated+online",
    search_engine: engine,
    query: q,
    translated_query: translated,
    page: pageNum,
    last_page: lastPage,
    total_online: totalCount,
    has_more: pageNum < lastPage && onlineItems.length > 0,
    items: [...baseItems, ...onlineItems],
    online_error: onlineError,
  };
}
