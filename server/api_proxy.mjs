/**
 * Built-in local transparent API proxy & Anthropic <-> OpenAI SSE protocol bridge.
 *
 * Allows the REAL native Claude Code CLI to talk seamlessly to:
 *   - Any Anthropic-protocol API provider (direct passthrough)
 *   - Any OpenAI-compatible API provider (DeepSeek, OpenRouter, Grok, SiliconFlow, Ollama, etc.)
 *     with full streaming text, thinking/reasoning, tool_use, and vision image translation!
 *
 * Completely replaces external switchers (like CC Switch) without touching ~/.claude/settings.json.
 */

import { getProvider } from "./db.mjs";
import { logEvent } from "./logger.mjs";
import { buildApiEndpoint, detectModelCapabilities } from "./model_registry.mjs";

function sendSse(res, eventName, dataObj) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
}

function anthropicToOpenAiBody(antBody, provider, thinkingHint = "") {
  let model = antBody.model || provider.default_model || "";
  // If Claude Code internally issues an auxiliary request for a haiku/claude model that this
  // OpenAI-compatible provider doesn't host, cleanly fall back to the provider's selected default model.
  if (
    provider.default_model &&
    Array.isArray(provider.models) &&
    provider.models.length > 0 &&
    !provider.models.includes(model)
  ) {
    model = provider.default_model;
  }
  const cap = detectModelCapabilities(
    model,
    "openai",
    provider.extra?.remote_meta?.[model] || null,
    provider.model_overrides?.[model],
  );
  const messages = [];

  // System prompt (string or block array) — strip Claude's internal billing header lines
  const cleanSys = (txt) =>
    String(txt || "")
      .split(/\r?\n/)
      .filter((line) => !/^x-anthropic-billing-header:/i.test(line.trim()))
      .join("\n")
      .trim();

  if (typeof antBody.system === "string" && antBody.system.trim()) {
    const s = cleanSys(antBody.system);
    if (s) messages.push({ role: "system", content: s });
  } else if (Array.isArray(antBody.system)) {
    const sysText = antBody.system
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .map(cleanSys)
      .filter(Boolean)
      .join("\n\n");
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  // Convert Anthropic messages -> OpenAI messages
  for (const m of antBody.messages || []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (m.role === "user") {
      const toolResults = m.content.filter((b) => b?.type === "tool_result");
      const otherBlocks = m.content.filter((b) => b?.type !== "tool_result");

      for (const tr of toolResults) {
        let contentStr = "";
        if (typeof tr.content === "string") contentStr = tr.content;
        else if (Array.isArray(tr.content)) {
          contentStr = tr.content
            .map((x) => (x?.type === "text" ? x.text : JSON.stringify(x)))
            .join("\n");
        } else if (tr.content != null) {
          contentStr = JSON.stringify(tr.content);
        }
        messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id || "call_0",
          content: contentStr || "(empty)",
        });
      }

      if (otherBlocks.length) {
        const parts = [];
        for (const b of otherBlocks) {
          if (b.type === "text" && b.text) {
            parts.push({ type: "text", text: b.text });
          } else if (b.type === "image" && b.source?.type === "base64" && b.source?.data) {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${b.source.media_type || "image/png"};base64,${b.source.data}` },
            });
          }
        }
        if (parts.length === 1 && parts[0].type === "text") {
          messages.push({ role: "user", content: parts[0].text });
        } else if (parts.length) {
          messages.push({ role: "user", content: parts });
        }
      }
    } else if (m.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const b of m.content) {
        if (b?.type === "text" && b.text) textParts.push(b.text);
        else if (b?.type === "tool_use") {
          toolCalls.push({
            id: b.id || `call_${toolCalls.length}`,
            type: "function",
            function: {
              name: b.name,
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
            },
          });
        }
      }
      const msg = { role: "assistant", content: textParts.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const out = {
    model,
    messages,
    stream: Boolean(antBody.stream),
  };
  if (antBody.max_tokens) out.max_tokens = Math.min(Number(antBody.max_tokens) || 8192, 32768);
  if (antBody.temperature !== undefined && !antBody.thinking) out.temperature = antBody.temperature;
  if (out.stream) out.stream_options = { include_usage: true };

  if (Array.isArray(antBody.tools) && antBody.tools.length) {
    out.tools = antBody.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || t.name,
          parameters: t.input_schema || { type: "object", properties: {} },
        },
      }));
  }

  // Forward thinking intent accurately based on UI-selected thinkingHint & model capability
  if (cap.thinking_supported) {
    const lvl = thinkingHint && thinkingHint !== "auto" ? thinkingHint : "";
    if (lvl === "off") {
      if (cap.thinking_mode === "toggle") {
        out.enable_thinking = false;
      }
    } else if (lvl === "on") {
      if (cap.thinking_mode === "toggle") {
        out.enable_thinking = true;
      } else {
        out.reasoning_effort = "medium";
      }
    } else if (["low", "medium", "high", "xhigh", "max"].includes(lvl)) {
      if (cap.thinking_mode === "toggle") {
        out.enable_thinking = true;
      } else {
        out.reasoning_effort = lvl === "max" ? (cap.thinking_levels.includes("xhigh") ? "xhigh" : "high") : lvl;
      }
    } else if (antBody.thinking?.type === "enabled") {
      if (cap.thinking_mode === "openai_effort") {
        const b = Number(antBody.thinking.budget_tokens || 10000);
        out.reasoning_effort = b >= 30000 && cap.thinking_levels.includes("xhigh") ? "xhigh" : b >= 20000 ? "high" : b >= 8000 ? "medium" : "low";
      } else if (cap.thinking_mode === "toggle") {
        out.enable_thinking = true;
      }
    }
  }

  return out;
}

function attachClientAbortController(req, res) {
  const abortCtrl = new AbortController();
  const onDisconnect = () => {
    if (!res.writableEnded) {
      try {
        abortCtrl.abort();
      } catch {}
    }
  };
  req.on("aborted", onDisconnect);
  res.on("close", onDisconnect);
  return abortCtrl;
}

async function handleAnthropicPassthrough(req, res, provider, rawBody, subpath, signal) {
  const url = buildApiEndpoint(provider.base_url, "anthropic", subpath);
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
  };
  if (req.headers["anthropic-beta"]) {
    headers["anthropic-beta"] = req.headers["anthropic-beta"];
  }
  if (provider.api_key) {
    headers["x-api-key"] = provider.api_key;
    headers["Authorization"] = `Bearer ${provider.api_key}`;
  }

  let upstream = await fetch(url, {
    method: "POST",
    headers,
    body: rawBody,
    signal,
  });

  // Auto-fallback if an Anthropic-compatible relay rejects optional thinking parameter with 400/422
  if ((upstream.status === 400 || upstream.status === 422) && rawBody && rawBody.includes('"thinking"')) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && parsed.thinking) {
        delete parsed.thinking;
        const retryRes = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(parsed),
          signal,
        });
        if (retryRes.ok) {
          logEvent("INFO", "proxy", "anthropic_thinking_fallback_ok", `上游「${provider.name}」拒绝 thinking 参数，已自动降级恢复成功`);
          upstream = retryRes;
        }
      }
    } catch {}
  }

  const respHeaders = {
    "Content-Type": upstream.headers.get("content-type") || "application/json",
    "Cache-Control": "no-cache",
  };
  res.writeHead(upstream.status, respHeaders);
  if (!upstream.body) return res.end();

  const reader = upstream.body.getReader();
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

// Per-provider/model compatibility cache: remembers when an upstream rejects enable_thinking or reasoning_effort
// Values: "reasoning_effort" | "strip_thinking" | "strip_all_extras"
const _upstreamCompatMode = new Map();

async function handleOpenAiTranslated(res, provider, antBody, thinkingHint = "", signal = undefined) {
  const url = buildApiEndpoint(provider.base_url, "openai", "/chat/completions");
  const oaiBody = anthropicToOpenAiBody(antBody, provider, thinkingHint);
  const headers = { "Content-Type": "application/json" };
  if (provider.api_key) headers["Authorization"] = `Bearer ${provider.api_key}`;

  const compatKey = `${provider.id}::${oaiBody.model}`;
  const cachedCompat = _upstreamCompatMode.get(compatKey);
  const applyCompat = (body, mode) => {
    const cloned = { ...body };
    if (mode === "reasoning_effort") {
      if (cloned.enable_thinking === true) {
        delete cloned.enable_thinking;
        cloned.reasoning_effort = "high";
      } else {
        delete cloned.enable_thinking;
      }
    } else if (mode === "strip_thinking") {
      delete cloned.enable_thinking;
      delete cloned.reasoning_effort;
    } else if (mode === "strip_all_extras") {
      delete cloned.enable_thinking;
      delete cloned.reasoning_effort;
      delete cloned.stream_options;
    }
    return cloned;
  };

  let sendBody = cachedCompat ? applyCompat(oaiBody, cachedCompat) : oaiBody;
  let upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(sendBody),
    signal,
  });

  // Zero-400 auto-fallback when a relay rejects optional thinking/stream extension fields
  if ((upstream.status === 400 || upstream.status === 422) && !cachedCompat) {
    const firstErrTxt = await upstream.text();
    const hadEnableThinking = sendBody.enable_thinking !== undefined;
    const hadEffort = sendBody.reasoning_effort !== undefined;
    const hadStreamOpts = sendBody.stream_options !== undefined;

    const fallbacks = [];
    if (hadEnableThinking && sendBody.enable_thinking === true) fallbacks.push("reasoning_effort");
    if (hadEnableThinking || hadEffort) fallbacks.push("strip_thinking");
    if (hadStreamOpts) fallbacks.push("strip_all_extras");

    let recovered = false;
    let lastStatus = upstream.status;
    let lastErrTxt = firstErrTxt;

    for (const mode of fallbacks) {
      const nextBody = applyCompat(oaiBody, mode);
      const retryRes = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(nextBody),
        signal,
      });
      if (retryRes.ok) {
        _upstreamCompatMode.set(compatKey, mode);
        logEvent(
          "INFO",
          "proxy",
          "compat_fallback_ok",
          `上游「${provider.name} / ${oaiBody.model}」拒绝扩展参数，已自动切换兼容模式 (${mode}) 并恢复成功`,
        );
        upstream = retryRes;
        sendBody = nextBody;
        recovered = true;
        break;
      }
      lastStatus = retryRes.status;
      lastErrTxt = await retryRes.text();
    }

    if (!recovered) {
      logEvent(
        "ERROR",
        "proxy",
        "upstream_http_error",
        `上游「${provider.name} / ${oaiBody.model}」返回 HTTP ${lastStatus}: ${lastErrTxt.slice(0, 320)}`,
        { layer: "upstream-api" },
      );
      res.writeHead(lastStatus, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: lastStatus === 401 ? "authentication_error" : lastStatus === 429 ? "rate_limit_error" : "api_error",
            message: lastErrTxt.slice(0, 1200),
          },
        }),
      );
    }
  } else if (!upstream.ok) {
    const errTxt = await upstream.text();
    logEvent(
      "ERROR",
      "proxy",
      "upstream_http_error",
      `上游「${provider.name} / ${oaiBody.model}」返回 HTTP ${upstream.status}: ${errTxt.slice(0, 320)}`,
      { layer: "upstream-api" },
    );
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        type: "error",
        error: {
          type: upstream.status === 401 ? "authentication_error" : upstream.status === 429 ? "rate_limit_error" : "api_error",
          message: errTxt.slice(0, 1200),
        },
      }),
    );
  }

  // Non-streaming response translation
  if (!oaiBody.stream) {
    const data = await upstream.json();
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const content = [];
    if (msg.reasoning_content || msg.reasoning) {
      content.push({ type: "thinking", thinking: msg.reasoning_content || msg.reasoning });
    }
    if (msg.content) content.push({ type: "text", text: msg.content });
    for (const tc of msg.tool_calls || []) {
      let parsed = {};
      try {
        parsed = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        parsed = { raw: tc.function?.arguments || "" };
      }
      content.push({ type: "tool_use", id: tc.id || "call_0", name: tc.function?.name || "Tool", input: parsed });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        id: data.id || `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: oaiBody.model,
        content,
        stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: data.usage?.prompt_tokens || 0,
          output_tokens: data.usage?.completion_tokens || 0,
        },
      }),
    );
  }

  // Streaming SSE translation: OpenAI SSE -> Anthropic Messages SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const msgId = `msg_${Date.now().toString(36)}`;
  sendSse(res, "message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model: oaiBody.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let nextBlockIndex = 0;
  let thinkingIdx = null;
  let textIdx = null;
  const toolIndexMap = new Map(); // openai tool_call index -> anthropic block index
  let openBlockIdx = null;
  let finishReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };

  const closeCurrentBlock = () => {
    if (openBlockIdx !== null) {
      sendSse(res, "content_block_stop", { type: "content_block_stop", index: openBlockIdx });
      if (openBlockIdx === thinkingIdx) thinkingIdx = null;
      if (openBlockIdx === textIdx) textIdx = null;
      openBlockIdx = null;
    }
  };

  const processSseLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const payloadStr = line.slice(5).trim();
    if (!payloadStr || payloadStr === "[DONE]") return;

    let chunk;
    try {
      chunk = JSON.parse(payloadStr);
    } catch {
      return;
    }

    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens || usage.input_tokens,
        output_tokens: chunk.usage.completion_tokens || usage.output_tokens,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      finishReason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "max_tokens" : "end_turn";
    }
    const delta = choice.delta || {};

    // 1) Reasoning / Thinking stream
    const rText = delta.reasoning_content || delta.reasoning || "";
    if (rText) {
      if (thinkingIdx === null) {
        closeCurrentBlock();
        thinkingIdx = nextBlockIndex++;
        openBlockIdx = thinkingIdx;
        sendSse(res, "content_block_start", {
          type: "content_block_start",
          index: thinkingIdx,
          content_block: { type: "thinking", thinking: "" },
        });
      }
      sendSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: thinkingIdx,
        delta: { type: "thinking_delta", thinking: rText },
      });
    }

    // 2) Text stream
    if (delta.content) {
      if (textIdx === null) {
        closeCurrentBlock();
        textIdx = nextBlockIndex++;
        openBlockIdx = textIdx;
        sendSse(res, "content_block_start", {
          type: "content_block_start",
          index: textIdx,
          content_block: { type: "text", text: "" },
        });
      }
      sendSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: textIdx,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // 3) Tool call stream
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oaiIdx = tc.index ?? 0;
        let antIdx = toolIndexMap.get(oaiIdx);
        if (antIdx === undefined) {
          closeCurrentBlock();
          antIdx = nextBlockIndex++;
          toolIndexMap.set(oaiIdx, antIdx);
          openBlockIdx = antIdx;
          sendSse(res, "content_block_start", {
            type: "content_block_start",
            index: antIdx,
            content_block: {
              type: "tool_use",
              id: tc.id || `toolu_${Date.now()}_${oaiIdx}`,
              name: tc.function?.name || "Tool",
              input: {},
            },
          });
        }
        if (tc.function?.arguments) {
          sendSse(res, "content_block_delta", {
            type: "content_block_delta",
            index: antIdx,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments },
          });
        }
      }
    }
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const rawLine of lines) processSseLine(rawLine);
    }
    buf += decoder.decode();
    if (buf.trim()) processSseLine(buf);
  } finally {
    closeCurrentBlock();
    if (!signal?.aborted) {
      sendSse(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: finishReason, stop_sequence: null },
        usage: { output_tokens: usage.output_tokens || 0 },
      });
      sendSse(res, "message_stop", { type: "message_stop" });
    }
    res.end();
  }
}

/**
 * Main HTTP handler for `/proxy/provider/:providerId/v1/...`
 */
export async function handleProviderProxyRequest(req, res, providerId, subpath, thinkingHint = "") {
  const provider = getProvider(providerId, true);
  if (!provider) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "not_found", message: `供应商不存在: ${providerId}` } }));
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const abortCtrl = attachClientAbortController(req, res);

  // Handle count_tokens gracefully for OpenAI-compatible providers
  if (subpath.includes("count_tokens")) {
    if (provider.kind === "anthropic") {
      try {
        return await handleAnthropicPassthrough(req, res, provider, rawBody, "/messages/count_tokens", abortCtrl.signal);
      } catch {
        // fall through to fast local estimate
      }
    }
    const approx = Math.max(10, Math.round(rawBody.length / 3.5));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ input_tokens: approx }));
  }

  try {
    if (provider.kind === "anthropic") {
      let bodyToSend = rawBody;
      if (thinkingHint === "off" && rawBody) {
        try {
          const parsed = JSON.parse(rawBody);
          if (parsed && typeof parsed === "object" && parsed.thinking) {
            delete parsed.thinking;
            bodyToSend = JSON.stringify(parsed);
          }
        } catch {}
      }
      return await handleAnthropicPassthrough(req, res, provider, bodyToSend, "/messages", abortCtrl.signal);
    }
    const antBody = JSON.parse(rawBody || "{}");
    return await handleOpenAiTranslated(res, provider, antBody, thinkingHint, abortCtrl.signal);
  } catch (err) {
    if (abortCtrl.signal.aborted) {
      return res.end();
    }
    logEvent("ERROR", "proxy", "upstream_error", `内置代理转发至 ${provider.name} 失败: ${err.message}`, {
      layer: "upstream-api",
    });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
    } else {
      res.end();
    }
  }
}
