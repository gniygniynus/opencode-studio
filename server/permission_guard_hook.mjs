#!/usr/bin/env node
/**
 * Native Claude Code `PreToolUse` Security Guard Hook for `permission_mode === "confirm_dangerous"`.
 *
 * - Normal read/edit/shell operations inside the session workdir pass through in <10ms with zero friction.
 * - Destructive shell commands (`rm -rf`, `del /s`, `git push -f`, `git reset --hard`, `format`, etc.)
 *   or writes escaping the session workdir / touching `.git/hooks` pause and trigger the interactive
 *   confirmation modal inside OpenCode Studio!
 */

import path from "node:path";
import { isRealPathInsideDir } from "./security.mjs";
import { isDangerousCommand, isSensitiveWriteTarget } from "./tools.mjs";

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) break;
  }

  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.stdout.write("{}\n");
    process.exit(0);
  }

  const toolName = String(payload.tool_name || "");
  const toolInput = payload.tool_input || {};
  const sessionCwd = process.env.OPENCODE_GUARD_CWD || payload.cwd || process.cwd();
  const dataRoot = process.env.OPENCODE_DATA_DIR || "";
  const port = Number(process.env.OPENCODE_GUARD_PORT || 0);
  const sessionId = process.env.OPENCODE_GUARD_SESSION || "";
  const internalToken = process.env.OPENCODE_INTERNAL_TOKEN || "";

  let needConfirm = false;
  let displayCommand = "";
  let reason = "";

  if (/^(Bash|PowerShell)$/i.test(toolName)) {
    const cmd = String(toolInput.command || "").trim();
    if (cmd && isDangerousCommand(cmd)) {
      needConfirm = true;
      displayCommand = cmd;
      reason = "检测到高风险删除、格式化、系统关机或强制覆盖类终端命令，请确认是否允许执行：";
    }
  } else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName)) {
    const targetRaw = String(toolInput.file_path || toolInput.notebook_path || toolInput.path || "").trim();
    if (targetRaw) {
      const resolved = path.isAbsolute(targetRaw) ? path.normalize(targetRaw) : path.resolve(sessionCwd, targetRaw);
      const check = isSensitiveWriteTarget(resolved, sessionCwd, dataRoot);
      if (check.sensitive) {
        needConfirm = true;
        displayCommand = `${toolName} -> ${resolved}`;
        reason = check.reason;
      }
    }
  }

  if (!needConfirm) {
    process.stdout.write("{}\n");
    process.exit(0);
  }
  if (!port || !internalToken) {
    process.stderr.write("OpenCode Studio 安全护栏通信凭证缺失，已默认拦截该高风险操作。\n");
    process.exit(2);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 125_000);
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ocs-internal-token": internalToken,
      },
      body: JSON.stringify({
        session_id: sessionId,
        tool: toolName,
        command: displayCommand,
        reason,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.approved === true) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
          },
        }) + "\n",
      );
      process.exit(0);
    }
  } catch {}

  process.stderr.write("用户已在 OpenCode Studio 安全护栏中拒绝执行该高风险操作。\n");
  process.exit(2);
}

main().catch(() => {
  process.stdout.write("{}\n");
  process.exit(0);
});
