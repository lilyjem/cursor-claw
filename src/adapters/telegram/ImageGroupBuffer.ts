// 把 Telegram media_group 的"多条 message 同 group_id 在短时间内陆续到达"
// 这种异步事件流抽象成"按 groupId 聚合 + 防抖触发"的纯逻辑。
//
// 用法：
//   const buf = new ImageGroupBuffer<MyItem>(200, (items) => emit(items));
//   buf.push(msg.media_group_id, myItem);   // groupId 可为 undefined
//
// 当 groupId 为 undefined 时立即触发（单图快路径）。
//
// 当 groupId 存在时：
//   - 第一次见到该 groupId：建桶 + 启 debounce timer
//   - 之后每次 push 都重置 timer（"最后一次到达后 debounceMs 才触发"）
//   - timer 触发时一次性 fire 整个桶并清掉

export class ImageGroupBuffer<T> {
  // groupId → { 待 fire 的项数组, 当前 debounce timer }
  private buckets = new Map<
    string,
    { items: T[]; timer: ReturnType<typeof setTimeout> }
  >();
  private disposed = false;

  constructor(
    private readonly debounceMs: number,
    private readonly fire: (items: T[]) => void,
  ) {}

  // 入队一条新消息；groupId 为空走单条快路径，立即触发
  push(groupId: string | undefined, item: T): void {
    if (this.disposed) return;
    if (!groupId) {
      // 单图快路径：不进 bucket，直接触发
      this.fire([item]);
      return;
    }
    const bucket = this.buckets.get(groupId);
    if (bucket) {
      // 已存在的桶：刷新 debounce timer，把新元素拼上
      clearTimeout(bucket.timer);
      bucket.items.push(item);
      bucket.timer = setTimeout(() => this.flush(groupId), this.debounceMs);
    } else {
      // 第一次见到：建桶，初始化 timer
      const timer = setTimeout(() => this.flush(groupId), this.debounceMs);
      this.buckets.set(groupId, { items: [item], timer });
    }
  }

  // dispose：取消所有未触发的 timer，避免进程退出时仍有定时回调
  dispose(): void {
    this.disposed = true;
    for (const b of this.buckets.values()) clearTimeout(b.timer);
    this.buckets.clear();
  }

  // 内部触发：把指定桶的内容一次性 fire 出去并清掉桶
  private flush(groupId: string): void {
    const bucket = this.buckets.get(groupId);
    if (!bucket) return;
    this.buckets.delete(groupId);
    this.fire(bucket.items);
  }
}
