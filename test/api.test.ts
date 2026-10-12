import { describe, expect, it } from 'vitest';
import { HttpGtmApi, isRetryable } from '../src/core/api';
import { RateLimiter, type Clock } from '../src/core/rateLimiter';
import { GtmError } from '../src/core/types';

function fakeClock(): Clock & { slept: number[]; time: number } {
  const clock = {
    time: 0,
    slept: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

type Responder = (url: string, init: RequestInit) => { status: number; body?: unknown };

function apiWith(responder: Responder, clock = fakeClock()) {
  const requests: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, method: String(init.method), body: init.body as string | undefined });
    const { status, body } = responder(url, init);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const api = new HttpGtmApi({ getAccessToken: async () => 'tok' }, { fetchImpl, clock, limiter: new RateLimiter(1000, 100_000, clock), retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 } });
  return { api, requests, clock };
}

const WS = { accountId: '1', containerId: '2', workspaceId: '3' };

describe('RateLimiter', () => {
  it('lets 25 requests through then waits for the window', async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    const limiter = new RateLimiter(25, 100_000, clock, (ms) => waits.push(ms));
    for (let i = 0; i < 25; i++) await limiter.acquire();
    expect(clock.slept).toEqual([]);
    expect(limiter.inWindow()).toBe(25);
    await limiter.acquire();
    expect(waits).toEqual([100_001]);
    expect(clock.time).toBe(100_001);
  });

  it('shares history through a store (separate CLI runs)', async () => {
    const clock = fakeClock();
    let saved: readonly number[] = [];
    const store = { load: () => saved, save: (s: readonly number[]) => { saved = s; } };
    const first = new RateLimiter(2, 1000, clock, undefined, store);
    await first.acquire();
    await first.acquire();
    const second = new RateLimiter(2, 1000, clock, undefined, store);
    await second.acquire();
    expect(clock.slept).toEqual([1001]);
  });

  it('serializes concurrent callers', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, 1000, clock);
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(clock.slept).toEqual([1001]);
  });
});

describe('HttpGtmApi', () => {
  it('follows pagination and sends the bearer token', async () => {
    const { api, requests } = apiWith((url) =>
      url.includes('pageToken=p2')
        ? { status: 200, body: { account: [{ accountId: '2', name: 'B' }] } }
        : { status: 200, body: { account: [{ accountId: '1', name: 'A' }], nextPageToken: 'p2' } },
    );
    expect(await api.listAccounts()).toEqual([{ accountId: '1', name: 'A' }, { accountId: '2', name: 'B' }]);
    expect(requests).toHaveLength(2);
  });

  it('retries 429 and quota 403 with backoff', async () => {
    let calls = 0;
    const { api, clock } = apiWith(() => {
      calls++;
      if (calls === 1) return { status: 429, body: { error: { message: 'slow down' } } };
      if (calls === 2) return { status: 403, body: { error: { message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] } } };
      return { status: 200, body: { workspaceId: '3', accountId: '1', containerId: '2', name: 'W' } };
    });
    const workspace = await api.getWorkspace(WS);
    expect(workspace.name).toBe('W');
    expect(clock.slept).toEqual([10, 20]);
  });

  it('does not retry a permission 403 or a 400', async () => {
    const { api, requests } = apiWith(() => ({ status: 403, body: { error: { message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } } }));
    await expect(api.getWorkspace(WS)).rejects.toThrow(/does not have permission/);
    expect(requests).toHaveLength(1);
    expect(isRetryable(400, {})).toBe(false);
    expect(isRetryable(503, {})).toBe(true);
  });

  it('gives up after maxAttempts', async () => {
    const { api, requests } = apiWith(() => ({ status: 500, body: { error: { message: 'boom' } } }));
    await expect(api.getWorkspace(WS)).rejects.toBeInstanceOf(GtmError);
    expect(requests).toHaveLength(3);
  });

  it('skips server-only kinds on web containers and tolerates optional 400s', async () => {
    const { api, requests } = apiWith((url) => {
      if (url.includes('/zones') || url.includes('/gtag_config')) return { status: 400, body: { error: { message: 'not supported' } } };
      if (url.includes('/built_in_variables')) return { status: 200, body: { builtInVariable: [{ type: 'pageUrl', name: 'Page URL' }] } };
      if (url.includes('/tags')) return { status: 200, body: { tag: [{ tagId: '1', name: 'T' }] } };
      return { status: 200, body: {} };
    });
    const snapshot = await api.fetchSnapshot(WS, ['web']);
    expect(snapshot.entities.tag).toHaveLength(1);
    expect(snapshot.entities.zone).toEqual([]);
    expect(snapshot.builtInVariables).toEqual([{ type: 'pageUrl', name: 'Page URL' }]);
    expect(requests.some((r) => r.url.includes('/clients'))).toBe(false);
  });

  it('propagates a 400 on a required kind', async () => {
    const { api } = apiWith((url) => (url.includes('/tags') ? { status: 400, body: { error: { message: 'bad' } } } : { status: 200, body: {} }));
    await expect(api.fetchSnapshot(WS, ['web'])).rejects.toThrow(/bad/);
  });

  it('builds the right URLs for writes, built-ins, versions and publish', async () => {
    const { api, requests } = apiWith(() => ({ status: 200, body: { changes: [{ changeStatus: 'added' }], containerVersion: { containerVersionId: '9' }, newWorkspacePath: 'accounts/1/containers/2/workspaces/4' } }));
    await api.updateEntity(WS, 'tag', '5', { name: 'x' }, 'fp1');
    await api.deleteEntity(WS, 'trigger', '6');
    expect(await api.bulkUpdate(WS, [{ changeStatus: 'added', tag: { tagId: 'new_1' } }])).toHaveLength(1);
    await api.enableBuiltIns(WS, ['pageUrl', 'clickUrl']);
    await api.disableBuiltIns(WS, ['event']);
    await api.enableBuiltIns(WS, []);
    const version = await api.createVersion(WS, 'v', 'n');
    await api.publishVersion('1', '2', '9');
    const base = 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2';
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT ${base}/workspaces/3/tags/5?fingerprint=fp1`,
      `DELETE ${base}/workspaces/3/triggers/6`,
      `POST ${base}/workspaces/3/bulk_update`,
      `POST ${base}/workspaces/3/built_in_variables?type=pageUrl&type=clickUrl`,
      `DELETE ${base}/workspaces/3/built_in_variables?type=event`,
      `POST ${base}/workspaces/3:create_version`,
      `POST ${base}/versions/9:publish`,
    ]);
    expect(version).toMatchObject({ containerVersionId: '9', compilerError: false, newWorkspacePath: 'accounts/1/containers/2/workspaces/4' });
  });
});
