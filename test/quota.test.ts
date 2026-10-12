import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileStampStore } from '../src/cli/fileStore';
import { HttpGtmApi, isDailyQuota } from '../src/core/api';
import { readState } from '../src/core/mirror/state';
import { AutoPull, IDLE_CHECKS_BEFORE_SLOWDOWN, idleFactor, MAX_IDLE_FACTOR } from '../src/core/ops/autoPull';
import { workingStatus } from '../src/core/ops/plan';
import { pushWorkspace } from '../src/core/ops/push';
import { refreshMirror } from '../src/core/ops/sync';
import { initMirror } from '../src/core/ops/workspace';
import { RateLimiter } from '../src/core/rateLimiter';
import { DailyQuotaError } from '../src/core/types';
import { CONTAINER, seededFake, type FakeGtm } from './fakeApi';

let root: string;
let gtm: FakeGtm;

async function readJson(rel: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(root, rel), 'utf8'));
}
async function writeJson(rel: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-quota-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
  gtm.calls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('push cost', () => {
  it('one tag edit costs a handful of requests, not two full snapshots', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'cheap' });
    await pushWorkspace(root, gtm, await readState(root));
    expect(gtm.calls).toEqual(['status', 'latestVersion', 'snapshot folder', 'status', 'bulk 1', 'status', 'snapshot tag,folder']);
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('cheap');
    expect((await workingStatus(root, await readState(root))).changes.entities).toEqual([]);
    gtm.calls = [];
    expect((await refreshMirror(root, gtm, await readState(root))).pulled).toBe(false);
  });

  it('a delete fetches only GTM\'s copy of the deleted entity', async () => {
    await rm(path.join(root, 'tags/cHTML - hello.json'));
    await rm(path.join(root, 'tags/cHTML - hello.html'));
    await pushWorkspace(root, gtm, await readState(root));
    expect(gtm.calls).toContain('get tag');
    expect(gtm.calls.filter((call) => call === 'snapshot')).toEqual([]);
    expect(gtm.find('tag', 'cHTML - hello')).toBeUndefined();
  });

  it('a teammate\'s change to an untouched kind during the push is pulled on the next check', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    const bulk = gtm.bulkUpdate.bind(gtm);
    gtm.bulkUpdate = async (ref, changes) => {
      const result = await bulk(ref, changes);
      gtm.remoteEdit('variable', 'DL - user_id', { notes: 'teammate' });
      return result;
    };
    await pushWorkspace(root, gtm, await readState(root));
    const next = await refreshMirror(root, gtm, await readState(root));
    expect(next.pulled).toBe(true);
    expect((await readJson('variables/DL - user_id.json')).notes).toBe('teammate');
  });
});

describe('daily quota', () => {
  it('recognises a per-day quota error', () => {
    const body = { error: { code: 429, message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per day' of service 'tagmanager.googleapis.com'", status: 'RESOURCE_EXHAUSTED' } };
    expect(isDailyQuota(429, body)).toBe(true);
    expect(isDailyQuota(429, { error: { message: 'Rate Limit Exceeded' } })).toBe(false);
  });

  it('stops at once instead of retrying', async () => {
    let calls = 0;
    const api = new HttpGtmApi({ getAccessToken: async () => 't' }, {
      limiter: new RateLimiter(1000),
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: 'Requests per day exceeded' } }), { status: 429 });
      }) as typeof fetch,
    });
    await expect(api.listAccounts()).rejects.toBeInstanceOf(DailyQuotaError);
    expect(calls).toBe(1);
  });
});

describe('auto-pull pacing', () => {
  it('stretches the interval while nothing changes, up to a cap', () => {
    expect(idleFactor(0)).toBe(1);
    expect(idleFactor(IDLE_CHECKS_BEFORE_SLOWDOWN)).toBe(2);
    expect(idleFactor(IDLE_CHECKS_BEFORE_SLOWDOWN * 10)).toBe(MAX_IDLE_FACTOR);
  });

  it('adds jitter so teammates do not poll in lockstep, and wake() resets the pace', async () => {
    const auto = new AutoPull(root, gtm, { intervalMs: 60_000 });
    expect(auto.nextDelay(() => 0)).toBe(54_000);
    expect(auto.nextDelay(() => 1)).toBe(66_000);
    for (let i = 0; i < IDLE_CHECKS_BEFORE_SLOWDOWN; i++) await auto.check();
    expect(auto.nextDelay(() => 0.5)).toBe(120_000);
    auto.wake();
    expect(auto.nextDelay(() => 0.5)).toBe(60_000);
  });
});

describe('shared request history', () => {
  it('merges stamps written by another process instead of overwriting them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gscode-stamps-'));
    const a = fileStampStore(dir);
    const b = fileStampStore(dir);
    const now = Date.now();
    a.save([now - 1000]);
    b.save([now - 500]);
    expect(a.load()).toEqual([now - 1000, now - 500]);
    await rm(dir, { recursive: true, force: true });
  });
});
