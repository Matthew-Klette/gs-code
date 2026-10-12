import type { GtmApi } from '../api';
import type { Overlay } from '../mirror/model';
import { MirrorBusyError } from '../mirror/lock';
import { readState } from '../mirror/state';
import { AuthError, DailyQuotaError, WorkspaceGoneError } from '../types';
import { refreshMirror, type RefreshResult } from './sync';

/** One check is 2 requests, so 60 s uses ~3 of the 25 requests GTM allows per 100 s. */
export const DEFAULT_INTERVAL_SECONDS = 60;
export const MIN_INTERVAL_SECONDS = 15;
/** Failed checks back off exponentially up to this. */
export const MAX_BACKOFF_MS = 10 * 60_000;
/** After this many checks in a row with nothing new, the interval starts stretching… */
export const IDLE_CHECKS_BEFORE_SLOWDOWN = 10;
/** …up to this multiple of the configured interval. Any change, focus or command resets it. */
export const MAX_IDLE_FACTOR = 4;
/** ±10% jitter, so many teammates' mirrors do not poll in lockstep on a shared quota. */
const JITTER = 0.1;

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

/** 1× for the first checks, then doubling every IDLE_CHECKS_BEFORE_SLOWDOWN idle checks, capped. */
export function idleFactor(idleChecks: number): number {
  return Math.min(MAX_IDLE_FACTOR, 2 ** Math.floor(idleChecks / IDLE_CHECKS_BEFORE_SLOWDOWN));
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
  private idleChecks = 0;
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

  /** The user is active (focus, edit, command): poll at the normal rate again. */
  wake(): void {
    this.idleChecks = 0;
  }

  /** Check now unless a check finished within `maxAgeMs` (window focus, quick re-opens). */
  checkIfStale(maxAgeMs: number): Promise<RefreshResult | undefined> {
    this.wake();
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
        // Never wait on another process: if the CLI or an agent is mid-push, check again next round.
        refreshMirror(this.root, this.api, await readState(this.root), { force, overlay: this.options.overlay?.(), lockWaitMs: 0 }),
      );
      this.failures = 0;
      this.lastError = undefined;
      this.lastCheckedAt = this.now();
      if (result.pulled) this.lastPulledAt = this.lastCheckedAt;
      this.idleChecks = result.pulled ? 0 : this.idleChecks + 1;
      this.options.onResult?.(result);
      return result;
    } catch (error: unknown) {
      if (error instanceof MirrorBusyError) return undefined;
      this.failures++;
      this.lastError = error;
      // Signed out, or the workspace is gone: retrying cannot help until the user acts.
      const fatal = error instanceof AuthError || error instanceof WorkspaceGoneError || error instanceof DailyQuotaError;
      if (fatal) this.stop();
      this.options.onError?.(error, fatal);
      return undefined;
    }
  }

  nextDelay(random = Math.random): number {
    const base = this.failures > 0
      ? Math.min(this.options.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS)
      : this.options.intervalMs * idleFactor(this.idleChecks);
    return Math.round(base * (1 + (random() * 2 - 1) * JITTER));
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // A throwing onError/onResult callback must not end the loop: keep it as lastError and check again.
      void this.check()
        .catch((error: unknown) => {
          this.lastError = error;
        })
        .finally(() => {
          if (this.running) this.schedule(this.nextDelay());
        });
    }, delayMs);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
