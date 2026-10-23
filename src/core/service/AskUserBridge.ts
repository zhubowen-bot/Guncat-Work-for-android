// AskUserBridge: ask_user_question 工具与 UI 之间的桥(对齐 DeepSeek Harness 的 ask_user 交互)
// 工具执行线程注册问题并挂起等待; ChatPage 渲染问题卡片, 用户作答后 resolve, 结果回传模型。
// 纯逻辑模块, 不依赖设备 API。

// 一次待回答的提问
export class PendingAsk {
  id: string = '';
  question: string = '';
  options: string[] = [];
  multiSelect: boolean = false;
  // 归属会话: 鸿蒙侧靠 ChatPage 每秒轮询 current() 就能画卡片, 因为那里只有一个前台会话;
  // 桌面端是多会话的, 主进程必须知道这条提问属于哪个会话, 才能把 ask:user 事件
  // 精确推给对当前会话, 而不是让所有会话都弹同一张卡。
  conversationId: string = '';
}

// 回答结果(送回模型的文本由 resolve 调用方组装)
export class AskAnswer {
  selections: string[] = [];
  note: string = ''; // 用户自定义补充, 可空
}

/**
 * 提问生命周期通知: 'ask' = 刚挂起(界面该画卡片了); 'settled' = 已落定
 * (用户作答 / 点跳过 / 超时 / 被中止), 界面该收卡片了。
 *
 * 为什么需要它: 鸿蒙侧 ChatPage 每秒轮询 current() 拿待答提问; 桌面端的渲染层
 * 在另一个进程, 只能靠主进程推事件。桥本身不认识 Electron, 因此只暴露一个回调,
 * 由 SessionManager 装上去, 把生命周期翻译成 ask:user / ask:done 事件。
 */
export type AskPhase = 'ask' | 'settled';
/**
 * answered 只在 phase='settled' 时有意义: true = 用户真的答了,
 * false = 跳过/超时/被中止(桥里返回的都是 null, 界面需要区分这两种结局)。
 */
export type AskNotifier = (item: PendingAsk, phase: AskPhase, answered: boolean) => void;

export class AskUserBridge {
  private static pending: Map<string, PendingAsk> = new Map();
  private static resolvers: Map<string, (answer: AskAnswer | null) => void> = new Map();
  // 每张卡的兜底计时器：落定（作答/取消/超时）就必须清掉。留着它等于「用户 3 毫秒就答完了，
  // 进程还要为这张已经作废的卡再挂 5 分钟」——主进程退出和验证脚本收口都被这一步吊住。
  private static timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static seq: number = 0;
  private static notifier: AskNotifier | null = null;

  // 宿主(主进程)装上生命周期回调; 传 null 卸载
  static setNotifier(notifier: AskNotifier | null): void {
    AskUserBridge.notifier = notifier;
  }

  // 注册提问并等待用户作答; 用户中断时返回 null
  static ask(question: string, options: string[], multiSelect: boolean,
    timeoutMs: number, conversationId: string = ''): Promise<AskAnswer | null> {
    let id: string = 'ask_' + Date.now().toString() + '_' + (AskUserBridge.seq++).toString();
    let item: PendingAsk = new PendingAsk();
    item.id = id;
    item.question = question;
    item.options = options;
    item.multiSelect = multiSelect;
    item.conversationId = conversationId;
    AskUserBridge.pending.set(id, item);
    return new Promise<AskAnswer | null>((resolve: (a: AskAnswer | null) => void) => {
      AskUserBridge.resolvers.set(id, resolve);
      // 先登记 resolver 再通知界面: 用户可能在事件回来之前就点了提交,
      // 顺序反过来的话那一次作答会找不到 resolver 而被丢掉(工具继续挂到超时)。
      AskUserBridge.notify(item, 'ask', false);
      if (timeoutMs > 0) {
        // 平台差异补丁: ArkTS 的 setTimeout 返回 number, Node 返回 Timeout 对象
        let timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
          AskUserBridge.timers.delete(id);
          if (AskUserBridge.resolvers.has(id)) {
            // 超时未答: 以取消收场, 避免工具永久挂起
            AskUserBridge.resolveWith(id, null);
          }
        }, timeoutMs);
        AskUserBridge.timers.set(id, timer);
        // 兜底计时器不该反过来决定宿主能活多久: 到点无人应答仍然按取消收场,
        // 但一张挂着的卡不能让主进程退不出去（关窗、验证脚本收口都被它拖住过）。
        timer.unref?.();
      }
    });
  }

  // 当前是否有待回答的提问(供 UI 轮询)
  static current(): PendingAsk | null {
    let first: PendingAsk | null = null;
    AskUserBridge.pending.forEach((v: PendingAsk, _k: string): void => {
      if (first === null) {
        first = v;
      }
    });
    return first;
  }

  // 用户作答
  static answer(id: string, answer: AskAnswer): boolean {
    return AskUserBridge.resolveWith(id, answer);
  }

  // 用户取消作答
  static cancel(id: string): boolean {
    return AskUserBridge.resolveWith(id, null);
  }

  // 取消全部挂起提问(循环被中断时调用)
  static cancelAll(): void {
    let ids: string[] = [];
    AskUserBridge.pending.forEach((_v: PendingAsk, k: string): void => {
      ids.push(k);
    });
    for (let i: number = 0; i < ids.length; i++) {
      AskUserBridge.resolveWith(ids[i], null);
    }
  }

  private static resolveWith(id: string, answer: AskAnswer | null): boolean {
    let resolver: (answer: AskAnswer | null) => void | undefined =
      AskUserBridge.resolvers.get(id);
    if (resolver === undefined) {
      return false;
    }
    let item: PendingAsk | undefined = AskUserBridge.pending.get(id);
    AskUserBridge.resolvers.delete(id);
    AskUserBridge.pending.delete(id);
    let timer: ReturnType<typeof setTimeout> | undefined = AskUserBridge.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      AskUserBridge.timers.delete(id);
    }
    // 先 resolve 再通知界面收卡片: 工具被唤醒后会继续往下跑,
    // 通知放在 resolve 之前的话, 界面可能先看到卡片消失、再看到工具已经出新结果,
    // 中间那一下「卡片还在但工具已经往下走」的错位窗口就没必要存在。
    resolver(answer);
    if (item !== undefined) {
      AskUserBridge.notify(item, 'settled', answer !== null);
    }
    return true;
  }

  private static notify(item: PendingAsk, phase: AskPhase, answered: boolean): void {
    let fn: AskNotifier | null = AskUserBridge.notifier;
    if (fn === null) {
      return;
    }
    try {
      fn(item, phase, answered);
    } catch (e) {
      // 界面通知失败不能反过来把工具挂死: 桥的职责是「保证 resolve」, 通知只是附赠
    }
  }
}
