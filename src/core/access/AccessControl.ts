/**
 * 用户白名单：M1 阶段唯一的访问控制机制。
 * 不在 allowedUserIds 中的消息会在 messenger 层就被静默 drop。
 */
export class AccessControl {
  private readonly set: Set<number>;
  private readonly first?: number;

  constructor(allowedUserIds: number[]) {
    this.set = new Set(allowedUserIds);
    this.first = allowedUserIds[0];
  }

  isAllowed(userId: number): boolean {
    return this.set.has(userId);
  }

  // primary user：用于把 reminders 等服务端推送的消息发给"主用户"（默认白名单第一个）
  primaryUserId(): number | undefined {
    return this.first;
  }
}
