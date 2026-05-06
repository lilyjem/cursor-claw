import { InputFile } from "grammy";
import { createBot, type GrammyBot } from "./grammyClient.js";
import { ImageGroupBuffer } from "./ImageGroupBuffer.js";
import type { IMessenger } from "../../core/messenger/IMessenger.js";
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
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
  // M2: 媒体组 debounce 时间，太小会拆开 album，太大用户感知延迟
  mediaGroupDebounceMs?: number;
}

// ImageGroupBuffer 内部缓存的 photo 元数据（与 IncomingImageGroup 几乎重合，
// 但需要额外携带 chatId / userId / username 以便聚合后构造 group 事件）
interface PendingPhoto {
  data: string;
  mimeType: string;
  caption?: string;
  chatId: string;
  userId: number;
  username?: string;
}

/**
 * grammy 实现 IMessenger。
 * - long-polling：bot.start() 是常驻任务，整个进程启动后只调一次
 * - 图片接收（M2）：用 ImageGroupBuffer 把同 media_group_id 的多张图聚合成单次 imageGroup 事件；
 *   旧的单图 image 事件保留 listener 注册能力但不再 emit（迁移到 imageGroup）
 * - editText 容错：Telegram 对"内容未变化"的编辑会抛错，吞掉
 */
export class TelegramMessenger implements IMessenger {
  private bot?: GrammyBot;
  private textListeners: Array<(m: IncomingTextMessage) => void> = [];
  private imageListeners: Array<(m: IncomingImageMessage) => void> = [];
  private imageGroupListeners: Array<(m: IncomingImageGroup) => void> = [];
  private buffer?: ImageGroupBuffer<PendingPhoto>;

  constructor(private readonly cfg: TelegramMessengerConfig) {}

  async start(): Promise<void> {
    const bot = createBot(this.cfg.botToken);
    this.bot = bot;

    // M2: 用 ImageGroupBuffer 把同 media_group_id 的多张图聚合成一次 emit
    this.buffer = new ImageGroupBuffer<PendingPhoto>(
      this.cfg.mediaGroupDebounceMs ?? 200,
      (items) => {
        if (items.length === 0) return;
        // 用首张的 chatId / userId 作为整组的"主"标识；caption 取首条非空
        const first = items[0]!;
        const caption = items.map((i) => i.caption).find((c) => !!c);
        const group: IncomingImageGroup = {
          chatId: first.chatId,
          userId: first.userId,
          username: first.username,
          images: items.map((i) => ({ data: i.data, mimeType: i.mimeType })),
          caption,
        };
        for (const l of this.imageGroupListeners) l(group);
      },
    );

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
        const data = buf.toString("base64");
        const mimeType = "image/jpeg";
        const caption = ctx.message.caption ?? undefined;
        const item: PendingPhoto = {
          data,
          mimeType,
          caption,
          chatId,
          userId,
          username: ctx.from?.username,
        };
        // media_group_id 由 grammy 暴露在 ctx.message
        const groupId = ctx.message.media_group_id ?? undefined;
        this.buffer?.push(groupId, item);
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
    this.buffer?.dispose();
    this.buffer = undefined;
  }

  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "imageGroup", h: (m: IncomingImageGroup) => void): void;
  on(
    event: "text" | "image" | "imageGroup",
    h: (m: never) => void,
  ): void {
    if (event === "text") {
      this.textListeners.push(h as (m: IncomingTextMessage) => void);
    } else if (event === "image") {
      this.imageListeners.push(h as (m: IncomingImageMessage) => void);
    } else {
      this.imageGroupListeners.push(h as (m: IncomingImageGroup) => void);
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
