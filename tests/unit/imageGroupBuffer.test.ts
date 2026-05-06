import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ImageGroupBuffer } from "../../src/adapters/telegram/ImageGroupBuffer.js";

describe("ImageGroupBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("无 groupId 单条立即触发", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push(undefined, "a");
    expect(fired).toEqual([["a"]]);
  });

  it("同 groupId 多条在 debounce 内只触发一次（按入队序）", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push("g1", "a");
    vi.advanceTimersByTime(100);
    buf.push("g1", "b");
    vi.advanceTimersByTime(100);
    buf.push("g1", "c");
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(199);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(fired).toEqual([["a", "b", "c"]]);
  });

  it("不同 groupId 互不干扰", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push("g1", "a");
    buf.push("g2", "x");
    vi.advanceTimersByTime(250);
    expect(fired.length).toBe(2);
    expect(fired).toContainEqual(["a"]);
    expect(fired).toContainEqual(["x"]);
  });

  it("dispose 清掉所有定时器，再来不会触发", () => {
    const fired: string[][] = [];
    const buf = new ImageGroupBuffer<string>(200, (xs) => fired.push(xs));
    buf.push("g1", "a");
    buf.dispose();
    vi.advanceTimersByTime(500);
    expect(fired).toEqual([]);
  });
});
