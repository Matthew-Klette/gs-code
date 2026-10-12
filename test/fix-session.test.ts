import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { CdpConnection } from '../src/debugger/cdp';
import { checkNavigableUrl, DebugSession, draftUrl } from '../src/debugger/session';
import { Timeline } from '../src/debugger/timeline';

const preview = { publicId: 'GTM-TEST123', gtmAuth: 'SECRETAUTH123', gtmPreview: 'env-9' };

/** A fake browser: answers every CDP command, records them, and can push events to the session. */
async function fakeBrowser(fail: ReadonlySet<string> = new Set()) {
  const server = new WebSocketServer({ port: 0 });
  const commands: { method: string; params: Record<string, unknown> }[] = [];
  let socket: WebSocket | undefined;
  let closed = false;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('close', () => (closed = true));
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> };
      commands.push({ method: message.method, params: message.params });
      if (fail.has(message.method)) return ws.send(JSON.stringify({ id: message.id, error: { message: 'nope' } }));
      const result = message.method === 'Target.createTarget' ? { targetId: 't1' } : message.method === 'Target.attachToTarget' ? { sessionId: 's1' } : {};
      ws.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    commands,
    connected: () => !!socket,
    closed: () => closed,
    event: (method: string, params: Record<string, unknown>) => socket?.send(JSON.stringify({ method, params, sessionId: 's1' })),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('debug session hardening', () => {
  let dir: string;
  let browser: Awaited<ReturnType<typeof fakeBrowser>>;
  let session: DebugSession | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gs-session-'));
  });
  afterEach(async () => {
    await session?.stop();
    session = undefined;
    await browser?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const open = async (options: { fail?: ReadonlySet<string>; url?: string } = {}) => {
    browser = await fakeBrowser(options.fail);
    session = new DebugSession({ url: options.url ?? 'https://shop.example/', browser: { browserUrl: browser.url, profileDir: dir }, preview, logDir: path.join(dir, 'debug') });
    return session;
  };

  it('continues a paused gtm.js request even when the session file can no longer be written', async () => {
    const s = await open();
    const faults: unknown[] = [];
    s.on('fault', (error) => faults.push(error));
    await s.start();
    await rm(path.join(dir, 'debug'), { recursive: true, force: true });
    browser.event('Fetch.requestPaused', { requestId: 'f1', request: { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST123' } });
    await waitFor(() => browser.commands.some((c) => c.method === 'Fetch.continueRequest'));
    const continued = browser.commands.find((c) => c.method === 'Fetch.continueRequest');
    expect(continued?.params).toMatchObject({ requestId: 'f1' });
    expect(String(continued?.params.url)).toContain('gtm_auth=SECRETAUTH123');
    await waitFor(() => s.timeline.notes.some((n) => n.message.startsWith('Stopped writing')));
    expect(faults).toHaveLength(1);
    // Later records still reach the timeline, without another fault.
    browser.event('Page.frameNavigated', { frame: { url: 'https://shop.example/next' } });
    await waitFor(() => s.timeline.pages.length === 1);
    expect(faults).toHaveLength(1);
  });

  it('never writes the gtm_auth credential to the session file or the timeline', async () => {
    const s = await open();
    await s.start();
    browser.event('Fetch.requestPaused', { requestId: 'f1', request: { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST123' } });
    browser.event('Page.frameNavigated', { frame: { url: 'https://shop.example/?gtm_auth=OTHERSECRET&x=1' } });
    await waitFor(() => s.timeline.pages.length === 1 && s.timeline.notes.length === 1);
    const text = await readFile(s.file as string, 'utf8');
    expect(text).not.toContain('SECRETAUTH123');
    expect(text).not.toContain('OTHERSECRET');
    expect(text).toContain('gtm_auth=…');
    expect(s.timeline.pages[0]?.url).toBe('https://shop.example/?gtm_auth=…&x=1');
    expect(JSON.stringify(s.timeline.notes)).not.toContain('SECRETAUTH123');
  });

  it('redacts encoded, JSON and upper-case gtm_auth forms in the session file', async () => {
    const s = await open();
    await s.start();
    const url = 'https://shop.example/?dl=https%3A%2F%2Fshop.example%2F%3Fgtm_auth%3DENC1SECRET%26x%3D1&dr=https%253A%252F%252Fa%252F%253Fgtm_auth%253DENC2SECRET&GTM_AUTH=UPPERSECRET&j={"gtm_auth":"JSONSECRET"}';
    browser.event('Page.frameNavigated', { frame: { url } });
    await waitFor(() => s.timeline.pages.length === 1);
    const text = await readFile(s.file as string, 'utf8');
    expect(text).not.toMatch(/ENC1SECRET|ENC2SECRET|UPPERSECRET|JSONSECRET/);
    expect(s.timeline.pages[0]?.url).toContain('gtm_auth%3D…%26x%3D1');
  });

  it('redacts the draft-workspace note at source, even for a short credential', async () => {
    browser = await fakeBrowser();
    session = new DebugSession({ url: 'https://shop.example/', browser: { browserUrl: browser.url, profileDir: dir }, preview: { ...preview, gtmAuth: 'abc12' }, logDir: path.join(dir, 'debug') });
    await session.start();
    browser.event('Fetch.requestPaused', { requestId: 'f1', request: { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-TEST123' } });
    await waitFor(() => session!.timeline.notes.length === 1);
    expect(session.timeline.notes[0]?.message).toContain('gtm_auth=…');
    expect(session.timeline.notes[0]?.message).not.toContain('abc12');
  });

  it('drops oversized probe messages from the page with a warning', async () => {
    const s = await open();
    await s.start();
    browser.event('Runtime.bindingCalled', { name: '__gsCodeEmit', payload: JSON.stringify({ type: 'push', t: 1, seq: 1, data: 'x'.repeat(300 * 1024) }) });
    await waitFor(() => s.timeline.notes.length === 1);
    expect(s.timeline.notes[0]).toMatchObject({ level: 'warning' });
    expect(s.timeline.notes[0]?.message).toMatch(/Dropped a \d+ KB probe message/);
    expect(s.timeline.events).toHaveLength(0);
    expect(await readFile(s.file as string, 'utf8')).not.toContain('xxxx');
  });

  it('closes the browser connection when setup fails after connecting', async () => {
    const s = await open({ fail: new Set(['Target.createTarget']) });
    await expect(s.start()).rejects.toThrow(/Target\.createTarget: nope/);
    await waitFor(() => browser.closed());
    expect(s.running).toBe(false);
  });

  it('treats a browser connection error as a close instead of crashing', async () => {
    const s = await open();
    await s.start();
    const stopped = new Promise((resolve) => s.once('stopped', resolve));
    ((s as unknown as { browser: { cdp: CdpConnection } }).browser.cdp).emit('error', new Error('socket reset'));
    await stopped;
    expect(s.running).toBe(false);
    await waitFor(() => s.timeline.notes.some((n) => n.message.includes('socket reset')));
  });

  it('refuses non-web URLs before opening a browser, and in navigate()', async () => {
    const s = await open({ url: 'file:///etc/passwd' });
    await expect(s.start()).rejects.toThrow(/Only http/);
    expect(browser.connected()).toBe(false);
    const live = new DebugSession({ url: 'about:blank', browser: { browserUrl: browser.url, profileDir: dir } });
    session = live;
    await live.start();
    for (const url of ['javascript:alert(1)', 'chrome://settings', 'view-source:https://shop.example/', 'not a url']) {
      await expect(live.navigate(url)).rejects.toThrow();
    }
    expect(browser.commands.filter((c) => c.method === 'Page.navigate').map((c) => c.params.url)).toEqual(['about:blank']);
  });
});

describe('navigable URLs', () => {
  it('allows http, https and about:blank only', () => {
    expect(() => checkNavigableUrl('https://shop.example/')).not.toThrow();
    expect(() => checkNavigableUrl('http://localhost:3000/')).not.toThrow();
    expect(() => checkNavigableUrl('about:blank')).not.toThrow();
    expect(() => checkNavigableUrl('about:config')).toThrow(/about:/);
    expect(() => checkNavigableUrl('file:///tmp/x.html')).toThrow(/file:/);
  });
});

describe('draft URL credential safety', () => {
  it('only rewrites https gtm.js on the real Google hosts', () => {
    expect(draftUrl('https://evilgoogletagmanager.com/gtm.js?id=GTM-TEST123', preview, [])).toBeUndefined();
    expect(draftUrl('https://www.googletagmanager.com.evil.example/gtm.js?id=GTM-TEST123', preview, [])).toBeUndefined();
    expect(draftUrl('http://www.googletagmanager.com/gtm.js?id=GTM-TEST123', preview, [])).toBeUndefined();
    expect(draftUrl('https://googletagmanager.com/gtm.js?id=GTM-TEST123', preview, [])).toMatch(/^https:\/\/www\.googletagmanager\.com\/gtm\.js\?id=GTM-TEST123&gtm_auth=SECRETAUTH123&gtm_preview=env-9$/);
  });

  it('keeps only id and l from the original URL', () => {
    const url = draftUrl('https://www.googletagmanager.com/gtm.js?id=gtm-test123&l=myLayer&gtm_auth=OLD&extra=1', preview, []);
    expect(url).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-TEST123&l=myLayer&gtm_auth=SECRETAUTH123&gtm_preview=env-9');
  });
});

describe('session file reading', () => {
  it('skips a half-written last line silently but reports damaged lines before it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gs-timeline-'));
    const file = path.join(dir, 'session.jsonl');
    const good = JSON.stringify({ kind: 'page', t: 1, page: 1, url: 'https://shop.example/' });
    await writeFile(file, `${good}\n{broken\n${good}\n{"kind":"pa`, 'utf8');
    const timeline = await Timeline.fromFile(file);
    expect(timeline.pages).toHaveLength(2);
    expect(timeline.notes).toHaveLength(1);
    expect(timeline.notes[0]).toMatchObject({ level: 'warning' });
    expect(timeline.notes[0]?.message).toMatch(/Skipped 1 unreadable line in/);
    await writeFile(file, `${good}\n{"kind":"pa`, 'utf8');
    expect((await Timeline.fromFile(file)).notes).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });
});
