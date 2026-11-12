/**
 * Tracks in-flight tool calls and pending stdout writes so that a stdin EOF
 * waits for the last response to be flushed instead of dropping it.
 */
class ToolRuntime {
  #inflight = 0;
  #writes = 0;

  enter(): void {
    this.#inflight += 1;
  }

  leave(): void {
    this.#inflight = Math.max(0, this.#inflight - 1);
  }

  trackWrite(): void {
    this.#writes += 1;
  }

  finishWrite(): void {
    this.#writes = Math.max(0, this.#writes - 1);
  }

  get busy(): boolean {
    return this.#inflight > 0 || this.#writes > 0;
  }

  /**
   * Wait until no tool is running and stdout has flushed. The extra quiet
   * window covers the gap between a handler returning and the SDK queuing the
   * response write.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.busy) {
        await sleep(20);
        if (!this.busy) return;
        continue;
      }
      await sleep(10);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const toolRuntime = new ToolRuntime();
