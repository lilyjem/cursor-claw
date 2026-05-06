// F-05 修复：把图片下载逻辑从 TelegramMessenger 内联 IIFE 抽出来，
// 让 maxFileSizeBytes 在每个层面被强制：
//   1. file_size 预检查：getFile 返回的 file_size 超 cap 即拒绝（不发起 fetch）
//   2. content-length 复核：fetch 响应头 content-length 超 cap 即拒绝（防 server 谎报 file_size）
//   3. 流式累计：响应体边读边累计字节数，超 cap 即 cancel 流并抛错（防无 content-length 时下载到一半才知道）
// F-01 联动：捕获 fetch 错误时统一构造无 url / token 的错误信息，避免 botToken 通过 error.message 泄露到 logger 或 Telegram 用户端。

// 抽象 grammy 的 api.getFile 用最小契约接口，方便单测 stub
export interface GetFileApi {
  getFile(
    fileId: string,
  ): Promise<{ file_id: string; file_path?: string; file_size?: number }>;
}

export interface DownloadOptions {
  api: GetFileApi;
  fileId: string;
  botToken: string;
  maxFileSizeBytes: number;
}

// 返回 base64 编码后的文件内容，与原 IIFE 兼容（buf.toString("base64")）
export async function downloadTelegramFile(
  opts: DownloadOptions,
): Promise<string> {
  const { api, fileId, botToken, maxFileSizeBytes } = opts;

  // 第 1 道闸：getFile 预检查 file_size
  const file = await api.getFile(fileId);
  if (file.file_size && file.file_size > maxFileSizeBytes) {
    throw new Error(
      `file_size ${file.file_size} 超过上限 ${maxFileSizeBytes}（file_id=${fileId}）`,
    );
  }
  if (!file.file_path) {
    throw new Error(`file_path 缺失（file_id=${fileId}）`);
  }

  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // F-01：fetch 失败时不要把含 url/token 的原始 message 透出去；统一构造无敏感信息的描述
    throw new Error(`Telegram 文件下载请求失败 (file_id=${fileId})`);
  }

  // 第 2 道闸：content-length 复核
  const cl = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(cl) && cl > maxFileSizeBytes) {
    // 主动 cancel response body，避免 socket 被持有
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(
      `content-length ${cl} 超过上限 ${maxFileSizeBytes}（file_id=${fileId}）`,
    );
  }

  if (!res.body) {
    throw new Error(`响应体为空 (file_id=${fileId})`);
  }

  // 第 3 道闸：流式累计，边读边检查；不预分配 Buffer，避免 server 谎报触发分配
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxFileSizeBytes) {
        // 主动 cancel 中断剩余数据；某些实现要求 release 后才能 cancel
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(
          `下载累计 size ${total} 超过上限 ${maxFileSizeBytes}（file_id=${fileId}）`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已 cancel / 已 done 的 reader 再 release 会抛 */
    }
  }

  return Buffer.concat(chunks).toString("base64");
}
