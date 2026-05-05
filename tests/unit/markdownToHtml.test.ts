import { describe, it, expect } from "vitest";
import { markdownToHtml } from "../../src/core/render/markdownToHtml.js";

describe("markdownToHtml", () => {
  it("转义 < > &", () => {
    expect(markdownToHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("行内代码 → <code>", () => {
    expect(markdownToHtml("foo `bar` baz")).toBe("foo <code>bar</code> baz");
  });

  it("粗体 → <b>", () => {
    expect(markdownToHtml("a **bold** b")).toBe("a <b>bold</b> b");
  });

  it("斜体（_..._）→ <i>", () => {
    expect(markdownToHtml("a _it_ b")).toBe("a <i>it</i> b");
  });

  it("代码块 ``` ... ``` → <pre><code>", () => {
    const md = "before\n```\nlet a = 1;\n```\nafter";
    const html = markdownToHtml(md);
    expect(html).toContain("<pre><code>let a = 1;\n</code></pre>");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("代码块内的 < > & 必须转义", () => {
    const md = "```\n<x> & </x>\n```";
    expect(markdownToHtml(md)).toContain(
      "<pre><code>&lt;x&gt; &amp; &lt;/x&gt;\n</code></pre>",
    );
  });

  it("链接 [text](url) → <a>", () => {
    expect(markdownToHtml("[hi](https://example.com)")).toBe(
      '<a href="https://example.com">hi</a>',
    );
  });

  it("空字符串", () => {
    expect(markdownToHtml("")).toBe("");
  });
});
