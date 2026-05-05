import { JsonStore } from "../persist/jsonStore.js";

// 工作区元数据：name 是 SDK agentId 的"逻辑标签"，path 是实际 cwd。
export interface Workspace {
  name: string;
  path: string;
}

interface RegistryFile {
  active?: string;
  items: Record<string, Workspace>;
}

export class WorkspaceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WorkspaceError";
  }
}

/**
 * 工作区注册表：维护 name→Workspace 的映射 + 当前活跃工作区。
 *
 * - 不真正切换 process.cwd（agent SDK 用每个 workspace 独立的 cwd 参数即可）
 * - 写盘是显式 persist，避免高频 add/use 都触发文件 IO；命令 handler 在变更后调一次
 * - 自动注册 cwd 为 default：仅在没有任何 active 时触发，避免覆盖用户已有配置
 */
export class WorkspaceRegistry {
  private readonly store: JsonStore<RegistryFile>;
  private state: RegistryFile = { items: {} };

  constructor(filePath: string) {
    this.store = new JsonStore<RegistryFile>(filePath, { items: {} });
  }

  async init(opts: { autoRegisterCwd: boolean; cwd: string }): Promise<void> {
    this.state = await this.store.readOrInit();
    if (opts.autoRegisterCwd && !this.state.active) {
      this.state.items["default"] = { name: "default", path: opts.cwd };
      this.state.active = "default";
      await this.persist();
    }
  }

  add(name: string, path: string): void {
    if (this.state.items[name]) {
      throw new WorkspaceError(`workspace already exists: ${name}`);
    }
    this.state.items[name] = { name, path };
  }

  remove(name: string): void {
    if (!this.state.items[name]) {
      throw new WorkspaceError(`workspace not found: ${name}`);
    }
    if (this.state.active === name) {
      throw new WorkspaceError(`cannot remove active workspace: ${name}`);
    }
    delete this.state.items[name];
  }

  use(name: string): void {
    if (!this.state.items[name]) {
      throw new WorkspaceError(`workspace not found: ${name}`);
    }
    this.state.active = name;
  }

  getActive(): Workspace | undefined {
    return this.state.active ? this.state.items[this.state.active] : undefined;
  }

  get(name: string): Workspace | undefined {
    return this.state.items[name];
  }

  list(): Workspace[] {
    return Object.values(this.state.items);
  }

  async persist(): Promise<void> {
    await this.store.write(this.state);
  }
}
