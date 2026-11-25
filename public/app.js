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

    // Live wallpaper & pagination
    liveBgEngine: null,
    _activeBgSig: "",
    _activeStaticSlot: "a",
    _bgSwapToken: 0,
    _liveRafId: null,
    zenMode: false,
    showAllMessages: false,
    lastWpItems: [],
    wpCategory: "all",
    wpPage: 1,
    wpHasMore: false,
    wpSearchTimer: null,
    mcpSearchTimer: null,
    skillSearchTimer: null,
  };

  const SVG_ICONS = {
    edit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`,
    copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
    regen: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>`,
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

  const _layerTimers = new WeakMap();

  function openAnimatedLayer(el) {
    if (!el) return;
    const prev = _layerTimers.get(el);
    if (prev) {
      clearTimeout(prev);
      _layerTimers.delete(el);
    }
    if (!el.classList.contains("hidden") && el.classList.contains("is-open")) {
      el.classList.remove("is-closing");
      return;
    }
    el.classList.remove("hidden", "is-closing");
    // Double rAF guarantees the browser paints the initial state before transitioning
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!el.classList.contains("hidden")) el.classList.add("is-open");
      });
    });
  }

  function closeAnimatedLayer(el, dur = 190) {
    if (!el || el.classList.contains("hidden")) return;
    const prev = _layerTimers.get(el);
    if (prev) clearTimeout(prev);
    el.classList.remove("is-open");
    el.classList.add("is-closing");
    const tid = setTimeout(() => {
      _layerTimers.delete(el);
      el.classList.add("hidden");
      el.classList.remove("is-closing");
    }, dur);
    _layerTimers.set(el, tid);
  }

  function openModal(idOrEl) {
    const el = typeof idOrEl === "string" ? $(idOrEl) : idOrEl;
    openAnimatedLayer(el);
  }

  function closeModal(idOrEl) {
    const el = typeof idOrEl === "string" ? $(idOrEl) : idOrEl;
    if (el && el.id === "modal-settings" && state._promptDirty) {
      flushPromptAutoSave(true);
    }
    closeAnimatedLayer(el, 180);
  }

  function triggerViewFade(el) {
    if (!el) return;
    el.classList.remove("view-fade-in");
    void el.offsetWidth;
    el.classList.add("view-fade-in");
  }

  function toast(msg, ms = 2600) {
    const root = $("toast-root");
    if (!root) return;
    // Keep toast stack clean (max 3 active toasts)
    const active = root.querySelectorAll(".toast:not(.is-closing)");
    if (active.length >= 3) {
      const oldest = active[0];
      oldest.classList.remove("is-open");
      oldest.classList.add("is-closing");
      setTimeout(() => oldest.remove(), 220);
    }
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("is-open"));
    setTimeout(() => {
      el.classList.remove("is-open");
      el.classList.add("is-closing");
      setTimeout(() => el.remove(), 240);
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

  function autoResizeTextarea(el, minH = 76, maxH = 360) {
    if (!el) return;
    el.style.height = minH + "px";
    el.style.height = Math.min(Math.max(el.scrollHeight, minH), maxH) + "px";
  }

  function insertNewlineAtTextarea(el, afterInsert) {
    if (!el) return;
    const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + "\n" + el.value.slice(end);
    const caret = start + 1;
    el.selectionStart = caret;
    el.selectionEnd = caret;
    if (typeof afterInsert === "function") afterInsert();
    // Ensure caret remains visible when adding lines near bottom of max-height
    if (caret >= el.value.length) el.scrollTop = el.scrollHeight;
  }

  function autoResizeComposer() {
    const el = $("composer-input");
    if (!el) return;
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

  // ==================== APPEARANCE & WALLPAPER (ZERO-FLICKER DUAL-BUFFER CROSSFADE) ====================

  function _hideStaticWallpaperLayers() {
    const layerA = $("wallpaper-layer");
    const layerB = $("wallpaper-layer-b");
    layerA?.classList.remove("wp-visible");
    layerB?.classList.remove("wp-visible");
    setTimeout(() => {
      if (layerA && !layerA.classList.contains("wp-visible")) layerA.style.backgroundImage = "none";
      if (layerB && !layerB.classList.contains("wp-visible")) layerB.style.backgroundImage = "none";
    }, 450);
  }

  function _crossfadeStaticBg(cssBgValue, token) {
    if (token !== state._bgSwapToken) return;
    const layerA = $("wallpaper-layer");
    const layerB = $("wallpaper-layer-b");
    if (!layerA) return;
    if (!layerB) {
      layerA.style.backgroundImage = cssBgValue;
      layerA.classList.add("wp-visible");
      return;
    }
    const nextSlot = state._activeStaticSlot === "a" ? "b" : "a";
    const incoming = nextSlot === "a" ? layerA : layerB;
    const outgoing = nextSlot === "a" ? layerB : layerA;

    incoming.style.backgroundImage = cssBgValue;
    // Ensure incoming is painted before crossfading in, keeping outgoing visible underneath so 0 white flash occurs
    requestAnimationFrame(() => {
      if (token !== state._bgSwapToken) return;
      incoming.classList.add("wp-visible");
      outgoing.classList.remove("wp-visible");
      state._activeStaticSlot = nextSlot;
      setTimeout(() => {
        if (!outgoing.classList.contains("wp-visible")) {
          outgoing.style.backgroundImage = "none";
        }
      }, 460);
    });
  }

  function applyAppearance(ap = {}) {
    const theme = ap.theme === "dark" ? "dark" : "light";
    const bgMode = ap.bgMode === "hd" ? "hd" : "subtle";
    const bubbleStyle = ap.bubbleStyle === "text" ? "text" : "card";
    const bubbleAlpha = ap.bubbleOpacity !== undefined ? Number(ap.bubbleOpacity) : (ap.bgOpacity ?? 0.88);
    const sidebarAlpha = ap.sidebarOpacity !== undefined ? Number(ap.sidebarOpacity) : (bgMode === "hd" ? 0.52 : 0.84);

    // 1. Update CSS tokens & body classes (instant, zero media disruption!)
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--font-size-base", `${ap.fontSize || 14.5}px`);
    try {
      localStorage.setItem("ocs_ap_snap", JSON.stringify({ theme, fontSize: ap.fontSize || 14.5 }));
    } catch {}

    const blurPx = bgMode === "hd" ? 0 : (ap.bgBlur ?? 10);
    document.documentElement.style.setProperty("--bg-blur", `${blurPx}px`);
    document.documentElement.style.setProperty("--bubble-alpha", String(bubbleAlpha));
    document.documentElement.style.setProperty("--sidebar-alpha", String(sidebarAlpha));
    document.body.classList.toggle("bg-mode-hd", bgMode === "hd");
    document.body.classList.toggle("bubble-text-only", bubbleStyle === "text");

    const videoEl = $("wallpaper-video");
    const webEl = $("wallpaper-web");
    if (!state.liveBgEngine && window.OpenCodeLiveBg) {
      state.liveBgEngine = new window.OpenCodeLiveBg($("wallpaper-canvas"));
    }

    const bgType = ap.bgType || "none";
    const hasBg = bgType !== "none" && Boolean(ap.bgUrl || ap.liveBg);
    const isGrad =
      bgType === "gradient" ||
      String(ap.bgUrl || "").startsWith("linear-gradient") ||
      String(ap.bgUrl || "").startsWith("radial-gradient");
    const normKind = !hasBg
      ? "none"
      : bgType === "live" && ap.liveBg
        ? "live"
        : bgType === "web" && ap.bgUrl
          ? "web"
          : bgType === "video" && ap.bgUrl
            ? "video"
            : isGrad
              ? "gradient"
              : "image";
    const mediaVal = normKind === "live" ? String(ap.liveBg || "") : String(ap.bgUrl || "");
    const nextSig = normKind === "none" ? "none" : `${normKind}|${mediaVal}`;

    document.body.classList.toggle("has-wallpaper", hasBg);
    document.documentElement.style.setProperty("--glass-alpha", hasBg ? String(bubbleAlpha) : "0.98");

    // Always keep mute preference in sync without ever pausing playback
    if (videoEl) {
      videoEl.muted = state.settings.wallpaper_engine?.video_muted !== false;
    }

    // 2. Dirty-check wallpaper media: dragging sliders / switching themes / async settings save NEVER restarts video or flashes wallpaper!
    const isSeamlessOfflinePin =
      normKind === "image" &&
      Boolean(ap.sourceUrl) &&
      String(ap.bgUrl || "").startsWith("/api/bg-files/active_wallpaper_") &&
      state._activeBgSig === `image|${ap.sourceUrl}`;

    if (isSeamlessOfflinePin) {
      state._activeBgSig = nextSig;
    } else if (nextSig !== state._activeBgSig) {
      const prevSig = state._activeBgSig;
      state._activeBgSig = nextSig;
      const token = ++state._bgSwapToken;

      const stopNonTarget = (keep) => {
        if (keep !== "static") _hideStaticWallpaperLayers();
        if (keep !== "live") state.liveBgEngine?.setMode("");
        if (keep !== "video" && videoEl) {
          videoEl.classList.remove("wp-visible");
          setTimeout(() => {
            if (token === state._bgSwapToken && !videoEl.classList.contains("wp-visible")) {
              videoEl.pause();
              videoEl.classList.add("hidden");
            }
          }, 360);
        }
        if (keep !== "web" && webEl) {
          webEl.classList.remove("wp-visible");
          setTimeout(() => {
            if (token === state._bgSwapToken && !webEl.classList.contains("wp-visible")) {
              webEl.removeAttribute("src");
              webEl.classList.add("hidden");
            }
          }, 360);
        }
      };

      if (normKind === "none") {
        stopNonTarget("");
      } else if (normKind === "live") {
        stopNonTarget("live");
        state.liveBgEngine?.setMode(ap.liveBg);
      } else if (normKind === "web" && webEl) {
        stopNonTarget("web");
        webEl.classList.remove("hidden", "wp-visible");
        const revealWeb = () => {
          if (token === state._bgSwapToken) webEl.classList.add("wp-visible");
        };
        webEl.onload = revealWeb;
        if (webEl.getAttribute("src") !== ap.bgUrl) webEl.setAttribute("src", ap.bgUrl);
        setTimeout(revealWeb, 160);
      } else if (normKind === "video" && videoEl) {
        stopNonTarget("video");
        const sameSrc = videoEl.getAttribute("src") === ap.bgUrl;
        videoEl.muted = state.settings.wallpaper_engine?.video_muted !== false;
        videoEl.classList.remove("hidden");
        const revealVideo = () => {
          if (token === state._bgSwapToken) videoEl.classList.add("wp-visible");
        };
        if (!sameSrc) {
          videoEl.classList.remove("wp-visible");
          videoEl.addEventListener("loadeddata", revealVideo, { once: true });
          videoEl.addEventListener("canplay", revealVideo, { once: true });
          videoEl.setAttribute("src", ap.bgUrl);
        } else if (videoEl.readyState >= 2) {
          requestAnimationFrame(revealVideo);
        }
        videoEl.play().then(revealVideo).catch(() => {});
        setTimeout(revealVideo, 450);
      } else if (normKind === "gradient") {
        stopNonTarget("static");
        _crossfadeStaticBg(ap.bgUrl, token);
      } else if (normKind === "image") {
        stopNonTarget("static");
        const targetUrl = ap.bgUrl;
        const cssUrl = `url("${targetUrl.replace(/"/g, '\\"')}")`;
        const preloader = new Image();
        let done = false;
        const commit = () => {
          if (done || token !== state._bgSwapToken) return;
          done = true;
          _crossfadeStaticBg(cssUrl, token);
        };
        preloader.onload = () => {
          if (typeof preloader.decode === "function") {
            preloader.decode().then(commit).catch(commit);
          } else {
            commit();
          }
        };
        preloader.onerror = () => {
          if (done || token !== state._bgSwapToken) return;
          done = true;
          state._activeBgSig = prevSig;
          toast("该壁纸资源暂时加载超时，请换一张壁纸或检查网络设置", 3200);
        };
        preloader.src = targetUrl;
        if (preloader.complete && preloader.naturalWidth > 0) commit();
      }
    }

    // 3. Sync controls cleanly (never fight the user while actively dragging a range slider)
    const setIfIdle = (id, val) => {
      const el = $(id);
      if (el && document.activeElement !== el) el.value = String(val);
    };
    setIfIdle("ap-theme", theme);
    $("btn-bgmode-hd")?.classList.toggle("active", bgMode === "hd");
    $("btn-bgmode-subtle")?.classList.toggle("active", bgMode !== "hd");
    $("btn-bubble-card")?.classList.toggle("active", bubbleStyle !== "text");
    $("btn-bubble-text")?.classList.toggle("active", bubbleStyle === "text");
    setIfIdle("ap-fontsize", ap.fontSize || 14.5);
    if ($("ap-fontsize-val")) $("ap-fontsize-val").textContent = `${ap.fontSize || 14.5}px`;
    setIfIdle("ap-blur", ap.bgBlur ?? 10);
    if ($("ap-blur-val")) $("ap-blur-val").textContent = `${blurPx}px`;
    setIfIdle("ap-bubble-opacity", bubbleAlpha);
    if ($("ap-bubble-opacity-val")) $("ap-bubble-opacity-val").textContent = `${Math.round(bubbleAlpha * 100)}%`;
    setIfIdle("ap-sidebar-opacity", sidebarAlpha);
    if ($("ap-sidebar-opacity-val")) $("ap-sidebar-opacity-val").textContent = `${Math.round(sidebarAlpha * 100)}%`;
  }

  function renderWallpaperStorage(st) {
    if (st) state.wallpaperStorage = st;
    const info = state.wallpaperStorage;
    const el = $("wp-storage-info");
    if (!el || !info) return;
    el.textContent =
      `离线壁纸快照 ${info.active_mb} MB · 已上传 ${info.uploads_mb} MB · 预览缓存 ${info.cache_mb}/${info.cache_limit_mb} MB（断网可用 · 切换自动删旧）`;
  }

  let apSaveTimer = null;
  let apSaveSeq = 0;
  function updateAppearance(patch) {
    const next = { ...(state.settings.appearance || {}), ...patch };
    state.settings.appearance = next;
    applyAppearance(next);
    clearTimeout(apSaveTimer);
    const seq = ++apSaveSeq;
    apSaveTimer = setTimeout(() => {
      apiJson("/api/settings", { method: "PUT", body: JSON.stringify({ appearance: next }) })
        .then((res) => {
          if (seq !== apSaveSeq) return;
          if (res?.settings?.appearance) {
            state.settings.appearance = res.settings.appearance;
            applyAppearance(res.settings.appearance);
          }
          if (res?.wallpaper_storage) renderWallpaperStorage(res.wallpaper_storage);
        })
        .catch(() => {});
    }, 260);
  }

  // ==================== SAFE GFM MARKDOWN + ZERO-DEP SYNTAX HIGHLIGHTING ====================

  const SYNTAX_TOKEN_RE =
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(async|await|break|case|catch|class|const|continue|def|default|delete|do|elif|else|enum|export|extends|false|finally|fn|for|from|func|function|if|impl|import|in|interface|let|loop|match|mod|mut|new|nil|None|null|package|pub|raise|return|select|self|static|struct|super|switch|then|this|throw|trait|true|try|type|typeof|undefined|use|var|void|where|while|with|yield|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|LEFT|INNER|CREATE|TABLE|INDEX|AND|OR|NOT|NULL|AS|ORDER|GROUP|BY|LIMIT)\b|\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b([A-Z][A-Za-z0-9_]{1,})\b|\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/g;

  const LANG_DOT_COLORS = {
    js: "#f59e0b", javascript: "#f59e0b", mjs: "#f59e0b", cjs: "#f59e0b", jsx: "#f59e0b",
    ts: "#3b82f6", typescript: "#3b82f6", tsx: "#3b82f6",
    py: "#10b981", python: "#10b981",
    rs: "#ea580c", rust: "#ea580c",
    go: "#06b6d4", golang: "#06b6d4",
    sh: "#22c55e", bash: "#22c55e", zsh: "#22c55e", powershell: "#38bdf8", ps1: "#38bdf8", cmd: "#94a3b8", bat: "#94a3b8",
    json: "#eab308", yaml: "#ec4899", yml: "#ec4899", toml: "#ec4899",
    html: "#f97316", css: "#8b5cf6", scss: "#ec4899", sql: "#6366f1", md: "#64748b", markdown: "#64748b",
  };

  function highlightCodeSyntax(rawCode, lang, skipHeavy = false) {
    const cleanLang = String(lang || "text").toLowerCase();
    if (skipHeavy || rawCode.length > 24000 || cleanLang === "text" || cleanLang === "txt" || cleanLang === "plaintext") {
      return escHtml(rawCode);
    }
    let out = "";
    let lastIdx = 0;
    SYNTAX_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = SYNTAX_TOKEN_RE.exec(rawCode)) !== null) {
      if (m.index > lastIdx) {
        out += escHtml(rawCode.slice(lastIdx, m.index));
      }
      const tok = escHtml(m[0]);
      if (m[1] !== undefined) out += `<span class="tok-com">${tok}</span>`;
      else if (m[2] !== undefined) out += `<span class="tok-str">${tok}</span>`;
      else if (m[3] !== undefined) out += `<span class="tok-kw">${tok}</span>`;
      else if (m[4] !== undefined) out += `<span class="tok-num">${tok}</span>`;
      else if (m[5] !== undefined) out += `<span class="tok-typ">${tok}</span>`;
      else if (m[6] !== undefined) out += `<span class="tok-fn">${tok}</span>`;
      else out += tok;
      lastIdx = SYNTAX_TOKEN_RE.lastIndex;
    }
    if (lastIdx < rawCode.length) {
      out += escHtml(rawCode.slice(lastIdx));
    }
    return out;
  }

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

  const _mdCache = new Map();
  const MD_CACHE_MAX = 400;

  function renderMarkdown(md, isStreaming = false) {
    if (!md) return "";
    const str = String(md);
    const cacheable = !isStreaming && str.length <= 65536;
    if (cacheable && _mdCache.has(str)) {
      const hit = _mdCache.get(str);
      _mdCache.delete(str);
      _mdCache.set(str, hit);
      return hit;
    }
    const lines = str.replace(/\r\n/g, "\n").split("\n");
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
        const closed = i < lines.length && /^```\s*$/.test(lines[i]);
        if (closed) i++;
        const rawCode = codeLines.join("\n");
        const lineCount = codeLines.length;
        const skipSyntax = isStreaming && !closed && rawCode.length > 6000;
        const codeHtml = highlightCodeSyntax(rawCode, lang, skipSyntax);
        const dotColor = LANG_DOT_COLORS[lang.toLowerCase()] || "var(--brand)";
        const collapsible = !isStreaming && lineCount > 32;
        out.push(
          `<div class="md-code-block${collapsible ? " is-collapsed" : ""}">` +
            `<div class="md-code-head">` +
              `<span class="md-code-lang"><span class="md-code-dot" style="background:${dotColor};"></span><span>${escHtml(lang)}</span><span class="md-code-lines">${lineCount} 行</span></span>` +
              `<span class="md-code-actions"><button type="button" class="md-code-copy" data-code="${encodeURIComponent(rawCode)}">复制代码</button></span>` +
            `</div>` +
            `<pre><code>${codeHtml}</code></pre>` +
            (collapsible
              ? `<div class="md-code-expand-bar"><button type="button" class="md-code-toggle" data-lines="${lineCount}">展开全部 ${lineCount} 行代码 ▾</button></div>`
              : "") +
          `</div>`,
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
    const html = out.join("");
    if (cacheable) {
      if (_mdCache.size >= MD_CACHE_MAX) {
        const oldestKey = _mdCache.keys().next().value;
        _mdCache.delete(oldestKey);
      }
      _mdCache.set(str, html);
    }
    return html;
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

  // ==================== CUSTOM GLASS DROPDOWNS & CONTEXT DISPLAY ====================

  function closeAllGlassDropdowns() {
    document.querySelectorAll(".glass-dropdown.open").forEach((dd) => {
      dd.classList.remove("open");
      const menu = dd.querySelector(".gd-menu");
      if (menu) closeAnimatedLayer(menu, 160);
    });
  }

  function renderGlassMenu(ddId, menuId, labelId, items, currentValue, onPick) {
    const dd = $(ddId);
    const menu = $(menuId);
    const lbl = $(labelId);
    if (!dd || !menu || !lbl) return;
    const cur = items.find((i) => i.value === currentValue) || items[0];
    lbl.textContent = cur ? cur.triggerLabel || cur.label : "未选择";
    menu.innerHTML = "";
    for (const it of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gd-item" + (it.value === currentValue ? " active" : "");
      btn.innerHTML =
        `<span class="gd-item-main">${escHtml(it.label)}</span>` +
        (it.sub ? `<span class="gd-item-sub">${escHtml(it.sub)}</span>` : "");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllGlassDropdowns();
        onPick(it.value);
      });
      menu.appendChild(btn);
    }
  }

  function updateContextDisplay() {
    const info = getSelectedModelInfo();
    const maxCtx = info?.context_window || 128000;
    const live = state.activeSessionId ? state.liveStream.get(state.activeSessionId) : null;
    const liveTok =
      (Number(live?.usage?.input_tokens) || 0) +
      (Number(live?.usage?.cache_read_input_tokens) || 0) +
      (Number(live?.usage?.output_tokens) || 0);
    const usedCtx = Math.max(state.activeTimeline?.activity?.context_tokens || 0, liveTok);
    const ctxPill = $("ctx-pill");
    if (!ctxPill) return;
    if (state.activeTimeline?.items?.length || liveTok > 0) {
      const pct = maxCtx > 0 ? Math.min(100, (usedCtx / maxCtx) * 100) : 0;
      let pctText = "0%";
      if (usedCtx > 0 && pct > 0) {
        pctText = pct < 1 ? `${Math.max(0.01, pct).toFixed(2)}%` : `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
      }
      ctxPill.textContent = `上下文 ${usedCtx > 0 ? fmtTokens(usedCtx) : "0"}/${fmtTokens(maxCtx)} (${pctText})`;
      ctxPill.title = `当前会话已用约 ${usedCtx.toLocaleString()} Tokens / 模型上限 ${maxCtx.toLocaleString()} Tokens`;
      ctxPill.classList.remove("hidden");
    } else {
      ctxPill.classList.add("hidden");
    }
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

    // Custom glass dropdown for providers
    renderGlassMenu(
      "gd-provider",
      "gd-provider-menu",
      "gd-provider-label",
      state.providers.map((p) => ({
        value: p.id,
        label: p.name,
        triggerLabel: p.name,
        sub: p.kind === "claude_native" ? "原生Auth" : p.kind.toUpperCase(),
      })),
      pSel.value,
      async (pid) => {
        pSel.value = pid;
        renderComposerSelectors(pid);
        try {
          await apiJson(`/api/providers/${encodeURIComponent(pid)}/activate`, {
            method: "POST",
            body: JSON.stringify({ model: $("model-select").value }),
          });
        } catch {}
      },
    );

    // Populate models directly showing real model names (clean & untruncated)
    const mSel = $("model-select");
    mSel.innerHTML = "";
    const infos = prov?.model_infos || [];
    const modelItems = [];
    if (!infos.length) {
      const val = prov?.default_model || "";
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = val || "请在左侧供应商拉取模型";
      mSel.appendChild(opt);
      modelItems.push({ value: val, label: val || "请在左侧供应商拉取模型", triggerLabel: val || "未配置模型", sub: "" });
    } else {
      const dispCounts = new Map();
      for (const info of infos) {
        dispCounts.set(info.display_name, (dispCounts.get(info.display_name) || 0) + 1);
      }
      for (const info of infos) {
        const shownName = (dispCounts.get(info.display_name) || 0) > 1 ? info.id : info.display_name;
        const opt = document.createElement("option");
        opt.value = info.id;
        opt.textContent = shownName;
        mSel.appendChild(opt);
        const ctxTag = fmtTokens(info.context_window);
        const subParts = [ctxTag, info.thinking_supported ? "思考" : "", info.vision ? "识图" : ""].filter(Boolean);
        modelItems.push({
          value: info.id,
          label: shownName,
          triggerLabel: shownName,
          sub: subParts.join(" · "),
        });
      }
      const targetModel =
        (preferredModel && infos.some((i) => i.id === preferredModel) ? preferredModel : null) ||
        prov.default_model ||
        infos[0].id;
      mSel.value = targetModel;
    }

    renderGlassMenu("gd-model", "gd-model-menu", "gd-model-label", modelItems, mSel.value, (mid) => {
      mSel.value = mid;
      updateThinkingSelector();
      updateContextDisplay();
      const pid = pSel.value;
      if (pid) {
        apiJson(`/api/providers/${encodeURIComponent(pid)}/activate`, {
          method: "POST",
          body: JSON.stringify({ model: mid }),
        }).catch(() => {});
      }
    });

    updateThinkingSelector(preferredThinking);
    updateContextDisplay();
  }

  function updateThinkingSelector(preferredThinking = "") {
    const prov = getSelectedProvider();
    const info = getSelectedModelInfo();
    const tSel = $("thinking-select");
    const gdThink = $("gd-thinking");

    if (prov && $("model-select").value) {
      const mLabel = info?.display_name || $("model-select").value;
      const ccTag = state.claudeNative?.installed
        ? `${state.claudeNative.bundled ? "内置原生" : "原生"} Claude Code ${state.claudeNative.version}`
        : "内置开放 API 引擎";
      $("sidebar-prov-model").textContent = mLabel;
      $("composer-engine-note").textContent =
        prov.kind === "claude_native"
          ? `${ccTag} · 官方 Auth (${mLabel})`
          : `${ccTag} · ${prov.name} / ${mLabel}`;
      // Keep model button label synced
      const ml = $("gd-model-label");
      if (ml) ml.textContent = mLabel;
    }

    updateContextDisplay();

    if (!info || !info.thinking_supported || !info.thinking_levels?.length) {
      tSel.classList.add("hidden");
      tSel.innerHTML = "";
      gdThink?.classList.add("hidden");
      return;
    }

    const labelMap = { off: "关闭", on: "开启", low: "低", medium: "中", high: "高", xhigh: "极高", max: "极致" };
    const prefix = info.thinking_mode === "openai_effort" ? "推理" : "思考";
    tSel.innerHTML = "";
    const thinkItems = [];
    for (const lvl of info.thinking_levels) {
      const txt = `${prefix}: ${labelMap[lvl] || lvl}`;
      const opt = document.createElement("option");
      opt.value = lvl;
      opt.textContent = txt;
      tSel.appendChild(opt);
      thinkItems.push({ value: lvl, label: txt, triggerLabel: txt, sub: lvl });
    }
    const chosen =
      preferredThinking && info.thinking_levels.includes(preferredThinking)
        ? preferredThinking
        : info.default_thinking || info.thinking_levels[0];
    tSel.value = chosen;
    gdThink?.classList.remove("hidden");
    const onPickThink = (val) => {
      tSel.value = val;
      renderGlassMenu("gd-thinking", "gd-thinking-menu", "gd-thinking-label", thinkItems, val, onPickThink);
    };
    renderGlassMenu("gd-thinking", "gd-thinking-menu", "gd-thinking-label", thinkItems, chosen, onPickThink);
  }

  // ==================== SESSION LIST (PINNING + TIME GROUPING) ====================

  function classifySessionTimeGroup(s) {
    if (s.pinned) return "📌 已置顶";
    const ms = Date.parse(s.updated_at || "") || 0;
    if (!ms) return "更早";
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= todayStart) return "今天";
    if (ms >= todayStart - 6 * 86400_000) return "近 7 天";
    return "更早";
  }

  function syncWelcomeResumePill() {
    const wrap = $("welcome-resume-wrap");
    const titleEl = $("resume-latest-title");
    if (!wrap || !titleEl) return;
    const latest = state.sessions?.[0];
    if (!state.activeSessionId && latest) {
      titleEl.textContent = latest.title || "未命名会话";
      wrap.classList.remove("hidden");
    } else {
      wrap.classList.add("hidden");
    }
  }

  async function togglePinSession(sid, nextPinned) {
    try {
      await apiJson(`/api/sessions/${encodeURIComponent(sid)}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: Boolean(nextPinned) }),
      });
      toast(nextPinned ? "已置顶该会话" : "已取消置顶");
      refreshSessions();
    } catch (err) {
      toast("更新置顶状态失败: " + err.message);
    }
  }

  function renderSessionList() {
    const list = state.sessions;
    const q = $("global-search-input").value.trim();
    const el = $("session-list");
    syncWelcomeResumePill();

    if (!list.length) {
      el.innerHTML = `<div class="empty-hint">${q ? "没有找到匹配的对话" : "点击右上角 + 开启新会话"}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    let lastGroup = "";
    const showGroups = !q && list.length >= 4;

    for (const s of list) {
      if (showGroups) {
        const grp = classifySessionTimeGroup(s);
        if (grp !== lastGroup) {
          lastGroup = grp;
          const gl = document.createElement("div");
          gl.className = "session-group-label";
          gl.textContent = grp;
          frag.appendChild(gl);
        }
      }

      const item = document.createElement("div");
      item.className = "session-item" + (s.id === state.activeSessionId ? " active" : "");
      const running = state.runningIds.has(s.id);
      const snippet = q && s.match_snippet ? `<div class="session-item-snippet">${highlightHtml(s.match_snippet, q)}</div>` : "";
      item.innerHTML =
        `<div class="session-item-row">` +
          (running ? `<span class="pulse-dot" title="后台运行中"></span>` : s.pinned ? `<span class="session-pin-mark" title="已置顶">📌</span>` : "") +
          `<span class="session-item-title">${highlightHtml(s.title, q)}</span>` +
          `<div class="session-item-actions">` +
            `<button class="icon-btn xs btn-pin${s.pinned ? " is-pinned" : ""}" title="${s.pinned ? "取消置顶" : "置顶会话"}">📌</button>` +
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
      item.querySelector(".btn-pin")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        togglePinSession(s.id, !s.pinned);
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
    renderCwdFilterDropdown();
    renderSessionList();
    updateRunningButtons();
  }

  function shortDirName(fullPath) {
    const clean = String(fullPath || "").replace(/[\\/]+$/, "");
    if (!clean) return "全部工作目录";
    const parts = clean.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || clean;
  }

  function renderCwdFilterDropdown() {
    const sel = $("cwd-filter-select");
    const menu = $("gd-cwd-filter-menu");
    const lbl = $("gd-cwd-filter-label");
    const cntEl = $("gd-cwd-filter-count");
    if (!sel || !menu || !lbl) return;

    const current = sel.value || "";
    const totalCount = (state.cwds || []).reduce((sum, c) => sum + (Number(c.count) || 0), 0);
    const activeItem = (state.cwds || []).find((c) => c.cwd === current);

    lbl.textContent = current ? shortDirName(current) : "全部工作目录";
    lbl.title = current || "显示全部工作目录的会话";
    if (cntEl) {
      const n = current ? (activeItem?.count ?? 0) : totalCount;
      cntEl.textContent = String(n);
      cntEl.classList.toggle("hidden", n <= 0);
    }

    const pick = (val) => {
      if (sel.value !== val) {
        sel.value = val;
        refreshSessions();
      }
      closeAllGlassDropdowns();
    };

    menu.innerHTML = "";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "gd-item" + (!current ? " active" : "");
    allBtn.innerHTML =
      `<div class="cwd-opt-main">` +
        `<span class="cwd-opt-name">全部工作目录</span>` +
        `<span class="cwd-opt-path">显示所有项目与目录会话</span>` +
      `</div>` +
      (totalCount > 0 ? `<span class="cwd-opt-badge">${totalCount}</span>` : "");
    allBtn.addEventListener("click", (e) => { e.stopPropagation(); pick(""); });
    menu.appendChild(allBtn);

    for (const c of state.cwds || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gd-item" + (c.cwd === current ? " active" : "");
      btn.title = c.cwd;
      btn.innerHTML =
        `<div class="cwd-opt-main">` +
          `<span class="cwd-opt-name">${escHtml(shortDirName(c.cwd))}</span>` +
          `<span class="cwd-opt-path">${escHtml(c.cwd)}</span>` +
        `</div>` +
        `<span class="cwd-opt-badge">${c.count || 0}</span>`;
      btn.addEventListener("click", (e) => { e.stopPropagation(); pick(c.cwd); });
      menu.appendChild(btn);
    }
  }

  // ==================== TOOL CARDS & MESSAGE RENDERING ====================

  function formatToolDisplay(name) {
    const raw = String(name || "Tool");
    if (raw === "web_search" || raw === "mcp__opencode_web__web_search" || raw === "WebSearch") {
      return { label: "🌐 联网搜索", isWeb: true };
    }
    if (raw === "web_fetch" || raw === "mcp__opencode_web__web_read_page" || raw === "WebFetch") {
      return { label: "🌐 网页精读", isWeb: true };
    }
    const mcpMatch = raw.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
    if (mcpMatch) {
      return { label: `🔌 ${mcpMatch[1]}: ${mcpMatch[2]}`, isWeb: false };
    }
    return { label: raw, isWeb: false };
  }

  function summarizeTool(name, input) {
    if (!input || typeof input !== "object") return "";
    if (name === "web_search" || name === "mcp__opencode_web__web_search" || name === "WebSearch") {
      return input.query || input.q || "";
    }
    if (name === "web_fetch" || name === "mcp__opencode_web__web_read_page" || name === "WebFetch") {
      return input.url || "";
    }
    if (name === "run_shell" || name === "Bash") return input.description || input.command || "";
    if (["read_file", "edit_file", "write_file", "Read", "Edit", "Write"].includes(name)) return input.file_path || input.path || "";
    if (name === "grep_search" || name === "glob_files") return `${input.pattern || ""} ${input.dir_path || ""}`.trim();
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
    const disp = formatToolDisplay(tool.name);
    det.innerHTML =
      `<summary><span class="tool-status ${status}">${icon}</span>` +
      `<span class="tool-chip${disp.isWeb ? " is-web" : ""}">${escHtml(disp.label)}</span>` +
      `<span class="tool-summary">${escHtml(summarizeTool(tool.name, tool.input))}</span>` +
      `<span class="tool-chevron">▸</span></summary>`;

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
          `<textarea class="edit-box-textarea" id="inline-edit-ta" rows="3">${escHtml(item.content_text || "")}</textarea>` +
          `<div class="edit-box-actions">` +
            `<span class="muted-text" style="margin-right:auto;font-size:11.5px;">Enter / Shift+Enter / Ctrl+Enter 自由换行 · Esc 取消</span>` +
            `<button type="button" class="btn-secondary sm" id="btn-cancel-edit">取消</button>` +
            `<button type="button" class="btn-primary sm" id="btn-submit-edit">保存并重新发送（创建新分支）</button>` +
          `</div>` +
        `</div>`;
      const ta = wrap.querySelector("#inline-edit-ta");
      setTimeout(() => {
        autoResizeTextarea(ta, 76, 360);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 20);
      ta.addEventListener("input", () => autoResizeTextarea(ta, 76, 360));
      const cancelInlineEdit = () => {
        state.editingMessageId = null;
        renderConversation();
      };
      const submitInlineEdit = () => {
        const nextText = ta.value.trim();
        if (!nextText) return toast("消息内容不能为空");
        state.editingMessageId = null;
        sendEditResend(item.id, nextText);
      };
      ta.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.isComposing && (ev.ctrlKey || ev.altKey || ev.metaKey)) {
          ev.preventDefault();
          insertNewlineAtTextarea(ta, () => autoResizeTextarea(ta, 76, 360));
          return;
        }
        if (ev.key === "Escape") {
          ev.stopPropagation();
          cancelInlineEdit();
        }
      });
      wrap.querySelector("#btn-cancel-edit").addEventListener("click", cancelInlineEdit);
      wrap.querySelector("#btn-submit-edit").addEventListener("click", submitInlineEdit);
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

    const isAttImg = (im) => im.kind === "image" || (!im.kind && String(im.media_type || "").startsWith("image/"));
    const imgAtts = (item.images || []).filter(isAttImg);
    const fileAtts = (item.images || []).filter((im) => !isAttImg(im));

    const imgsHtml = imgAtts.length
      ? `<div class="msg-images">${imgAtts.map((im) => `<img src="${escHtml(im.url)}" alt="${escHtml(im.name || "图片")}" />`).join("")}</div>`
      : "";
    const filesHtml = fileAtts.length
      ? `<div class="msg-files">${fileAtts
          .map((f) => {
            const ico = f.kind === "text" ? "📄" : "📎";
            const sz = f.size >= 1024 * 1024 ? `${(f.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round((f.size || 0) / 1024))} KB`;
            return `<a class="msg-file-chip" href="${escHtml(f.url || "#")}" target="_blank" rel="noopener noreferrer" title="${escHtml(f.path || f.name || "")}">` +
              `<span>${ico}</span><span>${escHtml(f.name || "附件")}</span><span class="mf-size">${sz}</span></a>`;
          })
          .join("")}</div>`
      : "";

    const clockStr = fmtClock(item.created_at);
    wrap.innerHTML =
      `<div class="msg-user-card">${imgsHtml}${filesHtml}<div class="msg-user-text">${escHtml(item.content_text || "")}</div></div>` +
      `<div class="msg-footer-bar">` +
        (clockStr ? `<span class="msg-footer-time">${clockStr}</span>` : "") +
        branchBar +
        `<button class="sym-btn btn-edit-resend" title="编辑并重新发送（保留原分支）">${SVG_ICONS.edit}</button>` +
        `<button class="sym-btn btn-copy-u" title="复制提问">${SVG_ICONS.copy}</button>` +
      `</div>`;

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
      img.addEventListener("click", () => { $("lightbox-img").src = img.src; openModal("lightbox"); });
    });
    return wrap;
  }

  function createAssistantMsgEl(item, isLive = false) {
    const wrap = document.createElement("div");
    wrap.className = "msg-assistant" + (isLive ? " live-node msg-enter" : "");
    if (item.id) wrap.id = item.id;

    const head = document.createElement("div");
    head.className = "msg-assistant-head";
    const isPureNative =
      item.engine === "claude_native" ||
      (item.engine === "claude_code" && state.settings?.prompt_mode === "native");
    const engLabel = isPureNative ? "Claude Code" : "AI 助手";
    head.innerHTML =
      `<span class="asst-badge">${engLabel}</span>` +
      (item.provider_name ? `<span class="asst-tag">${escHtml(item.provider_name)}</span>` : "") +
      (item.model ? `<span class="asst-tag">${escHtml(item.model)}</span>` : "") +
      (isLive ? `<span class="pulse-dot"></span><span>思考与执行中…</span>` : `<span>${fmtClock(item.created_at)}</span>`);
    wrap.appendChild(head);

    if (isLive) {
      const liveBody = document.createElement("div");
      liveBody.className = "live-blocks";
      liveBody.style.display = "flex";
      liveBody.style.flexDirection = "column";
      liveBody.style.gap = "10px";
      wrap.appendChild(liveBody);
      patchLiveBlocksContainer(liveBody, item);
      return wrap;
    }

    const blocks = item.blocks || [];
    for (const blk of blocks) {
      if (blk.type === "thinking") {
        const det = document.createElement("details");
        det.className = "thinking-card";
        det.open = false;
        det.innerHTML =
          `<summary><span class="thinking-chevron">▸</span><span>思考过程（${String(blk.text || "").length} 字）</span></summary>` +
          `<div class="thinking-body">${escHtml(blk.text || "")}</div>`;
        wrap.appendChild(det);
      } else if (blk.type === "tool_use") {
        wrap.appendChild(createToolCardEl(blk, false));
      } else if (blk.type === "text") {
        const div = document.createElement("div");
        div.className = "md-body";
        div.innerHTML = renderMarkdown(blk.text || "");
        wrap.appendChild(div);
      }
    }

    if (item.error) {
      wrap.appendChild(createErrorCardEl(item.error));
    }

    // Bottom symbol action bar for completed AI replies (Regenerate + Copy + Branch switcher)
    if (!isLive && item.id) {
      const footer = document.createElement("div");
      footer.className = "msg-footer-bar";
      const brHtml =
        item.branch_total > 1
          ? `<span class="branch-bar">` +
              `<button class="branch-btn btn-asst-prev" ${item.branch_index <= 1 ? "disabled" : ""} title="上一版回复">◀</button>` +
              `<span>${item.branch_index}/${item.branch_total}</span>` +
              `<button class="branch-btn btn-asst-next" ${item.branch_index >= item.branch_total ? "disabled" : ""} title="下一版回复">▶</button>` +
            `</span>`
          : "";
      footer.innerHTML =
        brHtml +
        `<button class="sym-btn btn-regen" title="重新回复（保留当前版本为可切换分支）">${SVG_ICONS.regen}</button>` +
        `<button class="sym-btn btn-copy-a" title="复制完整回复">${SVG_ICONS.copy}</button>`;

      footer.querySelector(".btn-copy-a")?.addEventListener("click", () => {
        const fullTxt = item.content_text || blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
        copyText(fullTxt, "已复制回复");
      });
      footer.querySelector(".btn-regen")?.addEventListener("click", () => sendRegenerateReply(item.id));
      footer.querySelector(".btn-asst-prev")?.addEventListener("click", () => {
        const targetId = item.sibling_ids?.[item.branch_index - 2];
        if (targetId) switchToBranch(targetId);
      });
      footer.querySelector(".btn-asst-next")?.addEventListener("click", () => {
        const targetId = item.sibling_ids?.[item.branch_index];
        if (targetId) switchToBranch(targetId);
      });
      wrap.appendChild(footer);
    }

    return wrap;
  }

  const WINDOWED_MSG_THRESHOLD = 42;
  const WINDOWED_MSG_INITIAL = 28;

  function buildTimelineItemNode(item) {
    if (item.role === "user") return createUserMsgEl(item);
    if (item.role === "assistant") return createAssistantMsgEl(item, false);
    if (item.role === "compact") {
      const c = document.createElement("div");
      c.className = "compact-divider";
      c.id = item.id;
      c.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;">` +
          `<span><b>上下文压缩边界</b> · ${fmtClock(item.created_at)}</span>` +
          `<button class="link-btn btn-sum">查看摘要</button>` +
        `</div><div class="compact-summary hidden">${escHtml(item.content_text)}</div>`;
      c.querySelector(".btn-sum").addEventListener("click", () => c.querySelector(".compact-summary").classList.toggle("hidden"));
      return c;
    }
    return null;
  }

  function renderConversation() {
    const box = $("messages-container");
    const welcomeEl = $("welcome-view");
    const tl = state.activeTimeline;
    const live = state.activeSessionId ? state.liveStream.get(state.activeSessionId) : null;
    const allItems = tl?.items || [];
    const hasItems = allItems.length > 0;

    if (!hasItems && !live) {
      box.innerHTML = "";
      welcomeEl?.classList.remove("hidden");
      syncWelcomeResumePill();
      $("ctx-pill").classList.add("hidden");
      renderOutline([]);
      renderActivity(null);
      return;
    }

    welcomeEl?.classList.add("hidden");
    $("welcome-resume-wrap")?.classList.add("hidden");
    const frag = document.createDocumentFragment();
    const shouldWindow = !state.showAllMessages && allItems.length > WINDOWED_MSG_THRESHOLD;
    const hiddenCount = shouldWindow ? allItems.length - WINDOWED_MSG_INITIAL : 0;
    const visibleItems = shouldWindow ? allItems.slice(hiddenCount) : allItems;

    if (hiddenCount > 0) {
      const bar = document.createElement("div");
      bar.className = "history-expand-bar";
      bar.innerHTML =
        `<button type="button" class="history-expand-btn" title="瞬时挂载本会话全部较早对话记录">` +
          `<span>↑ 展开更早的 ${hiddenCount} 条对话（共 ${allItems.length} 条）</span>` +
        `</button>`;
      bar.querySelector("button").addEventListener("click", () => {
        const sc = $("messages-scroll");
        const prevHeight = sc.scrollHeight;
        const prevTop = sc.scrollTop;
        state.showAllMessages = true;
        renderConversation();
        requestAnimationFrame(() => {
          sc.scrollTop = prevTop + (sc.scrollHeight - prevHeight);
        });
      });
      frag.appendChild(bar);
    }

    for (const item of visibleItems) {
      const node = buildTimelineItemNode(item);
      if (node) frag.appendChild(node);
    }

    box.innerHTML = "";
    box.appendChild(frag);

    if (live) {
      box.appendChild(createAssistantMsgEl(live, true));
    }

    updateContextDisplay();

    renderOutline(tl?.outline || []);
    renderActivity(tl?.activity || null);
  }

  function patchLiveBlocksContainer(container, live) {
    const blocks = live.blocks || [];
    const existingByKey = new Map();
    for (const ch of Array.from(container.children)) {
      if (ch.dataset.blkKey) existingByKey.set(ch.dataset.blkKey, ch);
    }

    const desired = [];
    if (!blocks.length && !live.error) {
      let ph = existingByKey.get("__waiting__");
      if (!ph) {
        ph = document.createElement("div");
        ph.dataset.blkKey = "__waiting__";
        ph.className = "md-body streaming-cursor";
        ph.style.color = "var(--text-muted)";
        ph.textContent = "等待 Claude Code 响应";
      }
      desired.push(ph);
    } else {
      let lastTextIdx = -1;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === "text") { lastTextIdx = i; break; }
      }
      blocks.forEach((blk, idx) => {
        if (blk.type === "thinking") {
          const key = `think-${idx}`;
          let det = existingByKey.get(key);
          const txt = String(blk.text || "");
          if (!det) {
            det = document.createElement("details");
            det.dataset.blkKey = key;
            det.className = "thinking-card";
            det.open = true;
            const sum = document.createElement("summary");
            sum.innerHTML = `<span class="thinking-chevron">▸</span><span class="thinking-lbl"></span>`;
            const body = document.createElement("div");
            body.className = "thinking-body";
            det.appendChild(sum);
            det.appendChild(body);
          }
          if (det._lastText !== txt) {
            det._lastText = txt;
            const lbl = det.querySelector(".thinking-lbl") || det.querySelector("summary");
            const body = det.querySelector(".thinking-body");
            if (lbl) lbl.textContent = `思考过程（${txt.length} 字）`;
            if (body) body.textContent = txt;
          }
          desired.push(det);
        } else if (blk.type === "tool_use") {
          const key = `tool-${blk.id || idx}`;
          let det = existingByKey.get(key);
          const status = blk.status || (blk.is_error ? "error" : "done");
          const sig = `${status}|${blk.is_error ? 1 : 0}|${String(blk.result ?? "").length}|${summarizeTool(blk.name, blk.input)}`;
          if (!det) {
            det = createToolCardEl(blk, status === "running");
            det.dataset.blkKey = key;
            det._lastSig = sig;
          } else if (det._lastSig !== sig) {
            det._lastSig = sig;
            det.className = "tool-card" + (blk.is_error ? " is-error" : "");
            const stEl = det.querySelector(".tool-status");
            if (stEl) {
              stEl.className = `tool-status ${status}`;
              stEl.textContent = status === "running" ? "◌" : status === "error" || blk.is_error ? "✕" : "✓";
            }
            const sumEl = det.querySelector(".tool-summary");
            if (sumEl) sumEl.textContent = summarizeTool(blk.name, blk.input);
            const bodyEl = det.querySelector(".tool-body");
            if (bodyEl) bodyEl.innerHTML = renderToolBodyHtml(blk);
            else if (det.open || blk.is_error) {
              if (blk.is_error) det.open = true;
              const b = document.createElement("div");
              b.className = "tool-body";
              b.innerHTML = renderToolBodyHtml(blk);
              det.appendChild(b);
            }
          }
          desired.push(det);
        } else if (blk.type === "text") {
          const key = `text-${idx}`;
          let div = existingByKey.get(key);
          const txt = String(blk.text || "");
          if (!div) {
            div = document.createElement("div");
            div.dataset.blkKey = key;
          }
          const wantClass = "md-body" + (idx === lastTextIdx && !live.error ? " streaming-cursor" : "");
          if (div.className !== wantClass) div.className = wantClass;
          if (div._lastText !== txt) {
            div._lastText = txt;
            div.innerHTML = renderMarkdown(txt, true);
          }
          desired.push(div);
        }
      });
    }

    if (live.error) {
      const errKey = "__error__";
      const errSig = JSON.stringify(live.error);
      let errEl = existingByKey.get(errKey);
      if (!errEl || errEl._lastSig !== errSig) {
        errEl = createErrorCardEl(live.error);
        errEl.dataset.blkKey = errKey;
        errEl._lastSig = errSig;
      }
      desired.push(errEl);
    }

    // Reconcile children in-place without tearing down unchanged DOM nodes
    const desiredSet = new Set(desired);
    for (const ch of Array.from(container.children)) {
      if (!desiredSet.has(ch)) ch.remove();
    }
    desired.forEach((node, i) => {
      if (container.children[i] !== node) {
        container.insertBefore(node, container.children[i] || null);
      }
    });
  }

  function renderLiveOnly() {
    if (state._liveRafId) return;
    state._liveRafId = requestAnimationFrame(() => {
      state._liveRafId = null;
      const box = $("messages-container");
      const welcomeEl = $("welcome-view");
      const live = state.activeSessionId ? state.liveStream.get(state.activeSessionId) : null;
      if (!live) {
        box.querySelectorAll(".live-node").forEach((n) => n.remove());
        return;
      }
      welcomeEl?.classList.add("hidden");
      const stick = isNearBottom();
      const existing = box.querySelector(".live-node");
      if (existing) {
        const liveBody = existing.querySelector(".live-blocks");
        if (liveBody) {
          patchLiveBlocksContainer(liveBody, live);
        } else {
          existing.replaceWith(createAssistantMsgEl(live, true));
        }
      } else {
        box.appendChild(createAssistantMsgEl(live, true));
      }
      if (stick) scrollToBottom(false);
      syncScrollBottomBtn();
    });
  }

  function syncScrollBottomBtn() {
    const btn = $("btn-scroll-bottom");
    if (!btn) return;
    const sc = $("messages-scroll");
    const hasOverflow = sc && sc.scrollHeight - sc.clientHeight > 80;
    const show = Boolean(hasOverflow && !isNearBottom());
    btn.classList.toggle("is-visible", show);
    btn.setAttribute("aria-hidden", show ? "false" : "true");
  }

  async function openSession(sid, opts = {}) {
    saveDraft();
    state.activeSessionId = sid;
    state.editingMessageId = null;
    state.showAllMessages = Boolean(opts.jumpMessageId);
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
      triggerViewFade(data?.items?.length ? $("messages-container") : $("welcome-view"));
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
      syncScrollBottomBtn();
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
    triggerViewFade($("welcome-view"));
    syncScrollBottomBtn();
    updateRunningButtons();
    restoreDraft();
    $("composer-input").focus();
  }

  function exportCurrentSessionMarkdown() {
    const tl = state.activeTimeline;
    if (!tl?.items?.length) {
      return toast("当前会话暂无内容可导出");
    }
    const sess = tl.session || {};
    const lines = [
      `# ${sess.title || "OpenCode Studio 对话记录"}`,
      "",
      `- **工作目录**: \`${sess.cwd || "-"}\``,
      `- **模型**: \`${sess.model || "-"}\``,
      `- **导出时间**: \`${new Date().toLocaleString("zh-CN", { hour12: false })}\``,
      "",
      "---",
      "",
    ];

    for (const it of tl.items) {
      if (it.role === "user") {
        lines.push(`## 🙋 提问 #${it.turn_index || ""} (${fmtClock(it.created_at)})`, "");
        if (it.images?.length) {
          lines.push(`> 附带文件/图片: ${it.images.map((f) => f.name || "附件").join(", ")}`, "");
        }
        lines.push(it.content_text || "", "");
      } else if (it.role === "assistant") {
        const metaTag = [it.provider_name, it.model].filter(Boolean).join(" / ");
        lines.push(`## 🤖 回复${metaTag ? ` (${metaTag})` : ""} (${fmtClock(it.created_at)})`, "");
        for (const blk of it.blocks || []) {
          if (blk.type === "thinking" && blk.text) {
            lines.push("<details><summary>思考过程</summary>", "", blk.text.trim(), "", "</details>", "");
          } else if (blk.type === "tool_use") {
            lines.push(`- 🔧 **工具调用** \`${blk.name}\`: \`${summarizeTool(blk.name, blk.input)}\``);
          } else if (blk.type === "text" && blk.text) {
            lines.push("", blk.text.trim(), "");
          }
        }
        if (!it.blocks?.length && it.content_text) {
          lines.push(it.content_text.trim(), "");
        }
        lines.push("---", "");
      } else if (it.role === "compact") {
        lines.push(`> 📦 **上下文压缩摘要**: ${it.content_text || ""}`, "", "---", "");
      }
    }

    const mdContent = lines.join("\n");
    const safeName = String(sess.title || "conversation")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 48) || "conversation";
    const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast(`已导出 Markdown：${safeName}.md`);
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

  // ==================== RIGHT DRAWER (SMOOTH SLIDE + EXACT JUMP!) ====================

  function openDrawer(tab) {
    state.drawerOpen = true;
    state.drawerTab = tab;
    openAnimatedLayer($("right-drawer"));
    syncDrawerTabs();
    if (tab === "find") setTimeout(() => { $("thread-find-input").focus(); $("thread-find-input").select(); }, 90);
  }

  function closeDrawer() {
    state.drawerOpen = false;
    closeAnimatedLayer($("right-drawer"), 260);
    document.querySelectorAll(".seg-btn[data-tab]").forEach((b) => b.classList.remove("active"));
  }

  function syncDrawerTabs() {
    const t = state.drawerTab;
    document.querySelectorAll(".drawer-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    document.querySelectorAll(".seg-btn[data-tab]").forEach((b) => b.classList.toggle("active", state.drawerOpen && b.dataset.tab === t));
    $("drawer-panel-outline").classList.toggle("hidden", t !== "outline");
    $("drawer-panel-find").classList.toggle("hidden", t !== "find");
    $("drawer-panel-activity").classList.toggle("hidden", t !== "activity");
  }

  function jumpToElement(elOrId) {
    let el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    if (!el && typeof elOrId === "string" && !state.showAllMessages && (state.activeTimeline?.items?.length || 0) > WINDOWED_MSG_THRESHOLD) {
      state.showAllMessages = true;
      renderConversation();
      el = document.getElementById(elOrId);
    }
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
    // Wait for user to click a specific search result before jumping!
  }

  function focusFind(idx) {
    if (!state.findMatches.length) return;
    const n = state.findMatches.length;
    state.findIndex = ((idx % n) + n) % n;
    $("thread-find-count").textContent = `${state.findIndex + 1} / ${n}`;
    $("thread-find-results").querySelectorAll(".find-item").forEach((el, i) => el.classList.toggle("active", i === state.findIndex));
    const m = state.findMatches[state.findIndex];
    if (m.toolId) {
      let tEl = $("messages-container").querySelector(`[data-tool-id="${CSS.escape(m.toolId)}"]`);
      if (!tEl && !state.showAllMessages && (state.activeTimeline?.items?.length || 0) > WINDOWED_MSG_THRESHOLD) {
        state.showAllMessages = true;
        renderConversation();
        tEl = $("messages-container").querySelector(`[data-tool-id="${CSS.escape(m.toolId)}"]`);
      }
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
      const keepPrompt = state._promptDirty ? state.settings.system_prompt : undefined;
      state.settings = msg.settings;
      if (keepPrompt !== undefined) state.settings.system_prompt = keepPrompt;
      applyAppearance(msg.settings.appearance);
      syncWebSearchToggle();
      syncFavoriteCountBadge();
      return;
    }
    if (t === "providers_updated") {
      state.providers = msg.providers || [];
      state.activeProvider = msg.active_provider;
      renderComposerSelectors();
      return;
    }
    if (t === "claude_status_updated" && msg.claude_native) {
      state.claudeNative = msg.claude_native;
      renderClaudeStatusViews();
      return;
    }
    if (t === "claude_auth_progress") {
      const box = $("claude-auth-output");
      const codeRow = $("claude-auth-code-row");
      if (box) {
        box.classList.remove("hidden");
        if (msg.stage === "oauth_url" && msg.url) {
          box.innerHTML =
            `<div style="margin-bottom:6px;"><b>已生成官方授权链接（系统浏览器已自动尝试打开）：</b></div>` +
            `<a class="btn-primary sm" style="text-decoration:none;margin-bottom:6px;" href="${escHtml(msg.url)}" target="_blank" rel="noopener noreferrer">在浏览器中打开官方授权页 ↗</a>` +
            `<div class="muted-text" style="word-break:break-all;font-size:11px;">${escHtml(msg.url)}</div>` +
            `<div class="muted-text" style="margin-top:4px;">完成网页授权后，如页面给出授权码 (Code)，请粘贴至下方提交；如已自动回调成功，点击上方「刷新状态」即可。</div>`;
          codeRow?.classList.remove("hidden");
        } else if (msg.stage === "done" && msg.auth?.loggedIn) {
          box.innerHTML = `<b style="color:var(--ok);">● 官方账号授权登录成功！</b>`;
          codeRow?.classList.add("hidden");
        } else if (msg.text && !box.innerHTML.includes("在浏览器中打开官方授权页")) {
          box.textContent = (box.textContent ? box.textContent + "\n" : "") + msg.text;
        }
      }
      return;
    }
    if (t === "claude_install_progress") {
      const wrap = $("claude-install-progress-wrap");
      const lbl = $("claude-progress-label");
      const meta = $("claude-progress-meta");
      const bar = $("claude-progress-bar");
      if (wrap) wrap.classList.remove("hidden");
      const pct = Math.max(0, Math.min(100, Math.round(Number(msg.percent) || 0)));
      if (bar) bar.style.width = `${pct}%`;
      if (lbl) lbl.textContent = msg.message || "正在下载并校验内核…";
      if (meta) {
        const sizePart =
          msg.downloaded_mb !== undefined && msg.total_mb
            ? `${msg.downloaded_mb} / ${msg.total_mb} MB` + (msg.speed_mbps ? ` · ${msg.speed_mbps} MB/s` : "") + ` (${pct}%)`
            : `${pct}%`;
        meta.textContent = sizePart;
      }
      return;
    }
    if (t === "claude_install_log") {
      const pre = $("claude-install-log");
      if (pre && msg.text) {
        pre.classList.remove("hidden");
        pre.textContent += msg.text;
        pre.scrollTop = pre.scrollHeight;
      }
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
    if (t === "memories_updated") {
      if (!$("modal-memory")?.classList.contains("hidden")) {
        openMemoryModal().catch(() => {});
      }
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
        usage: msg.usage || null,
        error: null,
      });
      if (msg.session_id === state.activeSessionId) {
        renderLiveOnly();
        updateContextDisplay();
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
      openModal("modal-confirm");
    }
  }

  // ==================== LIVE WEB SEARCH TOGGLE & SEND / EDIT-RESEND / UPLOAD ====================

  function isWebSearchEnabled() {
    return state.settings?.web_search_enabled !== false;
  }

  function syncWebSearchToggle() {
    const sel = $("set-web-search");
    if (sel) sel.value = isWebSearchEnabled() ? "on" : "off";
  }

  async function toggleWebSearch() {
    const next = !isWebSearchEnabled();
    state.settings.web_search_enabled = next;
    syncWebSearchToggle();
    toast(next ? "🌐 已开启实时联网搜索增强（支持任意模型免 Key 查最新资料）" : "已关闭实时联网搜索");
    try {
      const res = await apiJson("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ web_search_enabled: next }),
      });
      if (res?.settings) {
        state.settings.web_search_enabled = res.settings.web_search_enabled;
        syncWebSearchToggle();
      }
    } catch {}
  }

  function sendCurrentMessage() {
    if (!state.wsConnected) return toast("正在重连后端服务…");
    let text = $("composer-input").value.trim();
    const images = state.attachments.slice();
    if (!text && !images.length) return;
    if (text === "/clear") {
      $("composer-input").value = "";
      autoResizeComposer();
      saveDraft();
      return startNewSession();
    }
    if (text === "/web") {
      $("composer-input").value = "";
      autoResizeComposer();
      saveDraft();
      return toggleWebSearch();
    }

    let forceWeb = false;
    if (/^\/web\s+/i.test(text)) {
      const query = text.replace(/^\/web\s+/i, "").trim();
      if (query) {
        forceWeb = true;
        text = `请优先调用联网搜索工具检索关于「${query}」的最新权威网页信息并整理回答：${query}`;
      }
    }

    const prov = getSelectedProvider();
    const model = $("model-select").value;
    const thinking = $("gd-thinking")?.classList.contains("hidden") ? "off" : $("thinking-select").value;

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
      web_search: forceWeb || isWebSearchEnabled(),
    }));
  }

  function sendEditResend(messageId, newText) {
    if (!state.wsConnected || !state.activeSessionId) return;
    const prov = getSelectedProvider();
    const model = $("model-select").value;
    const thinking = $("gd-thinking")?.classList.contains("hidden") ? "off" : $("thinking-select").value;
    state.ws.send(JSON.stringify({
      type: "edit_resend",
      session_id: state.activeSessionId,
      message_id: messageId,
      new_text: newText,
      provider_id: prov?.id || "",
      model,
      thinking_level: thinking,
      web_search: isWebSearchEnabled(),
    }));
    toast("已创建新分支并重新发送");
  }

  function sendRegenerateReply(assistantMessageId) {
    if (!state.wsConnected || !state.activeSessionId || !assistantMessageId) return;
    if (state.runningIds.has(state.activeSessionId)) {
      return toast("当前回复正在生成中，请稍候或先停止");
    }
    const prov = getSelectedProvider();
    const model = $("model-select").value;
    const thinking = $("gd-thinking")?.classList.contains("hidden") ? "off" : $("thinking-select").value;
    state.ws.send(JSON.stringify({
      type: "regenerate_reply",
      session_id: state.activeSessionId,
      assistant_message_id: assistantMessageId,
      provider_id: prov?.id || "",
      model,
      thinking_level: thinking,
      web_search: isWebSearchEnabled(),
    }));
    toast("正在重新生成回复（旧版本将作为分支保留）…");
  }

  function fmtFileSize(bytes) {
    if (!bytes || bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function uploadChatAttachment(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return toast(`文件「${file.name}」超过 25MB 上限`, 3500);
    const b64 = await fileToDataUrl(file);
    try {
      const data = await apiJson("/api/upload", {
        method: "POST",
        body: JSON.stringify({
          media_type: file.type || "application/octet-stream",
          data: b64,
          name: file.name || (file.type?.startsWith("image/") ? "pasted.png" : "pasted.txt"),
        }),
      });
      state.attachments.push(data);
      renderAttachments();
      if (data.kind !== "image") {
        toast(`已附加文件：${data.name} (${fmtFileSize(data.size)})`, 2200);
      }
    } catch (err) {
      toast("文件附加失败: " + err.message, 4000);
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
      const isImg = att.kind === "image" || (!att.kind && String(att.media_type || "").startsWith("image/"));
      const el = document.createElement("div");
      if (isImg) {
        el.className = "att-thumb";
        el.innerHTML = `<img src="${escHtml(att.url)}" alt="${escHtml(att.name || "图片")}" /><button class="att-remove" title="移除">×</button>`;
      } else {
        el.className = "att-file-chip";
        const icon = att.kind === "text" ? "📄" : "📎";
        el.title = att.preview ? `${att.name}\n${att.preview}` : att.name || "";
        el.innerHTML =
          `<span class="att-file-icon">${icon}</span>` +
          `<span class="att-file-meta"><span class="att-file-name">${escHtml(att.name || "文件")}</span>` +
          `<span class="att-file-size">${fmtFileSize(att.size)} · ${att.kind === "text" ? "直读内容" : "原生读取"}</span></span>` +
          `<button class="att-remove" title="移除">×</button>`;
      }
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
        { label: "/web", desc: "使用实时联网搜索查询最新信息并回答", insert: "/web" },
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

  // ==================== MODAL: PROVIDERS & NATIVE CLAUDE AUTH ====================

  function renderClaudeStatusViews() {
    const cn = state.claudeNative;
    const modeLabel = cn?.bundled
      ? "随包内置适配内核"
      : cn?.managed
        ? "私有隔离升级内核"
        : cn?.mode === "wsl"
          ? "WSL2 原生内核"
          : cn?.mode === "native"
            ? "本机原生内核"
            : "未安装";
    const loggedIn = Boolean(cn?.auth?.loggedIn);
    const authDetailText = !cn || !cn.installed
      ? "正在检测内置原生 Claude Code 内核（若处于源码模式未装依赖，可在设置高级维护中一键下载）"
      : loggedIn
        ? `已登录（${cn.auth.authMethod || "OAuth"}${cn.auth.email ? ` · ${cn.auth.email}` : ""}${cn.auth.subscriptionType ? ` · ${cn.auth.subscriptionType}` : ""}）· 内核 ${cn.version} (${modeLabel})`
        : `未登录官方账号 · 内核 ${cn.version} (${modeLabel})，点击下方按钮执行官方 OAuth 登录（使用第三方 API 则无需登录此处）`;

    const statusBox = $("claude-native-status-box");
    if (statusBox) {
      statusBox.innerHTML = cn
        ? `<b>原生 Claude Code 内核：</b>${cn.installed ? `<span style="color:var(--ok);">● 已就绪</span> ${escHtml(cn.version)} (${modeLabel})` : "未就绪"}<br />` +
          `<b>官方 Auth：</b>${loggedIn ? `<span style="color:var(--ok);">● 已登录</span>` : `<span style="color:var(--muted);">○ 未登录（用内置 API 无需登录）</span>`}<br />` +
          `${escHtml(cn.note || "")}`
        : "";
    }
    const authDetail = $("claude-auth-detail");
    if (authDetail) authDetail.textContent = authDetailText;
    const logoutBtn = $("btn-claude-auth-logout");
    if (logoutBtn) logoutBtn.disabled = !cn?.installed || !loggedIn;

    const pill = $("claude-bundled-pill");
    if (pill) {
      if (cn?.installed && cn?.bundled) {
        pill.textContent = "● 内置适配版已就绪";
        pill.className = "store-badge is-installed";
      } else if (cn?.installed) {
        pill.textContent = cn.managed ? "● 已切换自定义版本" : "● 本机内核已就绪";
        pill.className = "store-badge is-official";
      } else {
        pill.textContent = cn?.probing ? "检测中…" : "需初始化";
        pill.className = "store-badge";
      }
    }

    const resetBtn = $("btn-claude-reset-bundled");
    if (resetBtn) {
      resetBtn.disabled = Boolean(cn?.bundled);
    }

    const advDetails = $("claude-kernel-adv");
    if (advDetails && cn && !cn.installed && !cn.probing) {
      advDetails.open = true;
    }

    const verLine = $("claude-core-ver-line");
    if (verLine) {
      verLine.textContent = cn?.installed
        ? cn.bundled
          ? `已自动启用随本软件内置并完整适配的原生 Claude Code ${cn.version}（无需学生额外安装内核）`
          : `当前已接入原生 Claude Code ${cn.version}（${modeLabel}）`
        : "未检测到内置二进制（源码运行模式），可在下方高级维护中一键下载";
    }
    const engineNote = $("composer-engine-note");
    if (engineNote) {
      engineNote.textContent = cn?.installed
        ? `驱动内核：${modeLabel} ${cn.version}`
        : "驱动内核：内置开放 API 引擎";
    }
  }

  async function refreshClaudeStatus(force = true) {
    try {
      const data = await apiJson(`/api/claude/status?refresh=${force ? "1" : "0"}`);
      state.claudeNative = data;
      renderClaudeStatusViews();
      return data;
    } catch (err) {
      toast("刷新 Claude Code 状态失败: " + err.message);
      return null;
    }
  }

  async function openProvidersModal(focusProviderId = null) {
    openModal("modal-providers");
    const data = await apiJson("/api/providers");
    state.providers = data.providers || [];
    state.claudeNative = data.claude_native;
    if (focusProviderId) state.selectedProviderId = focusProviderId;
    renderProviderModalList();
    renderClaudeStatusViews();
    const target = state.selectedProviderId || state.activeProvider?.id || state.providers[0]?.id;
    const found = state.providers.find((p) => p.id === target) || state.providers[0];
    if (found) fillProviderForm(found);
  }

  function renderProviderModalList() {
    const listEl = $("provider-list");
    listEl.innerHTML = "";
    for (const p of state.providers) {
      const el = document.createElement("div");
      el.className = "stack-item" + (p.id === state.selectedProviderId ? " active" : "");
      const badgeClass = p.is_active ? "is-current" : p.kind === "claude_native" ? "is-native" : "is-api";
      const badgeText = p.is_active
        ? "当前"
        : p.kind === "claude_native"
          ? "原生 Auth"
          : p.kind === "anthropic"
            ? "Anthropic"
            : "OpenAI";
      el.innerHTML =
        `<div class="stack-item-head">` +
          `<span class="stack-item-title" title="${escHtml(p.name)}">${escHtml(p.name)}</span>` +
          `<span class="prov-badge ${badgeClass}">${badgeText}</span>` +
        `</div>` +
        `<div class="stack-item-sub">${escHtml(p.default_model || (p.base_url || "官方 OAuth 登录"))}</div>`;
      el.addEventListener("click", () => fillProviderForm(p));
      listEl.appendChild(el);
    }
    renderClaudeStatusViews();
  }

  function fillProviderForm(p) {
    state.selectedProviderId = p ? p.id : null;
    renderProviderModalList();
    $("pf-name").value = p?.name || "";
    $("pf-kind").value = p?.kind || "openai";
    $("pf-baseurl").value = p?.base_url || "";
    $("pf-apikey").value = "";
    $("pf-apikey").placeholder = p?.has_api_key ? `已加密保存 (${p.api_key_masked})，留空保持不变，输入新 Key 即覆盖更新` : "输入 API Key (sk-...)";
    $("pf-default-model").value = p?.default_model || "";
    $("pf-models").value = (p?.models || []).join("\n");
    $("btn-delete-provider").disabled = !p || p.id === "claude-native-oauth";
    const testBox = $("pf-test-result");
    if (testBox) {
      testBox.classList.add("hidden");
      testBox.textContent = "";
    }
    toggleProviderKindFields();
    renderModelCapsPreview(p?.model_infos || []);
  }

  function toggleProviderKindFields() {
    const isNative = $("pf-kind").value === "claude_native";
    $("pf-baseurl-wrap").classList.toggle("hidden", isNative);
    $("pf-apikey-wrap").classList.toggle("hidden", isNative);
    $("claude-auth-panel")?.classList.toggle("hidden", !isNative);
    if (isNative) renderClaudeStatusViews();
  }

  async function startClaudeAuthLogin(mode = "claudeai") {
    const out = $("claude-auth-output");
    const codeRow = $("claude-auth-code-row");
    codeRow?.classList.add("hidden");
    if (out) {
      out.classList.remove("hidden");
      out.textContent = `正在启动原生 claude auth login (${mode === "console" ? "Anthropic Console" : "Claude 订阅账号"})…`;
    }
    try {
      const res = await apiJson("/api/claude/auth/login", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        if (out) out.textContent = res.error || "启动登录失败";
        return toast(res.error || "登录失败", 4000);
      }
      if (res.oauth_url) {
        if (out) {
          out.innerHTML =
            `<div style="margin-bottom:6px;"><b>已为您打开官方授权页面：</b></div>` +
            `<a class="btn-primary sm" style="text-decoration:none;margin-bottom:6px;" href="${escHtml(res.oauth_url)}" target="_blank" rel="noopener noreferrer">在浏览器中打开官方授权页 ↗</a>` +
            `<div class="muted-text" style="word-break:break-all;font-size:11px;">${escHtml(res.oauth_url)}</div>` +
            `<div class="muted-text" style="margin-top:4px;">${escHtml(res.message || "")}</div>`;
        }
        codeRow?.classList.remove("hidden");
        $("claude-auth-code-input")?.focus();
        window.open(res.oauth_url, "_blank", "noopener,noreferrer");
        toast("已弹出官方授权页，如页面给出授权码请粘贴回填", 4500);
      } else {
        if (out) out.textContent = res.message || res.output || "登录流程已结束";
        await refreshClaudeStatus(true);
        toast("原生 Claude 登录状态已更新");
      }
    } catch (err) {
      if (out) out.textContent = "登录请求失败: " + err.message;
      toast("登录失败: " + err.message, 4000);
    }
  }

  async function submitClaudeAuthCodeInput() {
    const inp = $("claude-auth-code-input");
    const code = (inp?.value || "").trim();
    if (!code) return toast("请先粘贴官方页面给出的授权码 (Code)");
    const btn = $("btn-claude-auth-submit-code");
    if (btn) btn.disabled = true;
    try {
      const res = await apiJson("/api/claude/auth/submit-code", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      if (res.runtime) {
        state.claudeNative = res.runtime;
        renderClaudeStatusViews();
      }
      if (res.ok) {
        if (inp) inp.value = "";
        $("claude-auth-code-row")?.classList.add("hidden");
        const out = $("claude-auth-output");
        if (out) out.innerHTML = `<b style="color:var(--ok);">● ${escHtml(res.message || "官方账号授权登录成功！")}</b>`;
        toast("原生 Claude 官方账号登录成功！", 3500);
      } else {
        toast(res.error || res.message || "提交授权码未生效，请重试", 4500);
      }
    } catch (err) {
      toast("提交授权码失败: " + err.message, 4000);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderModelCapsPreview(infos) {
    const grid = $("pf-caps-preview");
    if (!infos.length) {
      grid.innerHTML = `<div class="muted-text">保存或拉取模型后，此处会展示每个模型自动识别的思考等级与上下文窗口。</div>`;
      return;
    }
    const zhMap = { off: "关", on: "开", low: "低", medium: "中", high: "高", xhigh: "极高", max: "极致" };
    grid.innerHTML = infos.slice(0, 60).map((m) => {
      const lvls = m.thinking_levels || [];
      const zhLevels = lvls.map((l) => zhMap[l] || l).join("/");
      const thinkTitle = m.thinking_supported
        ? `共 ${lvls.length} 个档位 (${lvls.join(" / ")}) · 识别方式: ${m.source === "provider-api" ? "供应商接口元数据" : "模型家族规则"}`
        : "该模型为标准非推理模型";
      return (
        `<div class="cap-card">` +
          `<div class="cap-card-name" title="${escHtml(m.id || m.display_name)}">${escHtml(m.display_name)}</div>` +
          `<div class="cap-tags">` +
            `<span class="mini-tag">${fmtTokens(m.context_window)} 上下文</span>` +
            (m.thinking_supported
              ? `<span class="mini-tag think" title="${escHtml(thinkTitle)}">${lvls.length}档思考: ${escHtml(zhLevels)}</span>`
              : `<span class="mini-tag" title="${escHtml(thinkTitle)}">标准无思考档</span>`) +
            (m.vision ? `<span class="mini-tag vision">识图</span>` : "") +
          `</div>` +
        `</div>`
      );
    }).join("");
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

  async function testSelectedProviderConnection() {
    const btn = $("btn-test-provider");
    const box = $("pf-test-result");
    if (btn) btn.disabled = true;
    if (box) {
      box.classList.remove("hidden");
      box.style.color = "var(--text-secondary)";
      box.textContent = "正在发起真实连通性与鉴权探测…";
    }
    const models = $("pf-models").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    try {
      const res = await apiJson("/api/providers/test", {
        method: "POST",
        body: JSON.stringify({
          id: state.selectedProviderId || undefined,
          name: $("pf-name").value.trim(),
          kind: $("pf-kind").value,
          base_url: $("pf-baseurl").value.trim(),
          api_key: $("pf-apikey").value.trim() || undefined,
          default_model: $("pf-default-model").value.trim() || models[0] || "",
          models,
        }),
      });
      if (box) {
        if (res.ok) {
          box.style.color = "var(--ok)";
          box.textContent = `● ${res.message || `连接成功 (${res.latency_ms || 0} ms)`}`;
          toast(res.message || "供应商连接测试通过！");
        } else {
          box.style.color = "var(--err)";
          box.textContent = `✕ 连接未通过：${res.error || res.message || "未知错误"}`;
          toast("测试未通过，请查看下方提示", 3600);
        }
      }
    } catch (err) {
      if (box) {
        box.style.color = "var(--err)";
        box.textContent = `✕ 测试请求失败：${err.message}`;
      }
      toast("测试连接异常: " + err.message);
    } finally {
      if (btn) btn.disabled = false;
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

  function getSearchEngineMode() {
    return $("store-search-engine")?.value || state.settings.search_engine?.mode || "auto";
  }

  function syncSearchEngineBadge(eng) {
    const badge = $("store-engine-badge");
    if (!badge || !eng) return;
    const isProxy = eng.active === "proxy";
    badge.textContent = eng.label || (isProxy ? "代理引擎" : "国内直连");
    badge.classList.toggle("is-proxy", isProxy);
  }

  function openStoresModal(tab = "mcp") {
    state.activeStoreTab = tab;
    openModal("modal-stores");
    const se = state.settings.search_engine?.mode || "auto";
    if ($("store-search-engine")) $("store-search-engine").value = se;
    document.querySelectorAll("[data-storetab]").forEach((b) => b.classList.toggle("active", b.dataset.storetab === tab));
    $("store-pane-mcp").classList.toggle("hidden", tab !== "mcp");
    $("store-pane-skills").classList.toggle("hidden", tab !== "skills");
    $("store-pane-wallpapers").classList.toggle("hidden", tab !== "wallpapers");
    if (tab === "mcp") { loadInstalledMcps(); searchMcp($("mcp-search-input").value.trim()); }
    if (tab === "skills") { loadInstalledSkills(); searchSkills($("skills-search-input").value.trim()); }
    if (tab === "wallpapers") {
      renderCustomBgs();
      apiJson("/api/backgrounds/storage").then((r) => renderWallpaperStorage(r.storage)).catch(() => {});
      loadWallpaperEngineLibrary(false);
      searchWallpapers($("wp-search-input").value.trim());
    }
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
        `<div class="store-card-head"><span class="store-card-title" title="${escHtml(m.name)}">${escHtml(m.name)}</span>` +
        `<span class="store-badge ${m.runtime_status === "connected" ? "is-remote" : ""}">${escHtml(m.runtime_status)} · ${m.tools_count || 0} 工具</span></div>` +
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

  let mcpReqSeq = 0;
  async function searchMcp(q) {
    const seq = ++mcpReqSeq;
    const el = $("store-mcp-list");
    el.innerHTML = `<div class="muted-text">${q ? `正在联网搜索「${escHtml(q)}」开源 MCP (npm & GitHub)…` : "加载精选开源 MCP…"}</div>`;
    try {
      const data = await apiJson(`/api/stores/mcp?q=${encodeURIComponent(q)}&engine=${encodeURIComponent(getSearchEngineMode())}`);
      if (seq !== mcpReqSeq) return;
      syncSearchEngineBadge(data.search_engine);
      el.innerHTML = "";
      const items = data.items || [];
      if (!items.length) {
        el.innerHTML = `<div class="muted-text">未找到匹配的开源 MCP${data.online_error ? `（${escHtml(data.online_error)}）` : "，请换个英文关键词试试"}。</div>`;
        return;
      }
      for (const m of items) {
        const card = document.createElement("div");
        card.className = "store-card";
        const isInstalled = state.installedMcps.some((x) => (m.id && x.source_id === m.id) || x.name === m.name);
        const isOfficial = Boolean(m.featured || (m.tags || []).includes("official"));
        const isRemote = m.command === "http" || m.command === "sse" || m.badge === "远程";
        const badgeText = isInstalled
          ? "✓ 已安装"
          : isOfficial
            ? "官方精选"
            : isRemote
              ? "远程直连"
              : m.badge || (m.tags || [])[0] || "开源";
        const badgeCls = isInstalled ? "is-installed" : isOfficial ? "is-official" : isRemote ? "is-remote" : "";
        const descText =
          (m.description && m.description.trim()) ||
          `公开 MCP 扩展工具服务（${m.command === "http" || m.command === "sse" ? "远程直连" : m.command}），一键安装后即可供 Claude Code 调用。`;
        card.innerHTML =
          `<div class="store-card-head">` +
            `<span class="store-card-title" title="${escHtml(m.title || m.name)}">${escHtml(m.title || m.name)}</span>` +
            `<span class="store-badge ${badgeCls}">${escHtml(badgeText)}</span>` +
          `</div>` +
          `<div class="store-card-desc" title="${escHtml(descText)}">${escHtml(descText)}</div>` +
          `<div class="store-card-foot">` +
            (m.repo_url ? `<a class="link-btn" href="${escHtml(m.repo_url)}" target="_blank">源码仓库 ↗</a>` : `<span></span>`) +
            `<button class="${isInstalled ? "btn-secondary" : "btn-primary"} sm btn-install">${isInstalled ? "重新配置/更新" : "一键安装启用"}</button>` +
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
    } catch (err) {
      if (seq !== mcpReqSeq) return;
      el.innerHTML = `<div class="muted-text" style="color:var(--err);">MCP 联网搜索失败：${escHtml(err.message)}</div>`;
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
        `<div class="store-card-head"><span class="store-card-title" title="/${escHtml(s.slug)} · ${escHtml(s.name)}">/${escHtml(s.slug)} · ${escHtml(s.name)}</span>` +
        `<span class="store-badge ${s.enabled ? "is-remote" : ""}">${s.enabled ? "已启用" : "已停用"}</span></div>` +
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

  let skillReqSeq = 0;
  async function searchSkills(q) {
    const seq = ++skillReqSeq;
    const el = $("store-skills-list");
    el.innerHTML = `<div class="muted-text">${q ? `正在联网搜索「${escHtml(q)}」GitHub 开源 Skills…` : "加载精选 Skills…"}</div>`;
    try {
      const data = await apiJson(`/api/stores/skills?q=${encodeURIComponent(q)}&engine=${encodeURIComponent(getSearchEngineMode())}`);
      if (seq !== skillReqSeq) return;
      syncSearchEngineBadge(data.search_engine);
      el.innerHTML = "";
      const items = data.items || [];
      if (!items.length) {
        el.innerHTML = `<div class="muted-text">未找到匹配的开源 Skills${data.online_error ? `（${escHtml(data.online_error)}）` : "，请换个关键词试试"}。</div>`;
        return;
      }
      for (const s of items) {
        const card = document.createElement("div");
        card.className = "store-card";
        const isInstalled = state.installedSkills.some((x) => (s.slug && x.slug === s.slug) || x.name === s.name);
        const isOfficial = s.badge === "官方" || String(s.id || "").startsWith("anth-skill-") || String(s.id || "").startsWith("skill-");
        const badgeText = isInstalled ? "✓ 已安装" : isOfficial ? "官方" : s.badge || `/${(s.slug || "skill").slice(0, 12)}`;
        const badgeCls = isInstalled ? "is-installed" : isOfficial ? "is-official" : "";
        const descText =
          (s.description && s.description.trim()) ||
          `公开 Agent 扩展技能（安装后支持 /${s.slug || "skill"} 调用），点击自动拉取 SKILL.md 并启用。`;
        card.innerHTML =
          `<div class="store-card-head">` +
            `<span class="store-card-title" title="${escHtml(s.name)}">${escHtml(s.name)}</span>` +
            `<span class="store-badge ${badgeCls}" title="/${escHtml(s.slug)}">${escHtml(badgeText)}</span>` +
          `</div>` +
          `<div class="store-card-desc" title="${escHtml(descText)}">${escHtml(descText)}</div>` +
          `<div class="store-card-foot">` +
            (s.source_url ? `<a class="link-btn" href="${escHtml(s.source_url)}" target="_blank">开源仓库 ↗</a>` : `<span></span>`) +
            `<button class="${isInstalled ? "btn-secondary" : "btn-primary"} sm btn-dl">${isInstalled ? "更新重装" : "下载并启用"}</button>` +
          `</div>`;
        card.querySelector(".btn-dl").addEventListener("click", async () => {
          toast(`正在下载 Skill：${s.name}…`);
          await apiJson("/api/skills", { method: "POST", body: JSON.stringify(s) });
          loadInstalledSkills();
          toast(`已安装 Skill /${s.slug}！`);
        });
        el.appendChild(card);
      }
    } catch (err) {
      if (seq !== skillReqSeq) return;
      el.innerHTML = `<div class="muted-text" style="color:var(--err);">Skills 联网搜索失败：${escHtml(err.message)}</div>`;
    }
  }

  // ==================== LAZY MEDIA OBSERVER, WALLPAPER FAVORITES, RANDOM & ZEN SHOWCASE ====================

  const _wpThumbObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const el = entry.target;
            if (el.tagName === "VIDEO") {
              if (entry.isIntersecting) {
                if (el.dataset.lazySrc && !el.getAttribute("src")) {
                  el.setAttribute("src", el.dataset.lazySrc);
                }
                el.play().catch(() => {});
              } else {
                el.pause();
              }
            } else if (entry.isIntersecting) {
              const bgSrc = el.dataset.bgSrc;
              if (bgSrc) {
                el.style.backgroundImage = `url("${bgSrc.replace(/"/g, '\\"')}")`;
                delete el.dataset.bgSrc;
              }
              el.classList.remove("is-lazy");
              _wpThumbObserver.unobserve(el);
            }
          }
        },
        { rootMargin: "200px 0px" },
      )
    : null;

  function observeLazyThumb(thumbEl, imgUrl, eager = false) {
    if (!thumbEl || !imgUrl) return;
    if (eager || !_wpThumbObserver) {
      thumbEl.style.backgroundImage = `url("${imgUrl.replace(/"/g, '\\"')}")`;
      return;
    }
    thumbEl.classList.add("is-lazy");
    thumbEl.dataset.bgSrc = imgUrl;
    _wpThumbObserver.observe(thumbEl);
  }

  function observeLazyVideo(vidEl, srcUrl) {
    if (!vidEl || !srcUrl) return;
    if (!_wpThumbObserver) {
      vidEl.setAttribute("src", srcUrl);
      return;
    }
    vidEl.dataset.lazySrc = srcUrl;
    _wpThumbObserver.observe(vidEl);
  }

  function getFavoriteWallpapers() {
    return Array.isArray(state.settings?.favorite_wallpapers) ? state.settings.favorite_wallpapers : [];
  }

  function getWallpaperFavKey(w) {
    if (!w || w.type === "none") return "";
    if (w.type === "live") return `live:${w.liveBg}`;
    return `${w.type || w.play_mode || "image"}:${w.url || w.stream_url || w.id || ""}`;
  }

  function isWallpaperFavorited(w) {
    const key = getWallpaperFavKey(w);
    if (!key) return false;
    return getFavoriteWallpapers().some((item) => getWallpaperFavKey(item) === key);
  }

  function syncFavoriteCountBadge() {
    const cnt = getFavoriteWallpapers().length;
    const el = $("wp-fav-count");
    if (!el) return;
    el.textContent = String(cnt);
    el.classList.toggle("hidden", cnt <= 0);
  }

  function toggleFavoriteWallpaper(w, btnEl) {
    const key = getWallpaperFavKey(w);
    if (!key) return;
    const list = getFavoriteWallpapers().slice();
    const idx = list.findIndex((item) => getWallpaperFavKey(item) === key);
    let added = false;
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      added = true;
      list.unshift({
        id: w.id || key,
        name: w.name || w.title || "收藏壁纸",
        type: w.type || w.play_mode || "image",
        url: w.url || w.stream_url || "",
        thumb: w.thumb || w.preview_url || w.url || "",
        liveBg: w.liveBg || "",
        preview_css: w.preview_css || "",
        resolution: w.resolution || "",
        author: w.author || w.source_label || "",
        license: w.license || "",
        description: w.description || "",
      });
    }
    state.settings.favorite_wallpapers = list.slice(0, 200);
    syncFavoriteCountBadge();
    if (btnEl) {
      btnEl.classList.toggle("is-fav", added);
      btnEl.textContent = added ? "♥" : "♡";
      btnEl.title = added ? "取消收藏" : "收藏此壁纸";
    }
    apiJson("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ favorite_wallpapers: state.settings.favorite_wallpapers }),
    }).catch(() => {});
    toast(added ? `❤️ 已收藏壁纸：${w.name || w.title}` : "已移出我的收藏");
    if (!added && state.wpCategory === "favorites" && !$("modal-stores")?.classList.contains("hidden")) {
      searchWallpapers("", 1, false);
    }
  }

  function applyWallpaperItem(w) {
    if (!w) return;
    const title = w.name || w.title || "精选壁纸";
    if (w.type === "live") {
      updateAppearance({ bgType: "live", liveBg: w.liveBg, bgUrl: "", bgName: title });
    } else if (w.type === "video" || w.play_mode === "video") {
      updateAppearance({ bgType: "video", bgUrl: w.url || w.stream_url || "", liveBg: "", bgName: title });
    } else if (w.type === "web" || w.play_mode === "web") {
      updateAppearance({ bgType: "web", bgUrl: w.url || w.stream_url || "", liveBg: "", bgMode: "hd", bgBlur: 0, bgName: title });
    } else {
      updateAppearance({ bgType: w.type === "gif" ? "image" : (w.type || "image"), bgUrl: w.url || w.stream_url || "", liveBg: "", bgName: title });
    }
    const zenTitle = $("zen-wp-title");
    if (zenTitle) zenTitle.textContent = title;
  }

  async function applyRandomWallpaper() {
    let pool = [
      ...(state.lastWpItems || []).filter((w) => w && w.type !== "none"),
      ...getFavoriteWallpapers(),
      ...((state.weLibrary?.items || []).filter((i) => i.playable && i.stream_url)),
    ];
    if (!pool.length) {
      try {
        const res = await apiJson(`/api/stores/wallpapers?category=all&page=1&engine=${encodeURIComponent(getSearchEngineMode())}`);
        state.lastWpItems = res.items || [];
        pool = state.lastWpItems.filter((w) => w && w.type !== "none");
      } catch {}
    }
    if (!pool.length) return toast("暂无可用壁纸池");
    const ap = state.settings.appearance || {};
    const curId = ap.bgType === "live" ? ap.liveBg : ap.bgUrl;
    const candidates = pool.filter((w) => (w.liveBg || w.url || w.stream_url) !== curId);
    const chosen = (candidates.length ? candidates : pool)[Math.floor(Math.random() * (candidates.length || pool.length))];
    applyWallpaperItem(chosen);
    toast(`🎲 已随机切换壁纸：${chosen.name || chosen.title || "高清壁纸"}`);
  }

  function toggleZenWallpaperMode(forceState) {
    const next = typeof forceState === "boolean" ? forceState : !state.zenMode;
    if (next) {
      const ap = state.settings.appearance || {};
      const hasBg = ap.bgType && ap.bgType !== "none" && (ap.bgUrl || ap.liveBg);
      if (!hasBg) {
        updateAppearance({ bgType: "live", liveBg: "live-aurora", bgUrl: "", bgName: "极光流影 · 动态 60fps" });
        toast("已为您自动点亮「极光流影」动态壁纸并进入沉浸赏析", 2800);
      }
      state.zenMode = true;
      document.body.classList.add("zen-wallpaper-mode");
      const titleEl = $("zen-wp-title");
      if (titleEl) {
        const curName = state.settings.appearance?.bgName || (state.settings.appearance?.bgType === "web" ? "Web 互动壁纸（可直接移动鼠标交互）" : "沉浸壁纸赏析");
        titleEl.textContent = curName;
      }
      openAnimatedLayer($("zen-exit-bar"));
    } else {
      if (!state.zenMode) return;
      state.zenMode = false;
      document.body.classList.remove("zen-wallpaper-mode");
      closeAnimatedLayer($("zen-exit-bar"), 200);
    }
  }

  async function loadWallpaperEngineLibrary(refresh = false) {
    try {
      const data = await apiJson(`/api/we/status?refresh=${refresh ? "1" : "0"}`);
      state.weLibrary = data;
      renderWallpaperEngineSection(data);
    } catch {}
  }

  function renderWallpaperEngineSection(data) {
    if (!data) return;
    const authorized = Boolean(data.authorized && data.dirs?.length);
    const dirsBar = $("we-dirs-bar");
    const grid = $("we-grid");
    const sub = $("we-bridge-sub");
    const btnSteam = $("btn-we-authorize-steam");
    const btnRef = $("btn-we-refresh");
    const btnMute = $("btn-we-toggle-mute");
    const btnRevoke = $("btn-we-revoke");

    btnRef?.classList.toggle("hidden", !authorized);
    btnMute?.classList.toggle("hidden", !authorized);
    btnRevoke?.classList.toggle("hidden", !authorized);
    if (btnSteam) btnSteam.textContent = authorized ? "重新探测 Steam (431960)" : "🔐 只读授权壁纸目录";
    if (btnMute) btnMute.textContent = data.video_muted !== false ? "🔇 视频静音" : "🔊 视频有声";

    if (!authorized) {
      if (sub) {
        sub.innerHTML =
          `<b>与您的 Windows 桌面壁纸完全独立、互不同步、绝不改动您系统桌面</b> · 只读零拷贝直连原版 4K/8K 视频（支持数百 MB ~ 数 GB 长动画）与 Web 互动壁纸，0 压缩、0 拷贝、断网可用`;
      }
      dirsBar?.classList.add("hidden");
      grid?.classList.add("hidden");
      return;
    }

    if (sub) {
      sub.innerHTML =
        `<span style="color:var(--ok);font-weight:600;">● 已只读授权（完全独立于您系统桌面）</span> · 发现 <b>${data.playable_count || 0}</b> 个可 0 损耗独立播放的原版视频/Web/原图壁纸（共 ${data.count || 0} 项 · 0 拷贝 0 额外占用）`;
    }

    if (dirsBar) {
      dirsBar.classList.remove("hidden");
      dirsBar.innerHTML = "";
      for (const d of data.dirs || []) {
        const chip = document.createElement("span");
        chip.className = "we-dir-chip";
        chip.title = d;
        chip.innerHTML = `<span>📁 ${escHtml(d)}</span><button type="button" title="移除此目录授权">×</button>`;
        chip.querySelector("button").addEventListener("click", async () => {
          const res = await apiJson("/api/we/revoke", { method: "POST", body: JSON.stringify({ remove_dir: d }) });
          state.weLibrary = res;
          renderWallpaperEngineSection(res);
          toast("已移除该目录授权");
        });
        dirsBar.appendChild(chip);
      }
    }

    if (!grid) return;
    grid.classList.remove("hidden");
    grid.innerHTML = "";
    const items = data.items || [];
    const playableItems = items.filter((i) => i.playable);
    const lockedItems = items.filter((i) => !i.playable);
    if (!items.length) {
      grid.innerHTML = `<div class="muted-text" style="white-space:normal;">已授权目录内暂未发现壁纸。点击上方「🚀 打开 Steam 小红车逛工坊」订阅任意 <b>视频 (Video)</b> 或 <b>网页 (Web)</b> 类型壁纸后，点击「🔄 刷新」即可独立原画质播放！</div>`;
      return;
    }
    const ap = state.settings.appearance || {};
    const buildWeCard = (it, idx = 0) => {
      const isActive = Boolean(it.playable && it.stream_url && ap.bgUrl === it.stream_url);
      const card = document.createElement("div");
      card.className = "wp-card" + (isActive ? " active" : "") + (!it.playable ? " we-card-locked" : "");
      const isDirectVideoThumb = it.we_type === "video" && !it.preview_url.includes("kind=preview");
      const favHtml = it.playable
        ? `<button type="button" class="wp-fav-btn${isWallpaperFavorited(it) ? " is-fav" : ""}" title="${isWallpaperFavorited(it) ? "取消收藏" : "收藏此壁纸"}">${isWallpaperFavorited(it) ? "♥" : "♡"}</button>`
        : "";
      const thumbHtml = isDirectVideoThumb
        ? `<div class="wp-thumb">${favHtml}<video class="wp-thumb-vid" muted loop playsinline preload="metadata"></video><span class="wp-live-badge">${escHtml(it.badge)}</span></div>`
        : `<div class="wp-thumb">${favHtml}<span class="wp-live-badge">${escHtml(it.badge)}</span></div>`;
      card.innerHTML =
        thumbHtml +
        `<div class="wp-meta"><div class="wp-name">${escHtml(it.title)}</div>` +
        `<div class="wp-sub">${escHtml(it.source_label || "Wallpaper Engine")} · ${escHtml(it.description || "")}</div></div>`;

      const thumbEl = card.querySelector(".wp-thumb");
      if (isDirectVideoThumb) {
        observeLazyVideo(card.querySelector("video"), `${it.stream_url}#t=0.5`);
      } else {
        observeLazyThumb(thumbEl, it.preview_url || it.stream_url, idx < 6);
      }

      card.querySelector(".wp-fav-btn")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleFavoriteWallpaper(it, ev.currentTarget);
      });

      card.addEventListener("click", (ev) => {
        if (ev.target.closest(".wp-fav-btn")) return;
        if (it.playable && it.stream_url) {
          // 100% lossless independent playback — NEVER touches Windows desktop wallpaper!
          updateAppearance({ bgType: it.play_mode, bgUrl: it.stream_url, liveBg: "", bgMode: "hd", bgBlur: 0, bgName: it.title });
          grid.querySelectorAll(".wp-card").forEach((c) => c.classList.remove("active"));
          card.classList.add("active");
          toast(`已独立应用原版 0 损耗壁纸：${it.title}（不影响您的桌面壁纸）`, 3200);
        } else {
          toast(
            `「${it.title}」是小红车专有 DirectX 3D (.pkg) 格式，无法脱离小红车无损独立渲染。在创意工坊勾选「类型：视频 (Video) / 网页 (Web)」下载即可 100% 4K 独立播放！`,
            5500,
          );
        }
      });
      return card;
    };

    if (!playableItems.length) {
      const hint = document.createElement("div");
      hint.className = "muted-text";
      hint.style.cssText = "grid-column:1/-1;white-space:normal;line-height:1.5;";
      hint.innerHTML =
        `当前已授权目录内暂无可直接 0 损耗独立播放的 <b>视频 (Video)</b> 或 <b>网页 (Web)</b> 壁纸。请在 Steam 小红车创意工坊左侧筛选勾选 <b>「类型：视频」</b> 或 <b>「类型：网页」</b> 订阅下载后点击「🔄 刷新」。`;
      grid.appendChild(hint);
    } else {
      playableItems.forEach((it, idx) => grid.appendChild(buildWeCard(it, idx)));
    }

    if (lockedItems.length) {
      const det = document.createElement("details");
      det.className = "we-locked-details";
      det.innerHTML =
        `<summary>已折叠 ${lockedItems.length} 个小红车专有 DirectX 3D (.pkg) 项目（专有格式无法脱离小红车无损独立渲染）</summary>` +
        `<div class="wp-grid" style="margin-top:8px;"></div>`;
      const subGrid = det.querySelector(".wp-grid");
      lockedItems.forEach((it, idx) => subGrid.appendChild(buildWeCard(it, idx + 8)));
      grid.appendChild(det);
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
      const isVideo = bg.source === "video" || /\.(mp4|webm)$/i.test(bg.url || "");
      const card = document.createElement("div");
      card.className = "wp-card" + (curUrl === bg.url ? " active" : "");
      card.innerHTML =
        (isVideo
          ? `<div class="wp-thumb"><video class="wp-thumb-vid" src="${escHtml(bg.url)}" muted loop playsinline autoplay></video><span class="wp-live-badge">🎬 动态视频</span></div>`
          : `<div class="wp-thumb" style="background-image:url('${escHtml(bg.url)}')"></div>`) +
        `<div class="wp-meta"><div class="wp-name">${escHtml(bg.name)}</div>` +
        `<div class="wp-sub" style="display:flex;justify-content:space-between;"><span>${isVideo ? "动态视频壁纸" : "本地图片"}</span><button class="link-btn btn-rm-bg" style="padding:0;color:var(--err);">删除</button></div></div>`;
      card.addEventListener("click", (e) => {
        if (e.target.closest(".btn-rm-bg")) return;
        updateAppearance({ bgType: isVideo ? "video" : "upload", bgUrl: bg.url, liveBg: "", bgName: bg.name });
        renderCustomBgs();
        toast(`已应用${isVideo ? "动态视频" : ""}背景：${bg.name}`);
      });
      card.querySelector(".btn-rm-bg").addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await apiJson(`/api/backgrounds/${encodeURIComponent(bg.id)}`, { method: "DELETE" });
        state.customBackgrounds = res.backgrounds || [];
        if (res.storage) renderWallpaperStorage(res.storage);
        renderCustomBgs();
        toast("已删除该背景并清理本地文件");
      });
      grid.appendChild(card);
    }
  }

  let wpReqSeq = 0;
  function buildWallpaperCard(w, grid, idx = 0) {
    const ap = state.settings.appearance || {};
    const isActive =
      (w.type === "none" && (!ap.bgType || ap.bgType === "none")) ||
      (w.type === "live" && ap.bgType === "live" && ap.liveBg === w.liveBg) ||
      ((w.url || w.stream_url) && (ap.bgUrl === (w.url || w.stream_url) || ap.sourceUrl === w.url));
    const card = document.createElement("div");
    card.className = "wp-card" + (isActive ? " active" : "");
    const inlineCss = w.preview_css ? `background:${w.preview_css}` : "";
    const favable = w.type !== "none";
    const isFav = favable && isWallpaperFavorited(w);
    const favHtml = favable
      ? `<button type="button" class="wp-fav-btn${isFav ? " is-fav" : ""}" title="${isFav ? "取消收藏" : "收藏此壁纸"}">${isFav ? "♥" : "♡"}</button>`
      : "";
    const badgeHtml =
      w.type === "live"
        ? `<span class="wp-live-badge">✨ 高刷动态</span>`
        : w.type === "video"
          ? `<span class="wp-live-badge">🎬 动态视频</span>`
          : w.type === "web"
            ? `<span class="wp-live-badge">✨ Web 互动</span>`
            : w.type === "gif"
              ? `<span class="wp-live-badge">✨ 动态 GIF</span>`
              : w.resolution
                ? `<span class="wp-res-badge">${escHtml(w.resolution)}</span>`
                : "";
    const subText = w.description
      ? `${w.description}`
      : `${w.license || "Open"} · ${w.author || ""}`;
    card.innerHTML =
      `<div class="wp-thumb"${inlineCss ? ` style="${inlineCss}"` : ""}>${favHtml}${badgeHtml}</div>` +
      `<div class="wp-meta"><div class="wp-name">${escHtml(w.name || w.title || "壁纸")}</div><div class="wp-sub" title="${escHtml(subText)}">${escHtml(subText)}</div></div>`;

    if (!w.preview_css && (w.thumb || w.url)) {
      observeLazyThumb(card.querySelector(".wp-thumb"), w.thumb || w.url, idx < 12);
    }

    card.querySelector(".wp-fav-btn")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleFavoriteWallpaper(w, ev.currentTarget);
    });

    card.addEventListener("click", (ev) => {
      if (ev.target.closest(".wp-fav-btn")) return;
      if (w.type === "none") {
        updateAppearance({ bgType: "none", bgUrl: "", liveBg: "", bgName: "" });
      } else {
        applyWallpaperItem(w);
      }
      grid.querySelectorAll(".wp-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      toast(`已应用背景：${w.name || w.title}`);
    });
    return card;
  }

  async function searchWallpapers(q, page = 1, append = false) {
    const seq = ++wpReqSeq;
    const grid = $("store-wp-grid");
    const metaEl = $("wp-search-meta");
    const moreBtn = $("btn-wp-load-more");
    const cat = state.wpCategory || "all";
    syncFavoriteCountBadge();

    if (cat === "favorites" && !q) {
      state.wpPage = 1;
      state.wpHasMore = false;
      moreBtn?.classList.add("hidden");
      const favs = getFavoriteWallpapers();
      grid.innerHTML = "";
      if (!favs.length) {
        grid.innerHTML = `<div class="muted-text" style="grid-column:1/-1;white-space:normal;">尚未收藏任何壁纸。悬停任意壁纸卡片左上角点击「♡」即可加入我的收藏（离线快速切换）！</div>`;
        if (metaEl) metaEl.textContent = "0 张收藏";
      } else {
        favs.forEach((w, idx) => grid.appendChild(buildWallpaperCard(w, grid, idx)));
        if (metaEl) metaEl.textContent = `已收藏 ${favs.length} 张壁纸`;
      }
      return;
    }

    if (!append) {
      state.wpPage = 1;
      const loadingHint = q
        ? `正在实时联网搜索「${escHtml(q)}」${cat === "live" ? "动态壁纸与循环视频" : "海量 4K 壁纸"}…`
        : cat === "bing_uhd"
          ? "正在拉取微软必应官方每日 4K UHD (3840×2160) 原版壁纸…"
          : cat === "live"
            ? "正在加载 14 款高刷动态壁纸与在线开源循环视频…"
            : "正在加载精选与微软必应 4K UHD 壁纸…";
      grid.innerHTML = `<div class="muted-text">${loadingHint}</div>`;
      if (metaEl) metaEl.textContent = "检索中…";
      moreBtn?.classList.add("hidden");
    } else if (moreBtn) {
      moreBtn.disabled = true;
      moreBtn.textContent = "加载下一页中…";
    }

    try {
      const data = await apiJson(
        `/api/stores/wallpapers?q=${encodeURIComponent(q)}&page=${encodeURIComponent(page)}&category=${encodeURIComponent(cat)}&engine=${encodeURIComponent(getSearchEngineMode())}`,
      );
      if (seq !== wpReqSeq) return;
      syncSearchEngineBadge(data.search_engine);
      if (!append) grid.innerHTML = "";

      const items = data.items || [];
      state.lastWpItems = append ? [...(state.lastWpItems || []), ...items] : items;
      if (!items.length && !append) {
        grid.innerHTML = `<div class="muted-text">未搜索到匹配壁纸${data.online_error ? `（${escHtml(data.online_error)}）` : "，试试「星空」「极光」「海洋」「樱花」「赛博」或英文关键词"}。</div>`;
      } else {
        let imgSeq = append ? 12 : 0;
        items.forEach((w) => {
          const isRealImg = !w.preview_css && Boolean(w.thumb || w.url);
          const cardIdx = isRealImg ? imgSeq++ : 99;
          grid.appendChild(buildWallpaperCard(w, grid, cardIdx));
        });
      }

      state.wpPage = data.page || page;
      state.wpHasMore = Boolean(data.has_more);
      if (moreBtn) {
        moreBtn.disabled = false;
        moreBtn.textContent = cat === "live" ? `加载更多在线动态视频（第 ${state.wpPage + 1} 页）` : `加载更多 4K 壁纸（第 ${state.wpPage + 1} 页）`;
        moreBtn.classList.toggle("hidden", !state.wpHasMore);
      }
      if (metaEl) {
        if (cat === "bing_uhd") {
          metaEl.textContent = `必应官方每日 4K UHD 原图 · 共 ${grid.children.length} 张`;
        } else if (cat === "live") {
          metaEl.textContent = `当前已加载 ${grid.children.length} 个动态壁纸（14款内置 + 在线视频）${data.online_error ? ` · ${data.online_error}` : ""}`;
        } else if (data.total_online > 0) {
          metaEl.textContent = `在线共 ${Number(data.total_online).toLocaleString()} 张 4K 壁纸（第 ${state.wpPage}/${data.last_page || 1} 页）`;
        } else if (data.online_error) {
          metaEl.textContent = data.online_error;
        } else {
          metaEl.textContent = `当前展示 ${grid.children.length} 张`;
        }
      }
    } catch (err) {
      if (seq !== wpReqSeq) return;
      if (!append) grid.innerHTML = `<div class="muted-text" style="color:var(--err);">壁纸联网搜索失败：${escHtml(err.message)}</div>`;
      if (metaEl) metaEl.textContent = "联网失败";
      if (moreBtn) {
        moreBtn.disabled = false;
        moreBtn.textContent = "重试加载更多";
      }
    }
  }

  // ==================== MODAL: SETTINGS & CLAUDE CORE VERSION / SHELL UPDATER ====================

  let promptSaveTimer = null;
  let promptSaveSeq = 0;

  function setPromptSaveBadge(kind, text) {
    const el = $("prompt-save-status");
    if (!el) return;
    el.textContent = text;
    el.style.color =
      kind === "ok" ? "var(--ok)" : kind === "err" ? "var(--err)" : "var(--brand)";
  }

  async function flushPromptAutoSave(silent = true) {
    clearTimeout(promptSaveTimer);
    promptSaveTimer = null;
    const ta = $("set-system-prompt");
    if (!ta) return;
    const val = ta.value;
    const mode = $("set-prompt-mode")?.value || "replace";
    state._promptDirty = false;
    const seq = ++promptSaveSeq;
    setPromptSaveBadge("saving", "保存中…");
    try {
      const res = await apiJson("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ system_prompt: val, prompt_mode: mode }),
      });
      if (seq !== promptSaveSeq) return;
      if (res?.settings) state.settings = res.settings;
      setPromptSaveBadge("ok", "● 已自动保存");
      if (!silent) toast("自定义系统提示词已保存并立即生效");
    } catch (err) {
      if (seq !== promptSaveSeq) return;
      state._promptDirty = true;
      setPromptSaveBadge("err", "保存失败，请重试");
      toast("提示词保存失败: " + err.message, 4000);
    }
  }

  function schedulePromptAutoSave() {
    state._promptDirty = true;
    setPromptSaveBadge("saving", "编辑中…");
    clearTimeout(promptSaveTimer);
    promptSaveTimer = setTimeout(() => {
      flushPromptAutoSave(true);
    }, 550);
  }

  function renderDbStats(st) {
    if (st) state.dbStats = st;
    const info = state.dbStats;
    const el = $("db-stats-line");
    if (!el || !info) return;
    el.textContent =
      `主库 ${info.db_mb} MB + WAL 日志 ${info.wal_mb} MB（总计 ${info.total_mb} MB） · ` +
      `活跃会话 ${info.sessions_active} 个 / 已删除归档 ${info.sessions_archived} 个 · ` +
      `消息 ${info.messages_total} 条 · 记忆 ${info.memories_total} 篇 · ` +
      `FTS5 全文索引：${info.fts_enabled ? "已启用" : "标准模式"}`;
    const purgeBtn = $("btn-db-purge-archived");
    if (purgeBtn) purgeBtn.disabled = !info.sessions_archived;
  }

  async function runLegacyCleanup() {
    const btn = $("btn-cleanup-legacy");
    if (btn) btn.disabled = true;
    toast("正在扫描并清理旧便携版残留、0轮空壳会话与预览缓存…");
    try {
      const res = await apiJson("/api/system/cleanup-legacy", {
        method: "POST",
        body: JSON.stringify({ purge_archived: false }),
      });
      if (res.after_db) renderDbStats(res.after_db);
      if (res.wallpaper_storage) renderWallpaperStorage(res.wallpaper_storage);
      if (res.purged_empty_shells > 0) {
        if (state.activeSessionId && (!state.activeTimeline?.items?.length)) {
          startNewSession();
        }
        await refreshSessions().catch(() => {});
      }
      const parts = [];
      if (res.portable_dirs_removed > 0) parts.push(`旧便携版解包残留 ${res.portable_dirs_removed} 处`);
      if (res.purged_empty_shells > 0) parts.push(`0 轮空壳会话 ${res.purged_empty_shells} 个`);
      if (res.wp_cache_removed > 0) parts.push(`壁纸预览缓存 ${res.wp_cache_removed} 项`);
      if (res.orphan_prompts_removed > 0) parts.push(`临时文件 ${res.orphan_prompts_removed} 个`);
      const detailTxt = parts.length ? `已清理：${parts.join("、")}` : "检查完毕，当前环境非常干净无残留";
      const freedTxt = res.total_freed_mb > 0 ? `（共释放 ${res.total_freed_mb} MB）` : "";
      toast(`🧼 ${detailTxt}${freedTxt}`, 4200);
    } catch (err) {
      toast("清理旧版残留失败: " + err.message, 4000);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runDatabaseMaintenance(purgeArchived = false) {
    if (
      purgeArchived &&
      !window.confirm(
        `确定彻底清除 ${state.dbStats?.sessions_archived || 0} 个已删除归档的旧会话并压缩回收数据库空间？\n（不会影响任何当前正常展示的活跃会话与记忆）`,
      )
    ) {
      return;
    }
    const btnOpt = $("btn-db-optimize");
    const btnPurge = $("btn-db-purge-archived");
    if (btnOpt) btnOpt.disabled = true;
    if (btnPurge) btnPurge.disabled = true;
    try {
      const res = await apiJson("/api/db/optimize", {
        method: "POST",
        body: JSON.stringify({ purge_archived: purgeArchived }),
      });
      if (res.after) renderDbStats(res.after);
      const freedTxt = res.freed_mb > 0 ? `，已释放 ${res.freed_mb} MB 磁盘空间` : "";
      const purgedTxt = res.purged_sessions > 0 ? `，彻底清理 ${res.purged_sessions} 个归档会话` : "";
      toast(`SQLite 维护完成${purgedTxt}${freedTxt}（当前总计 ${res.after?.total_mb ?? 0} MB）`, 3800);
    } catch (err) {
      toast("数据库维护失败: " + err.message, 4000);
    } finally {
      if (btnOpt) btnOpt.disabled = false;
      renderDbStats();
    }
  }

  async function openSettingsModal() {
    openModal("modal-settings");
    const syncFieldsFromSettings = (s) => {
      const savedPrompt = s.system_prompt !== undefined && s.system_prompt !== null ? String(s.system_prompt) : "";
      if (!state._promptDirty) $("set-system-prompt").value = savedPrompt;
      if ($("set-prompt-mode")) $("set-prompt-mode").value = s.prompt_mode || "replace";
      if ($("set-web-search")) $("set-web-search").value = s.web_search_enabled === false ? "off" : "on";
      if ($("set-search-mode")) $("set-search-mode").value = s.search_engine?.mode || "auto";
      if ($("set-search-proxy")) $("set-search-proxy").value = s.search_engine?.proxy_url || "";
      if ($("set-claude-isolation")) $("set-claude-isolation").value = s.claude_isolation || "isolated";
      $("set-permission-mode").value = s.permission_mode || "auto";
      $("set-default-cwd").value = s.default_cwd || "";
    };
    state._promptDirty = false;
    syncFieldsFromSettings(state.settings || {});
    setPromptSaveBadge("ok", "● 已保存");
    $("updater-current-line").textContent = `当前版本：v${state.version} · 官方仓库：github.com/gniygniynus/opencode-studio`;
    renderClaudeStatusViews();
    renderDbStats();
    // Fetch fresh persisted settings & live DB stats in parallel
    Promise.all([
      apiJson("/api/settings").catch(() => null),
      apiJson("/api/db/stats").catch(() => null),
    ]).then(([fresh, dbRes]) => {
      if (fresh && typeof fresh === "object") {
        state.settings = { ...(state.settings || {}), ...fresh };
        if (!state._promptDirty && document.activeElement !== $("set-system-prompt")) {
          syncFieldsFromSettings(state.settings);
        }
      }
      if (dbRes?.stats) renderDbStats(dbRes.stats);
    });
  }

  async function checkClaudeCoreVersions() {
    const box = $("claude-ver-compare");
    const btn = $("btn-claude-check-ver");
    if (btn) btn.disabled = true;
    if (box) box.textContent = "正在联网检测本机原生 Claude Code 与官方稳定版 (stable) / 最新版 (latest)…";
    try {
      const res = await apiJson("/api/claude/versions");
      state.lastClaudeVersions = res;
      if (res.runtime) {
        state.claudeNative = res.runtime;
        renderClaudeStatusViews();
      }
      const badgeColor =
        res.channel_status === "stable" || res.channel_status === "latest" || res.channel_status === "both"
          ? "var(--ok)"
          : res.channel_status === "outdated"
            ? "var(--brand)"
            : "var(--warn)";
      if (box) {
        box.innerHTML =
          `<div style="font-weight:600;color:${badgeColor};">${escHtml(res.status_text || "")}</div>` +
          `<div class="ver-compare-grid">` +
            `<div class="ver-pill-card"><span class="v-lbl">本机当前版本</span><span class="v-val">${escHtml(res.current_version ? `v${res.current_version}` : "未安装")}</span></div>` +
            `<div class="ver-pill-card"><span class="v-lbl">官方稳定版 (stable)</span><span class="v-val">${escHtml(res.stable_version ? `v${res.stable_version}` : "获取失败")}</span></div>` +
            `<div class="ver-pill-card"><span class="v-lbl">官方最新版 (latest)</span><span class="v-val">${escHtml(res.latest_version ? `v${res.latest_version}` : "获取失败")}</span></div>` +
          `</div>` +
          (res.error ? `<div class="muted-text" style="color:var(--err);margin-top:6px;">${escHtml(res.error)}</div>` : "");
      }
    } catch (err) {
      if (box) box.textContent = "版本检测失败: " + err.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function resetToBundledClaudeCore() {
    const btn = $("btn-claude-reset-bundled");
    if (btn) btn.disabled = true;
    try {
      const res = await apiJson("/api/claude/reset-bundled", { method: "POST", body: JSON.stringify({}) });
      if (res.runtime) {
        state.claudeNative = res.runtime;
        renderClaudeStatusViews();
      }
      $("claude-install-progress-wrap")?.classList.add("hidden");
      toast(`已恢复随软件内置的完整适配版内核 (${res.runtime?.version || "已就绪"})`, 3800);
    } catch (err) {
      toast("恢复内置内核失败: " + err.message, 4000);
    } finally {
      renderClaudeStatusViews();
    }
  }

  async function installOrSwitchClaudeCore(channel) {
    const label = channel === "latest" ? "最新版 (latest)" : "稳定版 (stable)";
    const vInfo = state.lastClaudeVersions;
    const targetVerHint =
      channel === "latest"
        ? (vInfo?.latest_version ? ` (v${vInfo.latest_version})` : "")
        : (vInfo?.stable_version ? ` (v${vInfo.stable_version})` : "");
    const curHint = state.claudeNative?.version ? `当前内核：${state.claudeNative.version}` : "当前尚未检测到内核";

    if (
      !window.confirm(
        `确认在线下载原生 Claude Code「${label}${targetVerHint}」？\n\n` +
          `${curHint}\n` +
          `• 提示：本软件安装包已自带经过完整适配验证的内核，日常无需升级\n` +
          `• 下载的新内核仅存放在工作台私有目录，随时可点击「恢复软件内置适配版内核」一键回退`,
      )
    ) {
      return;
    }

    const pre = $("claude-install-log");
    const progWrap = $("claude-install-progress-wrap");
    const progBar = $("claude-progress-bar");
    const progLbl = $("claude-progress-label");
    const progMeta = $("claude-progress-meta");
    const btnS = $("btn-claude-install-stable");
    const btnL = $("btn-claude-install-latest");
    if (btnS) btnS.disabled = true;
    if (btnL) btnL.disabled = true;
    if (progWrap) {
      progWrap.classList.remove("hidden");
      if (progBar) progBar.style.width = "2%";
      if (progLbl) progLbl.textContent = `正在连接镜像源获取 ${label}…`;
      if (progMeta) progMeta.textContent = "2%";
    }
    if (pre) {
      pre.classList.remove("hidden");
      pre.textContent = `>>> 开始在线下载原生 Claude Code ${label}（内置流式下载，无需本机安装 Node/npm）…\n`;
    }
    try {
      const res = await apiJson("/api/claude/install", {
        method: "POST",
        body: JSON.stringify({ channel }),
      });
      if (res.runtime) {
        state.claudeNative = res.runtime;
        renderClaudeStatusViews();
      } else {
        await refreshClaudeStatus(true);
      }
      if (pre && res.output && !pre.textContent.includes(res.output.slice(0, 40))) {
        pre.textContent += "\n" + res.output;
        pre.scrollTop = pre.scrollHeight;
      }
      if (res.ok) {
        if (progBar) progBar.style.width = "100%";
        if (progLbl) progLbl.textContent = `下载并校验完成 (${state.claudeNative?.version || ""})`;
        if (progMeta) progMeta.textContent = "100%";
        toast(`原生 Claude Code ${label} 已就绪 (${state.claudeNative?.version || ""})`, 4500);
        checkClaudeCoreVersions();
      } else {
        toast(`下载切换未成功：${res.error || "已自动保留软件内置内核可用"}`, 5000);
      }
    } catch (err) {
      if (pre) pre.textContent += `\n[ERROR] ${err.message}`;
      toast("在线下载失败（软件内置内核不受影响）: " + err.message, 4500);
    } finally {
      if (btnS) btnS.disabled = false;
      if (btnL) btnL.disabled = false;
      renderClaudeStatusViews();
    }
  }

  async function runUpdateCheck() {
    const btn = $("btn-check-update");
    if (btn) btn.disabled = true;
    $("updater-result").textContent = "正在联网检测 GitHub 上的项目最新版本…";
    try {
      const res = await apiJson("/api/updater/check?channel=latest");
      if (!res.ok) {
        $("updater-result").innerHTML = `${escHtml(res.message || "检测失败")} <a class="link-btn" href="${escHtml(res.repo_url)}" target="_blank">打开 GitHub Releases ↗</a>`;
        return;
      }
      if (!res.target_version) {
        $("updater-result").innerHTML = `${escHtml(res.message)} <a class="link-btn" href="${escHtml(res.repo_url)}" target="_blank">查看 Releases ↗</a>`;
        return;
      }
      const statusLine = res.has_update
        ? `<b style="color:var(--brand);">发现新版本 ${escHtml(res.tag_name)}</b>（本机当前 v${escHtml(res.current_version)}）`
        : `<b style="color:var(--ok);">● 当前 v${escHtml(res.current_version)} 已是项目最新版本 (${escHtml(res.tag_name)})</b>`;
      const dlBtn = res.recommended_asset
        ? `<a class="btn-primary sm" style="text-decoration:none;margin-right:8px;" href="${escHtml(res.recommended_asset.download_url)}" target="_blank">下载最新版安装包 (${escHtml(res.recommended_asset.name)})</a>`
        : "";
      $("updater-result").innerHTML =
        `<div style="margin-bottom:8px;">${statusLine}</div>` +
        `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${dlBtn}<a class="link-btn" href="${escHtml(res.release_url)}" target="_blank">打开发布页 (${escHtml(res.tag_name)}) ↗</a></div>`;
    } catch (err) {
      $("updater-result").textContent = "检查更新失败: " + err.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ==================== MODAL: CWD (NATIVE PICKER + CUSTOM BY DRIVE) / MEMORY / LOGS ====================

  function updateCustomCwdPreview() {
    const drive = $("cwd-drive-select")?.value || "";
    const sub = ($("cwd-subpath-input")?.value || "").trim().replace(/^[\\/]+/, "");
    const isWin = drive.includes("\\");
    const sep = isWin ? "\\" : "/";
    const preview = !sub ? drive : drive.endsWith(sep) ? drive + sub : drive + sep + sub;
    if ($("cwd-custom-preview")) $("cwd-custom-preview").textContent = preview || "请选择盘符并输入文件夹名";
  }

  let explorerCurrentPath = "";
  let explorerParentPath = "";

  async function loadInlineExplorer(targetPath, hintText = "") {
    const box = $("cwd-inline-explorer");
    const listEl = $("cwd-explorer-list");
    const pathEl = $("cwd-explorer-path");
    const hintEl = $("cwd-explorer-hint");
    if (!box || !listEl) return;
    box.classList.remove("hidden");
    if (hintEl && hintText) hintEl.textContent = hintText;
    listEl.innerHTML = `<div class="muted-text" style="padding:8px;">加载文件夹中…</div>`;
    try {
      const data = await apiJson(`/api/dirs?path=${encodeURIComponent(targetPath || "")}`);
      explorerCurrentPath = data.path || targetPath || "";
      explorerParentPath = data.parent || "";
      if (pathEl) pathEl.textContent = explorerCurrentPath;
      listEl.innerHTML = "";
      const children = data.children || [];
      if (!children.length) {
        listEl.innerHTML = `<div class="muted-text" style="padding:8px;">该目录下没有子文件夹，可直接点击上方「选择此文件夹」。</div>`;
        return;
      }
      for (const ch of children) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "cwd-dir-row";
        row.innerHTML = `<span>📁</span><span>${escHtml(ch.name)}</span>`;
        row.addEventListener("click", () => loadInlineExplorer(ch.path));
        listEl.appendChild(row);
      }
    } catch (err) {
      listEl.innerHTML = `<div class="muted-text" style="color:var(--err);padding:8px;">读取目录失败：${escHtml(err.message)}</div>`;
    }
  }

  async function openCwdModal() {
    openModal("modal-cwd");
    $("cwd-inline-explorer")?.classList.add("hidden");
    const cur = state.activeCwd || state.settings.default_cwd || "";
    if ($("cwd-active-hint")) $("cwd-active-hint").textContent = `当前工作目录：${cur || "未设置"}`;
    try {
      const info = await apiJson("/api/dirs/drives");
      const sel = $("cwd-drive-select");
      const drivesBar = $("cwd-explorer-drives");
      if (drivesBar) {
        drivesBar.innerHTML = "";
        for (const d of info.drives || []) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chip-btn";
          chip.textContent = info.platform === "win32" ? `💾 ${d}` : d;
          chip.addEventListener("click", () => loadInlineExplorer(d));
          drivesBar.appendChild(chip);
        }
        if (info.home) {
          const homeChip = document.createElement("button");
          homeChip.type = "button";
          homeChip.className = "chip-btn";
          homeChip.textContent = "🏠 用户目录";
          homeChip.addEventListener("click", () => loadInlineExplorer(info.home));
          drivesBar.prepend(homeChip);
        }
      }
      if (sel) {
        sel.innerHTML = "";
        for (const d of info.drives || []) {
          const opt = document.createElement("option");
          opt.value = d;
          opt.textContent = info.platform === "win32" ? `${d} 盘` : d;
          sel.appendChild(opt);
        }
        // Pre-select current drive if matched
        const matchedDrive = (info.drives || []).find((d) => cur.toLowerCase().startsWith(d.toLowerCase()));
        if (matchedDrive) sel.value = matchedDrive;
      }
      if ($("cwd-subpath-input") && !$("cwd-subpath-input").value) {
        $("cwd-subpath-input").value = "";
      }
      updateCustomCwdPreview();
    } catch (err) {
      toast("加载本地盘符失败: " + err.message);
    }
  }

  async function applyCwd(p) {
    const clean = (p || "").trim();
    if (!clean) return;
    state.activeCwd = clean;
    $("cwd-pill-text").textContent = clean;
    closeModal("modal-cwd");
    if (state.activeSessionId) {
      await apiJson(`/api/sessions/${encodeURIComponent(state.activeSessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ cwd: clean }),
      });
    }
    toast(`工作目录已设为：${clean}`);
  }

  async function openMemoryModal() {
    openModal("modal-memory");
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
    openModal("modal-logs");
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

    // Quick welcome cards & resume latest pill
    $("wc-providers")?.addEventListener("click", () => openProvidersModal());
    $("wc-stores")?.addEventListener("click", () => openStoresModal("mcp"));
    $("wc-wallpaper")?.addEventListener("click", () => openStoresModal("wallpapers"));
    $("wc-settings")?.addEventListener("click", openSettingsModal);
    $("btn-resume-latest")?.addEventListener("click", () => {
      const latest = state.sessions?.[0];
      if (latest?.id) openSession(latest.id);
    });

    // Navigation buttons
    $("btn-open-providers").addEventListener("click", () => openProvidersModal());
    $("btn-open-stores").addEventListener("click", () => openStoresModal("mcp"));
    $("btn-export-md")?.addEventListener("click", exportCurrentSessionMarkdown);
    $("btn-zen-wallpaper")?.addEventListener("click", () => toggleZenWallpaperMode());
    $("btn-zen-exit")?.addEventListener("click", () => toggleZenWallpaperMode(false));
    $("btn-zen-random")?.addEventListener("click", () => applyRandomWallpaper());
    $("btn-quick-bg").addEventListener("click", () => openStoresModal("wallpapers"));
    $("btn-open-memory").addEventListener("click", openMemoryModal);
    $("btn-open-settings").addEventListener("click", openSettingsModal);
    $("btn-open-logs").addEventListener("click", () => openLogsModal("server"));

    // Custom Glass Popover Dropdown triggers (composer + sidebar workdir filter)
    for (const [ddId, btnId, menuId] of [
      ["gd-cwd-filter", "gd-cwd-filter-btn", "gd-cwd-filter-menu"],
      ["gd-provider", "gd-provider-btn", "gd-provider-menu"],
      ["gd-model", "gd-model-btn", "gd-model-menu"],
      ["gd-thinking", "gd-thinking-btn", "gd-thinking-menu"],
    ]) {
      $(btnId)?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const dd = $(ddId);
        const menu = $(menuId);
        const wasOpen = dd?.classList.contains("open");
        closeAllGlassDropdowns();
        if (!wasOpen && dd && menu) {
          dd.classList.add("open");
          openAnimatedLayer(menu);
        }
      });
    }
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest(".glass-dropdown")) closeAllGlassDropdowns();
    });

    // Composer selectors (fallback sync)
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
        if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.isComposing)) {
          ev.preventDefault();
          return applyAutocomplete(state.acIndex);
        }
        if (ev.key === "Escape") return closeAutocomplete();
        if (ev.key === "Enter") closeAutocomplete();
      }
      if (ev.key === "Enter" && !ev.isComposing) {
        if (ev.ctrlKey || ev.altKey || ev.metaKey) {
          ev.preventDefault();
          insertNewlineAtTextarea($("composer-input"), () => {
            autoResizeComposer();
            saveDraft();
          });
          return;
        }
        if (ev.shiftKey) {
          setTimeout(() => {
            autoResizeComposer();
            saveDraft();
          }, 0);
          return;
        }
        ev.preventDefault();
        sendCurrentMessage();
      }
    });
    $("composer-input").addEventListener("paste", (ev) => {
      const files = Array.from(ev.clipboardData?.files || []);
      if (files.length) {
        ev.preventDefault();
        for (const f of files) uploadChatAttachment(f);
        return;
      }
      const itemFiles = [];
      for (const item of ev.clipboardData?.items || []) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) itemFiles.push(f);
        }
      }
      if (itemFiles.length) {
        ev.preventDefault();
        for (const f of itemFiles) uploadChatAttachment(f);
      }
    });
    $("composer-box").addEventListener("dragover", (e) => { e.preventDefault(); $("composer-box").classList.add("drag-over"); });
    $("composer-box").addEventListener("dragleave", () => $("composer-box").classList.remove("drag-over"));
    $("composer-box").addEventListener("drop", (e) => {
      e.preventDefault();
      $("composer-box").classList.remove("drag-over");
      for (const f of e.dataTransfer?.files || []) uploadChatAttachment(f);
    });
    $("btn-attach-image").addEventListener("click", () => $("file-upload-input").click());
    $("file-upload-input").addEventListener("change", () => {
      for (const f of $("file-upload-input").files || []) uploadChatAttachment(f);
      $("file-upload-input").value = "";
    });
    $("btn-send").addEventListener("click", sendCurrentMessage);
    $("btn-stop").addEventListener("click", () => {
      if (state.activeSessionId && state.wsConnected) state.ws.send(JSON.stringify({ type: "stop_turn", session_id: state.activeSessionId }));
    });

    // Code copy & collapsible long code blocks delegation
    $("messages-container").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".md-code-copy");
      if (btn) {
        copyText(decodeURIComponent(btn.dataset.code || ""), "已复制代码");
        return;
      }
      const toggleBtn = ev.target.closest(".md-code-toggle");
      if (toggleBtn) {
        const block = toggleBtn.closest(".md-code-block");
        if (block) {
          const collapsed = block.classList.toggle("is-collapsed");
          const n = toggleBtn.dataset.lines || "";
          toggleBtn.textContent = collapsed ? `展开全部 ${n} 行代码 ▾` : "收起代码 ▴";
        }
      }
    });

    // Scroll bottom (rAF throttled for 60fps over 4K wallpapers)
    let scrollTicking = false;
    $("messages-scroll").addEventListener("scroll", () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        syncScrollBottomBtn();
      });
    }, { passive: true });
    $("btn-scroll-bottom").addEventListener("click", () => scrollToBottom(true));

    // Drawer
    document.querySelectorAll(".seg-btn[data-tab]").forEach((b) =>
      b.addEventListener("click", () => (state.drawerOpen && state.drawerTab === b.dataset.tab ? closeDrawer() : openDrawer(b.dataset.tab))),
    );
    document.querySelectorAll(".drawer-tab").forEach((b) =>
      b.addEventListener("click", () => { state.drawerTab = b.dataset.tab; syncDrawerTabs(); }),
    );
    $("btn-close-drawer").addEventListener("click", closeDrawer);
    $("outline-filter").addEventListener("input", () => renderOutline(state.activeTimeline?.outline || []));
    $("thread-find-input").addEventListener("input", runThreadFind);

    // Title & Simplified CWD Modal (Native Picker + Custom by Drive)
    $("thread-title").addEventListener("click", () => {
      if (state.activeSessionId) promptRename(state.activeSessionId, $("thread-title").textContent);
    });
    $("cwd-pill").addEventListener("click", openCwdModal);
    $("cwd-drive-select")?.addEventListener("change", updateCustomCwdPreview);
    $("cwd-subpath-input")?.addEventListener("input", updateCustomCwdPreview);
    $("cwd-subpath-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("btn-cwd-create-apply")?.click();
    });
    $("btn-cwd-inline-toggle")?.addEventListener("click", () => {
      const box = $("cwd-inline-explorer");
      if (!box) return;
      if (box.classList.contains("hidden")) {
        loadInlineExplorer(state.activeCwd || state.settings.default_cwd || "", "点击任意文件夹进入，或点击右侧「选择此文件夹」直接设为工作目录：");
      } else {
        box.classList.add("hidden");
      }
    });
    $("btn-cwd-up")?.addEventListener("click", () => {
      if (explorerParentPath) loadInlineExplorer(explorerParentPath);
    });
    $("btn-cwd-pick-current")?.addEventListener("click", () => {
      if (explorerCurrentPath) applyCwd(explorerCurrentPath);
    });
    $("btn-cwd-native").addEventListener("click", async () => {
      const btn = $("btn-cwd-native");
      btn.disabled = true;
      const oldTxt = btn.textContent;
      btn.textContent = "正在唤起本机文件夹选择窗口…";
      try {
        let picked = "";
        let nonInteractive = false;
        let reason = "";
        if (window.opencodeDesktop?.pickDirectory) {
          picked = await window.opencodeDesktop.pickDirectory();
        } else {
          const res = await apiJson("/api/dirs/pick-native", {
            method: "POST",
            body: JSON.stringify({ initial_dir: state.activeCwd || state.settings.default_cwd || "" }),
          });
          picked = res.path || "";
          nonInteractive = Boolean(res.non_interactive);
          reason = res.error || "";
        }
        if (picked) {
          await applyCwd(picked);
        } else if (nonInteractive) {
          toast("当前后台服务处于非交互桌面，已自动展开内置全盘文件夹浏览器", 4200);
          loadInlineExplorer(state.activeCwd || state.settings.default_cwd || "", reason);
        } else {
          toast("已取消选择文件夹");
        }
      } catch (err) {
        toast("打开系统目录选择框失败，已切换至内置文件夹浏览", 3600);
        loadInlineExplorer(state.activeCwd || state.settings.default_cwd || "", err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = oldTxt;
      }
    });
    $("btn-cwd-create-apply")?.addEventListener("click", async () => {
      const drive = $("cwd-drive-select")?.value || "";
      const subpath = ($("cwd-subpath-input")?.value || "").trim();
      try {
        const res = await apiJson("/api/dirs/ensure", {
          method: "POST",
          body: JSON.stringify({ drive, subpath }),
        });
        if (res.ok && res.path) {
          await applyCwd(res.path);
          if (res.created) toast(`已新建并切换到工作目录：${res.path}`);
        }
      } catch (err) {
        toast("设置自定义目录失败: " + err.message, 4000);
      }
    });

    // Providers modal actions & Native Claude Auth
    $("btn-add-provider").addEventListener("click", () => fillProviderForm(null));
    $("pf-kind").addEventListener("change", toggleProviderKindFields);
    $("btn-save-provider").addEventListener("click", saveProviderForm);
    $("btn-activate-provider").addEventListener("click", async () => {
      if (!state.selectedProviderId) return toast("请先保存供应商");
      await apiJson(`/api/providers/${encodeURIComponent(state.selectedProviderId)}/activate`, { method: "POST", body: JSON.stringify({}) });
      openProvidersModal(state.selectedProviderId);
      toast("已切换为当前活跃供应商");
    });
    $("btn-test-provider")?.addEventListener("click", testSelectedProviderConnection);
    $("btn-fetch-models").addEventListener("click", fetchModelsForSelected);
    $("btn-delete-provider").addEventListener("click", async () => {
      if (!state.selectedProviderId || !window.confirm("确定删除该供应商？")) return;
      await apiJson(`/api/providers/${encodeURIComponent(state.selectedProviderId)}`, { method: "DELETE" });
      state.selectedProviderId = null;
      openProvidersModal();
      toast("已删除");
    });
    $("btn-refresh-claude-auth")?.addEventListener("click", async () => {
      toast("正在检测原生 Claude Code 登录状态…");
      const st = await refreshClaudeStatus(true);
      if (st?.auth?.loggedIn) toast("已确认原生 Claude 账号在线！");
      else toast("当前尚未登录官方账号");
    });
    $("btn-claude-auth-login")?.addEventListener("click", () => startClaudeAuthLogin("claudeai"));
    $("btn-claude-auth-console")?.addEventListener("click", () => startClaudeAuthLogin("console"));
    $("btn-claude-auth-submit-code")?.addEventListener("click", submitClaudeAuthCodeInput);
    $("claude-auth-code-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitClaudeAuthCodeInput(); });
    $("btn-claude-auth-logout")?.addEventListener("click", async () => {
      if (!window.confirm("确定退出本机原生 Claude Code 官方账号登录？")) return;
      const res = await apiJson("/api/claude/auth/logout", { method: "POST" });
      if (res.runtime) state.claudeNative = res.runtime;
      renderClaudeStatusViews();
      toast(res.ok ? "已退出原生 Claude 账号" : (res.error || "退出失败"));
    });

    // Stores tabs & live debounced searches + public URL/package importers
    document.querySelectorAll("[data-storetab]").forEach((b) => b.addEventListener("click", () => openStoresModal(b.dataset.storetab)));
    $("btn-search-mcp").addEventListener("click", () => searchMcp($("mcp-search-input").value.trim()));
    $("mcp-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMcp($("mcp-search-input").value.trim()); });
    $("mcp-search-input").addEventListener("input", () => {
      clearTimeout(state.mcpSearchTimer);
      state.mcpSearchTimer = setTimeout(() => searchMcp($("mcp-search-input").value.trim()), 450);
    });
    $("btn-import-mcp")?.addEventListener("click", async () => {
      const raw = window.prompt("粘贴任意公开 MCP（支持远程 HTTP/SSE URL、npm 包名、GitHub 仓库链接或 mcpServers JSON）：");
      if (!raw || !raw.trim()) return;
      toast("正在解析并安装公开 MCP…");
      try {
        const res = await apiJson("/api/mcp/import", { method: "POST", body: JSON.stringify({ input: raw.trim() }) });
        loadInstalledMcps();
        toast(`已成功导入并适配 MCP「${res.item?.name || ""}」！`, 3500);
      } catch (err) {
        toast("导入 MCP 失败: " + err.message, 4500);
      }
    });
    $("btn-custom-mcp").addEventListener("click", async () => {
      const name = window.prompt("MCP 名称（如 my-mcp）：");
      if (!name) return;
      const cmdLine = window.prompt("启动命令或远程 URL（如 npx -y @modelcontextprotocol/server-memory 或 https://...）：");
      if (!cmdLine) return;
      const trimmed = cmdLine.trim();
      const body = /^https?:\/\//i.test(trimmed)
        ? { name, command: /sse/i.test(trimmed) ? "sse" : "http", args: [trimmed], enabled: true }
        : { name, command: trimmed.split(/\s+/)[0], args: trimmed.split(/\s+/).slice(1), enabled: true };
      await apiJson("/api/mcp", { method: "POST", body: JSON.stringify(body) });
      loadInstalledMcps();
      toast("已添加并适配自定义 MCP");
    });

    $("btn-search-skills").addEventListener("click", () => searchSkills($("skills-search-input").value.trim()));
    $("skills-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") searchSkills($("skills-search-input").value.trim()); });
    $("skills-search-input").addEventListener("input", () => {
      clearTimeout(state.skillSearchTimer);
      state.skillSearchTimer = setTimeout(() => searchSkills($("skills-search-input").value.trim()), 450);
    });
    $("btn-import-skill")?.addEventListener("click", async () => {
      const url = window.prompt("粘贴任意公开 GitHub Skill 仓库链接或 SKILL.md 文件链接：");
      if (!url || !url.trim()) return;
      toast("正在拉取并解析公开 Skill…");
      try {
        const res = await apiJson("/api/skills/import-url", { method: "POST", body: JSON.stringify({ url: url.trim() }) });
        loadInstalledSkills();
        toast(`已成功导入并启用 Skill /${res.item?.slug || ""}！`, 3500);
      } catch (err) {
        toast("导入 Skill 失败: " + err.message, 4500);
      }
    });
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

    // Dual Search Engine switcher inside Stores modal (Auto / Domestic Direct / Global Proxy)
    $("store-search-engine")?.addEventListener("change", async () => {
      const mode = $("store-search-engine").value;
      const nextSearch = { ...(state.settings.search_engine || {}), mode };
      state.settings.search_engine = nextSearch;
      apiJson("/api/settings", { method: "PUT", body: JSON.stringify({ search_engine: nextSearch }) }).catch(() => {});
      if (state.activeStoreTab === "mcp") searchMcp($("mcp-search-input").value.trim());
      else if (state.activeStoreTab === "skills") searchSkills($("skills-search-input").value.trim());
      else searchWallpapers($("wp-search-input").value.trim(), 1, false);
    });

    // Appearance & Custom Dialogue Box controls (HD / Subtle / Bordered vs Pure-Text / Independent Alphas)
    $("ap-theme").addEventListener("change", () => updateAppearance({ theme: $("ap-theme").value }));
    $("btn-bgmode-hd")?.addEventListener("click", () => {
      updateAppearance({ bgMode: "hd", bgBlur: 0, bubbleOpacity: 0.68, sidebarOpacity: 0.48 });
      toast("已切换为「高清原版壁纸」模式（0 模糊，两侧栏清透适配）");
    });
    $("btn-bgmode-subtle")?.addEventListener("click", () => {
      updateAppearance({ bgMode: "subtle", bgBlur: 10, bubbleOpacity: 0.88, sidebarOpacity: 0.84 });
      toast("已切换为「隐性护眼背景」模式（柔焦防干扰）");
    });
    $("btn-bubble-card")?.addEventListener("click", () => {
      updateAppearance({ bubbleStyle: "card" });
      toast("对话框样式：有边框卡片（可自由拖动下方透明度滑块）");
    });
    $("btn-bubble-text")?.addEventListener("click", () => {
      updateAppearance({ bubbleStyle: "text" });
      toast("对话框样式：纯文字无边框（直接呈现通透文字）");
    });
    $("ap-fontsize").addEventListener("input", () => updateAppearance({ fontSize: Number($("ap-fontsize").value) }));
    $("ap-blur").addEventListener("input", () => updateAppearance({ bgMode: "subtle", bgBlur: Number($("ap-blur").value) }));
    $("ap-bubble-opacity")?.addEventListener("input", () => {
      const v = Number($("ap-bubble-opacity").value);
      updateAppearance({ bubbleOpacity: v, bgOpacity: v });
    });
    $("ap-sidebar-opacity")?.addEventListener("input", () => {
      updateAppearance({ sidebarOpacity: Number($("ap-sidebar-opacity").value) });
    });
    $("btn-we-launch")?.addEventListener("click", (ev) => {
      // Launch steam:// directly from user's visible browser / Electron shell (NEVER from background Node server!)
      if (window.opencodeDesktop?.openExternal) {
        ev.preventDefault();
        window.opencodeDesktop.openExternal("steam://rungameid/431960");
      }
      toast("正在通过您本机 Steam 打开 Wallpaper Engine（下载视频/网页类型壁纸后，点「刷新」即可在此独立使用）", 4500);
    });
    $("btn-we-authorize-steam")?.addEventListener("click", async () => {
      if (
        !window.confirm(
          "只读授权 OpenCode Studio 扫描本机 Steam Wallpaper Engine (431960) 壁纸目录？\n\n" +
            "• 完全独立于您的 Windows 桌面壁纸：绝不改动、绝不同步、绝不干扰您当前桌面壁纸\n" +
            "• 4K/8K 原版视频（支持几百 MB ~ 数 GB 长动画）与 Web 互动壁纸采用零拷贝流式直出，0 压缩 0 额外占用\n" +
            "• 您随时可以一键撤销授权",
        )
      ) {
        return;
      }
      toast("正在只读扫描 Steam Wallpaper Engine (431960) 壁纸目录…");
      try {
        const res = await apiJson("/api/we/authorize", { method: "POST", body: JSON.stringify({ auto_detect: true }) });
        state.weLibrary = res;
        renderWallpaperEngineSection(res);
        toast(res.message || `已授权，发现 ${res.playable_count || 0} 个可独立播放壁纸`, 4500);
      } catch (err) {
        toast("授权失败: " + err.message, 4200);
      }
    });
    $("btn-we-add-dir")?.addEventListener("click", async () => {
      let dir = "";
      try {
        if (window.opencodeDesktop?.pickDirectory) {
          dir = await window.opencodeDesktop.pickDirectory();
        } else {
          const pick = await apiJson("/api/dirs/pick-native", { method: "POST", body: JSON.stringify({}) });
          if (pick.ok && pick.path) dir = pick.path;
        }
      } catch {}
      if (!dir) {
        dir = window.prompt("请输入要授权的本地 4K 壁纸/视频目录或 Steam 431960 目录路径（零拷贝流式直连，不复制文件）：", "") || "";
      }
      if (!dir.trim()) return;
      try {
        const res = await apiJson("/api/we/authorize", { method: "POST", body: JSON.stringify({ add_dir: dir.trim() }) });
        state.weLibrary = res;
        renderWallpaperEngineSection(res);
        toast(res.message || `已授权目录，共 ${res.count || 0} 个壁纸`, 3800);
      } catch (err) {
        toast("添加壁纸目录失败: " + err.message, 4200);
      }
    });
    $("btn-we-refresh")?.addEventListener("click", async () => {
      toast("正在刷新授权壁纸库…");
      await loadWallpaperEngineLibrary(true);
      toast(`刷新完成，共 ${state.weLibrary?.count || 0} 个壁纸`);
    });
    $("btn-we-toggle-mute")?.addEventListener("click", async () => {
      const curWe = state.settings.wallpaper_engine || { authorized: true, dirs: state.weLibrary?.dirs || [], video_muted: true };
      const nextMuted = !(curWe.video_muted !== false);
      const nextWe = { ...curWe, video_muted: nextMuted };
      state.settings.wallpaper_engine = nextWe;
      if (state.weLibrary) state.weLibrary.video_muted = nextMuted;
      const vid = $("wallpaper-video");
      if (vid) vid.muted = nextMuted;
      renderWallpaperEngineSection(state.weLibrary || nextWe);
      apiJson("/api/settings", { method: "PUT", body: JSON.stringify({ wallpaper_engine: nextWe }) }).catch(() => {});
      toast(nextMuted ? "视频壁纸已静音" : "已开启视频壁纸音频");
    });
    $("btn-we-revoke")?.addEventListener("click", async () => {
      if (!window.confirm("确定撤销所有 Wallpaper Engine / 本地壁纸目录授权？\n撤销后 OpenCode Studio 将不再读取这些目录。")) return;
      const res = await apiJson("/api/we/revoke", { method: "POST", body: JSON.stringify({}) });
      state.weLibrary = res;
      renderWallpaperEngineSection(res);
      toast("已撤销本地壁纸库授权");
    });
    $("btn-wp-clear-cache")?.addEventListener("click", async () => {
      try {
        const res = await apiJson("/api/backgrounds/clear-cache", { method: "POST" });
        if (res.storage) renderWallpaperStorage(res.storage);
        toast(`已清理 ${res.removed || 0} 个预览缓存，释放 ${res.freed_mb || 0} MB（当前生效壁纸与上传壁纸完好保留）`, 3500);
      } catch (err) {
        toast("清理缓存失败: " + err.message);
      }
    });
    $("btn-upload-bg").addEventListener("click", () => $("bg-upload-input").click());
    $("bg-upload-input").addEventListener("change", async () => {
      const file = $("bg-upload-input").files?.[0];
      if (!file) return;
      if (file.size > 50 * 1024 * 1024) {
        $("bg-upload-input").value = "";
        return toast("该视频超过 50MB，请点击上方「📂 添加本地壁纸文件夹」零拷贝直连播放（支持数 GB 4K 长动画，0 硬盘复制！）", 5500);
      }
      toast(`正在上传${file.type.startsWith("video/") ? "动态视频壁纸" : "壁纸"}…`);
      try {
        const dataUrl = await fileToDataUrl(file);
        const res = await apiJson("/api/backgrounds/upload", {
          method: "POST",
          body: JSON.stringify({ name: file.name, media_type: file.type, data: dataUrl }),
        });
        state.customBackgrounds = res.backgrounds || [];
        if (res.storage) renderWallpaperStorage(res.storage);
        const isVideo = Boolean(res.is_video || file.type.startsWith("video/"));
        updateAppearance({ bgType: isVideo ? "video" : "upload", bgUrl: res.background.url, liveBg: "", bgName: res.background.name });
        renderCustomBgs();
        toast(`已上传并应用${isVideo ? "动态视频" : "自定义"}背景`);
      } catch (err) {
        toast("上传失败: " + err.message, 4000);
      } finally {
        $("bg-upload-input").value = "";
      }
    });
    $("btn-search-wp").addEventListener("click", () => {
      searchWallpapers($("wp-search-input").value.trim(), 1, false);
    });
    $("btn-random-wp")?.addEventListener("click", () => applyRandomWallpaper());
    $("wp-search-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        searchWallpapers($("wp-search-input").value.trim(), 1, false);
      }
    });
    $("wp-search-input").addEventListener("input", () => {
      clearTimeout(state.wpSearchTimer);
      state.wpSearchTimer = setTimeout(() => {
        searchWallpapers($("wp-search-input").value.trim(), 1, false);
      }, 450);
    });
    document.querySelectorAll(".wp-cat").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".wp-cat").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        if (btn.dataset.q) {
          state.wpCategory = "all";
          $("wp-search-input").value = btn.dataset.q;
          searchWallpapers(btn.dataset.q, 1, false);
        } else {
          state.wpCategory = btn.dataset.cat || "all";
          $("wp-search-input").value = "";
          searchWallpapers("", 1, false);
        }
      });
    });
    $("btn-wp-load-more")?.addEventListener("click", () => {
      if (!state.wpHasMore) return;
      searchWallpapers($("wp-search-input").value.trim(), state.wpPage + 1, true);
    });

    // Settings, Claude Code Core Detector & Safe Switcher + Shell Updater
    $("set-system-prompt")?.addEventListener("input", schedulePromptAutoSave);
    $("set-prompt-mode")?.addEventListener("change", () => flushPromptAutoSave(false));
    document.querySelectorAll(".prompt-preset").forEach((b) =>
      b.addEventListener("click", () => {
        $("set-system-prompt").value = PROMPT_PRESETS[b.dataset.preset] || "";
        flushPromptAutoSave(false);
      }),
    );
    // Copyable proxy presets & quick copy/clear buttons
    document.querySelectorAll(".copyable-proxy").forEach((el) => {
      el.addEventListener("click", () => {
        const val = el.dataset.proxy || el.textContent.trim();
        if (!val) return;
        const inp = $("set-search-proxy");
        if (inp) inp.value = val;
        copyText(val, `已复制并填入代理地址：${val}（记得点下方保存设置）`);
      });
    });
    $("btn-copy-proxy")?.addEventListener("click", () => {
      const val = ($("set-search-proxy")?.value || "").trim() || "http://127.0.0.1:7897";
      copyText(val, `已复制代理地址：${val}`);
    });
    $("btn-clear-proxy")?.addEventListener("click", () => {
      const inp = $("set-search-proxy");
      if (inp) inp.value = "";
      toast("已清空代理地址（点击保存设置生效）");
    });

    $("btn-save-settings").addEventListener("click", async () => {
      const btn = $("btn-save-settings");
      clearTimeout(promptSaveTimer);
      promptSaveTimer = null;
      const oldTxt = btn.textContent;
      btn.disabled = true;
      btn.textContent = "保存中…";
      setPromptSaveBadge("saving", "保存中…");
      try {
        const searchMode = $("set-search-mode")?.value || state.settings.search_engine?.mode || "auto";
        const searchProxy = ($("set-search-proxy")?.value || "").trim();
        const claudeIsolation = $("set-claude-isolation")?.value || state.settings.claude_isolation || "isolated";
        const webSearchEnabled = ($("set-web-search")?.value || "on") !== "off";
        const res = await apiJson("/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            system_prompt: $("set-system-prompt").value,
            prompt_mode: $("set-prompt-mode")?.value || "replace",
            permission_mode: $("set-permission-mode").value,
            web_search_enabled: webSearchEnabled,
            claude_isolation: claudeIsolation,
            search_engine: { ...(state.settings.search_engine || {}), mode: searchMode, proxy_url: searchProxy },
            default_cwd: $("set-default-cwd").value.trim(),
            update_channel: "latest",
          }),
        });
        state.settings = res.settings;
        state._promptDirty = false;
        setPromptSaveBadge("ok", "● 已保存");
        if (res.claude_native) {
          state.claudeNative = res.claude_native;
          renderClaudeStatusViews();
        }
        if ($("store-search-engine")) $("store-search-engine").value = searchMode;
        updateThinkingSelector();
        toast("设置与自定义提示词已保存并立即生效");
      } catch (err) {
        setPromptSaveBadge("err", "保存失败");
        toast("保存设置失败: " + err.message, 4200);
      } finally {
        btn.disabled = false;
        btn.textContent = oldTxt;
      }
    });
    $("btn-cleanup-legacy")?.addEventListener("click", runLegacyCleanup);
    $("btn-db-optimize")?.addEventListener("click", () => runDatabaseMaintenance(false));
    $("btn-db-purge-archived")?.addEventListener("click", () => runDatabaseMaintenance(true));
    $("btn-claude-reset-bundled")?.addEventListener("click", resetToBundledClaudeCore);
    $("btn-claude-check-ver")?.addEventListener("click", checkClaudeCoreVersions);
    $("btn-claude-install-stable")?.addEventListener("click", () => installOrSwitchClaudeCore("stable"));
    $("btn-claude-install-latest")?.addEventListener("click", () => installOrSwitchClaudeCore("latest"));
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
      closeModal("modal-confirm");
    });
    $("btn-confirm-deny").addEventListener("click", () => {
      if (state.activeConfirmId && state.wsConnected) {
        state.ws.send(JSON.stringify({ type: "confirm_response", confirm_id: state.activeConfirmId, approved: false }));
      }
      state.activeConfirmId = null;
      closeModal("modal-confirm");
    });

    // Close modals (delegated + Esc, with smooth exit animation)
    document.addEventListener("click", (ev) => {
      const closeBtn = ev.target.closest(".modal-close");
      if (closeBtn) {
        const targetId = closeBtn.getAttribute("data-close");
        if (targetId) closeModal(targetId);
        else closeModal(closeBtn.closest(".modal-backdrop"));
      }
    });
    document.querySelectorAll(".modal-backdrop").forEach((bd) =>
      bd.addEventListener("click", (e) => { if (e.target === bd && bd.id !== "modal-confirm") closeModal(bd); }),
    );
    $("lightbox").addEventListener("click", () => closeModal("lightbox"));

    // Shortcuts
    window.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        $("sidebar")?.classList.remove("collapsed");
        $("btn-expand-sidebar")?.classList.add("hidden");
        const gs = $("global-search-input");
        gs?.focus();
        gs?.select();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f" && state.activeTimeline) {
        ev.preventDefault();
        openDrawer("find");
      } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "o") {
        ev.preventDefault();
        startNewSession();
      } else if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.key.toLowerCase() === "w") {
        ev.preventDefault();
        toggleZenWallpaperMode();
      } else if (ev.key === "Escape") {
        if (state.zenMode) {
          toggleZenWallpaperMode(false);
          return;
        }
        closeModal("lightbox");
        closeAllGlassDropdowns();
        closeAutocomplete();
        document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach((bd) => {
          if (bd.id !== "modal-confirm") closeModal(bd);
        });
      }
    });
    window.addEventListener("message", (ev) => {
      if (ev.origin === location.origin && ev.data?.type === "ocs_zen_exit") {
        toggleZenWallpaperMode(false);
      }
    });
  }

  // ==================== BOOTSTRAP (PARALLEL ZERO-WAIT INIT) ====================

  async function init() {
    bindEvents();
    connectWs();

    const [boot] = await Promise.all([
      apiJson("/api/bootstrap"),
      refreshSessions().catch(() => {}),
    ]);
    state.version = boot.version || "1.0.0";
    state.settings = boot.settings || {};
    state.providers = boot.providers || [];
    state.activeProvider = boot.active_provider;
    state.claudeNative = boot.claude_native;
    state.installedMcps = boot.installed_mcps || [];
    state.installedSkills = boot.installed_skills || [];
    state.customBackgrounds = boot.custom_backgrounds || [];
    if (boot.wallpaper_storage) renderWallpaperStorage(boot.wallpaper_storage);
    if (boot.db_stats) renderDbStats(boot.db_stats);
    state.activeCwd = state.settings.default_cwd || "";

    $("app-version-badge").textContent = `v${state.version} · 开源透明`;
    $("cwd-pill-text").textContent = state.activeCwd || "选择目录";

    applyAppearance(state.settings.appearance || {});
    syncWebSearchToggle();
    syncFavoriteCountBadge();
    renderComposerSelectors();
    renderClaudeStatusViews();
    syncWelcomeResumePill();
    restoreDraft();
    $("composer-input").focus();
  }

  init().catch((err) => toast("初始化失败: " + err.message, 5000));
})();
