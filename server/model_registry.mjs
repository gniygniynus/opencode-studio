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

export const THINKING_BUDGETS = {
  off: 0,
  low: 4000,
  medium: 10000,
  high: 24000,
  max: 48000,
};

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

  // --- Claude family ---
  if (/claude|sonnet|opus|haiku/.test(low)) {
    cap.family = "claude";
    cap.vision = true;
    const isLegacyHaiku = /haiku-3(?:\.5)?|claude-3-haiku|claude-3-5-haiku/.test(low);
    const is35Sonnet = /claude-3-5-sonnet|3\.5-sonnet/.test(low);
    cap.context_window = explicitCtx || (/4-6|4\.6|1m/.test(low) ? 1_000_000 : 200_000);
    if (!isLegacyHaiku && !is35Sonnet) {
      cap.thinking_supported = true;
      cap.thinking_mode = providerKind === "openai" ? "openai_effort" : "anthropic_budget";
      cap.thinking_levels =
        cap.thinking_mode === "anthropic_budget"
          ? ["off", "low", "medium", "high", "max"]
          : ["off", "low", "medium", "high"];
      cap.default_thinking = /thinking|opus/.test(low) ? "high" : "medium";
    }
  }
  // --- OpenAI o-series / GPT-5 / Codex ---
  else if (/\b(o1|o3|o4)\b|^o[134]-|gpt-5|codex/.test(low)) {
    cap.family = "openai-reasoning";
    cap.vision = true;
    cap.context_window = explicitCtx || (/gpt-5/.test(low) ? 400_000 : 200_000);
    cap.thinking_supported = true;
    cap.thinking_mode = "openai_effort";
    cap.thinking_levels = /gpt-5|codex/.test(low) ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"];
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
  // --- DeepSeek family ---
  else if (/deepseek/.test(low)) {
    cap.family = "deepseek";
    cap.vision = /vl|v4/.test(low);
    cap.context_window = explicitCtx || (/v4/.test(low) ? 256_000 : 128_000);
    if (/r1|reasoner|think|v3\.2|v4/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = providerKind === "anthropic" ? "anthropic_budget" : "toggle";
      cap.thinking_levels =
        cap.thinking_mode === "anthropic_budget" ? ["off", "low", "medium", "high"] : ["off", "on"];
      cap.default_thinking = /r1|reasoner|think/.test(low) ? (cap.thinking_mode === "toggle" ? "on" : "high") : "off";
    }
  }
  // --- Gemini family ---
  else if (/gemini/.test(low)) {
    cap.family = "gemini";
    cap.vision = true;
    cap.context_window = explicitCtx || 1_000_000;
    if (/2\.5|3|4|thinking|pro/.test(low) && !/1\.5/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = "openai_effort";
      cap.thinking_levels = ["off", "low", "medium", "high"];
      cap.default_thinking = "medium";
    }
  }
  // --- Grok family ---
  else if (/grok/.test(low)) {
    cap.family = "grok";
    cap.vision = true;
    cap.context_window = explicitCtx || (/4\./.test(low) ? 240_000 : 131_072);
    if (/grok-3-mini|grok-4|think|reason/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = providerKind === "anthropic" ? "anthropic_budget" : "openai_effort";
      cap.thinking_levels = ["off", "low", "medium", "high"];
      cap.default_thinking = "medium";
    }
  }
  // --- Qwen / QwQ / GLM / Kimi / MiniMax ---
  else if (/qwq|qwen3|qwen-3/.test(low)) {
    cap.family = "qwen";
    cap.vision = /vl/.test(low);
    cap.context_window = explicitCtx || 131_072;
    cap.thinking_supported = true;
    cap.thinking_mode = "toggle";
    cap.thinking_levels = ["off", "on"];
    cap.default_thinking = /qwq|thinking/.test(low) ? "on" : "off";
  } else if (/glm-4\.5|glm-4\.6|glm-5|kimi-k2|minimax/.test(low)) {
    cap.family = "cn-flagship";
    cap.vision = /v|vision|4\.5v|5/.test(low);
    cap.context_window = explicitCtx || 200_000;
    if (/think|glm-4\.5|glm-5|k2-thinking/.test(low)) {
      cap.thinking_supported = true;
      cap.thinking_mode = "toggle";
      cap.thinking_levels = ["off", "on"];
      cap.default_thinking = /think/.test(low) ? "on" : "off";
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
    if (params.includes("reasoning") || params.includes("include_reasoning")) {
      cap.thinking_supported = true;
      if (cap.thinking_mode === "none") {
        cap.thinking_mode = "openai_effort";
        cap.thinking_levels = ["off", "low", "medium", "high"];
        cap.default_thinking = "medium";
      }
      cap.source = "provider-api";
    }
    const archMod = String(remoteMeta.architecture?.modality || "").toLowerCase();
    if (archMod.includes("image")) cap.vision = true;
  }

  // User manual overrides take highest precedence
  if (userOverride && typeof userOverride === "object") {
    if (typeof userOverride.thinking_supported === "boolean") cap.thinking_supported = userOverride.thinking_supported;
    if (userOverride.thinking_mode) cap.thinking_mode = userOverride.thinking_mode;
    if (Array.isArray(userOverride.thinking_levels) && userOverride.thinking_levels.length) {
      cap.thinking_levels = userOverride.thinking_levels;
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
  }
  if (clean.endsWith("/v1")) {
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
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    const rawList = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const models = [];
    const capabilities = [];
    const seen = new Set();

    for (const item of rawList) {
      const id = typeof item === "string" ? item : item?.id || item?.name;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
      capabilities.push(
        detectModelCapabilities(id, provider.kind, typeof item === "object" ? item : null, provider.model_overrides?.[id]),
      );
    }

    models.sort((a, b) => a.localeCompare(b));
    logEvent("INFO", "models", "fetched", `从 ${provider.name} 拉取到 ${models.length} 个模型`);
    return { ok: true, models, capabilities, endpoint: url };
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
  const modelInfos = allIds.map((m) =>
    detectModelCapabilities(m, provider.kind, null, provider.model_overrides?.[m]),
  );
  return {
    ...provider,
    model_infos: modelInfos,
  };
}
