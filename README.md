# LLM Media Library

一个使用 **TypeScript + Tauri 2** 开发的桌面应用（主要面向 Windows），用于收藏 YouTube 视频，
并通过 Google Gen AI SDK（Gemini）自动获取视频信息、生成【结构化时间戳逐字稿】。

## 功能

- 输入 YouTube 链接（`watch?v=`、`youtu.be/`、`shorts/`、`live/`、`embed/` 或直接输入视频 ID）即可收藏
- 使用 `@google/genai` 调用 Gemini（`GEMINI_API_KEY` / `GEMINI_API_MODEL`）获取：
  封面、标题、作者、发布时间、视频时长、视频介绍
  - 封面从 `i.ytimg.com` 下载并保存到数据目录的 `thumbnails/` 中，界面始终从本地加载；标题/作者另外用 YouTube oEmbed 校正（尽力而为）
- 使用 Issue 中给定的提示词，让 Gemini 直接“观看”视频并生成时间戳逐字稿
- 首页以卡片式网格（Card-based Grid Layout）展示所有收藏，支持搜索
- 点击封面打开详情：内嵌播放器播放、查看完整信息与逐字稿；**点击逐字稿中的时间戳可跳转播放**
- 可以重新生成逐字稿 / 刷新信息 / 复制逐字稿 / 删除

## 数据目录（data 目录）

首次启动时，应用会要求用户 **明确选择数据目录**（默认建议 `文档\LLMMediaLibrary`）。
所选路径记录在系统应用配置目录（Windows：`%APPDATA%\com.walksky.llmmedialibrary\settings.json`），
之后可在「⚙ 设置」中更改。数据目录内容：

| 文件 | 说明 |
| --- | --- |
| `library.db` | SQLite 数据库，保存收藏的视频列表（含元数据与逐字稿） |
| `thumbnails/` | 视频封面图（本地保存，界面只从本地加载封面） |
| `.env` | Gemini 配置（可在设置界面中填写后自动写入） |

> 从旧版本升级：若数据目录中存在旧的 `library.json`，首次打开时会自动导入到 `library.db`，
> 并将原文件重命名为 `library.json.migrated`；缺失的封面会在后台自动下载到 `thumbnails/`。

## Gemini 配置（.env）

```env
GEMINI_API_KEY=your-gemini-api-key
GEMINI_API_MODEL=gemini-2.5-flash
```

应用按以下顺序查找 `.env`（每个键取第一个非空值）：

1. `数据目录\.env`
2. 应用程序 exe 所在目录下的 `.env`
3. 当前工作目录（及其上级目录，便于 `tauri dev` 使用项目根目录的 `.env`）
4. 系统环境变量 `GEMINI_API_KEY` / `GEMINI_API_MODEL`

未设置 `GEMINI_API_MODEL` 时默认使用 `gemini-2.5-flash`。

## 开发

前置条件：Node.js 20+、Rust（stable），以及 Tauri 的 [系统依赖](https://tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev      # 开发模式运行
npm test               # 前端单元测试（vitest）
npm run typecheck      # TypeScript 类型检查
cd src-tauri && cargo test   # Rust 单元测试
```

## 在 Windows 上构建 Windows 安装包

前置条件：Node.js 20+、Rust（rustup，MSVC 工具链）、Visual Studio Build Tools
（勾选“使用 C++ 的桌面开发”），详见 [Tauri 前置条件](https://tauri.app/start/prerequisites/#windows)。
Windows 本机构建直接使用 MSVC，**不需要** `cargo-xwin`。

```powershell
npm.cmd install
npm.cmd run build:windows        # NSIS 安装包（.exe）
npm.cmd run build:windows:msi    # 可选：MSI 安装包（首次会自动下载 WiX）
```

或使用一键脚本（会检查工具链、安装 Rust 目标、按需 `npm install`）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1        # NSIS
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Msi   # MSI
```

生成的安装包位于 `src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\`（或 `bundle\msi\`）。

## 在 Linux 上交叉编译 Windows 安装包

参考 [Tauri 官方文档](https://tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos)，
在 Linux 上只能生成 **NSIS** 安装包（`.exe`），不能生成 MSI。

**一键脚本（推荐，Debian/Ubuntu，无需 root）：**

```bash
./scripts/build-windows.sh
```

脚本会检查 `makensis` / `llvm-rc` / `lld-link` / `clang-cl`，缺失时通过 `apt-get download`
下载并解压到 `~/.local/xtools`（不需要 sudo），然后安装 `x86_64-pc-windows-msvc` 目标与
`cargo-xwin` 并执行构建（`npm run build:windows:cross`）。

**手动步骤：**

```bash
# 1. 安装 NSIS、LLVM（提供 llvm-rc、lld-link、clang）
sudo apt install nsis lld llvm clang          # Debian / Ubuntu
# 2. 添加 Windows 目标与 cargo-xwin（会自动下载 MSVC CRT 与 Windows SDK）
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
# 3. 构建
npm install
npm run build:windows:cross
```

生成的安装包位于：

```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/LLM Media Library_0.1.0_x64-setup.exe
```

在 Windows 上运行安装程序（默认按当前用户安装，无需管理员权限）。Windows 10/11 自带 WebView2；
旧系统上安装程序会自动下载 WebView2 运行时。安装后首次启动会要求选择数据目录。

## 项目结构

```
src/                 前端（TypeScript，无框架）
  main.ts            UI：数据目录设置、卡片网格、详情/播放、设置
  lib/youtube.ts     YouTube 链接解析、封面/嵌入地址
  lib/gemini.ts      Google Gen AI SDK 调用（元数据 + 逐字稿）
  lib/transcript.ts  逐字稿提示词与解析（可点击时间戳）
  lib/metadata.ts    Gemini JSON 响应解析与规范化
  lib/library.ts     收藏列表工具函数
  lib/backend.ts     Tauri 命令封装
src-tauri/           Rust 后端：数据目录、library.json 读写、.env 解析
tests/               vitest 单元测试
```
