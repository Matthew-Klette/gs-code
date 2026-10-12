import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { GtmError } from '../types';
import { STATE_DIR } from './layout';

export const LOCK_FILE = `${STATE_DIR}/lock`;
/** A lock older than this is from a crashed process, whatever it says. */
export const STALE_LOCK_MS = 15 * 60_000;
/** How long an operation waits for another process to finish before giving up. */
export const DEFAULT_LOCK_WAIT_MS = 30_000;
const POLL_MS = 200;

interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly operation: string;
  readonly startedAt: number;
}

/** Another process (CLI, second window, an agent) is working on this mirror. */
export class MirrorBusyError extends GtmError {
  constructor(readonly holder: LockInfo | undefined) {
    super(
      holder
        ? `Another GS Code process (pid ${holder.pid}, "${holder.operation}") is working on this folder. Try again when it finishes.`
        : 'Another GS Code process is working on this folder. Try again when it finishes.',
    );
    this.name = 'MirrorBusyError';
  }
}

/** Roots whose lock the current async call chain already holds, so nested operations do not wait on themselves. */
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Run `task` holding `.gtm/lock`, so the CLI, `gscode watch`, other VS Code windows and agents never
 * write the same mirror at once. Re-entrant within one call chain; waits up to `waitMs` for others.
 */
export async function withMirrorLock<T>(root: string, operation: string, task: () => Promise<T>, waitMs = DEFAULT_LOCK_WAIT_MS): Promise<T> {
  const key = path.resolve(root);
  const current = held.getStore();
  if (current?.has(key)) return task();
  const file = path.join(key, LOCK_FILE);
  await acquire(file, operation, waitMs);
  try {
    return await held.run(new Set([...(current ?? []), key]), task);
  } finally {
    await fs.rm(file, { force: true });
  }
}

async function acquire(file: string, operation: string, waitMs: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = { pid: process.pid, host: hostname(), operation, startedAt: Date.now() };
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(JSON.stringify(info));
      } finally {
        await handle.close();
      }
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await readLock(file);
    if (!holder || isStale(holder)) {
      await fs.rm(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new MirrorBusyError(holder);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return undefined;
    return { pid: parsed.pid, host: String(parsed.host ?? ''), operation: String(parsed.operation ?? 'unknown'), startedAt: parsed.startedAt };
  } catch {
    // Missing, or being written right now: a fresh lock is never older than a poll, so wait a round.
    return { pid: -1, host: '', operation: 'unknown', startedAt: Date.now() };
  }
}

export function isStale(holder: LockInfo, now = Date.now()): boolean {
  if (now - holder.startedAt > STALE_LOCK_MS) return true;
  if (holder.host !== hostname() || holder.pid <= 0) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
