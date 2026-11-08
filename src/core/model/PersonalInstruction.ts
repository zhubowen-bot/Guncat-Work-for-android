// 个性化指令: 用户在「设置 → 个性化指令」里自己维护的一段偏好文本,
// 按生效范围自动拼接进系统提示词的末尾。
//
// 生效范围(scope)直接复用智能体 id, 不额外维护第二套映射:
//   - 'interactive' = 交互模式(Constants.INTERACTIVE_AGENT_ID)
//   - 'work'        = 工作模式(Constants.WORK_AGENT_ID)
//   - 其余          = 聊天引擎(agents.json 里各智能体的 id)
// 这样运行时拿"本轮请求用的 agent id / 会话模式"直接匹配即可。
//
// 本文件是纯数据模型(不依赖平台 API), 可以进 scripts/smoke.ts 做纯逻辑测试。
export class PersonalInstruction {
  // 单条正文上限: 系统提示词每一轮都要带上它, 太长会挤占上下文、拖慢首字。
  // 编辑器 TextArea 与解析入库两处共用同一个上限, 避免"界面能输、落盘被截"的分叉。
  static readonly MAX_CONTENT_CHARS: number = 8000;
  // 名称上限: 只用于列表与提示词里的块标记, 不承担正文职责。
  static readonly MAX_NAME_CHARS: number = 40;

  // 稳定 id(列表定位与增删改查用, 生成后不再改)
  id: string = '';
  // 用户可选的短名称; 空串时按正文首行取一个显示名(见 displayName)
  name: string = '';
  // 指令正文(用户原文, 支持 Markdown, 渲染只在编辑页做, 进提示词时保留原文)
  content: string = '';
  // 生效范围: 至少一项, 取值见文件头说明
  scopes: string[] = [];
  // 最近一次保存时间(毫秒), 列表排序/展示用
  updatedAt: number = 0;

  static create(name: string, content: string, scopes: string[]): PersonalInstruction {
    const item: PersonalInstruction = new PersonalInstruction();
    item.id = PersonalInstruction.newId();
    item.name = PersonalInstruction.clampText(name, PersonalInstruction.MAX_NAME_CHARS);
    item.content = PersonalInstruction.clampText(content, PersonalInstruction.MAX_CONTENT_CHARS);
    item.scopes = PersonalInstruction.normalizeScopes(scopes);
    item.updatedAt = Date.now();
    return item;
  }

  // 生成稳定 id: 时间戳 + 随机段, 单机内足够避免同一毫秒重复
  private static newId(): string {
    const stamp: string = Date.now().toString(36);
    const salt: string = Math.floor(Math.random() * 1679616).toString(36);
    return 'pi-' + stamp + '-' + salt;
  }

  // 去首尾空白并按字符截断(不是按字节, 中文不会被截坏)
  static clampText(text: string, max: number): string {
    const value: string = text.trim();
    return value.length > max ? value.substring(0, max) : value;
  }

  // 范围去重 + 去空: 顺序按用户勾选顺序保留, 重复项不重复生效
  static normalizeScopes(scopes: string[]): string[] {
    const out: string[] = [];
    for (const raw of scopes) {
      const value: string = raw.trim();
      if (value !== '' && out.indexOf(value) === -1) {
        out.push(value);
      }
    }
    return out;
  }

  // 旧存档/脏数据解析: 缺 id 或正文为空的条目直接丢弃(没有正文的指令拼进提示词只会是噪音)
  static fromJson(json: Record<string, unknown>): PersonalInstruction | null {
    const idObj: unknown = json['id'];
    const contentObj: unknown = json['content'];
    if (typeof idObj !== 'string' || typeof contentObj !== 'string') {
      return null;
    }
    const id: string = idObj.trim();
    const content: string = PersonalInstruction.clampText(
      contentObj,
      PersonalInstruction.MAX_CONTENT_CHARS
    );
    if (id === '' || content === '') {
      return null;
    }
    const item: PersonalInstruction = new PersonalInstruction();
    item.id = id;
    const nameObj: unknown = json['name'];
    item.name =
      typeof nameObj === 'string'
        ? PersonalInstruction.clampText(nameObj, PersonalInstruction.MAX_NAME_CHARS)
        : '';
    item.content = content;
    const scopesObj: unknown = json['scopes'];
    if (Array.isArray(scopesObj)) {
      const scopes: string[] = [];
      for (const raw of scopesObj) {
        if (typeof raw === 'string') {
          scopes.push(raw);
        }
      }
      item.scopes = PersonalInstruction.normalizeScopes(scopes);
    }
    const timeObj: unknown = json['updatedAt'];
    item.updatedAt = typeof timeObj === 'number' && Number.isFinite(timeObj) ? timeObj : 0;
    if (item.updatedAt <= 0) {
      item.updatedAt = Date.now();
    }
    return item;
  }

  // 解析整个持久化字符串: 只接受 JSON 数组; 任何坏数据都只丢条目, 不让设置页整体打不开
  static parseList(raw: string): PersonalInstruction[] {
    const out: PersonalInstruction[] = [];
    if (raw.trim() === '') {
      return out;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 存档损坏: 返回空列表, 不抛给设置页
      return out;
    }
    if (!Array.isArray(parsed)) {
      return out;
    }
    for (const value of parsed) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue;
      }
      const item: PersonalInstruction | null = PersonalInstruction.fromJson(
        value as Record<string, unknown>
      );
      if (item !== null) {
        out.push(item);
      }
    }
    return out;
  }

  toJson(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      content: this.content,
      scopes: this.scopes.slice(),
      updatedAt: this.updatedAt
    };
  }

  hasScope(scope: string): boolean {
    return this.scopes.indexOf(scope) !== -1;
  }

  // 列表显示名: 用户填了名称就用名称, 否则取正文第一条非空行(过长截断)
  displayName(): string {
    const name: string = this.name.trim();
    if (name !== '') {
      return name;
    }
    const lines: string[] = this.content.split('\n');
    for (const raw of lines) {
      // Markdown 标题/列表符号不当作标题内容
      const line: string = raw
        .trim()
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-*+]\s+/, '');
      if (line !== '') {
        return PersonalInstruction.clampText(line, 24);
      }
    }
    return '未命名指令';
  }

  // 列表副标题: 正文压成一行摘要(去 Markdown 记号, 便于单行省略显示)
  summary(): string {
    const oneLine: string = this.content.replace(/\s+/g, ' ').trim();
    return oneLine.length > 80 ? oneLine.substring(0, 80) : oneLine;
  }

  // 按 id 定位; 找不到返回 -1
  static indexOfId(items: PersonalInstruction[], id: string): number {
    for (let i: number = 0; i < items.length; i++) {
      if (items[i].id === id) {
        return i;
      }
    }
    return -1;
  }

  // 生效范围的稳定排序: 交互模式 → 工作模式 → 聊天引擎(按传入引擎顺序)。
  // 只用于展示与提示词拼接, 不影响用户已勾选的集合。
  static sortScopesByOrder(scopes: string[], order: string[]): string[] {
    const out: string[] = [];
    for (const scope of order) {
      if (scopes.indexOf(scope) !== -1) {
        out.push(scope);
      }
    }
    // 未登记的旧范围(比如引擎已从 agents.json 移除)保留在末尾, 不静默丢失数据
    for (const scope of scopes) {
      if (out.indexOf(scope) === -1) {
        out.push(scope);
      }
    }
    return out;
  }
}
