import type { IMessenger } from "../messenger/IMessenger.js";

export interface StreamRendererOptions {
  // 编辑节流间隔：连续 pushText 时合并到一次 editMessageText 请求
  throttleMs: number;
  // 单条主消息最大字符数：超过则发送新消息继续追加
  maxLen: number;
}

/**
 * 在一条主消息上滚动渲染 assistant text + 状态行。
 * 超过 maxLen 自动开新消息。
 *
 * 渲染格式：
 *   [状态行（可选）]
 *
 *   <textBuffer>
 *
 * 设计要点：
 * - editMessageText 在 Telegram 有 RPS 限制，所以用节流；连续小 chunk 合并
 * - 长消息切分用 rotate()：finalize 当前主消息（去状态行）→ 发新 placeholder → 新内容写入新消息
 * - 状态行变更也会触发节流刷新（用同一 timer，避免抖动）
 */
export class StreamRenderer {
  private currentMsgId?: string;
  private status: string = "";
  private textBuffer: string = "";
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private finalized = false;

  constructor(
    private readonly messenger: IMessenger,
    private readonly chatId: string,
    private readonly opts: StreamRendererOptions,
  ) {}

  async start(initialPlaceholder: string): Promise<void> {
    this.status = initialPlaceholder;
    const handle = await this.messenger.sendText(this.chatId, this.compose());
    this.currentMsgId = handle.messageId;
  }

  setStatus(line: string): void {
    this.status = line;
    this.dirty = true;
    this.scheduleFlush();
  }

  async pushText(chunk: string): Promise<void> {
    // textBuffer 加上 chunk 超长 → 切两段：head 入当前消息后立即 flush + rotate；rest 递归
    if (this.textBuffer.length + chunk.length > this.opts.maxLen) {
      const remaining = Math.max(0, this.opts.maxLen - this.textBuffer.length);
      const head = chunk.slice(0, remaining);
      const rest = chunk.slice(remaining);
      this.textBuffer += head;
      this.dirty = true;
      await this.flushNow();
      await this.rotate();
      if (rest.length > 0) {
        await this.pushText(rest);
      }
      return;
    }
    this.textBuffer += chunk;
    this.dirty = true;
    this.scheduleFlush();
  }

  async finalize(extra?: string): Promise<void> {
    this.finalized = true;
    this.status = "";
    if (extra) this.textBuffer += extra;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // finalize 总要确保最终状态写到 messenger 上：
    // 即使 dirty=false（例如 cancel 路径下没 pushText），也强制 flush 一次，
    // 把状态行清掉 / 把 extra 追加上去
    this.dirty = true;
    await this.flushNow();
  }

  // 把当前 status / textBuffer 拼成一段消息体
  private compose(): string {
    const lines: string[] = [];
    if (this.status) {
      lines.push(this.status, "");
    }
    if (this.textBuffer) lines.push(this.textBuffer);
    if (lines.length === 0) lines.push("⏳");
    return lines.join("\n");
  }

  // 把 dirty 状态在 throttle 间隔后写出去
  private scheduleFlush(): void {
    if (this.finalized) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushNow();
    }, this.opts.throttleMs);
  }

  // 立即 flush（绕过 throttle）：在 finalize 和 rotate 时调用
  private async flushNow(): Promise<void> {
    if (!this.dirty || !this.currentMsgId) return;
    this.dirty = false;
    await this.messenger.editText(this.chatId, this.currentMsgId, this.compose());
  }

  // 切到新主消息：textBuffer 清空 → 发 placeholder 拿新 messageId
  private async rotate(): Promise<void> {
    this.textBuffer = "";
    this.dirty = false;
    const handle = await this.messenger.sendText(this.chatId, "⏳ continuing...");
    this.currentMsgId = handle.messageId;
    // 切完之后状态行可能仍要渲染，标 dirty 让下次 push 触发刷新
    this.dirty = true;
  }
}
