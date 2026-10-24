import { Message } from './Message';
import { generateConversationId } from '../common/Utils';

// 对话(对齐 web 版本的 guncat_conversations)
export class Conversation {
  id: string = '';
  agentId: string = '';
  title: string = '';
  messages: Message[] = [];
  createdAt: number = 0;
  // 会话模式: 'chat' 聊天模式 | 'work' 工作模式(Agent Loop + 沙箱工作区); 旧数据缺省为 chat
  mode: string = 'chat';
  // 自定义工作区绝对路径; 空串 = 默认沙箱目录(filesDir/workspaces/<id>)
  workspacePath: string = '';
  // run_command 的审批档位: 'ask' 每条都问 | 'ask-risk' 危险才问 |
  // 'auto' 自动审批(默认: 危险命令先过模型) | 'full-access' 完全权限(不审不问, 硬禁仍生效)
  // 空串 = 未设置, 按默认档处理(与 workspacePath 一样要过 JSON 往返, 否则重启就丢)
  commandPermission: string = '';
  // 'auto' 在老版本里的含义是「危险命令也不问人」(= 现在的 'full-access')。老存档里的 auto
  // 必须按语义搬到 full-access 才能保住原来的行为, 但不能每次都搬 —— 用户后来亲手选的 'auto'
  // 是新的「模型审阅」档。这个一次性标记就是用来分得清「老数据」与「新选择」的。
  commandPermissionMigrated: boolean = false;

  static create(agentId: string, title: string, mode: string): Conversation {
    let conv: Conversation = new Conversation();
    conv.id = generateConversationId();
    conv.agentId = agentId;
    conv.title = title;
    conv.mode = mode;
    conv.commandPermissionMigrated = true;
    conv.createdAt = new Date().getTime();
    return conv;
  }

  static fromJson(json: Record<string, Object>): Conversation {
    let conv: Conversation = new Conversation();
    conv.id = (json['id'] as string) ?? '';
    conv.agentId = (json['agentId'] as string) ?? '';
    conv.title = (json['title'] as string) ?? '';
    conv.createdAt = (json['createdAt'] as number) ?? 0;
    conv.mode = (json['mode'] as string) ?? 'chat';
    conv.workspacePath = (json['workspacePath'] as string) ?? '';
    conv.commandPermission = (json['commandPermission'] as string) ?? '';
    // 缺这个键 = 这份存档早于档位语义调整, 交给 SessionManager 的一次性迁移处理
    conv.commandPermissionMigrated = (json['commandPermissionMigrated'] as boolean) ?? false;
    let raw: Object = json['messages'];
    if (raw !== undefined) {
      let rawMessages: Object[] = raw as Object[];
      let result: Message[] = [];
      for (let i: number = 0; i < rawMessages.length; i++) {
        result.push(Message.fromJson(rawMessages[i] as Record<string, Object>));
      }
      conv.messages = result;
    }
    return conv;
  }

  toJson(): Record<string, Object> {
    let msgs: Object[] = [];
    for (let i: number = 0; i < this.messages.length; i++) {
      msgs.push(this.messages[i].toJson());
    }
    return {
      'id': this.id,
      'agentId': this.agentId,
      'title': this.title,
      'messages': msgs,
      'createdAt': this.createdAt,
      'mode': this.mode,
      'workspacePath': this.workspacePath,
      'commandPermission': this.commandPermission,
      'commandPermissionMigrated': this.commandPermissionMigrated
    };
  }
}
