import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeSignature } from '../src/core/mirror/diff';
import { LOCK_FILE, MirrorBusyError, withMirrorLock } from '../src/core/mirror/lock';
import { readState, type MirrorState } from '../src/core/mirror/state';
import { workingStatus } from '../src/core/ops/plan';
import { createVersion } from '../src/core/ops/publish';
import { pullWorkspace } from '../src/core/ops/pull';
import { PushBlockedError, pushWorkspace } from '../src/core/ops/push';
import { refreshMirror } from '../src/core/ops/sync';
import { initMirror, resolveConflict } from '../src/core/ops/workspace';
import { GtmError, type BulkEntity, type WorkspaceRef } from '../src/core/types';
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

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-multi-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
  gtm.calls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a failed push never adopts a colleague\'s entity', () => {
  it('keeps my new file when a teammate created the same name and my push failed', async () => {
    await writeJson('triggers/CE - x.json', { name: 'CE - x', type: 'customEvent', notes: 'mine' });
    // The teammate's trigger lands after my pre-push check; GTM then rejects my bulk update.
    const bulk = gtm.bulkUpdate.bind(gtm);
    gtm.bulkUpdate = async (ref: WorkspaceRef, changes: readonly BulkEntity[]) => {
      gtm.seed('trigger', { name: 'CE - x', type: 'pageview', notes: 'theirs' });
      throw new GtmError('duplicate trigger name CE - x', 400);
      return bulk(ref, changes);
    };
    await expect(pushWorkspace(root, gtm, await state())).rejects.toThrow(/Push stopped/);
    expect((await readJson('triggers/CE - x.json')).notes).toBe('mine');
  });
});

describe('push sends exactly what was confirmed', () => {
  it('stops when files changed after the confirmation', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'reviewed' });
    const expected = changeSignature((await workingStatus(root, await state())).changes);
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'sneaked in by an agent' });
    await expect(pushWorkspace(root, gtm, await state(), { expected })).rejects.toBeInstanceOf(PushBlockedError);
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBeUndefined();
  });

  it('pushes when nothing changed since the confirmation', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'reviewed' });
    const expected = changeSignature((await workingStatus(root, await state())).changes);
    await pushWorkspace(root, gtm, await state(), { expected });
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('reviewed');
  });

  it('keeps an edit saved while the push was running', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'sent' });
    const bulk = gtm.bulkUpdate.bind(gtm);
    gtm.bulkUpdate = async (ref: WorkspaceRef, changes: readonly BulkEntity[]) => {
      const result = await bulk(ref, changes);
      await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'typed during the push' });
      return result;
    };
    await pushWorkspace(root, gtm, await state());
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('sent');
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('typed during the push');
    const status = await workingStatus(root, await state());
    expect(status.changes.entities.map((change) => `${change.type} ${change.base}`)).toEqual(['updated tags/GA4 - purchase']);
  });
});

describe('a refresh failure after a push loses nothing', () => {
  it('reports success, and the next pull finishes the job', async () => {
    await writeJson('triggers/CE - new.json', { name: 'CE - new', type: 'customEvent' });
    const fetch = gtm.fetchSnapshot.bind(gtm);
    let calls = 0;
    gtm.fetchSnapshot = async (ref: WorkspaceRef) => {
      calls++;
      if (calls === 2) throw new GtmError('quota exceeded', 429);
      return fetch(ref);
    };
    await expect(pushWorkspace(root, gtm, await state())).rejects.toThrow(/Pushed 1 change\(s\) to GTM\.[\s\S]*run Pull to finish/);
    expect((await state()).pendingPush).toBeDefined();
    gtm.fetchSnapshot = fetch;
    await pullWorkspace(root, gtm, await state());
    const s = await state();
    expect(s.pendingPush).toBeUndefined();
    expect(s.entities['triggers/CE - new']?.id).toBe(gtm.find('trigger', 'CE - new')?.triggerId);
    expect(gtm.entities.trigger.filter((t) => t.name === 'CE - new')).toHaveLength(1);
    const status = await workingStatus(root, s);
    expect(status.changes.entities).toEqual([]);
  });
});

describe('versioning takes exactly what was reviewed', () => {
  it('refuses when the workspace changed in GTM after the last pull', async () => {
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'teammate, unreviewed' });
    await expect(createVersion(root, gtm, await state(), { name: 'v', notes: '', publish: true, protectedContainers: [] })).rejects.toThrow(
      /changed in GTM since your last pull/,
    );
    expect(gtm.versions).toEqual([]);
  });

  it('never publishes over a newer live version', async () => {
    const live = gtm.liveVersionId.bind(gtm);
    gtm.liveVersionId = async () => '99';
    await expect(createVersion(root, gtm, await state(), { name: 'v', notes: '', publish: true, protectedContainers: [] })).rejects.toThrow(
      /NOT published: version 99 is newer and already live/,
    );
    expect(gtm.versions[0]?.published).toBe(false);
    gtm.liveVersionId = live;
  });
});

describe('deleted in GTM, edited locally', () => {
  beforeEach(async () => {
    const tag = await readJson('tags/cHTML - hello.json');
    await writeJson('tags/cHTML - hello.json', { ...tag, notes: 'mine' });
    gtm.entities.tag = gtm.entities.tag.filter((item) => item.name !== 'cHTML - hello');
    const result = await pullWorkspace(root, gtm, await state());
    expect(result.conflicts).toContain('tags/cHTML - hello');
  });

  it('is a conflict that blocks push, and stays one across pulls', async () => {
    await pullWorkspace(root, gtm, await state());
    expect((await state()).conflicts).toContain('tags/cHTML - hello');
    await expect(pushWorkspace(root, gtm, await state())).rejects.toThrow(/deleted in GTM, edited locally/);
    expect(gtm.find('tag', 'cHTML - hello')).toBeUndefined();
  });

  it('Keep Mine recreates it on the next push', async () => {
    await resolveConflict(root, await state(), 'tags/cHTML - hello', 'mine');
    await pushWorkspace(root, gtm, await state());
    expect(gtm.find('tag', 'cHTML - hello')?.notes).toBe('mine');
  });

  it('Take Theirs deletes the local file', async () => {
    await resolveConflict(root, await state(), 'tags/cHTML - hello', 'theirs');
    expect(await exists('tags/cHTML - hello.json')).toBe(false);
    expect((await state()).conflicts).toEqual([]);
  });
});

describe('one process at a time per folder', () => {
  it('a second writer waits, and gives up with a clear error', async () => {
    let release!: () => void;
    const holding = withMirrorLock(root, 'push', () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(refreshMirror(root, gtm, await state(), { lockWaitMs: 0 })).rejects.toBeInstanceOf(MirrorBusyError);
    const waiting = refreshMirror(root, gtm, await state(), { lockWaitMs: 5000 });
    release();
    await holding;
    await expect(waiting).resolves.toMatchObject({ pulled: false });
    expect(await exists(LOCK_FILE)).toBe(false);
  });

  it('nested operations in one call chain do not wait on themselves', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'x' });
    await expect(withMirrorLock(root, 'outer', async () => pushWorkspace(root, gtm, await readState(root)), 0)).resolves.toBeDefined();
  });

  it('clears a lock left by a crashed process', async () => {
    await writeFile(path.join(root, LOCK_FILE), JSON.stringify({ pid: 999_999_999, host: (await import('node:os')).hostname(), operation: 'push', startedAt: Date.now() }));
    await expect(refreshMirror(root, gtm, await state(), { lockWaitMs: 0 })).resolves.toBeDefined();
  });
});

describe('a teammate without permission to update the workspace', () => {
  it('pulls without syncing instead of failing', async () => {
    gtm.publishElsewhere('elsewhere', (contents) => contents);
    gtm.syncWorkspace = async () => {
      throw new GtmError('The caller does not have permission', 403);
    };
    const result = await refreshMirror(root, gtm, await state(), { force: true, sync: true });
    expect(result.syncSkipped).toMatch(/no permission/);
    expect(result.behind).toBe('1');
  });
});
