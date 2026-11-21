/* ==========================================================================
   OpenCode Studio — Frontend Application
   ========================================================================== */

(() => {
  "use strict";

  const DRAFT_PREFIX = "ocs_draft_";

  const PROMPT_PRESETS = {
    default: `你是 OpenCode Studio 内置的开源透明 AI 编程与效率助手。\n核心工作原则：\n1. 默认使用简体中文与用户清晰交流，结论先行、简洁精准。\n2. 修改文件或执行有副作用的命令前，先查看现状，做到精准最小改动。\n3. 善用工具读取文件、编辑代码、搜索项目和运行验证命令，不要凭空臆测文件内容或运行结果。\n4. 如遇报错，清晰说明根因、影响范围和下一步修复方案。`,
    tutor: `你是一位耐心的编程教学导师（面向学生）。\n1. 先用通俗直白的比喻解释原理，再给最小可运行代码示例。\n2. 遇到报错时，带领学生读懂报错第一行与根因，而不是只丢黑盒代码。\n3. 全程使用简体中文，语气鼓励、条理清晰。`,
    minimal: `你是用户的个人开源 AI 助手，请使用简体中文直接、高效地完成用户的开发与分析任务，必要时主动调用工具核实事实。`,
  };

  const state = {
    ws: null,
    wsConnected: false,
    reconnectTimer: null,

    version: "1.0.0",
    settings: {},
    providers: [],
    activeProvider: null,
    claudeNative: null,

    installedMcps: [],
    installedSkills: [],
    customBackgrounds: [],

    sessions: [],
    cwds: [],
    runningIds: new Set(),

    activeSessionId: null,
    activeTimeline: null,
    activeCwd: "",
    liveStream: new Map(), // sessionId -> { model, provider_name, engine, blocks, error }
    attachments: [],

    // Editing states
    editingMessageId: null,
    selectedProviderId: null,
    selectedMemory: null,
    memories: [],

    // Drawer & find
    drawerOpen: false,
    drawerTab: "outline",
    findMatches: [],
    findIndex: -1,

    // Autocomplete
    acOpen: false,
    acStartPos: 0,
    acItems: [],
    acIndex: 0,
    acTimer: null,

    // Confirm modal
    activeConfirmId: null,
    cwdBrowsePath: "",
    activeStoreTab: "mcp",
    activeLogTab: "server",
  };

  const $ = (id) => document.getElementById(id);

  // ==================== HELPERS ====================

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtTokens(n) {
    if (!n || n <= 0) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
  }

  function fmtRelTime(iso) {
    const ms = Date.parse(iso || "");
    if (!ms) return "";
    const min = Math.floor((Date.now() - ms) / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} 天前`;
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmtClock(iso) {
    const d = new Date(iso || "");
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function toast(msg, ms = 2600) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    $("toast-root").appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.2s";
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  async function copyText(txt, okMsg = "已复制") {
    try {
      await navigator.clipboard.writeText(txt);
      toast(okMsg);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast(okMsg);
    }
  }

  async function apiJson(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data?.error?.title || data?.error?.cause || data?.error || `HTTP ${res.status}`;
      const e = new Error(errMsg);
      e.payload = data;
      throw e;
    }
    return data;
  }

  function autoResizeComposer() {
    const el = $("composer-input");
    if (!el.value) {
      el.style.height = "44px";
      return;
    }
    el.style.height = "44px";
    el.style.height = Math.min(Math.max(el.scrollHeight, 44), 200) + "px";
  }

  function saveDraft() {
    try {
      const k = DRAFT_PREFIX + (state.activeSessionId || "new");
      const v = $("composer-input").value;
      if (v) localStorage.setItem(k, v);
      else localStorage.removeItem(k);
    } catch {}
  }

  function restoreDraft() {
    try {
      const k = DRAFT_PREFIX + (state.activeSessionId || "new");
      $("composer-input").value = localStorage.getItem(k) || "";
      autoResizeComposer();
    } catch {}
  }

  function isNearBottom() {
    const sc = $("messages-scroll");
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
  }

  function scrollToBottom(smooth = false) {
    const sc = $("messages-scroll");
    const doScroll = () => {
      sc.scrollTo({ top: sc.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    };
    doScroll();
    requestAnimationFrame(doScroll);
  }

  // ==================== APPEARANCE & WALLPAPER ====================

  function applyAppearance(ap = {}) {
    const theme = ap.theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--font-size-base", `${ap.fontSize || 14.5}px`);
    document.documentElement.style.setProperty("--bg-blur", `${ap.bgBlur ?? 8}px`);

    const layer = $("wallpaper-layer");
    const hasBg = ap.bgType && ap.bgType !== "none" && ap.bgUrl;
    if (hasBg) {
      document.body.classList.add("has-wallpaper");
      document.documentElement.style.setProperty("--glass-alpha", String(ap.bgOpacity ?? 0.86));
      if (ap.bgType === "gradient" || ap.bgUrl.startsWith("linear-gradient") || ap.bgUrl.startsWith("radial-gradient")) {
        layer.style.backgroundImage = ap.bgUrl;
      } else {
        layer.style.backgroundImage = `url("${ap.bgUrl.replace(/"/g, '\\"')}")`;
      }
    } else {
      document.body.classList.remove("has-wallpaper");
      document.documentElement.style.setProperty("--glass-alpha", "0.98");
      layer.style.backgroundImage = "none";
    }

    // Sync appearance controls in store modal
    $("ap-theme").value = theme;
    $("ap-fontsize").value = String(ap.fontSize || 14.5);
    $("ap-fontsize-val").textContent = `${ap.fontSize || 14.5}px`;
    $("ap-blur").value = String(ap.bgBlur ?? 8);
    $("ap-blur-val").textContent = `${ap.bgBlur ?? 8}px`;
    $("ap-opacity").value = String(ap.bgOpacity ?? 0.86);
    $("ap-opacity-val").textContent = `${Math.round((ap.bgOpacity ?? 0.86) * 100)}%`;
  }

  let apSaveTimer = null;
  function updateAppearance(patch) {
    const next = { ...(state.settings.appearance || {}), ...patch };
    state.settings.appearance = next;
    applyAppearance(next);
    clearTimeout(apSaveTimer);
    apSaveTimer = setTimeout(() => {
      apiJson("/api/settings", { method: "PUT", body: JSON.stringify({ appearance: next }) }).catch(() => {});
    }, 260);
  }

  // ==================== SAFE GFM MARKDOWN ====================

  function renderInlineMd(raw) {
    let s = escHtml(raw);
    const slots = [];
    s = s.replace(/`([^`\n]+)`/g, (_, inner) => {
      const idx = slots.length;
      slots.push(`<code>${inner}</code>`);
      return `\x00C${idx}\x00`;
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    return s.replace(/\x00C(\d+)\x00/g, (_, i) => slots[Number(i)]);
  }

  function renderMarkdown(md) {
    if (!md) return "";
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```([\w.+-]*)\s*$/);
      if (fence) {
        const lang = fence[1] || "text";
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        const rawCode = codeLines.join("\n");
        out.push(
          `<div class="md-code-block"><div class="md-code-head"><span>${escHtml(lang)}</span>` +
            `<button class="md-code-copy" data-code="${encodeURIComponent(rawCode)}">复制代码</button></div>` +
            `<pre><code>${escHtml(rawCode)}</code></pre></div>`,
        );
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const h = line.match(/^(#{1,4})\s+(.+)$/);
      if (h) { out.push(`<h${h[1].length}>${renderInlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^([-*_])\1{2,}\s*$/.test(line.trim())) { out.push("<hr />"); i++; continue; }
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        const splitRow = (r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const heads = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(
          `<table><thead><tr>${heads.map((x) => `<th>${renderInlineMd(x)}</th>`).join("")}</tr></thead><tbody>` +
            rows.map((r) => `<tr>${heads.map((_, idx) => `<td>${renderInlineMd(r[idx] || "")}</td>`).join("")}</tr>`).join("") +
            `</tbody></table>`,
        );
        continue;
      }
      if (line.startsWith(">")) {
        const q = [];
        while (i < lines.length && lines[i].startsWith(">")) { q.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push(`<blockquote>${renderMarkdown(q.join("\n"))}</blockquote>`);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(`<li>${renderInlineMd(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join("")}</ul>`);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${renderInlineMd(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
          i++;
        }
        out.push(`<ol>${items.join("")}</ol>`);
        continue;
      }
      const p = [];
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !lines[i].match(/^#{1,4}\s+/) && !lines[i].startsWith(">") && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        p.push(lines[i]);
        i++;
      }
      out.push(`<p>${p.map(renderInlineMd).join("<br />")}</p>`);
    }
    return out.join("");
  }

  function highlightHtml(text, query) {
    const safe = escHtml(text);
    if (!query) return safe;
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return safe.replace(new RegExp(`(${esc})`, "gi"), '<mark class="search-hl">$1</mark>');
  }

  // ==================== PROVIDER & MODEL SELECTORS (ADAPTIVE THINKING) ====================

  function getSelectedProvider() {
    const pid = $("provider-select").value;
    return state.providers.find((p) => p.id === pid) || state.activeProvider || state.providers[0] || null;
  }

  function getSelectedModelInfo() {
    const prov = getSelectedProvider();
    const mid = $("model-select").value;
    return prov?.model_infos?.find((m) => m.id === mid) || null;
  }

  function renderComposerSelectors(preferredProviderId = "", preferredModel = "", preferredThinking = "") {
    const pSel = $("provider-select");
    pSel.innerHTML = "";
    for (const p of state.providers) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      pSel.appendChild(opt);
    }
    const chosenPid =
      (preferredProviderId && state.providers.some((p) => p.id === preferredProviderId) ? preferredProviderId : null) ||
      state.activeProvider?.id ||
      state.providers[0]?.id ||
      "";
    if (chosenPid) pSel.value = chosenPid;

    const prov = getSelectedProvider();
    // Sidebar card
    if (prov) {
      const isConfigured = prov.kind === "claude_native" ? Boolean(state.claudeNative?.installed) : Boolean(prov.has_api_key || prov.base_url);
      $("sidebar-prov-dot").className = "status-dot " + (isConfigured ? "ok" : "warn");
      $("sidebar-prov-name").textContent = prov.name;
      $("sidebar-prov-kind").textContent = prov.kind === "claude_native" ? "原生登录" : prov.kind.toUpperCase();
    } else {
      $("sidebar-prov-dot").className = "status-dot warn";
      $("sidebar-prov-name").textContent = "未配置供应商";
      $("sidebar-prov-kind").textContent = "去添加";
    }

    // Populate models directly showing the chosen provider's real model names + context window
    const mSel = $("model-select");
    mSel.innerHTML = "";
    const infos = prov?.model_infos || [];
    if (!infos.length) {
      const opt = document.createElement("option");
      opt.value = prov?.default_model || "";
      opt.textContent = prov?.default_model || "请先在供应商管理拉取/添加模型";
      mSel.appendChild(opt);
    } else {
      for (const info of infos) {
        const opt = document.createElement("option");
        opt.value = info.id;
        const ctxTag = fmtTokens(info.context_window);
        const thinkMark = info.thinking_supported ? " · 思考" : "";
        opt.textContent = `${info.display_name}${ctxTag ? ` [${ctxTag}]` : ""}${thinkMark}`;
        mSel.appendChild(opt);
      }
      const targetModel =
        (preferredModel && infos.some((i) => i.id === preferredModel) ? preferredModel : null) ||
        prov.default_model ||
        infos[0].id;
      mSel.value = targetModel;
    }

    updateThinkingSelector(preferredThinking);
  }

  function updateThinkingSelector(preferredThinking = "") {
    const prov = getSelectedProvider();
    const info = getSelectedModelInfo();
    const tSel = $("thinking-select");
    const capBadge = $("model-cap-badge");

    if (prov && $("model-select").value) {
      $("sidebar-prov-model").textContent = `${info?.display_name || $("model-select").value} · ${fmtTokens(info?.context_window || 128000)} ctx`;
      $("composer-engine-note").textContent =
        prov.kind === "claude_native"
          ? `引擎：Claude 原生登录 (${info?.display_name || $("model-select").value})`
          : `引擎：OpenCode 开源内核 · ${prov.name} / ${info?.display_name || $("model-select").value}`;
    }

    if (!info || !info.thinking_supported || !info.thinking_levels?.length) {
      tSel.classList.add("hidden");
      tSel.innerHTML = "";
      if (info) {
        capBadge.textContent = `${fmtTokens(info.context_window)} ctx${info.vision ? " · 识图" : ""}`;
        capBadge.classList.remove("hidden");
      } else {
        capBadge.classList.add("hidden");
      }
      return;
    }

    const labelMap = { off: "关闭", on: "开启", low: "低", medium: "中", high: "高", xhigh: "极高", max: "极致" };
    const prefix = info.thinking_mode === "openai_effort" ? "推理" : "思考";
    tSel.innerHTML = "";
    for (const lvl of info.thinking_levels) {
      const opt = document.createElement("option");
      opt.value = lvl;
      opt.textContent = `${prefix}: ${labelMap[lvl] || lvl}`;
      tSel.appendChild(opt);
    }
    const chosen =
      preferredThinking && info.thinking_levels.includes(preferredThinking)
        ? preferredThinking
        : info.default_thinking || info.thinking_levels[0];
    tSel.value = chosen;
    tSel.classList.remove("hidden");

    capBadge.textContent = `${fmtTokens(info.context_window)} ctx${info.vision ? " · 识图" : ""}`;
    capBadge.classList.remove("hidden");
  }

  // ==================== SESSION LIST ====================

  function renderSessionList() {
    const list = state.sessions;
    const q = $("global-search-input").value.trim();
    const el = $("session-list");

    if (!list.length) {
      el.innerHTML = `<div class="empty-hint">${q ? "没有找到匹配的对话" : "点击右上角 + 开启新会话"}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const s of list) {
      const item = document.createElement("div");
      item.className = "session-item" + (s.id === state.activeSessionId ? " active" : "");
      const running = state.runningIds.has(s.id);
      const snippet = q && s.match_snippet ? `<div class="session-item-snippet">${highlightHtml(s.match_snippet, q)}</div>` : "";
      item.innerHTML =
        `<div class="session-item-row">` +
          (running ? `<span class="pulse-dot" title="后台运行中"></span>` : "") +
          `<span class="session-item-title">${highlightHtml(s.title, q)}</span>` +
          `<div class="session-item-actions">` +
            `<button class="icon-btn xs btn-rn" title="重命名">✎</button>` +
            `<button class="icon-btn xs btn-del" title="删除">🗑</button>` +
          `</div>` +
        `</div>` +
        `<div class="session-item-meta"><span>${s.user_turns || 0} 轮${s.model ? ` · ${escHtml(s.model.slice(0, 18))}` : ""}</span><span>${fmtRelTime(s.updated_at)}</span></div>` +
        snippet;

      item.addEventListener("click", (ev) => {
        if (ev.target.closest(".session-item-actions")) return;
        openSession(s.id, { jumpMessageId: s.match_message_id || null, highlightQuery: q || null });
      });
      item.querySelector(".btn-rn")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        promptRename(s.id, s.title);
      });
      item.querySelector(".btn-del")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        confirmDeleteSession(s.id, s.title);
      });
      frag.appendChild(item);
    }
    el.innerHTML = "";
    el.appendChild(frag);
  }

  async function refreshSessions() {
    const q = $("global-search-input").value.trim();
    const cwd = $("cwd-filter-select").value;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cwd) params.set("cwd", cwd);
    const data = await apiJson(`/api/sessions?${params.toString()}`);
    state.sessions = data.sessions || [];
    state.cwds = data.cwds || [];
    state.runningIds = new Set(data.running_sessions || []);

    const sel = $("cwd-filter-select");
    const prev = sel.value;
    sel.innerHTML = '<option value="">全部工作目录</option>';
    for (const c of state.cwds) {
      const opt = document.createElement("option");
      opt.value = c.cwd;
      opt.textContent = `${c.cwd} (${c.count})`;
      if (c.cwd === prev) opt.selected = true;
      sel.appendChild(opt);
    }
    renderSessionList();
    updateRunningButtons();
  }

  // ==================== TOOL CARDS & MESSAGE RENDERING ====================

  function summarizeTool(name, input) {
    if (!input || typeof input !== "object") return "";
    if (name === "run_shell" || name === "Bash") return input.description || input.command || "";
    if (["read_file", "edit_file", "write_file", "Read", "Edit", "Write"].includes(name)) return input.file_path || input.path || "";
    if (name === "grep_search" || name === "glob_files") return `${input.pattern || ""} ${input.dir_path || ""}`.trim();
    if (name === "web_fetch") return input.url || "";
    return JSON.stringify(input).slice(0, 90);
  }

  function renderToolBodyHtml(tool) {
    const name = tool.name || "Tool";
    const input = tool.input || {};
    const parts = [];
    if ((name === "run_shell" || name === "Bash") && input.command) {
      parts.push(`<pre class="tool-pre">$ ${escHtml(input.command)}</pre>`);
    } else if ((name === "edit_file" || name === "Edit") && (input.old_string !== undefined || input.new_string !== undefined)) {
      const del = String(input.old_string || "").split("\n").map((l) => `<div class="diff-line del">- ${escHtml(l)}</div>`).join("");
      const add = String(input.new_string || "").split("\n").map((l) => `<div class="diff-line add">+ ${escHtml(l)}</div>`).join("");
      parts.push(`<div class="muted-text mono">${escHtml(input.file_path || "")}</div><div class="diff-box">${del}${add}</div>`);
    } else if (Object.keys(input).length) {
      parts.push(`<pre class="tool-pre">${escHtml(JSON.stringify(input, null, 2))}</pre>`);
    }
    if (tool.result !== null && tool.result !== undefined && String(tool.result).length) {
      parts.push(`<pre class="tool-pre${tool.is_error ? " error-out" : ""}">${escHtml(String(tool.result))}</pre>`);
    }
    return parts.join("");
  }

  function createToolCardEl(tool, openByDefault = false) {
    const det = document.createElement("details");
    const status = tool.status || (tool.is_error ? "error" : "done");
    det.className = "tool-card" + (tool.is_error ? " is-error" : "");
    det.dataset.toolId = tool.id || "";
    const icon = status === "running" ? "◌" : status === "error" || tool.is_error ? "✕" : "✓";
    det.innerHTML =
      `<summary><span class="tool-status ${status}">${icon}</span>` +
      `<span class="tool-chip">${escHtml(tool.name || "Tool")}</span>` +
      `<span class="tool-summary">${escHtml(summarizeTool(tool.name, tool.input))}</span></summary>`;

    let mounted = false;
    const mount = () => {
      if (mounted) return;
      mounted = true;
      const body = document.createElement("div");
      body.className = "tool-body";
      body.innerHTML = renderToolBodyHtml(tool);
      det.appendChild(body);
    };
    if (openByDefault || tool.is_error) {
      det.open = true;
      mount();
    } else {
      det.addEventListener("toggle", () => { if (det.open) mount(); });
    }
    return det;
  }

  function createErrorCardEl(err) {
    const el = document.createElement("div");
    el.className = "error-card";
    const sug = (err.suggestions || []).map((s) => `<li>${escHtml(s)}</li>`).join("");
    el.innerHTML =
      `<div class="error-head"><div class="error-title">⚠ ${escHtml(err.title || "执行错误")}</div>` +
      `<span class="error-code">${escHtml(err.error_code || "ERR")} · ${escHtml(err.layer || "")}</span></div>` +
      `<div>${escHtml(err.cause || "")}</div>` +
      (sug ? `<ul class="error-suggestions">${sug}</ul>` : "") +
      `<div class="action-row">` +
        `<button class="btn-secondary sm btn-copy-diag">复制 AI 排障报告</button>` +
        `<button class="btn-secondary sm btn-open-prov">检查供应商</button>` +
      `</div>` +
      `<details><summary class="muted-text" style="cursor:pointer;">技术详情</summary><pre class="tool-pre" style="margin-top:6px;">${escHtml(JSON.stringify(err.technical || {}, null, 2))}</pre></details>`;
    el.querySelector(".btn-copy-diag")?.addEventListener("click", copyAiReport);
    el.querySelector(".btn-open-prov")?.addEventListener("click", openProvidersModal);
    return el;
  }

  function createUserMsgEl(item) {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    wrap.id = item.id;

    // Inline edit mode for Edit & Resend
    if (state.editingMessageId === item.id) {
      wrap.innerHTML =
        `<div class="edit-box-wrap">` +
          `<textarea class="edit-box-textarea" id="inline-edit-ta">${escHtml(item.content_text || "")}</textarea>` +
          `<div class="edit-box-actions">` +
            `<button class="btn-secondary sm" id="btn-cancel-edit">取消</button>` +
            `<button class="btn-primary sm" id="btn-submit-edit">保存并重新发送（创建新分支）</button>` +
          `</div>` +
        `</div>`;
      const ta = wrap.querySelector("#inline-edit-ta");
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 20);
      wrap.querySelector("#btn-cancel-edit").addEventListener("click", () => {
        state.editingMessageId = null;
        renderConversation();
      });
      wrap.querySelector("#btn-submit-edit").addEventListener("click", () => {
        const nextText = ta.value.trim();
        if (!nextText) return toast("消息内容不能为空");
        state.editingMessageId = null;
        sendEditResend(item.id, nextText);
      });
      return wrap;
    }

    const branchBar =
      item.branch_total > 1
        ? `<span class="branch-bar">` +
            `<button class="branch-btn btn-br-prev" ${item.branch_index <= 1 ? "disabled" : ""} title="上一历史分支">◀</button>` +
            `<span>${item.branch_index}/${item.branch_total}</span>` +
            `<button class="branch-btn btn-br-next" ${item.branch_index >= item.branch_total ? "disabled" : ""} title="下一历史分支">▶</button>` +
          `</span>`
        : "";

    const imgsHtml = (item.images || []).length
      ? `<div class="msg-images">${item.images.map((im) => `<img src="${escHtml(im.url)}" alt="图片" />`).join("")}</div>`
      : "";

    wrap.innerHTML =
      `<div class="msg-user-header">` +
        branchBar +
        `<span class="mono">#${item.turn_index || ""}</span>` +
        `<span>${fmtClock(item.created_at)}</span>` +
        `<span class="msg-user-actions">` +
          `<button class="msg-mini-btn btn-edit-resend" title="修改此条历史提问并重新发送（原分支保留可切换）">编辑重发</button>` +
          `<button class="msg-mini-btn btn-copy-u" title="复制">复制</button>` +
        `</span>` +
      `</div>` +
      `<div class="msg-user-card">${imgsHtml}<div class="msg-user-text">${escHtml(item.content_text || "")}</div></div>`;

    wrap.querySelector(".btn-copy-u")?.addEventListener("click", () => copyText(item.content_text || ""));
    wrap.querySelector(".btn-edit-resend")?.addEventListener("click", () => {
      state.editingMessageId = item.id;
      renderConversation();
    });
    wrap.querySelector(".btn-br-prev")?.addEventListener("click", () => {
      const targetId = item.sibling_ids?.[item.branch_index - 2];
      if (targetId) switchToBranch(targetId);
    });
    wrap.querySelector(".btn-br-next")?.addEventListener("click", () => {
      const targetId = item.sibling_ids?.[item.branch_index];
      if (targetId) switchToBranch(targetId);
    });
    wrap.querySelectorAll(".msg-images img").forEach((img) => {
      img.addEventListener("click", () => { $("lightbox-img").src = img.src; $("lightbox").classList.remove("hidden"); });
    });
    return wrap;
  }

  function createAssistantMsgEl(item, isLive = false) {
    const wrap = document.createElement("div");
    wrap.className = "msg-assistant" + (isLive ? " live-node" : "");
    if (item.id) wrap.id = item.id;

    const head = document.createElement("div");
    head.className = "msg-assistant-head";
    const engLabel = item.engine === "claude_native" ? "Claude 原生" : "OpenCode";
    head.innerHTML =
      `<span class="asst-badge">${engLabel}</span>` +
      (item.provider_name ? `<span class="asst-tag">${escHtml(item.provider_name)}</span>` : "") +
      (item.model ? `<span class="asst-tag">${escHtml(item.model)}</span>` : "") +
      (isLive ? `<span class="pulse-dot"></span><span>思考与执行中…</span>` : `<span>${fmtClock(item.created_at)}</span>`);
    wrap.appendChild(head);

    const blocks = item.blocks || [];
    if (isLive && !blocks.length && !item.error) {
      const ph = document.createElement("div");
      ph.className = "md-body streaming-cursor";
      ph.style.color = "var(--text-muted)";
      ph.textContent = "等待模型响应";
      wrap.appendChild(ph);
    }

    for (const blk of blocks) {
      if (blk.type === "thinking") {
        const det = document.createElement("details");
        det.className = "thinking-card";
        det.open = isLive;
        det.innerHTML = `<summary>思考过程（${String(blk.text || "").length} 字）</summary><div class="thinking-body">${escHtml(blk.text || "")}</div>`;
        wrap.appendChild(det);
      } else if (blk.type === "tool_use") {
        wrap.appendChild(createToolCardEl(blk, isLive && blk.status === "running"));
      } else if (blk.type === "text") {
        const div = document.createElement("div");
        div.className = "md-body" + (isLive ? " streaming-cursor" : "");
        div.innerHTML = renderMarkdown(blk.text || "");
        wrap.appendChild(div);
      }
    }

    if (item.error) {
      wrap.appendChild(createErrorCardEl(item.error));
    }
    return wrap;
  }

  function renderConversation() {
    const box = $("messages-container");
    const tl = state.activeTimeline;
    const live = state.activeSessionId ? state.liveStream.get(state.activeSessionId) : null;

    if (!tl && !live) {
      box.innerHTML = "";
      box.appendChild($("welcome-view"));
      $("welcome-view").classList.remove("hidden");
      $("ctx-pill").classList.add("hidden");
      renderOutline([]);
      renderActivity(null);
      return;
    }

    $("welcome-view").classList.add("hidden");
    const frag = document.createDocumentFragment();
    for (const item of tl?.items || []) {
      if (item.role === "user") frag.appendChild(createUserMsgEl(item));
      else if (item.role === "assistant") frag.appendChild(createAssistantMsgEl(item, false));
      else if (item.role === "compact") {
        const c = document.createElement("div");
        c.className = "compact-divider";
        c.id = item.id;
        c.innerHTML =
          `<div style="display:flex;justify-content:space-between;align-items:center;">` +
            `<span><b>上下文压缩边界</b> · ${fmtClock(item.created_at)}</span>` +
            `<button class="link-btn btn-sum">查看摘要</button>` +
          `</div><div class="compact-summary hidden">${escHtml(item.content_text)}</div>`;
        c.querySelector(".btn-sum").addEventListener("click", () => c.querySelector(".compact-summary").classList.toggle("hidden"));
        frag.appendChild(c);
      }
    }

    box.innerHTML = "";
    box.appendChild(frag);

    if (live) {
      box.appendChild(createAssistantMsgEl(live, true));
    }

    const ctxTok = tl?.activity?.context_tokens || 0;
    if (ctxTok > 0) {
      $("ctx-pill").textContent = `上下文 ${fmtTokens(ctxTok)} tok`;
      $("ctx-pill").classList.remove("hidden");
    } else {
      $("ctx-pill").classList.add("hidden");
    }

    renderOutline(tl?.outline || []);
    renderActivity(tl?.activity || null);
  }

  function renderLiveOnly() {
    const box = $("messages-container");
    const live = state.activeSessionId ? state.liveStream.get(state.activeSessionId) : null;
    box.querySelectorAll(".live-node").forEach((n) => n.remove());
    if (live) {
      const stick = isNearBottom();
      box.appendChild(createAssistantMsgEl(live, true));
      if (stick) scrollToBottom(false);
    }
  }

  async function openSession(sid, opts = {}) {
    saveDraft();
    state.activeSessionId = sid;
    state.editingMessageId = null;
    renderSessionList();
    updateRunningButtons();
    restoreDraft();

    try {
      const data = await apiJson(`/api/sessions/${encodeURIComponent(sid)}`);
      if (state.activeSessionId !== sid) return;
      state.activeTimeline = data;
      state.activeCwd = data.session.cwd || state.settings.default_cwd || "";
      $("thread-title").textContent = data.session.title || "新会话";
      $("cwd-pill-text").textContent = state.activeCwd;

      if (data.live) state.liveStream.set(sid, data.live);
      if (data.session.provider_id) {
        renderComposerSelectors(data.session.provider_id, data.session.model, data.session.thinking_level);
      }

      renderConversation();
      if (opts.jumpMessageId) {
        jumpToElement(opts.jumpMessageId);
        if (opts.highlightQuery) {
          openDrawer("find");
          $("thread-find-input").value = opts.highlightQuery;
          runThreadFind();
        }
      } else {
        scrollToBottom(false);
      }
    } catch (err) {
      toast("加载会话失败: " + err.message);
    }
  }

  function startNewSession() {
    saveDraft();
    state.activeSessionId = null;
    state.activeTimeline = null;
    state.editingMessageId = null;
    state.activeCwd = state.settings.default_cwd || state.activeCwd;
    $("thread-title").textContent = "新会话";
    $("cwd-pill-text").textContent = state.activeCwd || "默认目录";
    state.attachments = [];
    renderAttachments();
    renderSessionList();
    renderConversation();
    updateRunningButtons();
    restoreDraft();
    $("composer-input").focus();
  }

  async function switchToBranch(targetMessageId) {
    if (!state.activeSessionId) return;
    try {
      const res = await apiJson(`/api/sessions/${encodeURIComponent(state.activeSessionId)}/switch-branch`, {
        method: "POST",
        body: JSON.stringify({ message_id: targetMessageId }),
      });
      state.activeTimeline = res.timeline;
      renderConversation();
      jumpToElement(targetMessageId);
    } catch (err) {
      toast("切换分支失败: " + err.message);
    }
  }

  // ==================== RIGHT DRAWER (EXACT JUMP!) ====================

  function openDrawer(tab) {
    state.drawerOpen = true;
    state.drawerTab = tab;
    $("right-drawer").classList.remove("hidden");
    syncDrawerTabs();
    if (tab === "find") setTimeout(() => { $("thread-find-input").focus(); $("thread-find-input").select(); }, 20);
  }

  function closeDrawer() {
    state.drawerOpen = false;
    $("right-drawer").classList.add("hidden");
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
  }

  function syncDrawerTabs() {
    const t = state.drawerTab;
    document.querySelectorAll(".drawer-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", state.drawerOpen && b.dataset.tab === t));
    $("drawer-panel-outline").classList.toggle("hidden", t !== "outline");
    $("drawer-panel-find").classList.toggle("hidden", t !== "find");
    $("drawer-panel-activity").classList.toggle("hidden", t !== "activity");
  }

  function jumpToElement(elOrId) {
    const el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    if (!el) return;
    let p = el.parentElement;
    while (p && p !== $("messages-container")) {
      if (p.tagName === "DETAILS") p.open = true;
      p = p.parentElement;
    }
    if (el.tagName === "DETAILS") el.open = true;

    const sc = $("messages-scroll");
    const align = (smooth) => {
      const scRect = sc.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const targetTop = sc.scrollTop + (elRect.top - scRect.top) - Math.max(24, (sc.clientHeight - Math.min(elRect.height, sc.clientHeight * 0.45)) / 3);
      sc.scrollTo({ top: Math.max(0, targetTop), behavior: smooth ? "smooth" : "auto" });
    };
    align(true);
    requestAnimationFrame(() => setTimeout(() => align(false), 260));

    el.classList.remove("jump-highlight");
    void el.offsetWidth;
    el.classList.add("jump-highlight");
  }

  function renderOutline(outline) {
    const f = $("outline-filter").value.trim().toLowerCase();
    const list = (outline || []).filter((o) => !f || o.preview.toLowerCase().includes(f));
    $("outline-count").textContent = `${list.length} / ${(outline || []).length} 轮`;
    const box = $("outline-list");
    if (!list.length) {
      box.innerHTML = `<div class="empty-hint">暂无提问目录</div>`;
      return;
    }
    box.innerHTML = "";
    for (const o of list) {
      const el = document.createElement("div");
      el.className = "outline-item";
      el.innerHTML = `<div class="outline-top"><span>#${o.turn_index} · ${fmtClock(o.timestamp)}</span></div><div class="outline-text">${escHtml(o.preview)}</div>`;
      el.addEventListener("click", () => jumpToElement(o.message_id));
      box.appendChild(el);
    }
  }

  function runThreadFind() {
    const q = $("thread-find-input").value.trim();
    state.findMatches = [];
    state.findIndex = -1;
    const box = $("thread-find-results");
    if (!q || !state.activeTimeline) {
      $("thread-find-count").textContent = "0";
      box.innerHTML = `<div class="empty-hint">输入关键词搜索当前会话的全部内容与工具输出</div>`;
      return;
    }
    const qlc = q.toLowerCase();
    for (const item of state.activeTimeline.items || []) {
      if (item.role === "user" && item.content_text.toLowerCase().includes(qlc)) {
        state.findMatches.push({ id: item.id, role: `我 #${item.turn_index}`, text: item.content_text, ts: item.created_at });
      } else if (item.role === "assistant") {
        for (const blk of item.blocks || []) {
          const blob = blk.type === "tool_use" ? `${blk.name} ${JSON.stringify(blk.input || {})} ${blk.result || ""}` : blk.text || "";
          if (blob.toLowerCase().includes(qlc)) {
            state.findMatches.push({ id: item.id, toolId: blk.type === "tool_use" ? blk.id : null, role: blk.type === "tool_use" ? `工具 ${blk.name}` : "助手回复", text: blob, ts: item.created_at });
          }
        }
      }
    }
    $("thread-find-count").textContent = `${state.findMatches.length} 处`;
    if (!state.findMatches.length) {
      box.innerHTML = `<div class="empty-hint">未找到「${escHtml(q)}」</div>`;
      return;
    }
    box.innerHTML = "";
    state.findMatches.forEach((m, idx) => {
      const pos = m.text.toLowerCase().indexOf(qlc);
      const snip = (pos > 28 ? "…" : "") + m.text.slice(Math.max(0, pos - 28), pos + q.length + 52).replace(/\s+/g, " ");
      const el = document.createElement("div");
      el.className = "find-item";
      el.innerHTML = `<div class="outline-top"><span>${escHtml(m.role)}</span><span>${fmtClock(m.ts)}</span></div><div class="outline-text">${highlightHtml(snip, q)}</div>`;
      el.addEventListener("click", () => focusFind(idx));
      box.appendChild(el);
    });
    focusFind(0);
  }

  function focusFind(idx) {
    if (!state.findMatches.length) return;
    const n = state.findMatches.length;
    state.findIndex = ((idx % n) + n) % n;
    $("thread-find-count").textContent = `${state.findIndex + 1} / ${n}`;
    $("thread-find-results").querySelectorAll(".find-item").forEach((el, i) => el.classList.toggle("active", i === state.findIndex));
    const m = state.findMatches[state.findIndex];
    if (m.toolId) {
      const tEl = $("messages-container").querySelector(`[data-tool-id="${CSS.escape(m.toolId)}"]`);
      if (tEl) return jumpToElement(tEl);
    }
    jumpToElement(m.id);
  }

  function renderActivity(act) {
    const box = $("activity-content");
    if (!act) {
      box.innerHTML = `<div class="empty-hint">开始对话后查看改动与工具统计</div>`;
      return;
    }
    const files = (act.edited_files || [])
      .map((f) => `<div class="dir-row mono" style="cursor:default;"><span>${escHtml(f.path)}</span><span>×${f.edits}</span></div>`)
      .join("") || `<div class="empty-hint" style="padding:10px;">暂无文件修改</div>`;
    box.innerHTML =
      `<div class="stat-grid">` +
        `<div class="stat-card"><div class="stat-val">${act.total_tool_calls || 0}</div><div class="stat-lbl">工具调用</div></div>` +
        `<div class="stat-card"><div class="stat-val">${act.bash_count || 0}</div><div class="stat-lbl">命令执行</div></div>` +
        `<div class="stat-card"><div class="stat-val">${act.read_files_count || 0}</div><div class="stat-lbl">读取文件</div></div>` +
        `<div class="stat-card"><div class="stat-val">${fmtTokens(act.context_tokens) || "0"}</div><div class="stat-lbl">上下文 Token</div></div>` +
      `</div><div class="section-label">修改文件</div>${files}`;
  }

  // ==================== WEBSOCKET MULTIPLEXING ====================

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => {
      state.wsConnected = true;
      $("ws-pill").textContent = "● 已连接";
      $("ws-pill").className = "meta-pill ws-ok";
    };
    ws.onclose = () => {
      state.wsConnected = false;
      $("ws-pill").textContent = "● 重连中";
      $("ws-pill").className = "meta-pill ws-err";
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectWs, 1800);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleWs(msg);
    };
  }

  function updateRunningButtons() {
    const run = Boolean(state.activeSessionId && state.runningIds.has(state.activeSessionId));
    $("btn-stop").classList.toggle("hidden", !run);
    $("btn-send").classList.toggle("hidden", run);
  }

  function handleWs(msg) {
    const t = msg.type;
    if (t === "hello") {
      state.runningIds = new Set(msg.running_sessions || []);
      if (msg.providers) {
        state.providers = msg.providers;
        state.activeProvider = msg.active_provider;
        renderComposerSelectors();
      }
      updateRunningButtons();
      return;
    }
    if (t === "settings_updated" && msg.settings) {
      state.settings = msg.settings;
      applyAppearance(msg.settings.appearance);
      return;
    }
    if (t === "providers_updated") {
      state.providers = msg.providers || [];
      state.activeProvider = msg.active_provider;
      renderComposerSelectors();
      return;
    }
    if (t === "running_sessions") {
      state.runningIds = new Set(msg.ids || []);
      renderSessionList();
      updateRunningButtons();
      return;
    }
    if (t === "session_created" && msg.session) {
      refreshSessions();
      if (!state.activeSessionId) {
        state.activeSessionId = msg.session.id;
        $("thread-title").textContent = msg.session.title;
        $("cwd-pill-text").textContent = msg.session.cwd;
      }
      return;
    }
    if (t === "session_meta_updated" || t === "session_deleted") {
      refreshSessions();
      return;
    }
    if (t === "message_added" || t === "timeline_updated") {
      refreshSessions();
      if (msg.session_id === state.activeSessionId && msg.timeline) {
        state.activeTimeline = msg.timeline;
        renderConversation();
        scrollToBottom(true);
      }
      return;
    }
    if (t === "stream_state") {
      state.liveStream.set(msg.session_id, {
        model: msg.model,
        provider_name: msg.provider_name,
        engine: msg.engine,
        blocks: msg.blocks || [],
        error: null,
      });
      if (msg.session_id === state.activeSessionId) {
        renderLiveOnly();
      }
      return;
    }
    if (t === "turn_complete" || t === "turn_stopped") {
      state.liveStream.delete(msg.session_id);
      refreshSessions();
      if (msg.session_id === state.activeSessionId && msg.timeline) {
        state.activeTimeline = msg.timeline;
        renderConversation();
        scrollToBottom(false);
      }
      if (t === "turn_stopped") toast("已停止生成");
      return;
    }
    if (t === "turn_error") {
      $("log-error-dot").classList.remove("hidden");
      const prev = state.liveStream.get(msg.session_id) || { blocks: [] };
      prev.error = msg.error;
      state.liveStream.set(msg.session_id, prev);
      if (msg.session_id === state.activeSessionId) {
        if (msg.timeline) state.activeTimeline = msg.timeline;
        renderConversation();
        scrollToBottom(true);
      }
      toast(msg.error?.title || "执行出错", 3800);
      return;
    }
    if (t === "confirm_request") {
      state.activeConfirmId = msg.confirm_id;
      $("confirm-reason").textContent = msg.reason || "请确认是否允许执行以下命令：";
      $("confirm-cmd").textContent = msg.command || "";
      $("modal-confirm").classList.remove("hidden");
    }
  }

  // ==================== SEND / EDIT-RESEND / UPLOAD ====================

  function sendCurrentMessage() {
    if (!state.wsConnected) return toast("正在重连后端服务…");
    const text = $("composer-input").value.trim();
    const images = state.attachments.slice();
    if (!text && !images.length) return;
    if (text === "/clear") {
      $("composer-input").value = "";
      autoResizeComposer();
      saveDraft();
      return startNewSession();
    }

    const prov = getSelectedProvider();
    const model = $("model-select").value;
    const thinking = $("thinking-select").classList.contains("hidden") ? "off" : $("thinking-select").value;

    $("composer-input").value = "";
    autoResizeComposer();
    saveDraft();
    state.attachments = [];
    renderAttachments();
    closeAutocomplete();

    state.ws.send(JSON.stringify({
      type: "send_message",
      session_id: state.activeSessionId || "",
      text,
      images,
      cwd: state.activeCwd || state.settings.default_cwd || "",
      provider_id: prov?.id || "",
      model,
      thinking_level: thinking,
    }));
  }

  function sendEditResend(messageId, newText) {
    if (!state.wsConnected || !state.activeSessionId) return;
    const prov = getSelectedProvider();
    const model = $("model-select").value;
    const thinking = $("thinking-select").classList.contains("hidden") ? "off" : $("thinking-select").value;
    state.ws.send(JSON.stringify({
      type: "edit_resend",
      session_id: state.activeSessionId,
      message_id: messageId,
      new_text: newText,
      provider_id: prov?.id || "",
      model,
      thinking_level: thinking,
    }));
    toast("已创建新分支并重新发送");
  }

  async function uploadChatImage(file) {
    if (!file || !file.type.startsWith("image/")) return toast("仅支持 PNG / JPG / WebP / GIF");
    const b64 = await fileToDataUrl(file);
    try {
      const data = await apiJson("/api/upload", {
        method: "POST",
        body: JSON.stringify({ media_type: file.type, data: b64, name: file.name || "pasted.png" }),
      });
      state.attachments.push(data);
      renderAttachments();
    } catch (err) {
      toast("图片上传失败: " + err.message);
    }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function renderAttachments() {
    const strip = $("attachment-strip");
    if (!state.attachments.length) {
      strip.classList.add("hidden");
      strip.innerHTML = "";
      return;
    }
    strip.classList.remove("hidden");
    strip.innerHTML = "";
    state.attachments.forEach((att, idx) => {
      const el = document.createElement("div");
      el.className = "att-thumb";
      el.innerHTML = `<img src="${escHtml(att.url)}" /><button class="att-remove">×</button>`;
      el.querySelector(".att-remove").addEventListener("click", () => {
        state.attachments.splice(idx, 1);
        renderAttachments();
      });
      strip.appendChild(el);
    });
  }

  // ==================== AUTOCOMPLETE (/ & @) ====================

  function closeAutocomplete() {
    state.acOpen = false;
    state.acItems = [];
    $("autocomplete-popup").classList.add("hidden");
  }

  function renderAutocomplete() {
    const pop = $("autocomplete-popup");
    if (!state.acItems.length) return closeAutocomplete();
    state.acOpen = true;
    pop.classList.remove("hidden");
    pop.innerHTML = "";
    state.acItems.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = "ac-item" + (idx === state.acIndex ? " selected" : "");
      row.innerHTML = `<span class="ac-name">${escHtml(it.label)}</span><span class="ac-desc">${escHtml(it.desc || "")}</span>`;
      row.addEventListener("mousedown", (e) => { e.preventDefault(); applyAutocomplete(idx); });
      pop.appendChild(row);
    });
  }

  function applyAutocomplete(idx) {
    const it = state.acItems[idx];
    if (!it) return;
    const el = $("composer-input");
    const pos = el.selectionStart;
    el.value = el.value.slice(0, state.acStartPos) + it.insert + " " + el.value.slice(pos);
    const nextPos = state.acStartPos + it.insert.length + 1;
    el.setSelectionRange(nextPos, nextPos);
    el.focus();
    autoResizeComposer();
    closeAutocomplete();
  }

  function checkAutocomplete() {
    const el = $("composer-input");
    const pos = el.selectionStart;
    const before = el.value.slice(0, pos);

    const slash = before.match(/^\/([^\s]*)$/);
    if (slash) {
      const q = slash[1].toLowerCase();
      const cmds = [
        { label: "/compact", desc: "压缩当前长对话上下文", insert: "/compact" },
        { label: "/clear", desc: "开启新会话", insert: "/clear" },
        ...state.installedSkills.filter((s) => s.enabled).map((s) => ({
          label: `/${s.slug}`,
          desc: `[Skill] ${s.name}`,
          insert: `请使用技能 /${s.slug} 处理：`,
        })),
      ];
      state.acStartPos = 0;
      state.acIndex = 0;
      state.acItems = cmds.filter((c) => c.label.toLowerCase().includes(q));
      return renderAutocomplete();
    }

    const at = before.match(/(?:^|\s)@([^\s]*)$/);
    if (at) {
      const q = at[1];
      state.acStartPos = pos - q.length - 1;
      clearTimeout(state.acTimer);
      state.acTimer = setTimeout(async () => {
        try {
          const data = await apiJson(`/api/files?cwd=${encodeURIComponent(state.activeCwd)}&q=${encodeURIComponent(q)}`);
          state.acIndex = 0;
          state.acItems = (data.files || []).slice(0, 15).map((f) => ({
            label: (f.is_dir ? "📁 " : "📄 ") + f.rel,
            desc: f.path,
            insert: f.path,
          }));
          renderAutocomplete();
        } catch { closeAutocomplete(); }
      }, 120);
      return;
    }
    closeAutocomplete();
  }

  // ==================== MODAL: PROVIDERS ====================

  async function openProvidersModal() {
    $("modal-providers").classList.remove("hidden");
    const data = await apiJson("/api/providers");
    state.providers = data.providers || [];
    state.claudeNative = data.claude_native;
    renderProviderModalList();
    const target = state.selectedProviderId || state.activeProvider?.id || state.providers[0]?.id;
    if (target) fillProviderForm(state.providers.find((p) => p.id === target));
  }

  function renderProviderModalList() {
    const listEl = $("provider-list");
    listEl.innerHTML = "";
    for (const p of state.providers) {
      const el = document.createElement("div");
      el.className = "stack-item" + (p.id === state.selectedProviderId ? " active" : "");
      el.innerHTML =
        `<div class="stack-item-head"><span>${escHtml(p.name)}</span>` +
        `<span class="mini-tag">${p.is_active ? "当前" : p.kind === "claude_native" ? "原生" : p.kind}</span></div>` +
        `<div class="stack-item-sub">${escHtml(p.default_model || (p.base_url || "本地 CLI OAuth"))}</div>`;
      el.addEventListener("click", () => fillProviderForm(p));
      listEl.appendChild(el);
    }
    const cn = state.claudeNative;
    $("claude-native-status-box").innerHTML = cn
      ? `<b>Claude 原生登录检测：</b>${cn.installed ? `已安装 (${escHtml(cn.version)})` : "未安装"}<br />${escHtml(cn.note)}`
      : "";
  }

  function fillProviderForm(p) {
    state.selectedProviderId = p ? p.id : null;
    renderProviderModalList();
    $("pf-name").value = p?.name || "";
    $("pf-kind").value = p?.kind || "openai";
    $("pf-baseurl").value = p?.base_url || "";
    $("pf-apikey").value = "";
    $("pf-apikey").placeholder = p?.has_api_key ? `已加密保存 (${p.api_key_masked})，留空保持不变` : "输入 API Key (sk-...)";
    $("pf-default-model").value = p?.default_model || "";
    $("pf-models").value = (p?.models || []).join("\n");
    $("btn-delete-provider").disabled = !p || p.id === "claude-native-oauth";
    toggleProviderKindFields();
    renderModelCapsPreview(p?.model_infos || []);
  }

  function toggleProviderKindFields() {
    const isNative = $("pf-kind").value === "claude_native";
    $("pf-baseurl-wrap").classList.toggle("hidden", isNative);
    $("pf-apikey-wrap").classList.toggle("hidden", isNative);
  }

  function renderModelCapsPreview(infos) {
    const grid = $("pf-caps-preview");
    if (!infos.length) {
      grid.innerHTML = `<div class="muted-text">保存或拉取模型后，此处会展示每个模型自动识别的思考等级与上下文窗口。</div>`;
      return;
    }
    grid.innerHTML = infos.slice(0, 24).map((m) =>
      `<div class="cap-card">` +
        `<div class="cap-card-name">${escHtml(m.display_name)}</div>` +
        `<div class="cap-tags">` +
          `<span class="mini-tag">${fmtTokens(m.context_window)} ctx</span>` +
          (m.thinking_supported ? `<span class="mini-tag think">思考: ${m.thinking_levels.join("/")}</span>` : `<span class="mini-tag">无思考档</span>`) +
          (m.vision ? `<span class="mini-tag">识图</span>` : "") +
        `</div>` +
      `</div>`,
    ).join("");
  }

  async function saveProviderForm() {
    const models = $("pf-models").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      id: state.selectedProviderId || undefined,
      name: $("pf-name").value.trim() || "未命名供应商",
      kind: $("pf-kind").value,
      base_url: $("pf-baseurl").value.trim(),
      api_key: $("pf-apikey").value.trim() || undefined,
      default_model: $("pf-default-model").value.trim() || models[0] || "",
      models,
    };
    try {
      const res = await apiJson("/api/providers", { method: "POST", body: JSON.stringify(payload) });
      state.providers = res.providers;
      state.activeProvider = state.providers.find((p) => p.is_active) || state.providers[0];
      fillProviderForm(res.provider);
      renderComposerSelectors();
      toast(`已保存供应商「${res.provider.name}」`);
    } catch (err) {
      toast("保存失败: " + err.message);
    }
  }

  async function fetchModelsForSelected() {
    if (!state.selectedProviderId) return toast("请先保存供应商后再拉取模型");
    toast("正在联网拉取模型列表并识别能力…");
    try {
      const res = await apiJson(`/api/providers/${encodeURIComponent(state.selectedProviderId)}/models`, { method: "POST" });
      if (!res.ok) return toast("拉取失败: " + (res.error || "未知错误"), 4000);
      state.providers = res.providers;
      const cur = state.providers.find((p) => p.id === state.selectedProviderId);
      fillProviderForm(cur);
      renderComposerSelectors();
      toast(`成功拉取并自动识别 ${res.models.length} 个模型！`, 3000);
    } catch (err) {
      toast("拉取模型异常: " + err.message);
    }
  }

  // ==================== MODAL: STORES (MCP / SKILLS / WALLPAPERS) ====================

  function openStoresModal(tab = "mcp") {
    state.activeStoreTab = tab;
    $("modal-stores").classList.remove("hidden");
    document.querySelectorAll("[data-storetab]").forEach((b) => b.classList.toggle("active", b.dataset.storetab === tab));
    $("store-pane-mcp").classList.toggle("hidden", tab !== "mcp");
    $("store-pane-skills").classList.toggle("hidden", tab !== "skills");
    $("store-pane-wallpapers").classList.toggle("hidden", tab !== "wallpapers");
    if (tab === "mcp") { loadInstalledMcps(); searchMcp(""); }
    if (tab === "skills") { loadInstalledSkills(); searchSkills(""); }
    if (tab === "wallpapers") { renderCustomBgs(); searchWallpapers(""); }
  }

  async function loadInstalledMcps() {
    const data = await apiJson("/api/mcp");
    state.installedMcps = data.items || [];
    const el = $("installed-mcp-list");
    if (!state.installedMcps.length) {
      el.innerHTML = `<div class="muted-text">尚未安装 MCP 服务，可在下方商店一键安装。</div>`;
      return;
    }
    el.innerHTML = "";
    for (const m of state.installedMcps) {
      const card = document.createElement("div");
      card.className = "store-card";
      card.innerHTML =
        `<div class="store-card-head"><span class="store-card-title">${escHtml(m.name)}</span>` +
        `<span class="mini-tag">${escHtml(m.runtime_status)} · ${m.tools_count || 0} 工具</span></div>` +
        `<div class="store-card-desc mono" style="font-size:11.5px;">${escHtml(m.command)} ${escHtml((m.args || []).join(" "))}${m.last_error ? `<br /><span style="color:var(--err);">${escHtml(m.last_error)}</span>` : ""}</div>` +
        `<div class="store-card-foot">` +
          `<button class="btn-secondary sm btn-toggle">${m.enabled ? "停用" : "启用"}</button>` +
          `<button class="btn-secondary sm btn-restart">重连</button>` +
          `<button class="btn-danger sm btn-rm">卸载</button>` +
        `</div>`;
      card.querySelector(".btn-toggle").addEventListener("click", async () => {
        await apiJson("/api/mcp", { method: "POST", body: JSON.stringify({ ...m, enabled: !m.enabled }) });
        loadInstalledMcps();
      });
      card.querySelector(".btn-restart").addEventListener("click", async () => {
        toast(`正在重启 MCP ${m.name}…`);
        await apiJson(`/api/mcp/${encodeURIComponent(m.id)}/restart`, { method: "POST" });
        loadInstalledMcps();
      });
      card.querySelector(".btn-rm").addEventListener("click", async () => {
        await apiJson(`/api/mcp/${encodeURIComponent(m.id)}`, { method: "DELETE" });
        loadInstalledMcps();
      });
      el.appendChild(card);
    }
  }

  async function searchMcp(q) {
    const el = $("store-mcp-list");
    el.innerHTML = `<div class="muted-text">${q ? "正在联网搜索 npm & GitHub 开源 MCP…" : "加载精选开源 MCP…"}</div>`;
    const data = await apiJson(`/api/stores/mcp?q=${encodeURIComponent(q)}`);
    el.innerHTML = "";
    for (const m of data.items || []) {
      const card = document.createElement("div");
      card.className = "store-card";
      card.innerHTML =
        `<div class="store-card-head"><span class="store-card-title">${escHtml(m.title || m.name)}</span>` +
        `<span class="mini-tag">${escHtml((m.tags || []).slice(0, 2).join(" · ") || "open-source")}</span></div>` +
        `<div class="store-card-desc">${escHtml(m.description)}</div>` +
        `<div class="store-card-foot">` +
          (m.repo_url ? `<a class="link-btn" href="${escHtml(m.repo_url)}" target="_blank">源码仓库 ↗</a>` : `<span></span>`) +
          `<button class="btn-primary sm btn-install">一键安装启用</button>` +
        `</div>`;
      card.querySelector(".btn-install").addEventListener("click", async () => {
        const args = (m.args || []).map((a) => a.replace("${WORKSPACE_DIR}", state.activeCwd || state.settings.default_cwd || "."));
        const env = {};
        for (const k of m.env_hints || []) {
          const v = window.prompt(`MCP「${m.name}」需要环境变量 ${k}（可先留空稍后配置）：`, "");
          if (v) env[k] = v;
        }
        toast(`正在安装并连接 MCP：${m.name}…`);
        await apiJson("/api/mcp", {
          method: "POST",
          body: JSON.stringify({ name: m.name, source_id: m.id, description: m.description, command: m.command, args, env, enabled: true }),
        });
        loadInstalledMcps();
        toast(`MCP「${m.name}」已安装！`);
      });
      el.appendChild(card);
    }
  }

  async function loadInstalledSkills() {
    const data = await apiJson("/api/skills");
    state.installedSkills = data.items || [];
    const el = $("installed-skills-list");
    if (!state.installedSkills.length) {
      el.innerHTML = `<div class="muted-text">尚未安装 Skills，可在下方商店一键下载或点击「新建本地 Skill」。</div>`;
      return;
    }
    el.innerHTML = "";
    for (const s of state.installedSkills) {
      const card = document.createElement("div");
      card.className = "store-card";
      card.innerHTML =
        `<div class="store-card-head"><span class="store-card-title">/${escHtml(s.slug)} · ${escHtml(s.name)}</span>` +
        `<span class="mini-tag">${s.enabled ? "已启用" : "已停用"}</span></div>` +
        `<div class="store-card-desc">${escHtml(s.description || s.content.slice(0, 90))}</div>` +
        `<div class="store-card-foot">` +
          `<button class="btn-secondary sm btn-toggle">${s.enabled ? "停用" : "启用"}</button>` +
          `<button class="btn-danger sm btn-rm">卸载</button>` +
        `</div>`;
      card.querySelector(".btn-toggle").addEventListener("click", async () => {
        await apiJson("/api/skills", { method: "POST", body: JSON.stringify({ ...s, enabled: !s.enabled }) });
        loadInstalledSkills();
      });
      card.querySelector(".btn-rm").addEventListener("click", async () => {
        await apiJson(`/api/skills/${encodeURIComponent(s.id)}`, { method: "DELETE" });
        loadInstalledSkills();
      });
      el.appendChild(card);
    }
  }

  async function searchSkills(q) {
    const el = $("store-skills-list");
    el.innerHTML = `<div class="muted-text">${q ? "正在联网搜索 GitHub 开源 Skills…" : "加载精选 Skills…"}</div>`;
    const data = await apiJson(`/api/stores/skills?q=${encodeURIComponent(q)}`);
    el.innerHTML = "";
    for (const s of data.items || []) {
      const card = document.createElement("div");
      card.className = "store-card";
      card.innerHTML =
        `<div class="store-card-head"><span class="store-card-title">${escHtml(s.name)}</span>` +
        `<span class="mini-tag">/${escHtml(s.slug)}</span></div>` +
        `<div class="store-card-desc">${escHtml(s.description)}</div>` +
        `<div class="store-card-foot">` +
          (s.source_url ? `<a class="link-btn" href="${escHtml(s.source_url)}" target="_blank">开源仓库 ↗</a>` : `<span></span>`) +
          `<button class="btn-primary sm btn-dl">下载并启用</button>` +
        `</div>`;
      card.querySelector(".btn-dl").addEventListener("click", async () => {
        toast(`正在下载 Skill：${s.name}…`);
        await apiJson("/api/skills", { method: "POST", body: JSON.stringify(s) });
        loadInstalledSkills();
        toast(`已安装 Skill /${s.slug}！`);
      });
      el.appendChild(card);
    }
  }

  function renderCustomBgs() {
    const sec = $("custom-bg-section");
    const grid = $("custom-bg-grid");
    if (!state.customBackgrounds.length) {
      sec.classList.add("hidden");
      return;
    }
    sec.classList.remove("hidden");
    grid.innerHTML = "";
    const curUrl = state.settings.appearance?.bgUrl || "";
    for (const bg of state.customBackgrounds) {
      const card = document.createElement("div");
      card.className = "wp-card" + (curUrl === bg.url ? " active" : "");
      card.innerHTML =
        `<div class="wp-thumb" style="background-image:url('${escHtml(bg.url)}')"></div>` +
        `<div class="wp-meta"><div class="wp-name">${escHtml(bg.name)}</div>` +
        `<div class="wp-sub" style="display:flex;justify-content:space-between;"><span>本地上传</span><button class="link-btn btn-rm-bg" style="padding:0;color:var(--err);">删除</button></div></div>`;
      card.addEventListener("click", (e) => {
        if (e.target.closest(".btn-rm-bg")) return;
        updateAppearance({ bgType: "upload", bgUrl: bg.url, bgName: bg.name });
        renderCustomBgs();
        toast(`已应用背景：${bg.name}`);
      });
      card.querySelector(".btn-rm-bg").addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await apiJson(`/api/backgrounds/${encodeURIComponent(bg.id)}`, { method: "DELETE" });
        state.customBackgrounds = res.backgrounds || [];
        renderCustomBgs();
      });
      grid.appendChild(card);
    }
  }

  async function searchWallpapers(q) {
    const grid = $("store-wp-grid");
    grid.innerHTML = `<div class="muted-text">${q ? "正在联网搜索 Wikimedia 免费开源高清壁纸…" : "加载精选开源壁纸…"}</div>`;
    const data = await apiJson(`/api/stores/wallpapers?q=${encodeURIComponent(q)}`);
    grid.innerHTML = "";
    const curUrl = state.settings.appearance?.bgUrl || "";
    for (const w of data.items || []) {
      const card = document.createElement("div");
      card.className = "wp-card" + ((w.type === "none" && !curUrl) || (w.url && curUrl === w.url) ? " active" : "");
      const thumbStyle = w.preview_css ? `background:${w.preview_css}` : `background-image:url('${escHtml(w.thumb || w.url)}')`;
      card.innerHTML =
        `<div class="wp-thumb" style="${thumbStyle}"></div>` +
        `<div class="wp-meta"><div class="wp-name">${escHtml(w.name)}</div><div class="wp-sub">${escHtml(w.license || "Open")} · ${escHtml(w.author || "")}</div></div>`;
      card.addEventListener("click", () => {
        updateAppearance({ bgType: w.type, bgUrl: w.url, bgName: w.name });
        grid.querySelectorAll(".wp-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        toast(`已应用背景：${w.name}`);
      });
      grid.appendChild(card);
    }
  }

  // ==================== MODAL: SETTINGS & DUAL-CHANNEL UPDATER ====================

  function openSettingsModal() {
    $("modal-settings").classList.remove("hidden");
    $("set-system-prompt").value = state.settings.system_prompt || "";
    $("set-permission-mode").value = state.settings.permission_mode || "auto";
    $("set-default-cwd").value = state.settings.default_cwd || "";
    $("set-update-channel").value = state.settings.update_channel || "stable";
    $("updater-current-line").textContent = `当前版本：v${state.version} · 仓库：github.com/gniygniynus/opencode-studio`;
  }

  async function runUpdateCheck() {
    const ch = $("set-update-channel").value;
    $("updater-result").textContent = `正在联网检查「${ch === "stable" ? "稳定版" : "最新版"}」通道更新…`;
    const res = await apiJson(`/api/updater/check?channel=${encodeURIComponent(ch)}`);
    if (!res.ok) {
      $("updater-result").innerHTML = `${escHtml(res.message || "检查失败")} <a class="link-btn" href="${escHtml(res.repo_url)}" target="_blank">打开 GitHub Releases ↗</a>`;
      return;
    }
    if (!res.target_version) {
      $("updater-result").innerHTML = `${escHtml(res.message)} <a class="link-btn" href="${escHtml(res.repo_url)}" target="_blank">查看 Releases ↗</a>`;
      return;
    }
    const statusLine = res.has_update
      ? `<b style="color:var(--brand);">发现新版本 ${escHtml(res.tag_name)}</b>（当前 v${escHtml(res.current_version)}）`
      : `<b style="color:var(--ok);">已是该通道最新版本 (${escHtml(res.tag_name)})</b>`;
    const dlBtn = res.recommended_asset
      ? `<a class="btn-primary sm" style="text-decoration:none;margin-right:8px;" href="${escHtml(res.recommended_asset.download_url)}" target="_blank">下载本平台安装包 (${escHtml(res.recommended_asset.name)})</a>`
      : "";
    $("updater-result").innerHTML =
      `<div>${statusLine} · 稳定版: <code>${escHtml(res.available_channels?.stable || "-")}</code> · 最新版: <code>${escHtml(res.available_channels?.latest || "-")}</code></div>` +
      `<div style="margin:8px 0;">${dlBtn}<a class="link-btn" href="${escHtml(res.release_url)}" target="_blank">查看完整发布说明 ↗</a></div>` +
      (res.notes ? `<pre class="tool-pre" style="max-height:140px;">${escHtml(res.notes)}</pre>` : "");
  }

  // ==================== MODAL: CWD / MEMORY / LOGS ====================

  async function browseCwd(dir) {
    $("cwd-manual-input").value = dir;
    const data = await apiJson(`/api/dirs?path=${encodeURIComponent(dir)}`);
    state.cwdBrowsePath = data.path;
    $("cwd-cur-path").textContent = data.path;
    $("cwd-shortcuts").innerHTML = "";
    for (const s of data.shortcuts || []) {
      const r = document.createElement("div");
      r.className = "dir-row";
      r.innerHTML = `<span>${escHtml(s.label)}</span><code class="mono">${escHtml(s.path)}</code>`;
      r.addEventListener("click", () => applyCwd(s.path));
      $("cwd-shortcuts").appendChild(r);
    }
    $("cwd-children").innerHTML = "";
    for (const ch of data.children || []) {
      const r = document.createElement("div");
      r.className = "dir-row";
      r.innerHTML = `<span>📁 ${escHtml(ch.name)}</span><button class="link-btn">选用</button>`;
      r.addEventListener("click", (e) => (e.target.tagName === "BUTTON" ? applyCwd(ch.path) : browseCwd(ch.path)));
      $("cwd-children").appendChild(r);
    }
  }

  async function applyCwd(p) {
    const clean = (p || "").trim();
    if (!clean) return;
    state.activeCwd = clean;
    $("cwd-pill-text").textContent = clean;
    $("modal-cwd").classList.add("hidden");
    if (state.activeSessionId) {
      await apiJson(`/api/sessions/${encodeURIComponent(state.activeSessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ cwd: clean }),
      });
    }
    toast(`工作目录已设为：${clean}`);
  }

  async function openMemoryModal() {
    $("modal-memory").classList.remove("hidden");
    const q = $("mem-search-input").value.trim();
    const data = await apiJson(`/api/memories?q=${encodeURIComponent(q)}`);
    state.memories = data.memories || [];
    renderMemoryList();
    if (!state.selectedMemory && state.memories.length) fillMemoryForm(state.memories[0]);
  }

  function renderMemoryList() {
    const box = $("mem-list");
    box.innerHTML = "";
    if (!state.memories.length) {
      box.innerHTML = `<div class="empty-hint">暂无记忆，点击「+ 新建」添加</div>`;
      return;
    }
    for (const m of state.memories) {
      const el = document.createElement("div");
      el.className = "stack-item" + (state.selectedMemory?.id === m.id ? " active" : "");
      el.innerHTML =
        `<div class="stack-item-head"><span>${m.pinned ? "📌 " : ""}${escHtml(m.title)}</span><span class="mini-tag">${m.scope}</span></div>` +
        `<div class="stack-item-sub">${escHtml(m.content.slice(0, 60))}</div>`;
      el.addEventListener("click", () => fillMemoryForm(m));
      box.appendChild(el);
    }
  }

  function fillMemoryForm(m) {
    state.selectedMemory = m;
    renderMemoryList();
    $("mf-title").value = m?.title || "";
    $("mf-scope").value = m?.scope || "global";
    $("mf-category").value = m?.category || "general";
    $("mf-pinned").checked = Boolean(m?.pinned);
    $("mf-content").value = m?.content || "";
    $("mf-version-info").textContent = m ? `版本 v${m.version} · ${fmtRelTime(m.updated_at)}` : "新建记忆";
    $("btn-delete-memory").disabled = !m;
  }

  async function openLogsModal(tab = "server") {
    state.activeLogTab = tab;
    $("log-error-dot").classList.add("hidden");
    $("modal-logs").classList.remove("hidden");
    document.querySelectorAll("[data-logtab]").forEach((b) => b.classList.toggle("active", b.dataset.logtab === tab));
    $("log-pane-server").classList.toggle("hidden", tab !== "server");
    $("log-pane-turn").classList.toggle("hidden", tab !== "turn");
    $("log-pane-report").classList.toggle("hidden", tab !== "report");
    await reloadLogs();
  }

  async function reloadLogs() {
    const tab = state.activeLogTab;
    if (tab === "server") {
      const lvl = $("log-level-filter").value;
      const data = await apiJson(`/api/logs?limit=150&level=${encodeURIComponent(lvl)}`);
      $("logs-path-line").textContent = `日志目录: ${data.paths?.server_jsonl || ""}`;
      const rows = (data.entries || []).slice().reverse();
      $("log-pane-server").innerHTML = rows.length
        ? rows.map((e) => `<div class="log-row ${escHtml(e.level)}">${escHtml(`${e.ts} [${e.level}] [${e.module}:${e.event}] ${e.msg}`)}</div>`).join("")
        : `<div class="empty-hint">暂无日志</div>`;
    } else if (tab === "turn") {
      if (!state.activeSessionId) {
        $("log-pane-turn").textContent = "请先打开一个会话。";
        return;
      }
      const data = await apiJson(`/api/logs/turn/${encodeURIComponent(state.activeSessionId)}`);
      $("logs-path-line").textContent = data.path;
      $("log-pane-turn").textContent = data.exists && data.lines.length ? data.lines.join("\n") : "该会话暂无追踪日志。";
    } else {
      const data = await apiJson(`/api/diagnostics?session_id=${encodeURIComponent(state.activeSessionId || "")}`);
      $("logs-path-line").textContent = `生成时间: ${data.generated_at}`;
      $("log-pane-report").textContent = data.markdown || "";
    }
  }

  async function copyAiReport() {
    const data = await apiJson(`/api/diagnostics?session_id=${encodeURIComponent(state.activeSessionId || "")}`);
    copyText(data.markdown || "", "已复制完整 AI 排障报告（Markdown）");
  }

  async function promptRename(sid, cur) {
    const next = window.prompt("重命名会话标题：", cur);
    if (!next || !next.trim()) return;
    await apiJson(`/api/sessions/${encodeURIComponent(sid)}`, { method: "PATCH", body: JSON.stringify({ title: next.trim() }) });
    if (sid === state.activeSessionId) $("thread-title").textContent = next.trim();
    refreshSessions();
  }

  async function confirmDeleteSession(sid, title) {
    if (!window.confirm(`确定删除会话「${title}」？`)) return;
    await apiJson(`/api/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
    if (sid === state.activeSessionId) startNewSession();
    refreshSessions();
  }

  // ==================== EVENTS ====================

  function bindEvents() {
    $("btn-new-session").addEventListener("click", startNewSession);
    $("btn-collapse-sidebar").addEventListener("click", () => {
      $("sidebar").classList.add("collapsed");
      $("btn-expand-sidebar").classList.remove("hidden");
    });
    $("btn-expand-sidebar").addEventListener("click", () => {
      $("sidebar").classList.remove("collapsed");
      $("btn-expand-sidebar").classList.add("hidden");
    });

    let gsTimer = null;
    $("global-search-input").addEventListener("input", () => {
      $("global-search-clear").classList.toggle("hidden", !$("global-search-input").value);
      clearTimeout(gsTimer);
      gsTimer = setTimeout(refreshSessions, 200);
    });
    $("global-search-clear").addEventListener("click", () => {
      $("global-search-input").value = "";
      $("global-search-clear").classList.add("hidden");
      refreshSessions();
    });
    $("cwd-filter-select").addEventListener("change", refreshSessions);

    // Quick welcome cards
    $("wc-providers")?.addEventListener("click", openProvidersModal);
    $("wc-stores")?.addEventListener("click", () => openStoresModal("mcp"));
    $("wc-wallpaper")?.addEventListener("click", () => openStoresModal("wallpapers"));
    $("wc-settings")?.addEventListener("click", openSettingsModal);

    // Navigation buttons
    $("btn-open-providers").addEventListener("click", openProvidersModal);
    $("btn-open-stores").addEventListener("click", () => openStoresModal("mcp"));
    $("btn-quick-bg").addEventListener("click", () => openStoresModal("wallpapers"));
    $("btn-open-memory").addEventListener("click", openMemoryModal);
    $("btn-open-settings").addEventListener("click", openSettingsModal);
    $("btn-open-logs").addEventListener("click", () => openLogsModal("server"));

    // Composer selectors (live provider/model switching)
    $("provider-select").addEventListener("change", async () => {
      const pid = $("provider-select").value;
      renderComposerSelectors(pid);
      try {
        await apiJson(`/api/providers/${encodeURIComponent(pid)}/activate`, {
          method: "POST",
          body: JSON.stringify({ model: $("model-select").value }),
        });
      } catch {}
    });
    $("model-select").addEventListener("change", async () => {
      updateThinkingSelector();
      const pid = $("provider-select").value;
      if (pid) {
        apiJson(`/api/providers/${encodeURIComponent(pid)}/activate`, {
          method: "POST",
          body: JSON.stringify({ model: $("model-select").value }),
        }).catch(() => {});
      }
    });
    $("btn-quick-compact").addEventListener("click", () => {
      if (!state.activeSessionId) return toast("当前为空白新会话");
      $("composer-input").value = "/compact";
      sendCurrentMessage();
    });

    // Composer input, paste, drag-drop
    $("composer-input").addEventListener("input", () => { autoResizeComposer(); saveDraft(); checkAutocomplete(); });
    $("composer-input").addEventListener("keydown", (ev) => {
      if (state.acOpen) {
        if (ev.key === "ArrowDown") { ev.preventDefault(); state.acIndex = (state.acIndex + 1) % state.acItems.length; return renderAutocomplete(); }
        if (ev.key === "ArrowUp") { ev.preventDefault(); state.acIndex = (state.acIndex - 1 + state.acItems.length) % state.acItems.length; return renderAutocomplete(); }
        if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); return applyAutocomplete(state.acIndex); }
        if (ev.key === "Escape") return closeAutocomplete();
      }
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        sendCurrentMessage();
      }
    });
    $("composer-input").addEventListener("paste", (ev) => {
      for (const item of ev.clipboardData?.items || []) {
        if (item.type?.startsWith("image/")) {
          ev.preventDefault();
          uploadChatImage(item.getAsFile());
        }
      }
    });
    $("composer-box").addEventListener("dragover", (e) => { e.preventDefault(); $("composer-box").classList.add("drag-over"); });
    $("composer-box").addEventListener("dragleave", () => $("composer-box").classList.remove("drag-over"));
    $("composer-box").addEventListener("drop", (e) => {
      e.preventDefault();
      $("composer-box").classList.remove("drag-over");
      for (const f of e.dataTransfer?.files || []) if (f.type.startsWith("image/")) uploadChatImage(f);
    });
    $("btn-attach-image").addEventListener("click", () => $("file-upload-input").click());
    $("file-upload-input").addEventListener("change", () => {
      for (const f of $("file-upload-input").files || []) uploadChatImage(f);
      $("file-upload-input").value = "";
    });
    $("btn-send").addEventListener("click", sendCurrentMessage);
    $("btn-stop").addEventListener("click", () => {
      if (state.activeSessionId && state.wsConnected) state.ws.send(JSON.stringify({ type: "stop_turn", session_id: state.activeSessionId }));
    });

    // Code copy delegation
    $("messages-container").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".md-code-copy");
      if (btn) copyText(decodeURIComponent(btn.dataset.code || ""), "已复制代码");
    });

    // Scroll bottom
    $("messages-scroll").addEventListener("scroll", () => {
      $("btn-scroll-bottom").classList.toggle("hidden", isNearBottom());
    });
    $("btn-scroll-bottom").addEventListener("click", () => scrollToBottom(true));

    // Drawer
    document.querySelectorAll(".seg-btn").forEach((b) =>
      b.addEventListener("click", () => (state.drawerOpen && state.drawerTab === b.dataset.tab ? closeDrawer() : openDrawer(b.dataset.tab))),
    );
    document.querySelectorAll(".drawer-tab").forEach((b) =>
      b.addEventListener("click", () => { state.drawerTab = b.dataset.tab; syncDrawerTabs(); }),
    );
    $("btn-close-drawer").addEventListener("click", closeDrawer);
    $("outline-filter").addEventListener("input", () => renderOutline(state.activeTimeline?.outline || []));
    $("thread-find-input").addEventListener("input", runThreadFind);
    $("thread-find-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); focusFind(state.findIndex + (e.shiftKey ? -1 : 1)); }
    });
    $("btn-find-prev").addEventListener("click", () => focusFind(state.findIndex - 1));
    $("btn-find-next").addEventListener("click", () => focusFind(state.findIndex + 1));

    // Title & CWD
    $("thread-title").addEventListener("click", () => {
      if (state.activeSessionId) promptRename(state.activeSessionId, $("thread-title").textContent);
    });
    $("cwd-pill").addEventListener("click", () => {
      $("modal-cwd").classList.remove("hidden");
      if (window.opencodeDesktop?.pickDirectory) $("btn-cwd-native").classList.remove("hidden");
      browseCwd(state.activeCwd || state.settings.default_cwd || "");
    });
    $("btn-cwd-native").addEventListener("click", async () => {
      const picked = await window.opencodeDesktop?.pickDirectory();
      if (picked) applyCwd(picked);
    });
    $("btn-cwd-browse").addEventListener("click", () => browseCwd($("cwd-manual-input").value.trim()));
    $("btn-cwd-apply").addEventListener("click", () => applyCwd($("cwd-manual-input").value.trim()));
    $("btn-cwd-up").addEventListener("click", () => {
      const cur = state.cwdBrowsePath || "";
      const sep = cur.includes("\\") ? "\\" : "/";
      const parts = cur.split(/[\\/]+/).filter(Boolean);
      if (parts.length <= 1) return;
      parts.pop();
      const parent = cur.includes("\\") ? parts.join("\\") + (parts.length === 1 ? "\\" : "") : "/" + parts.join("/");
      browseCwd(parent);
    });

    // Providers modal actions
    $("btn-add-provider").addEventListener("click", () => fillProviderForm(null));
    $("pf-kind").addEventListener("change", toggleProviderKindFields);
    $("btn-save-provider").addEventListener("click", saveProviderForm);
    $("btn-activate-provider").addEventListener("click", async () => {
      if (!state.selectedProviderId) return toast("请先保存供应商");
      await apiJson(`/api/providers/${encodeURIComponent(state.selectedProviderId)}/activate`, { method: "POST", body: JSON.stringify({}) });
      openProvidersModal();
      toast("已切换为当前活跃供应商");
    });
    $("btn-fetch-models").addEventListener("click", fetchModelsForSelected);
    $("btn-delete-provider").addEventListener("click", async () => {
      if (!state.selectedProviderId || !window.confirm("确定删除该供应商？")) return;
      await apiJson(`/api/providers/${encodeURIComponent(state.selectedProviderId)}`, { method: "DELETE" });
      state.selectedProviderId = null;
      openProvidersModal();
      toast("已删除");
    });

    // Stores tabs & searches
    document.querySelectorAll("[data-storetab]").forEach((b) => b.addEventListener("click", () => openStoresModal(b.dataset.storetab)));
    $("btn-search-mcp").addEventListener("click", () => searchMcp($("mcp-search-input").value.trim()));
    $("mcp-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMcp($("mcp-search-input").value.trim()); });
    $("btn-custom-mcp").addEventListener("click", async () => {
      const name = window.prompt("MCP 名称（如 my-mcp）：");
      if (!name) return;
      const cmdLine = window.prompt("启动命令（如 npx -y @modelcontextprotocol/server-memory）：");
      if (!cmdLine) return;
      const parts = cmdLine.trim().split(/\s+/);
      await apiJson("/api/mcp", { method: "POST", body: JSON.stringify({ name, command: parts[0], args: parts.slice(1), enabled: true }) });
      loadInstalledMcps();
      toast("已添加并启动自定义 MCP");
    });

    $("btn-search-skills").addEventListener("click", () => searchSkills($("skills-search-input").value.trim()));
    $("skills-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchSkills($("skills-search-input").value.trim()); });
    $("btn-custom-skill").addEventListener("click", async () => {
      const name = window.prompt("新建 Skill 名称（如 算法刷题教练）：");
      if (!name) return;
      const slug = window.prompt("调用代号 slug（英文，如 algo-coach）：", "custom-skill");
      if (!slug) return;
      const content = window.prompt("输入 Skill 指导指令：", `# ${name}\n\n请按专业规范协助用户完成任务。`);
      if (!content) return;
      await apiJson("/api/skills", { method: "POST", body: JSON.stringify({ name, slug, description: name, content, enabled: true }) });
      loadInstalledSkills();
      toast(`已创建 Skill /${slug}`);
    });

    $("ap-theme").addEventListener("change", () => updateAppearance({ theme: $("ap-theme").value }));
    $("ap-fontsize").addEventListener("input", () => updateAppearance({ fontSize: Number($("ap-fontsize").value) }));
    $("ap-blur").addEventListener("input", () => updateAppearance({ bgBlur: Number($("ap-blur").value) }));
    $("ap-opacity").addEventListener("input", () => updateAppearance({ bgOpacity: Number($("ap-opacity").value) }));
    $("btn-upload-bg").addEventListener("click", () => $("bg-upload-input").click());
    $("bg-upload-input").addEventListener("change", async () => {
      const file = $("bg-upload-input").files?.[0];
      if (!file) return;
      const dataUrl = await fileToDataUrl(file);
      const res = await apiJson("/api/backgrounds/upload", {
        method: "POST",
        body: JSON.stringify({ name: file.name, media_type: file.type, data: dataUrl }),
      });
      state.customBackgrounds = res.backgrounds || [];
      updateAppearance({ bgType: "upload", bgUrl: res.background.url, bgName: res.background.name });
      renderCustomBgs();
      toast("已上传并应用自定义背景");
      $("bg-upload-input").value = "";
    });
    $("btn-search-wp").addEventListener("click", () => searchWallpapers($("wp-search-input").value.trim()));
    $("wp-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchWallpapers($("wp-search-input").value.trim()); });

    // Settings & updater
    document.querySelectorAll(".prompt-preset").forEach((b) =>
      b.addEventListener("click", () => { $("set-system-prompt").value = PROMPT_PRESETS[b.dataset.preset] || ""; }),
    );
    $("btn-save-settings").addEventListener("click", async () => {
      const res = await apiJson("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          system_prompt: $("set-system-prompt").value,
          permission_mode: $("set-permission-mode").value,
          default_cwd: $("set-default-cwd").value.trim(),
          update_channel: $("set-update-channel").value,
        }),
      });
      state.settings = res.settings;
      toast("设置已保存并立即生效");
    });
    $("btn-check-update").addEventListener("click", runUpdateCheck);

    // Memory modal
    $("mem-search-input").addEventListener("input", openMemoryModal);
    $("btn-new-memory").addEventListener("click", () => fillMemoryForm(null));
    $("btn-save-memory").addEventListener("click", async () => {
      try {
        const res = await apiJson("/api/memories", {
          method: "POST",
          body: JSON.stringify({
            id: state.selectedMemory?.id,
            expected_version: state.selectedMemory?.version,
            title: $("mf-title").value.trim() || "未命名记忆",
            scope: $("mf-scope").value,
            cwd: state.activeCwd,
            category: $("mf-category").value.trim() || "general",
            pinned: $("mf-pinned").checked,
            content: $("mf-content").value,
          }),
        });
        state.selectedMemory = res.memory;
        openMemoryModal();
        toast("记忆已保存");
      } catch (err) {
        toast(err.message, 4000);
      }
    });
    $("btn-delete-memory").addEventListener("click", async () => {
      if (!state.selectedMemory || !window.confirm("确定删除该条记忆？")) return;
      await apiJson(`/api/memories/${encodeURIComponent(state.selectedMemory.id)}`, { method: "DELETE" });
      state.selectedMemory = null;
      openMemoryModal();
      toast("已删除记忆");
    });

    // Logs modal
    document.querySelectorAll("[data-logtab]").forEach((b) => b.addEventListener("click", () => openLogsModal(b.dataset.logtab)));
    $("log-level-filter").addEventListener("change", reloadLogs);
    $("btn-reload-logs").addEventListener("click", reloadLogs);
    $("btn-copy-ai-report").addEventListener("click", copyAiReport);

    // Confirm dangerous command modal
    $("btn-confirm-allow").addEventListener("click", () => {
      if (state.activeConfirmId && state.wsConnected) {
        state.ws.send(JSON.stringify({ type: "confirm_response", confirm_id: state.activeConfirmId, approved: true }));
      }
      state.activeConfirmId = null;
      $("modal-confirm").classList.add("hidden");
    });
    $("btn-confirm-deny").addEventListener("click", () => {
      if (state.activeConfirmId && state.wsConnected) {
        state.ws.send(JSON.stringify({ type: "confirm_response", confirm_id: state.activeConfirmId, approved: false }));
      }
      state.activeConfirmId = null;
      $("modal-confirm").classList.add("hidden");
    });

    // Close modals (delegated + Esc)
    document.addEventListener("click", (ev) => {
      const closeBtn = ev.target.closest(".modal-close");
      if (closeBtn) {
        const targetId = closeBtn.getAttribute("data-close");
        if (targetId) $(targetId)?.classList.add("hidden");
        else closeBtn.closest(".modal-backdrop")?.classList.add("hidden");
      }
    });
    document.querySelectorAll(".modal-backdrop").forEach((bd) =>
      bd.addEventListener("click", (e) => { if (e.target === bd && bd.id !== "modal-confirm") bd.classList.add("hidden"); }),
    );
    $("lightbox").addEventListener("click", () => $("lightbox").classList.add("hidden"));

    // Shortcuts
    window.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f" && state.activeTimeline) {
        ev.preventDefault();
        openDrawer("find");
      } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "o") {
        ev.preventDefault();
        startNewSession();
      } else if (ev.key === "Escape") {
        $("lightbox").classList.add("hidden");
        closeAutocomplete();
        document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach((bd) => {
          if (bd.id !== "modal-confirm") bd.classList.add("hidden");
        });
      }
    });
  }

  // ==================== BOOTSTRAP ====================

  async function init() {
    bindEvents();
    const boot = await apiJson("/api/bootstrap");
    state.version = boot.version || "1.0.0";
    state.settings = boot.settings || {};
    state.providers = boot.providers || [];
    state.activeProvider = boot.active_provider;
    state.claudeNative = boot.claude_native;
    state.installedMcps = boot.installed_mcps || [];
    state.installedSkills = boot.installed_skills || [];
    state.customBackgrounds = boot.custom_backgrounds || [];
    state.activeCwd = state.settings.default_cwd || "";

    $("app-version-badge").textContent = `v${state.version} · 开源透明`;
    $("cwd-pill-text").textContent = state.activeCwd || "选择目录";

    applyAppearance(state.settings.appearance || {});
    renderComposerSelectors();
    connectWs();
    await refreshSessions();
    restoreDraft();
    $("composer-input").focus();
  }

  init().catch((err) => toast("初始化失败: " + err.message, 5000));
})();
