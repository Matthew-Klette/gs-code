import { describe, expect, it } from 'vitest';
import { builtInDisplayName, normalizeBuiltInType } from '../src/core/builtInNames';
import { validateModel } from '../src/core/mirror/validate';
import type { EntityDoc } from '../src/core/serialize/entityFiles';
import { VariableResolver, type EventContext } from '../src/debugger/variables';

const ctx = (model: Record<string, unknown> = {}): EventContext => ({
  event: 'gtm.click',
  model,
  pageUrl: 'https://shop.example/cart?x=1',
  containerPublicId: 'GTM-XXXXXXX',
  consent: {},
});

/** Built-in names exactly as a real pull stores them (lowerCamel types). */
const PULLED_WEB = { pageUrl: 'Page URL', pagePath: 'Page Path', clickUrl: 'Click URL', clickText: 'Click Text', event: 'Event', containerId: 'Container ID' };

describe('built-in variables use the API lowerCamel types', () => {
  it('resolves {{Page URL}}, {{Page Path}}, {{Click URL}} and {{Event}} from lowerCamel types', async () => {
    const resolver = new VariableResolver([], PULLED_WEB);
    const event = ctx({ event: 'gtm.click', gtm: { elementUrl: 'https://shop.example/out' } });
    expect(await resolver.resolve('Page URL', event)).toMatchObject({ value: 'https://shop.example/cart?x=1', known: true });
    expect(await resolver.resolve('Page Path', event)).toMatchObject({ value: '/cart', known: true });
    expect(await resolver.resolve('Click URL', event)).toMatchObject({ value: 'https://shop.example/out', known: true });
    expect(await resolver.resolve('Event', event)).toMatchObject({ value: 'gtm.click', known: true });
    expect(await resolver.resolve('Container ID', event)).toMatchObject({ value: 'GTM-XXXXXXX', known: true });
  });

  it('still accepts UPPER_SNAKE types from older mirrors', async () => {
    const resolver = new VariableResolver([], { PAGE_URL: 'Page URL', CLICK_URL: 'Click URL' });
    const event = ctx({ gtm: { elementUrl: 'https://shop.example/out' } });
    expect(await resolver.resolve('Page URL', event)).toMatchObject({ value: 'https://shop.example/cart?x=1', known: true });
    expect(await resolver.resolve('Click URL', event)).toMatchObject({ value: 'https://shop.example/out', known: true });
  });

  it('auto-event TEXT variables read the clicked element text', async () => {
    const aev: EntityDoc = { kind: 'variable', base: 'variables/aev', data: { name: 'AEV text', type: 'aev', parameter: [{ key: 'varType', value: 'TEXT' }] } };
    const resolver = new VariableResolver([aev], PULLED_WEB);
    const event = ctx({ gtm: { element: { __element: { text: 'Buy now' } } } });
    expect(await resolver.resolve('AEV text', event)).toMatchObject({ value: 'Buy now', known: true });
    expect(await resolver.resolve('Click Text', event)).toMatchObject({ value: 'Buy now', known: true });
  });

  it('normalises UPPER_SNAKE and leaves lowerCamel alone', () => {
    expect(normalizeBuiltInType('PAGE_URL')).toBe('pageUrl');
    expect(normalizeBuiltInType('ELEMENT_VISIBILITY_RATIO')).toBe('elementVisibilityRatio');
    expect(normalizeBuiltInType('clickUrl')).toBe('clickUrl');
  });
});

describe('validation knows built-ins enabled since the last pull', () => {
  const tag = (value: string): EntityDoc => ({ kind: 'tag', base: 'tags/a', data: { name: 'A', type: 'html', parameter: [{ key: 'html', value }] } });

  it('accepts {{Click URL}} when clickUrl was just added to built-in-variables.json', () => {
    const docs = new Map([['tags/a', tag('{{Click URL}} {{Event Name}}')]]);
    const issues = validateModel({ docs, folders: [], builtIns: ['pageUrl', 'clickUrl', 'eventName'] }, new Map([['pageUrl', 'Page URL']]));
    expect(issues).toEqual([]);
  });

  it('still flags a built-in that is not enabled', () => {
    const docs = new Map([['tags/a', tag('{{Click URL}}')]]);
    const issues = validateModel({ docs, folders: [], builtIns: ['pageUrl'] }, new Map([['pageUrl', 'Page URL']]));
    expect(issues.map((issue) => issue.message)).toEqual([
      '{{Click URL}} is not a variable or enabled built-in in this workspace (renamed or deleted? enable it in built-in-variables.json)',
    ]);
  });

  it('flags a user variable clashing with a locally enabled built-in', () => {
    const docs = new Map([['variables/c', { kind: 'variable' as const, base: 'variables/c', data: { name: 'Click URL', type: 'v' } }]]);
    const issues = validateModel({ docs, folders: [], builtIns: ['clickUrl'] }, new Map());
    expect(issues.map((issue) => issue.message)).toEqual(['variable name "Click URL" is already used by an enabled built-in variable']);
  });

  it('prefers the pulled display name over the static table', () => {
    expect(builtInDisplayName('pageUrl', new Map([['pageUrl', 'Seite URL']]))).toBe('Seite URL');
    expect(builtInDisplayName('pageUrl', new Map())).toBe('Page URL');
    expect(builtInDisplayName('PAGE_URL', new Map())).toBe('Page URL');
    expect(builtInDisplayName('somethingNew', new Map())).toBeUndefined();
  });
});

describe('regex tables with a broken pattern', () => {
  it('reports the invalid row instead of "no row matched"', async () => {
    const table: EntityDoc = {
      kind: 'variable',
      base: 'variables/re',
      data: {
        name: 'RE',
        type: 'remm',
        parameter: [
          { key: 'input', value: '{{_event}}' },
          { key: 'map', list: [{ map: [{ key: 'key', value: 'gtm.(click' }, { key: 'value', value: 'x' }] }] },
        ],
      },
    };
    const resolved = await new VariableResolver([table], {}).resolve('RE', ctx());
    expect(resolved.known).toBe(false);
    expect(resolved.source).toMatch(/^invalid regex in row "gtm\.\(click"/);
  });
});
