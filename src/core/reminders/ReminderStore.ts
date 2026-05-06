import { JsonStore } from "../persist/jsonStore.js";

// reminder 两种 kind：text 直接发文本；prompt 触发 agent 跑 prompt
export interface ReminderText {
  id: string;
  createdAt: number;
  createdBy: number;
  chatId: string;
  kind: "text";
  at: number;
  tz: string;
  text: string;
}

export interface ReminderPrompt {
  id: string;
  createdAt: number;
  createdBy: number;
  chatId: string;
  kind: "prompt";
  at: number;
  tz: string;
  prompt: string;
  workspaceId: string;
}

export type Reminder = ReminderText | ReminderPrompt;

interface RemindersFile {
  items: Reminder[];
}

/**
 * Reminders 持久化：基于 JsonStore，整文件读写。
 * 内存里保留一份 state 以便 list() 同步返回；写操作每次都 persist 落盘。
 */
export class ReminderStore {
  private readonly store: JsonStore<RemindersFile>;
  private state: RemindersFile = { items: [] };

  constructor(filePath: string) {
    this.store = new JsonStore<RemindersFile>(filePath, { items: [] });
  }

  async init(): Promise<void> {
    this.state = await this.store.readOrInit();
  }

  list(): Reminder[] {
    return [...this.state.items];
  }

  async add(item: Reminder): Promise<void> {
    this.state.items.push(item);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.state.items = this.state.items.filter((r) => r.id !== id);
    await this.persist();
  }

  // 用回调原子地改某条；不存在则不变
  async update(id: string, fn: (r: Reminder) => Reminder): Promise<void> {
    let changed = false;
    this.state.items = this.state.items.map((r) => {
      if (r.id !== id) return r;
      changed = true;
      return fn(r);
    });
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    await this.store.write(this.state);
  }
}

// 生成 reminder id：r-{YYYYMMDD-HHMMSS}-{seq3}
// 进程内按调用顺序自增 seq；进程重启后 seq 归零（不持久化）。
// 重启后即便 seq 重叠，由于时间戳精度到秒，碰撞概率极低。
let seq = 0;
export function newReminderId(_at: number, now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  seq = (seq + 1) % 1000;
  return `r-${stamp}-${String(seq).padStart(3, "0")}`;
}
