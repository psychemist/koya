/**
 * The streaming-input channel into a live Agent SDK session: one user message
 * per turn is pushed, and the SDK pulls. A push wakes a waiting reader or is
 * buffered; end() finishes every reader once the buffer is drained.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const w = this.waiting.shift();
    if (w) w({ value, done: false }); else this.buffer.push(value);
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((r) => this.waiting.push(r));
      },
    };
  }
}
