import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../src/util/html.js";

describe("escapeHtml", () => {
  it("escape HTML-significant chars", () => {
    expect(escapeHtml(`<b>x</b> & y`)).toBe("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});
