// F-06：reminder 数量上限错误类型
// 用 typed error 让 handler 能明确取出 used/cap 生成中文用户提示。

export class ReminderQuotaExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(`reminders quota: ${used}/${cap}`);
    this.name = "ReminderQuotaExceededError";
  }
}
