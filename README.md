# OpenCode Studio

**内置官方原生 Claude Code 的全平台开箱即用工作台** —— 面向开发者与学生，支持 Windows / macOS / Linux 三端。安装包已直接随包内嵌对应平台的官方原生 Claude Code，**零命令行安装、零代理翻墙、双击即用**，并内置多 API 透明协议代理、官方完整 OAuth 登录、国内直连/代理双模式全网商店以及可高度自定义的极简对话外观。

## 核心特性

- **100% 纯净原生 Claude Code 内核（随安装包自带，彻底告别双引擎与外部切换器）**
  - **安装包开箱自带原生 Claude Code & 与系统原有 Claude Code 零冲突隔离**：Windows (`.exe`) / macOS (`.dmg`) / Linux (`.AppImage` & `.deb`) 均随包内嵌对应平台官方原生 `claude` 二进制；默认启用独立配置目录 (`CLAUDE_CONFIG_DIR`) 与私有升级目录 (`claude-runtime`)，**绝不读取、覆写或污染用户电脑原有的 `~/.claude/`、`~/.local/bin/claude` 与 CLI 会话历史**（也可在设置中按需切换为共享系统目录）。
  - **直接粘贴/拖拽任意文件对话**：输入框支持 `Ctrl+V` 直接粘贴或拖拽 `.txt`、代码、JSON/CSV、PDF、图片等任意文件，小文本文件自动内联送入上下文、大文件/文档自动落盘并交由原生 Claude Code 直接读取。
  - **完整官方 Auth 登录**：内置调用原生 `claude auth login`（支持 `claude.com` 订阅账号与 `platform.claude.com` Anthropic Console），自动由系统前台拉起浏览器授权并支持授权码回填。
  - **内置多 API 透明协议代理（免代理直连）**：自动确保原生 Claude Code 免引导直连，通过本机透明代理 `/proxy/provider/:id` + Anthropic ↔ OpenAI 实时 SSE 协议翻译无缝驱动任意国内/海外 API；彻底隔离旧 `~/.claude/settings.json` 干扰且不篡改原文件。
  - **系统提示词即时置换 & 遥测关闭**：支持 `--system-prompt` 完全替换或 `--append-system-prompt` 追加，并配合 `--system-prompt-snapshot off` 让老会话也即时生效。
  - **Claude Code 内核版本检测与安全切换**：先「检测版本」对比本机当前版本与官方稳定版 (`stable`) / 最新版 (`latest`)，默认在私有隔离目录内完成切换，绝不覆盖用户本机原有 CLI。
- **双模式全网实时搜索引擎（国内直连引擎 ↔ 海外代理引擎，零大体积存储）**
  - **自动探测 / 手动一键切换**：无代理环境自动启用**国内直连全网引擎**（必应全网亿级 4K 静态壁纸与海量动态 GIF + 淘宝 npmmirror 全库 MCP/Skills + jsDelivr 国内加速 CDN 官方 Skills），有代理环境自动启用**代理全网引擎**（Wallhaven 4K + Wikimedia 开源动态视频 + 官方 MCP Registry + GitHub 全网 API）。
- **高颜值自定义对话框、高清/动态壁纸与离线持久化**
  - 支持**高清原版**与**隐性护眼**壁纸模式、内置 12 套 60fps Canvas 动态壁纸 + 全网海量动态 GIF/视频 + 本地视频上传；
  - **独立导入 Steam Wallpaper Engine (431960) & 本地 4K 大视频壁纸库（与桌面完全独立、绝不干扰桌面壁纸）**：
    - 通过本机真实 Steam 客户端安全打开 Wallpaper Engine 逛创意工坊；显式只读授权后零拷贝直连原版 `Video`（数百 MB ~ 数 GB 4K/8K 60fps 长动画）、`Web`（HTML5/WebGL 互动壁纸）与本地 4K 原图；
    - 0 压缩、0 复制、0 额外占用、断网可用，你的 Windows 桌面与 OpenCode Studio 各用各的壁纸、互不干扰！
  - **断网离线可用 & 自动删旧不撑盘**：选中任意在线壁纸时自动固化为本地唯一离线快照（断网重启照常显示），切换新壁纸时立即自动删除旧快照；商店预览缩略图缓存严格限制在 **35MB** 内并支持一键清理，删除自定义壁纸同步清理磁盘文件。
  - 支持自定义对话框样式：**「对话框 · 有边框」**（可独立滑块 0%~100% 自定义透明度）或 **「纯文字 · 无边框」**（直接呈现纯净锐利文字），以及左右两边栏独立透明度调节！

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
