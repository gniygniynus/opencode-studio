/**
 * Model capability auto-detection & provider discovery engine.
 *
 * Automatically identifies for any model ID:
 *   - thinking_supported (boolean)
 *   - thinking_mode: "none" | "anthropic_budget" | "openai_effort" | "toggle"
 *   - thinking_levels: list of UI selectable levels (e.g. ["off","low","medium","high","max"])
 *   - context_window: token window size (e.g. 128000, 200000, 240000, 1000000)
 *   - vision: whether image inputs are supported
 *   - display_name: clean display name shown directly in chat composer
 */

import { logEvent } from "./logger.mjs";
import { fetchUpstreamWithSafeRedirects } from "./security.mjs";

export const THINKING_BUDGETS = {
  off: 0,
  on: 12000,
  low: 4000,
  medium: 10000,
  high: 24000,
  xhigh: 36000,
  max: 56000,
};

const CJK_CHAR_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g;

/**
 * Fast, language-aware token estimator (~1.25 tokens per CJK character, ~3.8 chars per ASCII/code token).
 */
export function estimateTextTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  const cjkMatches = s.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherLen = Math.max(0, s.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 1.25 + otherLen / 3.8));
}

function parseExplicitContext(modelId) {
  const m = String(modelId || "").match(/\[(\d+(?:\.\d+)?)\s*([kKmM])\]/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return unit === "m" ? Math.round(num * 1_000_000) : Math.round(num * 1_000);
}

export function cleanModelDisplayName(modelId) {
  return String(modelId || "").replace(/\[[^\]]*\]$/, "").trim();
}

/**
 * Auto-detect capabilities of a model from its ID + provider kind + optional remote metadata & user overrides.
 */
export function detectModelCapabilities(modelId, providerKind = "openai", remoteMeta = null, userOverride = null) {
  const id = String(modelId || "").trim();
  const low = id.toLowerCase();
  const explicitCtx = parseExplicitContext(id);

  let cap = {
    id,
    display_name: cleanModelDisplayName(id) || id,
    thinking_supported: false,
    thinking_mode: "none",       // none | anthropic_budget | openai_effort | toggle
    thinking_levels: [],
    default_thinking: "off",
    context_window: explicitCtx || 128_000,
    vision: false,
    family: "generic",
    source: "heuristic",
  };

  // --- Claude family (Anthropic 3.7 / 4 / 4.5 / 4.6 / 4.7) ---
  if (/claude|sonnet|opus|haiku/.test(low)) {
    cap.family = "claude";
    cap.vision = true;
    const isLegacyNoThink =
      /claude-3-haiku|claude-3-5-haiku|3\.5-haiku|claude-3-5-sonnet|3\.5-sonnet|claude-3-opus|claude-2/.test(low);
    const is47Opus = /opus[-_.]?4[-_.]?7|4[-_.]?7[-_.]?opus/.test(low);
    const is46OrNewer = /4[-_.]?[6789]|1m/.test(low);
    cap.context_window = explicitCtx || (is46OrNewer ? 1_000_000 : 200_000);
    if (!isLegacyNoThink) {
      cap.thinking_supported = true;
      cap.thinking_mode = providerKind === "openai" ? "openai_effort" : "anthropic_budget";
      cap.thinking_levels = is47Opus
        ? ["off", "low", "medium", "high", "xhigh", "max"]
        : ["off", "low", "medium", "high", "max"];
      cap.default_thinking = /thinking|opus/.test(low) ? "high" : "medium";
    }
  }
  // --- OpenAI o-series / GPT-5+ / Codex ---
  else if (/\b(o1|o3|o4)\b|^o[134]-|\/o[134](?:-|$)|gpt-[5-9]|codex/.test(low)) {
    cap.family = "openai-reasoning";
    cap.vision = !/o3-mini|o1-mini/.test(low);
    cap.context_window = explicitCtx || (/gpt-[5-9]|codex/.test(low) ? 400_000 : 200_000);
    cap.thinking_supported = true;
    cap.thinking_mode = "openai_effort";
    if (/gpt-[6-9]|gpt-5\.[12345]|gpt-5-codex|codex/.test(low)) {
      cap.thinking_levels = ["off", "low", "medium", "high", "xhigh"];
    } else if (/gpt-5/.test(low)) {
      cap.thinking_levels = ["low", "medium", "high", "xhigh"];
    } else {
      cap.thinking_levels = ["low", "medium", "high"];
    }
    cap.default_thinking = "medium";
  }
  // --- OpenAI GPT-4o / 4.1 ---
  else if (/gpt-4\.1/.test(low)) {
    cap.family = "openai-gpt4";
    cap.vision = true;
    cap.context_window = explicitCtx || 1_000_000;
  } else if (/gpt-4o|gpt-4-turbo|gpt-4/.test(low)) {
    cap.family = "openai-gpt4";
    cap.vision = true;
    cap.context_window = explicitCtx || 128_000;
  }
  // --- DeepSeek family (R1 / Reasoner / V3.1 / V3.2 / V4) ---
  else if (/deepseek/.test(low)) {
    cap.family = "deepseek";
    cap.vision = /vl|v4/.test(low);
    cap.context_window = explicitCtx || (/v4/.test(low) ? 256_000 : 128_000);
    if (/r1|reasoner|think|v3\.1|v3\.2|v4/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = "toggle";
      cap.thinking_levels = ["off", "on"];
      cap.default_thinking = /r1|reasoner|think/.test(low) ? "on" : "off";
    }
  }
  // --- Gemini family (2.5 / 3 / Thinking) ---
  else if (/gemini/.test(low)) {
    cap.family = "gemini";
    cap.vision = true;
    cap.context_window = explicitCtx || 1_000_000;
    const isThinkingGemini = /2\.5|gemini-3|gemini-4|thinking/.test(low) && !/1\.5|2\.0-flash(?!-thinking)/.test(low);
    if (isThinkingGemini) {
      cap.thinking_supported = true;
      cap.thinking_mode = "openai_effort";
      cap.thinking_levels = /flash/.test(low) ? ["off", "low", "medium", "high"] : ["low", "medium", "high"];
      cap.default_thinking = "medium";
    }
  }
  // --- Grok family ---
  else if (/grok/.test(low)) {
    cap.family = "grok";
    cap.vision = true;
    cap.context_window = explicitCtx || (/grok-4/.test(low) ? 256_000 : 131_072);
    if (/grok-3-mini|grok-4|think|reason/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = "openai_effort";
      cap.thinking_levels = /grok-3-mini/.test(low) ? ["low", "high"] : ["off", "low", "medium", "high"];
      cap.default_thinking = "medium";
    }
  }
  // --- Qwen / QwQ ---
  else if (/qwq|qwen3|qwen-3|qwen2\.5-thinking/.test(low)) {
    cap.family = "qwen";
    cap.vision = /vl|omni/.test(low);
    cap.context_window = explicitCtx || (/qwen3|qwen-3/.test(low) ? 256_000 : 131_072);
    cap.thinking_supported = true;
    cap.thinking_mode = "toggle";
    cap.thinking_levels = ["off", "on"];
    cap.default_thinking = /qwq|thinking/.test(low) ? "on" : "off";
  }
  // --- Doubao Seed (1.5 / 1.6 thinking levels) ---
  else if (/doubao|seed-1/.test(low)) {
    cap.family = "cn-flagship";
    cap.vision = /vision|seed-1\.6|1\.6|2\.0/.test(low);
    cap.context_window = explicitCtx || 256_000;
    if (/thinking|seed-1\.[56]|seed-2/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = "openai_effort";
      cap.thinking_levels = ["off", "low", "medium", "high"];
      cap.default_thinking = "medium";
    }
  }
  // --- GLM / Kimi / MiniMax / Step / Hunyuan ---
  else if (/glm-4\.5|glm-4\.6|glm-5|kimi-k2|minimax-m|step-r|hunyuan-t1/.test(low)) {
    cap.family = "cn-flagship";
    cap.vision = /(?:^|[-_./])(?:vl|vision|4\.5v|4\.6v|glm-5v)(?:$|[-_.\[])|kimi-k2\.5/.test(low);
    cap.context_window = explicitCtx || 200_000;
    if (/think|glm-4\.[56]|glm-5|kimi-k2|minimax-m|step-r|t1/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = "toggle";
      cap.thinking_levels = ["off", "on"];
      cap.default_thinking = /think|step-r|t1/.test(low) ? "on" : "off";
    }
  } else if (/think|reason|r1/.test(low)) {
    cap.thinking_supported = true;
    cap.thinking_mode = "toggle";
    cap.thinking_levels = ["off", "on"];
    cap.default_thinking = "on";
  }

  // Merge metadata returned by /v1/models (OpenRouter / NewAPI / LiteLLM / Anthropic)
  if (remoteMeta && typeof remoteMeta === "object") {
    const remoteCtx =
      Number(remoteMeta.context_length || remoteMeta.max_context_tokens || remoteMeta.input_token_limit || 0);
    if (remoteCtx >= 4096 && !explicitCtx) {
      cap.context_window = remoteCtx;
      cap.source = "provider-api";
    }
    const params = Array.isArray(remoteMeta.supported_parameters) ? remoteMeta.supported_parameters : [];
    const efforts = Array.isArray(remoteMeta.reasoning_efforts) ? remoteMeta.reasoning_efforts : [];
    if (efforts.length) {
      cap.thinking_supported = true;
      cap.thinking_mode = "openai_effort";
      cap.thinking_levels = efforts;
      cap.source = "provider-api";
    } else if (params.includes("reasoning") || params.includes("include_reasoning") || params.includes("reasoning_effort")) {
      cap.thinking_supported = true;
      if (cap.thinking_mode === "none") {
        cap.thinking_mode = "openai_effort";
        cap.thinking_levels = ["off", "low", "medium", "high"];
        cap.default_thinking = "medium";
      }
      cap.source = "provider-api";
    }
    const archMod = String(remoteMeta.architecture?.modality || "").toLowerCase();
    if (archMod.includes("image") || remoteMeta.vision === true) cap.vision = true;
  }

  // User manual overrides take highest precedence
  if (userOverride && typeof userOverride === "object") {
    if (typeof userOverride.thinking_supported === "boolean") cap.thinking_supported = userOverride.thinking_supported;
    if (userOverride.thinking_mode) cap.thinking_mode = userOverride.thinking_mode;
    if (Array.isArray(userOverride.thinking_levels) && userOverride.thinking_levels.length) {
      cap.thinking_levels = userOverride.thinking_levels;
    }
    if (cap.thinking_supported) {
      if (cap.thinking_mode === "none") cap.thinking_mode = "toggle";
      if (!cap.thinking_levels.length) cap.thinking_levels = ["off", "on"];
      if (!cap.default_thinking || cap.default_thinking === "off") {
        cap.default_thinking = cap.thinking_levels.find((l) => l !== "off") || "on";
      }
    }
    if (Number(userOverride.context_window) > 0) cap.context_window = Number(userOverride.context_window);
    if (typeof userOverride.vision === "boolean") cap.vision = userOverride.vision;
    cap.source = "manual-override";
  }

  return cap;
}

export function buildApiEndpoint(baseUrl, kind, suffix) {
  let clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) {
    clean = kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
  } else if (!/^https?:\/\//i.test(clean)) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(clean);
    clean = `${isLocal ? "http" : "https"}://${clean}`;
  }
  // Strip accidentally pasted endpoint tails (e.g. `.../v1/chat/completions`, `.../v1/messages`, `.../v1/models`)
  clean = clean
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/messages\/count_tokens$/i, "")
    .replace(/\/messages$/i, "")
    .replace(/\/models$/i, "")
    .replace(/\/+$/, "");

  if (/\/v\d+(?:beta\d*)?$/i.test(clean)) {
    return `${clean}${suffix}`;
  }
  return `${clean}/v1${suffix}`;
}

/**
 * Fetch available models from a provider's /v1/models endpoint and enrich each with detected capabilities.
 */
export async function fetchProviderModels(provider) {
  if (provider.kind === "claude_native") {
    const nativeModels = provider.models?.length ? provider.models : ["sonnet", "opus", "haiku"];
    return {
      ok: true,
      models: nativeModels,
      capabilities: nativeModels.map((m) =>
        detectModelCapabilities(m, "anthropic", null, provider.model_overrides?.[m]),
      ),
      message: "Claude 原生登录模式使用官方订阅模型档位（sonnet / opus / haiku）。",
    };
  }

  const url = buildApiEndpoint(provider.base_url, provider.kind, "/models");
  const headers = { Accept: "application/json" };
  if (provider.kind === "anthropic") {
    if (provider.api_key) {
      headers["x-api-key"] = provider.api_key;
      headers["Authorization"] = `Bearer ${provider.api_key}`;
    }
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider.api_key) {
    headers["Authorization"] = `Bearer ${provider.api_key}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetchUpstreamWithSafeRedirects(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const models = [];
    const capabilities = [];
    const remoteMetaMap = {};
    const seen = new Set();

    for (const item of rawList) {
      const id = typeof item === "string" ? item : item?.id || item?.name;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
      if (item && typeof item === "object") {
        const slim = {};
        if (item.context_length || item.max_context_tokens || item.input_token_limit) {
          slim.context_length = Number(item.context_length || item.max_context_tokens || item.input_token_limit);
        }
        if (Array.isArray(item.supported_parameters) && item.supported_parameters.length) {
          slim.supported_parameters = item.supported_parameters.slice(0, 24);
        }
        if (Array.isArray(item.reasoning_efforts) && item.reasoning_efforts.length) {
          slim.reasoning_efforts = item.reasoning_efforts.slice(0, 8);
        }
        if (item.architecture?.modality) slim.architecture = { modality: item.architecture.modality };
        if (typeof item.vision === "boolean") slim.vision = item.vision;
        if (Object.keys(slim).length) remoteMetaMap[id] = slim;
      }
      capabilities.push(
        detectModelCapabilities(id, provider.kind, typeof item === "object" ? item : null, provider.model_overrides?.[id]),
      );
    }

    models.sort((a, b) => a.localeCompare(b));
    logEvent("INFO", "models", "fetched", `从 ${provider.name} 拉取到 ${models.length} 个模型`);
    return { ok: true, models, capabilities, remote_meta: remoteMetaMap, endpoint: url };
  } catch (err) {
    logEvent("WARN", "models", "fetch_failed", `拉取 ${provider.name} 模型列表失败: ${err.message}`);
    return { ok: false, error: err.message, endpoint: url, models: [], capabilities: [] };
  } finally {
    clearTimeout(timer);
  }
}

export function enrichProviderForClient(provider) {
  if (!provider) return null;
  const models = Array.isArray(provider.models) ? provider.models : [];
  const allIds = [...new Set([...(provider.default_model ? [provider.default_model] : []), ...models])];
  const remoteMetaMap = provider.extra?.remote_meta || {};
  const modelInfos = allIds.map((m) =>
    detectModelCapabilities(m, provider.kind, remoteMetaMap[m] || null, provider.model_overrides?.[m]),
  );
  return {
    ...provider,
    model_infos: modelInfos,
  };
}

/**
 * Live connectivity & latency probe for a provider configuration.
 */
export async function testProviderConnection(provider) {
  const t0 = performance.now();
  const model =
    String(provider.default_model || provider.models?.[0] || "").trim() ||
    (provider.kind === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini");

  if (!provider.api_key && !provider.base_url) {
    return { ok: false, error: "请先填写 Base URL 或 API Key", latency_ms: 0, model };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14000);

  try {
    if (provider.kind === "anthropic") {
      const url = buildApiEndpoint(provider.base_url, "anthropic", "/messages");
      const headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      if (provider.api_key) {
        headers["x-api-key"] = provider.api_key;
        headers["Authorization"] = `Bearer ${provider.api_key}`;
      }
      const res = await fetchUpstreamWithSafeRedirects(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 8,
          stream: false,
          messages: [{ role: "user", content: "Reply OK" }],
        }),
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - t0);
      const raw = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          latency_ms: latencyMs,
          model,
          endpoint: url,
          error: `HTTP ${res.status}: ${raw.slice(0, 260)}`,
        };
      }
      return {
        ok: true,
        status: res.status,
        latency_ms: latencyMs,
        model,
        endpoint: url,
        message: `连接正常（${model} · 响应耗时 ${latencyMs} ms）`,
      };
    }

    // OpenAI-compatible protocol probe (auto-retries with stream:true if relay requires streaming)
    const url = buildApiEndpoint(provider.base_url, "openai", "/chat/completions");
    const headers = { "Content-Type": "application/json" };
    if (provider.api_key) headers["Authorization"] = `Bearer ${provider.api_key}`;

    let res = await fetchUpstreamWithSafeRedirects(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 8,
        stream: false,
        messages: [{ role: "user", content: "Reply OK" }],
      }),
      signal: controller.signal,
    });

    if (res.status === 400 || res.status === 422) {
      const retryRes = await fetchUpstreamWithSafeRedirects(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 8,
          stream: true,
          messages: [{ role: "user", content: "Reply OK" }],
        }),
        signal: controller.signal,
      });
      if (retryRes.ok) {
        try { await res.body?.cancel(); } catch {}
        res = retryRes;
      } else {
        try { await retryRes.body?.cancel(); } catch {}
      }
    }

    const latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      const raw = await res.text();
      return {
        ok: false,
        status: res.status,
        latency_ms: latencyMs,
        model,
        endpoint: url,
        error: `HTTP ${res.status}: ${raw.slice(0, 260)}`,
      };
    }
    // Drain/cancel body cleanly
    try {
      await res.body?.cancel();
    } catch {}
    return {
      ok: true,
      status: res.status,
      latency_ms: latencyMs,
      model,
      endpoint: url,
      message: `连接正常（${model} · 首包响应 ${latencyMs} ms）`,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - t0);
    return {
      ok: false,
      latency_ms: latencyMs,
      model,
      error: err.name === "AbortError" ? "请求超时（14s 无响应，请检查地址或网络）" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
