/** Discord silently drops Rich Presence updates faster than this. */
export const MIN_UPDATE_INTERVAL_MS = 15_000;

/**
 * Rate-limits calls to `send` to one per `minIntervalMs`, keeping only the
 * most recent submission. Submissions are never queued up: an older payload
 * is simply replaced, because only the newest state is worth showing.
 */
export class CoalescingDispatcher<T> {
  private pending: { value: T } | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly send: (value: T) => Promise<void>,
    private readonly minIntervalMs: number = MIN_UPDATE_INTERVAL_MS,
  ) {}

  submit(value: T): void {
    if (this.stopped) return;
    this.pending = { value };
    this.schedule();
  }

  /** Send any pending payload at once, ignoring the window. For shutdown. */
  async flushNow(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    // flush() returns immediately if a send was already in flight, so wait for
    // that one too: a shutdown that races an in-flight write can otherwise
    // land a stale presence AFTER the clear and then destroy the socket.
    await this.drain();
  }

  /** Resolve once no send is in flight. */
  async drain(): Promise<void> {
    while (this.inFlight !== null) {
      await this.inFlight;
    }
  }

  stop(): void {
    this.stopped = true;
    this.pending = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer !== null || this.sending || this.pending === null) return;
    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, waitMs);
    // Do not hold the event loop open purely to publish a presence update.
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.pending === null || this.sending) return;
    const { value } = this.pending;
    this.pending = null;
    this.sending = true;
    // Stamped before awaiting so a slow send does not shrink the next window.
    this.lastSentAt = Date.now();
    const inFlight = (async () => {
      try {
        await this.send(value);
      } catch {
        // The sink logs and reconnects; a dropped update is not fatal because
        // the next poll will resubmit current state.
      } finally {
        this.sending = false;
        this.inFlight = null;
        this.schedule();
      }
    })();
    this.inFlight = inFlight;
    await inFlight;
  }
}
