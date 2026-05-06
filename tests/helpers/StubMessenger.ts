import type { IMessenger } from "../../src/core/messenger/IMessenger.js";
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  IncomingImageGroup,
  MessageHandle,
  ImagePayload,
  FilePayload,
  SendOptions,
} from "../../src/core/messenger/types.js";

// StubMessenger 把所有调用记录到 calls 数组（M1 风格），方便单测断言。
type Call =
  | { kind: "sendText"; chatId: string; text: string; opts?: SendOptions }
  | {
      kind: "editText";
      chatId: string;
      messageId: string;
      text: string;
      opts?: SendOptions;
    }
  | {
      kind: "sendImage";
      chatId: string;
      caption?: string;
      mimeType: string;
      size: number;
    }
  | {
      kind: "sendDocument";
      chatId: string;
      caption?: string;
      filename: string;
      size: number;
    }
  | { kind: "sendTyping"; chatId: string };

export class StubMessenger implements IMessenger {
  // M1：所有调用按时序记录到 calls
  public calls: Call[] = [];

  // M2：按调用类型分桶记录，便于针对性断言
  public sentTexts: Array<{ chatId: string; text: string; opts?: SendOptions }> = [];
  public sentImages: Array<{ chatId: string; image: ImagePayload; caption?: string }> = [];
  public sentDocuments: Array<{ chatId: string; file: FilePayload; caption?: string }> = [];

  // M2：可注入的 hook，用于测试出错路径（例如重试 / 超过 maxRetries）
  public sendImageImpl?: (
    chatId: string,
    image: ImagePayload,
    caption?: string,
  ) => Promise<void>;
  public sendDocumentImpl?: (
    chatId: string,
    file: FilePayload,
    caption?: string,
  ) => Promise<void>;

  public textListeners: Array<(m: IncomingTextMessage) => void> = [];
  public imageListeners: Array<(m: IncomingImageMessage) => void> = [];
  public imageGroupListeners: Array<(m: IncomingImageGroup) => void> = [];

  private idCounter = 0;
  private nextId(): string {
    return `m-${++this.idCounter}`;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

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

  // 测试时手动触发 incoming
  emitText(m: IncomingTextMessage): void {
    for (const l of this.textListeners) l(m);
  }
  emitImage(m: IncomingImageMessage): void {
    for (const l of this.imageListeners) l(m);
  }
  emitImageGroup(m: IncomingImageGroup): void {
    for (const l of this.imageGroupListeners) l(m);
  }

  async sendText(
    chatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<MessageHandle> {
    this.calls.push({ kind: "sendText", chatId, text, opts });
    this.sentTexts.push({ chatId, text, opts });
    return { messageId: this.nextId() };
  }

  async editText(
    chatId: string,
    messageId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    this.calls.push({ kind: "editText", chatId, messageId, text, opts });
  }

  async sendImage(
    chatId: string,
    image: ImagePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    // hook 优先：测试可注入失败实现验证重试 / 失败路径
    if (this.sendImageImpl) await this.sendImageImpl(chatId, image, caption);
    this.calls.push({
      kind: "sendImage",
      chatId,
      caption,
      mimeType: image.mimeType,
      size: image.data.length,
    });
    this.sentImages.push({ chatId, image, caption });
    return { messageId: this.nextId() };
  }

  async sendDocument(
    chatId: string,
    file: FilePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    if (this.sendDocumentImpl) await this.sendDocumentImpl(chatId, file, caption);
    this.calls.push({
      kind: "sendDocument",
      chatId,
      caption,
      filename: file.filename,
      size: file.data.length,
    });
    this.sentDocuments.push({ chatId, file, caption });
    return { messageId: this.nextId() };
  }

  async sendTyping(chatId: string): Promise<void> {
    this.calls.push({ kind: "sendTyping", chatId });
  }
}
