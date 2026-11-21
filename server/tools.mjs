/**
 * Cross-platform Agent built-in tools (Windows native PowerShell/CMD + Linux/macOS Bash).
 *
 * Implements the full Claude Code-style coding toolkit with 100% open-source transparency:
 *   - run_shell, read_file, edit_file, write_file, list_dir, glob_files, grep_search,
 *     web_fetch, memory_search, memory_save
 *   - Optional student-safe confirmation guard for destructive shell commands.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listMemories, saveMemory } from "./db.mjs";
import { logEvent } from "./logger.mjs";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".cache",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

const DANGEROUS_CMD_RE =
  /(\brm\s+-[^\n]*r[^\n]*f|\bremove-item\b[^\n]*-recurse|\bdel\s+\/[sfq]|\brmdir\s+\/s|\bformat\s+[a-z]:|\bshutdown\b|\bmkfs\b|\bdd\s+if=|git\s+push\s+[^\n]*--force|git\s+reset\s+--hard)/i;

export function isDangerousCommand(command) {
  return DANGEROUS_CMD_RE.test(String(command || ""));
}

export const BUILTIN_TOOLS = [
  {
    name: "run_shell",
    description:
      "在当前工作目录执行本机终端命令（Windows 自动使用 PowerShell UTF-8，macOS/Linux 使用 bash）。用于运行代码、安装依赖、git 操作、测试验证等。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的完整命令" },
        description: { type: "string", description: "简短说明这条命令的目的（中文）" },
        timeout_ms: { type: "number", description: "超时毫秒数，默认 60000，最大 300000" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "读取指定文本文件的内容（带行号），支持按行范围分段读取，避免一次读入超大文件。",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件绝对路径或相对当前工作目录的路径" },
        start_line: { type: "number", description: "起始行号（从 1 开始，默认 1）" },
        end_line: { type: "number", description: "结束行号（默认最多读 300 行）" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "edit_file",
    description: "精准替换文件中的某段文本（外科手术式局部修改，不要整文件重写）。",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件路径" },
        old_string: { type: "string", description: "文件中现有的精确文本片段（含缩进与换行）" },
        new_string: { type: "string", description: "替换后的新文本" },
        replace_all: { type: "boolean", description: "是否替换全部匹配项，默认 false" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "write_file",
    description: "创建新文件或完整写入文件内容（自动创建不存在的父目录）。",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "目标文件路径" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "列出指定目录的文件与子目录列表。",
    input_schema: {
      type: "object",
      properties: {
        dir_path: { type: "string", description: "目录路径，默认为当前工作目录" },
      },
    },
  },
  {
    name: "glob_files",
    description: "在工作目录中按通配符/关键词搜索文件路径（自动忽略 node_modules 与 .git）。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "文件名通配符，如 *.js、**/*.py 或路径关键字" },
        dir_path: { type: "string", description: "搜索根目录，默认当前工作目录" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    description: "在工作目录文本文件中搜索包含指定关键词或正则表达式的代码行。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "搜索关键词或正则表达式" },
        dir_path: { type: "string", description: "搜索目录，默认当前工作目录" },
        file_ext: { type: "string", description: "可选文件后缀过滤，如 .js 或 .py" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "web_fetch",
    description: "联网抓取指定公开网页或文档的纯文本内容（只读 GET 请求）。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要访问的 http(s) URL" },
      },
      required: ["url"],
    },
  },
  {
    name: "memory_search",
    description: "检索 OpenCode Studio 的持久化记忆库（全局记忆与当前项目记忆）。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，留空列出全部记忆标题" },
      },
    },
  },
  {
    name: "memory_save",
    description: "保存一条精炼的长期记忆（用户偏好、项目架构或重要经验），支持后续对话按需读取。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "简短标题" },
        content: { type: "string", description: "记忆正文（精炼准确）" },
        scope: { type: "string", enum: ["global", "project"], description: "global 或 project" },
        category: { type: "string", description: "分类，如 preference / project / troubleshooting" },
      },
      required: ["title", "content"],
    },
  },
];

function resolveSafePath(cwd, target) {
  if (!target) return cwd;
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
}

function globToRegex(glob) {
  const escaped = String(glob || "*")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___DOUBLE___")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\?/g, ".")
    .replace(/___DOUBLE___/g, ".*");
  return new RegExp(escaped, "i");
}

function execShell(command, cwd, timeoutMs = 60000, signal = null) {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const bin = isWin ? "powershell.exe" : "bash";
    const args = isWin
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${command}`,
        ]
      : ["-lc", command];

    let stdout = "";
    let stderr = "";
    let killed = false;
    const maxBuf = 256 * 1024;

    const proc = spawn(bin, args, {
      cwd,
      env: process.env,
      windowsHide: true,
    });

    const killProc = () => {
      if (killed) return;
      killed = true;
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 1200);
      } catch {}
    };

    const timer = setTimeout(() => {
      stderr += `\n[超时] 命令超过 ${timeoutMs}ms 已自动终止。`;
      killProc();
    }, Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 300000));

    if (signal) {
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }

    proc.stdout?.on("data", (chunk) => {
      if (stdout.length < maxBuf) stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk) => {
      if (stderr.length < maxBuf) stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `启动终端进程失败: ${err.message}`, exitCode: -1 });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      let combined = "";
      if (stdout.trim()) combined += stdout.trimEnd();
      if (stderr.trim()) combined += (combined ? "\n\n[stderr]\n" : "") + stderr.trimEnd();
      if (!combined) combined = `(命令执行完毕，退出码 ${code ?? 0}，无输出)`;
      if (combined.length > 24000) {
        combined = combined.slice(0, 24000) + `\n... [输出已截断，总长 ${combined.length} 字符]`;
      }
      resolve({
        ok: code === 0,
        output: `exit_code: ${code ?? 0}\n${combined}`,
        exitCode: code ?? 0,
      });
    });
  });
}

export async function executeBuiltinTool(name, input, ctx) {
  const { cwd, signal, mcpManager, confirmDangerous } = ctx;

  // Dispatch dynamic MCP tools (mcp__<server>__<tool>)
  if (name.startsWith("mcp__") && mcpManager) {
    return await mcpManager.callTool(name, input || {});
  }

  try {
    if (name === "run_shell") {
      const command = String(input?.command || "").trim();
      if (!command) return { ok: false, output: "缺少 command 参数" };
      if (confirmDangerous && isDangerousCommand(command)) {
        const approved = await confirmDangerous({
          tool: "run_shell",
          command,
          reason: "检测到高风险删除/重置/强制推送命令，请确认是否允许执行。",
        });
        if (!approved) {
          return { ok: false, output: "用户拒绝了该高风险命令的执行。" };
        }
      }
      return await execShell(command, cwd, input?.timeout_ms || 60000, signal);
    }

    if (name === "read_file") {
      const fp = resolveSafePath(cwd, input?.file_path);
      if (!fs.existsSync(fp)) return { ok: false, output: `文件不存在: ${fp}` };
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) return { ok: false, output: `路径是目录而非文件: ${fp}` };
      if (stat.size > 4 * 1024 * 1024) {
        return { ok: false, output: `文件超过 4MB (${stat.size} B)，请使用 run_shell 分段查看。` };
      }
      const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
      const start = Math.max(1, Number(input?.start_line) || 1);
      const end = Math.min(lines.length, Number(input?.end_line) || start + 299);
      const slice = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`);
      return {
        ok: true,
        output: `File: ${fp} (lines ${start}-${end} of ${lines.length})\n` + slice.join("\n"),
      };
    }

    if (name === "edit_file") {
      const fp = resolveSafePath(cwd, input?.file_path);
      if (!fs.existsSync(fp)) return { ok: false, output: `文件不存在: ${fp}` };
      const oldStr = String(input?.old_string ?? "");
      const newStr = String(input?.new_string ?? "");
      if (!oldStr) return { ok: false, output: "old_string 不能为空" };
      const content = fs.readFileSync(fp, "utf8");
      if (!content.includes(oldStr)) {
        return { ok: false, output: `未在 ${fp} 中找到完全匹配的 old_string（请先 read_file 核对精确文本和缩进）。` };
      }
      const count = content.split(oldStr).length - 1;
      if (count > 1 && !input?.replace_all) {
        return {
          ok: false,
          output: `old_string 在文件中出现了 ${count} 次，请提供更多上下文使其唯一，或设置 replace_all=true。`,
        };
      }
      const updated = input?.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      fs.writeFileSync(fp, updated, "utf8");
      return { ok: true, output: `已成功修改 ${fp}（替换 ${input?.replace_all ? count : 1} 处）。` };
    }

    if (name === "write_file") {
      const fp = resolveSafePath(cwd, input?.file_path);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const content = String(input?.content ?? "");
      fs.writeFileSync(fp, content, "utf8");
      const lines = content.split(/\r?\n/).length;
      return { ok: true, output: `已写入 ${fp}（${lines} 行，${Buffer.byteLength(content, "utf8")} 字节）。` };
    }

    if (name === "list_dir") {
      const dir = resolveSafePath(cwd, input?.dir_path || ".");
      if (!fs.existsSync(dir)) return { ok: false, output: `目录不存在: ${dir}` };
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200);
      const lines = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => `${e.isDirectory() ? "[DIR] " : "      "}${e.name}`);
      return { ok: true, output: `Directory: ${dir}\n` + (lines.join("\n") || "(空目录)") };
    }

    if (name === "glob_files") {
      const root = resolveSafePath(cwd, input?.dir_path || ".");
      const rx = globToRegex(input?.pattern || "*");
      const hits = [];
      const deadline = Date.now() + 2500;
      const walk = (cur, depth) => {
        if (hits.length >= 150 || depth > 8 || Date.now() > deadline) return;
        let entries;
        try {
          entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= 150 || Date.now() > deadline) return;
          if (IGNORE_DIRS.has(e.name)) continue;
          const full = path.join(cur, e.name);
          const rel = path.relative(root, full).replace(/\\/g, "/");
          if (!e.isDirectory() && (rx.test(rel) || rx.test(e.name))) {
            hits.push(rel);
          } else if (e.isDirectory()) {
            walk(full, depth + 1);
          }
        }
      };
      walk(root, 0);
      return {
        ok: true,
        output: hits.length ? `匹配 ${hits.length} 个文件:\n` + hits.join("\n") : "未匹配到文件。",
      };
    }

    if (name === "grep_search") {
      const root = resolveSafePath(cwd, input?.dir_path || ".");
      const pat = String(input?.pattern || "");
      if (!pat) return { ok: false, output: "pattern 不能为空" };
      let rx;
      try {
        rx = new RegExp(pat, "i");
      } catch {
        rx = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const ext = input?.file_ext ? String(input.file_ext).toLowerCase() : "";
      const hits = [];
      const deadline = Date.now() + 3000;

      const walk = (cur, depth) => {
        if (hits.length >= 80 || depth > 7 || Date.now() > deadline) return;
        let entries;
        try {
          entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= 80 || Date.now() > deadline) return;
          if (IGNORE_DIRS.has(e.name)) continue;
          const full = path.join(cur, e.name);
          if (e.isDirectory()) {
            walk(full, depth + 1);
          } else {
            if (ext && !e.name.toLowerCase().endsWith(ext)) continue;
            try {
              const st = fs.statSync(full);
              if (st.size > 512 * 1024) continue;
              const txt = fs.readFileSync(full, "utf8");
              if (txt.includes("\0")) continue;
              const lines = txt.split(/\r?\n/);
              const rel = path.relative(root, full).replace(/\\/g, "/");
              for (let i = 0; i < lines.length; i++) {
                if (rx.test(lines[i])) {
                  hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 180)}`);
                  if (hits.length >= 80) break;
                }
              }
            } catch {
              // ignore unreadable files
            }
          }
        }
      };
      walk(root, 0);
      return {
        ok: true,
        output: hits.length ? hits.join("\n") : "未搜索到匹配内容。",
      };
    }

    if (name === "web_fetch") {
      const url = String(input?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, output: "仅支持 http:// 或 https:// 链接" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "OpenCodeStudio/1.0 (+https://github.com/gniygniynus/opencode-studio)" },
          signal: controller.signal,
        });
        const body = await res.text();
        const plain = body
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return {
          ok: res.ok,
          output: `HTTP ${res.status} (${url})\n` + plain.slice(0, 16000),
        };
      } finally {
        clearTimeout(timer);
      }
    }

    if (name === "memory_search") {
      const list = listMemories({ cwd, query: String(input?.query || "") });
      if (!list.length) return { ok: true, output: "当前未检索到相关记忆。" };
      const out = list
        .slice(0, 20)
        .map((m) => `[${m.scope}/${m.category}] ${m.title}\n${m.content.slice(0, 600)}`)
        .join("\n---\n");
      return { ok: true, output: out };
    }

    if (name === "memory_save") {
      const saved = saveMemory({
        title: input?.title,
        content: input?.content,
        scope: input?.scope === "project" ? "project" : "global",
        cwd,
        category: input?.category || "general",
      });
      return { ok: true, output: `已保存记忆 [${saved.scope}] ${saved.title} (id=${saved.id}, v${saved.version})。` };
    }

    return { ok: false, output: `未知工具: ${name}` };
  } catch (err) {
    logEvent("ERROR", "tools", "exec_error", `工具 ${name} 执行异常: ${err.message}`);
    return { ok: false, output: `工具执行出错: ${err.message}` };
  }
}
