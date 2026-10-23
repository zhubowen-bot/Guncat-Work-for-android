// CommandService: run_command / job_* 工具 —— 让智能体在本机跑命令，并把安全边界守住。
//
// 为什么不是「一个终端」：用户定的形态是「Agent 工具优先」—— 先给模型一条能跑命令的路,
// 用纯 child_process, 不引入 node-pty/xterm 这类原生依赖, 也不动打包链路;
// 界面可见的交互式终端标签页是下一阶段的事。
//
// 安全边界(全部集中在这一层, 平台层只管拉进程):
//   1. 工作目录锚定会话工作区, cwd 只接受工作区内的相对路径(越界拒绝);
//   2. 环境变量按白名单净化(主进程环境里的 API Key/令牌不会透传给子进程);
//   3. CommandGuard 硬禁表命中的命令**直接拒绝**, 不给审批入口;
//   4. 命令引用到的工作区脚本读进来过同一套判定(脚本同审) —— 否则「把破坏搬进 .bat/.ps1」
//      就是一条免检门, 命令行本身干净得不能再干净;
//   5. 危险命令按会话档位找一个判官:
//      'ask'/'ask-risk' 直接弹人工审批卡; 'auto' 先请模型审阅(它放行才静默执行, 拦下或
//      没出结论一律退回人工卡 —— 审阅器只能让用户少被打扰一次, 不可能多放行一条命令);
//      'full-access'(完全权限, 就是老 'auto' 的实际语义)不审也不问, 但上面 1~4 条照跑。
//      人工卡超时/跳过/没点选项一律按**拒绝**处理(fail-closed: 没人应答就等于不许);
//   6. 超时或被停止会杀掉整棵进程树, 不留孤儿进程;
//   7. 输出有缓冲上限 + 头尾截断, 超长全文落 .spill/ ——「截断不丢失」。
import { fileIo } from '@kit.CoreFileKit';
import { Constants } from '../common/Constants';
import { AbortSignal } from '../common/Types';
import { CommandGuard, GuardVerdict } from './CommandGuard';
import { ApprovalReviewService, ReviewOutcome } from './ApprovalReviewService';
import { AskUserBridge, AskAnswer } from './AskUserBridge';
import { SpillStore } from './SpillStore';
import { ToolExecResult, WorkFileService } from './WorkFileService';
import { ShellTask, ShellOutcome, buildCleanEnv } from '../platform/shellExec';

export const RUN_COMMAND_TOOL_NAME: string = 'run_command';
export const JOB_LIST_TOOL_NAME: string = 'job_list';
export const JOB_OUTPUT_TOOL_NAME: string = 'job_output';
export const JOB_KILL_TOOL_NAME: string = 'job_kill';

// 审批选项(文案即协议: 下面按这几个字判定用户意图, 改动要两边一起改)
const APPROVE_ONCE: string = '允许一次';
const APPROVE_ALL: string = '本次任务全部允许';
const APPROVE_DENY: string = '拒绝';

// 一次审批的落定结果
class Approval {
  allowed: boolean = false;
  grantAll: boolean = false;
  /** 拒绝原因(给人读的短句) */
  why: string = '';
  /** 用户在审批卡上补充的话(可空, 要让它看见) */
  note: string = '';
  /** 'auto' 档由模型审阅放行时的说明 —— 与「用户批准时的补充要求」是两种话, 分开记 */
  reviewLine: string = '';
}

// 一个后台任务
class CommandJob {
  id: string = '';
  convId: string = '';
  command: string = '';
  cwd: string = '';
  task: ShellTask | null = null;
  /** job_output 的「读后即弃」游标: 每次返回游标之后的新增输出并推进 */
  cursor: number = 0;
  finished: boolean = false;
  exitCode: number = -1;
  killed: boolean = false;
  startedAt: number = 0;
}

// 一个待审阅的脚本文件（命令直接引用的，以及它内部又指向的）
class ScriptAuditItem {
  abs: string = '';
  /** 审批卡上给用户看的写法 */
  label: string = '';
  /**
   * 这个文件里写的相对路径**可能**按哪些目录解析（相对工作区根，空串=根）。
   * cmd/PowerShell 执行脚本时不会把工作目录切到脚本所在目录，所以进程 cwd 是第一个候选；
   * 脚本 `cd` 到自己所在目录、或被别的目录的调用方拉起来时，它自己的目录也是候选 ——
   * 少试一个就等于「解析不到 → 静默跳过 → 整条链没审」（实测这样删掉了文件）。
   */
  bases: string[] = [];
  /** 它自己所在的目录（相对工作区根）：%~dp0、$PSScriptRoot 这类「相对脚本自己」的写法按这里解析 */
  ownDir: string = '';
  depth: number = 0;
}

// 一个待审阅的 package.json script（`npm run x` 真正执行的那段命令行）
class PackageScript {
  /** scripts 里的键名 */
  name: string = '';
  /** 那段命令行的原文 */
  body: string = '';
}

export class CommandService {
  // 会话级审批档位(与 WorkFileService.customRoots 同构: core 侧注册表, 主进程按会话元数据回填)
  private static permissions: Record<string, string> = {};
  // 「本次任务全部允许」的会话内授权(用户重新发起任务时清空, 不跨任务残留)
  private static grants: Record<string, boolean> = {};
  private static jobs: CommandJob[] = [];
  private static jobSeq: number = 0;

  static setPermission(convId: string, permission: string): void {
    if (permission === '') {
      delete CommandService.permissions[convId];
      return;
    }
    CommandService.permissions[convId] = CommandGuard.normalizePermission(permission);
  }

  static permissionFor(convId: string): string {
    let v: string | undefined = CommandService.permissions[convId];
    return CommandGuard.normalizePermission(v === undefined ? '' : v);
  }

  /** 新一轮任务开始: 收回「本次任务全部允许」—— 它的字面范围就是"本次任务" */
  static clearGrant(convId: string): void {
    delete CommandService.grants[convId];
  }

  /** 会话被删除: 杀掉它的后台任务, 清掉档位与授权 */
  static releaseConversation(convId: string): void {
    let keep: CommandJob[] = [];
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (job.convId === convId) {
        if (!job.finished && job.task !== null) {
          job.task.kill();
        }
        continue;
      }
      keep.push(job);
    }
    CommandService.jobs = keep;
    delete CommandService.permissions[convId];
    delete CommandService.grants[convId];
  }

  /** 应用退出: 后台任务一起带走(否则退出后留下一堆由本应用拉起的进程) */
  static killAllJobs(): void {
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (!job.finished && job.task !== null) {
        job.task.kill();
      }
    }
    CommandService.jobs = [];
  }

  static isCommandTool(name: string): boolean {
    return name === RUN_COMMAND_TOOL_NAME || name === JOB_LIST_TOOL_NAME ||
      name === JOB_OUTPUT_TOOL_NAME || name === JOB_KILL_TOOL_NAME;
  }

  // ===== run_command =====

  static async run(convId: string, root: string, args: Record<string, Object>,
    abortSignal: AbortSignal | null): Promise<ToolExecResult> {
    let command: string = CommandService.strArg(args, 'command', '');
    if (command.trim() === '') {
      return CommandService.fail('缺少参数 command(要执行的命令行)');
    }
    // 1. 硬禁判定(带上工作区根: 就在工作区里干活的绝对路径不算越界)
    let verdict: GuardVerdict = CommandGuard.assess(command, root);
    let forbiddenReason: string = CommandGuard.forbiddenReason(verdict);
    if (forbiddenReason !== '') {
      return CommandService.fail('该命令被安全策略拒绝(' + forbiddenReason +
        ')。这类操作不可逆, 本应用不会代为执行 —— 请把要做什么说清楚, 交给用户自己在终端里完成');
    }
    // 2. 工作目录: 只允许工作区内的相对路径(与文件工具同一把尺子)
    let cwdRel: string = CommandService.strArg(args, 'cwd', '').replace(/^\/+/, '');
    let cwd: string = root;
    if (cwdRel !== '') {
      let resolved: string | null = WorkFileService.resolveSafePublic(root, cwdRel);
      if (resolved === null) {
        return CommandService.fail('cwd 必须是工作区内的相对路径(不允许越出工作区): ' + cwdRel);
      }
      if (!fileIo.accessSync(resolved) || !fileIo.statSync(resolved).isDirectory()) {
        return CommandService.fail('cwd 不是工作区里已存在的目录: ' + cwdRel);
      }
      cwd = resolved;
    }
    // 2.5 脚本同审: 命令文本只写了「跑哪个脚本」, 危险全在文件里(实测: run.bat 无审批删文件)。
    //     读进来过同一套判定, 让「把破坏搬进脚本」不再是一条免检门。
    let scriptForbidden: string = CommandService.auditScripts(command, cwdRel, root, verdict);
    if (scriptForbidden !== '') {
      return CommandService.fail('该命令被安全策略拒绝(' + scriptForbidden +
        ')。这类操作不可逆, 本应用不会代为执行 —— 请把要做什么说清楚, 交给用户自己在终端里完成');
    }
    // 3. 审批(档位决定判官是谁: 人 / 先看模型再找人 / 完全权限不问)
    let permission: string = CommandService.permissionFor(convId);
    let note: string = '';
    let reviewLine: string = '';
    if (CommandService.grants[convId] !== true &&
      CommandGuard.needsApproval(verdict, permission)) {
      let review: ReviewOutcome | null = null;
      let approval: Approval;
      if (CommandGuard.usesModelReview(permission)) {
        // 'auto' 档: 先请模型看一眼。只有它明确判 low/medium 且放行才免打扰;
        // 判 high、自相矛盾、请求失败、超时、没配模型 —— 全都还是下面那张人工卡。
        review = await ApprovalReviewService.review(convId, command, cwdRel, root,
          verdict.reasons, abortSignal);
      }
      if (review !== null && review.allowed) {
        approval = new Approval();
        approval.allowed = true;
        approval.reviewLine = '自动审阅已放行(' + review.risk + ')' +
          (review.reason === '' ? '' : ': ' + review.reason);
      } else {
        approval = await CommandService.askApproval(convId, command, cwdRel, verdict, review);
      }
      if (!approval.allowed) {
        return CommandService.denyResult(command, approval.why, approval.note);
      }
      if (approval.grantAll) {
        CommandService.grants[convId] = true;
      }
      note = approval.note;
      reviewLine = approval.reviewLine;
    }
    // 4. 超时(命令自己的超时必须先于工具层的兜底超时触发, 否则进程没人收)
    let timeoutMs: number = CommandService.intArg(args, 'timeout_ms',
      Constants.WORK_CMD_DEFAULT_TIMEOUT_MS);
    if (timeoutMs <= 0) {
      timeoutMs = Constants.WORK_CMD_DEFAULT_TIMEOUT_MS;
    }
    if (timeoutMs > Constants.WORK_CMD_MAX_TIMEOUT_MS) {
      timeoutMs = Constants.WORK_CMD_MAX_TIMEOUT_MS;
    }
    // 5. 拉起进程
    let background: boolean = CommandService.boolArg(args, 'run_in_background', false);
    let task: ShellTask = new ShellTask(command, cwd);
    let limit: number = background ? Constants.WORK_CMD_JOB_BUFFER_BYTES :
      Constants.WORK_CMD_STREAM_BUFFER_BYTES;
    let startError: ShellOutcome | null = task.start(buildCleanEnv(), limit);
    if (startError !== null) {
      return CommandService.fail('命令启动失败: ' + startError.error);
    }
    if (background) {
      return CommandService.registerJob(convId, command, cwdRel, task, verdict, note, reviewLine);
    }
    let outcome: ShellOutcome = await task.wait(timeoutMs, abortSignal);
    return CommandService.renderForeground(root, cwdRel, outcome, verdict, note, reviewLine);
  }

  // ===== job_list / job_output / job_kill =====

  static listJobs(convId: string): ToolExecResult {
    CommandService.reapAll();
    let rows: string[] = [];
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (job.convId !== convId) {
        continue;
      }
      let status: string = job.finished ?
        (job.killed ? '已被终止' : '退出码 ' + job.exitCode.toString()) : '运行中';
      let unread: number = job.task === null ? 0 :
        Math.max(0, job.task.outputLength - job.cursor);
      rows.push('[' + job.id + '] ' + status + ' · 未读输出 ' + unread.toString() + ' 字符 · ' +
        CommandService.clip(job.command, 80) +
        ' · 目录 ' + (job.cwd === '' ? '工作区根' : job.cwd));
    }
    if (rows.length === 0) {
      return CommandService.ok('(本会话没有后台任务)');
    }
    return CommandService.ok('后台任务 ' + rows.length.toString() + ' 个:\n' + rows.join('\n') +
      '\n用 job_output(id) 读新增输出(每次只给上次之后的部分)。');
  }

  static jobOutput(convId: string, root: string,
    args: Record<string, Object>): ToolExecResult {
    CommandService.reapAll();
    let job: CommandJob | null = CommandService.findJob(convId,
      CommandService.strArg(args, 'job_id', ''));
    if (job === null) {
      return CommandService.fail('未找到该后台任务(用 job_list 查看 id)');
    }
    if (job.task === null) {
      return CommandService.ok('[' + job.id + '] 已结束, 没有更多输出');
    }
    let fresh: string = job.task.snapshot(job.cursor);
    job.cursor = job.task.outputLength;
    let head: string = '[' + job.id + '] ' + (job.finished ?
      (job.killed ? '已被终止' : '已结束, 退出码 ' + job.exitCode.toString()) : '仍在运行');
    if (fresh === '') {
      return CommandService.ok(head + '\n(本次没有新增输出)');
    }
    if (fresh.length > Constants.WORK_CMD_JOB_OUTPUT_MAX_CHARS) {
      fresh = CommandService.spillAndTruncate(root, 'job_output_' + job.id, fresh);
    }
    return CommandService.ok(head + '\n' + fresh);
  }

  static killJob(convId: string, args: Record<string, Object>): ToolExecResult {
    let id: string = CommandService.strArg(args, 'job_id', '');
    let job: CommandJob | null = CommandService.findJob(convId, id);
    if (job === null) {
      return CommandService.fail('未找到该后台任务(用 job_list 查看 id)');
    }
    if (job.finished) {
      return CommandService.ok('[' + job.id + '] 已经结束, 无需终止');
    }
    if (job.task !== null) {
      job.task.kill();
    }
    job.killed = true;
    job.finished = true;
    return CommandService.ok('已终止后台任务 [' + job.id + '] ' +
      CommandService.clip(job.command, 60));
  }

  // 同步结算已退出的后台任务(ShellTask 的 close 事件只维护自己的状态, 这里按快照回收到登记处)
  private static reapAll(): void {
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      let job: CommandJob = CommandService.jobs[i];
      if (job.finished || job.task === null || job.task.alive) {
        continue;
      }
      job.finished = true;
      job.exitCode = job.task.exitCodeValue;
      job.killed = job.task.wasKilled;
    }
  }

  private static findJob(convId: string, id: string): CommandJob | null {
    if (id === '') {
      return null;
    }
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      if (CommandService.jobs[i].convId === convId && CommandService.jobs[i].id === id) {
        return CommandService.jobs[i];
      }
    }
    return null;
  }

  private static registerJob(convId: string, command: string, cwdRel: string,
    task: ShellTask, verdict: GuardVerdict, note: string, reviewLine: string): ToolExecResult {
    CommandService.reapAll();
    CommandService.pruneFinished();
    if (CommandService.jobs.length >= Constants.WORK_CMD_MAX_JOBS) {
      task.kill();
      return CommandService.fail('后台任务已达上限(' +
        Constants.WORK_CMD_MAX_JOBS.toString() + ' 个), 先用 job_kill 结束不需要的任务');
    }
    let job: CommandJob = new CommandJob();
    job.id = 'cmd-' + (CommandService.jobSeq++).toString();
    job.convId = convId;
    job.command = command;
    job.cwd = cwdRel;
    job.task = task;
    job.startedAt = task.startedAt;
    CommandService.jobs.push(job);
    let r: ToolExecResult = CommandService.ok(
      '[run_command] 已放入后台, 任务 id=' + job.id + ', 目录 ' +
      (cwdRel === '' ? '工作区根' : cwdRel) + '\n' +
      '它在后台继续跑, 本轮不用等它。之后用 job_output(' + job.id +
      ') 读新增输出(每次只返回上次读过之后的部分), job_list 看状态, job_kill 结束它。' +
      CommandService.riskLine(verdict, note, reviewLine));
    return r;
  }

  // 结束态任务只保留最近 4 个, 避免长会话里注册表无限增长
  private static pruneFinished(): void {
    let finished: CommandJob[] = [];
    for (let i: number = 0; i < CommandService.jobs.length; i++) {
      if (CommandService.jobs[i].finished) {
        finished.push(CommandService.jobs[i]);
      }
    }
    if (finished.length <= 4) {
      return;
    }
    let drop: CommandJob[] = [];
    for (let d: number = 0; d < finished.length - 4; d++) {
      drop.push(finished[d]);
    }
    let keep: CommandJob[] = [];
    for (let j: number = 0; j < CommandService.jobs.length; j++) {
      if (drop.indexOf(CommandService.jobs[j]) === -1) {
        keep.push(CommandService.jobs[j]);
      }
    }
    CommandService.jobs = keep;
  }

  // ===== 脚本同审 =====

  /**
   * 脚本同审：把命令引用到的工作区脚本读进来，过同一套危险判定，命中就并进 verdict
   * （审批卡上写明是「哪个文件的哪一项」，用户才知道自己在批什么）。
   * 返回脚本内容里命中的**硬禁**项 —— 这类操作不给审批入口，与命令行本身同一口径。
   *
   * 会跟进脚本内部的引用（`run.bat` 里只写一行 `helper.ps1` 不算把危险藏好）。跟进时两件事必须做到：
   *   1. 相对路径按**所有可能的基准目录**试（进程 cwd 与脚本自己的目录），解析到几个就审几个 ——
   *      只按脚本自己的目录算，外层脚本写 `audit\x.bat` 这种「相对 cwd」的引用就会找不到而被跳过；
   *   2. 找不到的引用要**转审批**而不是静默放过。找不到只代表「我们的路径模型没覆盖到」
   *      （`%~dp0`、PATH 上的名字、脚本里自己 cd），不代表运行时不存在 ——
   *      实测 `%~dp0` 一条就静默删了文件。
   * 深度 2、文件数 8 封顶；被上限挡掉的引用同样转审批，不能默默少审。
   *
   * 这套审阅有一个绕不过去的时间差：它读的是**执行前**的文件内容，而同一条命令可以先把脚本改写掉
   * 再执行（`type payload.txt > run.bat && call run.bat`：这里看到的是干净的旧 run.bat，命令跑起来
   * 才把它换成 payload.txt 再 call）。所以「把输出重定向进脚本文件」由 CommandGuard 单独判危险
   * （见 firstScriptWriteTarget），改这条链时别把那层规则当成多余的。
   */
  private static auditScripts(command: string, cwdRel: string, root: string,
    verdict: GuardVerdict): string {
    let forbidden: string[] = [];
    let queue: ScriptAuditItem[] = [];
    let refs: string[] = CommandGuard.scriptRefs(command);
    // cmd 会按 PATHEXT 给裸名补后缀：`call clean` 落到的就是 clean.bat，而 scriptRefs 只认带后缀的
    // token —— 「把破坏写进 clean.bat，再用 call clean 调起来」把整个脚本同审跳了过去（实测）。
    // 只把**工作区里真实存在**的那几个补进来，所以不会给每条命令都添一条「脚本不存在」的风险项。
    refs = refs.concat(CommandService.bareScriptRefs(command, cwdRel, root));
    // package.json 的 scripts 是「同一条命令的另一半」：`npm run x` 跑的是文件里那段命令行，
    // 它既不在命令行文本里，后缀也不在脚本同审那张表里（.json 是数据文件）——把 `del` 写进去
    // 再 npm run 一下，就等于把破坏搬进了一个**没有扩展名**的脚本容器。
    // 实测（本轮）：package.json 里写 "x": "del /q marker.txt"，`npm run x` 零审批删掉了文件。
    // 这里按同一把尺子审它的正文，并把正文里引用的脚本一并排进同审队列（`npm run y` 也跟一层）。
    let pkgScripts: PackageScript[] =
      CommandService.packageScriptBodies(command, cwdRel, root, verdict);
    for (let p: number = 0; p < pkgScripts.length; p++) {
      let pkgVerdict: GuardVerdict = CommandGuard.assessScript(pkgScripts[p].body, root);
      for (let r: number = 0; r < pkgVerdict.reasons.length; r++) {
        let label: string = 'package.json 的 scripts.' + pkgScripts[p].name + ' 里：' +
          pkgVerdict.reasons[r];
        if (pkgVerdict.forbidden) {
          forbidden.push(label);
          verdict.forbidden = true;
        }
        CommandService.pushRisk(verdict, label);
      }
      refs = refs.concat(CommandGuard.scriptRefs(pkgScripts[p].body));
    }
    for (let i: number = 0; i < refs.length; i++) {
      let abs: string | null = CommandService.resolveScript(refs[i], cwdRel, root);
      if (abs === null) {
        CommandService.pushRisk(verdict, '脚本 ' + refs[i] + ' 不在工作区内，内容审阅不了');
        continue;
      }
      queue.push(CommandService.auditItem(abs, refs[i], [cwdRel], 0, root));
    }
    let seen: string[] = [];
    while (queue.length > 0 && seen.length < CommandService.MAX_SCRIPT_FILES) {
      let item: ScriptAuditItem = queue.shift() as ScriptAuditItem;
      if (seen.indexOf(item.abs) !== -1) {
        continue;
      }
      seen.push(item.abs);
      if (!fileIo.accessSync(item.abs)) {
        // 文件现在不在，**不代表命令跑起来之后不在**：同一条命令可以前半段用 writeFileSync
        // 写出载荷、后半段执行它（写文件本身不在危险表里，这是既定口径）。所以读不到就转审批，
        // 而不是按「命令自己会失败」静默放过。
        CommandService.pushRisk(verdict, '脚本 ' + item.label + ' 在工作区里还不存在，内容审阅不了');
        continue;
      }
      let size: number = fileIo.statSync(item.abs).size;
      if (size > Constants.WORK_CMD_SCRIPT_AUDIT_MAX_BYTES) {
        CommandService.pushRisk(verdict, '脚本 ' + item.label + ' 有 ' +
          Math.round(size / 1024).toString() + ' KB，超出能逐字审阅的上限');
        continue;
      }
      let body: string | null = CommandService.readScript(item.abs);
      if (body === null) {
        CommandService.pushRisk(verdict, '脚本 ' + item.label + ' 读不出文本（二进制或编码不符），内容审阅不了');
        continue;
      }
      let inner: GuardVerdict = CommandGuard.assessScript(body, root);
      for (let r: number = 0; r < inner.reasons.length; r++) {
        let label: string = '脚本 ' + item.label + ' 里：' + inner.reasons[r];
        if (inner.forbidden) {
          forbidden.push(label);
        }
        CommandService.pushRisk(verdict, label);
      }
      if (inner.forbidden) {
        verdict.forbidden = true;
      }
      let children: string[] = CommandGuard.scriptRefs(body);
      // 裸名引用同样跟进（脚本里写 `helper` 跑的就是 helper.bat）；只收工作区里真实存在的，
      // 否则每一份 .bat 里的 `echo`、`dir` 都会被当成「定位不到的脚本」去追问用户。
      let childBases: string[] = CommandService.mergeBases(item);
      for (let b: number = 0; b < childBases.length; b++) {
        children = children.concat(CommandService.bareScriptRefs(body, childBases[b], root));
      }
      if (children.length === 0) {
        continue;
      }
      if (item.depth >= CommandService.MAX_SCRIPT_DEPTH) {
        CommandService.pushRisk(verdict, '脚本 ' + item.label +
          ' 里还引用了别的脚本，但已经到了审阅层级上限，更里面的内容没看');
        continue;
      }
      for (let c: number = 0; c < children.length; c++) {
        CommandService.collectChildren(children[c], item, seen, queue, verdict, root);
      }
    }
    if (queue.length > 0) {
      CommandService.pushRisk(verdict, '命令引用的脚本超过 ' +
        CommandService.MAX_SCRIPT_FILES.toString() + ' 个，剩下的内容没读');
    }
    return forbidden.join('、');
  }

  // 「相对脚本自己」的写法：cmd 的 %~dp0/%~dp1（脚本所在目录 + 尾斜杠）、PowerShell 的 $PSScriptRoot。
  // shell 执行时会把它们换成脚本所在目录，所以这一类只按脚本自己的目录解析。
  private static readonly OWN_DIR_RE: RegExp = /^(?:%~dp\d|%~f0|\$\{?PSScriptRoot\}?)[/\\]?/i;

  private static readonly MAX_SCRIPT_FILES: number = 8;
  private static readonly MAX_SCRIPT_DEPTH: number = 2;

  /** 脚本内部的一条引用：按每一个可能的基准目录去解析，解析到几个就审几个，一个都没有就转审批 */
  private static collectChildren(ref: string, item: ScriptAuditItem, seen: string[],
    queue: ScriptAuditItem[], verdict: GuardVerdict, root: string): void {
    let ownDirOnly: boolean = CommandService.OWN_DIR_RE.test(ref);
    let clean: string = ref.replace(CommandService.OWN_DIR_RE, '');
    let bases: string[] = ownDirOnly ? [item.ownDir] : CommandService.mergeBases(item);
    let found: string[] = [];
    let audited: boolean = false;
    for (let b: number = 0; b < bases.length; b++) {
      let abs: string | null = CommandService.resolveScript(clean, bases[b], root);
      if (abs === null || !fileIo.accessSync(abs)) {
        continue;
      }
      if (seen.indexOf(abs) !== -1) {
        audited = true;
        continue;
      }
      if (found.indexOf(abs) === -1) {
        found.push(abs);
      }
    }
    if (found.length === 0) {
      if (!audited) {
        CommandService.pushRisk(verdict, '脚本 ' + item.label + ' 里引用的 ' + ref +
          ' 在工作区里定位不到（或在工作区之外），内容审阅不了');
      }
      return;
    }
    for (let f: number = 0; f < found.length; f++) {
      queue.push(CommandService.auditItem(found[f], ref, item.bases, item.depth + 1, root));
    }
  }

  /** 候选基准目录：继承下来的执行目录，加上脚本自己所在的目录（去重） */
  private static mergeBases(item: ScriptAuditItem): string[] {
    let out: string[] = [];
    for (let i: number = 0; i < item.bases.length; i++) {
      if (out.indexOf(item.bases[i]) === -1) {
        out.push(item.bases[i]);
      }
    }
    if (out.indexOf(item.ownDir) === -1) {
      out.push(item.ownDir);
    }
    return out;
  }

  private static auditItem(abs: string, label: string, bases: string[], depth: number,
    root: string): ScriptAuditItem {
    let item: ScriptAuditItem = new ScriptAuditItem();
    item.abs = abs;
    item.label = label;
    item.bases = bases;
    item.depth = depth;
    // 脚本自己所在的目录：它内部写的相对路径也可能按这里解析（脚本先 cd 到自己目录是常见写法）
    item.ownDir = CommandService.relativeToRoot(abs.substring(0, abs.lastIndexOf('/')), root);
    return item;
  }

  private static relativeToRoot(abs: string, root: string): string {
    let nAbs: string = abs.replace(/\\/g, '/');
    let nRoot: string = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (nAbs.toLowerCase().indexOf(nRoot.toLowerCase() + '/') === 0) {
      return nAbs.substring(nRoot.length + 1);
    }
    return nAbs === nRoot ? '' : nAbs;
  }

  // 裸名可能被 PATHEXT 补成的后缀。只收「能给 shell/解释器执行」的那几个：
  // .exe/.com 这类二进制读不出内容，把它算进来等于让「跑一个工作区里的可执行文件」每条都要批准。
  private static readonly BARE_SCRIPT_EXTS: string[] = [
    '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.js', '.mjs', '.cjs', '.py', '.sh', '.wsf'
  ];

  /**
   * 「无后缀的脚本名」→ 工作区里真实存在的那份脚本。
   *
   * cmd 的 PATHEXT 会在裸名后面补 .bat/.cmd/.ps1… 再执行，而 CommandGuard.scriptRefs 只按后缀筛，
   * 于是 `call tools\clean` 把 tools\clean.bat 整个跳过了同审（实测四种裸名写法全部零审批）。
   * 这里只补**真实存在**的文件：文本层不知道 cwd 下有什么，猜的结果是每条命令都多一条
   * 「脚本在工作区里还不存在」的风险项（那样连 `git status` 都要人点一下）。
   */
  private static bareScriptRefs(text: string, baseRel: string, root: string): string[] {
    let tokens: string[] = CommandGuard.bareScriptTokens(text);
    let refs: string[] = [];
    for (let i: number = 0; i < tokens.length; i++) {
      for (let e: number = 0; e < CommandService.BARE_SCRIPT_EXTS.length; e++) {
        let rel: string = tokens[i] + CommandService.BARE_SCRIPT_EXTS[e];
        let abs: string | null = CommandService.resolveScript(rel, baseRel, root);
        if (abs === null || !fileIo.accessSync(abs)) {
          continue;
        }
        if (refs.indexOf(rel) === -1) {
          refs.push(rel);
        }
      }
    }
    return refs;
  }

  /**
   * 命令里出现的「npm/yarn/pnpm/bun 要跑哪个 script」。
   *
   * 三种写法都要认：`<pm> run x` / `<pm> run-script x`（最正规的那一种）、
   * `<pm> start|test|restart|stop`（npm 的隐式 script 名）、以及 yarn/bun 特有的 `<pm> x`
   * （不需要 run）。词先过 CommandGuard.plainToken，`np^m run x` 这种拆词写法同样认得出来。
   */
  private static packageScriptNames(text: string): string[] {
    let out: string[] = [];
    let segments: string[] = text.split(/\r?\n|&&|\|\||[;&|]/);
    for (let s: number = 0; s < segments.length; s++) {
      let rawToks: string[] = segments[s].trim().split(/\s+/);
      let toks: string[] = [];
      for (let t: number = 0; t < rawToks.length; t++) {
        let w: string = CommandGuard.plainToken(rawToks[t]);
        if (w !== '') {
          toks.push(w);
        }
      }
      for (let i: number = 0; i + 1 < toks.length; i++) {
        let pm: string = toks[i].replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
        if (!/^(?:npm|pnpm|yarn|bun)$/.test(pm)) {
          continue;
        }
        // 参数可以插在包管理器与子命令之间：`npm --prefix <dir> run x`、`yarn --cwd <dir> build`。
        // 只看紧邻的下一词，`--prefix` 就会顶掉 `run`，script 名连识别都识别不出来（实测这条路
        // 让 `npm --prefix .tmp/pkg run scour` 整条免审）。
        let name: string = CommandService.pkgScriptNameIn(toks.slice(i + 1), pm);
        if (name !== '' && out.indexOf(name) === -1) {
          out.push(name);
        }
        break;
      }
    }
    return out;
  }

  // 包管理器自己的子命令（它们不是 script 名，别拿去找 package.json 的 scripts）
  private static readonly PKG_SUBCOMMAND_RE: RegExp =
    /^(?:add|audit|bin|cache|ci|config|create|dedupe|delete|dlx|doctor|exec|explain|fund|get|help|i|info|init|install|launch|link|list|login|logout|ls|outdated|pack|patch|pkg|prefix|prune|publish|rebuild|remove|repo|root|run|run-script|search|set|store|un|uninstall|unlink|update|upgrade|version|view|why|workspace|workspaces|whoami|x)$/i;

  /** 包管理器里「后面跟一个值」的参数：跳过这些词时必须连它的值一起跳，否则值会被当成子命令 */
  private static readonly PKG_VALUE_FLAGS: string[] = [
    '--prefix', '--dir', '--cwd', '-c', '-w', '--workspace', '--workspaces',
    '--filter', '-f', '--registry', '--userconfig', '--globalconfig', '--cache',
    '--loglevel', '--omit', '--include'
  ];

  /**
   * 从「包管理器之后的词」里找出要执行的 script 名。
   *
   * 顺序是：跳过参数（带值的连值一起跳）→ 遇到 run / run-script 就取它后面第一个真词；
   * 遇到 start / test / restart / stop 就直接用这个词；yarn / bun 允许省掉 run，取第一个
   * 非子命令的真词。认不出来返回 ''（此时调用方不会去找 package.json）。
   */
  private static pkgScriptNameIn(rest: string[], pm: string): string {
    let firstReal: (from: number) => number = (from: number): number => {
      let k: number = from;
      while (k < rest.length) {
        let lower: string = rest[k].toLowerCase();
        if (CommandService.PKG_VALUE_FLAGS.indexOf(lower) !== -1) {
          k += 2;
          continue;
        }
        if (rest[k] === '--') {
          k += 1;
          continue;
        }
        if (rest[k].charAt(0) === '-') {
          k += 1;
          continue;
        }
        return k;
      }
      return -1;
    };
    let k: number = firstReal(0);
    while (k >= 0) {
      let lower: string = rest[k].toLowerCase();
      if (lower === 'run' || lower === 'run-script') {
        let n: number = firstReal(k + 1);
        return n < 0 ? '' : rest[n];
      }
      if (/^(?:start|test|restart|stop)$/.test(lower)) {
        return lower;
      }
      if (pm === 'yarn' || pm === 'bun') {
        return CommandService.PKG_SUBCOMMAND_RE.test(lower) ? '' : rest[k];
      }
      return '';
    }
    return '';
  }

  /** 从工作目录往上找工作区里最近的那个 package.json（npm 自己也是这么找的） */
  private static findPackageJson(cwdRel: string, root: string): string | null {
    let rel: string = cwdRel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    while (true) {
      let candidate: string = rel === '' ? 'package.json' : rel + '/package.json';
      let abs: string | null = WorkFileService.resolveSafePublic(root, candidate);
      if (abs !== null && fileIo.accessSync(abs)) {
        return abs;
      }
      if (rel === '') {
        return null;
      }
      let cut: number = rel.lastIndexOf('/');
      rel = cut < 0 ? '' : rel.substring(0, cut);
    }
  }

  /**
   * 包管理器把「包目录」从参数里改掉的写法：`npm --prefix <dir> run x`、`pnpm -C <dir>`、
   * `yarn --cwd <dir>`、`--dir=<dir>`（含 `=` 与空格两种写法）。
   *
   * 这类参数一出现，scripts 就不再来自「cwd 往上最近的那个 package.json」。实测
   * `npm --prefix .tmp/npmcheck run scour`：同审按 cwd 读到了**工作区根目录**的 package.json
   * （里面没有 scour），判空后静默放行 —— 删除照跑、全程没有审批卡。参数换了位置，
   * 审的就不是同一个文件了，这跟前一轮的 `ca^ll` 是同一类「审的实体 != 跑的实体」。
   *
   * 返回 '' = 没指定包目录；其它 = 解析出的包目录（相对工作区）；null = 指定了但落在工作区外。
   */
  private static packageDirHint(text: string, cwdRel: string, root: string): string | null {
    let segments: string[] = text.split(/\r?\n|&&|\|\||[;&|]/);
    for (let s: number = 0; s < segments.length; s++) {
      let rawToks: string[] = segments[s].trim().split(/\s+/);
      let toks: string[] = [];
      for (let t: number = 0; t < rawToks.length; t++) {
        let w: string = CommandGuard.plainToken(rawToks[t]);
        if (w !== '') {
          toks.push(w);
        }
      }
      let isPm: boolean = false;
      for (let i: number = 0; i < toks.length; i++) {
        let pm: string = toks[i].replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
        if (/^(?:npm|pnpm|yarn|bun)$/.test(pm)) {
          isPm = true;
          break;
        }
      }
      if (!isPm) {
        continue;
      }
      for (let i: number = 0; i < toks.length; i++) {
        let value: string = '';
        let inline: RegExpMatchArray | null = toks[i].match(/^(?:--prefix|--dir|--cwd)=(.+)$/i);
        if (inline !== null) {
          value = inline[1];
        } else if (/^(?:--prefix|--dir|--cwd|-C)$/.test(toks[i]) && i + 1 < toks.length) {
          value = toks[i + 1];
        }
        if (value === '') {
          continue;
        }
        let abs: string | null = CommandService.resolveScript(value, cwdRel, root);
        return abs === null ? null : CommandService.relativeToRoot(abs, root);
      }
    }
    return '';
  }

  /** `-w pkg` / `--workspace=pkg`：脚本在子包里。名字→目录的映射不在这里猜，交给调用方转审批。 */
  private static hasWorkspaceFlag(text: string): boolean {
    return /(?:^|[\s;&|])(?:-w|--workspace|--workspaces|--ws|-ws)(?:[=\s]|$)/i.test(text);
  }

  /**
   * 取出这条命令会执行的 package.json script（名字 + 正文），并且顺着 `npm run y` 再跟一层。
   *
   * 读不出 / 解析不了时**转审批**而不是静默放过 —— 与「脚本读不出文本」同一条口径：
   * 读不到内容只代表我们看不见，不代表它跑起来无害。
   */
  private static packageScriptBodies(command: string, cwdRel: string, root: string,
    verdict: GuardVerdict): PackageScript[] {
    let out: PackageScript[] = [];
    let wanted: string[] = CommandService.packageScriptNames(command);
    if (wanted.length === 0) {
      return out;
    }
    // 包目录被参数改写时只能读那一个：往上翻会读到另一份 package.json，审的就不是要跑的那个文件
    let dirHint: string | null = CommandService.packageDirHint(command, cwdRel, root);
    if (dirHint === null) {
      CommandService.pushRisk(verdict,
        '命令用 --prefix / --dir / --cwd 指定了工作区之外的包目录，里面的 scripts 审阅不了');
      return out;
    }
    let pkgAbs: string | null;
    if (dirHint !== '') {
      pkgAbs = CommandService.resolveScript('package.json', dirHint, root);
      if (pkgAbs === null || !fileIo.accessSync(pkgAbs)) {
        CommandService.pushRisk(verdict, '命令指定的包目录 ' + dirHint +
          ' 里没有 package.json（或读不到），要跑的 scripts 审阅不了');
        return out;
      }
    } else {
      pkgAbs = CommandService.findPackageJson(cwdRel, root);
    }
    if (pkgAbs === null) {
      // 工作区里连 package.json 都没有：npm 会自己往上一层找，找不到就报错，命令根本跑不起来，
      // 所以这里不打扰用户（否则每个空目录里的 `npm test` 都要多问一次）。
      return out;
    }
    let size: number = fileIo.statSync(pkgAbs).size;
    if (size > Constants.WORK_CMD_SCRIPT_AUDIT_MAX_BYTES) {
      CommandService.pushRisk(verdict, 'package.json 有 ' + Math.round(size / 1024).toString() +
        ' KB，超出能逐字审阅的上限，里面的 scripts 审阅不了');
      return out;
    }
    let text: string | null = CommandService.readScript(pkgAbs);
    if (text === null) {
      CommandService.pushRisk(verdict, 'package.json 读不出文本（编码不符？），里面的 scripts 审阅不了');
      return out;
    }
    let scripts: Record<string, string> = {};
    try {
      let parsed: Object = JSON.parse(text) as Object;
      let bag: Object | undefined = (parsed as Record<string, Object>)['scripts'];
      if (bag !== undefined && bag !== null && typeof bag === 'object') {
        let map: Record<string, Object> = bag as Record<string, Object>;
        let keys: string[] = Object.keys(map);
        for (let k: number = 0; k < keys.length; k++) {
          let v: Object = map[keys[k]];
          if (typeof v === 'string') {
            scripts[keys[k]] = v as string;
          }
        }
      }
    } catch (e) {
      CommandService.pushRisk(verdict, 'package.json 解析失败，里面的 scripts 审阅不了');
      return out;
    }
    let queue: string[] = wanted;
    let seen: string[] = [];
    while (queue.length > 0 && out.length < CommandService.MAX_SCRIPT_FILES) {
      let name: string = queue.shift() as string;
      if (seen.indexOf(name) !== -1) {
        continue;
      }
      seen.push(name);
      let body: string | undefined = scripts[name];
      if (body === undefined || body.trim() === '') {
        continue;
      }
      let item: PackageScript = new PackageScript();
      item.name = name;
      item.body = body;
      out.push(item);
      let nested: string[] = CommandService.packageScriptNames(body);
      for (let n: number = 0; n < nested.length; n++) {
        if (seen.indexOf(nested[n]) === -1) {
          queue.push(nested[n]);
        }
      }
    }
    // `-w <pkg>` 把执行目录换到子包：真正要跑的 scripts 在子包自己的 package.json 里，
    // 我们手上这份（根/上层的）不是同一个文件 —— 与其拿另一份正文去审，不如转审批。
    if (CommandService.hasWorkspaceFlag(command)) {
      CommandService.pushRisk(verdict,
        '命令用 -w / --workspace 把执行目录换成了工作区子包，子包里真正要跑的 scripts 审阅不了');
    }
    return out;
  }

  private static readScript(abs: string): string | null {
    try {
      return fileIo.readTextSync(abs);
    } catch (e) {
      return null;
    }
  }

  /** 把命令里写的脚本路径归一成工作区内的绝对路径；工作区之外（或读不出）返回 null */
  private static resolveScript(ref: string, baseRel: string, root: string): string | null {
    let norm: string = ref.replace(/\\/g, '/').replace(/^"+|"+$/g, '');
    let rel: string = norm;
    if (/^[a-zA-Z]:\//.test(norm) || norm.indexOf('/') === 0) {
      let base: string = root.replace(/\\/g, '/').replace(/\/+$/, '');
      if (norm.toLowerCase().indexOf(base.toLowerCase() + '/') !== 0) {
        return null;
      }
      rel = norm.substring(base.length + 1);
    }
    let prefix: string = baseRel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return WorkFileService.resolveSafePublic(root, prefix === '' ? rel : prefix + '/' + rel);
  }

  private static pushRisk(verdict: GuardVerdict, why: string): void {
    if (verdict.reasons.indexOf(why) === -1) {
      verdict.reasons.push(why);
    }
    verdict.risky = true;
  }

  // ===== 审批 =====

  private static async askApproval(convId: string, command: string, cwdRel: string,
    verdict: GuardVerdict, review: ReviewOutcome | null): Promise<Approval> {
    let lines: string[] = [];
    lines.push('智能体请求执行一条命令, 需要你批准。');
    lines.push('工作目录: ' + (cwdRel === '' ? '工作区根' : cwdRel));
    if (verdict.reasons.length > 0) {
      lines.push('风险: ' + verdict.reasons.join('、'));
    }
    // 'auto' 档会走到这张卡上只有两种可能: 模型判了该拦, 或模型没能给出结论。
    // 两种都如实写在卡上 —— 用户看到的是「机器先看过、它的结论是什么」, 不是凭空多出来的一张卡。
    let reviewLine: string = '';
    if (review !== null) {
      reviewLine = review.failed !== '' ?
        '自动审阅未能定论(' + review.failed + '), 请你决定' :
        '自动审阅判定 ' + review.risk + ' 风险' +
        (review.reason === '' ? '' : '(' + review.reason + ')') + ', 仍请你决定';
      lines.push(reviewLine);
    }
    lines.push('命令:');
    lines.push(command.trim());
    // 桥返回 null 的三种情况(超时/跳过/任务中止)都按拒绝处理 —— 没人应答就等于不许。
    let answer: AskAnswer | null = await AskUserBridge.ask(lines.join('\n'),
      [APPROVE_ONCE, APPROVE_ALL, APPROVE_DENY], false,
      Constants.WORK_ASK_WAIT_TIMEOUT_MS, convId);
    let approval: Approval = new Approval();
    approval.reviewLine = reviewLine;
    if (answer === null) {
      approval.why = '未获得批准(超时或已跳过, 按拒绝处理)';
      return approval;
    }
    approval.note = answer.note.trim();
    let picked: string = answer.selections.join('|');
    if (picked.indexOf(APPROVE_DENY) !== -1) {
      approval.why = '用户明确拒绝';
      return approval;
    }
    if (picked.indexOf(APPROVE_ONCE) === -1 && picked.indexOf(APPROVE_ALL) === -1) {
      // 只写了补充说明、没点许可项: 审批必须点到明确的许可上, 不能把沉默当同意
      approval.why = '没有点选许可项';
      return approval;
    }
    approval.allowed = true;
    approval.grantAll = picked.indexOf(APPROVE_ALL) !== -1;
    return approval;
  }

  private static denyResult(command: string, why: string, note: string): ToolExecResult {
    let extra: string = note === '' ? '' : '; 用户补充: ' + note;
    return CommandService.fail('命令未执行(' + why + extra + '): ' +
      CommandService.clip(command, 120) +
      '。请改用文件/搜索等工具完成, 或把要执行的命令与理由写进回答交给用户, 不要重复请求同一条命令');
  }

  // ===== 结果渲染 =====

  private static renderForeground(root: string, cwdRel: string, outcome: ShellOutcome,
    verdict: GuardVerdict, note: string, reviewLine: string): ToolExecResult {
    let r: ToolExecResult = new ToolExecResult();
    let header: string = '[run_command] 退出码 ' + outcome.exitCode.toString() + ' · 用时 ' +
      (Math.round(outcome.durationMs / 100) / 10).toString() + 's · 目录 ' +
      (cwdRel === '' ? '工作区根' : cwdRel);
    let notes: string[] = [];
    if (outcome.timedOut) {
      notes.push('已达超时上限, 进程树已被终止(需要更久的话用 run_in_background 放后台)');
      r.timeout = true;
    }
    if (outcome.signal === 'aborted') {
      notes.push('任务被停止, 进程树已被终止');
      r.cancelled = true;
    }
    if (outcome.droppedChars > 0) {
      notes.push('输出超过缓冲上限, 开头 ' + outcome.droppedChars.toString() +
        ' 字符已被丢弃(下面只是结尾部分, 不是全量)');
    }
    let body: string = outcome.output.trim();
    if (body === '') {
      body = '(没有输出)';
    }
    if (body.length > Constants.WORK_RESULT_MAX_CHARS) {
      body = CommandService.spillAndTruncate(root, 'run_command', body);
    }
    r.ok = outcome.exitCode === 0 && !r.timeout && !r.cancelled;
    let tail: string = notes.length > 0 ? '\n注意: ' + notes.join('; ') : '';
    r.output = header + CommandService.riskLine(verdict, note, reviewLine) + tail + '\n\n' + body;
    if (!r.ok) {
      r.output = 'ERROR: ' + r.output;
    }
    return r;
  }

  private static riskLine(verdict: GuardVerdict, note: string, reviewLine: string): string {
    let text: string = '';
    if (verdict.risky) {
      text += '\n(已批准的危险项: ' + verdict.reasons.join('、') + ')';
    }
    if (reviewLine !== '') {
      // 谁放行的要写清: 模型放行没有经过用户的手, 事后回看得能分辨出这两条路
      text += '\n(' + reviewLine + ')';
    }
    if (note !== '') {
      text += '\n(用户批准时的补充要求: ' + note + ')';
    }
    return text;
  }

  // 超长输出: 全文落工作区 .spill/, 送回模型的只留头尾 + 定位(对齐 dsh 的「截断不丢失」)
  private static spillAndTruncate(root: string, label: string, text: string): string {
    let spillRel: string = SpillStore.save(root, label, text);
    return SpillStore.truncateWithLocator(text, spillRel);
  }

  // ===== 参数与小工具 =====

  private static clip(text: string, max: number): string {
    let oneLine: string = text.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : oneLine.substring(0, max) + '…';
  }

  private static strArg(args: Record<string, Object>, key: string, defVal: string): string {
    let v: Object = args[key];
    if (typeof v === 'string') {
      return v as string;
    }
    if (typeof v === 'number') {
      return (v as number).toString();
    }
    return defVal;
  }

  private static intArg(args: Record<string, Object>, key: string, defVal: number): number {
    let v: Object = args[key];
    if (typeof v === 'number' && !isNaN(v as number)) {
      return Math.floor(v as number);
    }
    if (typeof v === 'string') {
      let n: number = parseInt(v as string, 10);
      if (!isNaN(n)) {
        return n;
      }
    }
    return defVal;
  }

  private static boolArg(args: Record<string, Object>, key: string, defVal: boolean): boolean {
    let v: Object = args[key];
    if (typeof v === 'boolean') {
      return v as boolean;
    }
    if (typeof v === 'string') {
      let s: string = (v as string).toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') {
        return true;
      }
      if (s === 'false' || s === '0' || s === 'no') {
        return false;
      }
    }
    return defVal;
  }

  private static ok(output: string): ToolExecResult {
    let r: ToolExecResult = new ToolExecResult();
    r.ok = true;
    r.output = output;
    return r;
  }

  private static fail(output: string): ToolExecResult {
    let r: ToolExecResult = new ToolExecResult();
    r.ok = false;
    r.output = 'ERROR: ' + output;
    return r;
  }
}
