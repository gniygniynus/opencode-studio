/**
 * Unified Session Orchestrator:
 *  - Per-session concurrency lock (different sessions run truly in parallel;
 *    same session across multiple open browser/Electron windows stays strictly in sync).
 *  - Non-destructive Edit & Resend branching (creates sibling branch under same parent_id).
 *  - Seamless dual-engine dispatch (OpenCode Open-Source API Engine <-> Claude Native OAuth Adapter)
 *    sharing one unified SQLite timeline.
 *  - Interactive dangerous-command confirmation workflow when student-safe guard is enabled.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import {
  addMessage,
  createSession,
  getActiveProvider,
  getAllSettings,
  getMessageById,
  getProvider,
  getSessionMeta,
  getSessionTimeline,
  updateSessionMeta,
} from "./db.mjs";
import { runApiCompact, runOpenCodeApiTurn } from "./engine_api.mjs";
import { cleanupClaudeSessionFiles, detectClaudeRuntime, runNativeClaudeCodeTurn } from "./claude_runtime.mjs";
import { classifyError, logEvent, newReqId } from "./logger.mjs";

export class SessionOrchestrator {
  constructor({ broadcast, mcpManager, getPort }) {
    this.broadcast = broadcast;
    this.mcpManager = mcpManager;
    this.getPort = getPort || (() => 17620);
    this.activeRuns = new Map();
    this.pendingConfirms = new Map();
    this.lastError = null;
  }

  runningSessionIds() {
    return [...this.activeRuns.keys()];
  }

  getLiveState(sessionId) {
    const run = this.activeRuns.get(sessionId);
    if (!run) return null;
    return {
      running: true,
      req_id: run.reqId,
      model: run.model,
      provider_name: run.providerName,
      blocks: run.liveBlocks,
    };
  }

  resolveConfirm(confirmId, approved) {
    const entry = this.pendingConfirms.get(confirmId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingConfirms.delete(confirmId);
    entry.resolve(Boolean(approved));
    return true;
  }

  stopTurn(sessionId) {
    const run = this.activeRuns.get(sessionId);
    if (!run) return false;
    run.stoppedByUser = true;
    run.controller.abort();
    logEvent("INFO", "orchestrator", "stop_requested", `用户停止会话 ${sessionId.slice(0, 8)}`, {
      reqId: run.reqId,
      sessionId,
    });
    return true;
  }

  async _requestConfirm(sessionId, payload) {
    const confirmId = `cfm_${crypto.randomBytes(5).toString("hex")}`;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(confirmId);
        resolve(false);
      }, 120_000);
      this.pendingConfirms.set(confirmId, { resolve, timer });
      this.broadcast({
        type: "confirm_request",
        session_id: sessionId,
        confirm_id: confirmId,
        ...payload,
      });
    });
  }

  /**
   * Send a normal user message or create a new session first.
   */
  async sendMessage({
    sessionId = "",
    text = "",
    images = [],
    cwd = "",
    providerId = "",
    model = "",
    thinkingLevel = "auto",
  }) {
    const cleanText = String(text || "").trim();
    if (!cleanText && (!images || !images.length)) {
      return { ok: false, error: "消息不能为空" };
    }

    let sid = sessionId;
    let meta = sid ? getSessionMeta(sid) : null;
    if (!meta) {
      const titlePreview = (cleanText || `[图片 × ${images.length}]`).replace(/\s+/g, " ").slice(0, 60);
      meta = createSession({
        title: titlePreview,
        cwd: cwd || "",
        providerId,
        model,
        thinkingLevel,
      });
      sid = meta.id;
      this.broadcast({ type: "session_created", session: meta });
    } else if (cwd && cwd !== meta.cwd) {
      meta = updateSessionMeta(sid, { cwd });
    }

    if (this.activeRuns.has(sid)) {
      const err = classifyError({
        message: "该会话正在生成回复，请等待或点击停止。",
        sessionId: sid,
        codeHint: "ERR_SESSION_BUSY",
      });
      this.lastError = err;
      this.broadcast({ type: "turn_error", session_id: sid, error: err });
      return { ok: false, error: err };
    }

    // Handle /compact slash command cleanly across engines
    if (cleanText === "/compact" || cleanText.startsWith("/compact ")) {
      return await this._handleCompact(sid, providerId, model);
    }

    const timeline = getSessionTimeline(sid);
    const parentId = timeline?.last_message_id || null;

    // Auto-title if still default
    if (meta.title === "新会话" && cleanText) {
      updateSessionMeta(sid, { title: cleanText.replace(/\s+/g, " ").slice(0, 64) });
    }

    const userMsg = addMessage({
      sessionId: sid,
      parentId,
      role: "user",
      contentText: cleanText,
      images: images || [],
    });

    this.broadcast({
      type: "message_added",
      session_id: sid,
      message: userMsg,
      timeline: getSessionTimeline(sid),
    });

    this._launchExecution({
      sessionId: sid,
      userMessageId: userMsg.id,
      providerId: providerId || meta.provider_id,
      model: model || meta.model,
      thinkingLevel: thinkingLevel || meta.thinking_level || "auto",
      forceNoCliResume: false,
    });

    return { ok: true, session_id: sid, message_id: userMsg.id };
  }

  /**
   * Edit an existing historical user message and re-run from that point as a new branch!
   */
  async editAndResend({
    sessionId,
    messageId,
    newText,
    images = null,
    providerId = "",
    model = "",
    thinkingLevel = "",
  }) {
    const cleanText = String(newText || "").trim();
    if (!cleanText) return { ok: false, error: "编辑后的内容不能为空" };

    const meta = getSessionMeta(sessionId);
    if (!meta) return { ok: false, error: "会话不存在" };

    if (this.activeRuns.has(sessionId)) {
      const err = classifyError({
        message: "该会话正在运行，请先停止后再编辑历史消息。",
        sessionId,
        codeHint: "ERR_SESSION_BUSY",
      });
      this.broadcast({ type: "turn_error", session_id: sessionId, error: err });
      return { ok: false, error: err };
    }

    const orig = getMessageById(messageId);
    if (!orig || orig.session_id !== sessionId || orig.role !== "user") {
      return { ok: false, error: "只能编辑本会话的历史用户消息" };
    }

    // Create a sibling user message under the EXACT same parent_id (non-destructive branch!)
    const newUserMsg = addMessage({
      sessionId,
      parentId: orig.parent_id,
      role: "user",
      contentText: cleanText,
      images: images !== null ? images : orig.images || [],
    });

    // Clean up previous CLI temp session file so repeated branching NEVER leaves scattered files on disk
    if (meta.claude_cli_sid) {
      cleanupClaudeSessionFiles([meta.claude_cli_sid]);
    }
    updateSessionMeta(sessionId, { claude_cli_sid: "" });

    this.broadcast({
      type: "timeline_updated",
      session_id: sessionId,
      timeline: getSessionTimeline(sessionId),
    });

    this._launchExecution({
      sessionId,
      userMessageId: newUserMsg.id,
      providerId: providerId || meta.provider_id,
      model: model || meta.model,
      thinkingLevel: thinkingLevel || meta.thinking_level || "auto",
      forceNoCliResume: true,
    });

    return { ok: true, session_id: sessionId, message_id: newUserMsg.id };
  }

  /**
   * Regenerate an AI assistant reply for the same user prompt (creates a sibling assistant branch!).
   */
  async regenerateReply({
    sessionId,
    assistantMessageId,
    providerId = "",
    model = "",
    thinkingLevel = "",
  }) {
    const meta = getSessionMeta(sessionId);
    if (!meta) return { ok: false, error: "会话不存在" };

    if (this.activeRuns.has(sessionId)) {
      const err = classifyError({
        message: "该会话正在运行，请先停止后再重新生成。",
        sessionId,
        codeHint: "ERR_SESSION_BUSY",
      });
      this.broadcast({ type: "turn_error", session_id: sessionId, error: err });
      return { ok: false, error: err };
    }

    const origAsst = getMessageById(assistantMessageId);
    if (!origAsst || origAsst.session_id !== sessionId || origAsst.role !== "assistant" || !origAsst.parent_id) {
      return { ok: false, error: "未找到对应的历史回复或父级用户提问" };
    }

    const parentUserId = origAsst.parent_id;
    if (meta.claude_cli_sid) {
      cleanupClaudeSessionFiles([meta.claude_cli_sid]);
    }
    updateSessionMeta(sessionId, { claude_cli_sid: "" });

    this._launchExecution({
      sessionId,
      userMessageId: parentUserId,
      providerId: providerId || meta.provider_id,
      model: model || meta.model,
      thinkingLevel: thinkingLevel || meta.thinking_level || "auto",
      forceNoCliResume: true,
      truncateAfterUserId: parentUserId,
    });

    return { ok: true, session_id: sessionId, user_message_id: parentUserId };
  }

  async _handleCompact(sessionId, providerId, model) {
    const reqId = newReqId();
    const meta = getSessionMeta(sessionId);
    const provider = (providerId ? getProvider(providerId, true) : null) || getActiveProvider(true);
    if (!provider || (provider.kind !== "claude_native" && !provider.api_key && !provider.base_url)) {
      const err = classifyError({ codeHint: "ERR_NO_PROVIDER", sessionId, reqId });
      this.broadcast({ type: "turn_error", session_id: sessionId, error: err });
      return { ok: false, error: err };
    }

    const timeline = getSessionTimeline(sessionId);
    if (!timeline || timeline.items.length < 2) {
      return { ok: false, error: "当前会话消息较少，暂无需压缩" };
    }

    const effectiveModel = model || meta.model || provider.default_model;
    const controller = new AbortController();
    this.activeRuns.set(sessionId, {
      controller,
      reqId,
      liveBlocks: [{ type: "text", text: "正在压缩历史上下文…" }],
      model: effectiveModel,
      providerName: provider.name,
      stoppedByUser: false,
    });
    this.broadcast({ type: "running_sessions", ids: this.runningSessionIds() });

    try {
      const summary =
        provider.kind === "claude_native"
          ? "已触发上下文压缩（后续对话将携带精炼摘要继续）。"
          : await runApiCompact({
              provider,
              model: effectiveModel,
              historyItems: timeline.items,
              signal: controller.signal,
            });

      const compactMsg = addMessage({
        sessionId,
        parentId: timeline.last_message_id,
        role: "compact",
        contentText: summary,
        model: effectiveModel,
        providerName: provider.name,
      });
      updateSessionMeta(sessionId, { compact_count: (meta.compact_count || 0) + 1, claude_cli_sid: "" });
      this.broadcast({
        type: "turn_complete",
        session_id: sessionId,
        message: compactMsg,
        timeline: getSessionTimeline(sessionId),
      });
      return { ok: true, session_id: sessionId };
    } catch (err) {
      const classified = err?.error_code
        ? err
        : classifyError({ message: err.message, providerName: provider.name, model: effectiveModel, sessionId, reqId });
      this.lastError = classified;
      this.broadcast({ type: "turn_error", session_id: sessionId, error: classified });
      return { ok: false, error: classified };
    } finally {
      this.activeRuns.delete(sessionId);
      this.broadcast({ type: "running_sessions", ids: this.runningSessionIds() });
    }
  }

  _launchExecution({ sessionId, userMessageId, providerId, model, thinkingLevel, forceNoCliResume, truncateAfterUserId = null }) {
    const reqId = newReqId();
    const meta = getSessionMeta(sessionId);
    const provider = (providerId ? getProvider(providerId, true) : null) || getActiveProvider(true);

    if (!provider || (provider.kind !== "claude_native" && !provider.api_key && !provider.base_url)) {
      const err = classifyError({ codeHint: "ERR_NO_PROVIDER", sessionId, reqId });
      this.lastError = err;
      this.broadcast({ type: "turn_error", session_id: sessionId, error: err });
      return;
    }

    if (!fs.existsSync(meta.cwd)) {
      const err = classifyError({
        message: `工作目录不存在: ${meta.cwd}`,
        codeHint: "ERR_CWD_INVALID",
        sessionId,
        reqId,
      });
      this.lastError = err;
      this.broadcast({ type: "turn_error", session_id: sessionId, error: err });
      return;
    }

    const effectiveModel = model || provider.default_model || provider.models?.[0] || "sonnet";
    updateSessionMeta(sessionId, {
      provider_id: provider.id,
      model: effectiveModel,
      thinking_level: thinkingLevel || "auto",
    });

    const controller = new AbortController();
    const runState = {
      controller,
      reqId,
      liveBlocks: [],
      model: effectiveModel,
      providerName: provider.name,
      stoppedByUser: false,
    };
    this.activeRuns.set(sessionId, runState);
    this.broadcast({ type: "running_sessions", ids: this.runningSessionIds() });

    (async () => {
      const t0 = Date.now();
      try {
        const timeline = getSessionTimeline(sessionId);
        let historyItems = timeline.items;
        if (truncateAfterUserId) {
          const cutIdx = historyItems.findIndex((m) => m.id === truncateAfterUserId);
          if (cutIdx >= 0) historyItems = historyItems.slice(0, cutIdx + 1);
        }

        const settings = getAllSettings();
        const confirmDangerous =
          settings.permission_mode === "confirm_dangerous"
            ? (info) => this._requestConfirm(sessionId, info)
            : null;

        const claudeRt = detectClaudeRuntime(false);
        const engineMode = settings.engine_mode || "auto"; // auto | claude_code | api_direct
        const useNativeClaudeCode =
          provider.kind === "claude_native" ||
          (engineMode !== "api_direct" && claudeRt.mode !== "missing" && !process.env.OPENCODE_FORCE_API_DIRECT);

        let lastPushTs = 0;
        const pushLive = (force = false) => {
          const now = Date.now();
          if (!force && now - lastPushTs < 45) return;
          lastPushTs = now;
          this.broadcast({
            type: "stream_state",
            session_id: sessionId,
            model: effectiveModel,
            provider_name: provider.name,
            engine: useNativeClaudeCode ? "claude_code" : "api",
            blocks: runState.liveBlocks,
          });
        };

        const onEvent = (ev) => {
          if (ev.type === "delta") {
            if (ev.kind === "block_start" && ev.block) {
              if (!runState.liveBlocks.includes(ev.block)) {
                runState.liveBlocks.push(ev.block);
              }
              pushLive(true);
            } else {
              pushLive(false);
            }
          } else if (ev.type === "step_blocks" && Array.isArray(ev.blocks)) {
            runState.liveBlocks = ev.blocks;
            pushLive(true);
          } else if (ev.type === "tool_result" && Array.isArray(ev.blocks)) {
            runState.liveBlocks = ev.blocks;
            pushLive(true);
          }
        };

        let result;
        if (useNativeClaudeCode) {
          const prevAsst = [...historyItems].reverse().find((m) => m.role === "assistant");
          const canResume = !forceNoCliResume && Boolean(meta.claude_cli_sid) && prevAsst?.engine === "claude_code";

          result = await runNativeClaudeCodeTurn({
            sessionId,
            reqId,
            provider,
            model: effectiveModel,
            thinkingLevel,
            cwd: meta.cwd,
            historyItems,
            resumeCliSid: canResume ? meta.claude_cli_sid : "",
            forkSession: false,
            localServerPort: this.getPort(),
            signal: controller.signal,
            onEvent,
          });
          if (result.cli_session_id) {
            updateSessionMeta(sessionId, { claude_cli_sid: result.cli_session_id });
          }
        } else {
          result = await runOpenCodeApiTurn({
            sessionId,
            reqId,
            provider,
            model: effectiveModel,
            thinkingLevel,
            cwd: meta.cwd,
            historyItems,
            mcpManager: this.mcpManager,
            signal: controller.signal,
            onEvent,
            confirmDangerous,
          });
        }

        // Persist assistant response to unified SQLite tree
        const asstMsg = addMessage({
          sessionId,
          parentId: userMessageId,
          role: "assistant",
          contentText: result.content_text || "",
          blocks: result.blocks || [],
          model: effectiveModel,
          providerName: provider.name,
          engine: result.engine || "api",
          usage: result.usage || {},
        });

        const elapsed = Date.now() - t0;
        logEvent(
          "INFO",
          "orchestrator",
          runState.stoppedByUser ? "turn_stopped" : "turn_done",
          `会话 ${sessionId.slice(0, 8)} 回合结束 (${result.engine}/${effectiveModel}, ${elapsed}ms)`,
          { reqId, sessionId },
        );

        this.broadcast({
          type: runState.stoppedByUser ? "turn_stopped" : "turn_complete",
          session_id: sessionId,
          message: asstMsg,
          timeline: getSessionTimeline(sessionId),
          elapsed_ms: elapsed,
        });
      } catch (err) {
        const classified = err?.error_code
          ? err
          : classifyError({
              message: err?.message || String(err),
              providerName: provider.name,
              model: effectiveModel,
              engine: provider.kind === "claude_native" ? "claude_native" : "api",
              sessionId,
              reqId,
            });
        this.lastError = classified;
        logEvent("ERROR", "orchestrator", "turn_error", `${classified.title}: ${classified.cause}`, {
          reqId,
          sessionId,
          errorCode: classified.error_code,
          layer: classified.layer,
        });
        this.broadcast({
          type: "turn_error",
          session_id: sessionId,
          error: classified,
          timeline: getSessionTimeline(sessionId),
        });
      } finally {
        this.activeRuns.delete(sessionId);
        this.broadcast({ type: "running_sessions", ids: this.runningSessionIds() });
      }
    })();
  }
}
