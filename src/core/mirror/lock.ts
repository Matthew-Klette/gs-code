import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { GtmError } from '../types';
import { STATE_DIR } from './layout';

export const LOCK_FILE = `${STATE_DIR}/lock`;
/** A lock older than this is from a crashed process, whatever it says. */
export const STALE_LOCK_MS = 15 * 60_000;
/** How long an operation waits for another process to finish before giving up. */
export const DEFAULT_LOCK_WAIT_MS = 30_000;
/** An unreadable lock older than this was left half-written by a crash (or an older GS Code); a live one is never unreadable. */
export const CORRUPT_LOCK_MS = 5_000;
/** How often a running operation refreshes its lock, so a long push is never mistaken for a crash. */
export const HEARTBEAT_MS = 60_000;
const POLL_MS = 200;
/** A cleanup guard older than this was left by a crash; a live one is held for milliseconds. */
export const GUARD_STALE_MS = 10_000;
const GUARD_POLL_MS = 10;
/** Filesystems without hard links (FAT, some network shares) report one of these from link(). */
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV']);

interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly operation: string;
  readonly startedAt: number;
  /** Random per acquisition, so a holder only ever removes or refreshes its own lock. */
  readonly token?: string;
}

interface LockRead {
  readonly info: LockInfo;
  /** The file's exact contents, used to check a stale lock is still the one we judged stale. */
  readonly raw: string;
  /** Unparseable: `info.startedAt` is the file's mtime. */
  readonly corrupt: boolean;
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
  const info = await acquire(file, operation, waitMs);
  const heartbeat = setInterval(() => void refresh(file, info), HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await held.run(new Set([...(current ?? []), key]), task);
  } finally {
    clearInterval(heartbeat);
    await removeIfStill(file, (raw) => tokenOf(raw) === info.token);
  }
}

async function acquire(file: string, operation: string, waitMs: number): Promise<LockInfo> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = { pid: process.pid, host: hostname(), operation, startedAt: Date.now(), token: randomUUID() };
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await createExclusive(file, JSON.stringify(info))) return info;
    const lock = await readLock(file);
    if (!lock) continue; // Released between our create and read: try again straight away.
    if (lock.corrupt ? Date.now() - lock.info.startedAt > CORRUPT_LOCK_MS : isStale(lock.info)) {
      await removeIfStill(file, (raw) => raw === lock.raw);
      continue;
    }
    if (Date.now() >= deadline) throw new MirrorBusyError(lock.corrupt ? undefined : lock.info);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Create `file` with `content`, or return false when it already exists. The content is written to a
 * private temp file first and then hard-linked into place, so the lock is never seen half-written.
 */
async function createExclusive(file: string, content: string): Promise<boolean> {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, content, { flag: 'wx' });
  try {
    await linkExclusive(temp, file);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** Hard link `source` to `dest`, failing with EEXIST if `dest` exists. Falls back to an exclusive copy where links are unsupported. */
async function linkExclusive(source: string, dest: string): Promise<void> {
  try {
    await fs.link(source, dest);
  } catch (error: unknown) {
    if (!NO_LINK_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await fs.copyFile(source, dest, fsConstants.COPYFILE_EXCL);
  }
}

/**
 * Run `task` holding `<lock>.guard`, a short-lived O_EXCL file that serialises everything that removes or
 * rewrites an existing lock (clearing a stale one, releasing, heartbeats). Creating a lock needs no guard:
 * the exclusive link only succeeds on an empty slot, and the slot only empties under the guard.
 * Returns undefined without running `task` when `wait` is false and the guard is busy.
 */
async function withGuard<T>(file: string, task: () => Promise<T>, wait: boolean): Promise<T | undefined> {
  const guard = `${file}.guard`;
  for (;;) {
    try {
      await fs.writeFile(guard, String(process.pid), { flag: 'wx' });
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await clearStaleGuard(guard)) continue;
    if (!wait) return undefined;
    await new Promise((resolve) => setTimeout(resolve, GUARD_POLL_MS));
  }
  try {
    return await task();
  } finally {
    await fs.rm(guard, { force: true });
  }
}

/** A guard is held for milliseconds; one older than GUARD_STALE_MS was left by a crash. True when the slot may now be free. */
async function clearStaleGuard(guard: string): Promise<boolean> {
  try {
    const { mtimeMs } = await fs.stat(guard);
    if (Date.now() - mtimeMs <= GUARD_STALE_MS) return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  // Two waiters can both judge the same crashed guard stale; that needs a crash inside a millisecond
  // window and leaves at worst one extra clear, which still re-checks the lock's exact content.
  await fs.rm(guard, { force: true });
  return true;
}

/** Remove the lock if it is still exactly `raw` (the content judged stale, or our own lock). */
async function removeIfStill(file: string, isOurs: (raw: string) => boolean): Promise<void> {
  await withGuard(
    file,
    async () => {
      const lock = await readLock(file);
      if (lock && isOurs(lock.raw)) await fs.rm(file);
    },
    true,
  );
}

/** Keep a long operation's lock fresh. Only rewrites a lock that still carries our token; skips a beat if the guard is busy. */
async function refresh(file: string, info: LockInfo): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await withGuard(
      file,
      async () => {
        const lock = await readLock(file);
        if (!lock || tokenOf(lock.raw) !== info.token) return;
        await fs.writeFile(temp, JSON.stringify({ ...info, startedAt: Date.now() }), { flag: 'wx' });
        await fs.rename(temp, file);
      },
      false,
    );
  } catch {
    // Best effort by design: a missed beat only means the lock ages as it did before heartbeats,
    // and there is no caller to report to from a timer. The next beat tries again.
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function tokenOf(raw: string): string | undefined {
  try {
    const token = (JSON.parse(raw) as Partial<LockInfo>).token;
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined; // Unparseable: carries no token, so it is nobody's to release.
  }
}

async function readLock(file: string): Promise<LockRead | undefined> {
  let raw: string;
  let mtimeMs: number;
  try {
    [raw, { mtimeMs }] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.startedAt === 'number') {
      const info: LockInfo = { pid: parsed.pid, host: String(parsed.host ?? ''), operation: String(parsed.operation ?? 'unknown'), startedAt: parsed.startedAt };
      return { info: typeof parsed.token === 'string' ? { ...info, token: parsed.token } : info, raw, corrupt: false };
    }
  } catch {
    // Falls through: treated as corrupt below.
  }
  return { info: { pid: -1, host: '', operation: 'unknown', startedAt: mtimeMs }, raw, corrupt: true };
}

export function isStale(holder: LockInfo, now = Date.now()): boolean {
  if (holder.host === hostname() && holder.pid > 0 && !isAlive(holder.pid)) return true;
  return now - holder.startedAt > STALE_LOCK_MS;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
