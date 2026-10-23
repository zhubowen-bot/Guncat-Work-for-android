# 参与贡献

感谢你有兴趣参与。Guncat Work（电脑版）用 **Electron + React + TypeScript** 实现；鸿蒙版见 [Guncat Work](https://github.com/zhubowen-bot/Guncat-Work-for-hmos)。业务内核（Agent Loop、三协议流式对话、45 个工具、37 项技能、Office 生成器、`guncat-ui lang` 渲染器）在桌面运行时上独立维护。

这个仓库对「改动是否可靠」的要求比较高 —— 它做的事情（Agent 循环、文档生成、IPC 契约、界面渲染）出错时很难靠肉眼发现，所以下面这套验证流程不是形式主义，**每一层都在拦真实发生过的事故**。

欢迎提交 Issue 和 Pull Request。

---

## 环境要求

- **Node.js ≥ 22.6**（冒烟脚本用 esbuild 打包后交给 Node 跑；CI 用 Node 24）
- **npm**（**不是 pnpm** —— 仓库里只有 `package-lock.json`，打包脚本也按 npm 的布局组装）
- **Windows 10 / 11** 用于产出与核对可分发产物（`npm run dist` 输出的是 Windows 便携目录）
- macOS / Linux 可以开发与跑全部无头验证，但**打包产物面向 Windows**
- Python 3.11+：仅在使用 `tools/` 下的崩溃转储分析脚本时需要（纯标准库，无第三方依赖）

---

## 验证矩阵：为什么一层都不能省

一条命令跑完全部：**`npm run verify`**（= `typecheck` + `smoke`，而 `smoke` 内部会先构建）。

### 第 1 层 · 类型检查

```bash
npm run typecheck        # = typecheck:node + typecheck:web
```

覆盖 `src/core`（业务内核）+ `src/main` + `src/preload` + `src/renderer`。

> `tsconfig.node.json` 里**关掉了** `strictNullChecks` / `strictFunctionTypes`：
> ArkTS 的空值语义与 TS 不同（ArkTS 的 `Object` 接受 `null`），不关的话 3.5 万行移植代码
> 会淹在噪音里。但**保留 `noImplicitAny`**，新写的代码仍要能抓到真正的错误。

### 第 2 层 · 三端构建

```bash
npm run build            # main / preload / renderer 三端产物 → out/
```

### 第 3 层 · 四套无头冒烟（本仓库的核心验证）

```bash
npm run smoke:core       # 业务内核 + 工具链 + 三协议
npm run smoke:render     # react-dom/server 逐项断言
npm run smoke:ipc        # 每个 IPC 通道真实 invoke 一遍
npm run smoke:startup    # electron 替身跑真实入口 src/main/index.ts
```

| 套件 | 覆盖 |
| --- | --- |
| `smoke:core` | 智能体加载、44 个工具、37 项技能、沙箱工作区、`run_js` 沙箱、数据管道、持久化、三协议端点、Office 工具链端到端（生成→读回→算子编辑）、技能系统工具、交互模式全链路（解析 / `$绑定`重算 / 动作回传 / 状态尾标记 / 表单打包）、PDF 解析、SVG 栅格化、插件热加载、HTTP 读空闲超时 |
| `smoke:render` | 用 `react-dom/server` 把一份覆盖主要组件的界面程序渲染成 HTML 并逐项断言（含两种形态各自的编排方式、Markdown 的 LaTeX / 代码块 / mermaid 三条链路、工作区面板、输入区、侧栏、工具行的 diff 与任务清单卡、产物汇总卡等） |
| `smoke:ipc` | 用 electron 替身把渲染进程会调用的**每个 IPC 通道**真实 invoke 一遍（注册完整性、设置往返、会话生命周期、事件推送、越界与目录穿越拒绝、文件收件与工作区上传、导出 Word、语音转写、本地联网搜索、配置方案、聊天附件、定时提醒、推理强度透传、执行中插话、任务统计与目标、产物汇总、表格提取与模型输出清洗） |
| `smoke:startup` | 用 electron 替身跑**真实入口** `src/main/index.ts`，断言单实例锁 → whenReady → 建窗口 → 注册 IPC 依次发生，且 preload 路径与 `index.html` 都指向真实存在的文件、数据目录已建、全程无异常 |

这些脚本用的是 **esbuild + 与 `electron.vite.config.ts` 完全相同的别名规则** ——
验证的是构建产物真实依赖的那套解析规则，而不是另起一套近似配置。

### 第 4 层 · 源码级护栏

```bash
node scripts/check-emoji.mjs src/renderer
```

有些界面纪律**类型检查和单测都拦不住**，漏了只表现为「界面上多了几个奇怪的字符」。这类纪律用源码扫描守住：

- **`check-emoji.mjs`**：`src/renderer` 下所有 `.ts/.tsx/.css/.html` 不得出现 emoji，也不得出现**当图标用的符号**（箭头、几何图形、装饰符号、带圈数字、制表符等）。中文标点、全角括号、省略号、`·`、`×`、`™` 这类正常文案是白名单。新增图标请用 SVG 组件（`src/renderer/src/icons/index.tsx`），不要用字符画。

### 第 5 层 · 打包产物（改了 `scripts/package-portable.mjs` 或 `launch-scripts.mjs` 必跑）

```bash
npm run dist             # 产出 release/Guncat Work-<version>/
```

然后**双击产物里的 `Guncat Work.exe` 实际开一次窗口**。这一步没法自动化 ——
本仓库的启动链路有一批只有真跑才知道的坑（见下文「红线」里的第 4 条）。

> CI 覆盖第 1–4 层；**第 5 层必须在本地跑**。
> 托管 runner 上不适合下载 Electron 二进制并以窗口方式运行。

---

## 编码约定

### 一、`src/core/**` 是**逐字移植**的，默认不许改

`src/core/` 下的文件是从鸿蒙版 `entry/src/main/ets/{common,model,service,export,data}` 原样复制来的，
**目录结构与相对 import 路径完全一致**，平台依赖全部收敛在 `import ... from '@kit.*'` 这一行，
由 bundler 别名解析到 `src/core/platform/kit/` 下的桌面等价物。

因此：

- **不要**为了「顺手改好一点」而修改共享内核的语义。这会让下一次与鸿蒙版同步变成逐行比对。
- **确实必须改**（平台差异、Bug、语义修正）的，**必须**登记进
  [`docs/PORTING.md`](docs/PORTING.md) 的**差异补丁清单** —— 那张表是与鸿蒙版的**唯一分歧清单**，
  同步时按它逐条重新施加。
- **不要**在 `src/core/` 里放界面代码，也不要 import React / Electron / DOM 专有的东西。
  业务内核必须保持可在纯 Node 下被 `smoke:core` 导入。
- 新写平台能力时，加在 `src/core/platform/` 下，并通过别名暴露 —— 而不是直接改调用方。

### 二、TypeScript

- 项目是 `"type": "module"`（ESM）。Node 侧用 `node:` 前缀导入内置模块。
- 不要解构赋值写得让类型推断失效；移植代码里刻意避开了大量动态特性，新代码也请保持一致风格
  （显式类型声明、`let` 而非 `var`、箭头函数）。
- 移植代码里大量使用 ArkTS 风格的显式类型标注，**请勿**批量「现代化」，那会让补丁清单失效。

### 三、IPC 契约改一处要动四处

`src/ipc/contract.ts` 是主进程与渲染进程的共享契约。新增 / 修改一条通道时，下面四处要同时到位，
缺一处 `smoke:ipc` 会立刻变红（这是有意的）：

1. `src/ipc/contract.ts` —— 通道名与请求 / 响应类型
2. `src/main/ipc.ts` —— 处理器
3. `src/preload/index.ts` —— contextBridge 暴露
4. `src/renderer/src/env.d.ts` —— `window.guncat` 的类型声明

### 四、界面

- 图标一律走 `src/renderer/src/icons/index.tsx` 里的 SVG 组件，**不要用 emoji 或符号字符**。
- 界面里的数字必须来自真实数据，不要在代码或提示词里编造。
- 深浅色主题用已有的 CSS 变量，不要写死颜色。

---

## 红线

- **提示词与工具面边界有断言守着。** 工作模式与交互模式共用同一套循环，但**下发的工具面不同**
  （工作模式全量，交互模式物理裁剪到 27 个）。`scripts/smoke.ts` 里有针对性的断言，
  不要为了让某个 case 过关而放宽它。
- **改了 `src/core/**` 的纯逻辑，要同步补 / 改 `scripts/smoke.ts` 的断言。**
  这个仓库的习惯是「修一处缺陷，加一组断言」。
- **打包脚本里的 `.cmd` / `.ps1` 必须纯 ASCII。** `cmd.exe` 在中文 Windows 上按 GBK 解析批处理，
  写 UTF-8 中文会让整行变成非法命令、`if`/`goto` 控制流直接被拆坏；PowerShell 5.1 对 `.ps1` 同理。
  `scripts/launch-scripts.mjs` 的 `writeAsciiFile()` 做的是**字节级**校验（写盘后再读回来验），
  不要绕过它。中文说明一律放进 `使用说明.txt`（UTF-8 带 BOM）。
- **不要重新引入 `--disable-software-rasterizer` 或 `--disable-gpu`。** 14 组对照实验证明
  只有 `--no-sandbox` 有意义，而 `--disable-software-rasterizer` 是「白屏」的真凶。
  详见 [`docs/STARTUP-TROUBLESHOOTING.md`](docs/STARTUP-TROUBLESHOOTING.md)。
- **不要用 `app.commandLine.appendSwitch` 代替真实命令行参数。** GPU 子进程的启动参数取自命令行，
  而崩溃发生在 Chromium 初始化早期 —— 进程内自救来不及。
- **运行时只使用应用沙箱目录**（`%APPDATA%\Guncat Work`，开发态可用 `GUNCAT_DATA_DIR` 覆盖）
  与 Electron 的对话框 API；**不要新增对用户文件系统的隐式读取**。
- 提交前清掉生成物：`out/`、`release/`、`.smoke/`、`.tmp/`（`.gitignore` 已经覆盖，
  但不要用 `git add -f` 把它们带进来）。

---

## 改哪块看哪份文档

| 你要改的东西 | 先读 |
| --- | --- |
| 移植策略、`@kit.*` 适配对照、与上游的分歧清单 | [`docs/PORTING.md`](docs/PORTING.md) |
| 交互模式、`guncat-ui lang` 数据流、76 个组件覆盖 | [`docs/INTERACTIVE-MODE.md`](docs/INTERACTIVE-MODE.md) |
| 启动失败、白屏、兼容模式、诊断阶梯 | [`docs/STARTUP-TROUBLESHOOTING.md`](docs/STARTUP-TROUBLESHOOTING.md) |
| 客户端功能全貌与目录结构 | [`README.md`](README.md) |
| 版本变更史 | [`CHANGELOG.md`](CHANGELOG.md) |

---

## 提交与 PR 流程

1. Fork 仓库，从 `main` 创建功能分支。
2. 完成修改，跑通上面对应的验证层（PR 模板里有勾选项，**别勾没跑过的**）。
3. 提交，遵循下面的提交信息约定。
4. 发起 Pull Request，说明**改了什么、为什么、怎么验证的**；有 UI 改动请附前后截图。

### 提交信息约定

仓库使用 Conventional Commits，描述用中文：

```
feat(ui): 正文栏在桌面铺开（对话两侧不再留两条大空白）
fix(mode): 冷启动只设了智能体、没设形态 —— 交互模式被当成聊天模式跑（P0 回归）
feat(mermaid): 导图规范从「手机竖屏」改为「桌面宽屏」——结构放开、横向可滚动
docs(porting): 补上阶段七（逐项对标审计）与新的平台层改动清单
```

- 类型：`feat` / `fix` / `docs` / `style` / `refactor` / `chore` / `test`
- `scope` 用模块名（`ui` / `mode` / `interactive` / `mermaid` / `dev` / `porting` / `pack` 等）
- 描述写清**行为变化**，真机 / 真机外缺陷建议带上根因，例如上面那条 `fix(mode)`。

---

## 行为准则

- 讨论对事不对人；技术分歧用证据（日志、截图、最小复现）说话。
- 提 Issue 前先看一眼[启动排障](docs/STARTUP-TROUBLESHOOTING.md)与现有 Issue。
- 一个人维护的项目，回复可能不快，但每条都会看。
