// 消息接收/发送的中立类型，所有 IMessenger 实现共用。

export interface IncomingTextMessage {
  chatId: string;
  userId: number;
  username?: string;
  text: string;
}

export interface IncomingImageMessage {
  chatId: string;
  userId: number;
  username?: string;
  data: string;
  mimeType: string;
  caption?: string;
}

export interface SendOptions {
  // 单条消息级 parseMode 优先于 messenger 全局默认
  parseMode?: "HTML" | "Markdown" | "plain";
  replyToMessageId?: string;
}

export interface MessageHandle {
  messageId: string;
}

export interface ImagePayload {
  data: Buffer;
  mimeType: string;
  filename?: string;
}

export interface FilePayload {
  data: Buffer;
  mimeType?: string;
  filename: string;
}
