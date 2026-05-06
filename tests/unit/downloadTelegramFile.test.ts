import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { downloadTelegramFile } from "../../src/adapters/telegram/downloadFile.js";

// 测试 F-05 修复：图片下载强制 maxFileSizeBytes
//
// 三个核心 case：
// 1. file_size pre-check：getFile 返回的 file_size 超 cap → 抛错（不发起 fetch）
// 2. content-length 复核：fetch 响应 header content-length 超 cap → 抛错（防 server 谎报 file_size）
// 3. 流式累计：响应没有 content-length 但实际流数据超 cap → 累计到 cap 时抛错并 cancel

describe("downloadTelegramFile · F-05 size cap", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 工具：构造一个返回特定 ReadableStream + 可选 content-length 的 fetch mock
  function makeFetchMock(opts: {
    chunks: Uint8Array[];
    contentLength?: number;
  }): typeof fetch {
    return vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of opts.chunks) controller.enqueue(c);
          controller.close();
        },
      });
      const headers = new Headers();
      if (opts.contentLength !== undefined) {
        headers.set("content-length", String(opts.contentLength));
      }
      return new Response(stream, { headers });
    }) as unknown as typeof fetch;
  }

  // 工具：构造一个伪 grammy api.getFile 返回值
  function makeApi(
    file: { file_path?: string; file_size?: number },
  ): { getFile: (id: string) => Promise<typeof file & { file_id: string }> } {
    return {
      getFile: vi.fn(async (id: string) => ({ file_id: id, ...file })),
    };
  }

  it("Case 1：getFile 返回的 file_size 超 cap → 抛错且不调 fetch", async () => {
    const api = makeApi({ file_path: "doc/abc.jpg", file_size: 5_000_001 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadTelegramFile({
        api,
        fileId: "f1",
        botToken: "12345:fake",
        maxFileSizeBytes: 5_000_000,
      }),
    ).rejects.toThrow(/file_size/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Case 2：响应头 content-length 超 cap → 抛错（即使 file_size 未提供）", async () => {
    const api = makeApi({ file_path: "doc/abc.jpg" }); // 故意不提供 file_size
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chunks: [new Uint8Array(1024)],
        contentLength: 5_000_001,
      }),
    );

    await expect(
      downloadTelegramFile({
        api,
        fileId: "f1",
        botToken: "12345:fake",
        maxFileSizeBytes: 5_000_000,
      }),
    ).rejects.toThrow(/content-length/);
  });

  it("Case 3：响应无 content-length，但实际流超 cap → 累计到 cap 时抛错", async () => {
    const api = makeApi({ file_path: "doc/abc.jpg" });
    // 4 个 chunk 各 2 MB，总 8 MB，cap 5 MB → 第 3 个 chunk（累计 6 MB）应抛错
    const chunk = new Uint8Array(2 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        chunks: [chunk, chunk, chunk, chunk],
        // 故意不传 contentLength
      }),
    );

    await expect(
      downloadTelegramFile({
        api,
        fileId: "f1",
        botToken: "12345:fake",
        maxFileSizeBytes: 5 * 1024 * 1024,
      }),
    ).rejects.toThrow(/(size|cap|exceed)/i);
  });

  it("Case 4：正常路径（小文件）能完整返回 base64", async () => {
    const api = makeApi({ file_path: "doc/abc.jpg", file_size: 11 });
    // 写入 "hello world" 11 字节
    const data = new TextEncoder().encode("hello world");
    vi.stubGlobal(
      "fetch",
      makeFetchMock({ chunks: [data], contentLength: 11 }),
    );

    const result = await downloadTelegramFile({
      api,
      fileId: "f1",
      botToken: "12345:fake",
      maxFileSizeBytes: 1024,
    });

    expect(typeof result).toBe("string");
    // base64("hello world") = "aGVsbG8gd29ybGQ="
    expect(result).toBe("aGVsbG8gd29ybGQ=");
  });

  it("Case 5：fetch 失败时抛出的错误不含 botToken 或完整 URL（F-01 联动）", async () => {
    const api = makeApi({ file_path: "doc/abc.jpg", file_size: 100 });
    const failingFetch = vi.fn(async () => {
      throw new Error(
        "request to https://api.telegram.org/file/bot12345:SECRET/doc/abc.jpg failed",
      );
    });
    vi.stubGlobal("fetch", failingFetch);

    let caught: Error | undefined;
    try {
      await downloadTelegramFile({
        api,
        fileId: "f1",
        botToken: "12345:SECRET",
        maxFileSizeBytes: 1024,
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain("12345:SECRET");
    expect(caught!.message).not.toMatch(/bot[\w:]+/);
  });
});
