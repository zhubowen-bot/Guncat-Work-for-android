# 平台适配与差异说明：电脑版 Guncat Work ↔ 鸿蒙版 Guncat Work

本文记录电脑版与鸿蒙版之间的平台适配、已完成的实现差异，以及**对共享代码做过的修改**。
与鸿蒙版同步时，先看本文的「差异清单」。

上游参考仓库：`Guncat-Work-for-hmos`（ArkTS / ArkUI，API 24）

## 0. 阶段状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 一 | 三协议流式对话 + 工作模式 Agent Loop + 沙箱工作区 + 核心工具 | ✅ 已完成 |
| 二 | 交互模式：guncat-ui lang 渲染（76 个组件 + `$绑定` + 动作回传） | ✅ 已完成，见 [交互模式实现说明](INTERACTIVE-MODE.md) |
| 三 | Office 生成器接入工具链 + 技能系统 | ✅ 已完成（生成→读回→算子编辑端到端验证） |
| 四 | 端侧增强：朗读 / 语音输入 / 文件收件 / 导出 Word | ✅ 已完成 |
| 五 | 平台适配层的两个「后端缺席」补完：PDF 解析、SVG 栅格化 | ✅ 已完成 |
| 六 | 补上「内核已移植、但没有任何调用点」的那一批能力 | ✅ 已完成 |
| 七 | 逐项对标审计后的第二轮补齐（界面与体验语义） | ✅ 已完成 |

验证方式见 [README 的验证矩阵](../README.md#验证)：`npm run typecheck` / `npm run build` /
`npm run smoke`（内核 341 项 + 渲染 272 项 + 契约 247 项 + 启动链路 150 项 + 字符扫描，共约 1010 项断言）。
移植内核的起点是上游的 521 项纯逻辑回归，两边的断言口径不同：上游测的是 ArkTS 源码，
这边测的是**跑在 Node 下、经别名解析后的同一套逻辑**。

### 阶段七：逐项对标审计后的第二轮补齐（界面与体验）

阶段六解决的是「内核有能力、没人调用」。阶段七换了方法：**逐文件对照原版的
`@Builder` 参数、守卫条件与状态语义**做一次全量审计，凡是「原版有、桌面端没有或口径不同」
的都记进清单再逐条修。这一轮补出来的东西大多不是新功能，而是**语义与规格的差异**，
单看代码会很不起眼，但叠起来就是「用起来不像同一个应用」。

| 类别 | 原版口径 | 桌面端此前 |
| --- | --- | --- |
| 会话标题 | 首轮交付后用模型起一个不超过 12 字的标题（每会话一次，失败静默） | `generateSessionTitle` 已移植但**零调用点**，标题一直是「首条用户消息截前 12 字」 |
| 图片查看 | 点图看大图（全屏遮罩 + Contain + 关闭钮） | 整条链路不存在；**并且**正文里任何 `data:` 图片都会被 react-markdown 的默认 `urlTransform` 剥掉（静默不显示） |
| 附件 | 选完立刻出现卡片（解析中→已就绪/失败），解析中不可发送 | 发送时才解析，界面没有任何解析状态 |
| 停止/上限/失败 | 在轮次正文末尾追加标注（`任务已手动停止` / `达到模型上限…` / `⚠️ 原因`），折叠栏标题改「已停止」 | 停止后的回答和「正常答完」一模一样；`turn:finished` 在无工具调用那条路径上还把状态写死成 `ok` |
| 上下文预算 | 三级策略：修剪早期工具结果 → 摘要压缩重建 → 仍超预算从最旧处裁剪，并在正文里说明 | `WORK_PRUNE_*` / `WORK_COMPACT_*` 常量零调用点，工作循环的 `messages` **只增不减** |
| 工具行 | 两种形态（聊天紧凑 / 工作与交互宽松），右端四分支状态文案（执行中/生成调用中/等待中/已中断/失败/耗时） | 只有一种形态，且没有 `started`/`preparing` 字段，永远显示「等待中」 |
| 界面块可交互性 | 聊天与工作模式只看是否在流式（历史界面块仍可操作）；交互模式只放开最新一轮 | 三种模式都按「只有最新一条可交互」处理 |
| 界面块回传 | 分两类：`action` 要重算（滚到底），`state` 只本地调参（**不动滚动**） | 两类都补正文，于是拖滑块时页面被拽到底部 |
| 设置面板 | 三块可折叠区、按接入方式变化的占位符与提示、多模态字段随「先行解析」整组显隐 | 全部平铺，占位符与提示是写死的 |
| 统计与详情 | 「本轮统计」四行（整数秒 / 字符每秒 / 缓存命中 / 工具调用轮数）+ 会话工作时间 MM:SS | 2×2 方块、小数秒、耗时里没有工具段 |
| 提示条 | 1 秒自动消失、点击穿透、白字 + `toast_bg` + 圆角 24 | 挂 6 秒、带关闭钮、拦住点击 |
| 输入区 | 语音在输入框**左侧**，生成中/解析中不给录音不给发 | 语音在右侧，只有转写中才禁用 |

这一轮同时把「审计报告本身报错的地方」改回来了：审计说「工具执行中不显示展开箭头」，
核对源码后原版是**无条件渲染**的；审计说「只有最新一条界面可交互」，
实际只有交互模式如此。**结论：审计结果要回到源码复核，否则会把对的东西改错。**

---

### 阶段六：补上「内核已移植、但没有任何调用点」的那一批能力

阶段一到五把内核搬完了，但对照原版做了一次系统审计后发现：**一批已经移植好的能力在桌面端
一个调用点都没有**。它们不是「没实现」，而是「实现了但没人用」—— 这类问题比功能缺失更隐蔽，
因为代码看起来是齐的，用户却会遇到「模型说会提醒，到点什么都不发生」。

| 能力 | 症状 | 桌面端做法 |
| --- | --- | --- |
| 聊天模式附件（`MultimodalService` / `FileUploadService`） | 加附件等于没加：`makeAttachments` 只留文件名，`dataUrl`/`parsedText` 全空，三条协议都因「既无文本又无图」直接跳过 | 回形针 + 预览条 + `attachments:pick`；发送路径上按原版 `enqueueFiles`/`parseOneFile`/`prepareAttachmentFileIds` 真正读文件、先行解析、大文件走 Files API |
| 定时提醒（`ScheduleService.tick`） | 模型调 `schedule_create` 成功返回、还会说「5 分钟后提醒你」，但**到点什么都不发生**（静默失效） | `SessionManager.startScheduleTicker()` 每秒推进，到期注入「【定时提醒】…」并唤醒一次工作循环 |
| 产物汇总（`WorkArtifacts`） | 一轮跑完看不到「改了哪些文件、各加减多少行」 | `conversation:artifacts` + 对话流末尾的 Changes 卡（`WorkArtifactsCard`） |
| 表格提取（`TableOcrService`） | 原版唯一一个不依赖对话的独立工具页，桌面端完全不存在 | 顶栏入口 + `tableOcr:run`；识别结果是**模型生成的 HTML**，因此主进程按白名单重建后才交给渲染层（`src/main/sanitizeHtml.ts`） |
| 插件热加载（`PluginHotLoader`） | 随包的 `plugins/plugin_list.json` 无人读，插件工具一律「插件未实现」 | 补上 `service/PluginHotLoader.ts`（原文件此前没有移植），`bootstrap()` 里加载 |
| 当前目标（`GoalService.read`） | 跑长任务看不到「当前目标是什么」 | 工作区面板的目标卡（随统计卡一起下发） |
| 自动朗读（`reader_enabled`） | 偏好键清单里一直有它，却没有任何读写点 | `speechStore.autoRead` + 设置面板开关；只在一轮结束的那一次跃迁上朗读 |

同时修掉三处**会真的伤到用户**的缺陷：

| 缺陷 | 后果 | 修法 |
| --- | --- | --- |
| `NetworkKit` 把 `readTimeout` 当整段超时 | 工作模式流式超 5 分钟、聊天超 3 分钟**必然以网络错误中断**，哪怕数据一直在流 | 改成读空闲计时（每收到一块数据重置），`connectTimeout` 单独覆盖「未拿到响应头」那一段 |
| 推理强度被写死在主进程（`high`/`none`） | 工作模式永远拿不到 Max 档，也没法选 Low 提速 | 契约加 `reasoningEffort` + 顶栏档位选择器（按形态分键持久化，与原版同名） |
| 提示词把桌面版描述成手机/鸿蒙应用 | 模型自称「在 HarmonyOS 平台原生构建」、说「无法访问手机其他目录」，mermaid 按手机竖屏排版 | 22 处平台语义改为桌面端措辞（详见第 5 节的补丁清单） |

另外补齐了几处「IPC 齐全、渲染层零调用点」的界面：**配置方案**（多套 API 配置）、
工作区的**文件预览**、聊天模式下的**工作区面板**、侧栏的**引擎分组**、
执行中的**插话**（对齐原版 workSteerQueue）、工具行的 **diff 卡与任务清单卡**、
工作区面板的**任务统计卡**，以及**产物汇总卡**。

---

### 阶段五：平台适配层的两个「后端缺席」补完

阶段一到四把接口都搭好了，但有两处平台后端一直没人装，症状都被包装成了「文件坏了」：

| 能力 | 桌面端做法 | 说明 |
| --- | --- | --- |
| PDF 解析（`parse_document` / `search_pdf` / `pdf_to_images`） | ✅ PDF.js（`pdfjs-dist`）+ `@napi-rs/canvas` | 见 `platform/native/pdfBackend.ts`。此前 `PdfDocument.loadDocument` 看到 `backend === null` 就返回 `PARSE_ERROR_FORMAT`，而它的文案是「PDF 格式解析失败(文档结构损坏)」—— 于是**任何** PDF、任何来源都得到同一句话。两处平台差异：PDF.js 全异步（新开 `loadDocumentAsync` + `PdfPage.prepare()`，不动移植调用链）、主进程没有 canvas（渲染页面靠 `@napi-rs/canvas`）。 |
| SVG 栅格化（`write_svg` 的预览 PNG、docx/pptx 引用 svg） | ✅ `@napi-rs/canvas` 的 `loadImage`（底层 resvg） | 见 `platform/native/svgRaster.ts`。此前走 Electron 的 `nativeImage`，而它**只解码位图**（PNG/JPEG），喂 SVG 必然失败 —— 所以源码存得下、预览 PNG 出不来，两条引用路径跟着一起失败。 |

两者的随包数据（PDF 的 standard_fonts / cmaps / wasm）与不能进 bundle 的依赖
（`pdfjs-dist`、`@napi-rs/canvas`）由 `scripts/package-portable.mjs` 放进产物，
它们是这个项目里唯一的运行时 `node_modules` 内容。缺任何一块都不会「报文件损坏」：
文本抽取退化成缺字体度量，渲染退化成一条明确的「缺渲染能力」提示。

---

### 阶段四：哪些照搬、哪些必须换思路

| 鸿蒙能力 | 桌面端做法 | 说明 |
| --- | --- | --- |
| CoreSpeechKit 朗读 | ✅ 渲染进程 Web Speech API（`speechSynthesis`） | 音色取自系统 voice 列表；不再需要 AVSession 与后台长时任务（桌面端没有这些概念）；进度用 `onboundary` 逐词近似 |
| CoreSpeechKit 语音识别 | ⚠️ **换实现**：录音 + 服务商转写接口 | 桌面端没有端侧识别可用（Chromium 的 `SpeechRecognition` 在 Electron 里依赖 Google 语音服务凭据，默认不可用）。改为 `MediaRecorder` 录音后 POST 到 OpenAI 兼容的 `/audio/transcriptions`；配置**默认复用多模态预解析**的 Base URL 与 Key，可用偏好覆盖，不需要用户理解新的一套配置块。服务商不支持转写时会明确报错 |
| 系统分享接收 | ✅ 命令行参数 / 第二实例 / 窗口拖拽 | 桌面端的「分享」等价入口。文件进**沙箱工作区**（由模型用文件工具读取），不自动当附件送出 —— 与鸿蒙版行为一致 |
| 导出回答为 Word | ✅ 复用移植的 `DocxBuilder` | 含 LaTeX → OMML 原生公式；交互模式的界面程序会被剥离，只导出文本 |

### 阶段三说明：Office 工具链为何无需改动

`write_docx` / `write_xlsx` / `write_pptx` 及其读回与算子编辑（`read_*` / `edit_*`）
在鸿蒙侧本来就走 `WorkToolRunner` 分发到 `export/` 下的纯 TS 生成器。
平台层把 `fileIo` / `util` / `zlib` 补齐之后，这条链在桌面端**原样可用**：

- 生成器本身不依赖任何 ArkUI（已确认 `export/` 下零装饰器）；
- `zlib.decompressFile` 实为 zip 解包，已用 `fflate` 对齐；
- 内嵌 JSON 源的无损读回机制不涉及平台差异。

`transform_file`（数据管道）同样是纯逻辑，CSV/TSV/JSON/Markdown/XLSX 互转直接可用。

技能系统（`list_skills` / `load_skill`）只依赖 `resourceManager.getRawFileContent`，
已映射到随包 `resources/` 目录，37 项技能与参考文档均可按需加载。

**已完成**：PDF 解析后端（`parse_document` / `search_pdf` / `pdf_to_images`）已接上 PDF.js，
见本节上方的「阶段五」。另见 `platform/kit/PDFKit.ts` 与 `platform/native/pdfBackend.ts`。

---

## 1. 核心策略：**别名替换，而不是改写代码**

鸿蒙侧的 110 个源文件里，只有约 15% 是真正的 ArkUI 界面代码，其余是纯业务逻辑。
这些逻辑文件里的平台依赖**全部收敛在 `import ... from '@kit.*'` 这一行**。

因此电脑版没有去逐个改写这些文件，而是：

1. 把上游 `entry/src/main/ets/{common,model,service,export,data}` 原样复制到 `src/core/`，
   **保持目录结构与相对 import 路径完全一致**；
2. 在 `src/core/platform/kit/` 下实现 `@kit.*` 的桌面等价物；
3. 在 `electron.vite.config.ts` 与 `tsconfig.node.json` 里把 `@kit.*` 别名指过去。

于是 `src/core/` 下的移植文件**几乎不需要改动 import**，上游更新时可以整体覆盖再重跑类型检查。

```ts
// 端口代码里保持原样：
import { http } from '@kit.NetworkKit'
import { fileIo } from '@kit.CoreFileKit'
import { util } from '@kit.ArkTS'
// 由 bundler 别名解析到：
//   src/core/platform/kit/NetworkKit.ts（基于 fetch 的流式实现）
//   src/core/platform/kit/CoreFileKit.ts（基于 node:fs）
//   src/core/platform/kit/ArkTS.ts（基于 node:util）
```

### 另外两个别名

| 上游 | 电脑版实现 | 说明 |
| --- | --- | --- |
| `libguncatjs.so`（JSVM-API 原生模块） | `src/core/platform/native/libguncatjs.ts` | 改用 `node:vm`，见第 4 节 |
| `.ets` 扩展名 | 一律重命名为 `.ts` | 上游 `export/`、`service/` 下的 `.ets` **没有任何 ArkUI 装饰器**，是纯 TypeScript，重命名即可编译 |

---

## 2. 分层与目录

```text
src/
├── core/                      # 上游业务逻辑（几乎逐字移植，禁止放界面代码）
│   ├── common/                # 提示词、工具注册表、guncat-ui lang、数据管道、diff…
│   ├── model/                 # Message / Conversation / ApiConfig / Agent…
│   ├── service/               # 三协议 SSE、Agent Loop、工具执行、技能、沙箱工作区…
│   ├── export/                # Docx / Xlsx / Pptx / Svg 生成器与导入器
│   ├── data/                  # StorageManager
│   └── platform/              # ★ 电脑版新增：平台适配层
│       ├── appPaths.ts        #   应用沙箱目录（对应鸿蒙 filesDir）
│       ├── kit/               #   @kit.* 的桌面等价实现
│       └── native/            #   libguncatjs.so 的 node:vm 实现
├── main/                      # Electron 主进程：窗口、IPC、服务编排
├── preload/                   # contextBridge 安全桥
└── renderer/                  # React 界面（对应上游 views/ + pages/）
```

---

## 3. 平台适配层逐一对照

| 鸿蒙 `@kit.*` | 电脑版实现 | 关键差异处理 |
| --- | --- | --- |
| `@kit.NetworkKit`（http） | `platform/kit/NetworkKit.ts` | `createHttp()` 的 `request` / `requestInStream` + `on('dataReceive'/'dataEnd')` 事件模型完整还原；底层用全局 `fetch` 按 Web Streams 逐块读取。上游 SSE 链路用 `dataEnded` 标志做了双向兼容，因此「状态码先到」或「dataEnd 先到」都不会丢事件 |
| `@kit.CoreFileKit`（fileIo / picker） | `platform/kit/CoreFileKit.ts` | 上游只用到三种打开模式（`READ_ONLY`、`RW\|CREATE\|TRUNC`、`RW\|CREATE\|APPEND`），与 POSIX 常量一一对应，因此**数值标志直接透传** `fs.openSync`；`picker` 通过 `registerPickerHost` 注入 Electron dialog，实现延迟到启动时绑定 |
| `@kit.ArkTS`（util） | `platform/kit/ArkTS.ts` | `TextEncoder/TextDecoder/Base64Helper` 用 `node:util` 对齐；`TextDecoder.create(...)` 的流式 `{stream:true}` 语义保留 |
| `@kit.BasicServicesKit`（zlib） | `platform/kit/BasicServicesKit.ts` | ⚠️ 名字叫 zlib，实际语义是「把 zip 解包到目录」（docx/xlsx/pptx 都是 zip），因此用 `fflate.unzipSync` 而不是 `zlib.inflate`；已加防目录穿越校验 |
| `@kit.AbilityKit`（common） | `platform/kit/AbilityKit.ts` | `context.filesDir/cacheDir/tempDir` 由 `appPaths` 提供，**保持 `<filesDir>/workspaces/<会话ID>` 等全部子路径结构不变**；`resourceManager.getRawFileContent()` 映射到随包 `resources/` 目录 |
| `@kit.ArkData`（preferences） | `platform/kit/ArkData.ts` | 落成 `<filesDir>/preferences/<name>.json`，保留「`put` 不落盘、`flush` 才落盘」的语义 |
| `@kit.ImageKit`（image） | `platform/kit/ImageKit.ts` | 用 Electron 内置 `nativeImage` 实现解码/缩放/重编码。**但它只认位图**（PNG/JPEG/WebP），SVG 栅格化与 PDF 页面渲染改由 `platform/native/canvas.ts`（`@napi-rs/canvas`）承担 |
| `@kit.PDFKit`（pdfService） | `platform/kit/PDFKit.ts` + `platform/native/pdfBackend.ts` | ✅ 后端已接 PDF.js。新增 `loadDocumentAsync` 与 `PdfPage.prepare()` 承载「PDF.js 全异步」这条平台差异；渲染页面用 `@napi-rs/canvas`（主进程没有 canvas）。`setPdfBackend()` 注入点保留，便于测试注入假后端 |
| （无对应 kit）SVG 栅格化 | `platform/native/svgRaster.ts` | 上游交给设备图片引擎；桌面端 `nativeImage` 解码不了 SVG，改用 `@napi-rs/canvas` 的 `loadImage`（底层 resvg） |
| （无对应 kit）图像后端 | `platform/native/canvas.ts` | PDF 渲染与 SVG 栅格化共用的 canvas 加载器：惰性 `require`、补 PDF.js 需要的浏览器全局、缺模块时给统一可读提示 |
| `@kit.PerformanceAnalysisKit`（hilog） | `platform/kit/PerformanceAnalysisKit.ts` | 归一 `%{public}s` 格式串后走 console |

### 编译器设置对齐

ArkTS 与 TS 在空值上语义不同（ArkTS 的 `Object` 接受 `null`），
因此 `tsconfig.node.json` 里关闭了 `strictNullChecks` / `strictFunctionTypes`，
但**保留 `noImplicitAny`**，以便新写的代码仍能抓到真正的错误。
被移植的 35k 行代码本来就由 ArkTS 编译器与上游 521 项回归测试验证过。

---

## 4. 桌面端相对鸿蒙版的**能力增强**

### 4.1 `run_js`：死循环可以被真正中断

上游用 JSVM-API，注释里明确写了：

> JSVM 引擎没有中断接口，这段代码仍在后台线程里运行

于是上游只能「超时放弃等待」，并累计 `abandoned` 计数、两次后停用本会话的 `run_js`。

电脑版改用 `node:vm` 的 `runInContext(code, ctx, { timeout })`，**引擎会真正中断**执行，
并且把调用方给出的 `timeout_ms` 直接作为 vm 的中断预算
（`JsCodeService` 里新增一行 `timeoutMs: timeoutMs` 透传）。因此：

- 死循环会在**调用方预算内**被终止，而不是「放弃等待但后台继续烧 CPU」；
- 脚本的「最后一条表达式的值即返回值」语义由 `vm` 的完成值天然满足，与上游契约一致。

**边界（容易说错，这里写明）**：`vm` 的 `timeout` 只覆盖 `runInContext` 的**同步**执行段。
脚本里 `await` 一个永不 settle 的 Promise 属于异步悬挂，不在这个预算内 ——
那条路仍走上游的 `abandoned` 兜底（`JsCodeService.awaitWithTimeout` 放弃等待并累计，
两次后停用本会话的 `run_js`）。也就是说：**同步死循环可被引擎硬中断；异步悬挂仍靠放弃等待。**
早先这里写的是「abandoned 在桌面端永不触发」，那只对同步死循环成立。

沙箱边界与上游完全一致：无网络、无文件系统、无 `require`/`import`；
文件只能通过 `inputs` / `read()` 进、`write()` 出。

> 冒烟脚本里有一条针对性的回归：`while(true){}` 必须在 10 秒左右被中断并返回超时错误。

### 4.2 rawfile 访问带目录穿越防护

上游直接读应用内 rawfile；电脑版读的是真实文件系统，
因此 `ResourceManager.resolve()` 强制校验解析后的路径必须落在资源目录内。

---

## 5. 差异补丁清单（与鸿蒙版的唯一分歧）

以下是对**上游移植文件**做过的修改。同步上游时按此清单重新施加即可。

| 文件 | 补丁 | 原因 |
| --- | --- | --- |
| `core/common/Utils.ts` | 删除 `@kit.ArkTS` 的 `util` import，改用 Web 标准 `TextDecoder` | 该文件同时被渲染进程使用，必须保持平台无关 |
| `core/model/Message.ts` | 删除类上的 `@Observed` 装饰器 | `@Observed` 是 ArkUI 的追踪装饰器；编译产物会引用这个全局符号，桌面端不存在它（**不删会在运行时直接崩**）。桌面端状态刷新由渲染进程 store 负责 |
| `core/common/ToolExecutionGuard.ts` | `timer`/`poller` 类型 `number` → `ReturnType<typeof setTimeout/Interval> \| null`，哨兵 `-1` → `null` | Node 的定时器返回 `Timeout` 对象而非 `number` |
| `core/service/SubagentService.ts` | 同上（`abortPoller`，2 处哨兵比较） | 同上 |
| `core/service/JsCodeService.ts` | ① `timer` 类型同上；② `JsRunOptions` 里新增 `timeoutMs` 透传 | ①同上；②让 vm 按调用方预算硬中断（见 4.1） |
| `core/service/FileUploadService.ts` | `stringToBuffer()` 返回值加 `as ArrayBuffer` | TS 的 `Uint8Array.buffer` 类型是 `ArrayBufferLike`（含 `SharedArrayBuffer`） |
| `core/service/PdfTextExtractor.ts` | 三处 `doc.loadDocument(abs)` → `await doc.loadDocumentAsync(abs)`；取每页文本/渲染前 `await page.prepare()`；`renderOnePage` 由同步的 `getAreaPixelMapWithOptions`/`getPagePixelMap` 改为 `await page.renderToPixelMap(w,h)` | 桌面端的 PDF 后端（PDF.js）全程异步，鸿蒙侧那条同步原生链在 Node 下不存在。差异只落在这两个入口上，其余移植逻辑不变 |
| `core/service/WorkToolRunner.ts` | ① `rasterizeSvgFile` 去掉「写临时规整文件 → `image.createImageSource` 解码 → 清理」那一圈，改为 `rasterizeSvgToPng()`；参数去掉 `cacheDir`。② 抓网页的 UA 从 `Mozilla/5.0 (Linux; HarmonyOS) GuncatWork` 改成桌面 UA | ①Electron 的 `nativeImage` 只解码位图，SVG 必须走 `@napi-rs/canvas`；同时消掉了临时文件与 cacheDir 依赖。②UA 声称鸿蒙会让部分站点返回移动端页面 |
| `core/platform/kit/PDFKit.ts` | 新增 `PdfBackend.openAsync?`、`PdfPageBackend.prepare?`、`PdfDocument.loadDocumentAsync`、`PdfPage.prepare()`；两个同步渲染方法改为抛出「请用异步 renderToPixelMap」 | 承载上述异步差异；平台适配层本来就不是逐字移植的部分 |
| `core/platform/kit/NetworkKit.ts` | `buildSignal` 的 `readTimeout` 由一次性整段超时改成**读空闲**计时（每收到一块数据 `refreshReadTimer`）；`connectTimeout` 单独覆盖「未拿到响应头」那一段；`destroy()` 清理两个计时器 | 端口代码传的是鸿蒙的读空闲语义（工作 300000 / 聊天 180000）。当成整段超时的话，**任何超过 5 分钟的流式都会被硬掐断** |
| `core/platform/kit/ImageKit.ts` | 新增 `image.createPixelMapFromBuffer()` | PDF.js 渲染出来的是 PNG 字节，端口代码期望 PixelMap；让 Electron 的依赖只经由本模块 |
| `core/service/HarnessTools.ts` | **已恢复**：`ask_user_question` 的工具定义与调度分支照原版回来，`AskUserBridge` 导入一并恢复 | 这条补丁曾把该工具删掉（改成回一句「本平台没有提问界面，请用默认假设继续」），理由是原版的 `views/AskUserCard.ets` 没移植，真挂起等待就会一直挂到 5 分钟超时。**现在界面那一半补齐了**（AskUserBridge 通知 → `ask:user`/`ask:done` 事件 → 渲染层 `AskUserCard` → `work:answer` → 桥 resolve），于是恢复原版行为；超时与中止两条兜底路径都还在。 |
| `core/service/SubagentService.ts` | **已恢复**：`'ask_user_question'` 回到 `excludedTools()` | 与上游逐字一致 —— 子代理本来就没有宿主界面通道，工具面必须排除它，否则子代理提问同样会挂到超时 |
| `core/service/AgentLoopService.ts` | ① 写文档工具说明与「需求分析」流程条目里的「新建前必须 ask_user_question 前置提问」**已恢复原版措辞**；② 静态工具清单里的 `ask_user_question` 条目**已恢复**；③ 平台文案：`HarmonyOS 平台原生构建` → 桌面端、`手机竖屏/手机其他目录/手机可读格式` → 平台无关措辞 | ①② 工具回来了，提示词也必须跟着回来，否则模型根本不知道该问。③ 逐字保留的原版文案会让模型自称鸿蒙手机应用、按手机窄屏排版 |
| `core/common/PromptBuilder.ts` | 同上三项（工具说明、需求分析条目、工具清单、平台文案）；交互模式那一条已恢复成原版的「不要 ask_user_question: 要问就用界面问」 | 同上；交互模式**不在**工具白名单里，那条纪律的原文口径本来就准确 |
| `core/service/WorkFileService.ts` | 三个写文档工具的描述恢复原版；`search_web` 结果头部与注释里的「手机直连」改为「本机直连」 | 同上 |
| `core/service/WorkSkillService.ts` | ppt/docx/xlsx 技能描述恢复成原版的「新建前须前置提问」 | 同上 |
| `core/service/LocalWebSearch.ts` | 工具自述与结果文案里的「手机本地网络 / 手机内置 / 手机直连」改为「本机」 | 原版这么说是因为它真的跑在手机上；桌面端会据此说错话 |
| `core/service/WebFetchService.ts` | `User-Agent` 从 `Mozilla/5.0 (HarmonyOS) GuncatWork/6.1` 改成桌面 UA | 同上 |
| `core/common/GuncatUiLibrary.ts` | 组件提示文案「横向卡片轮播(手机上比网格更好读)」改为「在窄栏里比网格更好读」；「横向条形图(手机竖屏最易读)」改为「排名类数据在窄栏里最易读」 | 交互模式的组件选择说明，同样是平台措辞 |
| `resources/skills/{docx,xlsx,ppt}/SKILL.md`、`ppt/reference/design-guide.md` | **已恢复**：整节「默认假设门」改回原版的「前置提问门」（5 项问题表、`options` 建议、跳过条件都照原版） | 与上面的 ask_user_question 恢复配套：技能要求「新建前必须问」，工具与卡片都就位了才成立 |
| `core/common/PromptBuilder.ts`、`core/service/AgentLoopService.ts` | 「Mermaid 导图」一节从**手机竖屏口径**改写为**桌面口径**：图种按语义选（新增 `flowchart LR` / `mindmap` / `gantt` / `pie` / `quadrantChart` 可用）、节点 ≤ 8 → ≤ 20、同层分支 ≤ 3 → ≤ 5、subgraph 允许一到两层、标签 ≤ 10 字 → ≤ 16 字且「含标点时用双引号包住」、布局参数 `useMaxWidth` 由 `true` 改为 `false`；自检清单一并更新 | 原规范是为**手机窄屏**写的（"宁可加深层级，不加宽分支"、禁止 LR 与 mindmap、"缩到屏宽后文字不可读"）。桌面端对话栏宽约 800px 且**可以横向滚动**，再按窄屏压扁结构就是白白牺牲表达力 |
| `resources/Guncat {3.0-Flash,3.0-Pro,3.1-Flash}_prompt_{ZH_CN,EN}.md` | 同上口径的六个智能体提示词版本（`## 7.0/8.0 回答开头 Mermaid 结构图`、3.1 的 `## Mermaid 输出规范`，以及顶部摘要行与交付自检行） | 这几份是**随包资源**，会被整体覆盖；不记进本表，同步上游时手机口径会悄悄回来 |

> 除上表外，`src/core/` 下**没有**对上游逻辑做过任何语义修改。
> 同步上游时请按本表逐条重新施加。**`ask_user_question` 那几条现在是「不要删」而不是「要删」**：
> 整体覆盖上游之后，只要渲染层的提问卡片链路（`AskUserBridge` 通知 → `ask:user` → `AskUserCard` → `work:answer`）
> 还在，工具就是可用的；反过来，如果哪天又把卡片链路拿掉，必须同步把这四条补丁撤回去 ——
> 没有界面的挂起等待就是当初删它的唯一原因。

### 5.1.1 ask_user_question 的完整链路（同步上游时的核对清单）

删掉它只需改一处（工具定义），恢复它却要四处同时到位，缺一处都会退化成「挂到超时」：

| 环节 | 位置 | 缺了会怎样 |
| --- | --- | --- |
| 工具定义 + 挂起等待 | `core/service/HarnessTools.ts`（`toolDefs()` / `toolAskUser`） | 模型不知道有这个工具，永远不会问 |
| 生命周期通知 | `core/service/AskUserBridge.ts` 的 `setNotifier` | 工具挂起了，但主进程不发 `ask:user`，界面不知道要画卡片 |
| 事件 → 界面 | `SessionManager` 构造里装通知器；`store.ts` 的 `pendingAsk`；`components/AskUserCard.tsx`；`Timeline.tsx` 末尾渲染 | 用户看不到问题，只能等 5 分钟超时 |
| 回填 + 取消 | `ipc.ts` 的 `work:answer`、preload/env.d.ts 的 `work.answer`、`SessionManager.abort()` 里的 `AskUserBridge.cancelAll()` | 点了提交没反应，或者点了「停止」后那一轮永远结束不了 |

### 5.2 阶段七新增的平台层改动（同步上游时同样要重新施加）

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `src/main/session/SessionManager.ts` | ① 工作循环接入三级上下文预算管理（修剪早期工具结果 → 摘要压缩重建 → 从最旧处裁剪），并把说明写进轮次正文；② 收尾标注（手动停止 / max tokens / 步数耗尽 / 失败原因）；③ `turn:finished` 在「本轮无工具调用」路径上按 `abort.aborted` 报状态；④ 顶到 `max_tokens` 时按 `LoopDecisions.shouldBreakOnMaxTokens` 收尾（排在工具执行之前） | ①②③④ 都是原版有、桌面端漏掉的行为。③尤其隐蔽：手动停止的一轮会被报成「正常完成」 |
| `src/core/common/LoopDecisions.ts` | 无改动，但**首次被主进程调用** | 它本来就是原版的决策层，端口一直没人调 |
| `src/renderer/src/components/Markdown.tsx` | 新增 `safeUrlTransform` 并接到 `ReactMarkdown` 的 `urlTransform` | react-markdown v9 的默认变换会把 `data:` 整个剥掉，而桌面端的图片正是 data URL。白名单放行 http/https/mailto/app:/`data:image/*`/相对路径，拒绝 `javascript:` 与 `data:text/html` |
| `src/core/service/AskUserBridge.ts` | 新增 `setNotifier` / `AskPhase` / `PendingAsk.conversationId`；`ask()` 多一个可选 `conversationId` | 鸿蒙侧 ChatPage 每秒轮询 `current()` 就能画卡片（只有一个前台会话）；桌面端渲染层在另一个进程、而且多会话并存，必须由主进程按会话推事件 |
| `src/ipc/contract.ts` | `ask:user` 事件补 `multiSelect`；新增 `ask:done` 事件与 `WorkAnswerRequest` | 前者是单选/多选两种卡片形态的唯一判据；后者让卡片在作答/跳过/超时后收起来 |
| `src/main/ipc.ts` · `src/preload/index.ts` · `src/renderer/src/env.d.ts` | 实现 `work:answer`（含 `canceled` 取消路径）并暴露 `window.guncat.work.answer` | 契约里这条通道早就声明着，但从来没有处理器 —— 因为工具被删了 |
| `src/main/session/SessionManager.ts` | 构造函数里装 `AskUserBridge` 通知器（翻译成 `ask:user` / `ask:done`）；`abort()` 末尾加 `AskUserBridge.cancelAll()` | 不装通知器界面看不到卡片；不 cancelAll 则「停止」之后工具还挂在原处，轮次永远结束不了 |
| `src/renderer/src/components/AskUserCard.tsx`、`Timeline.tsx`、`store.ts`、`styles.css` | 新增提问卡片（原版 `views/AskUserCard.ets` 的逐条对应）、时间线末尾渲染、`pendingAsk` 状态与作答动作 | 原版由 `ChatPage` 每秒轮询 ViewModel 的 `pendingAsk` 并渲染卡片；桌面端换成事件驱动 |

### 5.3 有意保留的差异（不是漏掉）

| 项 | 原版 | 桌面端 | 原因 |
| --- | --- | --- | --- |
| 提示条位置 | 屏幕中下部 | 窗口底部居中 | 桌面窗口里底部最不挡内容，也不会压住输入框 |
| 附件入口 | 所有模式都在输入区 | 只在聊天模式 | 工作/交互模式的素材入口是工作区（上传/拖拽），那两条路本来就是「文件进沙箱、模型用工具读」 |
| 错误提示时长 | 统一 1 秒 | 错误类 2.5 秒 | 与原版自己在错误路径上的时长一致（`duration: 2500`）；桌面端错误信息没有第二个可见出口 |
| 发送/插话/停止按钮 | 42×42 纯图标 | 同尺寸但带文字标签 | 桌面端鼠标精度高、可用空间大，文字标签省掉一次悬停试探 |
| 模式切换入口 | 空态胶囊 | 侧栏底部 | 桌面端侧栏常驻 |
| 新增 API 配置方案 | 建一个空的 | 复制当前配置 | 复制一份「已经填好并验证过」的配置更快 |
| 定时任务推进范围 | 只推进当前会话 | 推进所有工作/交互会话 | 桌面端后台多会话是常态 |
| 界面块锁定 | `uiLocked` 三种口径 | 与之一致（阶段七已对齐） | —— |


---

## 5.1 平台层踩到的两个真坑（值得记下来）

### Windows 上不能把鸿蒙 OpenMode 的数值直接透传给 `fs.openSync`

最初的做法是「鸿蒙 OpenMode 取值与 POSIX 常量一致，所以数值直接透传」。
这在 Linux/macOS 成立，在 **Windows 上会直接 `EINVAL`**：
Node 在 Windows 把数值标志交给 CRT 的 `_open`，而 CRT 的 `_O_CREAT`/`_O_TRUNC`
取值与 POSIX 的 `O_CREAT`/`O_TRUNC` **并不相同**（`0x0100` vs `0o100`）。

现在 `CoreFileKit.toNodeFlags()` 统一把位组合翻译成 Node 的字符串标志
（`r` / `r+` / `w` / `w+` / `a` / `a+`），由 Node 自己跨平台归一。

> 这个 bug 是被 `npm run smoke` 抓出来的：`write_file` 报
> `EINVAL: invalid argument, open '…'`，随即对话持久化、工作区打包全部连带失败。

### `@kit.*` 的延迟解析

`ImageKit` 里的 `nativeImage` 用 `createRequire` 延迟到真正解码像素时才解析，
这样本模块（以及依赖它的 `WorkFileService`）可以在**纯 Node 环境**下被导入，
无头冒烟验证才能覆盖工作区与工具链。

---

## 6. 移出构建的鸿蒙端侧强绑定服务（`porting/deferred/`）

以下服务是鸿蒙端侧强绑定的能力，桌面端**换了实现思路**而不是照搬。
原始版本留在 `porting/deferred/` 作为**归档**，不参与编译、不参与类型检查 ——
保留它们的唯一目的是同步上游时能看到原来的接口形状。

| 归档文件 | 鸿蒙能力 | 电脑版实际做法 |
| --- | --- | --- |
| `TextReaderService.ts` | CoreSpeechKit TTS + AVSession + 后台长时任务 | ✅ 渲染进程 Web Speech API（`speechSynthesis`）；音色取自系统 voice 列表，进度用 `onboundary` 逐词近似；桌面端没有 AVSession 与后台长时任务这些概念 |
| `VoiceInputService.ts` | CoreSpeechKit ASR + AudioKit 采集 | ⚠️ **换实现**：`MediaRecorder` 录音 + 服务商 `/audio/transcriptions` 转写（Chromium 的 `SpeechRecognition` 在 Electron 里依赖 Google 语音服务凭据，默认不可用）。配置默认复用多模态预解析的 Base URL 与 Key |
| `BackgroundReaderService.ts` | AVSession 媒体会话 | 桌面端无对应概念，朗读直接在前台/后台继续 |
| `BackgroundTaskService.ts` | 后台任务申请 | 桌面端无对应概念，整体废弃 |
| `PluginHotLoader.ts` | 基于沙箱目录的热加载 | ✅ **已在阶段六接入**：实现放在 `src/core/service/PluginHotLoader.ts`，随包 `resources/plugins/plugin_list.json` 在 `bootstrap()` 里加载 |

同理，上游的 `entry/src/main/resources/rawfile/玩转应用`（32.5MB 静态教程站，ArkWeb 承载）
未纳入随包资源。

> `porting/deferred/` 下的文件**不是待办清单**，而是「已经用别的方式做完、原件留档」。
> 新增归档文件时请同时更新上表。
