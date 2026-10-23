# 交互模式（Intelligent UI）实现说明

> 对齐 GPT 的 Intelligent UI：**一句话进来，一张能操作的界面出去**。
> 模型不再回纯文本，而是回一份**界面程序**，客户端把它渲染成原生可交互界面。

## 1. 数据流全景

```text
用户：一句话
  └─ 主进程 SessionManager.runWork(mode='interactive')
       ├─ AgentLoopService.buildWorkSystemPromptFor('interactive')
       │    （行为纪律：默认零工具、一轮直出；工具面物理裁剪 45 → 27）
       └─ 模型流式输出 guncat-ui lang 程序
            └─ 逐 token 推给渲染进程（message:patched 事件）
                 └─ 渲染进程 MessageView
                      ├─ GuncatUiParts.build(content)  ── 拆成 文本片段 / 界面片段
                      ├─ 文本片段 → Markdown 组件
                      └─ 界面片段 → GuncatUiBlock
                           ├─ GuncatUiLang.parse(source)    解析成语句 + AST
                           ├─ GuncatUiState.of(program, saved)  绑定值（含尾标记恢复）
                           ├─ GuncatUiLang.render(program, values)  按当前绑定值物化元素树
                           └─ renderNode(root) → React 组件树（76 个组件）
```

**用户操作回流**（拖动滑块 / 点按钮）：

```text
控件 onChange
  ├─ 本地动作（@Set / @Reset）→ 改 GuncatUiState → 重新物化并重渲染（不发请求、不等模型）
  ├─ 绑定值变化 → 去抖 400ms → 以尾标记写回消息 → IPC 持久化（滚动/切会话/重启后仍在）
  └─ 回传动作（@ToAssistant）→ 组装成用户消息发回模型 → 模型产出更新后的完整界面
```

下一轮请求前，主进程会把上一轮界面的绑定状态翻译成一句人话
（`GuncatUiRuntime.describeStateForModel`）附在任务后面，
模型因此始终知道界面当前处于什么状态。

## 2. 与鸿蒙版的分工

**零改动的部分**（直接从上游移植，纯逻辑、无平台依赖）：

| 模块 | 职责 |
| --- | --- |
| `GuncatUiLang.ts` | 词法 / 语法 / 自动补全括号 / 物化求值 / 围栏切分 |
| `GuncatUiLibrary.ts` | 76 个组件的签名与位置参数表（**单一事实源**：同时驱动提示词、解析、渲染合法性） |
| `GuncatUiRuntime.ts` | `$绑定`状态、动作执行、控件取值、状态尾标记、回传给模型的人话描述 |
| `GuncatUiParts.ts` | 把消息正文切成「Markdown 文本片段 + 界面程序片段」 |
| `GuncatUiPaint.ts` | 图表几何（比例尺 / 路径生成 / 雷达 / 楔形）、调色板、数值格式化 |
| `GuncatUiPrompt.ts` | 交互模式系统提示词 |

**桌面端新写的部分**（把 ArkUI 的「画」换成 DOM + SVG）：

| 文件 | 职责 |
| --- | --- |
| `renderer/src/guncat-ui/GuncatUiBlock.tsx` | 顶层块：解析、持有绑定值、重物化、状态回写、只读态 |
| `renderer/src/guncat-ui/nodes.tsx` | 元素树 → React 组件树的分派器（覆盖全部 76 个组件） |
| `renderer/src/guncat-ui/charts.tsx` | 8 种图表用 SVG 绘制，几何复用 `GuncatUiPaint` |
| `renderer/src/guncat-ui/guncat-ui.css` | 与主应用共用 CSS 变量，深浅色自动适配 |

> 上游 `views/GuncatUiView.ets`(2807 行) + `GuncatUiCharts.ets` + `GuncatUiIcons.ets`
> 合计约 3900 行 ArkUI，在桌面端由约 1300 行 React 等价表达。

## 3. 组件覆盖

76 个组件按 9 组全部实现：

| 分组 | 数量 | 代表 |
| --- | --- | --- |
| 根与内容 | 15 | `Card` / `CardHeader` / `TextContent` / `MarkDownRenderer` / `Callout` / `CodeBlock` / `ImageGallery` / `EntityList` |
| 布局 | 9 | `Tabs` / `Accordion` / `Steps` / `Carousel` / `SectionBlock` |
| 表格与数据 | 2 | `Table` / `Col` |
| 图表 | 8 | `BarChart` / `LineChart` / `AreaChart` / `HorizontalBarChart` / `PieChart` / `RadialChart` / `SingleStackedBarChart` / `Series` |
| 指标与文本 | 6 | `Text` / `IconText` / `ImageText` / `MetricIndicatorInline` |
| 卡片块 | 10 | `OverviewCardBlock` / `SnippetCardBlock` / `ContextCardBlock` / `CompositeCardBlock` / `VisualCardBlock` |
| 列表与追问 | 4 | `ListBlock` / `FollowUpBlock` |
| 表单 | 18 | `Form` / `FormControl` / `Slider` / `Select` / `RadioGroup` / `CheckBoxGroup` / `SwitchGroup` / `Chips` / `OptionCards` / `DatePicker` |
| 按钮与图标 | 4 | `Button` / `Buttons` / `IconButton` / `Icon` |

> 组件清单不是手抄的，而是用 `pnpm dump:components` 从 `GuncatUiLibrary` 直接导出，
> 保证「模型看到的」= 「我们解析的」= 「我们能画的」三者一致。

## 4. 容错设计（继承上游并保留）

| 情形 | 行为 |
| --- | --- |
| 流式中间态（括号未闭合） | `UiAutoClose` 自动补齐，**已写完的语句全部保留**（这也是相对「输出一大段 JSON」最根本的改进：JSON 一截断就整块作废） |
| 引用了还没流进来的变量 | 暂时为空，等定义流进来再出现 |
| 未知组件名 | **丢弃该组件并给出诊断**，但同块的其它组件照常渲染 |
| 必需参数缺失 / 类型不符 | **不丢弃组件**，用安全默认值渲染 —— 聊天场景里「少一个字段」远好于「整块消失」 |
| 未知组件在渲染期到达 | 渲染器兜底：把它的文本参数与子元素尽量显示出来并标注 |

## 5. 验证

交互模式有两层无头验证，都不依赖 Electron 窗口：

```bash
pnpm smoke:core     # 68 项，其中 13 组是交互模式逻辑链
pnpm smoke:render   # 26 项，React SSR 渲染断言
```

`smoke:core` 第 13 组覆盖：程序解析、入口解析、`$变量`收集、表达式求值、
**改绑定值后表达式重算**、派生表达式同步更新、`@ToAssistant` 动作收集、
状态尾标记往返、文本/程序混合拆分、表单字段打包回传、图表 labels/series 提取、
未闭合程序容错、未知组件诊断。

`smoke:render` 用 `react-dom/server` 把一份覆盖主要组件的界面程序渲染成 HTML，
逐项断言卡片标题、`$绑定`求值结果、指标卡、趋势方向、滑块默认值、图表 SVG 与图例、
表格、选项卡、折叠面板、步骤条、标签、Callout 变体、代码块、饼图、键值清单、
表单与下拉框、只读态置灰标记，以及**正文与界面共存**的组合关系。
