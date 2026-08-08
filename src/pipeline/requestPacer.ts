export class RequestPacer {
  private nextSlot = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly delayMs: number) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error("Request pacing delay must be a non-negative number");
    }
  }

  wait(): Promise<void> {
    const slot = this.nextSlot.then(async () => {
      const remaining = this.delayMs - (Date.now() - this.lastRequestAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      this.lastRequestAt = Date.now();
    });
    this.nextSlot = slot.catch(() => undefined);
    return slot;
  }
}
