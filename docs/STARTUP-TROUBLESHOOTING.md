# 启动排障与兼容模式

> 这份文档回答两件事：**双击之后窗口没出现该怎么办**，以及**应用为什么默认就把
> `--no-sandbox` 带在命令行上**。
>
> 本文只写与代码和运行环境有关的事实，不含任何特定机器的取证材料。

---

## 0. 先看这一条：默认启动就是「带参数重启」的

Windows 打包态下，应用**默认**会在启动第一刻检查命令行有没有 `--no-sandbox`；
没有的话，它会用 `app.relaunch()` 自我重启一次，把 `--no-sandbox` 放到**真实命令行**上
（见 `src/main/nosandbox.ts`）。

所以正常双击时你会看到进程「闪一下又起来」——**这是预期行为，不是崩溃**。
启动日志里会留下两行自证：

```
BOOT_RELAUNCH_NO_SANDBOX      ← 发生了一次自我重启
SANDBOX_STATE                 ← 最终 --no-sandbox 是否生效
```

开发态（`npm run dev`）**刻意不做**这次重启，保留沙箱，便于继续定位真实沙箱问题。

---

## 1. 窗口没出现时，先拿到两份日志

| 日志 | 位置 | 内容 |
| --- | --- | --- |
| 启动日志 | `%APPDATA%\Guncat Work\logs\startup.log` | 应用逐里程碑的启动日志（单实例锁 → app ready → 建窗口 → 注册 IPC → 渲染进程各阶段） |
| Chromium 日志 | `%APPDATA%\Guncat Work\logs\chromium.log` | Chromium 自己的输出。沙箱 / 子进程 / GPU 这条线的证据全在这里 |
| 崩溃转储 | `%LOCALAPPDATA%\CrashDumps\` | 启动即退时由 Windows 写入的 `.dmp` |

启动日志是**覆盖式**的：下次启动会覆盖上一次。出问题后请立刻把它复制出来。

> 为什么默认就落 Chromium 日志（`src/main/nosandbox.ts` 的 `shouldLogChromium`）：
> 失败往往发生在 Chromium 日志初始化之前，不留任何痕迹。默认把它打开，
> 下一次出问题就有第一手材料，而不必再去翻崩溃转储。

### 带日志手动启动一次

```
cd /d "<产物目录>"
"Guncat Work.exe" --enable-logging --v=1 --log-file="%USERPROFILE%\Desktop\guncat-chromium.log"
```

日志里重点搜这几个串：`GPU process launch failed`、`GPU process isn't usable`、
`sandbox_win`、`error_code`。

---

## 2. 诊断阶梯：`diagnose.cmd`

产物目录里带了 `diagnose.cmd` / `diagnose.ps1`。它**一次跑 6 档**，每档用**独立**的用户数据目录，
跑完在 `diag-log.txt` 里逐档给出结论：

| 档 | 参数 | 预期 |
| --- | --- | --- |
| 1 | `--no-sandbox` | 通过（= 现在的默认启动方式） |
| 2 | `--no-sandbox --disable-gpu` | 通过（兜底） |
| 3 | （无参数） | 通过 |
| 4 | `--guncat-keep-sandbox` | **故意失败**：显式保留沙箱，用来复现原始崩溃 |
| 5 | `--no-sandbox --disable-gpu --disable-software-rasterizer` | **故意白屏**：老三参数组合，用来说明白屏的真凶 |
| 6 | `--guncat-diag --no-sandbox` | 通过（极简诊断页） |

第 4、5 档是**对照组**，它们的价值不在于「能不能起来」，而在于证明结论。

每档的 `VERDICT` 会把「同一个白屏」拆成四种完全不同的故障：

| 走到哪一步 | 判定 | 意味着 |
| --- | --- | --- |
| 没到 `RENDERER_DOM_READY` | 页面根本没加载 | 看该档的 `chromium-N.log` 里的 GPU / 沙箱报错 |
| 到了 dom-ready 但没 `REACT_MOUNTED` | 界面产物没跑起来 | 查 preload 失败、CSP、React 报错 |
| 挂载了但没 `FRAME_PAINTED` | 合成器画不出像素 | DOM 正常、窗口却空白 |
| 加载 + 挂载 + 产帧全有 | 这条链路本身没问题 | 问题在界面内容，不在管道 |

> 每档用独立 `--user-data-dir` 是踩过坑的：共用同一份用户数据时，第一轮留下的单实例锁
> 直接让第二轮启动失败（`Lock file can not be created`），最该验证的那一档反而没跑成。

---

## 3. 根因：Chromium 自己把主进程杀了

**这不是「渲染进程起不来」，而是主进程被 Chromium 的一条 `LOG(FATAL)` 杀掉。**

崩溃点（由崩溃转储的栈上字符串确证）：

```
content\browser\gpu\gpu_data_manager_impl_private.cc:415
GPU process isn't usable. Goodbye.
```

执行它的是 `CrBrowserMain`（主进程主线程）。Chromium 判定 GPU 进程「已无法使用」后走
`IMMEDIATE_CRASH()` / `__debugbreak()`，产生 **`0x80000003`（STATUS_BREAKPOINT）**，
主进程随即退出 —— 有符号 32 位下就是用户看到的退出码 **`-2147483645`**。

因果链：

1. 沙箱开启时 Chromium **建不出 GPU 子进程**（转储里同时留下 `process launch failed … error_code=18` 的痕迹）；
2. Chromium 按内建策略重试 / 降级，全部失败；
3. fallback 用尽 → `LOG(FATAL)` → 断点异常 → 主进程被杀；
4. 主进程一死，应用注册的 `dom-ready` / `did-finish-load` / `preload-error` /
   `render-process-gone` 回调**全部不可能再执行** —— 这正是启动日志「突然断掉、
   什么后续事件都没有」的原因。渲染进程本身没有问题。

**崩溃发生在 Chromium 初始化早期**，进程内的看门狗与自动降级根本来不及跑
（这就是之前几轮「看门狗一条日志都没留下」的原因）。所以修复只能是把参数
**带在真实命令行上**，而不是靠进程内自救。

---

## 4. 14 组对照实验：只有 `--no-sandbox` 有意义

同一复现方法下的参数矩阵：

| 参数组合 | 退出码 |
| --- | --- |
| `--version` | **-2147483645** |
| `--version --disable-gpu` | **-2147483645** |
| `--version --disable-software-rasterizer` | **-2147483645** |
| `--version --disable-gpu --disable-software-rasterizer` | **-2147483645** |
| `--version --disable-gpu-compositing` | **-2147483645** |
| `--version --disable-gpu-sandbox` | **-2147483645** |
| `--version --in-process-gpu` | **-2147483645** |
| `--version --single-process` | **-2147483645** |
| `--version --use-angle=swiftshader` | **-2147483645** |
| `--version --disable-features=Vulkan` | **-2147483645** |
| `--version --no-sandbox` | **0** |
| `--version --no-sandbox --disable-gpu` | **0** |
| `--version --no-sandbox --disable-gpu-sandbox` | **0** |
| `--version --no-sandbox --disable-gpu --disable-software-rasterizer` | **0** |

读法：

1. **只有 `--no-sandbox` 能改变结果。** 所有 `--disable-gpu*`（含 `--disable-gpu`、
   `--disable-software-rasterizer`、`--disable-gpu-sandbox`、`--disable-gpu-compositing`、
   `--in-process-gpu`）、`--single-process`、`--use-angle=swiftshader`、
   `--disable-features=Vulkan` **单独使用一律照崩**。
2. `--disable-gpu-sandbox`（只关 GPU 进程沙箱）**无效** → 失败的很可能不是「GPU 沙箱策略」，
   而是**浏览器进程侧的沙箱 / broker 初始化或子进程创建**这一步。
3. 因此「三个参数缺一不可」是**误判**。真实情况是三条里只有 `--no-sandbox` 必要。

`--no-sandbox` 之下 GPU 进程 **44 ms** 就正常起来了（Chromium 日志里的
`GPUProcessLaunchTime mean = 44.0`）。

### 白屏的真凶：`--disable-software-rasterizer`

`--disable-gpu` 关掉 GPU 后，Chromium 会退回**软件光栅化**；再关掉软件光栅化，
就一个像素都画不出来 —— DOM 正常解析、JS 正常执行（`DOM 就绪` + `加载完成` 都触发了），
用户看到的却是一片空白。这与「页面加载完成后仍一片空白」的实测完全一致。

**结论：`--disable-software-rasterizer` 必须永久删除；`--disable-gpu` 也不必要。**

---

## 5. 为什么「提权就好」是错的

产物里同时提供了 `run-as-admin.cmd`（提权）与 `run-compat.cmd`（不提权，直接带参数）。
用户曾得出「必须提权」的结论，但那**变量没有分离**：

```bat
rem run-as-admin.cmd 实际做的事
Start-Process -Verb RunAs ... -ArgumentList '--no-sandbox','--disable-gpu'
```

它**同时**做了两件事：提权 **和** 加参数。两个变量从未被单独试过，
于是「提权 + 带参数 → 成功」被误读成「提权解决了问题」。
而 §4 的矩阵已经证明：真正起作用的是参数。

**`run-as-admin.cmd` 因此只作为最后手段保留，不是默认路径，也不写进用户文档当方案。**
让所有代码长期跑在 High 完整性令牌下是安全倒退。

---

## 6. 仍未查明的一环

**已确证**：`--no-sandbox` 开 / 关是这条 FATAL 的唯一开关；开启时 GPU 子进程无法创建。

**未确证**：为什么**只有这份产物**建不出 GPU 子进程。反证很硬 ——
同一台机器、同一个非提权 UAC 分割令牌下，另一个 Electron 应用**不带任何参数、
不提权、带沙箱**跑得好好的，主进程与 GPU / 渲染子进程齐全。
所以问题不在「沙箱整体坏了」，也不在操作系统构建或安全软件的一般性拦截。

按可能性排序的待验假设（都还没有证据落定）：

| # | 假设 | 说明 |
| --- | --- | --- |
| A | 本产物特有的**启动参数 / 启动上下文**差异 | 出问题场景都来自带参数启动；「完全无参数、非提权、交互式桌面」这一档最需要补数据 |
| B | 全局注入的**第三方钩子 DLL** 与本产物的加载时序冲突 | 崩溃进程里确实有全局注入模块，但对照组同样会被注入，属于弱假设 |
| C | UAC 分割令牌（Administrators 为 deny-only + Medium 完整性）下的某个 broker 步骤 | 唯一与「提权就好」相关的变量；但对照组在同一令牌下沙箱正常，单靠令牌解释不了 |
| D | 本产物特有的**启动前环境变量 / 兼容性层** | 曾观测到从启动方继承来的 `__COMPAT_LAYER`，来源未查明，也未证明有害 |
| E | 特定 Windows 预览版构建与 Chromium 的沙箱兼容性缺陷 | 已被对照组大幅削弱 |
| F | 用户数据目录的所有权 / 完整性级别边界 | 理论上 Chromium 会临时改写该目录 DACL；证据不足 |

> 如果哪天要重新推进这件事：`diagnose.ps1` 的**第 3 档（无参数）**与
> **第 4 档（保留沙箱复现）**就是为此准备的 —— 装上无条件 `--no-sandbox` 之后，
> 第 4 档是唯一还能复现根因的路径（`--guncat-keep-sandbox` 会抑制这次自我重启）。

---

## 7. 崩溃转储分析工具（`tools/`）

`%LOCALAPPDATA%\CrashDumps` 下的 `.dmp` 不依赖任何外部工具也能读关键信息，
仓库里带了三个纯 Python 解析脚本：

```powershell
# 异常码 / faulting module / 崩溃线程名 / 栈上的 FATAL 串
python tools\mdmp.py "<dump 路径>"
python tools\stack.py "<dump 路径>"
python tools\memstrings.py "<dump 路径>" "<输出目录>"
```

`tools\acl-scan.ps1` 用来核对某个目录及其各级父目录的 ACL（排查访问被拒时用），
它只读取、不修改。

> 这三个脚本在排「启动即退、日志空白」这类问题时比任何日志都直接：
> 崩溃转储里带着异常码、崩溃线程名，以及**从未落盘的栈上日志串**。

---

## 8. 一页速览

- **崩溃是什么**：Chromium `LOG(FATAL)` → `STATUS_BREAKPOINT`（`0x80000003` / `-2147483645`），死的是**主进程**。
- **在哪**：`content/browser/gpu/gpu_data_manager_impl_private.cc:415`，消息 `GPU process isn't usable. Goodbye.`。
- **为什么**：沙箱开启时 GPU 子进程创建失败，fallback 用尽后 Chromium 自杀。
- **唯一的解**：`--no-sandbox`；`--disable-gpu*` 全部无效（14 组对照）。
- **白屏的真凶**：`--disable-software-rasterizer`。
- **提权能好只是巧合**：它和参数从未被分离。
- **现在的默认行为**：win32 打包态启动第一刻自我重启一次，把 `--no-sandbox` 放到真实命令行上。
- **排障入口**：`diagnose.cmd`（6 档阶梯 + 逐档 VERDICT）→ `diag-log.txt` + `startup-N.log` + `chromium-N.log`。
