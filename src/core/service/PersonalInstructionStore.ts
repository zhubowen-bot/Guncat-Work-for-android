// PersonalInstructionStore: 个性化指令的持久化。
//
// 数据量很小(每条最多 8000 字, 通常只有几条), 放在 Preferences 的一条 JSON 里,
// 不进会话存档文件, 也不参与流式热路径 —— 只在启动加载、设置页增删改、每轮请求前读一次。
import { StorageManager } from '../data/StorageManager';
import { Constants } from '../common/Constants';
import { PersonalInstruction } from '../model/PersonalInstruction';

export class PersonalInstructionStore {
  static async load(context: Context): Promise<PersonalInstruction[]> {
    try {
      const raw: string = await StorageManager.loadString(
        context,
        Constants.LS_KEY_PERSONAL_INSTRUCTIONS,
        ''
      );
      return PersonalInstruction.parseList(raw);
    } catch {
      // 读取失败(权限/存储异常)按"没有个性化指令"处理, 不影响正常对话
      return [];
    }
  }

  static async save(context: Context, items: PersonalInstruction[]): Promise<void> {
    await StorageManager.saveString(
      context,
      Constants.LS_KEY_PERSONAL_INSTRUCTIONS,
      PersonalInstructionStore.serialize(items)
    );
  }

  // 序列化成持久化字符串(设置页保存与单测共用同一条口径)
  static serialize(items: PersonalInstruction[]): string {
    const values: Record<string, unknown>[] = [];
    for (const item of items) {
      values.push(item.toJson());
    }
    return JSON.stringify(values);
  }
}
