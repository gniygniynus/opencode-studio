/**
 * OpenCode Studio Open-Source Transparent Agent Engine (API Mode).
 *
 * Features:
 *  - 100% open-source, zero telemetry, zero hidden system prompt injection.
 *  - Dual protocol native streaming: Anthropic Messages API + OpenAI Chat Completions API.
 *  - Auto-adapts thinking parameters to each model's detected capability (budget / effort / toggle / none).
 *  - Full multi-step tool loop (built-in cross-platform tools + live MCP tools) + image vision + /compact.
 */

import fs from "node:fs";
import { getAllSettings, listInstalledSkills } from "./db.mjs";
import { appendTurnLog, classifyError, logEvent } from "./logger.mjs";
import { buildUnifiedMemoryContext } from "./memory_sync.mjs";
import { buildApiEndpoint, detectModelCapabilities, THINKING_BUDGETS } from "./model_registry.mjs";
import { BUILTIN_TOOLS, executeBuiltinTool } from "./tools.mjs";

const MAX_TOOL_STEPS = 25;

export function buildTransparentSystemPrompt(cwd) {
  const settings = getAllSettings();
  const basePrompt = String(settings.system_prompt || "").trim();
  const parts = [basePrompt];

  parts.push(
    `\n[运行环境]\n- 操作系统: ${process.platform} (${process.arch})\n- 当前工作目录: ${cwd}\n- 提示: 操作文件与命令默认相对于当前工作目录。`,
  );

  // Inject unified live memories (full core rules + full MEMORY.md indexes + pinned web memories, never 220-char truncated)
  const unifiedMem = buildUnifiedMemoryContext({ cwd, rtMode: "native", includeToolHint: true });
  if (unifiedMem) {
    parts.push(`\n${unifiedMem}`);
  }

  // Inject enabled installed Skills
  const skills = listInstalledSkills().filter((s) => s.enabled);
  if (skills.length) {
    const skLines = ["\n[已启用的 Skills（当任务匹配对应技能时请遵循其工作流）]"];
    for (const sk of skills.slice(0, 10)) {
      skLines.push(`\n## Skill: /${sk.slug} (${sk.name})\n${sk.content.slice(0, 2400)}`);
    }
    parts.push(skLines.join("\n"));
  }

  return parts.join("\n");
}

function loadImageAsBase64(img) {
  if (img.base64) return { media_type: img.media_type || "image/png", data: img.base64 };
  if (img.path && fs.existsSync(img.path)) {
    const buf = fs.readFileSync(img.path);
    return { media_type: img.media_type || "image/png", data: buf.toString("base64") };
  }
  return null;
}

/**
 * Convert OpenCode Studio's unified message timeline into Anthropic Messages array.
 * Respects compact boundaries (starts after latest compact summary so context stays clean).
 */
function buildAnthropicMessages(historyItems) {
  let startIdx = 0;
  for (let i = historyItems.length - 1; i >= 0; i--) {
    if (historyItems[i].role === "compact") {
      startIdx = i;
      break;
    }
  }
  const slice = historyItems.slice(startIdx);
  const out = [];

  for (const item of slice) {
    if (item.role === "compact") {
      out.push({
        role: "user",
        content: `[历史上下文压缩摘要]\n${item.content_text}`,
      });
      out.push({
        role: "assistant",
        content: "已了解之前对话的压缩摘要，请继续。",
      });
      continue;
    }
    if (item.role === "user") {
      const blocks = [];
      const fileNotes = [];
      for (const im of item.images || []) {
        const isImg = im.kind === "image" || (!im.kind && String(im.media_type || "").startsWith("image/"));
        if (isImg) {
          const b64 = loadImageAsBase64(im);
          if (b64) {
            blocks.push({
              type: "image",
              source: { type: "base64", media_type: b64.media_type, data: b64.data },
            });
          }
        } else if (im.kind === "text" && im.path && fs.existsSync(im.path)) {
          try {
            const raw = fs.readFileSync(im.path, "utf8");
            const capped = raw.length > 65536 ? `${raw.slice(0, 8192)}\n...[文件较大已截断预览，完整路径: ${im.path}]` : raw;
            fileNotes.push(`[附带文本文件: ${im.name || "file"} | 路径: ${im.path}]\n\`\`\`\n${capped}\n\`\`\``);
          } catch {
            fileNotes.push(`[附带文件: ${im.name || "file"} | 路径: ${im.path}]`);
          }
        } else if (im.path || im.name) {
          fileNotes.push(`[附带文件: ${im.name || "file"} (${im.media_type || "binary"}, ${im.size || 0} bytes) | 本地路径: ${im.path || ""}]`);
        }
      }
      const combinedText = [item.content_text || "", ...fileNotes].filter(Boolean).join("\n\n");
      if (combinedText) {
        blocks.push({ type: "text", text: combinedText });
      }
      if (!blocks.length) continue;
      out.push({ role: "user", content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks });
      continue;
    }
    if (item.role === "assistant") {
      // Summarize tool calls inline or replay clean text so switching between engines/models never breaks tool_use_id pairing!
      const textParts = [];
      for (const b of item.blocks || []) {
        if (b.type === "text" && b.text) textParts.push(b.text);
        else if (b.type === "tool_use") {
          const resSnippet = b.result ? String(b.result).slice(0, 600) : "";
          textParts.push(`[工具调用 ${b.name}(${JSON.stringify(b.input || {}).slice(0, 200)}) -> ${resSnippet}]`);
        }
      }
      const txt = textParts.join("\n").trim() || item.content_text || "(无文本回复)";
      out.push({ role: "assistant", content: txt });
    }
  }

  // Guarantee alternating user/assistant roles for strict Anthropic API compliance
  const normalized = [];
  for (const m of out) {
    if (normalized.length && normalized[normalized.length - 1].role === m.role) {
      const prev = normalized[normalized.length - 1];
      const prevStr = typeof prev.content === "string" ? prev.content : JSON.stringify(prev.content);
      const curStr = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      prev.content = `${prevStr}\n\n${curStr}`;
    } else {
      normalized.push(m);
    }
  }
  return normalized;
}

function buildOpenAiMessages(historyItems, systemPrompt) {
  const ant = buildAnthropicMessages(historyItems);
  const out = [{ role: "system", content: systemPrompt }];
  for (const m of ant) {
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push({ type: "text", text: b.text });
        else if (b.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          });
        }
      }
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

async function* parseSseStream(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const rawEv of events) {
      let eventName = "message";
      const dataLines = [];
      for (const line of rawEv.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      yield { event: eventName, data: dataLines.join("\n") };
    }
  }
}

async function callAnthropicStep({ provider, model, thinkingLevel, cap, systemPrompt, messages, tools, signal, onDelta }) {
  const url = buildApiEndpoint(provider.base_url, "anthropic", "/messages");
  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (provider.api_key) {
    headers["x-api-key"] = provider.api_key;
    headers["Authorization"] = `Bearer ${provider.api_key}`;
  }

  let maxTokens = 16384;
  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
    stream: true,
  };

  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  // Adapt thinking strictly based on detected model capability
  const lvl = thinkingLevel === "auto" ? cap.default_thinking : thinkingLevel;
  if (cap.thinking_supported && lvl && lvl !== "off") {
    const budget = THINKING_BUDGETS[lvl] || 10000;
    if (budget > 0) {
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = Math.max(maxTokens, budget + 8192);
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Anthropic API HTTP ${res.status}: ${errText.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }

  const blocks = [];
  const blockByIndex = new Map();
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  for await (const ev of parseSseStream(res.body)) {
    if (ev.data === "[DONE]") break;
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      continue;
    }

    if (payload.type === "error") {
      throw new Error(payload.error?.message || JSON.stringify(payload.error));
    }
    if (payload.type === "message_start" && payload.message?.usage) {
      usage = { ...usage, ...payload.message.usage };
    } else if (payload.type === "message_delta" && payload.usage) {
      usage = { ...usage, ...payload.usage };
    } else if (payload.type === "content_block_start") {
      const cb = payload.content_block || {};
      let blk;
      if (cb.type === "thinking") blk = { type: "thinking", text: "" };
      else if (cb.type === "tool_use") {
        blk = { type: "tool_use", id: cb.id || `tu_${Date.now()}`, name: cb.name, input: {}, _raw: "" };
      } else {
        blk = { type: "text", text: "" };
      }
      blocks.push(blk);
      blockByIndex.set(payload.index, blk);
      onDelta({ kind: "block_start", block: blk });
    } else if (payload.type === "content_block_delta") {
      const blk = blockByIndex.get(payload.index);
      if (!blk) continue;
      const d = payload.delta || {};
      if (d.type === "text_delta" && d.text) {
        blk.text += d.text;
        onDelta({ kind: "text_delta", text: d.text });
      } else if (d.type === "thinking_delta" && d.thinking) {
        blk.text += d.thinking;
        onDelta({ kind: "thinking_delta", text: d.thinking });
      } else if (d.type === "input_json_delta" && d.partial_json) {
        blk._raw += d.partial_json;
      }
    } else if (payload.type === "content_block_stop") {
      const blk = blockByIndex.get(payload.index);
      if (blk?.type === "tool_use") {
        try {
          blk.input = blk._raw ? JSON.parse(blk._raw) : {};
        } catch {
          blk.input = { raw: blk._raw };
        }
        delete blk._raw;
      }
    }
  }

  return { blocks, usage };
}

async function callOpenAiStep({ provider, model, thinkingLevel, cap, messages, tools, signal, onDelta }) {
  const url = buildApiEndpoint(provider.base_url, "openai", "/chat/completions");
  const headers = { "Content-Type": "application/json" };
  if (provider.api_key) {
    headers["Authorization"] = `Bearer ${provider.api_key}`;
  }

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // Adapt reasoning parameters strictly to the model's detected mode
  const lvl = thinkingLevel === "auto" ? cap.default_thinking : thinkingLevel;
  if (cap.thinking_supported && lvl && lvl !== "off") {
    if (cap.thinking_mode === "openai_effort") {
      body.reasoning_effort = lvl;
    } else if (cap.thinking_mode === "toggle") {
      if (cap.family === "qwen" || cap.family === "cn-flagship") {
        body.enable_thinking = true;
      }
    }
  } else if (cap.thinking_supported && lvl === "off" && cap.thinking_mode === "toggle") {
    if (cap.family === "qwen" || cap.family === "cn-flagship") {
      body.enable_thinking = false;
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`OpenAI Compatible API HTTP ${res.status}: ${errText.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }

  let thinkingBlock = null;
  let textBlock = null;
  const toolCallsByIdx = new Map();
  let usage = { input_tokens: 0, output_tokens: 0 };

  for await (const ev of parseSseStream(res.body)) {
    if (ev.data === "[DONE]") break;
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      continue;
    }

    if (payload.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    if (payload.usage) {
      usage = {
        input_tokens: payload.usage.prompt_tokens || 0,
        output_tokens: payload.usage.completion_tokens || 0,
      };
    }

    const choice = payload.choices?.[0];
    const delta = choice?.delta;
    if (!delta) continue;

    const rText = delta.reasoning_content || delta.reasoning || "";
    if (rText) {
      if (!thinkingBlock) {
        thinkingBlock = { type: "thinking", text: "" };
        onDelta({ kind: "block_start", block: thinkingBlock });
      }
      thinkingBlock.text += rText;
      onDelta({ kind: "thinking_delta", text: rText });
    }

    if (delta.content) {
      if (!textBlock) {
        textBlock = { type: "text", text: "" };
        onDelta({ kind: "block_start", block: textBlock });
      }
      textBlock.text += delta.content;
      onDelta({ kind: "text_delta", text: delta.content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolCallsByIdx.get(idx);
        if (!entry) {
          entry = {
            type: "tool_use",
            id: tc.id || `call_${Date.now()}_${idx}`,
            name: "",
            input: {},
            _raw: "",
          };
          toolCallsByIdx.set(idx, entry);
          onDelta({ kind: "block_start", block: entry });
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry._raw += tc.function.arguments;
      }
    }
  }

  const blocks = [];
  if (thinkingBlock?.text) blocks.push(thinkingBlock);
  if (textBlock?.text) blocks.push(textBlock);
  for (const tc of [...toolCallsByIdx.values()]) {
    try {
      tc.input = tc._raw ? JSON.parse(tc._raw) : {};
    } catch {
      tc.input = { raw: tc._raw };
    }
    delete tc._raw;
    blocks.push(tc);
  }
  return { blocks, usage };
}

/**
 * Execute one full multi-step Agent turn using the OpenCode open-source API engine.
 */
export async function runOpenCodeApiTurn({
  sessionId,
  reqId,
  provider,
  model,
  thinkingLevel,
  cwd,
  historyItems,
  mcpManager,
  signal,
  onEvent,
  confirmDangerous,
}) {
  const cap = detectModelCapabilities(model, provider.kind, null, provider.model_overrides?.[model]);
  const systemPrompt = buildTransparentSystemPrompt(cwd);
  const allTools = [...BUILTIN_TOOLS, ...(mcpManager ? mcpManager.getToolDefinitions() : [])];

  appendTurnLog(
    sessionId,
    `=== API TURN req=${reqId} provider=${provider.name}(${provider.kind}) model=${model} thinking=${thinkingLevel}(mode=${cap.thinking_mode}) ctx=${cap.context_window} tools=${allTools.length} ===`,
  );

  const collectedBlocks = [];
  let latestUsage = {};

  // Working message buffer for multi-step tool loop within this turn
  let antMsgs = provider.kind === "anthropic" ? buildAnthropicMessages(historyItems) : null;
  let oaiMsgs = provider.kind === "openai" ? buildOpenAiMessages(historyItems, systemPrompt) : null;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (signal.aborted) break;

    let stepResult;
    try {
      if (provider.kind === "anthropic") {
        stepResult = await callAnthropicStep({
          provider,
          model,
          thinkingLevel,
          cap,
          systemPrompt,
          messages: antMsgs,
          tools: allTools,
          signal,
          onDelta: (d) => onEvent({ type: "delta", ...d }),
        });
      } else {
        stepResult = await callOpenAiStep({
          provider,
          model,
          thinkingLevel,
          cap,
          messages: oaiMsgs,
          tools: allTools,
          signal,
          onDelta: (d) => onEvent({ type: "delta", ...d }),
        });
      }
    } catch (err) {
      if (signal.aborted || err.name === "AbortError") break;
      appendTurnLog(sessionId, `[api-error] status=${err.status || "-"} ${err.message}`);
      const classified = classifyError({
        message: err.message,
        status: err.status || null,
        providerName: provider.name,
        model,
        engine: "api",
        sessionId,
        reqId,
      });
      throw classified;
    }

    latestUsage = stepResult.usage || latestUsage;
    const toolUses = [];

    for (const blk of stepResult.blocks) {
      if (blk.type === "tool_use") {
        const record = { ...blk, status: "running", is_error: false, result: null };
        collectedBlocks.push(record);
        toolUses.push(record);
      } else {
        collectedBlocks.push(blk);
      }
    }

    onEvent({ type: "step_blocks", blocks: collectedBlocks, usage: latestUsage });

    // No tool calls -> final answer reached
    if (!toolUses.length) break;

    // Append assistant tool-call turn to loop buffer
    if (provider.kind === "anthropic") {
      antMsgs.push({
        role: "assistant",
        content: stepResult.blocks.map((b) =>
          b.type === "tool_use"
            ? { type: "tool_use", id: b.id, name: b.name, input: b.input }
            : b.type === "thinking"
              ? { type: "thinking", thinking: b.text }
              : { type: "text", text: b.text },
        ),
      });
    } else {
      const assistantText = stepResult.blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      oaiMsgs.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        })),
      });
    }

    // Execute tools sequentially and stream results back to UI
    const antToolResults = [];
    for (const tu of toolUses) {
      if (signal.aborted) break;
      appendTurnLog(sessionId, `[tool-call] ${tu.name} ${JSON.stringify(tu.input || {}).slice(0, 300)}`);
      const res = await executeBuiltinTool(tu.name, tu.input, {
        cwd,
        signal,
        mcpManager,
        confirmDangerous,
      });
      tu.result = res.output;
      tu.is_error = !res.ok;
      tu.status = res.ok ? "done" : "error";
      appendTurnLog(sessionId, `[tool-res] ${tu.name} ok=${res.ok} len=${String(res.output || "").length}`);

      onEvent({
        type: "tool_result",
        tool_id: tu.id,
        result: tu.result,
        is_error: tu.is_error,
        blocks: collectedBlocks,
      });

      if (provider.kind === "anthropic") {
        antToolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: String(tu.result || ""),
          is_error: tu.is_error,
        });
      } else {
        oaiMsgs.push({
          role: "tool",
          tool_call_id: tu.id,
          content: String(tu.result || ""),
        });
      }
    }

    if (provider.kind === "anthropic" && antToolResults.length) {
      antMsgs.push({ role: "user", content: antToolResults });
    }
  }

  const finalText = collectedBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  return {
    blocks: collectedBlocks,
    content_text: finalText,
    usage: latestUsage,
    model,
    engine: "api",
  };
}

/**
 * Compact long conversation history into a concise summary using the active API provider.
 */
export async function runApiCompact({ provider, model, historyItems, signal }) {
  const cap = detectModelCapabilities(model, provider.kind);
  const transcript = historyItems
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${(m.content_text || "").slice(0, 1500)}`)
    .join("\n\n")
    .slice(-60000);

  const prompt = `请把下面这段历史对话压缩成结构清晰、信息无损的中文交接摘要（保留关键目标、已改文件路径、核心结论、待办事项与约束），控制在 800 字以内：\n\n${transcript}`;

  let summary = "";
  if (provider.kind === "anthropic") {
    const res = await callAnthropicStep({
      provider,
      model,
      thinkingLevel: "off",
      cap,
      systemPrompt: "你是精准的对话上下文压缩助手。",
      messages: [{ role: "user", content: prompt }],
      tools: [],
      signal,
      onDelta: () => {},
    });
    summary = res.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  } else {
    const res = await callOpenAiStep({
      provider,
      model,
      thinkingLevel: "off",
      cap,
      messages: [
        { role: "system", content: "你是精准的对话上下文压缩助手。" },
        { role: "user", content: prompt },
      ],
      tools: [],
      signal,
      onDelta: () => {},
    });
    summary = res.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  return summary.trim() || "（已完成历史上下文压缩）";
}
