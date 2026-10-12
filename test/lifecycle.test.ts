import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEmpty } from '../src/core/mirror/diff';
import { readState, type MirrorState } from '../src/core/mirror/state';
import { workingStatus } from '../src/core/ops/plan';
import { createVersion, ProtectedContainerError, publishVersion } from '../src/core/ops/publish';
import { pullWorkspace } from '../src/core/ops/pull';
import { PushBlockedError, pushWorkspace, type PushStrategy } from '../src/core/ops/push';
import { discardChanges, initMirror, resolveConflict } from '../src/core/ops/workspace';
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
async function state(): Promise<MirrorState> {
  return readState(root);
}
async function push(strategy: PushStrategy = 'bulk') {
  return pushWorkspace(root, gtm, await state(), { strategy });
}
async function expectClean(): Promise<void> {
  const status = await workingStatus(root, await state());
  expect(status.changes.entities.map((c) => `${c.type} ${c.base}`)).toEqual([]);
  expect(isEmpty(status.changes)).toBe(true);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-life-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('init / pull', () => {
  it('mirrors every entity as readable files', async () => {
    expect(await readJson('tags/GA4 - purchase.json')).toMatchObject({ name: 'GA4 - purchase', firingTriggers: ['CE - purchase'], folder: 'GA4' });
    expect(await readFile(path.join(root, 'tags/cHTML - hello.html'), 'utf8')).toContain('console.log');
    expect(await readFile(path.join(root, 'variables/cJS - page type.js'), 'utf8')).toContain('return "home"');
    expect(await readFile(path.join(root, 'templates/Hash Email/code.js'), 'utf8')).toBe('return data.email;');
    expect(await readJson('folders.json')).toEqual([{ name: 'GA4' }]);
    expect(await readJson('built-in-variables.json')).toEqual(['EVENT', 'PAGE_URL']);
    await expectClean();
  });

  it('refuses a non-empty folder', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'gscode-busy-'));
    await writeFile(path.join(other, 'notes.txt'), 'hi');
    await expect(initMirror(other, gtm, CONTAINER, gtm.workspace)).rejects.toThrow(/not empty/);
    await rm(other, { recursive: true, force: true });
  });

  it('brings in remote edits, additions and deletions', async () => {
    gtm.remoteEdit('tag', 'GA4 - purchase', { paused: true });
    gtm.seed('trigger', { name: 'Remote new', type: 'pageview' });
    gtm.entities.variable = gtm.entities.variable.filter((v) => v.name !== 'DL - user_id');
    const result = await pullWorkspace(root, gtm, await state());
    expect(result.updated).toEqual(['tags/GA4 - purchase']);
    expect(result.added).toEqual(['triggers/Remote new']);
    expect(result.removed).toEqual(['variables/DL - user_id']);
    expect((await readJson('tags/GA4 - purchase.json')).paused).toBe(true);
    expect(await exists('variables/DL - user_id.json')).toBe(false);
  });

  it('keeps local edits when the remote did not change', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'local' });
    await pullWorkspace(root, gtm, await state());
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('local');
  });
});

describe.each(['bulk', 'sequential'] as const)('push (%s)', (strategy) => {
  it('pushes an edit and ends clean', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, parameter: [...tag.parameter, { type: 'TEMPLATE', key: 'currency', value: 'USD' }] });
    const result = await push(strategy);
    expect(result.pushed).toBe(1);
    expect(gtm.find('tag', 'GA4 - purchase')?.parameter).toContainEqual({ type: 'template', key: 'currency', value: 'USD' });
    await expectClean();
  });

  it('pushes edited code from a sidecar file', async () => {
    await writeFile(path.join(root, 'tags/cHTML - hello.html'), '<script>console.log("bye")</script>');
    await push(strategy);
    expect(gtm.find('tag', 'cHTML - hello')?.parameter).toEqual([{ type: 'template', key: 'html', value: '<script>console.log("bye")</script>' }]);
    await expectClean();
  });

  it('creates a new trigger, folder and tag that reference each other by name', async () => {
    await writeJson('folders.json', [{ name: 'GA4' }, { name: 'Ads' }]);
    await writeJson('triggers/CE - signup.json', { name: 'CE - signup', type: 'customEvent', customEventFilter: [] });
    await writeJson('tags/Ads - signup.json', { name: 'Ads - signup', type: 'awct', folder: 'Ads', firingTriggers: ['CE - signup', 'builtin:All Pages'] });
    await push(strategy);
    const trigger = gtm.find('trigger', 'CE - signup');
    const folder = gtm.find('folder', 'Ads');
    expect(gtm.find('tag', 'Ads - signup')).toMatchObject({ firingTriggerId: [trigger?.triggerId, '2147479553'], parentFolderId: folder?.folderId });
    const s = await state();
    expect(s.entities['tags/Ads - signup']?.id).toBe(gtm.find('tag', 'Ads - signup')?.tagId);
    await expectClean();
  });

  it('creates a template and a variable that uses it', async () => {
    await writeJson('templates/Upper/template.json', { name: 'Upper', sections: [{ section: 'INFO', file: 'info.json' }, { section: 'SANDBOXED_JS_FOR_WEB_TEMPLATE', file: 'code.js' }] });
    await writeFile(path.join(root, 'templates/Upper/info.json'), '{"type":"MACRO"}');
    await writeFile(path.join(root, 'templates/Upper/code.js'), 'return "X";');
    await writeJson('variables/Upper var.json', { name: 'Upper var', type: 'template:Upper' });
    await push(strategy);
    const template = gtm.find('template', 'Upper');
    expect(template?.templateData).toBe('___INFO___\n\n{"type":"MACRO"}\n\n\n___SANDBOXED_JS_FOR_WEB_TEMPLATE___\n\nreturn "X";\n\n\n');
    expect(gtm.find('variable', 'Upper var')?.type).toBe(`cvt_200_${template?.templateId}`);
    await expectClean();
  });

  it('deletes entities and folders, toggles built-ins', async () => {
    await rm(path.join(root, 'tags/cHTML - hello.json'));
    await rm(path.join(root, 'tags/cHTML - hello.html'));
    const tag = await readJson('tags/GA4 - purchase.json');
    const { folder: _f, ...unfoldered } = tag;
    await writeJson('tags/GA4 - purchase.json', unfoldered);
    await writeJson('folders.json', []);
    await writeJson('built-in-variables.json', ['PAGE_URL', 'CLICK_URL']);
    await push(strategy);
    expect(gtm.find('tag', 'cHTML - hello')).toBeUndefined();
    expect(gtm.find('folder', 'GA4')).toBeUndefined();
    expect([...gtm.builtIns].sort()).toEqual(['CLICK_URL', 'PAGE_URL']);
    await expectClean();
  });

  it('treats a renamed file with the same entity name as an update', async () => {
    await rename(path.join(root, 'variables/DL - user_id.json'), path.join(root, 'variables/user id.json'));
    const variable = await readJson('variables/user id.json');
    await writeJson('variables/user id.json', { ...variable, notes: 'moved' });
    const status = await workingStatus(root, await state());
    expect(status.changes.entities.map((c) => `${c.type} ${c.base} ${c.previousBase ?? ''}`)).toEqual(['updated variables/user id variables/DL - user_id']);
    await push(strategy);
    expect(gtm.entities.variable.filter((v) => v.name === 'DL - user_id')).toHaveLength(1);
    expect((await state()).entities['variables/user id']).toBeDefined();
    await expectClean();
  });

  it('renames an entity and its references in one push', async () => {
    const trigger = await readJson('triggers/CE - purchase.json');
    await writeJson('triggers/CE - purchase.json', { ...trigger, name: 'CE - order' });
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, firingTriggers: ['CE - order'] });
    const group = await readJson('triggers/TG - purchase group.json');
    group.parameter[0].list[0].value = 'CE - order';
    await writeJson('triggers/TG - purchase group.json', group);
    await push(strategy);
    expect(gtm.find('trigger', 'CE - order')?.triggerId).toBe('20');
    expect(gtm.find('tag', 'GA4 - purchase')?.firingTriggerId).toEqual(['20']);
    await expectClean();
  });
});

describe('push safety', () => {
  it('blocks on validation errors without calling the API', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, firingTriggers: ['Nope'] });
    gtm.calls = [];
    await expect(push()).rejects.toThrow(/unknown trigger "Nope"/);
    expect(gtm.calls).toEqual([]);
  });

  it('blocks on broken JSON', async () => {
    await writeFile(path.join(root, 'tags/GA4 - purchase.json'), '{');
    await expect(push()).rejects.toBeInstanceOf(PushBlockedError);
  });

  it('blocks when GTM changed an entity since the last pull', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'theirs' });
    // Push pulls first; the remote edit meets the local one and becomes a conflict. Nothing is sent.
    await expect(push()).rejects.toThrow(/tags\/GA4 - purchase: changed locally and in GTM/);
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('theirs');
    expect((await state()).conflicts).toEqual(['tags/GA4 - purchase']);
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('mine');
  });

  it('is a no-op when nothing changed', async () => {
    gtm.calls = [];
    expect((await push()).pushed).toBe(0);
    expect(gtm.calls).toEqual([]);
  });

  it('keeps unapplied work as local changes when the push fails', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'pending' });
    gtm.failBulk = true;
    await expect(push()).rejects.toThrow(/Push stopped/);
    const status = await workingStatus(root, await state());
    expect(status.changes.entities.map((c) => c.base)).toEqual(['tags/GA4 - purchase']);
  });
});

describe('conflicts', () => {
  beforeEach(async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'mine' });
    gtm.remoteEdit('tag', 'GA4 - purchase', { notes: 'theirs' });
    const result = await pullWorkspace(root, gtm, await state());
    expect(result.conflicts).toEqual(['tags/GA4 - purchase']);
  });

  it('keeps the local file and stores the remote copy', async () => {
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('mine');
    expect((await readJson('.gtm/remote/tags/GA4 - purchase.json')).notes).toBe('theirs');
    await expect(push()).rejects.toThrow(/unresolved conflict/);
  });

  it('Keep Mine lets the push overwrite GTM', async () => {
    await resolveConflict(root, await state(), 'tags/GA4 - purchase', 'mine');
    await push();
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('mine');
    await expectClean();
  });

  it('Take Theirs replaces the local file', async () => {
    await resolveConflict(root, await state(), 'tags/GA4 - purchase', 'theirs');
    expect((await readJson('tags/GA4 - purchase.json')).notes).toBe('theirs');
    await expectClean();
  });
});

describe('discard', () => {
  it('restores edited, added and deleted files', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'x' });
    await writeJson('triggers/New.json', { name: 'New', type: 'pageview' });
    await rm(path.join(root, 'variables/DL - user_id.json'));
    await writeJson('built-in-variables.json', []);
    expect(await discardChanges(root, await state())).toBe(5);
    await expectClean();
  });

  it('can discard a single entity', async () => {
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'x' });
    await writeJson('triggers/New.json', { name: 'New', type: 'pageview' });
    await discardChanges(root, await state(), ['triggers/New']);
    const status = await workingStatus(root, await state());
    expect(status.changes.entities.map((c) => c.base)).toEqual(['tags/GA4 - purchase']);
  });
});

describe('versions', () => {
  it('blocks protected containers before any API call', async () => {
    gtm.calls = [];
    await expect(createVersion(root, gtm, await state(), { name: 'v', notes: '', publish: true, protectedContainers: ['gtm-test123'] })).rejects.toBeInstanceOf(ProtectedContainerError);
    expect(gtm.calls).toEqual([]);
  });

  it('blocks when there are unpushed changes', async () => {
    await writeJson('triggers/New.json', { name: 'New', type: 'pageview' });
    await expect(createVersion(root, gtm, await state(), { name: 'v', notes: '', publish: false, protectedContainers: [] })).rejects.toThrow(/unpushed/);
  });

  it('creates and publishes a version, then follows GTM to the new workspace', async () => {
    const oldWorkspace = (await state()).workspace.workspaceId;
    const result = await createVersion(root, gtm, await state(), { name: 'v1', notes: 'n', publish: true, protectedContainers: ['GTM-OTHER'] });
    expect(result).toMatchObject({ versionId: '1', published: true });
    expect(gtm.versions).toEqual([{ id: '1', name: 'v1', published: true }]);
    const s = await state();
    expect(s.workspace.workspaceId).not.toBe(oldWorkspace);
    expect(s.workspace.workspaceId).toBe(gtm.workspace.workspaceId);
    await expectClean();
    const tag = await readJson('tags/GA4 - purchase.json');
    await writeJson('tags/GA4 - purchase.json', { ...tag, notes: 'after version' });
    await push();
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('after version');
  });

  it('publishes, then recreates the workspace by name when GTM does not replace it (other workspaces exist)', async () => {
    gtm.replaceWorkspaceOnVersion = false;
    const named = (await state()).workspace.name;
    const result = await createVersion(root, gtm, await state(), { name: 'v1', notes: '', publish: true, protectedContainers: [] });
    expect(result).toMatchObject({ versionId: '1', published: true });
    expect(gtm.versions[0]?.published).toBe(true);
    expect(gtm.calls).toContain(`createWorkspace ${named}`);
    expect((await state()).workspace.workspaceId).toBe(gtm.workspace.workspaceId);
    await expectClean();
  });

  it('still publishes when re-pointing the folder fails', async () => {
    gtm.replaceWorkspaceOnVersion = false;
    gtm.createWorkspace = async () => {
      throw new Error('workspace limit reached');
    };
    await expect(createVersion(root, gtm, await state(), { name: 'v1', notes: '', publish: true, protectedContainers: [] })).rejects.toThrow(
      /Version 1 was created and published, but switching this folder .*workspace limit reached/,
    );
    expect(gtm.versions[0]?.published).toBe(true);
  });

  it('publishes an existing version, but never on a protected container', async () => {
    gtm.calls = [];
    await expect(publishVersion(gtm, await state(), '1', ['GTM-TEST123'])).rejects.toBeInstanceOf(ProtectedContainerError);
    expect(gtm.calls).toEqual([]);
    await createVersion(root, gtm, await state(), { name: 'v1', notes: '', publish: false, protectedContainers: [] });
    await publishVersion(gtm, await state(), '1', []);
    expect(gtm.versions[0]?.published).toBe(true);
  });
});
