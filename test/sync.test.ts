import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, type MirrorState } from '../src/core/mirror/state';
import { AutoPull, clampInterval, MIN_INTERVAL_SECONDS } from '../src/core/ops/autoPull';
import { workingStatus } from '../src/core/ops/plan';
import { createVersion } from '../src/core/ops/publish';
import { PushBlockedError, pushWorkspace } from '../src/core/ops/push';
import { refreshMirror, resolveGtmConflict, statusSignature, switchWorkspace } from '../src/core/ops/sync';
import { initMirror } from '../src/core/ops/workspace';
import { AuthError, WorkspaceGoneError, type ApiEntity, type RemoteSnapshot, type WorkspaceRef } from '../src/core/types';
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
async function exists(rel: string): Promise<boolean> {
  return access(path.join(root, rel)).then(() => true, () => false);
}
const state = (): Promise<MirrorState> => readState(root);
const check = async (overlay?: Map<string, string>, force = false) => refreshMirror(root, gtm, await state(), { overlay, force });
/** An explicit Pull: the only kind of refresh that may sync the workspace to a newer version. */
const pullNow = async () => refreshMirror(root, gtm, await state(), { force: true, sync: true });
const tagText = async (name: string) => readFile(path.join(root, 'tags', `${name}.json`), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-sync-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
  await check(); // first check records the remote status
  gtm.calls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('change detection', () => {
  it('costs exactly two requests when GTM did not change', async () => {
    const result = await check();
    expect(result.pulled).toBe(false);
    expect(gtm.calls).toEqual(['status', 'latestVersion']);
  });

  it('pulls a remote edit made in the same workspace', async () => {
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'edited in the GTM UI' });
    const result = await check();
    expect(result.pulled).toBe(true);
    expect(result.pull?.updated).toEqual(['tags/GA4 - purchase']);
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('edited in the GTM UI');
    gtm.calls = [];
    expect((await check()).pulled).toBe(false);
    expect(gtm.calls).toEqual(['status', 'latestVersion']);
  });

  it('notices a second edit to an entity that was already changed', async () => {
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'one' });
    await check();
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'two' });
    expect((await check()).pulled).toBe(true);
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('two');
  });

  it('records the status hash so the same status never pulls twice', async () => {
    const status = await gtm.getWorkspaceStatus(gtm.workspace);
    expect((await state()).remote?.status).toBe(statusSignature(status));
  });

  it('a forced check always pulls', async () => {
    expect((await check(undefined, true)).pulled).toBe(true);
  });
});

describe('local edits are never overwritten', () => {
  it('keeps an unpushed edit while bringing in a remote edit to another entity', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    gtm.remoteEdit('tag', 'cHTML - hello', { notes: 'theirs' });
    const result = await check();
    expect(result.pull?.updated).toEqual(['tags/cHTML - hello']);
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('mine');
    expect((await readJson('tags/cHTML - hello.json')).notes).toBe('theirs');
  });

  it('turns an edit on both sides into a conflict and keeps mine', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'theirs' });
    const result = await check();
    expect(result.state.conflicts).toEqual(['tags/GA4 - purchase']);
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('mine');
    expect((await readJson('.gtm/remote/tags/GA4 - purchase.json')).notes).toBe('theirs');
  });

  it('treats an unsaved editor buffer as a local edit: conflict, file on disk untouched', async () => {
    const onDisk = await tagText('GA4 - purchase');
    const unsaved = JSON.stringify({ ...JSON.parse(onDisk), notes: 'typing…' }, null, 2);
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'theirs' });
    const result = await check(new Map([['tags/GA4 - purchase.json', unsaved]]));
    expect(result.state.conflicts).toEqual(['tags/GA4 - purchase']);
    expect(await tagText('GA4 - purchase')).toBe(onDisk);
  });

  it('never writes under an open dirty editor, even if its text matches the last pull', async () => {
    const onDisk = await tagText('GA4 - purchase');
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'theirs' });
    const result = await check(new Map([['tags/GA4 - purchase.json', onDisk]]));
    expect(result.state.conflicts).toEqual(['tags/GA4 - purchase']);
    expect(await tagText('GA4 - purchase')).toBe(onDisk);
  });

  it('does not delete a file open with unsaved edits when GTM deletes the entity', async () => {
    const onDisk = await tagText('cHTML - hello');
    gtm.entities.tag = gtm.entities.tag.filter((tag) => tag.name !== 'cHTML - hello');
    const result = await check(new Map([['tags/cHTML - hello.json', onDisk]]));
    expect(result.pull?.orphaned).toEqual(['tags/cHTML - hello']);
    expect(await exists('tags/cHTML - hello.json')).toBe(true);
  });

  it('defers a remote folders.json change while it is unsaved, then merges it after save', async () => {
    gtm.seed('folder', { name: 'Remote folder' });
    const unsaved = JSON.stringify([{ name: 'GA4' }, { name: 'My folder' }], null, 2);
    const first = await check(new Map([['folders.json', unsaved]]));
    expect(first.pull?.deferred).toEqual(['folders.json']);
    expect(await readJson('folders.json')).toEqual([{ name: 'GA4' }]);

    await writeFile(path.join(root, 'folders.json'), unsaved); // the user saves
    gtm.calls = [];
    const second = await check();
    expect(second.pulled).toBe(true);
    expect((await readJson('folders.json')).map((f: { name: string }) => f.name)).toEqual(['GA4', 'My folder', 'Remote folder']);
    expect((await state()).deferred).toEqual([]);
  });
});

describe('newer container versions', () => {
  const publishNewTrigger = () =>
    gtm.publishElsewhere('from another workspace', (contents) => ({
      ...contents,
      trigger: [...contents.trigger, gtm.restamp('trigger', { triggerId: '900', name: 'Published elsewhere', type: 'pageview' })],
    }));

  it('a background check never writes to GTM: it only reports that a newer version exists', async () => {
    const versionId = publishNewTrigger();
    const result = await check();
    expect(gtm.calls).toEqual(['status', 'latestVersion']);
    expect(result.behind).toBe(versionId);
    expect((await state()).remote?.behind).toBe(versionId);
    await expect(createVersion(root, gtm, await state(), { name: 'v', notes: '', publish: false, protectedContainers: [] })).rejects.toThrow(/Pull first/);
  });

  it('an explicit pull syncs the workspace to the latest version, then pulls', async () => {
    const versionId = publishNewTrigger();
    const result = await pullNow();
    expect(gtm.calls.slice(0, 4)).toEqual(['status', 'latestVersion', 'sync', 'status']);
    expect(result.syncedTo).toBe(versionId);
    expect(result.pull?.added).toEqual(['triggers/Published elsewhere']);
    expect((await state()).remote?.versionId).toBe(versionId);
    expect((await state()).remote?.behind).toBeUndefined();
    gtm.calls = [];
    expect((await check()).pulled).toBe(false);
    expect(gtm.calls).toEqual(['status', 'latestVersion']);
  });

  it('keeps unpushed local edits through a sync', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine, not pushed' });
    publishNewTrigger();
    await pullNow();
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('mine, not pushed');
    expect(await exists('triggers/Published elsewhere.json')).toBe(true);
  });

  describe('GTM merge conflicts', () => {
    beforeEach(async () => {
      const tag = await readJson('tags/GA4 - purchase.json');
      await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'workspace edit' });
      await pushWorkspace(root, gtm, await state());
      gtm.publishElsewhere('conflicting', (contents) => ({
        ...contents,
        tag: contents.tag.map((item) => (item.name === 'GA4 - purchase' ? gtm.restamp('tag', { ...item, notes: 'published edit' }) : item)),
      }));
      await pullNow();
    });

    it('records the conflict and writes the latest version for comparison', async () => {
      const s = await state();
      expect(s.gtmConflicts).toMatchObject([{ kind: 'tag', id: '30', name: 'GA4 - purchase', base: 'tags/GA4 - purchase', workspaceChange: 'updated', latestChange: 'updated' }]);
      expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('workspace edit');
      expect((await readJson('.gtm/merge/tags/GA4 - purchase.json')).notes).toBe('published edit');
    });

    it('blocks push and versioning until resolved', async () => {
      const tag = await readJson('tags/cHTML - hello.json');
      await writeJson('tags/cHTML - hello.json', { ...tag, notes: 'x' });
      await expect(pushWorkspace(root, gtm, await state())).rejects.toThrow(/GTM merge conflict/);
      await writeJson('tags/cHTML - hello.json', tag);
      await expect(createVersion(root, gtm, await state(), { name: 'v', notes: '', publish: false, protectedContainers: [] })).rejects.toThrow(/merge conflicts/);
    });

    it('Take Latest replaces the workspace entity with the published one', async () => {
      const result = await resolveGtmConflict(root, gtm, await state(), 'tags/GA4 - purchase', 'latest');
      expect(result.state.gtmConflicts).toEqual([]);
      expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('published edit');
      expect(gtm.mergeConflicts).toEqual([]);
    });

    it('Keep Workspace keeps ours and clears the conflict', async () => {
      const result = await resolveGtmConflict(root, gtm, await state(), 'GA4 - purchase', 'workspace');
      expect(result.state.gtmConflicts).toEqual([]);
      expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('workspace edit');
      await expect(createVersion(root, gtm, await state(), { name: 'v', notes: '', publish: false, protectedContainers: [] })).resolves.toMatchObject({ published: false });
    });

    it('rejects an unknown conflict', async () => {
      await expect(resolveGtmConflict(root, gtm, await state(), 'tags/nope', 'latest')).rejects.toThrow(/not a GTM merge conflict/);
    });
  });
});

describe('workspace replaced in GTM', () => {
  it('never guesses a replacement: it stops and lists the workspaces to choose from', async () => {
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(path.join(tmpdir(), 'gscode-sync-'));
    const named = await gtm.createWorkspace('100', '200', 'claude-test');
    await initMirror(root, gtm, CONTAINER, named);
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'unpushed' });
    gtm.versionFromUi();
    gtm.calls = [];
    const error = await check().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceGoneError);
    expect((error as WorkspaceGoneError).candidates.map((w) => w.name)).toEqual(['Default Workspace']);
    expect(gtm.calls.filter((call) => call.startsWith('createWorkspace'))).toEqual([]);
    expect((await state()).workspace.workspaceId).toBe(named.workspaceId);
  });

  it('switching keeps unpushed edits and backs up the working files first', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'unpushed' });
    gtm.versionFromUi();
    const result = await switchWorkspace(root, gtm, await state(), gtm.workspace);
    expect(result.movedTo?.workspaceId).toBe(gtm.workspace.workspaceId);
    expect((await state()).workspace.workspaceId).toBe(gtm.workspace.workspaceId);
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('unpushed');
    expect((await readJson(`${result.backup}/tags/GA4 - purchase.json`)).notes).toBe('unpushed');
  });
});

describe('push pulls first', () => {
  it('merges a remote-only change before pushing and never reverts it', async () => {
    gtm.remoteEdit('tag', 'cHTML - hello', { notes: 'colleague' });
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    const result = await pushWorkspace(root, gtm, await state());
    expect(result.before?.pulled).toBe(true);
    expect(gtm.find('tag', 'cHTML - hello')?.notes).toBe('colleague');
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('mine');
    expect((await readJson('tags/cHTML - hello.json')).notes).toBe('colleague');
  });

  it('records the status after its own push, so the next check does not pull again', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    await pushWorkspace(root, gtm, await state());
    gtm.calls = [];
    expect((await check()).pulled).toBe(false);
    expect(gtm.calls).toEqual(['status', 'latestVersion']);
  });

  it('still stops on a GTM edit that lands between the refresh and the push', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    const original = gtm.fetchSnapshot.bind(gtm);
    let snapshots = 0;
    gtm.fetchSnapshot = async (ref: WorkspaceRef): Promise<RemoteSnapshot> => {
      if (++snapshots === 1) gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'racing colleague' });
      return original(ref);
    };
    await expect(pushWorkspace(root, gtm, await state())).rejects.toBeInstanceOf(PushBlockedError);
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('racing colleague');
  });
});

describe('AutoPull', () => {
  const until = async (probe: () => boolean, timeoutMs = 3000) => {
    const start = Date.now();
    while (!probe()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('clamps the interval to the minimum', () => {
    expect(clampInterval(1)).toBe(MIN_INTERVAL_SECONDS * 1000);
    expect(clampInterval(undefined)).toBe(60_000);
    expect(clampInterval(120)).toBe(120_000);
  });

  it('checks on start and on every interval, pulling remote edits by itself', async () => {
    const results: boolean[] = [];
    const watcher = new AutoPull(root, gtm, { intervalMs: 30, onResult: (result) => results.push(result.pulled) });
    watcher.start();
    await until(() => results.length >= 1);
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'from the UI' });
    await until(() => results.includes(true));
    watcher.stop();
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('from the UI');
    expect(watcher.lastCheckedAt).toBeDefined();
  });

  it('shares one in-flight check between concurrent callers', async () => {
    const watcher = new AutoPull(root, gtm, { intervalMs: 60_000 });
    gtm.calls = [];
    await Promise.all([watcher.check(), watcher.check(), watcher.checkIfStale(0)]);
    expect(gtm.calls).toEqual(['status', 'latestVersion']);
  });

  it('skips a focus check when one just ran', async () => {
    const watcher = new AutoPull(root, gtm, { intervalMs: 60_000 });
    await watcher.check();
    gtm.calls = [];
    await watcher.checkIfStale(10_000);
    expect(gtm.calls).toEqual([]);
  });

  it('retries transient errors and stops on sign-in errors', async () => {
    const errors: [string, boolean][] = [];
    const original = gtm.getWorkspaceStatus.bind(gtm);
    let calls = 0;
    gtm.getWorkspaceStatus = async (ref: WorkspaceRef) => {
      calls++;
      if (calls === 1) throw new Error('network down');
      if (calls === 2) throw new AuthError('Not signed in. Run "Sign In" first.');
      return original(ref);
    };
    const watcher = new AutoPull(root, gtm, { intervalMs: 5, onError: (error, fatal) => errors.push([(error as Error).message, fatal]) });
    watcher.start();
    await until(() => errors.length === 2);
    expect(errors).toEqual([['network down', false], ['Not signed in. Run "Sign In" first.', true]]);
    expect(watcher.active).toBe(false);
  });
});

describe('status after sync', () => {
  it('reports no local changes after pulling remote-only edits', async () => {
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'remote' });
    gtm.seed('variable', { name: 'Remote var', type: 'c', parameter: [] } as ApiEntity);
    await check();
    const status = await workingStatus(root, await state());
    expect(status.changes.entities).toEqual([]);
  });
});
