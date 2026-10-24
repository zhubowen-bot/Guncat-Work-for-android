# Guncat Work（Android 版）

[中文](README.md) | [English](README_EN.md)

> 把桌面版 Guncat Work 的 Agent Harness 搬进 Android：**三种对话形态、三协议流式接入、
> 多轮工具循环与沙箱工作区、交互式界面、Office 直出、可审计的命令执行**，
> 装成 APK 就能在手机上用。

![Android](https://img.shields.io/badge/Android-9%2B-3ddc84)
![minSdk](https://img.shields.io/badge/minSdk-28-blue)
![targetSdk](https://img.shields.io/badge/targetSdk-28-blue)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![version](https://img.shields.io/badge/version-0.3.0-blue)
![tools](https://img.shields.io/badge/%E5%86%85%E7%BD%AE%E5%B7%A5%E5%85%B7-45-informational)
![skills](https://img.shields.io/badge/%E6%8A%80%E8%83%BD-37-informational)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

| 对话 | 会话抽屉 | 工作区 |
| --- | --- | --- |
| ![对话](docs/images/android-home.png) | ![会话](docs/images/android-sessions.png) | ![工作区](docs/images/android-workspace.png) |

设置页与工作区在手机上都是全屏页面，不是把桌面弹窗按比例缩小：

![设置](docs/images/android-settings.png)

## 三个形态

| 形态 | 对标 | 在手机上的说明 |
| --- | --- | --- |
| ✦ **交互模式** | GPT 的 **Intelligent UI** | 一句话直出可操作界面，控件取值即时重算 |
| 🛠 **工作模式** | **DeepSeek Harness**（Codex 式 Agent Loop） | 多轮工具循环 + 每会话独立沙箱工作区 + 内置工具 |
| 聊天模式 | — | 纯对话，不带沙箱工作区 |

三种形态与桌面版共用同一套业务内核（`src/core/`），差别只在「平台能力」这一层。

## Android 版做了什么

这不是把 Electron 界面套个 WebView 壳。Android 没有 Node 主进程、没有可直接调用的
POSIX 用户态，因此做了以下替换（详见 [docs/ANDROID.md](docs/ANDROID.md)）：

| 桌面能力 | Android 实现 |
| --- | --- |
| Electron 主进程 + preload IPC | **WebView 内宿主**：`SessionManager` 直接跑在页面里，`window.guncat` 接口签名与桌面 preload 完全一致，渲染层不用改 |
| Node `fs` | **memfs 内存文件系统 + IndexedDB 持久化**：仍保留同步 `fs` 语义，对话、配置、工作区文件都在应用私有存储中，重启不丢 |
| Node `child_process` | **内置 Termux 用户态**：随 APK 打包 bash、coreutils、grep/sed/awk、tar、curl、**python、git**；首次启动解压到应用私有目录，不依赖外部 Termux。系统 `/system/bin/sh` 作为兜底 |
| Node `vm` 跑 `run_js` | **Web Worker**：超时或死循环时直接 `terminate()`，是真正可中断的 |
| Electron `dialog` | HTML 文件选择器（WebView 的 `onShowFileChooser`）+ 原生下载/分享桥 |
| Electron `nativeImage` | 浏览器 `createImageBitmap` + canvas（缩放、缩略图、SVG 栅格化） |
| Electron `shell.openPath` | MediaStore 写入下载目录后交给系统 `ACTION_VIEW` / `ACTION_SEND` |
| Node `fetch` 直连模型 API | **应用内 127.0.0.1 同源反向代理**：绕开 WebView 的 CORS，逐块 flush，SSE 流式不中断 |
| Web Speech TTS | Android 原生 `TextToSpeech`；语音输入仍是 MediaRecorder + 服务商转写接口 |
| 桌面三栏布局 | **手机布局**：全屏对话 + 左侧会话抽屉 + 输入框上方胶囊 + 全屏工作区/设置，安全区与 44px 触控目标 |

### 手机端 UI 的关键改动

- 顶栏只保留「抽屉 / 标题 / 工作区」；模型、推理强度、深度思考、联网搜索做成输入框上方的胶囊，
  不再挤在顶栏，也不再单独开一个底部设置抽屉。
- 输入区保持一行：左侧语音 + 拍照，中间输入框，右侧上传 + 圆形发送；上传与拍照会按模式自动决定
  是「发给模型的附件」还是「加入工作区」。
- 侧栏收窄到 300px，底部的「工作区」入口移除（顶栏文件夹按钮直达）；表格提取移到侧栏底部。
- 侧栏变成可滑出的抽屉，选中会话/引擎/模式后自动收起；设置与工作区是全屏页，带安全区内边距。
- 输入框字号 16px、最小高度 46px，避免聚焦缩放；键盘弹出时使用 `adjustResize` 让输入区留在键盘上方。
- Markdown 表格在窄屏横向滚动，代码块与 Mermaid 不撑破屏幕；所有图标按钮至少 40×40。
- 用系统返回键时，先关闭抽屉/弹层/工作区，再退出；连按两次返回才真正退出。

## 快速开始（安装）

1. 从 `release/Guncat-Work-0.3.0-android.apk` 安装（arm64，Android 9+；导出到系统「下载」需 Android 10+；需要允许「安装未知来源应用」）。
   首次启动会解压内置终端（约 205MB，几十秒到几分钟），状态可在「设置 → 终端命令执行」查看。
2. 打开后进入「设置 → 接入方式」，填 Base URL、API Key、模型名，保存。
   - 支持 OpenAI Completions（`/chat/completions`）、OpenAI Responses（`/responses`）、
     Anthropic Messages（`/messages`）三种协议，均可直传图片。
   - 配置项存在应用私有目录；卸载应用会一并删除，升级安装不会。
3. 回到对话页开始用。输入框下方的回形针/相机在聊天模式是附件，在工作/交互模式会自动加入工作区；
   也可以点顶栏的文件夹按钮打开工作区统一管理文件。

> 建议先在工作模式里发一句「把工作区里的文件列一下」，确认内置终端与工具链正常。

## 从源码构建 APK

### 环境

- Node.js 20+
- JDK 17+（本机验证用 JDK 21/25）
- Android SDK：`platforms/android-35` + `build-tools/35.0.0`（不需要 Gradle）
- SDK 查找顺序：`ANDROID_HOME` → `ANDROID_SDK_ROOT` → 项目内 `.android-sdk/` → `%LOCALAPPDATA%\Android\Sdk`

```bash
npm install
npm run dist:android
```

产物：`release/Guncat-Work-<version>-android.apk`

脚本会依次完成：

1. `vite build --config vite.mobile.config.ts` → `android/app/src/main/assets/public`
2. 复制 `resources/`（智能体提示词、技能库、图标）到 assets
3. `aapt2 compile/link` 生成资源 APK（含 `assets/termux/bootstrap-aarch64.zip`）
4. `javac` 编译 `android/app/src/main/java`（Java 8 目标）
5. `d8` 生成 `classes.dex`
6. `zipalign` 对齐、`apksigner` 签名

内置终端资源（约 205MB，因体积大不入 git）按需生成：

```bash
python scripts/fetch-termux-bootstrap.py   # 下载官方 bootstrap + 工具链 deb（需联网）
python scripts/prepare-termux-bootstrap.py # 等长改写 com.termux 前缀
python scripts/add-termux-packages.py      # 合并工具链
```

详见 [docs/ANDROID.md](docs/ANDROID.md)。

首次构建会在 `android/keystore/` 生成自用签名密钥（密码见该目录 README），之后的升级包必须用同一把钥匙签名。

开发时可以只跑前端热更新：

```bash
npm run dev:android   # http://127.0.0.1:5174
```

浏览器里没有 `window.GuncatAndroid`，文件保存、系统 TTS、流式代理会退化为浏览器行为；完整能力以 APK 为准。

## 内置 Linux 终端能做什么

`run_command` 执行的是**真的进程**，不需要另外安装 Termux：

- **内置终端（默认）**：APK 里带一套 arm64 的 Termux 用户态 —— `bash`、coreutils、
  `grep` `sed` `awk` `find` `xargs` `tar` `curl`、`apt`，以及一条真实工具链：
  **Node 26 + npm 11、ffmpeg、jq、sqlite3、ssh/scp、rsync、make、rg、fd、dig/nslookup、
  htop、wget、zip**，**Python 3.14 + pip + numpy/scipy/pillow/lxml**，**Git**。
  首次启动把 bootstrap（约 205MB 压缩）解压到应用私有目录的 `abcd`，之后直接执行。
  真正的管道、重定向、通配符、命令替换、循环/函数、`&&`/`||`、退出码、后台作业都在。
- 未内置：`pandoc`、ImageMagick、`gcc/clang`、pandas、matplotlib —— 这些 deb 单个就有
  30–80MB、装完 100–200MB，再塞进 APK 会让包体失控；Termux 仓库也没有 pandas/matplotlib
  的 arm64 包。纯 Python 包可以直接 `pip install`（pip 已预装）。
- 执行命令前，App 会把当前会话工作区从 memfs 镜像到应用私有目录
  （`/data/data/com.guncat.work/files/guncat-data/files/workspaces/<会话>`），
  命令结束后把新建/修改/删除的文件同步回工作区 —— 所以 `ls`、`grep -r`、`tar`、`git status`
  看到的就是你在界面上看到的文件。
- **系统 Shell（兜底）**：内置终端不可用（非 arm64、解压失败）时可切到
  `/system/bin/sh`（mksh + toybox），仍支持管道、重定向和工作区镜像，但没有上面这些工具。
- 设置页「终端命令执行 (Shell)」可切换后端、查看内置终端安装进度、重新安装。

APK 因此从 7MB 增到约 **211MB**，并把 `targetSdk` 定为 **28**：Android 10+ 禁止
targetSdk ≥ 29 的应用执行私有目录里的文件（Termux 官方也一直用 28）。这是内置终端的硬前提。

镜像边界：单文件 8MB、单次同步 32MB 封顶；不同步设置/会话历史/API Key；超限文件会在结果里
明确写出「没有同步」，不会假装命令看得见。

## 能力与差异

| 能力 | Android 状态 |
| --- | --- |
| 三协议流式对话 / 深度思考 / 联网搜索 | ✅ |
| 工作模式 Agent Loop、45 个工具、技能库 | ✅（命令类工具走内置 Linux 终端） |
| 交互模式界面渲染 | ✅ |
| Office 生成（docx/xlsx/pptx/svg） | ✅ 保存到系统「下载/Guncat Work」 |
| 图片查看 / 缩略图 / SVG 栅格化 | ✅ |
| 聊天附件 + 工作区上传 | ✅ 系统文件选择器 |
| 表格提取（视觉模型） | ✅ |
| 朗读 | ✅ 系统 TTS（音色由系统决定） |
| 语音输入 | ✅ MediaRecorder + 服务商转写（需另配或复用多模态配置） |
| 内置 Linux 终端（bash / Python / pip / Git） | ✅ 随 APK 打包，arm64；首次启动解压 |
| 数据持久化 | ✅ IndexedDB（应用私有，卸载即清除） |
| PDF 解析 / 搜索 / 页面转图 | ✅ PDF.js（WebView 内 worker + canvas）；中文 CMap、标准字体、wasm 随包 |
| 自定义工作区目录 | ⚠️ 不支持：使用应用沙箱工作区，可用 ZIP 导出 |
| 文件管理器「定位」 | ⚠️ 改为保存/分享到系统下载目录 |
| 后台长任务 | ⚠️ WebView 退到后台可能被系统冻结，长任务请保持前台 |

## 项目结构

```text
src/
├── core/                 # 与桌面/鸿蒙共享的业务内核（不写平台代码）
├── main/                 # Electron 主进程（桌面端）
├── renderer/             # React 界面（两端共用）
└── mobile/               # ★ Android 宿主
    ├── boot.ts           #   启动：IndexedDB → memfs → 资源 → SessionManager → React
    ├── host/             #   window.guncat 的 WebView 实现（对应 src/main/ipc.ts）
    ├── kit/              #   @kit.* 的浏览器实现（ImageKit / ArkTS / PDFKit）
    ├── shims/            #   node:fs / node:path / node:util 的浏览器实现
    ├── platform/         #   内置终端适配 / 工作区镜像、run_js Worker、SVG 栅格化、PDF.js 后端
    └── native/           #   原生桥（含 Shell 桥）、文件选择、同源代理 fetch
android/
├── app/src/main/assets/termux/  # 内置 Termux bootstrap（构建产物，勿手改）
├── app/src/main/java/com/guncat/work/
│   ├── MainActivity.java        # WebView + 文件选择 + TTS + 下载/分享
│   ├── GuncatServer.java        # 本机静态服务 + 流式反向代理
│   ├── TermuxBootstrap.java     # 首次解压内置 Termux 用户态 + 路径/符号链接
│   └── ShellManager.java        # 命令执行（内置 bash / 系统 sh）+ 工作区落盘
├── app/src/main/res/     # 图标、主题、网络安全配置
└── keystore/             # 本地签名（git 忽略）
```

## 验证

在桌面浏览器（Edge/Chrome 手机视口）上做过的自动化冒烟：

- 首屏启动、抽屉、快捷设置、全屏设置页（390×844）；
- 保存配置 → 新建会话 → 流式回答（mock SSE）→ 重启后会话与配置仍在；
- 工作模式：模型发起 `run_command` → 内置终端执行 `ls` → 结果回传 → 收尾；
- PDF：`parse_document` 文字层（含中文 CMap）、`search_pdf` 关键词、`pdf_to_images` 渲染 JPEG；
- Shell：管道、追加写、grep、find、sed；无原生桥时退回 JS Shell 的回退路径；
- `run_js`：输入/输出、完成值、`while(true)` 1.5 秒内被 Worker 终止；
- `npm run typecheck`（node/web/mobile 三套 tsconfig）。

类型检查命令：

```bash
npm run typecheck:mobile
```

## 数据与隐私

- 对话、配置、工作区文件都在应用私有存储（IndexedDB）中，不写入公共目录；导出文件才落到「下载」。
- API Key 以明文保存在应用私有配置中（Android WebView 没有桌面版那套系统凭据保险库），设置页会如实提示。
- 模型请求经 `127.0.0.1` 的本机代理转发；代理只监听回环地址，并要求启动时注入的随机 token。

## 已知限制

1. 内置终端只提供 **arm64**；其他 ABI 只能用系统 Shell。`targetSdk` 固定为 28（执行私有目录文件的系统限制），
   这不是「懒得升级」，降到更低或升到 29+ 都会直接不能执行。
2. 内置终端首次启动要解压约 560MB，占用应用私有空间；APK 因此约 211MB。
3. `pkg install` 安装的新包仍带 Termux 原路径，当前未做逐包路径修复；内置的 Python/Git 可直接用。
4. 应用退到后台后，长任务可能被系统暂停；没有前台服务/通知来维持执行。
5. 暂不支持自定义工作区目录与系统「打开方式」接收文件。
6. PDF 只做**读取**：解析/搜索/转图可用，不提供创建、编辑、合并、加水印、填表与 OCR 文字层。

## 文档

- [Android 移植说明与平台差异](docs/ANDROID.md)
- [桌面版 ↔ 鸿蒙版移植档案](docs/PORTING.md)
- [交互模式实现](docs/INTERACTIVE-MODE.md)
- [更新日志](CHANGELOG.md)

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。Android 端请优先保持 `src/core/` 平台无关；
新平台能力放进 `src/mobile/`，新界面同时检查手机窄屏。

## 授权

[GPL-3.0](LICENSE)

内置终端使用 [Termux](https://github.com/termux/termux-app) 的 bootstrap（GPL-3.0），
详见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。
