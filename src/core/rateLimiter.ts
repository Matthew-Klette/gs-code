/**
 * Sliding-window limiter for the GTM API quota: 0.25 QPS per project,
 * measured over a 100 second window, i.e. 25 requests per 100 s.
 * https://developers.google.com/tag-platform/tag-manager/api/v2/limits-quotas
 */

export const GTM_WINDOW_MS = 100_000;
export const GTM_REQUESTS_PER_WINDOW = 25;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type WaitListener = (waitMs: number) => void;

/** Lets separate processes (each CLI run) share one request history. */
export interface StampStore {
  load(): readonly number[];
  save(stamps: readonly number[]): void;
}

export class RateLimiter {
  private stamps: readonly number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number = GTM_REQUESTS_PER_WINDOW,
    private readonly windowMs: number = GTM_WINDOW_MS,
    private readonly clock: Clock = systemClock,
    private readonly onWait?: WaitListener,
    private readonly store?: StampStore,
  ) {}

  /** Resolves when a request may be sent. Calls are serialized in FIFO order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Requests counted in the current window (for status display). */
  inWindow(): number {
    const cutoff = this.clock.now() - this.windowMs;
    return this.stamps.filter((stamp) => stamp > cutoff).length;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const cutoff = now - this.windowMs;
      // The store holds every stamp this process saved plus other runs' stamps; no merge needed.
      const known = this.store ? [...this.store.load()].sort((a, b) => a - b) : this.stamps;
      this.stamps = known.filter((stamp) => stamp > cutoff);
      if (this.stamps.length < this.limit) {
        this.stamps = [...this.stamps, now];
        this.store?.save(this.stamps);
        return;
      }
      const oldest = this.stamps[0] ?? now;
      const waitMs = oldest + this.windowMs - now + 1;
      this.onWait?.(waitMs);
      await this.clock.sleep(waitMs);
    }
  }
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 60_000 };

export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  return Math.min(exponential, policy.maxDelayMs);
}
