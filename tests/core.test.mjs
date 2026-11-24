import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// Use an isolated temporary data directory for tests so user data is never touched
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-studio-test-"));
const tmpWorkdir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-studio-cwd-"));
process.env.OPENCODE_DATA_DIR = tmpRoot;
process.env.OPENCODE_FORCE_API_DIRECT = "1";

const {
  addMessage,
  closeDb,
  createSession,
  deleteProvider,
  getProvider,
  getSessionTimeline,
  listMemories,
  saveMemory,
  saveProvider,
  switchBranch,
} = await import("../server/db.mjs");
const { detectModelCapabilities } = await import("../server/model_registry.mjs");
const { executeBuiltinTool, isDangerousCommand } = await import("../server/tools.mjs");
const { compareSemver } = await import("../server/updater.mjs");
const { CURATED_MCPS, CURATED_SKILLS, CURATED_WALLPAPERS } = await import("../server/stores.mjs");
const { isPathInsideDir, scanAuthorizedWallpaperLibrary } = await import("../server/wallpaper_engine.mjs");
const { buildCustomPromptAndMcp } = await import("../server/claude_runtime.mjs");
const { buildTransparentSystemPrompt } = await import("../server/engine_api.mjs");
const { getActiveClaudeMemoryRoot, resetMemorySyncCache } = await import("../server/memory_sync.mjs");
const { startServer } = await import("../server/index.mjs");

let mockLlmServer;
let mockLlmUrl;
let studioServer;

before(async () => {
  // Start a local mock OpenAI SSE server that tests both tool calling and text streaming
  let callCount = 0;
  mockLlmServer = http.createServer(async (req, res) => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          data: [
            { id: "claude-sonnet-4-6[1M]" },
            { id: "gpt-4o" },
            { id: "deepseek-reasoner" },
            { id: "gpt-5-codex" },
          ],
        }),
      );
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    callCount += 1;

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

    const lastMsg = body.messages[body.messages.length - 1];
    // If user mentions CREATE_FILE and we haven't seen a tool result yet, issue a write_file tool call
    if (lastMsg.role === "user" && String(lastMsg.content).includes("CREATE_FILE")) {
      const tc = {
        choices: [
          {
            delta: {
              reasoning_content: "需要调用 write_file 创建测试文件。",
              tool_calls: [
                {
                  index: 0,
                  id: "call_test_1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ file_path: "hello.txt", content: "OpenCode Studio Works!\n" }),
                  },
                },
              ],
            },
          },
        ],
      };
      res.write(`data: ${JSON.stringify(tc)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    // Normal / post-tool reply echoing user context
    const reply = lastMsg.role === "tool"
      ? `文件已创建完毕：${lastMsg.content}`
      : `收到(${callCount})：${String(lastMsg.content).slice(0, 60)}`;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 120, completion_tokens: 24 } })}\n\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  });

  await new Promise((r) => mockLlmServer.listen(0, "127.0.0.1", r));
  mockLlmUrl = `http://127.0.0.1:${mockLlmServer.address().port}`;
  studioServer = await startServer({ host: "127.0.0.1", port: 0 });
});

after(async () => {
  await studioServer?.stop();
  await new Promise((r) => mockLlmServer?.close(r));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpWorkdir, { recursive: true, force: true });
});

describe("OpenCode Studio Core Suite", () => {
  it("encrypts provider API keys at rest and masks them for clients", () => {
    const saved = saveProvider({
      name: "Mock Provider",
      kind: "openai",
      base_url: mockLlmUrl,
      api_key: "sk-super-secret-1234567890",
      default_model: "deepseek-reasoner",
      models: ["deepseek-reasoner", "gpt-4o"],
      is_active: true,
    });
    assert.equal(saved.has_api_key, true);
    assert.ok(!saved.api_key_masked.includes("123456"));
    assert.equal(saved.api_key, undefined);

    const withSecret = getProvider(saved.id, true);
    assert.equal(withSecret.api_key, "sk-super-secret-1234567890");
    deleteProvider(saved.id);
  });

  it("auto-detects model thinking levels, context window, and vision capabilities", () => {
    const claude = detectModelCapabilities("claude-sonnet-4-6[1M]", "anthropic");
    assert.equal(claude.thinking_supported, true);
    assert.equal(claude.thinking_mode, "anthropic_budget");
    assert.equal(claude.context_window, 1_000_000);
    assert.equal(claude.display_name, "claude-sonnet-4-6");
    assert.deepEqual(claude.thinking_levels, ["off", "low", "medium", "high", "max"]);

    // Claude 4.6 via OpenAI-compatible relay must still expose full 5 levels (including max!)
    const claudeOai = detectModelCapabilities("claude-opus-4-6-thinking", "openai");
    assert.deepEqual(claudeOai.thinking_levels, ["off", "low", "medium", "high", "max"]);

    // Claude Opus 4.7 supports 6 levels including xhigh & max
    const opus47 = detectModelCapabilities("claude-opus-4-7", "openai");
    assert.deepEqual(opus47.thinking_levels, ["off", "low", "medium", "high", "xhigh", "max"]);

    const gpt4o = detectModelCapabilities("gpt-4o", "openai");
    assert.equal(gpt4o.thinking_supported, false);
    assert.equal(gpt4o.context_window, 128_000);
    assert.equal(gpt4o.vision, true);

    const gpt5 = detectModelCapabilities("gpt-5-codex", "openai");
    assert.equal(gpt5.thinking_supported, true);
    assert.equal(gpt5.thinking_mode, "openai_effort");
    assert.ok(gpt5.thinking_levels.includes("xhigh"));

    const o3 = detectModelCapabilities("o3", "openai");
    assert.deepEqual(o3.thinking_levels, ["low", "medium", "high"]);

    const ds = detectModelCapabilities("deepseek-v4.1-flash", "openai");
    assert.deepEqual(ds.thinking_levels, ["off", "on"]);
    assert.equal(ds.context_window, 256_000);

    const gemFlash = detectModelCapabilities("gemini-2.5-flash", "openai");
    assert.deepEqual(gemFlash.thinking_levels, ["off", "low", "medium", "high"]);

    const grok = detectModelCapabilities("grok-4.7", "openai");
    assert.equal(grok.context_window, 256_000);
    assert.equal(grok.thinking_supported, true);

    // Unknown brand-new model enriched via provider /v1/models remote metadata
    const futureModel = detectModelCapabilities("acme-future-9", "openai", {
      context_length: 512_000,
      reasoning_efforts: ["low", "medium", "high"],
      vision: true,
    });
    assert.equal(futureModel.context_window, 512_000);
    assert.deepEqual(futureModel.thinking_levels, ["low", "medium", "high"]);
    assert.equal(futureModel.vision, true);
    assert.equal(futureModel.source, "provider-api");
  });

  it("supports non-destructive Edit & Resend branching and branch switching", () => {
    const sess = createSession({ title: "分支测试", cwd: tmpWorkdir });
    const u1 = addMessage({ sessionId: sess.id, parentId: null, role: "user", contentText: "原始提问 A" });
    addMessage({ sessionId: sess.id, parentId: u1.id, role: "assistant", contentText: "回答 A" });

    // Edit u1 -> creates sibling branch under parentId=null
    const u1b = addMessage({ sessionId: sess.id, parentId: null, role: "user", contentText: "修改后的提问 B" });
    addMessage({ sessionId: sess.id, parentId: u1b.id, role: "assistant", contentText: "回答 B" });

    const tlB = getSessionTimeline(sess.id);
    assert.equal(tlB.items.length, 2);
    assert.equal(tlB.items[0].content_text, "修改后的提问 B");
    assert.equal(tlB.items[0].branch_index, 2);
    assert.equal(tlB.items[0].branch_total, 2);

    // Switch back to branch 1
    const tlA = switchBranch(sess.id, u1.id);
    assert.equal(tlA.items[0].content_text, "原始提问 A");
    assert.equal(tlA.items[1].content_text, "回答 A");
    assert.equal(tlA.items[0].branch_index, 1);
  });

  it("protects concurrent memory edits with optimistic version locking", () => {
    const m1 = saveMemory({ title: "并发记忆测试", content: "v1", scope: "global", pinned: true });
    assert.equal(m1.version, 1);
    const m2 = saveMemory({ id: m1.id, expected_version: 1, title: "并发记忆测试", content: "v2" });
    assert.equal(m2.version, 2);
    assert.throws(
      () => saveMemory({ id: m1.id, expected_version: 1, title: "旧窗口覆盖", content: "stale" }),
      (err) => err.code === "ERR_MEMORY_CONFLICT",
    );
    assert.ok(listMemories({ query: "并发记忆" }).length >= 1);
  });

  it("executes cross-platform built-in tools and flags dangerous shell commands", async () => {
    const ctx = { cwd: tmpWorkdir, signal: new AbortController().signal };
    const w = await executeBuiltinTool("write_file", { file_path: "demo.txt", content: "line1\nline2\n" }, ctx);
    assert.equal(w.ok, true);

    const e = await executeBuiltinTool("edit_file", { file_path: "demo.txt", old_string: "line2", new_string: "line2_edited" }, ctx);
    assert.equal(e.ok, true);

    const r = await executeBuiltinTool("read_file", { file_path: "demo.txt" }, ctx);
    assert.ok(r.output.includes("line2_edited"));

    const g = await executeBuiltinTool("grep_search", { pattern: "line2_edited" }, ctx);
    assert.ok(g.output.includes("demo.txt"));

    const sh = await executeBuiltinTool("run_shell", { command: "echo HELLO_TOOL" }, ctx);
    assert.equal(sh.ok, true);
    assert.ok(sh.output.includes("HELLO_TOOL"));

    assert.equal(isDangerousCommand("rm -rf /"), true);
    assert.equal(isDangerousCommand("git push --force"), true);
    assert.equal(isDangerousCommand("echo safe"), false);
  });

  it("runs full end-to-end API Agent loop with tool execution + Edit & Resend via orchestrator", async () => {
    // Configure mock provider via REST API
    const saveRes = await fetch(`${studioServer.url}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Mock E2E",
        kind: "openai",
        base_url: mockLlmUrl,
        api_key: "sk-mock-key-1234567890",
        default_model: "deepseek-reasoner",
        is_active: true,
      }),
    }).then((r) => r.json());
    assert.equal(saveRes.ok, true);

    // Fetch models from mock server
    const fetchRes = await fetch(`${studioServer.url}/api/providers/${saveRes.provider.id}/models`, {
      method: "POST",
    }).then((r) => r.json());
    assert.equal(fetchRes.ok, true);
    assert.equal(fetchRes.models.length, 4);

    // Run real orchestrator turn that triggers write_file tool!
    const sent = await studioServer.orchestrator.sendMessage({
      text: "请执行 CREATE_FILE 任务",
      cwd: tmpWorkdir,
      providerId: saveRes.provider.id,
      model: "deepseek-reasoner",
      thinkingLevel: "on",
    });
    assert.equal(sent.ok, true);

    // Wait for completion
    for (let i = 0; i < 60; i++) {
      if (!studioServer.orchestrator.runningSessionIds().includes(sent.session_id)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(fs.existsSync(path.join(tmpWorkdir, "hello.txt")), true);
    assert.ok(fs.readFileSync(path.join(tmpWorkdir, "hello.txt"), "utf8").includes("OpenCode Studio Works!"));

    const tl1 = getSessionTimeline(sent.session_id);
    assert.equal(tl1.items.length, 2);
    assert.ok(tl1.items[1].blocks.some((b) => b.type === "tool_use" && b.name === "write_file" && b.status === "done"));

    // Now test Edit & Resend on that historical user message
    const edited = await studioServer.orchestrator.editAndResend({
      sessionId: sent.session_id,
      messageId: sent.message_id,
      newText: "改个问题：只打招呼",
    });
    assert.equal(edited.ok, true);
    for (let i = 0; i < 60; i++) {
      if (!studioServer.orchestrator.runningSessionIds().includes(sent.session_id)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const tl2 = getSessionTimeline(sent.session_id);
    assert.equal(tl2.items[0].branch_index, 2);
    assert.equal(tl2.items[0].branch_total, 2);
    assert.ok(tl2.items[1].content_text.includes("改个问题"));

    // Test AI Regenerate Reply (creates sibling assistant branch 2/2)
    const regen = await studioServer.orchestrator.regenerateReply({
      sessionId: sent.session_id,
      assistantMessageId: tl2.items[1].id,
    });
    assert.equal(regen.ok, true);
    for (let i = 0; i < 60; i++) {
      if (!studioServer.orchestrator.runningSessionIds().includes(sent.session_id)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const tl3 = getSessionTimeline(sent.session_id);
    assert.equal(tl3.items.length, 2);
    assert.equal(tl3.items[1].branch_index, 2);
    assert.equal(tl3.items[1].branch_total, 2);

    // Test Multi-turn accumulation (2nd user question appends -> 4 items, never overwrites 1st!)
    const sent2 = await studioServer.orchestrator.sendMessage({
      sessionId: sent.session_id,
      text: "第二轮连续提问测试",
      cwd: tmpWorkdir,
      providerId: saveRes.provider.id,
      model: "deepseek-reasoner",
      thinkingLevel: "off",
    });
    assert.equal(sent2.ok, true);
    for (let i = 0; i < 60; i++) {
      if (!studioServer.orchestrator.runningSessionIds().includes(sent.session_id)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const tl4 = getSessionTimeline(sent.session_id);
    assert.equal(tl4.items.length, 4);
    assert.equal(tl4.items[0].content_text, "改个问题：只打招呼");
    assert.equal(tl4.items[2].content_text, "第二轮连续提问测试");

    // Test Built-in Transparent Anthropic <-> OpenAI Proxy (used by Native Claude Code)
    const proxyRes = await fetch(`${studioServer.url}/proxy/provider/${saveRes.provider.id}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dummy" },
      body: JSON.stringify({
        model: "deepseek-reasoner",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "请执行 CREATE_FILE 任务" }],
      }),
    });
    assert.equal(proxyRes.status, 200);
    const sseText = await proxyRes.text();
    assert.ok(sseText.includes("event: message_start"));
    assert.ok(sseText.includes("thinking_delta"));
    assert.ok(sseText.includes('"name":"write_file"'));
    assert.ok(sseText.includes("event: message_stop"));

    const countRes = await fetch(`${studioServer.url}/proxy/provider/${saveRes.provider.id}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello world" }] }),
    }).then((r) => r.json());
    assert.ok(countRes.input_tokens > 0);
  });

  it("provides curated open-source catalogs (including live wallpapers) and accurate semver comparison", () => {
    assert.ok(CURATED_MCPS.length >= 6);
    assert.ok(CURATED_SKILLS.length >= 5);
    assert.ok(CURATED_WALLPAPERS.length >= 10);
    assert.ok(CURATED_WALLPAPERS.some((w) => w.type === "live" && w.liveBg));
    assert.equal(compareSemver("1.1.0", "1.0.0"), 1);
    assert.equal(compareSemver("1.0.0", "1.0.0-beta.1"), 1);
    assert.equal(compareSemver("1.0.1-beta.1", "1.0.0"), 1);
  });

  it("enforces Wallpaper Engine directory jail and zero-copy scans video/web items", () => {
    const weDir = path.join(tmpWorkdir, "we_mock_431960");
    const vidProj = path.join(weDir, "1001");
    const webProj = path.join(weDir, "1002");
    fs.mkdirSync(vidProj, { recursive: true });
    fs.mkdirSync(webProj, { recursive: true });
    fs.writeFileSync(path.join(vidProj, "project.json"), JSON.stringify({ title: "4K Anime Loop", type: "video", file: "loop.mp4", preview: "preview.jpg" }));
    fs.writeFileSync(path.join(vidProj, "loop.mp4"), Buffer.alloc(1024, 0x41));
    fs.writeFileSync(path.join(vidProj, "preview.jpg"), Buffer.alloc(256, 0xff));
    fs.writeFileSync(path.join(webProj, "project.json"), JSON.stringify({ title: "WebGL Matrix", type: "web", file: "index.html" }));
    fs.writeFileSync(path.join(webProj, "index.html"), "<html><body>ok</body></html>");

    const sceneProj = path.join(weDir, "1003");
    fs.mkdirSync(sceneProj, { recursive: true });
    fs.writeFileSync(path.join(sceneProj, "project.json"), JSON.stringify({ title: "4K DirectX Scene", type: "scene", file: "scene.json", preview: "preview.gif" }));
    fs.writeFileSync(path.join(sceneProj, "scene.pkg"), Buffer.alloc(2048, 0x50));
    fs.writeFileSync(path.join(sceneProj, "preview.gif"), Buffer.alloc(128, 0x47));

    // Directory jail must reject parent traversal
    assert.equal(isPathInsideDir(path.join(vidProj, "loop.mp4"), weDir), true);
    assert.equal(isPathInsideDir(path.resolve(weDir, "..", "outside.mp4"), weDir), false);

    const items = scanAuthorizedWallpaperLibrary([weDir], true);
    assert.equal(items.length, 3);
    assert.equal(items.some((i) => i.title === "4K Anime Loop" && i.we_type === "video" && i.lossless_in_browser === true), true);
    assert.equal(items.some((i) => i.title === "WebGL Matrix" && i.we_type === "web" && i.lossless_in_browser === true), true);
    // Scene (.pkg) must NEVER fake 4K with preview.gif and NEVER touch user's desktop!
    assert.equal(items.some((i) => i.title === "4K DirectX Scene" && i.we_type === "scene" && i.playable === false && i.lossless_in_browser === false), true);
  });

  it("persists custom system_prompt (multiline, empty, numeric/JSON text) reliably via PUT /api/settings", async () => {
    const customPrompt = "你是我的专属编程架构师。\n要求：\n1. 只输出核心思路\n2. 严禁废话";
    const r1 = await fetch(`${studioServer.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt: customPrompt, prompt_mode: "append" }),
    }).then((r) => r.json());
    assert.equal(r1.ok, true);
    assert.equal(r1.settings.system_prompt, customPrompt);
    assert.equal(r1.settings.prompt_mode, "append");

    // Read back via GET /api/settings to confirm SQLite persistence
    const g1 = await fetch(`${studioServer.url}/api/settings`).then((r) => r.json());
    assert.equal(g1.system_prompt, customPrompt);
    assert.equal(g1.prompt_mode, "append");

    // Pure numeric / JSON-like prompt must stay string (never coerced by JSON.parse)
    const r2 = await fetch(`${studioServer.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt: "12345" }),
    }).then((r) => r.json());
    assert.equal(typeof r2.settings.system_prompt, "string");
    assert.equal(r2.settings.system_prompt, "12345");

    // Empty custom prompt must persist as "" and never silently revert to default
    const r3 = await fetch(`${studioServer.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt: "", prompt_mode: "replace" }),
    }).then((r) => r.json());
    assert.equal(r3.settings.system_prompt, "");
    const g3 = await fetch(`${studioServer.url}/api/settings`).then((r) => r.json());
    assert.equal(g3.system_prompt, "");
  });

  it("auto-falls back without 400 error when upstream relay rejects enable_thinking/reasoning_effort", async () => {
    // Spin up a strict mock relay that rejects enable_thinking & reasoning_effort with HTTP 400 (like some NewAPI/OneAPI routes)
    let attempts = 0;
    const strictRelay = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      attempts++;
      if (body.enable_thinking !== undefined || body.reasoning_effort !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "the request parameters were rejected by the model provider" } }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "兼容回退成功" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise((r) => strictRelay.listen(0, "127.0.0.1", r));
    const strictUrl = `http://127.0.0.1:${strictRelay.address().port}`;
    try {
      const saved = await fetch(`${studioServer.url}/api/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Strict Relay",
          kind: "openai",
          base_url: strictUrl,
          api_key: "sk-strict-test-key",
          default_model: "deepseek-v4.1-flash",
          models: ["deepseek-v4.1-flash"],
        }),
      }).then((r) => r.json());
      const res = await fetch(`${studioServer.url}/proxy/provider/${saved.provider.id}/on/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "OPENCODE_STUDIO_PROXY" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          max_tokens: 128,
          stream: true,
          messages: [{ role: "user", content: "测试开启思考兼容性" }],
        }),
      });
      assert.equal(res.status, 200);
      const sse = await res.text();
      assert.ok(sse.includes("兼容回退成功"));
      assert.ok(attempts >= 2);
      deleteProvider(saved.provider.id);
    } finally {
      await new Promise((r) => strictRelay.close(r));
    }
  });

  it("syncs disk memories bidirectionally without duplicates and injects full memory indexes in native/append/replace modes", async () => {
    resetMemorySyncCache();
    const claudeRoot = getActiveClaudeMemoryRoot();
    const legacyMemDir = path.join(claudeRoot, "projects", "-mnt-legacy-home", "memory");
    fs.mkdirSync(legacyMemDir, { recursive: true });

    const longPadding = "这是一段超过二百二十字符的详细项目索引背景说明。".repeat(30);
    const sentinel = "PROJECT_SENTINEL_ALPHA_9981";
    const memoryMd = `# 记忆索引\n\n${longPadding}\n\n## 活跃项目\n- [关键项目 Alpha](project_alpha.md) — ${sentinel}\n`;
    const alphaFile = path.join(legacyMemDir, "project_alpha.md");

    fs.writeFileSync(path.join(claudeRoot, "CLAUDE.md"), "# 全局规则\n始终遵守严格核验原则。\n", "utf8");
    fs.writeFileSync(path.join(legacyMemDir, "MEMORY.md"), memoryMd, "utf8");
    fs.writeFileSync(alphaFile, "---\nname: project-alpha\ntype: project\n---\n\n初始 Alpha 详情\n", "utf8");

    // 1. GET /api/memories auto-discovers disk memories with zero duplicates on repeated calls
    const list1 = await fetch(`${studioServer.url}/api/memories`).then((r) => r.json());
    const alphaRow = list1.memories.find((m) => m.title === "project-alpha");
    assert.ok(alphaRow, "disk memory project_alpha.md should be synced into SQLite");
    const countBefore = list1.memories.length;
    const list2 = await fetch(`${studioServer.url}/api/memories`).then((r) => r.json());
    assert.equal(list2.memories.length, countBefore, "repeated sync must never duplicate memory rows");

    // 2. Native prompt_mode must STILL inject complete (non-220-char-truncated) memory index & cross-cwd paths
    await fetch(`${studioServer.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt: "CUSTOM_BASE_PROMPT_XYZ", prompt_mode: "native" }),
    });
    const nativeBuilt = buildCustomPromptAndMcp(tmpWorkdir, "native");
    assert.equal(nativeBuilt.promptFlag, "--append-system-prompt-file");
    assert.ok(!nativeBuilt.promptText.includes("CUSTOM_BASE_PROMPT_XYZ"), "native mode keeps Claude default base prompt");
    assert.ok(nativeBuilt.promptText.includes(sentinel), "native mode must inject full MEMORY.md past 220 chars");
    assert.ok(nativeBuilt.promptText.includes("-mnt-legacy-home"), "must expose cross-cwd memory library path");

    // 3. Replace prompt_mode must use --system-prompt-file with BOTH custom base prompt & full memories
    await fetch(`${studioServer.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_prompt: "CUSTOM_BASE_PROMPT_XYZ", prompt_mode: "replace" }),
    });
    const replaceBuilt = buildCustomPromptAndMcp(tmpWorkdir, "native");
    assert.equal(replaceBuilt.promptFlag, "--system-prompt-file");
    assert.ok(replaceBuilt.promptText.includes("CUSTOM_BASE_PROMPT_XYZ"));
    assert.ok(replaceBuilt.promptText.includes(sentinel));

    // 4. API direct engine also injects full memory index without 220-char truncation
    const apiSysPrompt = buildTransparentSystemPrompt(tmpWorkdir);
    assert.ok(apiSysPrompt.includes(sentinel));

    // 5. Bidirectional sync: editing a synced memory in Web UI writes straight back to its disk .md file
    const updatedContent = "---\nname: project-alpha\ntype: project\n---\n\n已通过工作台更新 Alpha 详情\n";
    const postRes = await fetch(`${studioServer.url}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: alphaRow.id,
        scope: alphaRow.scope,
        cwd: alphaRow.cwd,
        title: alphaRow.title,
        category: alphaRow.category,
        content: updatedContent,
        pinned: alphaRow.pinned,
      }),
    }).then((r) => r.json());
    assert.equal(postRes.disk_synced, true);
    assert.equal(fs.readFileSync(alphaFile, "utf8"), updatedContent);

    // 6. Deleting a synced memory via DELETE /api/memories/:id must NOT resurrect on subsequent GET /api/memories!
    const delRes = await fetch(`${studioServer.url}/api/memories/${encodeURIComponent(alphaRow.id)}`, {
      method: "DELETE",
    }).then((r) => r.json());
    assert.equal(delRes.ok, true);
    const listAfterDel = await fetch(`${studioServer.url}/api/memories`).then((r) => r.json());
    assert.equal(listAfterDel.memories.some((m) => m.id === alphaRow.id), false, "deleted disk memory must never ghost-resurrect");
  });

  it("preserves literal $&, $$, $1 patterns in edit_file without regex replacement corruption", async () => {
    const ctx = { cwd: tmpWorkdir, signal: new AbortController().signal };
    await executeBuiltinTool("write_file", { file_path: "dollar.sh", content: "PRICE=old_val\nEND=1\n" }, ctx);
    const special = "PRICE=$100 && echo $& $$ $' $`";
    const ed = await executeBuiltinTool(
      "edit_file",
      { file_path: "dollar.sh", old_string: "PRICE=old_val", new_string: special },
      ctx,
    );
    assert.equal(ed.ok, true);
    const raw = fs.readFileSync(path.join(tmpWorkdir, "dollar.sh"), "utf8");
    assert.equal(raw, `${special}\nEND=1\n`);
  });

  it("supports FTS5 >=3-char search, <3-char CJK fallback, session pinning, DB optimize, provider test & ETag/Gzip", async () => {
    // 1. Sub-80ms non-blocking /api/bootstrap + static Gzip & 304 ETag negotiation
    const tBoot = performance.now();
    const bootRes = await fetch(`${studioServer.url}/api/bootstrap`);
    const bootJson = await bootRes.json();
    const bootMs = performance.now() - tBoot;
    assert.equal(bootRes.status, 200);
    assert.ok(bootJson.db_stats, "bootstrap includes db_stats");
    assert.ok(bootMs < 1200, `/api/bootstrap should respond without blocking spawnSync (took ${bootMs.toFixed(1)}ms)`);

    const asset1 = await fetch(`${studioServer.url}/app.js`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(asset1.status, 200);
    const etag = asset1.headers.get("etag");
    assert.ok(etag, "static asset must return ETag");
    await asset1.arrayBuffer();
    const asset304 = await fetch(`${studioServer.url}/app.js`, { headers: { "If-None-Match": etag } });
    assert.equal(asset304.status, 304);

    // 2. Session pinning + FTS5 trigram (>=3 chars) + short CJK (<3 chars) search
    const s1 = createSession({ title: "普通会话一", cwd: tmpWorkdir });
    const s2 = createSession({ title: "置顶架构会话", cwd: tmpWorkdir });
    addMessage({ sessionId: s1.id, role: "user", contentText: "排查 PostgreSQL 索引锁等待问题与优化方案" });
    addMessage({ sessionId: s2.id, role: "user", contentText: "设计分布式缓存架构" });

    await fetch(`${studioServer.url}/api/sessions/${encodeURIComponent(s2.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    const allListed = await fetch(`${studioServer.url}/api/sessions`).then((r) => r.json());
    assert.equal(allListed.sessions[0].id, s2.id, "pinned session must sort first");
    assert.equal(allListed.sessions[0].pinned, true);

    // FTS5 trigram (>= 3 chars)
    const ftsHit = await fetch(`${studioServer.url}/api/sessions?q=${encodeURIComponent("索引锁等待")}`).then((r) => r.json());
    assert.ok(ftsHit.sessions.some((s) => s.id === s1.id && s.match_snippet?.includes("索引锁等待")));

    // Short 2-char CJK query fallback
    const shortHit = await fetch(`${studioServer.url}/api/sessions?q=${encodeURIComponent("缓存")}`).then((r) => r.json());
    assert.ok(shortHit.sessions.some((s) => s.id === s2.id));

    // 3. Provider live connectivity test endpoint
    const testConn = await fetch(`${studioServer.url}/api/providers/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Temp Probe",
        kind: "openai",
        base_url: mockLlmUrl,
        api_key: "sk-probe-123",
        default_model: "gpt-4o",
      }),
    }).then((r) => r.json());
    assert.equal(testConn.ok, true);
    assert.equal(typeof testConn.latency_ms, "number");

    // 4. Delete session -> archived -> purge via POST /api/db/optimize
    await fetch(`${studioServer.url}/api/sessions/${encodeURIComponent(s1.id)}`, { method: "DELETE" });
    const optRes = await fetch(`${studioServer.url}/api/db/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purge_archived: true }),
    }).then((r) => r.json());
    assert.equal(optRes.ok, true);
    assert.ok(optRes.purged_sessions >= 1);
    assert.equal(optRes.after.sessions_archived, 0);
  });

  it("translates interleaved thinking -> text -> tool_call -> text streams with valid block indices", async () => {
    const interleavedRelay = http.createServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先思考第一步" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "前置说明。" } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_il_1", type: "function", function: { name: "list_dir", arguments: "{}" } }] } }],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "后置补充说明。" }, finish_reason: "tool_calls" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise((r) => interleavedRelay.listen(0, "127.0.0.1", r));
    const ilUrl = `http://127.0.0.1:${interleavedRelay.address().port}`;
    try {
      const saved = saveProvider({
        name: "Interleaved Relay",
        kind: "openai",
        base_url: ilUrl,
        api_key: "sk-il",
        default_model: "gpt-4o",
      });
      const res = await fetch(`${studioServer.url}/proxy/provider/${saved.id}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "go" }] }),
      });
      const sse = await res.text();
      const starts = [...sse.matchAll(/data: (\{"type":"content_block_start"[^\n]+)/g)].map((m) => JSON.parse(m[1]));
      assert.equal(starts.length, 4, "must open 4 distinct content blocks (thinking=0, text=1, tool=2, text=3)");
      assert.deepEqual(starts.map((s) => s.index), [0, 1, 2, 3]);
      deleteProvider(saved.id);
    } finally {
      await new Promise((r) => interleavedRelay.close(r));
    }
  });

  it("supports v2.2 zero-key web search parsers, built-in opencode_web MCP stdio server, WE pkg-video HTTP 206 & CEF Web shim", async () => {
    // 1. Live Web Search RSS & DuckDuckGo HTML parsers
    const { parseRssSearchItems, parseDuckDuckGoHtmlItems } = await import("../server/web_search.mjs");
    const rssXml = `<?xml version="1.0" encoding="utf-8"?><rss><channel>
      <item>
        <title><![CDATA[Node.js 24 LTS Released]]></title>
        <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fnodejs.org%2fen%2fblog%2frelease</link>
        <description><![CDATA[Official Node.js release notes &amp; performance highlights.]]></description>
        <pubDate>Tue, 24 Nov 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
    const rssItems = parseRssSearchItems(rssXml, "bing_news");
    assert.equal(rssItems.length, 1);
    assert.equal(rssItems[0].title, "Node.js 24 LTS Released");
    assert.equal(rssItems[0].url, "https://nodejs.org/en/blog/release");
    assert.ok(rssItems[0].snippet.includes("Official Node.js release notes & performance"));

    const ddgHtml = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmodelcontextprotocol.io%2Fspecification">MCP Official Spec</a>
        <a class="result__snippet">Model Context Protocol <b>open</b> standard.</a>
      </div>`;
    const ddgItems = parseDuckDuckGoHtmlItems(ddgHtml);
    assert.equal(ddgItems.length, 1);
    assert.equal(ddgItems[0].url, "https://modelcontextprotocol.io/specification");
    assert.equal(ddgItems[0].snippet, "Model Context Protocol open standard.");

    // 2. Built-in opencode_web MCP server mounts into Claude config when webSearchEnabled=true & answers JSON-RPC initialize + tools/list
    const mcpOn = buildCustomPromptAndMcp(tmpWorkdir, "native", { webSearchEnabled: true });
    assert.ok(mcpOn.mcpConfigPath, "must generate active_mcp_config.json when webSearchEnabled=true");
    const mcpJson = JSON.parse(fs.readFileSync(mcpOn.mcpConfigPath, "utf8"));
    assert.ok(mcpJson.mcpServers?.opencode_web, "must mount opencode_web MCP server");

    const { spawn } = await import("node:child_process");
    const mcpProc = spawn(process.execPath, [mcpJson.mcpServers.opencode_web.args[0]], {
      env: { ...process.env, OPENCODE_DATA_DIR: tmpRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpcLines = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP stdio timeout")), 5000);
      let buf = "";
      mcpProc.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) rpcLines.push(JSON.parse(line));
          if (rpcLines.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      mcpProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
      mcpProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    });
    mcpProc.kill();
    assert.equal(rpcLines[0].result?.serverInfo?.name, "opencode_web");
    const toolNames = (rpcLines[1].result?.tools || []).map((t) => t.name);
    assert.deepEqual(toolNames, ["web_search", "web_read_page"]);

    // 3. Curated 14 live wallpapers + favorite_wallpapers & web_search_enabled persistence
    assert.equal(CURATED_WALLPAPERS.filter((w) => w.type === "live").length, 14);
    assert.ok(CURATED_WALLPAPERS.some((w) => w.liveBg === "live-fireflies"));
    assert.ok(CURATED_WALLPAPERS.some((w) => w.liveBg === "live-cybergrid"));

    const favRes = await fetch(`${studioServer.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        web_search_enabled: false,
        favorite_wallpapers: [{ id: "fav-1", name: "测试收藏", type: "live", liveBg: "live-aurora" }],
      }),
    }).then((r) => r.json());
    assert.equal(favRes.settings.web_search_enabled, false);
    assert.equal(favRes.settings.favorite_wallpapers.length, 1);

    // 4. Wallpaper Engine: PKGV single-embedded MP4 zero-copy HTTP 206 streaming + CEF Web Audio/Property shim injection
    const weAdvDir = path.join(tmpWorkdir, "we_adv_431960");
    const pkgVidDir = path.join(weAdvDir, "2001");
    const webAudioDir = path.join(weAdvDir, "2002");
    fs.mkdirSync(pkgVidDir, { recursive: true });
    fs.mkdirSync(webAudioDir, { recursive: true });

    // Build a valid PKGV archive with 1 embedded MP4 entry (ftypisom signature at offset +4, >200KB main video threshold)
    const mp4Payload = Buffer.alloc(210_000, 0x22);
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(mp4Payload, 0);
    const verStr = Buffer.from("PKGV0002", "utf8");
    const entryName = Buffer.from("materials/bg.mp4", "utf8");
    const pkgHeader = Buffer.alloc(4 + verStr.length + 4 + 4 + entryName.length + 8);
    let pos = 0;
    pkgHeader.writeUInt32LE(verStr.length, pos); pos += 4;
    verStr.copy(pkgHeader, pos); pos += verStr.length;
    pkgHeader.writeUInt32LE(1, pos); pos += 4; // count = 1
    pkgHeader.writeUInt32LE(entryName.length, pos); pos += 4;
    entryName.copy(pkgHeader, pos); pos += entryName.length;
    pkgHeader.writeUInt32LE(0, pos); pos += 4; // offset = 0
    pkgHeader.writeUInt32LE(mp4Payload.length, pos); pos += 4; // length
    fs.writeFileSync(path.join(pkgVidDir, "project.json"), JSON.stringify({ title: "Pkg Embedded 4K Video", type: "scene" }));
    fs.writeFileSync(path.join(pkgVidDir, "scene.pkg"), Buffer.concat([pkgHeader, mp4Payload]));

    // Build a Web wallpaper with user properties in project.json
    fs.writeFileSync(
      path.join(webAudioDir, "project.json"),
      JSON.stringify({
        title: "Audio Spectrum Web",
        type: "web",
        file: "index.html",
        general: { properties: { speed: { value: 1.5 }, themeColor: { value: "0.2 0.6 1.0" } } },
      }),
    );
    fs.writeFileSync(path.join(webAudioDir, "index.html"), "<!doctype html><html><head><title>WE</title></head><body>canvas</body></html>");

    const authRes = await fetch(`${studioServer.url}/api/we/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add_dir: weAdvDir }),
    }).then((r) => r.json());
    assert.equal(authRes.ok, true);
    const pkgItem = authRes.items.find((i) => i.title === "Pkg Embedded 4K Video");
    const webItem = authRes.items.find((i) => i.title === "Audio Spectrum Web");
    assert.ok(pkgItem && pkgItem.playable && pkgItem.play_mode === "video", "PKGV embedded MP4 should be unlocked as playable video");
    assert.ok(webItem && webItem.playable && webItem.play_mode === "web");

    // Verify HTTP 206 Byte-Range streaming from inside scene.pkg!
    const rangeRes = await fetch(`${studioServer.url}${pkgItem.stream_url}`, {
      headers: { Range: "bytes=4-11" },
    });
    assert.equal(rangeRes.status, 206);
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(rangeBuf.toString("ascii"), "ftypisom");

    // Verify CEF Web runtime shim injection in served HTML
    const webHtml = await fetch(`${studioServer.url}${webItem.stream_url}`).then((r) => r.text());
    assert.ok(webHtml.includes("wallpaperRegisterAudioListener"), "must inject WE audio spectrum shim");
    assert.ok(webHtml.includes("applyUserProperties"), "must inject WE user properties listener hook");
    assert.ok(webHtml.includes('"speed"'), "must pass project.json default property values");
  });

  it("detects nested electron-builder app.asar.unpacked Claude Code binary and supports one-click reset to bundled", async () => {
    const { clearRuntimeCache, getClaudeRuntimeAndAuth } = await import("../server/claude_runtime.mjs");
    const mockResDir = path.join(tmpWorkdir, "mock_electron_resources");
    const binName = process.platform === "win32" ? "claude.exe" : "claude";
    const subPkg = `claude-code-${process.platform}-${process.arch}`;
    const nestedPkgDir = path.join(
      mockResDir,
      "app.asar.unpacked",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "node_modules",
      "@anthropic-ai",
      subPkg,
    );
    const parentPkgDir = path.join(mockResDir, "app.asar.unpacked", "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(nestedPkgDir, { recursive: true });
    fs.writeFileSync(path.join(parentPkgDir, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.323" }));
    fs.writeFileSync(path.join(nestedPkgDir, "package.json"), JSON.stringify({ name: `@anthropic-ai/${subPkg}`, version: "2.1.323" }));
    const nestedBinPath = path.join(nestedPkgDir, binName);
    fs.writeFileSync(nestedBinPath, Buffer.alloc(64, 0x7f));

    const origResourcesPath = process.resourcesPath;
    process.resourcesPath = mockResDir;
    try {
      clearRuntimeCache();
      const fastSnap = getClaudeRuntimeAndAuth(false);
      assert.equal(fastSnap.installed, true, "must detect nested electron-builder unpacked binary on cold boot");
      assert.equal(fastSnap.bundled, true);
      assert.equal(path.resolve(fastSnap.binary), path.resolve(nestedBinPath));
      assert.ok(String(fastSnap.version || "").includes("2.1.323"));
    } finally {
      if (origResourcesPath === undefined) delete process.resourcesPath;
      else process.resourcesPath = origResourcesPath;
      clearRuntimeCache();
    }

    // Verify POST /api/claude/reset-bundled cleans up private runtime overrides safely
    const resetRes = await fetch(`${studioServer.url}/api/claude/reset-bundled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    assert.equal(resetRes.ok, true);
    assert.ok(resetRes.runtime);
  });
});
