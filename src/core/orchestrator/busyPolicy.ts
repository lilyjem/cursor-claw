// 忙状态决策的纯函数：不持有任何状态，方便单测且能复用到 reminders 触发的运行。

export type BusyAction = "run" | "reject" | "force-replace";
export type RunStatus = "running" | "finished" | "error" | "cancelled";

/**
 * 把以 "!" 开头的文本剥成 { force: true, text }。
 * 用于让用户能用 !fix this 强制打断当前 run 而不是先 /cancel 再发。
 */
export function parseForcePrefix(text: string): { force: boolean; text: string } {
  if (text.startsWith("!")) {
    return { force: true, text: text.slice(1) };
  }
  return { force: false, text };
}

/**
 * 根据当前活跃 run 状态 + force 标志，决定怎么处理新 prompt：
 * - 没活跃 run / 已结束 → 直接 run
 * - 活跃但非 force → reject（提示用户 /cancel 或 ! 强制）
 * - 活跃且 force → force-replace（SDK send 时传 force=true 打断旧 run）
 */
export function decideBusyAction(input: {
  activeRunStatus: RunStatus | undefined;
  force: boolean;
}): BusyAction {
  if (!input.activeRunStatus || input.activeRunStatus !== "running") return "run";
  return input.force ? "force-replace" : "reject";
}
