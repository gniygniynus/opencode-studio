/**
 * Optional Claude Official Subscription Login Adapter (Thin Adapter).
 *
 * Design principles:
 *  - Isolated from API providers: strips ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN so it
 *    uses the user's own official Claude subscription OAuth login without ever conflicting
 *    with OpenCode Studio's built-in API providers.
 *  - Privacy-first flags: disables telemetry, error reporting, auto-updater, nonessential traffic,
 *    and injects the user's own transparent system prompt via `--system-prompt`.
 *  - Seamless cross-engine continuity: bridges prior history from OpenCode Studio's unified
 *    SQLite timeline when switching from API mode -> Claude Native mode (or after editing a branch),
 *    and persists outputs back into the same unified timeline so switching back to API is instant!
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendTurnLog, classifyError, logEvent } from "./logger.mjs";
import { buildTransparentSystemPrompt } from "./engine_api.mjs";

export function findClaudeCliBinary() {
  const candidates = [];
  if (process.platform === "win32") {
    const res = spawnSync("where", ["claude"], { encoding: "utf8", windowsHide: true });
    if (res.status === 0 && res.stdout) {
      candidates.push(...res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    }
    const localBin = path.join(os.homedir(), ".local", "bin", "claude.exe");
    if (fs.existsSync(localBin)) candidates.push(localBin);
  } else {
    const localBin = path.join(os.homedir(), ".local", "bin", "claude");
    if (fs.existsSync(localBin)) candidates.push(localBin);
    const res = spawnSync("which", ["claude"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) candidates.push(res.stdout.trim());
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function probeClaudeNativeStatus() {
  const bin = findClaudeCliBinary();
  if (!bin) {
    return {
      installed: false,
      binary: null,
      version: null,
      note: "未在本机检测到 claude CLI（可忽略，使用内置 API 供应商完全无需安装）。",
    };
  }
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 4000, windowsHide: true });
  return {
    installed: true,
    binary: bin,
    version: (res.stdout || res.stderr || "").trim() || "unknown",
    note: "已检测到本机 Claude Code CLI，可直接切换为「Claude 原生订阅登录」模式。",
  };
}

function buildBridgeContext(historyItems) {
  // Include up to last 14 turns as concise bridge when crossing from API -> Native or branching
  const prior = historyItems.slice(0, -1).slice(-14);
  if (!prior.length) return "";
  const lines = ["[以下为本会话此前的统一历史记录，请自然衔接上下文继续回答最新问题]"];
  for (const m of prior) {
    if (m.role === "compact") {
      lines.push(`[压缩摘要]: ${m.content_text.slice(0, 1200)}`);
    } else if (m.role === "user") {
      lines.push(`用户: ${(m.content_text || "").slice(0, 800)}`);
    } else if (m.role === "assistant") {
      lines.push(`助手: ${(m.content_text || "").slice(0, 1000)}`);
    }
  }
  return lines.join("\n") + "\n\n[最新用户问题]\n";
}

export async function runClaudeNativeTurn({
  sessionId,
  reqId,
  model,
  thinkingLevel,
  cwd,
  historyItems,
  existingCliSid,
  canResumeCli,
  signal,
  onEvent,
}) {
  const bin = findClaudeCliBinary();
  if (!bin) {
    throw classifyError({
      message: "未找到本机 claude 可执行文件",
      engine: "claude_native",
      providerName: "Claude 原生订阅登录",
      model,
      sessionId,
      reqId,
    });
  }

  const latestUser = historyItems[historyItems.length - 1];
  const systemPrompt = buildTransparentSystemPrompt(cwd);

  // Clean environment so native OAuth subscription NEVER collides with API provider settings
  const env = { ...process.env };
  for (const k of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "CLAUDECODE",
  ]) {
    delete env[k];
  }
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    "--system-prompt", systemPrompt,
  ];
  if (canResumeCli && existingCliSid) {
    args.push("--resume", existingCliSid);
  }
  if (model) {
    args.push("--model", model);
  }
  if (["low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
    args.push("--effort", thinkingLevel);
  }

  const promptText =
    canResumeCli && existingCliSid
      ? latestUser.content_text || ""
      : buildBridgeContext(historyItems) + (latestUser.content_text || "");

  const contentBlocks = [];
  for (const im of latestUser.images || []) {
    if (im.path && fs.existsSync(im.path)) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: im.media_type || "image/png",
          data: fs.readFileSync(im.path).toString("base64"),
        },
      });
    }
  }
  contentBlocks.push({ type: "text", text: promptText || "请查看图片。" });

  appendTurnLog(
    sessionId,
    `=== CLAUDE NATIVE TURN req=${reqId} model=${model} resume=${Boolean(canResumeCli && existingCliSid)} cwd=${cwd} ===`,
  );

  return await new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const killProc = () => {
      try {
        proc.kill("SIGINT");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 2000);
      } catch {}
    };
    if (signal) {
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }

    const userPayload = {
      type: "user",
      message: {
        role: "user",
        content: contentBlocks.length === 1 ? contentBlocks[0].text : contentBlocks,
      },
    };
    proc.stdin.write(JSON.stringify(userPayload) + "\n");
    proc.stdin.end();

    let buf = "";
    let stderr = "";
    let cliSessionId = existingCliSid || "";
    const blocks = [];
    const blockByIdx = new Map();
    const toolById = new Map();
    let usage = {};

    proc.stderr.on("data", (chunk) => {
      const t = chunk.toString("utf8");
      stderr += t;
      appendTurnLog(sessionId, `[cli-stderr] ${t.trim()}`);
    });

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.session_id) cliSessionId = ev.session_id;

        if (ev.type === "stream_event") {
          const inner = ev.event || {};
          if (inner.type === "content_block_start") {
            const cb = inner.content_block || {};
            let blk;
            if (cb.type === "thinking") blk = { type: "thinking", text: "" };
            else if (cb.type === "tool_use") {
              blk = { type: "tool_use", id: cb.id || `tu_${Date.now()}`, name: cb.name, input: {}, status: "running", is_error: false, result: null };
              toolById.set(blk.id, blk);
            } else {
              blk = { type: "text", text: "" };
            }
            blocks.push(blk);
            blockByIdx.set(inner.index, blk);
            onEvent({ type: "delta", kind: "block_start", block: blk });
          } else if (inner.type === "content_block_delta") {
            const blk = blockByIdx.get(inner.index);
            const d = inner.delta || {};
            if (blk && d.type === "text_delta" && d.text) {
              blk.text += d.text;
              onEvent({ type: "delta", kind: "text_delta", text: d.text });
            } else if (blk && d.type === "thinking_delta" && d.thinking) {
              blk.text += d.thinking;
              onEvent({ type: "delta", kind: "thinking_delta", text: d.thinking });
            }
          }
        } else if (ev.type === "assistant" && ev.message) {
          if (ev.message.usage) usage = ev.message.usage;
          for (const b of ev.message.content || []) {
            if (b.type === "tool_use" && b.id) {
              const existing = toolById.get(b.id);
              if (existing) existing.input = b.input || existing.input;
            }
          }
          onEvent({ type: "step_blocks", blocks, usage });
        } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) {
            if (b.type === "tool_result" && b.tool_use_id && toolById.has(b.tool_use_id)) {
              const tu = toolById.get(b.tool_use_id);
              tu.result = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
              tu.is_error = Boolean(b.is_error);
              tu.status = tu.is_error ? "error" : "done";
              onEvent({ type: "tool_result", tool_id: tu.id, result: tu.result, is_error: tu.is_error, blocks });
            }
          }
        } else if (ev.type === "result" && ev.is_error && !signal?.aborted) {
          stderr += `\n${ev.result || ""}`;
        }
      }
    });

    proc.on("error", (err) => {
      reject(
        classifyError({
          message: err.message,
          stderr,
          engine: "claude_native",
          providerName: "Claude 原生订阅登录",
          model,
          sessionId,
          reqId,
        }),
      );
    });

    proc.on("close", (code) => {
      if (signal?.aborted) {
        return resolve({
          blocks,
          content_text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim(),
          usage,
          model,
          engine: "claude_native",
          cli_session_id: cliSessionId,
        });
      }
      if (code !== 0 && !blocks.length) {
        return reject(
          classifyError({
            message: `Claude CLI 退出码 ${code}`,
            stderr,
            engine: "claude_native",
            providerName: "Claude 原生订阅登录",
            model,
            sessionId,
            reqId,
          }),
        );
      }
      resolve({
        blocks,
        content_text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim(),
        usage,
        model,
        engine: "claude_native",
        cli_session_id: cliSessionId,
      });
    });
  });
}
