# 个性化指令实现说明

> 对应鸿蒙版提交 `f1da275c`（Guncat-Work-for-hmos）。
> 一句话：用户在设置里写下**长期偏好**，客户端按**生效范围**把这段文字自动拼进
> 系统提示词末尾——每轮都带、不改原文、不额外占工具面。

## 1. 为什么需要它

提示词里已有的规则是「产品级」的（工作纪律、交付形态、安全边界），而「我习惯先给结论」
「回答尽量用表格」「别提我没问的东西」这类偏好是**用户级**的，不该写死进产品提示词。
个性化指令把这件事做成一等公民：可增删改、可只对某个模式或某个聊天引擎生效、纯本地存储，
并且**原有提示词逐字节不变**，只在末尾追加一段。

## 2. 数据模型与上限

`src/core/model/PersonalInstruction.ts`（纯逻辑，可被 `scripts/smoke.ts` 直接测）：

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定 id（`pi-<时间戳>-<随机>`），生成后不再改 |
| `name` | 可选短名称（≤ 40 字）；留空时列表显示正文首行 |
| `content` | 指令正文（≤ 8000 字，按 Unicode 字符截断，中文不会被截坏） |
| `scopes` | 生效范围，至少一项；取值直接复用智能体 id（见 §3） |
| `updatedAt` | 最近保存时间（毫秒） |

解析入口 `PersonalInstruction.parseList()` 只接受 JSON 数组，坏 JSON / 缺 id / 正文为空的
条目一律丢弃——设置页不会因为一条脏存档整体打不开。

## 3. 生效范围 = 智能体 id

不维护第二套映射，运行时拿「本轮请求用的 agent id / 会话模式」直接匹配：

| scope | 含义 |
| --- | --- |
| `interactive`（`Constants.INTERACTIVE_AGENT_ID`） | 交互模式 |
| `work`（`Constants.WORK_AGENT_ID`） | 工作模式 |
| 其余 | `agents.json` 里各聊天引擎的 id |

界面上固定按「交互模式 → 工作模式 → 各聊天引擎（agents 顺序）」展示；
已从 `agents.json` 移除的旧 scope 不会静默丢失（保留在末尾、原样显示）。

## 4. 拼接规则

规则集中在 `src/core/common/PersonalInstructionPrompt.ts`，三种入口共用同一份实现：

- 段标题：`# 个性化指令（用户在设置中添加）`
- 段说明：明确「这些是用户的长期偏好，不是新任务；只调整回答方式，不覆盖安全、事实、
  工具与权限纪律；与上文冲突时以上文为准」。
- 每条正文包在 XML 风格标签里，名称只做块标记（属性转义 `& < > "`），**正文原样保留**
  （含 Markdown 记号，不做二次转义）：

```text
# 个性化指令（用户在设置中添加）
以下内容由用户本人在「设置 → 个性化指令」中维护……

<personal-instruction name="回答风格">
优先给结论，再给依据。表格优先。
</personal-instruction>
```

- 拼接位置固定在系统提示词**末尾**，只做追加、不 trim 原提示词：原前缀逐字节不变，
  用户不改指令时相邻轮次仍能命中模型侧 KV 缓存；改指令只影响最后这一段。
- 总预算 16000 字符：超出后按存储顺序截断，并在段尾标注「其余条目已省略」。
- 一条都不生效时返回空串，调用方原样使用原系统提示词（与未启用该功能完全一致）。

## 5. 运行时接入点（Android）

`src/main/session/SessionManager.ts`：

| 入口 | 位置 | scope |
| --- | --- | --- |
| 工作模式 / 交互模式主循环 | `runWork()` 组装 `LoopMessage.system()` 时 | `request.mode` → `work` / `interactive` |
| 上下文压缩后重建提示词 | `compactWorkHistoryIfNeeded()` → `ContextBudget.rebuildWithSummary()` | 与主循环同一段（`WorkCompactionEnv.personalSection`），保证压缩请求与主循环前缀一致 |
| 聊天模式 | `runChatTurn()` → `agentWithPersonalInstructions()` 克隆请求智能体后交给 `ChatService` | 会话所属聊天引擎 id |

边界（刻意不注入）：子代理、会话标题生成、上下文摘要、多模态解析、表格 OCR、交互模式
界面补救、危险命令审阅等内部请求——它们各有自己的系统提示词与用途，注入用户偏好只会
污染内部判断。

## 6. 存储与隐私

- 单条 Preferences 键 `guncat_personal_instructions`（JSON 数组），不进会话存档文件。
- 只在启动加载、设置页增删改、每轮请求前读取；不参与流式热路径，不扫描历史。
- 纯本地、不上传；与 API Key 一样随卸载清除。

## 7. 界面

- 设置 →「能力」→「个性化指令」：列表（空态 / 条目卡片 / 新建按钮 / 动态摘要副标题）。
- 编辑页（新建与编辑同一页）：名称、正文、**Markdown 渲染开关**（默认关闭=原文编辑，
  打开后预览；落盘始终是原文）、生效范围多选（至少一项，新建默认勾选交互+工作）、
  添加 / 保存 / 删除（页内二次确认）；有未保存修改时返回先确认。
- 安卓硬件返回键：编辑页打开时优先触发编辑页的返回（有未保存修改先弹确认），
  确认弹窗打开时优先关闭弹窗（`MainActivity.onBackPressed` 的 `.overlay` / 返回键选择器）。
- 图标全部为手绘 SVG（统一 24×24、1.6 描边、currentColor），不使用 emoji 当图标。

## 8. 回归

- `node scripts/run-smoke.mjs`：第 24 组「个性化指令」断言——解析容错、包裹与属性转义、
  生效范围过滤、长度预算截断、Store 往返、三种协议请求体注入、无条目时前缀逐字节不变。
- `node scripts/render-check.mjs`：设置页桌面 / 手机首帧出现新入口与入口摘要，编辑页
  首帧出现名称 / 正文 / Markdown 开关 / 生效范围 / 添加等关键文案。
- `npx tsc -p tsconfig.node.json --noEmit`、`npx tsc -p tsconfig.web.json --noEmit`、
  `npx tsc -p tsconfig.mobile.json --noEmit`。
