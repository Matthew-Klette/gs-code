import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_DIR } from '../src/core/mirror/layout';
import { readState } from '../src/core/mirror/state';
import { workingStatus } from '../src/core/ops/plan';
import { PushBlockedError, pushWorkspace } from '../src/core/ops/push';
import { initMirror } from '../src/core/ops/workspace';
import { CONTAINER, seededFake, type FakeGtm } from './fakeApi';

const BASE_TAG = path.join(BASE_DIR, 'tags', 'GA4 - purchase.json');
// chmod 000 can't make a file unreadable for root, and does nothing on Windows.
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;

let root: string;
let gtm: FakeGtm;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-plan-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
});

afterEach(async () => {
  await chmod(path.join(root, BASE_TAG), 0o644).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe.runIf(canDenyRead)('unreadable base files', () => {
  it('report a .gtm/base problem and block push instead of creating a duplicate', async () => {
    await chmod(path.join(root, BASE_TAG), 0o000);
    const state = await readState(root);

    const status = await workingStatus(root, state);
    expect(status.problems.map((problem) => problem.path)).toContain(`${BASE_DIR}/tags/GA4 - purchase.json`);

    const tagsBefore = gtm.entities.tag.length;
    const callsBefore = gtm.calls.length;
    await expect(pushWorkspace(root, gtm, state, { strategy: 'bulk' })).rejects.toBeInstanceOf(PushBlockedError);
    expect(gtm.entities.tag).toHaveLength(tagsBefore);
    expect(gtm.calls.slice(callsBefore).filter((call) => /bulk|create|update/i.test(call))).toEqual([]);
  });
});
