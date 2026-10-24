# Android 移植说明

本文记录 Android 版相对桌面版（Electron）的实现选择、平台差异与验证方式。
与桌面版共享的业务内核在 `src/core/`，Android 专属代码全部在 `src/mobile/` 与 `android/`。

## 1. 总体架构

```text
┌──────────────────────────── Android APK ────────────────────────────┐
│ MainActivity (Java)                                                  │
│   ├── WebView  ←  http://127.0.0.1:<port>/index.html                 │
│   │     └── React UI + SessionManager + memfs + ShellTask            │
│   ├── GuncatServer                                                  │
│   │     ├── 静态资源（assets/public）                                 │
│   │     └── /__fetch?url=…  同源流式反向代理                          │
│   ├── ShellManager（GuncatShell 桥）                                 │
│   │     ├── 内置 Termux 用户态（abcd/bin/bash，Python/pip/Git）            │
│   │     ├── /system/bin/sh 兜底（mksh + toybox）                      │
│   │     └── 工作区落盘：memfs ↔ files/guncat-data/files/workspaces          │
│   ├── TextToSpeech / MediaStore / ACTION_VIEW / ACTION_SEND          │
│   └── onShowFileChooser → HTML <input type=file>                     │
└──────────────────────────────────────────────────────────────────────┘
```

桌面版是「渲染进程 + 主进程」两段式；Android 版把主进程那一半（`SessionManager` 及其服务）
放进 WebView 里跑，外面只留一个 Java 外壳负责 WebView 做不到的事。

`window.guncat` 的接口签名与 `src/preload/index.ts` 完全一致（见 `src/mobile/host/index.ts`），
所以 `src/renderer` 的 store 与组件不需要平台分支。

## 2. 启动顺序

`src/mobile/boot.ts`：

1. `hydrateFs()`：从 IndexedDB 恢复内存文件系统；
2. `installBundledResources()`：把构建期以 `?raw` 打进包的 `resources/**`（agents.json、提示词、
   技能库、插件清单）写入 `/guncat/resources`；
3. `initAppPaths({dataRoot:'/guncat/data', resourcesRoot:'/guncat/resources'})`；
4. `bindSafeStorage(null)`：Android 版没有系统凭据保险库，设置页会如实显示「明文保存」；
5. `registerPickerHost()`：把鸿蒙 `picker` 语义接到 HTML 文件选择器；
6. `installFetchProxy()`：把跨域请求改道到本机代理；
7. `installPdfJsBackend()`：注入 PDF.js 后端（只注册，PDF.js 在第一次打开文档时才加载）；
8. `createMobileHost()`：实例化 `SessionManager`，挂上 `window.guncat`；
9. `session.bootstrap()`：加载智能体与会话；
10. React 挂载（`src/mobile/main.tsx`）。

顺序不能反：core 第一次读配置会创建目录/读写文件，必须等 IndexedDB 恢复完成。

## 3. 平台适配层

### 3.1 直接复用桌面 kit 的部分

这些 kit 的实现只依赖 `fs` / `fetch` / `fflate`，把 `node:fs`、`node:path` 换成浏览器实现后
可以原样复用：

- `@kit.AbilityKit`（appPaths / resourceManager）
- `@kit.CoreFileKit`（fileIo / picker）
- `@kit.NetworkKit`（fetch + Web Streams）
- `@kit.ArkData`（Preferences）
- `@kit.BasicServicesKit`（fflate unzip）
- `@kit.PerformanceAnalysisKit`

### 3.2 Android 专属实现

| 模块 | 位置 | 原因 |
| --- | --- | --- |
| `@kit.ArkTS` | `src/mobile/kit/ArkTS.ts` | 桌面版从 `node:util` 取 TextEncoder；浏览器原生已有，且 node:util 的 polyfill 在 bundle 里不可靠 |
| `@kit.ImageKit` | `src/mobile/kit/ImageKit.ts` | 浏览器没有 `nativeImage`：用 `createImageBitmap` + canvas 解码/缩放/编码 |
| `@kit.PDFKit` | `src/mobile/kit/PDFKit.ts` + `src/mobile/platform/pdfBackend.ts` | 后端接 PDF.js（WebView 内 worker + DOM canvas）；CMap / 标准字体 / wasm 随包 |
| `@core/platform/shellExec` | `src/mobile/platform/shellExec.ts` | 没有 `child_process`：走原生 `GuncatShell` 桥（真机）或内置 JS Shell（浏览器预览） |
| `libguncatjs.so` | `src/mobile/platform/libguncatjs.ts` | `node:vm` → Web Worker（可真正终止） |
| `@core/platform/native/svgRaster` | `src/mobile/platform/svgRaster.ts` | `@napi-rs/canvas` → 浏览器 Image + canvas |

重定向有两层：`vite.mobile.config.ts` 的模块别名，以及一个 `resolveId` 插件。
后者是必要的，因为 core 内部有**相对路径**引用（例如 `CommandService` 的
`../platform/shellExec`、`NetworkKit` 的 `./ArkTS`），别名改不到相对说明符。

### 3.3 Node 内置模块替身

| 替身 | 位置 | 说明 |
| --- | --- | --- |
| `node:fs` | `src/mobile/shims/fs.ts` | memfs 内存卷；写操作按路径标脏，400ms 防抖写 IndexedDB；页面隐藏时全量快照 |
| `node:path` | `src/mobile/shims/path.ts` | path-browserify；补 `path.posix` / `path.win32`（memfs 依赖 `posix` 命名空间） |
| `node:util` | `src/mobile/shims/util.ts` | `@kit.ArkTS` 已改用原生 API；此为兜底 |
| `node:events` / `stream` / `buffer` / `process` | `vite-plugin-node-polyfills` | memfs 的依赖需要 |

持久化策略的取舍：不能每次写都全量快照（流式回答时对话 JSON 每几百毫秒落一次盘），
所以只记录真正变动的路径；目录删除按前缀清理；应用切后台/页面卸载时再全量兜底。

### 3.4 PDF 解析（PDF.js）

PDF 三件套（`parse_document` / `search_pdf` / `pdf_to_images`）与桌面端共用
`core/service/PdfTextExtractor.ts` 和 `@kit.PDFKit` 的接口，Android 侧只补一个后端：

| 环节 | Android 做法 |
| --- | --- |
| 后端注入 | `src/mobile/platform/pdfBackend.ts` 的 `installPdfJsBackend()`，在 `boot.ts` 里调用 |
| 解析引擎 | `pdfjs-dist/legacy/build/pdf.mjs`，动态 import（首次打开 PDF 才加载，约 474KB gzip 144KB） |
| Worker | 构建期把 `pdf.worker.min.mjs` 拷成 `assets/public/pdfjs/pdf.worker.mjs`，与页面同源 |
| 随包数据 | `pdfjs/{cmaps,standard_fonts,wasm,iccs}` 原样拷进 assets；中文 PDF 的文字层依赖 `cmaps` |
| 文件读取 | 仍走 `node:fs` 替身（memfs）：`fs.readFileSync(absPath)` → `Uint8Array` → PDF.js |
| 页面渲染 | 直接创建 DOM `<canvas>`，铺白底后交给 `page.render()`；`transferToImageBitmap()` 转成 `PixelMap` |
| 输出图片 | `ImagePacker.packToFile()` 走 canvas → JPEG，落到 `pdf_images/<文件名>/p001.jpg` |
| 文本拼装 | 与桌面端共用 `core/platform/pdfTextLayout.ts`（`hasEOL` 换行、版面兜底），避免两端读出不同结果 |

`vite.mobile.config.ts` 里的 `guncat-pdfjs-assets` 插件负责两件事：构建结束时把上述四组
数据与 worker 拷进产物；`vite dev` 时用中间件从 `node_modules/pdfjs-dist` 提供同一批
`/pdfjs/*` 路径。开发态与打包态的 URL 完全一致，不依赖 CDN 或网络。

已知边界（与桌面端一致）：加密 PDF 需要密码（返回 `PARSE_ERROR_PASSWORD`）；扫描件没有
文字层，文本为空，需 `pdf_to_images` + `view_image`；不提供 PDF 创建/编辑/合并/OCR。

## 4. 真实 Shell（`run_command`）

`run_command` 现在执行真实进程，不再是 JS 解释器模拟。入口仍是
`src/mobile/platform/shellExec.ts` 的 `ShellTask`，接口与桌面版逐字一致，因此
`CommandService` 的安全判定、审批、后台任务、超时、输出截断都不用改。

### 4.1 两个后端

| 后端 | 进程 | 能力 | 工作目录 |
| --- | --- | --- | --- |
| 内置终端（默认） | `abcd/bin/bash --noprofile --norc -c <command>` | Termux 用户态：bash、coreutils、grep/sed/awk、tar、curl、apt、**Python 3.14、pip、Git** | 工作区的设备镜像目录 |
| 系统 Shell（兜底） | `/system/bin/sh -c <command>`（mksh）+ toybox | 管道/重定向/通配符 + 系统命令；无 Python/Git | 工作区的设备镜像目录 |

后端选择存在 `localStorage.guncat.shellBackend`，设置页「终端命令执行 (Shell)」可切换。
默认内置终端 —— 用户不需要安装 Termux。

### 4.2 为什么内置终端能执行：路径与 targetSdk

Termux 的二进制里写死了 `/data/data/com.termux/files/usr`（31 字符）。我们的包名是
`com.guncat.work`，路径更长，不能直接原地替换。构建期做了等长替换：

| 原路径 | 替换为 | 长度 |
| --- | --- | --- |
| `/data/data/com.termux/files/usr` | `/data/data/com.guncat.work/abcd` | 31 → 31 |
| `/data/data/com.termux/files/home` | `/data/data/com.guncat.work/abcde` | 32 → 32 |
| `/data/data/com.termux`（仅文本脚本） | `/data/data/com.guncat.work` | 21 → 26 |

`abcd` / `abcde` 是应用私有目录下的真实目录（不是符号链接）。等长替换保证 ELF 的
`.dynstr` / rpath / shebang 不被改坏；脚本里的裸路径可以变长，所以在文本文件里单独替换。
替换脚本见 `scripts/prepare-termux-bootstrap.py` 与 `scripts/add-termux-packages.py`。

另一个硬前提是 **`targetSdk = 28`**：Android 10 起，targetSdk ≥ 29 的应用被系统禁止执行
应用私有目录里的文件（W^X），Termux 官方也一直把 targetSdk 压在 28。清单与
`scripts/build-android.mjs` 都写死 28；改成 29+ 会直接导致内置终端 `exec` 失败。

### 4.3 首次安装（`TermuxBootstrap.java`）

APK 的 `assets/termux/bootstrap-aarch64.zip` 是约 205MB 的压缩包（解压后约 560MB）。
`ShellManager` 构造时启动后台解压到 `<app home>/abcd`：

1. 读 `SYMLINKS.txt`（格式 `目标←./链接路径`），先解压全部文件、再统一 `Os.symlink`；
2. `bin/`、`libexec/`、apt 的 methods/helper 设 0700；
3. 创建 `abcde`（HOME）、`cache/apt`、`prefix/tmp`，写 apt 的 `Dir::Cache`；
4. 写版本标记；版本变化时整目录重建。

解压完成前 `run_command` 会返回明确的「内置终端还没有就绪（已解压 N 个文件）」，
设置页轮询显示进度。只提供 **arm64**；非 arm64 设备自动建议切系统 Shell。

### 4.4 为什么需要「工作区镜像」

Android 版的 `node:fs` 是 memfs（`src/mobile/shims/fs.ts`），而真实命令只认真实文件。
执行前 `src/mobile/platform/mirror.ts` 会把当前会话工作区写到
`<filesDir>/guncat-data/files/workspaces/<conv>`，命令结束后再扫一遍设备目录：

- 新增/修改的文件读回 memfs（`fs.writeFileSync`，沿用原有 IndexedDB 持久化）；
- 命令删掉的文件从 memfs 删除；
- 只镜像 `/guncat/data/files/workspaces/<会话>`，不同步设置、会话历史与 API Key；
- 单文件 8MB、单次同步 32MB 封顶，超限会写进命令结果，不静默跳过；
- 后台任务与文件工具同时改同一个文件时按「后写覆盖」；镜像状态只在本次页面生命周期内保存，
  刷新页面后首次命令会重新上传（memfs 的 mtime 本来也会在恢复时重置）。

镜像目录同时是两个后端的 cwd：命令里的相对路径、`ls`、`grep -r .`、`tar`、`git status`
都落在真实会话工作区。

### 4.5 进程管理（`ShellManager.java`）

- `ProcessBuilder` + `redirectErrorStream(true)`，输出按 UTF-8 逐块读进环形缓冲；
- 缓冲上限来自 `Constants.WORK_CMD_*_BUFFER_BYTES`（前台 256KB / 后台 512KB），超出从头丢，
  通过 `droppedChars` 汇报，避免 `yes` 把 WebView 撑爆；
- 超时/停止/`job_kill`：按 `/proc/<pid>/task/<pid>/children` 递归找子孙进程再 `sendSignal(pid, 9)`，
  不只杀 bash；
- 后台任务登记表仍由 `CommandService` 维护，`job_output` 的游标只对 JS 侧已读到的文本切片。

环境变量用别名路径（`PREFIX=/data/data/com.guncat.work/abcd`、`HOME=.../abcde`、
`TMPDIR=$PREFIX/tmp`、`PATH=$PREFIX/bin:/system/bin:...`），并覆盖上层传下来的 `/guncat/data`。
**不注入全局 `LD_LIBRARY_PATH`**：Termux 二进制/共享库都带 `DT_RUNPATH=$PREFIX/lib`；全局注入会连
Android 系统库也解析到前缀同名库（`libjpeg`/`libcrypto`/`libsasl2`…），ffmpeg 的 `libhwui → libjpeg`
链就会报 `cannot locate symbol "tjInitDecompress"`。需要临时覆盖时在命令前写
`LD_LIBRARY_PATH=... cmd`。

### 4.6 已内置的软件与 `pkg install` 的边界

bootstrap 里预装了：**Node 26 + npm 11、ffmpeg、jq、sqlite3、ssh/scp、rsync、make、rg、fd、
dig/nslookup、htop、wget、zip、Git 2.56、Python 3.14 + pip + numpy/scipy/pillow/lxml**（含依赖库）。
基础镜像另有 apt/dpkg。

未内置的 `pandoc`、ImageMagick、`gcc/clang`、pandas、matplotlib：前四个的 deb 单个 30–80MB、
装完 100–200MB；pandas/matplotlib 在 Termux 仓库没有 arm64 包。APK 已经 211MB，再加这些会让
包体和首次解压进一步失控。纯 Python 包可直接 `pip install`。

Termux 仓库的新包仍引用 `/data/data/com.termux/...`，`pkg install` 装出来的文件路径不会自动
改写；当前**不承诺** `pkg install` 的包可直接运行，需要额外工具应优先用已内置的这批。

另外，Termux 的 `libandroid-stub` 是**编译期桩**，不能随运行时一起装：它会在 `$PREFIX/lib`
放假的 `libbinder_ndk.so`/`libandroid.so` 等，遮蔽系统真库。ffmpeg 的 `libplacebo → libvulkan →
libui` 链加载时会因此报 `cannot find "libbinder_ndk.so" from verneed[0] ... /system/lib64/libui.so`。
本项目的工具链清单已排除 `libandroid-stub`；手工加包时不要把它装回来。

### 4.7 文件名编码：Windows 中文 ZIP 的「隐形文件」

Android/Linux 的文件名本质是字节串，不强制 UTF-8。Windows 中文 ZIP 的条目名常是 GBK/CP936；
`unzip`/`tar` 直接解压会写出非法 UTF-8 字节名。终端 `find` 能列出来，但 `list_files`/`read_file`/
`glob`/`grep` 走 JS 字符串，无法表示这些名字，于是目录显示为空 —— **这不是文件丢了**。

处理原则：**先修名，后解压**。解压前用 Python 检查 ZIP 条目名（`zipfile` 对非 UTF-8 标志按
cp437 解码，可用 `name.encode('cp437')` 还原原始字节，再按 UTF-8 → cp936 解码）；已解压的用
`find ... -print0` 或 `os.listdir(b'.')` 查原始字节名，在终端里重命名。模型侧已写入
`PromptBuilder.fileNameEncodingNote()` 与 `list_files` 工具描述，避免下一次误判成「目录为空」。

### 4.8 浏览器预览的回退

`window.GuncatShell` 不存在时（`npm run dev:android`、`scripts/android-check.mjs`），
`ShellTask` 回退到 `src/mobile/platform/shell.ts` 的 JS POSIX 子集。这条路径只服务开发预览：
真机不会走，也不需要在 README 里承诺它支持什么。回退实现保留是因为浏览器冒烟要能在没有
WebView 原生桥的环境里跑通工作模式。

安全策略仍在 core：`CommandGuard` 硬禁、四档审批、工作区越界判定全部保留。内置 Linux 终端
让「能跑什么」变多，但「谁批准」没有放宽；脚本同审、输出截断、`.spill/` 落盘照旧。

## 5. `run_js`

桌面版用 `node:vm` 的 `timeout` 硬中断；Android 版用 Blob Worker：

- 输入通过 `inputs` 传入，`read()` / `write()` 是唯一文件通道；
- 完成值取 `await eval(code)` 的返回值；
- 超时调用 `worker.terminate()`，死循环不会留在后台烧 CPU；
- Worker 内屏蔽 `fetch` / `XMLHttpRequest` / `indexedDB` / `importScripts`。

边界与桌面一致：约束的是正常写法，不是恶意逃逸（同源 Worker 仍可通过 Function 拿到全局）。

## 6. 网络：为什么必须有一个本机代理

WebView 里的 `fetch` 受 CORS 约束。很多模型服务不返回 `Access-Control-Allow-Origin`，
或者不允许带 `Authorization` 的预检请求；直接把桌面版 `fetch` 搬过来会在真机上全部失败。
同时，SSE 必须逐块到达，不能等整包。

`GuncatServer`：

- 只绑定 `127.0.0.1`，固定端口 `47653`（IndexedDB 与 origin 绑定；端口变了历史数据就不可见，
  只有端口被占用时才退回随机端口并在日志/提示里说明）；
- 静态资源加 `Cache-Control`，`index.html` 注入本次启动的随机 token 与版本号；
- `/__fetch?url=…` 校验 `X-Guncat-Token`，用 `HttpURLConnection` 转发；
- 请求头过滤 `Host/Origin/Referer/Sec-*/Content-Length` 等，强制 `Accept-Encoding: identity`；
- 响应状态与头原样回写（去掉 `Content-Length/Transfer-Encoding/Content-Encoding`），
  以 `Connection: close` 分帧，每读到一块就 `flush()`；
- `URLDecoder` 前把 `+` 转义成 `%2B`，否则查询串里的加号会被解成空格。

JS 侧 `src/mobile/native/net.ts` 只改写跨域 URL，同源资源请求保持原样。

## 7. 移动端界面

`src/mobile/mobile.css` 只在 `max-width: 860px` 生效，桌面端不受影响：

- 三栏 → 单栏：侧栏（300px）滑出抽屉，工作区/设置/表格提取全屏；
- 顶栏只留抽屉、标题、工作区；模型/推理/思考/联网做成输入框上方胶囊；
- 输入区一行：左语音 + 拍照，中间输入框，右上传 + 圆形发送；上传/拍照按模式进附件或工作区；
- 侧栏底部移除「工作区」（顶栏直达），换成「表格」；
- 安全区：`env(safe-area-inset-*)` 用于顶栏、输入区、弹层底部；
- 触控目标 ≥ 40–44px；输入框 16px 防止聚焦缩放；
- 表格横向滚动、代码块不撑破；
- `adjustResize` + `--app-height`（visualViewport）保证键盘弹出时输入区可见；
- 返回键：先关抽屉/弹层/工作区，再双击退出（`MainActivity.onBackPressed`）。

全局状态新增 `sidebarOpen`；选择会话/引擎/模式时自动收起抽屉。

## 8. 原生桥

### 8.1 `GuncatAndroid`（系统能力）

`MainActivity.NativeBridge` 只暴露 WebView 做不到的事：

| 方法 | 用途 |
| --- | --- |
| `saveFile(name, mime, base64)` | 写 MediaStore 的 `Downloads/Guncat Work` |
| `openFile(name, mime, base64)` | 先写下载目录，再 `ACTION_VIEW` |
| `shareFile(name, mime, base64)` | 先写下载目录，再 `ACTION_SEND` 选择器 |
| `toast(message)` | 轻提示 |
| `info()` / `getVersion()` | 设备与版本信息 |
| `ttsSpeak(text, rate)` / `ttsStop()` | 系统 TTS |

文件**选择**不走桥：`onShowFileChooser` 返回 content URI，页面的 `File` API 读取后写入 memfs。
文件**保存**返回 `ok:下载/Guncat Work/<name>` 或 `err:<原因>`，host 据此给用户提示。

### 8.2 `GuncatShell`（命令执行 / 工作区落盘）

`ShellManager` 单独注入，和系统能力桥分开 —— 它是「能执行任意命令」的入口，边界要清楚。

| 方法 | 用途 |
| --- | --- |
| `info()` | 虚拟根 / 真实根 / 内置终端就绪状态与进度 / 系统 shell |
| `start(command, cwd, envJson, limit, backend)` | 返回 `{id, pid, backend}` 或 `{ok:false, error}`；backend 为 `bundled` / `system` |
| `read(id, from)` | 增量输出 + 运行状态 + 退出码 + 丢弃字符数 |
| `kill(id)` / `release(id)` | 递归杀进程树 / 释放任务 |
| `reinstallBundled()` | 删除并重新解压内置 Termux 用户态 |
| `fsList` / `fsRead` / `fsWrite` / `fsDelete` / `fsMkdir` / `fsStat` | 工作区镜像；只接受 `/guncat/data` 内路径，做 canonical path 越界校验 |

`info()` 与 `fs*` 都是同步方法（`@JavascriptInterface` 跑在 WebView 的 JS 线程），
所以 `ShellTask.start()` 能保持同步签名；只有进程退出由 `wait()` / 定时轮询等待。

## 9. 构建

见根目录 README「从源码构建 APK」。要点：

- 不用 Gradle：`aapt2` → `javac --release 8` → `d8` → `jar uf` → `zipalign` → `apksigner`；
- Java 侧 `ShellManager.java` / `TermuxBootstrap.java` 没有第三方依赖，d8 直接能编；
- `minSdk 28`、**`targetSdk 28`**（执行私有目录文件的系统限制；Termux 同款做法）；
- `assets/termux/bootstrap-aarch64.zip` 约 205MB，构建时由 `aapt2 -A` 打进 APK；产物 APK 约 211MB；
- 清单与主题在 `android/app/src/main/`；
- 签名密钥在 `android/keystore/guncat.jks`（git 忽略）；换钥匙会导致覆盖安装失败。

内置终端资源的生成（约 205MB，因超过 GitHub 单文件限制不入库）：

```bash
# 1. 下载官方 arm64 bootstrap 与全部工具链 deb（清华镜像，可用 TERMUX_MIRROR 覆盖）
python scripts/fetch-termux-bootstrap.py
# 2. 等长改写 com.termux → com.guncat.work/abcd、abcde
python scripts/prepare-termux-bootstrap.py
# 3. 追加工具链（Node/ffmpeg/Python libs/...，清单见 scripts/termux-toolchain-packages.txt）
python scripts/add-termux-packages.py
```

`npm run dist:android` 在资源缺失时会直接报错并给出上面三步，不会静默出无终端的包。

## 10. 已知限制

| 限制 | 说明 |
| --- | --- |
| PDF 能力边界 | 只读：解析/搜索/页面转图可用；不提供创建、编辑、合并、加水印、填表与 OCR 文字层 |
| 内置终端架构 | 只带 arm64；x86/armv7 设备只能用系统 Shell |
| `targetSdk 28` | Android 10+ 才允许执行应用私有目录文件，降到 28 是内置终端的硬前提；Play 商店新应用不适用此版本，本应用走 sideload |
| APK 体积 / 磁盘 | APK 约 211MB；首次解压约占 560MB 私有空间 |
| `pkg install` | 新装 deb 的路径仍写死 `com.termux`，当前未做逐包改写；内置 Python/pip/Git 可用，其他工具需后续适配 |
| 工作区镜像 | 单文件 8MB / 单次 32MB；大文件、超大目录（如完整 `node_modules`）不会完整落地 |
| 后台执行 | WebView 退后台可能被冻结；没有前台服务与常驻通知 |
| 自定义工作区 | 只支持应用沙箱；导出走 ZIP |
| 数据迁移 | 桌面版数据目录与 Android IndexedDB 不互通；没有导入通道 |
| 加密 | 没有系统凭据保险库，API Key 明文存应用私有配置 |

## 11. 验证记录

自动化浏览器冒烟（390×844，Edge headless，无原生桥 → 走 JS 回退）：

- 首屏、抽屉、快捷设置、全屏设置；
- mock SSE：保存配置 → 发消息 → 流式增量 → 标题生成 → 重启后会话与配置仍在；
- 工作模式：模型返回 `tool_calls(run_command ls)` → 内核执行 → tool 结果回传 → 第二轮收尾；
- Shell：`echo >`、`>>`、`cat`、`ls -la`、`grep -n`、`cat | grep | wc -l`、`find`、`sed`、
  `rm -r`、回退实现对不存在命令的 127；
- `run_js`：输入/输出、完成值、`while(true)` 在 1.5s 被终止；
- PDF：`parse_document` 文字层（英文与中文 CMap 各一份）、`search_pdf` 命中页码、
  `pdf_to_images` 渲染出可读 JPEG，并校验 `/pdfjs/*` 随包数据全部可访问；
- `npm run typecheck`（node/web/mobile）。

真机验证建议：安装 APK 后依次测

1. 首启：等待「设置 → 终端命令执行」显示内置终端「已就绪」（首次解压约 560MB）；
2. 基础命令：工作模式 `run_command` 执行
   `pwd; ls -la; echo hi > a.txt; cat a.txt; uname -a`，确认 `a.txt` 出现在工作区面板；
3. Linux 工具链：`bash --version`、`python3 --version`、`python3 -c "print(1+1)"`、
   `git --version`、`git init && git status`、`grep -rn .`、`tar -czf x.tgz a.txt`；
4. 工作区回写：`mkdir -p d && echo x > d/f.txt`、`rm a.txt`、`git add/commit`，
   刷新后工作区与命令结果一致；
5. 超时/终止：`sleep 60` 会被超时杀掉；后台 `sleep 60` 用 `job_kill` 结束；
6. 兜底：设置切到系统 Shell，重复第 2 步，确认仍可用（无 Python/pip/Git）；
7. 导出 Word/ZIP、系统 TTS 回归。
