import { promises as fsp } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORRUPT_LOCK_MS, GUARD_STALE_MS, HEARTBEAT_MS, LOCK_FILE, MirrorBusyError, STALE_LOCK_MS, withMirrorLock } from '../src/core/mirror/lock';

let root: string;
const lockPath = () => path.join(root, LOCK_FILE);
const readLockJson = async (): Promise<Record<string, any>> => JSON.parse(await readFile(lockPath(), 'utf8'));
const lockExists = () => readFile(lockPath()).then(() => true, () => false);
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function putLock(content: string, ageMs = 0): Promise<void> {
  await mkdir(path.dirname(lockPath()), { recursive: true });
  await writeFile(lockPath(), content);
  const when = new Date(Date.now() - ageMs);
  await utimes(lockPath(), when, when);
}

/** Start holding the lock until the returned release() is called. */
function hold(operation: string, waitMs?: number): { done: Promise<void>; release: () => void; entered: Promise<void> } {
  let release!: () => void;
  let entered!: () => void;
  const enteredP = new Promise<void>((resolve) => (entered = resolve));
  const done = withMirrorLock(root, operation, () => new Promise<void>((resolve) => { entered(); release = resolve; }), waitMs);
  return { done, release: () => release(), entered: enteredP };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-lock-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('a half-written lock does not block the folder forever', () => {
  it('clears an empty lock left by a crash once it is a few seconds old', async () => {
    await putLock('', CORRUPT_LOCK_MS + 1_000);
    await expect(withMirrorLock(root, 'pull', async () => 'ran', 0)).resolves.toBe('ran');
    expect(await lockExists()).toBe(false);
  });

  it('clears a garbage lock the same way', async () => {
    await putLock('{"pid": 12', CORRUPT_LOCK_MS + 1_000);
    await expect(withMirrorLock(root, 'pull', async () => 'ran', 0)).resolves.toBe('ran');
  });

  it('treats a fresh unreadable lock as busy, without inventing a pid', async () => {
    await putLock('');
    const error = await withMirrorLock(root, 'pull', async () => 'ran', 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MirrorBusyError);
    expect((error as MirrorBusyError).message).not.toMatch(/pid -1/);
  });

  it('writes the lock complete, with a token, and leaves no temp files', async () => {
    const h = hold('push');
    await h.entered;
    const lock = await readLockJson();
    expect(lock).toMatchObject({ pid: process.pid, host: hostname(), operation: 'push' });
    expect(typeof lock.token).toBe('string');
    expect(await readdir(path.dirname(lockPath()))).toEqual(['lock']);
    h.release();
    await h.done;
    expect(await readdir(path.dirname(lockPath()))).toEqual([]);
  });
});

describe('two waiters clearing the same stale lock', () => {
  it('never both get in', async () => {
    for (let round = 0; round < 10; round++) {
      await putLock(JSON.stringify({ pid: 4242, host: 'other-machine', operation: 'push', startedAt: Date.now() - STALE_LOCK_MS - 1_000 }));
      let inside = 0;
      let most = 0;
      const task = async () => {
        inside++;
        most = Math.max(most, inside);
        await tick(30);
        inside--;
      };
      await Promise.all([withMirrorLock(root, 'a', task, 5_000), withMirrorLock(root, 'b', task, 5_000), withMirrorLock(root, 'c', task, 5_000)]);
      expect(most).toBe(1);
      expect(await lockExists()).toBe(false);
    }
  });
  it('does not delete a fresh lock another waiter put in place of the stale one', async () => {
    const stale = JSON.stringify({ pid: 4242, host: 'other-machine', operation: 'push', startedAt: Date.now() - STALE_LOCK_MS - 1_000 });
    const fresh = JSON.stringify({ pid: 4343, host: 'other-machine', operation: 'winner', startedAt: Date.now(), token: 'winner' });
    await putLock(stale);
    const realRead = fsp.readFile.bind(fsp);
    let swapped = false;
    // Interleave deterministically: right after this waiter reads the stale lock, another waiter clears it and takes the slot.
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (file: any, options: any) => {
      const result = await realRead(file, options);
      if (!swapped && file === lockPath()) {
        swapped = true;
        await rm(lockPath());
        await writeFile(lockPath(), fresh);
      }
      return result;
    }) as typeof fsp.readFile);
    try {
      await expect(withMirrorLock(root, 'loser', async () => 'ran', 0)).rejects.toThrow(/pid 4343, "winner"/);
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect((await readLockJson()).token).toBe('winner');
  });
  it('never leaves the slot empty while a late waiter checks a lock that is no longer stale', async () => {
    // A judges the stale lock; B clears it and takes the slot; C turns up while A is checking.
    const stale = JSON.stringify({ pid: 4242, host: 'other-machine', operation: 'push', startedAt: Date.now() - STALE_LOCK_MS - 1_000 });
    const fresh = JSON.stringify({ pid: 4343, host: 'other-machine', operation: 'B', startedAt: Date.now(), token: 'B' });
    await putLock(stale);
    const realRead = fsp.readFile.bind(fsp);
    let reads = 0;
    let inC = false;
    let cResult: unknown;
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (file: any, options: any) => {
      if (inC) return realRead(file, options);
      reads++;
      if (reads === 2) {
        // A is now checking what it judged stale. C must still find B's lock in place.
        inC = true;
        cResult = await withMirrorLock(root, 'C', async () => 'C ran', 0).catch((e: unknown) => e);
        inC = false;
      }
      const result = await realRead(file, options);
      if (reads === 1) {
        await rm(lockPath());
        await writeFile(lockPath(), fresh);
      }
      return result;
    }) as typeof fsp.readFile);
    try {
      await expect(withMirrorLock(root, 'A', async () => 'A ran', 0)).rejects.toThrow(/pid 4343, "B"/);
    } finally {
      spy.mockRestore();
    }
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(cResult).toBeInstanceOf(MirrorBusyError);
    expect((await readLockJson()).token).toBe('B');
    expect(await readdir(path.dirname(lockPath()))).toEqual(['lock']);
  });

  it('is not blocked by a cleanup guard left by a crash', async () => {
    await putLock(JSON.stringify({ pid: 4242, host: 'other-machine', operation: 'push', startedAt: Date.now() - STALE_LOCK_MS - 1_000 }));
    const guard = `${lockPath()}.guard`;
    await writeFile(guard, '4242');
    const when = new Date(Date.now() - GUARD_STALE_MS - 1_000);
    await utimes(guard, when, when);
    await expect(withMirrorLock(root, 'pull', async () => 'ran', 0)).resolves.toBe('ran');
    expect(await readdir(path.dirname(lockPath()))).toEqual([]);
  });
});

describe('a holder whose lock was taken over', () => {
  it('does not remove the new holder\'s lock on release', async () => {
    const a = hold('slow push');
    await a.entered;
    // Pretend A has run past the stale limit without a heartbeat (e.g. the machine slept).
    const mine = await readLockJson();
    await writeFile(lockPath(), JSON.stringify({ ...mine, pid: 4242, host: 'other-machine', startedAt: Date.now() - STALE_LOCK_MS - 1_000 }));
    const b = hold('pull', 5_000);
    await b.entered;
    const theirs = await readLockJson();
    expect(theirs.token).not.toBe(mine.token);
    a.release();
    await a.done;
    expect((await readLockJson()).token).toBe(theirs.token);
    b.release();
    await b.done;
    expect(await lockExists()).toBe(false);
  });
});

describe('a long operation keeps its lock fresh', () => {
  it('refreshes startedAt on each heartbeat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = hold('long push');
    await h.entered;
    const before = await readLockJson();
    await tick(5);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    let after = before;
    for (let i = 0; i < 50 && after.startedAt === before.startedAt; i++) {
      await tick(10);
      after = await readLockJson();
    }
    expect(after.startedAt).toBeGreaterThan(before.startedAt);
    expect(after.token).toBe(before.token);
    h.release();
    await h.done;
    expect(await lockExists()).toBe(false);
  });
});

describe('a crashed holder on this machine', () => {
  it('is cleared at once even when its lock is fresh', async () => {
    await putLock(JSON.stringify({ pid: 999_999_999, host: hostname(), operation: 'push', startedAt: Date.now() }));
    await expect(withMirrorLock(root, 'pull', async () => 'ran', 0)).resolves.toBe('ran');
  });

  it('a live holder on another machine still blocks', async () => {
    await putLock(JSON.stringify({ pid: 4242, host: 'other-machine', operation: 'push', startedAt: Date.now() }));
    await expect(withMirrorLock(root, 'pull', async () => 'ran', 0)).rejects.toThrow(/pid 4242, "push"/);
  });
});
