# OpenCode Studio

**基于原生 Claude Code 内核打造的全平台增强工作台** —— 面向开发者与学生，支持 Windows / macOS / Linux 三端，保留原生 Claude Code 的全部强大能力，同时提供官方完整 Auth 登录、内置多 API 透明协议代理（告别第三方切换器）、自定义系统提示词与遥测关闭、稳定版/最新版内核切换以及三大联网生态商店。

## 核心特性

- **真正驱动原生 Claude Code 内核（Windows 原生 / WSL2 自动桥接 / macOS / Linux）**
  - **完整官方 Auth 登录**：内置调用原生 `claude auth status` / `claude auth login`（支持 Claude 订阅账号与 Anthropic Console OAuth）/ `claude auth logout`。
  - **内置多 API 透明协议代理（彻底告别 CC Switch）**：通过内嵌本地透明代理与 Anthropic ↔ OpenAI 实时 SSE 协议翻译（支持思考链、工具调用、多模态识图），让原生 Claude Code 无缝驱动任意 Anthropic / OpenAI 兼容 API；彻底隔离旧 `~/.claude/settings.json` 干扰，且绝不篡改原配置文件。
  - **系统提示词与隐私完全掌控**：支持通过 `--system-prompt` 完全替换或 `--append-system-prompt` 追加提示词，默认关闭遥测与自动上报环境变量。
  - **一键安装/切换 Claude Code 稳定版（`stable`）与最新版（`latest`）**：在「设置」中直接调用原生 `claude install stable|latest` 或在全新机器上自动安装，学生零命令行门槛上手。
- **内置供应商随时更新 & 模型能力自适应**
  - 对话框供应商旁一键直达编辑更新 API Key、Base URL 与模型列表；API Key 本地 AES-256-GCM 加密保存。
  - 一键拉取 `/v1/models`，自动识别模型**思考等级制式、上下文窗口（128k / 200k / 240k / 1M）与识图能力**；对话界面直接清晰显示所选供应商真实模型名。
- **优雅对话交互：编辑重发 + AI 重新回复 + 无损分支切换**
  - 气泡底部极简 SVG 符号操作栏：用户提问底部支持 ✎ 编辑重发与 ⧉ 复制，AI 回复底部支持 ↻ 重新回复（保留旧版本为可切换分支 `◀ 2/2 ▶`）与 ⧉ 复制。
  - 支持点击顶部目录胶囊弹出**系统原生文件夹选择框**自定义工作目录。
- **三大开源联网商店（防抖实时搜索 + 一键生效）**
  - **MCP 商店**：精选开源 MCP + 实时联网搜索 npm / GitHub，一键安装并挂载给原生 Claude Code（`--mcp-config`）。
  - **Skills 商店**：精选实用技能 + 实时联网搜索 GitHub 开源 Skills 一键下载启用。
  - **壁纸与外观商店**：支持**高清原版**与**隐性护眼**双显示模式、接入 Wallhaven 4K 海量壁纸实时中文搜索与无限分页加载、内置 6 套 60fps Canvas 动态壁纸，并支持上传本地 `.mp4` / `.webm` 动态视频壁纸。
- **工作台外壳双通道更新与 AI 排障中心**
  - 支持检查工作台自身的 GitHub Releases 稳定版/最新版安装包，内置结构化脱敏日志与一键复制 Markdown AI 排障报告。

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
