# LLM Media Library

一个使用 **TypeScript + Tauri 2** 开发的桌面应用（主要面向 Windows），用于收藏 YouTube 视频，
并通过 Google Gen AI SDK（Gemini）自动获取视频信息、生成【结构化时间戳逐字稿】。

## 功能

- 输入 YouTube 链接（`watch?v=`、`youtu.be/`、`shorts/`、`live/`、`embed/` 或直接输入视频 ID）即可收藏
- 使用 `@google/genai` 调用 Gemini（`GEMINI_API_KEY` / `GEMINI_API_MODEL`）获取：
  封面、标题、作者、发布时间、视频时长、视频介绍
  - 封面从 `i.ytimg.com` 下载并保存到数据目录的 `thumbnails/` 中，界面始终从本地加载；标题/作者另外用 YouTube oEmbed 校正（尽力而为）
- 使用 Issue 中给定的提示词，让 Gemini 直接“观看”视频并生成时间戳逐字稿
- 输入 GitHub 仓库地址（`https://github.com/owner/repo`、`github.com/owner/repo`、`git@github.com:owner/repo.git`
  或仓库内任意页面链接）即可收藏 GitHub 仓库：
  - 通过 GitHub API 读取仓库信息（简介、语言、Star 数等）和 README，交给 Gemini 生成中文摘要与一句话功能标题
  - 自动生成封面图片（仓库名 + 功能标题），保存到数据目录的 `thumbnails/` 中
  - 详情中可查看摘要、重新生成摘要 / 封面、在 GitHub 打开
- 首页以卡片式网格（Card-based Grid Layout）展示所有收藏，可在「全部 / YouTube / GitHub」之间切换，支持搜索
- 点击封面打开详情：内嵌播放器播放、查看完整信息与逐字稿；**点击逐字稿中的时间戳可跳转播放**
- 可以重新生成逐字稿 / 刷新信息 / 复制逐字稿 / 删除
- 「⚙ 设置 → 版本与更新」显示当前版本，并自动检查 [GitHub Releases](https://github.com/walkskysu/llm_media_library/releases)
  上是否有新版本（启动时后台检查一次，打开设置时若超过 10 分钟未检查会再次检查；有新版本时设置按钮上会出现红点）。
  也可点击「检查升级」手动检查；发现新版本时显示版本号、发布日期与更新说明，并出现「安装更新」按钮——
  点击后下载该版本的 Windows 安装包（优先 NSIS `*-setup.exe`，其次 `.msi`，仅允许本仓库 Release 中的文件），
  启动安装程序并自动退出应用。只检查正式发布的版本（草稿与预发布版本会被忽略）。

## 数据目录（data 目录）

首次启动时，应用会要求用户 **明确选择数据目录**（默认建议 `文档\LLMMediaLibrary`）。
所选路径记录在系统应用配置目录（Windows：`%APPDATA%\com.walksky.llmmedialibrary\settings.json`），
之后可在「⚙ 设置」中更改。数据目录内容：

| 文件 | 说明 |
| --- | --- |
| `library.db` | SQLite 数据库，保存收藏列表（YouTube 视频的元数据与逐字稿、GitHub 仓库的信息与摘要） |
| `thumbnails/` | 封面图（YouTube 封面下载保存、GitHub 封面本地生成，界面只从本地加载封面） |
| `conf.json` | Gemini 配置（可在设置界面中填写后自动写入） |

> 从旧版本升级：若数据目录中存在旧的 `library.json`，首次打开时会自动导入到 `library.db`，
> 并将原文件重命名为 `library.json.migrated`；缺失的封面会在后台自动下载到 `thumbnails/`。

## Gemini 配置（conf.json）

```json
{
  "GEMINI_API_KEY": "your-gemini-api-key",
  "GEMINI_API_MODEL": "gemini-2.5-flash"
}
```

可参考仓库根目录的 `conf.example.json`。应用按以下顺序查找 `conf.json`（每个键取第一个非空值）：

1. `数据目录\conf.json`
2. 应用程序 exe 所在目录下的 `conf.json`
3. 当前工作目录（及其上级目录，便于 `tauri dev` 使用项目根目录的 `conf.json`）
4. 系统环境变量 `GEMINI_API_KEY` / `GEMINI_API_MODEL`

未设置 `GEMINI_API_MODEL` 时默认使用 `gemini-2.5-flash`。

> 从旧版本升级：若数据目录中只有旧的 `.env` 而没有 `conf.json`，启动时会自动将其中的
> `GEMINI_API_KEY` / `GEMINI_API_MODEL` 转换写入 `conf.json`（原 `.env` 保留不删除）。

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

## 发布 GitHub Release

发布采用 **“草稿 + 人工发布”** 流程（`.github/workflows/release.yml`）：推送 `v*` 标签后，
GitHub Actions 在 `windows-latest` 上运行测试并构建 NSIS（`.exe`）与 MSI 安装包，然后创建一个
**草稿（Draft）Release**，附带 Windows 安装包与 `SHA256SUMS.txt`，并自动生成更新说明（GitHub
自动附带的源代码包除外，安装包需由工作流上传）。工作流**不会**自动发布；维护者检查草稿无误后，
在网页上手动点击 **Publish release** 才会正式发布。草稿对普通用户不可见，应用内的更新检查也只会
看到已发布的版本。

1. 更新版本号（同时写入 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、
   `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`）：

   ```bash
   npm run version:set -- 0.2.0
   npm run version:check
   ```

2. 提交并通过 PR 合并到 `main`（CI 会检查各文件版本号是否一致、类型检查与单元测试）。
3. 在 `main` 上打标签并推送：

   ```bash
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. 等待 Actions 中的 **Release** 工作流完成（运行摘要中会给出草稿链接），打开
   [Releases 页面](https://github.com/walkskysu/llm_media_library/releases) 找到 `v0.2.0` 的草稿。
5. 人工检查草稿：确认 `*-setup.exe`、`.msi` 与 `SHA256SUMS.txt` 均已附带，按需编辑标题与更新说明
   （预发布版本可确认已勾选 Pre-release）。
6. 点击 **Publish release** 正式发布。发布后应用内的「检查更新」才会提示该版本。

说明：

- 标签必须与应用版本号一致（`v0.2.0` ↔ `0.2.0`），否则工作流会在 `verify` 阶段失败。
- 带预发布后缀的标签（如 `v0.2.0-beta.1`）会被标记为 Pre-release。
- 若该标签已有 Release（草稿或已发布，例如在网页上手动创建、只有源代码包），工作流会把安装包上传到
  该 Release（优先已发布的版本，其次草稿），覆盖同名文件，且**不改变**其草稿/已发布状态。工作流最后
  会检查 Release 中确实包含 `*-setup.exe`、`.msi` 与 `SHA256SUMS.txt`，否则失败。
- 也可以在 Actions 页面手动运行 **Release**（`workflow_dispatch`），输入已存在的标签（如 `v0.1.0`）
  以重新构建并补传安装包。
- 安装包未做代码签名，Windows SmartScreen 可能会提示“未知发布者”。

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
src-tauri/           Rust 后端：数据目录、SQLite 读写、conf.json 配置解析
tests/               vitest 单元测试
```
