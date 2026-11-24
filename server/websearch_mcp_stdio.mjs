#!/usr/bin/env node
/**
 * Built-in Zero-Dependency Stdio MCP Server for Live Web Search & Clean Page Reading.
 *
 * Mounted automatically into Native Claude Code when the user enables the `🌐 联网` toggle
 * in OpenCode Studio — works with ANY model & ANY OpenAI/Anthropic relay without API keys!
 */

import { fetchWebPageClean, formatSearchResultsForLlm, searchWebLive } from "./web_search.mjs";

const TOOLS = [
  {
    name: "web_search",
    description:
      "实时联网搜索全网网页与最新技术文档/新闻（免 API Key，自动适配国内直连必应与全球搜索引擎）。回答时效性问题、查找最新库用法或未知报错时优先调用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词（支持中文或英文，尽量精炼聚焦）" },
        max_results: { type: "number", description: "返回条数，默认 8，最大 15" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_read_page",
    description: "联网读取指定网页 URL 的清洗后正文与标题结构（在 web_search 找到关键链接后用于深入阅读全文）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整的 http:// 或 https:// 网页地址" },
      },
      required: ["url"],
    },
  },
];

function sendJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    return sendJsonRpc({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode_web", version: "2.2.0" },
      },
    });
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "ping") {
    return sendJsonRpc({ jsonrpc: "2.0", id, result: {} });
  }

  if (method === "tools/list") {
    return sendJsonRpc({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === "web_search") {
        const res = await searchWebLive(args.query || "", { maxResults: Number(args.max_results) || 8 });
        return sendJsonRpc({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: formatSearchResultsForLlm(res) }],
            isError: !res.ok && !res.results?.length,
          },
        });
      }
      if (name === "web_read_page") {
        const page = await fetchWebPageClean(args.url || "");
        const out = page.ok
          ? `# ${page.title || page.url}\nURL: ${page.url}\n\n${page.content}`
          : `读取网页失败 (${page.url}): ${page.error}`;
        return sendJsonRpc({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: out }],
            isError: !page.ok,
          },
        });
      }
      return sendJsonRpc({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true },
      });
    } catch (err) {
      return sendJsonRpc({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `联网工具执行异常: ${err.message}` }], isError: true },
      });
    }
  }

  if (id !== undefined) {
    sendJsonRpc({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      handleRequest(msg);
    } catch {}
  }
});
