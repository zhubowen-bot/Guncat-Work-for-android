# 参与贡献

感谢你有兴趣参与。Guncat Work（Android 版）用 **React + TypeScript 界面 + WebView 内宿主 + 一层很薄的 Java 原生壳** 实现；业务内核（Agent Loop、三协议流式对话、45 个工具、37 项技能、Office 生成器、`guncat-ui lang` 渲染器）放在 `src/core/`，与桌面版（Electron）、鸿蒙版共用。鸿蒙版见 [Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos)。

这个仓库对「改动是否可靠」的要求比较高 —— 它做的事情（Agent 循环、真实进程执行、工作区镜像、IPC 契约、手机界面渲染）出错时很难靠肉眼发现，所以下面这套验证流程不是形式主义，**每一层都在拦真实发生过的事故**。

欢迎提交 Issue 和 Pull Request。

---

## 先认清分层：改错地方是这里最常见的问题

| 目录 | 是什么 | 改动约定 |
| --- | --- | --- |
| `src/core/` | 业务内核，**逐字移植**自鸿蒙版 | 默认不许改；平台差异放 `src/mobile/` |
| `src/main/` | Electron 主进程；其中 `session/SessionManager.ts`、`asr.ts`、`sanitizeHtml.ts` **被 Android 宿主复用** | 被复用的文件里不许 import `electron` |
| `src/renderer/` | React 界面，桌面与 Android 共用 | 新界面必须同时看 `src/mobile/mobile.css` 的窄屏表现 |
| `src/mobile/` | Android 宿主：`window.guncat` 实现、`@kit.*` 浏览器版、Node 内置模块替身、Shell/镜像/Worker 适配 | Android 专属代码写在这里 |
| `src/ipc/contract.ts` | 主进程与渲染进程的共享类型 | 改一条通道要动五处，见下文 |
| `android/app/src/main/java/` | Java 壳：WebView、静态服务与代理、命令执行、Termux 解压、相机/文件提供者 | 无第三方依赖，按 Java 8 + minSdk 28 写 |
| `android/app/src/main/assets/` | `public/`（Vite 产物）与 `termux/bootstrap-aarch64.zip`（约 205MB） | **都是生成物，不要手改、不要提交** |

桌面端的 `src/main`、`src/renderer` 没有删掉，是因为 Android 复用其中的会话编排与界面；但本仓库可交付的产物只有 APK，验证也以 Android 为准。

---

## 环境要求

- **Node.js ≥ 20**（`package.json` 里的脚本全按 ESM 写）
- **npm**（**不是 pnpm** —— 仓库里只有 `package-lock.json`，脚本也按 npm 的布局找依赖）
- **JDK 17+**（打包脚本用 `javac`/`keytool`；优先读 `JAVA_HOME`，也会探测常见安装路径）
- **Android SDK**：`platforms/android-35` + `build-tools/35.0.0`，**不需要 Gradle / Android Studio**。
  查找顺序：`ANDROID_HOME` → `ANDROID_SDK_ROOT` → 项目内 `.android-sdk/` → `%LOCALAPPDATA%\Android\Sdk`（Windows）
- **Python 3.11+**：只在重建内置 Termux 用户态时需要（`scripts/*.py` 只用标准库，无第三方依赖）
- 主要构建环境是 **Windows 10 / 11**（脚本的 SDK / JDK 探测路径按 Windows 写全）；macOS / Linux
  走同一套 `aapt2` / `javac` / `d8` 工具链，但没有纳入日常验证。
- 最后一步要一台 **arm64 的 Android 9+ 真机**（模拟器也能装，但内置终端的性能与后台行为只有真机可信）
- 磁盘：构建侧留 2–3GB；设备侧首次解压内置终端约需 560MB 私有空间

---

## 验证矩阵：为什么一层都不能省

Android 侧最短闭环：

```bash
npm run verify:android   # = typecheck:mobile + dist:android
```

但它**不含**浏览器冒烟。完整提交建议按下面的层顺序跑：

### 第 1 层 · 类型检查

```bash
npm run typecheck         # node + web + mobile 三套 tsconfig
npm run typecheck:mobile  # 只查 Android 侧：src/mobile + 共用界面 + core
```

`tsconfig.mobile.json` 里同样**关掉了** `strictNullChecks` / `strictFunctionTypes`：
ArkTS 的空值语义与 TS 不同，不关的话 3.5 万行移植代码会淹在噪音里。
但**保留 `noImplicitAny`**，新写的代码仍要能抓到真正的错误。

### 第 2 层 · Android 构建

```bash
npm run build:android     # vite build --config vite.mobile.config.ts
```

产物写到 `android/app/src/main/assets/public/`。这里有几件事要清楚：

- `npm run build` 是**桌面 Electron 构建**（`out/`），不能替代 `build:android`。
- 开发时可以用 `npm run dev:android`（`http://127.0.0.1:5174`）热更新；但浏览器里没有
  `window.GuncatAndroid` / `window.GuncatShell`，保存文件、系统 TTS、流式代理、真实命令都会退化。
  **浏览器能跑通不等于真机能跑通**，最终以 APK 为准。

### 第 3 层 · 无头冒烟（本仓库的核心验证）

```bash
npm run smoke:android     # Android 前端冒烟：390×844 手机视口 + mock SSE
npm run smoke:core        # 共用业务内核 + 工具链 + 三协议
npm run smoke:render      # 共用 React 界面的逐项断言
npm run smoke:guard       # CommandGuard 判定语料（十几秒，改命令规则必跑）
```

| 套件 | 覆盖 | 什么时候必须跑 |
| --- | --- | --- |
| `smoke:android` | 首屏、抽屉、输入区胶囊、底部选择器、全屏设置/工作区、内置 Shell 的 JS 回退、工作区镜像根与 cwd 一致、`run_js`（含死循环被 Worker 终止）、工作模式工具调用与收尾、mock SSE 流式回答、刷新后会话/配置仍在、页面无异常 | 改 `src/mobile/**`、`src/renderer/**`、`mobile.css`、构建配置 |
| `smoke:core` | 智能体加载、工具、技能、沙箱工作区、`run_js`、数据管道、持久化、三协议端点、Office 工具链、交互模式全链路、插件热加载 | 改 `src/core/**`、工具定义（`common/ToolRegistry.ts` 等）、提示词 |
| `smoke:render` | `react-dom/server` 渲染主要组件，断言 Markdown/LaTeX/代码块/mermaid、工具行、产物卡等 | 改 `src/renderer/**` |
| `smoke:guard` | 硬禁 / 危险 / 不打扰三档语料、规则覆盖自检、转义与拆词变体不降档 | 改 `CommandGuard` 或命令判定 |

`smoke:android` 依赖 `build:android` 的产物；找不到 Edge/Chrome 时会**跳过**并打印提示 ——
跳过不是通过，真机能力最终仍要自己装 APK 验。

桌面宿主的两套冒烟（`smoke:ipc`、`smoke:startup`）在改 `src/main/ipc.ts`、
`src/preload/index.ts` 或 Electron 入口时必须跑；同时别忘了 Android 侧还有一份
`src/mobile/host/index.ts` 要实现同一条通道（见「IPC 契约」一节）。

`smoke:core` / `smoke:render` / `smoke:ipc` / `smoke:startup` 用的是
**esbuild + 与构建配置一致的别名规则**，验证的是产物真实依赖的那套解析规则，而不是另起一套近似配置；
`smoke:android` 则直接跑 `build:android` 的产物，等价于真机加载的那份文件。

> `npm run smoke` 是桌面全量（会先构建 Electron，再跑四套宿主冒烟 + 字符扫描），
> Android 提交不必每次跑；按上表挑对应套件即可。

### 第 4 层 · 源码级护栏

```bash
node scripts/check-emoji.mjs src/renderer
node scripts/check-emoji.mjs src/mobile    # 改了手机端界面文案/样式时
```

有些界面纪律**类型检查和单测都拦不住**，漏了只表现为「界面上多了几个奇怪的字符」：

- 所有 `.ts/.tsx/.css/.html` 不得出现 emoji，也不得出现**当图标用的符号**（箭头、几何图形、
  装饰符号、带圈数字、制表符等）。中文标点、全角括号、省略号、`·`、`×`、`™` 这类正常文案是白名单。
- 新增图标请用 SVG 组件（`src/renderer/src/icons/index.tsx`），不要用字符画。

### 第 5 层 · 打包 APK（每次改动都跑一遍；动了构建脚本、Java 壳、资源清单时尤其不能省）

```bash
npm run dist:android
```

产物：`release/Guncat-Work-<version>-android.apk`（arm64，约 208MB）。脚本依次完成：

1. `vite build --config vite.mobile.config.ts` → `assets/public`
2. 复制 `resources/`（智能体提示词、技能库、图标）
3. `aapt2 compile/link` 生成资源 APK（含 `assets/termux/bootstrap-aarch64.zip`）
4. `javac --release 8` 编译 Java 壳
5. `d8 --min-api 28` 生成 `classes.dex`
6. `zipalign` 对齐、`apksigner` 签名

内置终端资源（约 205MB，因体积不入 git）缺失时脚本会**直接报错**并给出三步重建命令，
不会静默出一个没有终端的包：

```bash
python scripts/fetch-termux-bootstrap.py    # 下载官方 bootstrap + 工具链 deb（需联网）
python scripts/prepare-termux-bootstrap.py  # 等长改写 com.termux 前缀
python scripts/add-termux-packages.py       # 合并工具链
```

然后**装到真机上实际用一遍**。仓库没有托管 CI，第 1–4 层都要在本地跑，第 5 层与真机验证
更是只能本地做。最低限度：

1. 首启：等「设置 → 终端命令执行」显示内置终端「已就绪」；
2. 工作模式执行 `pwd; ls -la; echo hi > a.txt; cat a.txt; uname -a`，确认 `a.txt` 出现在工作区面板；
3. `python3 --version`、`git --version`、`git init && git status` 各跑一次；
4. 切到系统 Shell 重复第 2 步，确认兜底仍可用；
5. `sleep 60` 被超时杀掉；后台任务用 `job_kill` 结束；
6. 刷新/重启应用后，会话、配置、工作区文件都还在；
7. 返回键先关抽屉/弹层/工作区，连按两次才退出；键盘弹出时输入区不被遮挡。

> 首次构建会在 `android/keystore/` 生成自用签名密钥（密码见该目录 README）。
> **后续升级包必须用同一把钥匙签名**，换钥匙会导致覆盖安装失败；该目录已在 gitignore 内。

---

## 编码约定

### 一、`src/core/**` 是**逐字移植**的，默认不许改

`src/core/` 下的文件是从鸿蒙版 `entry/src/main/ets/{common,model,service,export,data}` 原样复制来的，
**目录结构与相对 import 路径完全一致**，平台依赖全部收敛在 `import ... from '@kit.*'` 与
`@core/platform/*`，由 `vite.mobile.config.ts` 别名解析到 `src/mobile/` 下的浏览器实现。

因此：

- **不要**为了「顺手改好一点」而修改共享内核的语义。这会让下一次与鸿蒙版同步变成逐行比对。
- **确实必须改**（平台差异、Bug、语义修正）的，**必须**登记进
  [`docs/ANDROID.md`](docs/ANDROID.md) 的平台差异一节；如果这条差异同时影响桌面版，
  还要同步 [`docs/PORTING.md`](docs/PORTING.md) 的补丁清单。
- **不要**在 `src/core/` 里放界面代码，也不要 import React / DOM / Electron / Android 专有的东西。
  业务内核必须保持可在纯 Node 下被 `smoke:core` 导入。
- 新写平台能力时，加在 `src/core/platform/`（纯接口）与 `src/mobile/`（实现）两侧，
  并在 `vite.mobile.config.ts` 的 `resolve.alias` **和** `PLATFORM_REDIRECTS` 各登记一次。
  后者不能省：core 里有按**相对路径**引用平台实现的文件（例如 `CommandService` 的
  `../platform/shellExec`），别名改不到相对说明符，只配 alias 会出现「桌面实现被打进 APK」。

### 二、TypeScript

- 项目是 `"type": "module"`（ESM）。Node 侧用 `node:` 前缀导入内置模块。
- 不要解构赋值写得让类型推断失效；移植代码里刻意避开了大量动态特性，新代码也请保持一致风格
  （显式类型声明、`let` 而非 `var`、箭头函数）。
- 移植代码里大量使用 ArkTS 风格的显式类型标注，**请勿**批量「现代化」，那会让补丁清单失效。

### 三、Java 壳（`android/app/src/main/java/`）

- 没有 Gradle、没有 AndroidX、没有第三方依赖：`javac --release 8` + `d8` 直接编。
  引入依赖前先想清楚会不会把无 Gradle 的构建链路拆掉。
- 语言级别是 **Java 8**（`var`、`switch` 表达式之类不能用），`minSdk 28`。
- 桥方法保持**窄接口**：每个 `@JavascriptInterface` 只做一件具体的事，参数与返回值都可校验；
  **不要**把 `Runtime.exec`、反射调用或「执行任意 Java」包成一个万能入口暴露给页面。
- 原生桥只做 WebView 做不到的事：保存/分享到 MediaStore、系统 TTS、文件选择、相机、
  `GuncatShell` 命令执行。业务逻辑留在 JS 侧。
- 改执行层、bootstrap 或工作区镜像边界时，同步更新 **README、`docs/ANDROID.md`、
  `docs/THIRD-PARTY.md` 与 `scripts/android-check.mjs` 的断言** —— 这四份是同一件事的四个侧面，
  只改一处会让下一个人按旧说法排查新问题。

### 四、真实命令执行与工作区镜像：这里最容易出事

`run_command` 在 Android 上是**真实进程**。入口仍是 `src/mobile/platform/shellExec.ts` 的
`ShellTask`，接口与桌面版逐字一致，所以 `CommandService` 的超时、审批、后台任务、输出截断
都不用改 —— **不要**为了「方便」再造一条执行路径。

- **两个后端**：随 APK 打包的 Termux 用户态（`abcd/bin/bash`，默认）、系统 `/system/bin/sh`（兜底）。
  `src/mobile/platform/shell.ts` 只是浏览器预览的 JS 回退，**不要**把它当成真机能力描述，
  也不要在它上面加只有真机才有的语义。
- **`targetSdk` 必须是 28**：Android 10+ 禁止 targetSdk ≥ 29 的应用执行私有目录里的文件，
  这是内置终端的硬前提（Termux 官方同款做法）。清单与 `scripts/build-android.mjs` 都写死 28，
  升到 29+ 会让 `exec` 直接失败。
- **不要改包名 `com.guncat.work`，也不要手改 bootstrap 里的路径。** Termux 二进制写死了
  `/data/data/com.termux/files/usr`（31 字符），构建期按**等长**规则替换成
  `/data/data/com.guncat.work/abcd`（31 字符），home 32→32（`abcde`）；改包名或路径长度会
  破坏 ELF 的 `.dynstr`/rpath/shebang。生成脚本是 `scripts/prepare-termux-bootstrap.py`
  与 `scripts/add-termux-packages.py`。
- **不要注入全局 `LD_LIBRARY_PATH`**：会把 Android 系统库也解析到 Termux 前缀的同名库，
  ffmpeg 的 `libhwui → libjpeg` 链会报 `tjInitDecompress`。需要临时覆盖时写成
  `LD_LIBRARY_PATH=... <命令>`，只作用于这一条命令。
- **不要把 `libandroid-stub` 加回工具链**：它放的是假系统库（`libbinder_ndk.so` 等），
  会遮蔽真库，`libvulkan → libui` 链加载失败。
- **工作区镜像有边界**：只镜像当前会话工作区，不同步设置/会话历史/API Key；单文件 8MB、
  单次 32MB 封顶；超限必须在命令结果里写明「没有同步」，**不许静默跳过**。
  镜像根与 `cwd` 必须是同一个真实目录（`fs*` 只接受 `/guncat/data` 内路径，Java 侧做
  canonical path 越界校验）。
- **输出上限与杀进程**：环形缓冲（前台 256KB / 后台 512KB）与按 `/proc` 递归杀子孙进程
  是防止 `yes` 撑爆 WebView、防止 `job_kill` 只杀 bash 的关键，不要简化。

### 五、危险命令审批（CommandGuard）

- 判定层在 `src/core/service/CommandGuard.ts`，审批链路在 `src/core/service/CommandService.ts`。
  内置 Linux 终端让「能跑什么」变多，但「谁批准」没有放宽 —— 硬禁不给审批入口、四档审批、
  fail-closed、脚本同审、`.spill/` 落盘都照旧。
- 改判定规则后，必须补 `scripts/guard-corpus.mjs` 的语料，并在
  `scripts/ipc-check.mjs` 补判定层 + 集成层各一组回归用例，同时确保「正常命令不被误伤」。
- 交付前跑 `npm run smoke:guard`、`node --check scripts/ipc-check.mjs` 与 `npm run typecheck`。

### 六、IPC 契约：改一处要动五处

`src/ipc/contract.ts` 是共享契约。Android 没有 preload，`window.guncat` 由
`src/mobile/host/index.ts` 在页面里实现，接口签名必须与 `src/preload/index.ts` 完全一致
（渲染层不允许写平台分支）。新增 / 修改一条通道时，五处要同时到位：

1. `src/ipc/contract.ts` —— 通道名与请求 / 响应类型
2. `src/main/ipc.ts` —— Electron 处理器
3. `src/preload/index.ts` —— contextBridge 暴露
4. `src/renderer/src/env.d.ts` —— `window.guncat` 的类型声明
5. `src/mobile/host/index.ts` —— **Android 侧实现**

第 5 处声明的是 `const api: GuncatApi`，漏了通常会在 `typecheck:mobile` 直接报错；
即便用 `as` 之类绕过去，真机上也会在第一次调用时 `undefined is not a function`。
改完跑 `smoke:ipc` 与 `smoke:android`。

### 七、网络与本机代理

WebView 的 `fetch` 受 CORS 约束，模型服务又必须 SSE 逐块到达，所以页面所有网络请求都走
**应用内 `127.0.0.1` 同源代理**：

- `GuncatServer` 只绑定回环地址，端口固定 **47653**：IndexedDB 与 origin 绑定，端口一变，
  上次的会话与配置就看不到了。只有端口被占用时才退回随机端口并在日志/提示里说明 ——
  不要为了「避免冲突」主动改端口。
- `/__fetch` 必须校验启动时注入的随机 token；不要为了调试关掉校验，也不要把它扩成
  「任意 URL 任意方法」的开放代理。
- 明文 HTTP 之所以放行（`network_security_config`），是因为本机代理与部分用户自建的
  局域网网关；**不要**把它当作可以直连任意公网 http 站点的许可。
- API Key 明文保存在应用私有配置中（Android WebView 没有桌面那套系统凭据保险库），
  设置页必须如实提示；**不要**在文案或文档里写成「已加密」。

### 八、界面（手机优先）

- 图标一律走 `src/renderer/src/icons/index.tsx` 里的 SVG 组件，**不要用 emoji 或符号字符**。
- 界面里的数字必须来自真实数据，不要在代码或提示词里编造。
- 深浅色主题用已有的 CSS 变量，不要写死颜色。
- 新界面必须检查 `src/mobile/mobile.css`（`max-width: 860px`）下的表现：
  - 触控目标 ≥ 40–44px，输入框字号 16px（防聚焦缩放）；
  - 顶栏/输入区/弹层底部用 `env(safe-area-inset-*)`，不要压到刘海与手势条；
  - 表格横向滚动，代码块/Mermaid 不撑破屏幕；
  - 键盘弹出时用 `adjustResize` + `--app-height`（visualViewport），不要写死 `100vh`；
  - 设置、工作区、表格提取是**全屏页**，不是把桌面弹窗按比例缩小；
  - 只有 `(hover: hover) and (pointer: fine)` 才挂 hover 样式，触摸屏上只保留 `:active` 反馈。
- 返回键顺序：先关抽屉/弹层/工作区，再退出；连按两次返回才真正退出
  （`MainActivity.onBackPressed`）。新增全屏层时要把自己接进这个顺序。
- 桌面端也会加载同一套组件，改动不要只盯着手机宽度，把桌面三栏也扫一眼。

---

## 红线

- **`targetSdk` 必须保持 28。** 这不是「懒得升级」：Android 10+ 禁止 targetSdk ≥ 29 的应用
  执行私有目录里的文件，升上去内置终端直接不能用。`minSdk` 同为 28。
- **不要改包名，也不要改 Termux 的等长路径方案。** 二进制里的路径按 31/32 字符写死，
  改包名或换别名目录会让 ELF 解析失败；相关脚本与清单要一起改才算完整。
- **不要提交生成物与大文件**：`android/app/src/main/assets/public/`、`assets/termux/bootstrap-aarch64.zip`、
  `android/keystore/*.jks`、`.android-sdk/`、`out/`、`release/`、`.smoke/`、`.tmp/`
  都在 `.gitignore` 内，不要用 `git add -f` 把它们带进来。
- **不要绕过工作区镜像的边界**，也不要把「同步失败」吞掉：用户看到命令结果，就必须能相信
  工作区里真是那批文件。
- **不要新增第二条命令执行路径**（JS `eval`、系统 `Runtime.exec` 直通、隐藏的 shell 接口都不行）。
  执行统一走 `ShellTask` → `GuncatShell` 桥 → `ShellManager`；判定与审批留在 core。
- **提示词与工具面边界有断言守着。** 工作模式与交互模式共用同一套循环，但下发的工具面不同
  （工作模式全量，交互模式是被裁剪的子集）。`scripts/smoke.ts` 里有针对性的断言，
  不要为了让某个 case 过关而放宽它。
- **改了 `src/core/**` 的纯逻辑，要同步补 / 改 `scripts/smoke.ts` 的断言。**
  这个仓库的习惯是「修一处缺陷，加一组断言」。
- **不要扩大权限面。** 清单里现有 `INTERNET` / `ACCESS_NETWORK_STATE` / `RECORD_AUDIO` /
  `MODIFY_AUDIO_SETTINGS` / `POST_NOTIFICATIONS`；新增权限必须有明确用途，并在设置页/README
  说明用户能感知到的后果。
- **不要假设 WebView 一定在前台。** 应用退到后台可能被系统冻结，长任务没有前台服务；
  文档与提示文案不要承诺「后台继续跑」。
- **不要用桌面行为冒充 Android 能力。** 浏览器预览、系统 Shell 兜底、arm64 限定、
  镜像大小限制，这些差异要在 README / 设置页 / 工具结果里说清楚。

---

## 改哪块看哪份文档

| 你要改的东西 | 先读 |
| --- | --- |
| Android 架构、平台替换、Shell/Termux、镜像、代理 | [`docs/ANDROID.md`](docs/ANDROID.md) |
| 桌面版 ↔ 鸿蒙版移植档案、`@kit.*` 对照、core 分歧清单 | [`docs/PORTING.md`](docs/PORTING.md) |
| 交互模式、`guncat-ui lang` 数据流、组件覆盖 | [`docs/INTERACTIVE-MODE.md`](docs/INTERACTIVE-MODE.md) |
| Termux bootstrap 来源与许可证义务 | [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md) |
| 客户端功能全貌、安装与构建、已知限制 | [`README.md`](README.md) |
| 版本变更史 | [`CHANGELOG.md`](CHANGELOG.md) |
| 桌面 Electron 启动失败、白屏（只与 `src/main/` 有关） | [`docs/STARTUP-TROUBLESHOOTING.md`](docs/STARTUP-TROUBLESHOOTING.md) |

---

## 提交与 PR 流程

1. Fork 仓库，从 `main` 创建功能分支。
2. 完成修改，按上面的验证矩阵逐层跑通，并在 PR 里写清跑了哪几层、没跑哪几层。
3. 提交，遵循下面的提交信息约定。
4. 发起 Pull Request，说明**改了什么、为什么、怎么验证的**；有 UI 改动请附 390×844 视口
   或真机的前后截图，涉及 Shell/工作区/APK 的改动请写清真机型号与 Android 版本。

### 提交信息约定

仓库使用 Conventional Commits，描述用中文：

```
feat(ui): 输入区改为单行，拍照/相册/文件合并到加号
fix(shell): 终端与工作区共用同一目录，list_files 不再各看一份
fix(mirror): 只读文件回写失败不再每条命令都刷「写入设备失败」
docs(android): 补上 Termux 等长路径与 targetSdk 28 的前提说明
```

- 类型：`feat` / `fix` / `docs` / `style` / `refactor` / `chore` / `test`
- `scope` 用模块名（`ui` / `shell` / `mirror` / `termux` / `proxy` / `build` / `porting` / `docs` 等）
- 描述写清**行为变化**，真机缺陷建议带上根因，例如上面那条 `fix(mirror)`。

---

## 行为准则

- 讨论对事不对人；技术分歧用证据（日志、截图、最小复现）说话。
- 提 Issue 前先看一眼 README 的「已知限制」与现有 Issue；真机问题请附机型、Android 版本、
  是否使用内置终端、能否用系统 Shell 复现。
- 一个人维护的项目，回复可能不快，但每条都会看。
