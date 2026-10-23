# Android 移植说明

本文记录 Android 版相对桌面版（Electron）的实现选择、平台差异与验证方式。
与桌面版共享的业务内核在 `src/core/`，Android 专属代码全部在 `src/mobile/` 与 `android/`。

## 1. 总体架构

```text
┌──────────────────────────── Android APK ────────────────────────────┐
│ MainActivity (Java)                                                  │
│   ├── WebView  ←  http://127.0.0.1:<port>/index.html                 │
│   │     └── React UI + SessionManager + memfs + 内置 Shell            │
│   ├── GuncatServer                                                  │
│   │     ├── 静态资源（assets/public）                                 │
│   │     └── /__fetch?url=…  同源流式反向代理                          │
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
7. `createMobileHost()`：实例化 `SessionManager`，挂上 `window.guncat`；
8. `session.bootstrap()`：加载智能体与会话；
9. React 挂载（`src/mobile/main.tsx`）。

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
| `@kit.PDFKit` | `src/mobile/kit/PDFKit.ts` | 保留接口；**后端未接入**，PDF 工具会返回明确的「后端不可用」 |
| `@core/platform/shellExec` | `src/mobile/platform/shellExec.ts` | 没有 `child_process`，改用内置 JS Shell |
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

## 4. 内置 Shell（`run_command` 的条件适配）

Android 没有 `/bin/sh`，也没有可执行文件。`src/mobile/platform/shell.ts` 实现了一个
POSIX 子集解释器：

- 词法：单/双引号、反斜杠转义、`$VAR` 展开；
- 语法：`|`、`&&`、`||`、`;`、`>`、`>>`、`<`、`2>`、`2>&1`；
- 内建命令：`pwd cd ls cat head tail wc grep find sed mkdir rm rmdir cp mv touch stat sort uniq
  cut tr base64 echo printf true false test date uname whoami env which sleep clear exit`；
- `python` / `node` / `git` / `curl` 等真实可执行文件：返回 127 + 明确原因 + 可用命令列表。

安全策略仍在 core：`CommandGuard` 硬禁、四档审批、工作区越界判定全部保留；
内置 Shell 本身只接受工作区内的相对路径解析。命中不支持的命令时是**失败**，不是静默跳过。

`ShellTask` 保持与桌面同构的接口（`start/wait/snapshot/kill`），因此
`CommandService` 的后台任务、超时、输出截断、`.spill/` 落盘逻辑不用改。
内置命令都是同步短任务；`sleep` 等长等待会占用主线程，这是已知取舍。

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

- 三栏 → 单栏：侧栏滑出抽屉，工作区/设置/表格提取全屏；
- 顶栏只留抽屉、标题、更多；其余进底部抽屉；
- 安全区：`env(safe-area-inset-*)` 用于顶栏、输入区、弹层底部；
- 触控目标 ≥ 40–44px；输入框 16px 防止聚焦缩放；
- 表格横向滚动、代码块不撑破；
- `adjustResize` + `100dvh` 保证键盘弹出时输入区可见；
- 返回键：先关抽屉/弹层/工作区，再双击退出（`MainActivity.onBackPressed`）。

全局状态新增 `sidebarOpen`；选择会话/引擎/模式时自动收起抽屉。

## 8. 原生桥（`GuncatAndroid`）

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

## 9. 构建

见根目录 README「从源码构建 APK」。要点：

- 不用 Gradle：`aapt2` → `javac --release 8` → `d8` → `jar uf` → `zipalign` → `apksigner`；
- `minSdk 29`（MediaStore 下载目录 API 从 29 开始稳定）、`targetSdk 35`；
- 清单与主题在 `android/app/src/main/`；
- 签名密钥在 `android/keystore/guncat.jks`（git 忽略）；换钥匙会导致覆盖安装失败。

## 10. 已知限制

| 限制 | 说明 |
| --- | --- |
| PDF 解析 | `@kit.PDFKit` 后端未接；`parse_document` / `search_pdf` / `pdf_to_images` 返回清楚的能力缺失提示。桌面版的 PDF.js 后端可后续移植 |
| 内置 Shell | 没有 Python/Node/git；重型流水线仍需桌面版 |
| 后台执行 | WebView 退后台可能被冻结；没有前台服务与常驻通知 |
| 自定义工作区 | 只支持应用沙箱；导出走 ZIP |
| 数据迁移 | 桌面版数据目录与 Android IndexedDB 不互通；没有导入通道 |
| 加密 | 没有系统凭据保险库，API Key 明文存应用私有配置 |

## 11. 验证记录

自动化浏览器冒烟（390×844，Edge headless）：

- 首屏、抽屉、快捷设置、全屏设置；
- mock SSE：保存配置 → 发消息 → 流式增量 → 标题生成 → 重启后会话与配置仍在；
- 工作模式：模型返回 `tool_calls(run_command ls)` → 内核执行内置 Shell → tool 结果回传 →
  第二轮收尾；
- Shell：`echo >`、`>>`、`cat`、`ls -la`、`grep -n`、`cat | grep | wc -l`、`find`、`sed`、
  `rm -r`、不支持命令的 127；
- `run_js`：输入/输出、完成值、`while(true)` 在 1.5s 被终止；
- `npm run typecheck`（node/web/mobile）。

真机验证建议：安装 APK 后先测「设置保存 → 聊天流式 → 工作区上传 → 工作模式 ls →
导出 Word/ZIP 到下载目录 → 系统 TTS」。
