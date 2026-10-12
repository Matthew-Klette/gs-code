import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpGtmApi } from '../src/core/api';
import { readState } from '../src/core/mirror/state';
import { workingStatus } from '../src/core/ops/plan';
import { createVersion } from '../src/core/ops/publish';
import { applySnapshot, pullWorkspace } from '../src/core/ops/pull';
import { pushWorkspace } from '../src/core/ops/push';
import { initMirror, resolveConflict } from '../src/core/ops/workspace';
import { RateLimiter } from '../src/core/rateLimiter';
import { CONTAINER, seededFake, type FakeGtm } from './fakeApi';

let root: string;
let gtm: FakeGtm;
const json = async (rel: string) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));
const put = async (rel: string, value: unknown) => {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const changes = async () => (await workingStatus(root, await readState(root))).changes.entities.map((c) => `${c.type} ${c.base}`);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-reg-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
});
afterEach(async () => rm(root, { recursive: true, force: true }));

describe('review regressions', () => {
  it('a bulk-created unnamed gtag config is adopted, not duplicated', async () => {
    await put('gtag-configs/main.json', { type: 'google', parameter: [{ type: 'TEMPLATE', key: 'tagId', value: 'G-1' }] });
    await pushWorkspace(root, gtm, await readState(root));
    expect(gtm.entities.gtagConfig).toHaveLength(1);
    expect(await changes()).toEqual([]);
    await pushWorkspace(root, gtm, await readState(root));
    expect(gtm.entities.gtagConfig).toHaveLength(1);
  });

  it('CRLF in remote custom HTML does not cause false updates or conflicts', async () => {
    gtm.remoteEdit('tag', 'cHTML - hello', { parameter: [{ type: 'TEMPLATE', key: 'html', value: '<script>\r\n  a();\r\n</script>' }] });
    await pullWorkspace(root, gtm, await readState(root));
    await put('tags/cHTML - hello.html', '<script>\n  b();\n</script>');
    const again = await pullWorkspace(root, gtm, await readState(root));
    expect(again.conflicts).toEqual([]);
    expect(again.updated).toEqual([]);
  });

  it('a broken local file keeps its old fingerprint so a later push still detects remote edits', async () => {
    await put('tags/GA4 - purchase.json', '{ broken');
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'colleague' });
    await pullWorkspace(root, gtm, await readState(root));
    const original = await json('.gtm/base/tags/GA4 - purchase.json');
    await put('tags/GA4 - purchase.json', { ...original, notes: 'mine' });
    await expect(pushWorkspace(root, gtm, await readState(root))).rejects.toThrow(/GA4 - purchase: changed locally and in GTM/);
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('colleague');
  });

  it('a folder edited on both sides becomes a resolvable conflict', async () => {
    await put('folders.json', [{ name: 'GA4', notes: 'mine' }]);
    gtm.remoteEdit('folder', 'GA4', { notes: 'theirs' });
    const result = await pullWorkspace(root, gtm, await readState(root));
    expect(result.conflicts).toEqual(['folders.json']);
    await expect(pushWorkspace(root, gtm, await readState(root))).rejects.toThrow(/unresolved conflict/);
    await resolveConflict(root, await readState(root), 'folders.json', 'mine');
    await pushWorkspace(root, gtm, await readState(root));
    expect(gtm.find('folder', 'GA4')?.notes).toBe('mine');
  });

  it('take theirs on folders.json restores the remote folders', async () => {
    await put('folders.json', [{ name: 'GA4', notes: 'mine' }]);
    gtm.remoteEdit('folder', 'GA4', { notes: 'theirs' });
    await pullWorkspace(root, gtm, await readState(root));
    await resolveConflict(root, await readState(root), 'folders.json', 'theirs');
    expect(await json('folders.json')).toEqual([{ name: 'GA4', notes: 'theirs' }]);
  });

  it('a kind that could not be listed is not treated as deleted', async () => {
    gtm.seed('zone', { name: 'Zone A', boundary: {} });
    await pullWorkspace(root, gtm, await readState(root));
    const snapshot = await gtm.fetchSnapshot(gtm.workspace);
    const result = await applySnapshot(root, await readState(root), { ...snapshot, entities: { ...snapshot.entities, zone: [] }, unavailable: ['zone'] });
    expect(result.removed).toEqual([]);
    expect(await json('zones/Zone A.json')).toMatchObject({ name: 'Zone A' });
  });

  it('a template folder keeps files it did not create when the template is deleted remotely', async () => {
    await put('templates/Hash Email/my-notes.txt', 'keep me');
    gtm.entities.template = [];
    gtm.entities.variable = gtm.entities.variable.filter((v) => v.name !== 'Hashed email');
    await pullWorkspace(root, gtm, await readState(root));
    expect(await readFile(path.join(root, 'templates/Hash Email/my-notes.txt'), 'utf8')).toBe('keep me');
  });

  it('reports clearly when the version is created but publishing fails', async () => {
    gtm.publishVersion = async () => {
      throw new Error('403 insufficient scope');
    };
    await expect(createVersion(root, gtm, await readState(root), { name: 'v', notes: '', publish: true, protectedContainers: [] })).rejects.toThrow(
      /Version 1 was created but NOT published/,
    );
    expect((await readState(root)).workspace.workspaceId).toBe(gtm.workspace.workspaceId);
  });
});

describe('HTTP retries', () => {
  const ws = { accountId: '1', containerId: '2', workspaceId: '3' };
  const clock = { now: () => 0, sleep: async () => undefined };
  const make = (status: number) => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'x' } }), { status });
    }) as unknown as typeof fetch;
    const api = new HttpGtmApi({ getAccessToken: async () => 't' }, { fetchImpl, clock, limiter: new RateLimiter(100, 1, clock), retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    return { api, calls: () => calls };
  };

  it('does not retry a write on 5xx (it may have been applied)', async () => {
    const { api, calls } = make(503);
    await expect(api.createEntity(ws, 'tag', { name: 'x' })).rejects.toThrow();
    expect(calls()).toBe(1);
  });

  it('still retries a write on 429', async () => {
    const { api, calls } = make(429);
    await expect(api.bulkUpdate(ws, [])).rejects.toThrow();
    expect(calls()).toBe(3);
  });

  it('retries reads on 5xx', async () => {
    const { api, calls } = make(502);
    await expect(api.getWorkspace(ws)).rejects.toThrow();
    expect(calls()).toBe(3);
  });
});
