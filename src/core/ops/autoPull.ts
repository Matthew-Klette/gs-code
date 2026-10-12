import type { GtmApi } from '../api';
import type { Overlay } from '../mirror/model';
import { readState } from '../mirror/state';
import { AuthError } from '../types';
import { refreshMirror, type RefreshResult } from './sync';

/** One check is 2 requests, so 60 s uses ~3 of the 25 requests GTM allows per 100 s. */
export const DEFAULT_INTERVAL_SECONDS = 60;
export const MIN_INTERVAL_SECONDS = 15;
/** Failed checks back off exponentially up to this. */
export const MAX_BACKOFF_MS = 10 * 60_000;

export interface AutoPullOptions {
  readonly intervalMs: number;
  /** Serializes the check with other mirror operations (the extension's per-folder queue). */
  readonly exclusive?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Unsaved editor buffers at the moment of the check. */
  readonly overlay?: () => Overlay | undefined;
  readonly onResult?: (result: RefreshResult) => void;
  /** `fatal` errors (signed out) stop the loop; others are retried with backoff. */
  readonly onError?: (error: unknown, fatal: boolean) => void;
  readonly now?: () => number;
}

export function clampInterval(seconds: number | undefined): number {
  const value = Number.isFinite(seconds) ? (seconds as number) : DEFAULT_INTERVAL_SECONDS;
  return Math.max(MIN_INTERVAL_SECONDS, value) * 1000;
}

/** Keeps a mirror current: checks GTM on a timer, and on demand (window focus, folder opened). */
export class AutoPull {
  lastCheckedAt?: number;
  lastPulledAt?: number;
  lastError?: unknown;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private inFlight?: Promise<RefreshResult | undefined>;

  constructor(
    private readonly root: string,
    private readonly api: GtmApi,
    private options: AutoPullOptions,
  ) {}

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  setInterval(intervalMs: number): void {
    this.options = { ...this.options, intervalMs };
    if (this.running) this.schedule(this.nextDelay());
  }

  /** Check now unless a check finished within `maxAgeMs` (window focus, quick re-opens). */
  checkIfStale(maxAgeMs: number): Promise<RefreshResult | undefined> {
    if (this.lastCheckedAt !== undefined && this.now() - this.lastCheckedAt < maxAgeMs) return Promise.resolve(undefined);
    return this.check();
  }

  /** One check. Concurrent callers share the check already in flight. */
  check(force = false): Promise<RefreshResult | undefined> {
    this.inFlight ??= this.runCheck(force).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runCheck(force: boolean): Promise<RefreshResult | undefined> {
    const exclusive = this.options.exclusive ?? ((task) => task());
    try {
      const result = await exclusive(async () =>
        refreshMirror(this.root, this.api, await readState(this.root), { force, overlay: this.options.overlay?.() }),
      );
      this.failures = 0;
      this.lastError = undefined;
      this.lastCheckedAt = this.now();
      if (result.pulled) this.lastPulledAt = this.lastCheckedAt;
      this.options.onResult?.(result);
      return result;
    } catch (error: unknown) {
      this.failures++;
      this.lastError = error;
      const fatal = error instanceof AuthError;
      if (fatal) this.stop();
      this.options.onError?.(error, fatal);
      return undefined;
    }
  }

  private nextDelay(): number {
    if (this.failures === 0) return this.options.intervalMs;
    return Math.min(this.options.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.check().then(() => {
        if (this.running) this.schedule(this.nextDelay());
      });
    }, delayMs);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
