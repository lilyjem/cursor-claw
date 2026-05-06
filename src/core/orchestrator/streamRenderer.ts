import type { IMessenger } from "../messenger/IMessenger.js";
import { markdownToHtml } from "../render/markdownToHtml.js";

export interface StreamRendererOptions {
  // 编辑节流间隔：连续 pushText 时合并到一次 editMessageText 请求
  throttleMs: number;
  // 单条主消息最大字符数（按 raw markdown 长度算；
  // HTML 转换后会增长，外部装配传保守值留余量，例如 3000）
  maxLen: number;
}

/**
 * 在一条主消息上滚动渲染 assistant text + 状态行。
 * 超过 maxLen 自动开新消息。
 *
 * 渲染契约（M2 polish）：
 * - textBuffer 存 agent 原始 markdown（raw），不预先 escape / 不预先转换
 * - status / finalizeExtra 是已经 HTML 化的字符串（来自我们自己的代码，不来自 agent）
 * - compose() 时只对 textBuffer 段调一次 markdownToHtml(textBuffer)，
 *   整体转换避免跨 chunk 切分丢失闭合标记
 *
 * 设计要点：
 * - editMessageText 在 Telegram 有 RPS 限制，所以用节流；连续小 chunk 合并
 * - 长消息切分用 rotate()：finalize 当前主消息（去状态行）→ 发新 placeholder → 新内容写入新消息
 * - 状态行变更也会触发节流刷新（用同一 timer，避免抖动）
 * - markdownToHtml 兜底：极端输入挂掉时 fallback 到 escapeHtml，
 *   宁可丢渲染也不能让 streaming 整体中断
 */
export class StreamRenderer {
  private currentMsgId?: string;
  private status: string = "";
  // 注意：raw markdown，不是 HTML
  private textBuffer: string = "";
  // finalize 时附加的 HTML 末尾（如 "(已取消)" / 错误提示），不进 markdownToHtml
  private finalizeExtra: string = "";
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
    // maxLen 按 raw 长度判断；HTML 转换后会增长，外部传保守值留余量
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
    if (extra) this.finalizeExtra += extra;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    // finalize 总要确保最终状态写到 messenger 上：
    // 即使 dirty=false（例如 cancel 路径下没 pushText），也强制 flush 一次，
    // 把状态行清掉 / 把 extra 追加上去
    this.dirty = true;
    await this.flushNow();
  }

  // 把当前 status / textBuffer / finalizeExtra 拼成一段消息体
  // 关键：textBuffer 段做整体 markdownToHtml；status / finalizeExtra 是 HTML 直接拼
  private compose(): string {
    const lines: string[] = [];
    if (this.status) {
      lines.push(this.status, "");
    }
    if (this.textBuffer) {
      lines.push(this.renderTextBufferSafely());
    }
    if (this.finalizeExtra) {
      lines.push(this.finalizeExtra);
    }
    if (lines.length === 0) lines.push("⏳");
    return lines.join("\n");
  }

  // markdownToHtml 整体转换 textBuffer；万一抛错降级为 escapeHtml 兜底
  private renderTextBufferSafely(): string {
    try {
      return markdownToHtml(this.textBuffer);
    } catch {
      return escapeHtmlFallback(this.textBuffer);
    }
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

  // 切到新主消息：textBuffer / finalizeExtra 清空 → 发 placeholder 拿新 messageId
  private async rotate(): Promise<void> {
    this.textBuffer = "";
    this.finalizeExtra = "";
    this.dirty = false;
    const handle = await this.messenger.sendText(this.chatId, "⏳ continuing...");
    this.currentMsgId = handle.messageId;
    // 切完之后状态行可能仍要渲染，标 dirty 让下次 push 触发刷新
    this.dirty = true;
  }
}

// markdownToHtml 兜底专用 escape；正常路径不走这里
function escapeHtmlFallback(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
