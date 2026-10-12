import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allocateBase, safeFileName } from '../src/core/mirror/layout';
import { readModel, writeDoc } from '../src/core/mirror/model';
import { canonicalJson } from '../src/core/serialize/canonical';
import { parsePlain, renderFiles, toApiBody, toLocalData, type EntityDoc } from '../src/core/serialize/entityFiles';
import { buildRefContext, collectTriggerReferences, mapTriggerReferences, templateType } from '../src/core/serialize/references';
import { joinTemplateData, sectionFileNames, sectionForFile, splitTemplateData } from '../src/core/serialize/templateData';
import { seededFake } from './fakeApi';

const TEMPLATE =
  '___TERMS_OF_SERVICE___\n\nBy creating...\n\n\n___INFO___\n\n{\n  "type": "TAG"\n}\n\n\n___SANDBOXED_JS_FOR_SERVER___\n\nconst x = 1;\ndata.gtmOnSuccess();\n\n\n___NOTES___\n\n\n\n\n';

describe('templateData', () => {
  it('splits sections without the separator whitespace', () => {
    const sections = splitTemplateData(TEMPLATE);
    expect(sections.map((s) => s.section)).toEqual(['TERMS_OF_SERVICE', 'INFO', 'SANDBOXED_JS_FOR_SERVER', 'NOTES']);
    expect(sections[2]?.content).toBe('const x = 1;\ndata.gtmOnSuccess();');
    expect(sections[3]?.content).toBe('');
  });

  it('round-trips byte for byte', () => {
    expect(joinTemplateData(splitTemplateData(TEMPLATE))).toBe(TEMPLATE);
  });

  it('normalizes CRLF input', () => {
    const crlf = TEMPLATE.replace(/\n/g, '\r\n');
    expect(joinTemplateData(splitTemplateData(crlf))).toBe(TEMPLATE);
  });

  it('tolerates non-standard spacing', () => {
    expect(splitTemplateData('___INFO___\n{}\n___NOTES___\nhi')).toEqual([
      { section: 'INFO', content: '{}' },
      { section: 'NOTES', content: 'hi' },
    ]);
  });

  it('maps sections to unique file names and back', () => {
    const names = sectionFileNames(['INFO', 'SANDBOXED_JS_FOR_SERVER', 'SERVER_PERMISSIONS', 'CUSTOM_THING']);
    expect([...names.values()]).toEqual(['info.json', 'code.js', 'permissions.json', 'custom_thing.txt']);
    expect(sectionForFile('code.js', true)).toBe('SANDBOXED_JS_FOR_SERVER');
    expect(sectionForFile('code.js', false)).toBe('SANDBOXED_JS_FOR_WEB_TEMPLATE');
    expect(sectionForFile('permissions.json', false)).toBe('WEB_PERMISSIONS');
    expect(sectionForFile('random.txt', false)).toBeUndefined();
  });

  it('keeps names unique when two sections want the same file', () => {
    const names = sectionFileNames(['SANDBOXED_JS_FOR_WEB_TEMPLATE', 'SANDBOXED_JS_FOR_SERVER']);
    expect([...names.values()]).toEqual(['code.js', 'sandboxed_js_for_server.js']);
  });
});

describe('references', () => {
  const gtm = seededFake();
  const snapshot = { entities: gtm.entities, builtInVariables: [] };
  const ctx = buildRefContext('200', snapshot);

  it('names triggers, folders and template types', () => {
    const tag = toLocalData('tag', gtm.find('tag', 'GA4 - purchase')!, ctx);
    expect(tag).toMatchObject({ name: 'GA4 - purchase', type: 'gaawe', firingTriggers: ['CE - purchase'], folder: 'GA4' });
    expect(tag).not.toHaveProperty('tagId');
    expect(tag).not.toHaveProperty('fingerprint');
    const variable = toLocalData('variable', gtm.find('variable', 'Hashed email')!, ctx);
    expect(variable.type).toBe('template:Hash Email');
  });

  it('encodes built-in and unknown trigger ids', () => {
    const tag = toLocalData('tag', { name: 't', type: 'html', firingTriggerId: ['2147479553', '999'] }, ctx);
    expect(tag.firingTriggers).toEqual(['builtin:All Pages', '#999']);
  });

  it('names TRIGGER_REFERENCE values inside trigger groups', () => {
    const group = toLocalData('trigger', gtm.find('trigger', 'TG - purchase group')!, ctx);
    expect(collectTriggerReferences(group.parameter)).toEqual(['CE - purchase']);
  });

  it('round-trips local data back to the same API body', () => {
    const lookup = {
      triggerIds: new Map([['CE - purchase', '20']]),
      folderIds: new Map([['GA4', '1']]),
      templateTypes: new Map([['Hash Email', 'cvt_200_50']]),
    };
    for (const [kind, name] of [['tag', 'GA4 - purchase'], ['trigger', 'TG - purchase group'], ['variable', 'Hashed email'], ['tag', 'cHTML - hello']] as const) {
      const api = gtm.find(kind, name)!;
      const local = toLocalData(kind, api, ctx);
      const { body, unresolved } = toApiBody({ kind, base: 'x', data: local }, lookup);
      expect(unresolved).toEqual([]);
      const strip = ({ fingerprint, path: _p, accountId, containerId, workspaceId, tagId, triggerId, variableId, ...rest }: Record<string, unknown>) => rest;
      expect(canonicalJson(body)).toBe(canonicalJson(strip(api)));
    }
  });

  it('reports unresolved names instead of sending them', () => {
    const empty = { triggerIds: new Map(), folderIds: new Map(), templateTypes: new Map() };
    const { unresolved } = toApiBody({ kind: 'tag', base: 'x', data: { name: 't', type: 'template:Nope', firingTriggers: ['Missing'], folder: 'Gone' } }, empty);
    expect(unresolved.map((item) => item.field)).toEqual(['type', 'firingTriggers', 'folder']);
  });

  it('uses gallery ids for gallery template types', () => {
    expect(templateType('200', { templateId: '9', galleryReference: { galleryTemplateId: 'MBTSV' } })).toBe('cvt_MBTSV');
    expect(templateType('200', { templateId: '9' })).toBe('cvt_200_9');
  });

  it('handles the REST API spelling triggerReference too', () => {
    const tree = [{ type: 'list', key: 'triggerIds', list: [{ type: 'triggerReference', value: '20' }] }];
    expect(collectTriggerReferences(tree)).toEqual(['20']);
    expect(mapTriggerReferences(tree, () => 'CE - purchase')).toEqual([{ type: 'list', key: 'triggerIds', list: [{ type: 'triggerReference', value: 'CE - purchase' }] }]);
  });

  it('mapTriggerReferences leaves non-reference values alone', () => {
    const tree = [{ type: 'TEMPLATE', value: '20' }, { type: 'TRIGGER_REFERENCE', value: '20' }];
    expect(mapTriggerReferences(tree, () => 'X')).toEqual([{ type: 'TEMPLATE', value: '20' }, { type: 'TRIGGER_REFERENCE', value: 'X' }]);
  });
});

describe('files on disk', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gscode-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes custom HTML to a sidecar file and reads it back', async () => {
    const doc: EntityDoc = { kind: 'tag', base: 'tags/cHTML - hello', data: { name: 'cHTML - hello', type: 'html', parameter: [{ type: 'TEMPLATE', key: 'html', value: '<script>1</script>' }] } };
    await writeDoc(root, doc);
    expect(await readFile(path.join(root, 'tags/cHTML - hello.html'), 'utf8')).toBe('<script>1</script>');
    const json = JSON.parse(await readFile(path.join(root, 'tags/cHTML - hello.json'), 'utf8'));
    expect(json.parameter[0]).toEqual({ type: 'TEMPLATE', key: 'html', valueFile: 'cHTML - hello.html' });
    const read = await parsePlain('tag', doc.base, async (rel) => readFile(path.join(root, rel), 'utf8').catch(() => undefined));
    expect(read.data).toEqual(doc.data);
  });

  it('writes templates as a folder of section files', async () => {
    const doc: EntityDoc = { kind: 'template', base: 'templates/T', data: { name: 'T', sections: splitTemplateData(TEMPLATE) } };
    expect([...renderFiles(doc).keys()].sort()).toEqual(['templates/T/code.js', 'templates/T/info.json', 'templates/T/notes.md', 'templates/T/template.json', 'templates/T/terms.txt']);
    await writeDoc(root, doc);
    const { model, problems } = await readModel(root, true);
    expect(problems).toEqual([]);
    expect(model.docs.get('templates/T')?.data).toEqual(doc.data);
  });

  it('reads a hand-made template folder without a manifest', async () => {
    await writeDoc(root, { kind: 'template', base: 'templates/New', data: { name: 'New', sections: [{ section: 'SANDBOXED_JS_FOR_WEB_TEMPLATE', content: 'return 1;' }, { section: 'INFO', content: '{}' }] } });
    await rm(path.join(root, 'templates/New/template.json'));
    const { model } = await readModel(root, false);
    expect(model.docs.get('templates/New')?.data).toEqual({ name: 'New', sections: [{ section: 'INFO', content: '{}' }, { section: 'SANDBOXED_JS_FOR_WEB_TEMPLATE', content: 'return 1;' }] });
  });

  it('reports broken JSON as a problem instead of throwing', async () => {
    await writeDoc(root, { kind: 'tag', base: 'tags/ok', data: { name: 'ok', type: 'html' } });
    await writeFile(path.join(root, 'tags/bad.json'), '{ nope');
    const { model, problems } = await readModel(root, false);
    expect(model.docs.has('tags/ok')).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe('tags/bad.json');
  });

  it('reports a missing sidecar', async () => {
    await writeDoc(root, { kind: 'tag', base: 'tags/x', data: { name: 'x', type: 'html', parameter: [{ key: 'html', type: 'TEMPLATE', value: 'a' }] } });
    await rm(path.join(root, 'tags/x.html'));
    const { problems } = await readModel(root, false);
    expect(problems[0]?.message).toMatch(/valueFile/);
  });
});

describe('layout', () => {
  it('makes names safe for every OS', () => {
    expect(safeFileName('GA4 / purchase: "test"?')).toBe('GA4 _ purchase_ _test__');
    expect(safeFileName('  trailing dots... ')).toBe('trailing dots');
    expect(safeFileName('')).toBe('_');
    expect(safeFileName('x'.repeat(300))).toHaveLength(120);
  });

  it('avoids case-insensitive collisions', () => {
    const taken = new Set(['tags/ga4 event']);
    expect(allocateBase('tag', 'GA4 Event', '5', taken)).toBe('tags/GA4 Event (5)');
    expect(allocateBase('tag', 'GA4 Event', '5', new Set([...taken, 'tags/ga4 event (5)']))).toBe('tags/GA4 Event (5) 2');
    expect(allocateBase('trigger', 'GA4 Event', '5', taken)).toBe('triggers/GA4 Event');
  });
});

describe('validate', () => {
  it('flags unknown refs, duplicates and folders but not internal macros', async () => {
    const { validateModel } = await import('../src/core/mirror/validate');
    const docs = new Map([
      ['tags/a', { kind: 'tag' as const, base: 'tags/a', data: { name: 'A', type: 'html', firingTriggers: ['T'], folder: 'F', setupTag: [{ tagName: 'Missing' }], parameter: [{ key: 'x', value: '{{_event}} {{Unknown}} {{Page URL}}' }] } }],
      ['tags/b', { kind: 'tag' as const, base: 'tags/b', data: { name: 'A', type: 'template:Nope' } }],
      ['triggers/t', { kind: 'trigger' as const, base: 'triggers/t', data: { name: 'T', type: 'pageview' } }],
    ]);
    const issues = validateModel({ docs, folders: [{ name: 'G' }, { name: 'G' }], builtIns: ['PAGE_URL'] }, new Map([['PAGE_URL', 'Page URL']]));
    expect(issues.map((i) => `${i.severity} ${i.path} ${i.message}`).sort()).toEqual([
      'error folders.json duplicate folder "G"',
      'error tags/a.json setupTag references unknown tag "Missing"',
      'error tags/a.json unknown folder "F" (add it to folders.json)',
      'error tags/b.json duplicate tag name "A" (also in tags/a)',
      'error tags/b.json unknown template "Nope"',
      'warning tags/a.json {{Unknown}} is not a variable or enabled built-in in this workspace',
    ]);
  });
});
