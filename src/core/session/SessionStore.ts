import { JsonStore } from "../persist/jsonStore.js";
import { z } from "zod";

// 单个工作区的会话信息：用 agentId 在重启后通过 Agent.resume() 续上原对话
export interface SessionEntry {
  agentId?: string;
  model?: string;
  modelParams?: Array<{ id: string; value: string }>;
}

interface SessionFile {
  workspaces: Record<string, SessionEntry>;
}

const SessionEntrySchema = z.object({
  agentId: z.string().optional(),
  model: z.string().optional(),
  modelParams: z
    .array(z.object({ id: z.string(), value: z.string() }))
    .optional(),
});

const SessionFileSchema = z.object({
  workspaces: z.record(SessionEntrySchema),
});

/**
 * 会话存储：每个 workspace name 对应一份 SessionEntry。
 *
 * - 每次 set / clear 都立刻 flush，避免崩溃后丢上下文
 * - JsonStore 内部串行化写入，多次 set 不会乱序
 */
export class SessionStore {
  private readonly store: JsonStore<SessionFile>;
  private state: SessionFile = { workspaces: {} };

  constructor(filePath: string) {
    this.store = new JsonStore<SessionFile>(
      filePath,
      { workspaces: {} },
      (raw) => SessionFileSchema.parse(raw),
    );
  }

  async init(): Promise<void> {
    this.state = await this.store.readOrInit();
  }

  get(workspaceId: string): SessionEntry | undefined {
    return this.state.workspaces[workspaceId];
  }

  async set(workspaceId: string, entry: SessionEntry): Promise<void> {
    this.state.workspaces[workspaceId] = entry;
    await this.store.write(this.state);
  }

  async clear(workspaceId: string): Promise<void> {
    delete this.state.workspaces[workspaceId];
    await this.store.write(this.state);
  }
}
