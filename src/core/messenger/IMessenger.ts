import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  MessageHandle,
  SendOptions,
  ImagePayload,
  FilePayload,
} from "./types.js";

/**
 * 消息平台中立接口：
 * - 上行：on("text"|"image"|"imageGroup", handler)
 * - 下行：sendText / editText / sendImage / sendDocument / sendTyping
 *
 * 微信 / Telegram / 任意 IM 都通过实现此接口接入；AgentOrchestrator 不感知具体平台。
 *
 * 关于 image vs imageGroup：
 * - "image"：M1 接口，单图触发；M2 之后保留向后兼容，但 TelegramMessenger 不再 emit
 * - "imageGroup"：M2 新增，可承载 1..N 张图（含 album）；caption 首张非空
 */
export interface IMessenger {
  start(): Promise<void>;
  stop(): Promise<void>;

  on(event: "text", h: (msg: IncomingTextMessage) => void): void;
  on(event: "image", h: (msg: IncomingImageMessage) => void): void;
  on(event: "imageGroup", h: (msg: IncomingImageGroup) => void): void;

  sendText(chatId: string, text: string, opts?: SendOptions): Promise<MessageHandle>;
  editText(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<void>;
  sendImage(chatId: string, image: ImagePayload, caption?: string): Promise<MessageHandle>;
  sendDocument(chatId: string, file: FilePayload, caption?: string): Promise<MessageHandle>;

  sendTyping(chatId: string): Promise<void>;
}
