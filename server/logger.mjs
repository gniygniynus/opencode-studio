/**
 * Structured logger, automatic rotation, secret redaction,
 * actionable error classification, and AI diagnostic report generator.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPaths } from "./paths.mjs";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROTATIONS = 5;

const SECRET_RE =
  /(sk-[A-Za-z0-9_\-]{12,}|Bearer\s+[A-Za-z0-9._\-]{12,}|(?:api[_-]?key|token|authorization|secret)\s*[:=]\s*["']?[^\s"',}]{10,}["']?)/gi;

export function sanitizeText(str) {
  if (!str) return "";
  return String(str).replace(SECRET_RE, (m) => m.slice(0, 10) + "***REDACTED***");
}

export function nowIso() {
  return new Date().toISOString();
}

export function newReqId() {
  return crypto.randomBytes(5).toString("hex");
}

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_BYTES) return;
    const ext = path.extname(filePath);
    const stem = filePath.slice(0, -ext.length);
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const src = `${stem}.${i}${ext}`;
      const dst = `${stem}.${i + 1}${ext}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(filePath, `${stem}.1${ext}`);
  } catch {
    // ignore rotation IO races
  }
}

export function logEvent(level, moduleName, event, msg, meta = {}) {
  const p = getPaths();
  const lvl = String(level || "INFO").toUpperCase();
  const rec = {
    ts: nowIso(),
    level: lvl,
    module: moduleName,
    event,
    msg: sanitizeText(msg),
  };
  if (meta.reqId) rec.req_id = meta.reqId;
  if (meta.sessionId) rec.session_id = meta.sessionId;
  if (meta.errorCode) rec.error_code = meta.errorCode;
  if (meta.layer) rec.layer = meta.layer;
  if (meta.detail !== undefined) {
    try {
      rec.detail = JSON.parse(sanitizeText(JSON.stringify(meta.detail)));
    } catch {
      rec.detail = sanitizeText(String(meta.detail));
    }
  }

  const jsonLine = JSON.stringify(rec) + "\n";
  const sidPart = rec.session_id ? ` sid=${rec.session_id.slice(0, 8)}` : "";
  const reqPart = rec.req_id ? ` req=${rec.req_id}` : "";
  const codePart = rec.error_code ? ` [${rec.error_code}]` : "";
  const textLine = `${rec.ts} [${lvl.padEnd(5)}] [${moduleName}:${event}]${sidPart}${reqPart}${codePart} ${rec.msg}\n`;

  try {
    rotateIfNeeded(p.jsonlLog);
    rotateIfNeeded(p.textLog);
    fs.appendFileSync(p.jsonlLog, jsonLine, "utf8");
    fs.appendFileSync(p.textLog, textLine, "utf8");
  } catch {
    // never crash caller on logging failure
  }
  return rec;
}

export function appendTurnLog(sessionId, line) {
  const p = getPaths();
  const safe = String(sessionId || "session").replace(/[^A-Za-z0-9_-]/g, "_");
  const fp = path.join(p.turnsLogDir, `${safe}.log`);
  try {
    rotateIfNeeded(fp);
    fs.appendFileSync(fp, `[${nowIso()}] ${sanitizeText(line).trimEnd()}\n`, "utf8");
  } catch {
    // ignore
  }
  return fp;
}

export function readTurnLog(sessionId, tailLines = 200) {
  const p = getPaths();
  const safe = String(sessionId || "session").replace(/[^A-Za-z0-9_-]/g, "_");
  const fp = path.join(p.turnsLogDir, `${safe}.log`);
  if (!fs.existsSync(fp)) {
    return { path: fp, exists: false, total_lines: 0, lines: [] };
  }
  const all = fs.readFileSync(fp, "utf8").split(/\r?\n/).filter(Boolean);
  return {
    path: fp,
    exists: true,
    total_lines: all.length,
    lines: all.slice(-tailLines),
  };
}

export function tailLogs({ limit = 150, level = "ALL", sessionId = "", moduleName = "" } = {}) {
  const p = getPaths();
  if (!fs.existsSync(p.jsonlLog)) return [];
  const rawLines = fs.readFileSync(p.jsonlLog, "utf8").split(/\r?\n/);
  const lvl = String(level || "ALL").toUpperCase();
  const out = [];
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const line = rawLines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (lvl === "WARN+") {
      if (!["WARN", "WARNING", "ERROR", "CRITICAL"].includes(rec.level)) continue;
    } else if (lvl !== "ALL" && rec.level !== lvl) {
      continue;
    }
    if (sessionId && rec.session_id !== sessionId) continue;
    if (moduleName && rec.module !== moduleName) continue;
    out.push(rec);
    if (out.length >= limit) break;
  }
  out.reverse();
  return out;
}

export function classifyError({
  message = "",
  status = null,
  stderr = "",
  providerName = "",
  model = "",
  engine = "api",
  sessionId = "",
  reqId = "",
  codeHint = "",
} = {}) {
  const p = getPaths();
  const combined = `${message}\n${stderr}`.trim();
  const low = combined.toLowerCase();

  let errorCode = codeHint || "ERR_RUNTIME";
  let layer = engine === "claude_native" ? "claude-cli" : "upstream-api";
  let title = "执行失败";
  let cause = sanitizeText(message || stderr.split(/\r?\n/).pop() || "未知错误");
  let suggestions = [];

  if (codeHint === "ERR_NO_PROVIDER") {
    layer = "config";
    title = "尚未配置可用的 AI 供应商";
    cause = "请先点击左下角“供应商”添加 API Key（Anthropic / OpenAI 兼容）或启用 Claude 原生登录。";
    suggestions = [
      "点击左下角「供应商管理」添加你的 API 地址与密钥。",
      "若本机已安装并登录官方 Claude Code，可直接切换到「Claude 原生登录」供应商。",
    ];
  } else if (codeHint === "ERR_SESSION_BUSY") {
    layer = "orchestrator";
    title = "当前会话正在运行上一条请求";
    suggestions = [
      "等待当前回复结束，或点击“停止”按钮后再发送。",
      "可以切换到其他会话或新建会话并行执行（多会话互不阻塞）。",
    ];
  } else if (codeHint === "ERR_CWD_INVALID") {
    layer = "filesystem";
    title = "工作目录不存在或不可访问";
    suggestions = ["点击顶栏工作目录选择有效的本机文件夹。"];
  } else if (status === 401 || status === 403 || /\b(401|403|unauthorized|invalid.?api.?key|authentication_error)\b/i.test(combined)) {
    errorCode = "ERR_UPSTREAM_AUTH";
    layer = "upstream-api";
    title = "API 密钥认证失败（401 / 403）";
    cause = `供应商「${providerName || "当前"}」拒绝了 API Key 或无权调用模型「${model || "默认"}」。`;
    suggestions = [
      "打开「供应商管理」检查 API Key 与 Base URL 是否填写正确。",
      "点击供应商里的「测试连接」验证凭证有效性。",
    ];
  } else if (status === 402 || status === 429 || status === 529 || /\b(402|429|529|rate.?limit|quota|insufficient|overloaded|balance)\b/i.test(combined)) {
    errorCode = "ERR_UPSTREAM_RATE_OR_QUOTA";
    layer = "upstream-api";
    title = "上游限流、过载或余额不足（402 / 429 / 529）";
    cause = `供应商「${providerName || "当前"}」返回限流、额度不足或服务繁忙。`;
    suggestions = [
      "稍等几秒后重试，或在底部切换其他模型/备用供应商（切换后对话上下文会自动无缝衔接）。",
    ];
  } else if (status === 404 || /model.?not.?found|does not exist|unsupported model|unknown model/i.test(combined)) {
    errorCode = "ERR_MODEL_UNSUPPORTED";
    layer = "upstream-api";
    title = "所选模型在当前供应商不可用（404）";
    cause = `模型「${model || "默认"}」不被供应商「${providerName || "当前"}」识别，或 Base URL 路径前缀有误。`;
    suggestions = [
      "在「供应商管理」点击「拉取模型」获取该供应商真实可用的模型名。",
      "检查 Base URL 是否需要/不需要末尾 `/v1`。",
    ];
  } else if (/econnrefused|enotfound|fetch failed|network|socket hang up|etimedout|timeout|504|524/i.test(low)) {
    errorCode = "ERR_NETWORK_OR_TIMEOUT";
    layer = "network";
    title = "网络连接失败或上游响应超时";
    cause = `无法连接供应商「${providerName || "当前"}」接口，或响应长时间无字节返回。`;
    suggestions = [
      "检查本机网络与代理配置，确认 Base URL 可正常访问。",
      "若使用本地中转/代理端口，确认对应程序已启动。",
    ];
  } else if (/context.?length|too many tokens|prompt is too long|maximum context/i.test(low)) {
    errorCode = "ERR_CONTEXT_LIMIT";
    layer = "agent-engine";
    title = "对话上下文超出模型上限";
    suggestions = [
      "点击输入框下方 `/compact` 按钮压缩历史上下文，或开启新会话。",
    ];
  } else if (/claude.*not found|enoent.*claude|not logged in|please login/i.test(low)) {
    errorCode = "ERR_CLAUDE_NATIVE_UNAVAILABLE";
    layer = "claude-cli";
    title = "本机 Claude Code 原生 CLI 未安装或未登录";
    suggestions = [
      "若需使用 Claude 会员原生登录，请先安装 Claude Code 并在终端执行 `claude` 完成登录。",
      "或直接在左下角「供应商管理」切换到任意 API 供应商（无需安装 Claude CLI，开箱即用）。",
    ];
  } else {
    suggestions = [
      "展开下方「技术详情」查看原始状态码与日志路径。",
      "点击「复制 AI 排障报告」可将脱敏诊断包直接发给任意 AI 快速定位。",
    ];
  }

  const safeSid = String(sessionId || "session").replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    error_code: errorCode,
    layer,
    title,
    cause,
    suggestions,
    technical: {
      req_id: reqId,
      session_id: sessionId,
      engine,
      provider: providerName,
      model,
      http_status: status,
      raw_message: sanitizeText(message).slice(0, 2000),
      stderr_tail: sanitizeText(stderr).split(/\r?\n/).filter(Boolean).slice(-25),
      log_files: {
        server_jsonl: p.jsonlLog,
        server_text: p.textLog,
        turn_log: path.join(p.turnsLogDir, `${safeSid}.log`),
      },
    },
    ts: nowIso(),
  };
}

export function buildAiDiagnosticBundle({ appVersion = "1.0.0", sessionId = "", activeProvider = null, lastError = null } = {}) {
  const p = getPaths();
  const recent = tailLogs({ limit: 40, sessionId: sessionId || "" });
  const logs = recent.length >= 8 ? recent : tailLogs({ limit: 35 });
  const turn = sessionId ? readTurnLog(sessionId, 60) : null;

  const md = [
    "# OpenCode Studio 排障诊断报告",
    `- 版本: \`v${appVersion}\``,
    `- 生成时间: \`${nowIso()}\``,
    `- 运行平台: \`${process.platform} ${process.arch} / ${os.release()} / Node ${process.version}\``,
    `- 数据目录: \`${p.dataRoot}\``,
    `- 结构化日志: \`${p.jsonlLog}\``,
    `- 易读日志: \`${p.textLog}\``,
  ];
  if (sessionId) md.push(`- 当前会话: \`${sessionId}\``);
  if (activeProvider) {
    md.push(
      "",
      "## 当前供应商（脱敏）",
      `- 名称: \`${activeProvider.name}\` | 类型: \`${activeProvider.kind}\` | 模型: \`${activeProvider.default_model || "-"}\``,
      `- Base URL: \`${activeProvider.base_url || "(native)"}\``,
    );
  }
  if (lastError) {
    md.push(
      "",
      "## 最近错误",
      `- 错误码: \`${lastError.error_code}\` | 分层: \`${lastError.layer}\``,
      `- 标题: ${lastError.title}`,
      `- 原因: ${lastError.cause}`,
      "```json",
      JSON.stringify(lastError.technical || {}, null, 2),
      "```",
    );
  }
  md.push("", "## 最近日志", "```text");
  for (const r of logs.slice(-30)) {
    const code = r.error_code ? ` [${r.error_code}]` : "";
    md.push(`${r.ts} [${r.level}] ${r.module}:${r.event}${code} ${r.msg}`);
  }
  md.push("```");
  if (turn?.exists && turn.lines.length) {
    md.push("", "## 当前会话底层追踪（末尾）", "```text", ...turn.lines.slice(-35), "```");
  }

  return {
    generated_at: nowIso(),
    log_paths: {
      data_root: p.dataRoot,
      server_jsonl: p.jsonlLog,
      server_text: p.textLog,
      turns_dir: p.turnsLogDir,
    },
    recent_logs: logs,
    markdown: md.join("\n"),
  };
}
