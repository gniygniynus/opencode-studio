# OpenCode Studio

**开源透明、跨平台、开箱即用的个人 AI Agent 工作台** —— 面向开发者与学生，支持 Windows / macOS / Linux 三端，零遥测、零黑盒注入，完整掌控你的提示词、模型、工具与对话历史。

## 核心特性

- **100% 开源透明双引擎架构（统一会话树，无缝丝滑互切）**
  - **主引擎（开源自研 API 内核，默认）**：原生直连 Anthropic Messages 与 OpenAI 兼容协议，完整内置跨平台终端（Windows PowerShell / macOS & Linux Bash）、文件读写与精准 Diff 编辑、Glob/Grep 搜索、网页抓取、多模态识图、MCP 客户端、Skills 注入与 `/compact` 自动压缩；发给模型的系统提示词 100% 透明可自定义。
  - **兼容引擎（Claude 原生订阅登录，可选）**：若本机已登录官方 Claude Code CLI，可随时切换为原生会员登录模式；环境变量完全隔离，不与 API 供应商冲突，对话历史由统一 SQLite 数据库衔接，会员与 API 随时无痛互切。
- **内置多供应商与模型能力自适应（彻底告别外部切换器）**
  - 供应商 API Key 本地 AES-256-GCM 加密存储，绝不上传。
  - 一键拉取 `/v1/models`，自动识别模型的**思考能力、思考等级制式（Anthropic budget / OpenAI reasoning_effort / 开关型 / 无思考）、上下文窗口（128k / 200k / 240k / 1M）与识图能力**；对话界面直接清晰显示所选供应商的真实模型名。
- **修改历史对话重发 + 无损分支切换**
  - 任意历史提问支持就地「编辑重发」，自动创建新分支并保留旧分支，随时 `◀ 2/2 ▶` 无损来回切换。
- **多窗口并发安全与精准找对话**
  - 单实例后端 + SQLite WAL 事务锁 + 按会话并发锁 + 记忆版本乐观锁：多会话真并发互不阻塞，多窗口实时同步不乱上下文。
  - 跨全部会话中英文全文检索 + 本会话提问目录精准跳转 + `Ctrl+F` 会话内高亮搜索 + 文件改动统计。
- **三大开源联网商店（精选展示 + 联网搜索 + 一键启用）**
  - **MCP 商店**：精选官方开源 MCP + 联网搜索 npm / GitHub 开源 MCP，一键配置安装即生效。
  - **Skills 商店**：精选教学/代码审查/排障技能 + 联网检索 GitHub 开源 Skills 一键下载。
  - **背景壁纸与外观商店**：舒适中文字体排版、明暗主题、字号/模糊度/毛玻璃透明度调节、精选开源壁纸 + Wikimedia Commons 免费开源壁纸联网搜索 + 本地上传。
- **双通道更新器与 AI 排障中心**
  - 内置检测 GitHub Releases **稳定版（`stable`）** 与 **最新版（`latest`）**，按系统推荐安装包。
  - 全链路结构化脱敏日志 + 故障分层错误卡片 + 一键复制 Markdown AI 排障报告。

---

## 快速开始（学生开箱即用）

### 方式一：下载桌面安装包（最简单，推荐学生）
前往本仓库的 [Releases 页面](https://github.com/gniygniynus/opencode-studio/releases) 下载对应系统安装包：
- **Windows**：下载 `OpenCode Studio Setup ...exe` 双击安装，或下载便携版直接运行。
- **macOS**：下载对应芯片的 `.dmg`（Apple Silicon 选 `arm64`，Intel 选 `x64`）拖入「应用程序」。
  > **macOS 首次打开提示说明**：个人开源免费版未购买 Apple 付费商业签名，若首次打开提示“无法验证开发者/已损坏”，在终端运行一行命令即可放行：
  > ```bash
  > xattr -cr "/Applications/OpenCode Studio.app"
  > ```
- **Linux**：下载 `.AppImage`（`chmod +x` 后双击）或 `.deb` 安装。

### 方式二：源码直接运行（网页版 / 开发模式，需要 Node.js ≥ 22.12）
```bash
git clone https://github.com/gniygniynus/opencode-studio.git
cd opencode-studio
npm install --omit=dev
npm start
# 打开浏览器访问 http://127.0.0.1:17620
```

启动桌面窗口开发模式：
```bash
npm install
npm run desktop
```

---

## 首次配置（30 秒上手）
1. 点击左下角 **供应商卡片** → `+ 新增 API 供应商`（填入任意 OpenAI 兼容或 Anthropic 协议的 Base URL 与 API Key，或直接启用「Claude 原生订阅登录」）。
2. 点击 **联网拉取模型 & 自动识别能力** → 点击 **设为当前使用**。
3. 点击顶栏工作目录选择你的代码文件夹，开始对话！
4. 给学生使用时，建议在 **设置 → 命令执行权限模式** 中开启 **安全护栏模式**（执行删除/重置等高风险命令前弹窗确认）。

---

## 排障与日志位置
应用内置左下角「日志」面板，支持一键复制脱敏 Markdown 排障报告。本地数据与日志路径：
- Windows：`%APPDATA%\OpenCodeStudio\logs\server.jsonl`
- macOS：`~/Library/Application Support/OpenCodeStudio/logs/server.jsonl`
- Linux：`~/.config/opencode-studio/logs/server.jsonl`

## 开源协议
MIT License — 自由使用、学习与二次开发。
