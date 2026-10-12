import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState } from '../src/core/mirror/state';
import { workingStatus } from '../src/core/ops/plan';
import { pullWorkspace } from '../src/core/ops/pull';
import { initMirror, tidyFileNames } from '../src/core/ops/workspace';
import { CONTAINER, seededFake, type FakeGtm } from './fakeApi';

let mine: string;
let clone: string;
let gtm: FakeGtm;

const readJson = async (root: string, rel: string) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));
const exists = (root: string, rel: string) => access(path.join(root, rel)).then(() => true, () => false);

beforeEach(async () => {
  mine = await mkdtemp(path.join(tmpdir(), 'gscode-team-a-'));
  clone = await mkdtemp(path.join(tmpdir(), 'gscode-team-b-'));
  gtm = seededFake();
  await initMirror(mine, gtm, CONTAINER, gtm.workspace);
});

afterEach(async () => {
  await rm(mine, { recursive: true, force: true });
  await rm(clone, { recursive: true, force: true });
});

/** What a teammate gets from `git clone`: the files, without .gtm/ (it is gitignored). */
async function gitClone(): Promise<void> {
  await cp(mine, clone, { recursive: true, filter: (src) => !src.split(path.sep).includes('.gtm') });
}

describe('sharing a mirror through git', () => {
  it('writes a .gitignore that keeps .gtm/ out of the repository', async () => {
    expect(await readFile(path.join(mine, '.gitignore'), 'utf8')).toContain('.gtm/');
  });

  it('a clone adopts the files: same names, clean when nothing differs', async () => {
    await gitClone();
    const theirs = await gtm.createWorkspace('100', '200', 'teammate');
    await initMirror(clone, gtm, CONTAINER, theirs, { adopt: true });
    const status = await workingStatus(clone, await readState(clone));
    expect(status.changes.entities).toEqual([]);
    expect((await readState(clone)).entities['tags/GA4 - purchase']).toBeDefined();
  });

  it('a committed edit that is not in GTM yet shows as the teammate\'s change', async () => {
    const tag = await readJson(mine, 'tags/GA4 - purchase.json');
    await writeFile(path.join(mine, 'tags/GA4 - purchase.json'), JSON.stringify({ ...tag, notes: 'from git' }, null, 2));
    await gitClone();
    const theirs = await gtm.createWorkspace('100', '200', 'teammate');
    await initMirror(clone, gtm, CONTAINER, theirs, { adopt: true });
    const status = await workingStatus(clone, await readState(clone));
    expect(status.changes.entities.map((change) => `${change.type} ${change.base}`)).toEqual(['updated tags/GA4 - purchase']);
    expect((await readJson(clone, 'tags/GA4 - purchase.json')).notes).toBe('from git');
  });

  it('without --adopt a non-empty folder is refused', async () => {
    await gitClone();
    await expect(initMirror(clone, gtm, CONTAINER, gtm.workspace)).rejects.toThrow(/--adopt/);
  });
});

describe('tidy', () => {
  it('renames a file after its entity was renamed in GTM', async () => {
    gtm.remoteEdit('tag', 'GA4 - purchase', { name: 'GA4 - order' });
    await pullWorkspace(mine, gtm, await readState(mine));
    expect(await exists(mine, 'tags/GA4 - purchase.json')).toBe(true);
    const { renamed } = await tidyFileNames(mine, await readState(mine));
    expect(renamed).toEqual([['tags/GA4 - purchase', 'tags/GA4 - order']]);
    expect((await readJson(mine, 'tags/GA4 - order.json')).name).toBe('GA4 - order');
    expect(await exists(mine, 'tags/GA4 - purchase.json')).toBe(false);
    expect((await workingStatus(mine, await readState(mine))).changes.entities).toEqual([]);
  });
});

