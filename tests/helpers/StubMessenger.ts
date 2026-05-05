import type { IMessenger } from "../../src/core/messenger/IMessenger.js";
import type {
  IncomingTextMessage,
  IncomingImageMessage,
  MessageHandle,
  ImagePayload,
  FilePayload,
  SendOptions,
} from "../../src/core/messenger/types.js";

// StubMessenger 把所有调用记录到 calls 数组，方便单测断言。
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
  public calls: Call[] = [];
  public textListeners: Array<(m: IncomingTextMessage) => void> = [];
  public imageListeners: Array<(m: IncomingImageMessage) => void> = [];

  private idCounter = 0;
  private nextId(): string {
    return `m-${++this.idCounter}`;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  on(event: "text", h: (m: IncomingTextMessage) => void): void;
  on(event: "image", h: (m: IncomingImageMessage) => void): void;
  on(event: "text" | "image", h: (m: never) => void): void {
    if (event === "text") this.textListeners.push(h as (m: IncomingTextMessage) => void);
    else this.imageListeners.push(h as (m: IncomingImageMessage) => void);
  }

  // 测试时手动触发 incoming
  emitText(m: IncomingTextMessage): void {
    for (const l of this.textListeners) l(m);
  }
  emitImage(m: IncomingImageMessage): void {
    for (const l of this.imageListeners) l(m);
  }

  async sendText(
    chatId: string,
    text: string,
    opts?: SendOptions,
  ): Promise<MessageHandle> {
    this.calls.push({ kind: "sendText", chatId, text, opts });
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
    this.calls.push({
      kind: "sendImage",
      chatId,
      caption,
      mimeType: image.mimeType,
      size: image.data.length,
    });
    return { messageId: this.nextId() };
  }

  async sendDocument(
    chatId: string,
    file: FilePayload,
    caption?: string,
  ): Promise<MessageHandle> {
    this.calls.push({
      kind: "sendDocument",
      chatId,
      caption,
      filename: file.filename,
      size: file.data.length,
    });
    return { messageId: this.nextId() };
  }

  async sendTyping(chatId: string): Promise<void> {
    this.calls.push({ kind: "sendTyping", chatId });
  }
}
