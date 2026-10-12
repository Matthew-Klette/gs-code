import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { readState } from '../src/core/mirror/state';
import { initMirror } from '../src/core/ops/workspace';
import { findBrowser } from '../src/debugger/browser';
import { CdpConnection } from '../src/debugger/cdp';
import { getPath, mergePush } from '../src/debugger/dataModel';
import { compare, Explainer } from '../src/debugger/explain';
import { classifyHit, decodeGcs } from '../src/debugger/hits';
import { loadMirrorDocs, predictClient, resolveWorkspacePreview } from '../src/debugger/mirrorContext';
import { probeSource } from '../src/debugger/probe';
import { draftUrl } from '../src/debugger/session';
import { Timeline, type ProbeMessage } from '../src/debugger/timeline';
import type { EventContext } from '../src/debugger/variables';
import { CONTAINER, seededFake } from './fakeApi';

/** A tiny fake page: the probe runs in it exactly as it would in Chrome, minus the DOM. */
function fakePage() {
  const messages: ProbeMessage[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const context: Record<string, unknown> = {
    location: { href: 'https://shop.example/checkout' },
    document: { title: 'Checkout' },
    addEventListener: (type: string, fn: () => void) => (listeners[type] = [...(listeners[type] ?? []), fn]),
    __gsCodeEmit: (text: string) => messages.push(JSON.parse(text) as ProbeMessage),
  };
  vm.createContext(context);
  vm.runInContext(probeSource({ binding: '__gsCodeEmit', dataLayerName: 'dataLayer', tagStatus: true }), context);
  const run = (code: string) => vm.runInContext(code, context);
  const fire = (type: string) => (listeners[type] ?? []).forEach((fn) => fn());
  return { messages, run, fire, context };
}

/** What GTM does when it loads: replaces push, stamps uniqueEventId, calls eventCallback with tag results. */
const LOAD_GTM = `
  window.google_tag_manager = { 'GTM-TEST123': {} };
  window.google_tag_data = { ics: { entries: { ad_storage: { default: false }, analytics_storage: { default: false, update: true } } } };
  var n = 0;
  window.dataLayer.push = function () {
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        o['gtm.uniqueEventId'] = ++n;
        if (typeof o.eventCallback === 'function') o.eventCallback('GTM-TEST123', { tags: [{ id: '30', status: 'success', executionTime: 4 }] });
      }
      Array.prototype.push.call(window.dataLayer, o);
    }
  };
`.replace(/window\./g, 'globalThis.');

describe('page probe', () => {
  it('records pushes made before GTM loads and after it replaces push, with ids and tag status', () => {
    const page = fakePage();
    page.run(`globalThis.dataLayer = globalThis.dataLayer || []; dataLayer.push({ event: 'early', user: { id: 1 } });`);
    page.run(LOAD_GTM);
    let siteCallback = 0;
    page.context.siteCallback = () => siteCallback++;
    page.run(`dataLayer.push({ event: 'purchase', ecommerce: { value: 10 }, eventCallback: siteCallback });`);
    const pushes = page.messages.filter((m) => m.type === 'push');
    expect(pushes.map((m) => m.event)).toEqual(['early', 'purchase']);
    expect(pushes[1]?.uniqueEventId).toBe(1);
    const tags = page.messages.find((m) => m.type === 'tags');
    expect(tags).toMatchObject({ seq: pushes[1]?.seq, containerId: 'GTM-TEST123', eventData: { tags: [{ id: '30', status: 'success' }] } });
    expect(siteCallback).toBe(1); // the site's own callback still runs
    expect(page.messages.find((m) => m.type === 'consent')).toMatchObject({ state: { analytics_storage: { default: false, update: true } } });
    expect(page.messages.find((m) => m.type === 'containers')).toMatchObject({ ids: ['GTM-TEST123'] });
  });

  it('survives the page reassigning window.dataLayer and records gtag() commands', () => {
    const page = fakePage();
    page.run(`globalThis.dataLayer = [{ event: 'from snippet' }];`);
    page.run(`function gtag(){ dataLayer.push(arguments); } gtag('consent', 'default', { ad_storage: 'denied' });`);
    const pushes = page.messages.filter((m) => m.type === 'push');
    expect(pushes[0]).toMatchObject({ event: 'from snippet', source: 'initial' });
    expect(pushes[1]?.command).toEqual(['consent', 'default', { ad_storage: 'denied' }]);
  });

  it('never throws into the page, even for circular or huge values', () => {
    const page = fakePage();
    page.run(`globalThis.dataLayer = []; var a = { big: 'x'.repeat(5000) }; a.self = a; dataLayer.push({ event: 'weird', a: a, f: function named() {} });`);
    const push = page.messages.find((m) => m.type === 'push') as ProbeMessage & { data: any };
    expect(push.data.a.self).toEqual({ __circular: true });
    expect(push.data.a.big.length).toBeLessThan(2100);
    expect(push.data.f).toEqual({ __function: 'named' });
  });
});

describe('data model', () => {
  it('merges like GTM: objects and arrays recursively, dotted keys as paths, callbacks dropped', () => {
    let model = mergePush({}, { ecommerce: { items: [{ id: 'a', price: 1 }, { id: 'b' }] }, eventCallback: { __function: 'x' } });
    model = mergePush(model, { ecommerce: { items: [{ id: 'c' }] } });
    expect(getPath(model, 'ecommerce.items')).toEqual([{ id: 'c', price: 1 }, { id: 'b' }]);
    model = mergePush(model, { ecommerce: null, 'user.tier': 'gold' });
    expect(model.ecommerce).toBeNull();
    expect(getPath(model, 'user.tier')).toBe('gold');
    expect(model.eventCallback).toBeUndefined();
  });
});

describe('hits', () => {
  it('classifies GA4 (batched), Meta, Ads and a first-party server container', () => {
    const ga4 = classifyHit('https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC&gcs=G101', 'POST', 'en=page_view\r\nen=purchase&ep.value=10', 1);
    expect(ga4).toMatchObject({ vendor: 'ga4', id: 'G-ABC', name: 'page_view', firstParty: false });
    expect(ga4?.events.map((e) => e.en)).toEqual(['page_view', 'purchase']);
    expect(classifyHit('https://www.facebook.com/tr/?id=123&ev=Purchase', 'GET', undefined, 1)).toMatchObject({ vendor: 'meta', id: '123', name: 'Purchase' });
    expect(classifyHit('https://googleads.g.doubleclick.net/pagead/viewthroughconversion/987/?label=abc', 'GET', undefined, 1)).toMatchObject({ vendor: 'google-ads', id: '987' });
    expect(classifyHit('https://sgtm.shop.example/g/collect?tid=G-ABC&en=purchase', 'POST', undefined, 1)).toMatchObject({ vendor: 'ga4', firstParty: true });
    expect(classifyHit('https://data.shop.example/data?e=1', 'POST', '{"event":"x"}', 1, { sgtmHosts: ['shop.example'] })).toMatchObject({ vendor: 'sgtm', firstParty: true });
    expect(classifyHit('https://shop.example/app.js', 'GET', undefined, 1)).toBeUndefined();
    expect(decodeGcs('G101')).toEqual({ adStorage: false, analyticsStorage: true });
  });
});

describe('draft workspace preview', () => {
  const preview = { publicId: 'GTM-TEST123', gtmAuth: 'AUTH', gtmPreview: 'env-9' };
  it('rewrites only this container\'s gtm.js, dropping gtm_cookies_win', () => {
    const url = draftUrl('https://www.googletagmanager.com/gtm.js?id=GTM-TEST123&l=dataLayer&gtm_cookies_win=x', preview, []);
    expect(url).toContain('gtm_auth=AUTH');
    expect(url).toContain('gtm_preview=env-9');
    expect(url).not.toContain('gtm_cookies_win');
    expect(draftUrl('https://www.googletagmanager.com/gtm.js?id=GTM-OTHER', preview, [])).toBeUndefined();
  });

  it('sends a custom loader to googletagmanager.com', () => {
    const url = draftUrl('https://shop.example/abcd.js?st=xyz&l=myLayer', preview, ['https://shop.example/abcd.js*']);
    expect(url).toMatch(/^https:\/\/www\.googletagmanager\.com\/gtm\.js\?id=GTM-TEST123&l=myLayer&gtm_auth=AUTH&gtm_preview=env-9$/);
  });

  it('gets the workspace preview environment from the API after quick_preview', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gscode-dbg-'));
    const gtm = seededFake();
    await initMirror(root, gtm, CONTAINER, gtm.workspace);
    await expect(resolveWorkspacePreview(gtm, await readState(root))).resolves.toEqual({ publicId: 'GTM-TEST123', gtmAuth: 'auth-preview', gtmPreview: 'env-9' });
    gtm.compilerError = true;
    await expect(resolveWorkspacePreview(gtm, await readState(root))).rejects.toThrow(/cannot compile/);
    await rm(root, { recursive: true, force: true });
  });
});

describe('explanations', () => {
  let root: string;
  let explainer: Explainer;
  const ctx = (event: string, model: Record<string, unknown> = {}, consent: Record<string, boolean> = {}): EventContext => ({
    event,
    model: { event, ...model },
    pageUrl: 'https://shop.example/checkout?step=2',
    containerPublicId: 'GTM-TEST123',
    consent,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gscode-explain-'));
    const gtm = seededFake();
    await initMirror(root, gtm, CONTAINER, gtm.workspace);
    explainer = new Explainer(await loadMirrorDocs(root, await readState(root)));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('says which trigger fires a tag', async () => {
    const result = await explainer.explainTag('GA4 - purchase', ctx('purchase'));
    expect(result).toMatchObject({ verdict: 'fires', summary: 'Fires on "CE - purchase".', file: 'tags/GA4 - purchase.json' });
  });

  it('says why it does not fire, with the trigger file and the compared value', async () => {
    const result = await explainer.explainTag('GA4 - purchase', ctx('add_to_cart'));
    expect(result?.verdict).toBe('does-not-fire');
    expect(result?.summary).toMatch(/CE - purchase.*add_to_cart/);
    expect(result?.firing[0]?.file).toBe('triggers/CE - purchase.json');
  });

  it('knows the built-in All Pages trigger', async () => {
    const result = await explainer.explainTag('cHTML - hello', ctx('gtm.js'));
    expect(result?.verdict).toBe('fires');
  });

  it('compares like GTM', () => {
    expect(compare('equals', 'a', 'a')).toBe(true);
    expect(compare('matchRegex', 'ABC', '^abc$', true)).toBe(true);
    expect(compare('greater', '10', '9')).toBe(true);
    expect(compare('cssSelector', 'x', 'y')).toBeUndefined();
  });
});

describe('timeline', () => {
  it('attributes hits to the event that started before them and labels tags by name', () => {
    const timeline = new Timeline(new Map([['30', 'GA4 - purchase']]));
    timeline.apply({ kind: 'page', t: 0, page: 1, url: 'https://shop.example/' });
    timeline.apply({ kind: 'probe', page: 1, message: { type: 'push', t: 10, url: 'u', seq: 1, started: 10, data: { event: 'gtm.js' }, event: 'gtm.js' } });
    timeline.apply({ kind: 'probe', page: 1, message: { type: 'push', t: 20, url: 'u', seq: 2, started: 20, data: { event: 'purchase', value: 5 }, event: 'purchase' } });
    timeline.apply({ kind: 'probe', page: 1, message: { type: 'tags', t: 21, url: 'u', seq: 2, containerId: 'GTM-TEST123', eventData: { tags: [{ id: '30', status: 'success' }] } } });
    timeline.apply({ kind: 'hit', page: 1, requestId: 'r1', hit: classifyHit('https://www.google-analytics.com/g/collect?tid=G-1&en=purchase', 'POST', undefined, 25)! });
    timeline.apply({ kind: 'response', requestId: 'r1', status: 204 });
    const purchase = timeline.event(2);
    expect(purchase?.model).toMatchObject({ event: 'purchase', value: 5 });
    expect(purchase?.tags).toEqual([{ id: '30', name: 'GA4 - purchase', status: 'success', executionTime: undefined, containerId: 'GTM-TEST123' }]);
    expect(purchase?.hits.map((hit) => [hit.name, hit.status])).toEqual([['purchase', 204]]);
    expect(timeline.event(1)?.hits).toEqual([]);
  });
});

describe('server container client prediction', () => {
  it('predicts the GA4 client for /g/collect, by priority, and says when it cannot tell', () => {
    const hit = classifyHit('https://sgtm.shop.example/g/collect?tid=G-1', 'POST', undefined, 1)!;
    const clients = [
      { kind: 'client' as const, base: 'clients/Data', data: { name: 'Data', type: 'cvt_1_2', priority: 5, parameter: [{ key: 'path', value: '/data' }] } },
      { kind: 'client' as const, base: 'clients/GA4', data: { name: 'GA4', type: 'gaaw_client', priority: 0 } },
    ];
    expect(predictClient(hit, clients)).toMatchObject({ client: 'GA4', confidence: 'likely' });
    const data = classifyHit('https://sgtm.shop.example/data?x=1', 'POST', undefined, 1, { sgtmHosts: ['sgtm.shop.example'] })!;
    expect(predictClient(data, clients)).toMatchObject({ client: 'Data' });
    const other = classifyHit('https://sgtm.shop.example/other', 'POST', undefined, 1, { sgtmHosts: ['sgtm.shop.example'] })!;
    expect(predictClient(other, clients).confidence).toBe('unknown');
  });
});

describe('browser plumbing', () => {
  it('finds an installed browser, or none', () => {
    expect(findBrowser('linux', (file) => file === '/usr/bin/chromium')).toBe('/usr/bin/chromium');
    expect(findBrowser('linux', () => false)).toBeUndefined();
  });

  it('speaks CDP: commands get their result, events are emitted, errors reject', async () => {
    const server = new WebSocketServer({ port: 0 });
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as { id: number; method: string };
        if (message.method === 'Fail.me') socket.send(JSON.stringify({ id: message.id, error: { message: 'nope' } }));
        else socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }));
        socket.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's1' }));
      });
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}`);
    const events: unknown[] = [];
    cdp.on('event', (event) => events.push(event));
    await expect(cdp.send('Page.enable', {}, 's1')).resolves.toEqual({ echoed: 'Page.enable' });
    await expect(cdp.send('Fail.me')).rejects.toThrow(/Fail\.me: nope/);
    expect(events[0]).toMatchObject({ method: 'Page.loadEventFired', sessionId: 's1' });
    cdp.close();
    await expect(cdp.send('Page.enable')).rejects.toThrow(/closed/);
    server.close();
  });
});
