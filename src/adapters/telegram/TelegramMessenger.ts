import { InputFile } from "grammy";
import { createBot, type GrammyBot } from "./grammyClient.js";
import type { IMessenger } from "../../core/messenger/IMessenger.js";
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  MessageHandle,
  ImagePayload,
  FilePayload,
  SendOptions,
} from "../../core/messenger/types.js";
import { logger } from "../../logger.js";

export interface TelegramMessengerConfig {
  botToken: string;
  parseMode: "HTML" | "Markdown" | "plain";
  // 适配器层也做一道白名单，避免 emit 事件之前就泄漏给业务层
  allowedUserIds?: number[];
}

/**
 * grammy 实现 IMessenger。
 * - long-polling：bot.start() 是常驻任务，整个进程启动后只调一次
 * - 图片接收：取最大尺寸，下载后转 base64 emit 给业务层
 * - editText 容错：Telegram 对"内容未变化"的编辑会抛错，吞掉
 */
export class TelegramMessenger implements IMessenger {
  private bot?: GrammyBot;
  private textListeners: Array<(m: IncomingTextMessage) => void> = [];
  private imageListeners: Array<(m: IncomingImageMessage) => void> = [];

  constructor(private readonly cfg: TelegramMessengerConfig) {}

  async start(): Promise<void> {
    const bot = createBot(this.cfg.botToken);
    this.bot = bot;

    bot.on("message:text", (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (
        this.cfg.allowedUserIds &&
        !this.cfg.allowedUserIds.includes(userId)
      ) {
        return;
      }
      const chatId = String(ctx.chat.id);
      const text = ctx.message.text;
      for (const l of this.textListeners) {
        l({ chatId, userId, username: ctx.from?.username, text });
      }
    });

    bot.on("message:photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      if (
        this.cfg.allowedUserIds &&
        !this.cfg.allowedUserIds.includes(userId)
      ) {
        return;
      }
      const chatId = String(ctx.chat.id);
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;
      try {
        const file = await ctx.api.getFile(largest.file_id);
        // Telegram getFile 返回的 file_path 需自己拼下载 URL
        const url = `https://api.telegram.org/file/bot${this.cfg.botToken}/${file.file_path}`;
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        const mimeType = "image/jpeg";
        const data = buf.toString("base64");
        const caption = ctx.message.caption ?? undefined;
        for (const l of this.imageListeners) {
          l({
            chatId,
            userId,
            username: ctx.from?.username,
            data,
            mimeType,
            caption,
          });
        }
      } catch (e) {
        logger.error({ err: (e as Error).message }, "下载图片失败");
      }
    });

    // bot.start 是 long-polling 阻塞任务，这里不 await，让它后台跑
    bot.start({ drop_pending_updates: true }).catch((e) => {
      logger.error({ err: (e as Error).message }, "grammy 退出");
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = undefined;
    }
  }

  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "text" | "image", h: (m: never) => void): void {
    if (event === "text") {
      this.textListeners.push(h as (m: IncomingTextMessage) => void);
    } else {
      this.imageListeners.push(h as (m: IncomingImageMessage) => void);
    }
  }

  async sendText(
    chatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendMessage(Number(chatId), text, {
      parse_mode: this.toParseMode(opts?.parseMode ?? this.cfg.parseMode),
      reply_parameters: opts?.replyToMessageId
        ? { message_id: Number(opts.replyToMessageId) }
        : undefined,
    });
    return { messageId: String(r.message_id) };
  }

  async editText(
    chatId: string,
    messageId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    try {
      await this.requireBot().api.editMessageText(
        Number(chatId),
        Number(messageId),
        text,
        {
          parse_mode: this.toParseMode(opts?.parseMode ?? this.cfg.parseMode),
        },
      );
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Telegram 对内容相同的编辑会抛 400，这是设计行为，吞掉
      if (msg.includes("message is not modified")) return;
      throw e;
    }
  }

  async sendImage(
    chatId: string,
    image: ImagePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendPhoto(
      Number(chatId),
      new InputFile(image.data, image.filename),
      { caption, parse_mode: this.toParseMode(this.cfg.parseMode) },
    );
    return { messageId: String(r.message_id) };
  }

  async sendDocument(
    chatId: string,
    file: FilePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    const r = await this.requireBot().api.sendDocument(
      Number(chatId),
      new InputFile(file.data, file.filename),
      { caption, parse_mode: this.toParseMode(this.cfg.parseMode) },
    );
    return { messageId: String(r.message_id) };
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.requireBot().api.sendChatAction(Number(chatId), "typing");
  }

  private requireBot(): GrammyBot {
    if (!this.bot) throw new Error("TelegramMessenger 未启动");
    return this.bot;
  }

  private toParseMode(
    mode: "HTML" | "Markdown" | "plain",
  ): "HTML" | "MarkdownV2" | undefined {
    if (mode === "HTML") return "HTML";
    if (mode === "Markdown") return "MarkdownV2";
    return undefined;
  }
}
