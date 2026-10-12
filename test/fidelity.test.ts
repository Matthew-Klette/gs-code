import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explainError } from '../src/core/api';
import { readState } from '../src/core/mirror/state';
import { pushWorkspace } from '../src/core/ops/push';
import { assertSupportedContainer, initMirror } from '../src/core/ops/workspace';
import { exportEnumToApi, normalizeEnums, toApiBody, toLocalData } from '../src/core/serialize/entityFiles';
import { buildRefContext } from '../src/core/serialize/references';
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
  root = await mkdtemp(path.join(tmpdir(), 'gscode-fidelity-'));
  gtm = seededFake();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('export-style enums', () => {
  it('maps UPPER_SNAKE to the API spelling and leaves everything else alone', () => {
    expect(exportEnumToApi('TRIGGER_REFERENCE')).toBe('triggerReference');
    expect(exportEnumToApi('MATCH_REGEX')).toBe('matchRegex');
    expect(exportEnumToApi('TEMPLATE')).toBe('template');
    expect(exportEnumToApi('gaawe')).toBe('gaawe');
    expect(exportEnumToApi('cvt_200_50')).toBe('cvt_200_50');
  });

  it('normalises parameters, conditions and a trigger type, never names or values', () => {
    const body = normalizeEnums('trigger', {
      name: 'CUSTOM_EVENT',
      type: 'CUSTOM_EVENT',
      customEventFilter: [{ type: 'EQUALS', parameter: [{ type: 'TEMPLATE', key: 'arg0', value: 'MY_EVENT' }] }],
    });
    expect(body).toEqual({
      name: 'CUSTOM_EVENT',
      type: 'customEvent',
      customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: 'MY_EVENT' }] }],
    });
    expect(normalizeEnums('tag', { name: 'x', type: 'HTML_LIKE' }).type).toBe('HTML_LIKE');
  });
});

describe('template-based entities', () => {
  it('keeps GTM\'s container-scoped type for a gallery template when the tag is edited', async () => {
    gtm.seed('template', { templateId: '60', name: 'Gallery tmpl', templateData: '___INFO___\n\n{}\n\n\n', galleryReference: { galleryTemplateId: 'abc123' } });
    gtm.seed('tag', { tagId: '70', name: 'Uses gallery', type: 'cvt_200_60', firingTriggerId: [] });
    await initMirror(root, gtm, CONTAINER, gtm.workspace);
    const tag = await readJson('tags/Uses gallery.json');
    expect(tag.type).toBe('template:Gallery tmpl');
    await writeJson('tags/Uses gallery.json', { ...tag, notes: 'edited' });
    await pushWorkspace(root, gtm, await readState(root));
    expect(gtm.find('tag', 'Uses gallery')).toMatchObject({ type: 'cvt_200_60', notes: 'edited' });
  });

  it('round-trips template fields it does not know about', () => {
    const entity = { templateId: '9', name: 'T', templateData: '___INFO___\n\n{}\n\n\n', futureField: { x: 1 } };
    const local = toLocalData('template', entity, buildRefContext('200', { entities: { folder: [], template: [], variable: [], trigger: [], tag: [], client: [], transformation: [], zone: [], gtagConfig: [] }, builtInVariables: [] }));
    expect(local.futureField).toEqual({ x: 1 });
    const { body } = toApiBody({ kind: 'template', base: 'templates/T', data: local }, { triggerIds: new Map(), folderIds: new Map(), templateTypes: new Map() });
    expect(body).toMatchObject({ name: 'T', futureField: { x: 1 } });
  });
});

describe('containers and errors', () => {
  it('refuses mobile and AMP containers up front', () => {
    expect(() => assertSupportedContainer({ ...CONTAINER, usageContext: ['android'] })).toThrow(/web and server containers only/);
    expect(() => assertSupportedContainer({ ...CONTAINER, usageContext: ['amp'] })).toThrow(/amp/);
    expect(() => assertSupportedContainer({ ...CONTAINER, usageContext: ['server'] })).not.toThrow();
  });

  it('explains the errors people actually hit', () => {
    expect(explainError('GET', 'accounts', 403, 'Tag Manager API has not been used in project 123 before or it is disabled')).toMatch(/not enabled/);
    expect(explainError('POST', 'accounts/1/containers/2/versions/3:publish', 403, 'Request had insufficient authentication scopes.')).toMatch(/no publish permission/);
    expect(explainError('POST', 'accounts/1/containers/2/workspaces/3/bulk_update', 403, 'The caller does not have permission')).toMatch(/needs Edit permission/);
    expect(explainError('POST', 'accounts/1/containers/2/workspaces', 400, 'Maximum number of workspaces reached')).toMatch(/3 on free GTM/);
    expect(explainError('POST', 'accounts/1/containers/2/workspaces/3/bulk_update', 400, 'Invalid value')).toMatch(/sequential/);
    expect(explainError('GET', 'x', 500, 'boom')).toBeUndefined();
  });
});
