import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveMcp } from '../src/cli/mcp';
import { initMirror } from '../src/core/ops/workspace';
import { classifyHit, redactGtmAuth, type Hit } from '../src/debugger/hits';
import { replayTarget, replayWithPreview } from '../src/debugger/sgtmPreview';
import { DEBUG_DIR, Toolkit } from '../src/debugger/toolkit';
import { CONTAINER, seededFake, type FakeGtm } from './fakeApi';

const header = Buffer.from('ZW52LTE|env-255|abc123').toString('base64');
const okFetch = () => vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const ga4 = (url: string, method = 'POST') => classifyHit(url, method, 'en=purchase', 1)!;

describe('sGTM replay target checks', () => {
  it('refuses to replay when no sgtmHosts are configured, and says how to set them', async () => {
    const fetchImpl = okFetch();
    await expect(replayWithPreview(ga4('https://sgtm.shop.example/g/collect'), header, { fetchImpl })).rejects.toThrow(/gsCode\.debug\.sgtmHosts.*GSCODE_SGTM_HOSTS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not replay /g/collect hits to hosts the page picked (metadata, localhost, LAN)', async () => {
    const fetchImpl = okFetch();
    const sgtmHosts = ['sgtm.shop.example'];
    for (const url of ['http://169.254.169.254/g/collect', 'https://localhost/g/collect', 'https://192.168.1.10/g/collect', 'https://sgtm.shop.example.evil.test/g/collect', 'https://evilsgtm.shop.example/g/collect']) {
      const hit = ga4(url);
      expect(hit.firstParty).toBe(true);
      await expect(replayWithPreview(hit, header, { sgtmHosts, fetchImpl })).rejects.toThrow(/not one of the configured sgtmHosts/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('replays to a configured host or its subdomain over https, with the header', async () => {
    const fetchImpl = okFetch();
    await replayWithPreview(ga4('https://sgtm.shop.example/g/collect?tid=G-1'), header, { sgtmHosts: ['sgtm.shop.example'], fetchImpl });
    await replayWithPreview(ga4('https://eu.sgtm.shop.example/g/collect?tid=G-1'), header, { sgtmHosts: ['SGTM.shop.example'], fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sgtm.shop.example/g/collect?tid=G-1');
    expect(init).toMatchObject({ method: 'POST', body: 'en=purchase', redirect: 'manual' });
    expect((init.headers as Record<string, string>)['X-Gtm-Server-Preview']).toBe(header);
  });

  it('needs https, except for a configured localhost or 127.0.0.1', () => {
    expect(() => replayTarget(ga4('http://sgtm.shop.example/g/collect'), ['sgtm.shop.example'])).toThrow(/https only/);
    expect(replayTarget(ga4('http://localhost:8080/g/collect'), ['localhost']).port).toBe('8080');
    expect(replayTarget(ga4('http://127.0.0.1:8080/g/collect'), ['127.0.0.1']).hostname).toBe('127.0.0.1');
    expect(() => replayTarget(ga4('http://sub.localhost/g/collect'), ['localhost'])).toThrow(/https only/);
  });

  it('replays only GET and POST, and never URLs with credentials', () => {
    expect(() => replayTarget(ga4('https://sgtm.shop.example/g/collect', 'PUT'), ['sgtm.shop.example'])).toThrow(/only GET and POST/);
    expect(replayTarget(ga4('https://sgtm.shop.example/g/collect', 'get'), ['sgtm.shop.example'])).toBeInstanceOf(URL);
    const withUser: Hit = { ...ga4('https://sgtm.shop.example/g/collect'), url: 'https://user:pw@sgtm.shop.example/g/collect' };
    expect(() => replayTarget(withUser, ['sgtm.shop.example'])).toThrow(/credentials/);
  });
});

describe('gtm_auth redaction in hits', () => {
  it('hides gtm_auth in the URL, the parsed params and the stored body', () => {
    const hit = classifyHit('https://sgtm.shop.example/g/collect?tid=G-1&gtm_auth=SECRET1&en=x', 'POST', 'en=purchase&gtm_auth=SECRET2', 1)!;
    expect(JSON.stringify(hit)).not.toMatch(/SECRET/);
    expect(hit.url).toContain('gtm_auth=…');
    expect(hit.events[0]).toMatchObject({ gtm_auth: '…', tid: 'G-1' });
  });
});

describe('shared gtm_auth redaction', () => {
  it.each([
    ['literal', 'https://a.example/?gtm_auth=S3CRET&x=1', 'https://a.example/?gtm_auth=…&x=1'],
    ['upper case', 'https://a.example/?GTM_AUTH=S3CRET&x=1', 'https://a.example/?GTM_AUTH=…&x=1'],
    ['percent-encoded inside dl=', 'dl=https%3A%2F%2Fa%2F%3Fgtm_auth%3DS3CRET%26x%3D1', 'dl=https%3A%2F%2Fa%2F%3Fgtm_auth%3D…%26x%3D1'],
    ['lower-case percent-encoding', 'dl=x%3fgtm_auth%3dS3CRET%26y', 'dl=x%3fgtm_auth%3d…%26y'],
    ['double-encoded', 'dr=x%253Fgtm_auth%253DS3CRET%2526y%253D1', 'dr=x%253Fgtm_auth%253D…%2526y%253D1'],
    ['JSON property', '{"gtm_auth":"S3CRET","x":1}', '{"gtm_auth":"…","x":1}'],
    ['JSON with spaces', '{"gtm_auth" : "S3CRET"}', '{"gtm_auth" : "…"}'],
    ['escaped JSON inside JSON', '{"body":"{\\"gtm_auth\\":\\"S3CRET\\"}"}', '{"body":"{\\"gtm_auth\\":\\"…\\"}"}'],
    ['encoded JSON', 'p=%7B%22gtm_auth%22%3A%22S3CRET%22%7D', 'p=%7B%22gtm_auth%22%3A%22…%22%7D'],
  ])('%s', (_label, input, expected) => {
    expect(redactGtmAuth(input)).toBe(expected);
  });

  it('keeps encoded gtm_auth out of hit URLs, params and replay URLs', async () => {
    const page = 'https://shop.example/?gtm_auth=PAGESECRET&x=1';
    const hit = classifyHit(`https://sgtm.shop.example/g/collect?tid=G-1&dl=${encodeURIComponent(page)}&dr=${encodeURIComponent(encodeURIComponent(page))}`, 'POST', '{"gtm_auth":"BODYSECRET"}', 1)!;
    expect(JSON.stringify(hit)).not.toMatch(/PAGESECRET|BODYSECRET/);
    const fetchImpl = okFetch();
    await replayWithPreview(hit, header, { sgtmHosts: ['sgtm.shop.example'], fetchImpl });
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('PAGESECRET');
  });
});

let root: string;
let gtm: FakeGtm;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-fix-replay-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function client(kit: Toolkit) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Record<string, any>[] = [];
  output.on('data', (chunk) => String(chunk).split('\n').filter(Boolean).forEach((line) => replies.push(JSON.parse(line))));
  void serveMcp(kit, input, output);
  const waitFor = async (match: (reply: Record<string, any>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const reply = replies.find(match);
      if (reply) return reply;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('no reply');
  };
  let id = 0;
  const call = async (method: string, params?: Record<string, unknown>) => {
    const request = { jsonrpc: '2.0', id: ++id, method, params };
    input.write(`${JSON.stringify(request)}\n`);
    return waitFor((item) => item.id === request.id);
  };
  const raw = (line: string) => input.write(`${line}\n`);
  const text = async (name: string, args: Record<string, unknown>) => (await call('tools/call', { name, arguments: args })).result as { content: { text: string }[]; isError?: boolean };
  return { call, raw, waitFor, replies, text, end: () => input.end() };
}

const kitFor = (sgtmHosts?: string[]) =>
  new Toolkit({ api: gtm, defaultRoot: () => root, browser: () => ({ profileDir: path.join(root, 'profile') }), settings: () => ({ sgtmHosts }) });

async function recordSession(file: string, hits: Hit[]) {
  await mkdir(path.join(root, DEBUG_DIR), { recursive: true });
  const records = [{ kind: 'page', t: 0, page: 1, url: 'https://shop.example/' }, ...hits.map((hit, index) => ({ kind: 'hit', page: 1, requestId: `r${index}`, hit }))];
  await writeFile(path.join(root, DEBUG_DIR, file), records.map((record) => JSON.stringify(record)).join('\n'));
  await writeFile(path.join(root, DEBUG_DIR, 'latest'), file);
}

describe('debug_replay_sgtm tool', () => {
  it('needs an event name or all: true before replaying anything', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await recordSession('session-2026-10-12T10-00-00-000Z.jsonl', [ga4('https://sgtm.shop.example/g/collect?en=purchase')]);
    const mcp = client(kitFor(['sgtm.shop.example']));
    const refused = await mcp.text('debug_replay_sgtm', { header });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/name.*all: true/);
    expect(fetchMock).not.toHaveBeenCalled();
    const replayed = await mcp.text('debug_replay_sgtm', { header, name: 'purchase' });
    expect(replayed.content[0]?.text).toMatch(/^200 POST https:\/\/sgtm\.shop\.example\/g\/collect/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mcp.end();
  });

  it('refuses a recorded hit to a host outside sgtmHosts, and refuses without sgtmHosts', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await recordSession('session-2026-10-12T10-00-00-000Z.jsonl', [ga4('http://169.254.169.254/g/collect?en=purchase')]);
    const outside = await client(kitFor(['sgtm.shop.example'])).text('debug_replay_sgtm', { header, all: true });
    expect(outside).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/169\.254\.169\.254.*not one of the configured sgtmHosts/) }] });
    const unset = await client(kitFor()).text('debug_replay_sgtm', { header, all: true });
    expect(unset).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/GSCODE_SGTM_HOSTS/) }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('toolkit folder confinement', () => {
  it('rejects a dir outside the open mirror but accepts the mirror itself', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'gscode-other-'));
    try {
      const mcp = client(kitFor());
      for (const dir of [outside, '..', path.join(root, '..', path.basename(outside))]) {
        const reply = await mcp.text('gtm_status', { dir });
        expect(reply).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/must be the open mirror/) }] });
      }
      expect((await mcp.text('gtm_status', { dir: root })).isError).toBeUndefined();
      expect((await mcp.text('gtm_status', { dir: '.' })).isError).toBeUndefined();
      mcp.end();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlink inside the mirror that leads to another mirror', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'gscode-other-mirror-'));
    try {
      await cp(root, other, { recursive: true });
      await symlink(other, path.join(root, 'linked'), 'dir');
      await mkdir(path.join(root, 'sub'));
      const mcp = client(kitFor());
      const reply = await mcp.text('gtm_status', { dir: 'linked' });
      expect(reply).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/must be the open mirror/) }] });
      const missing = await mcp.text('gtm_status', { dir: 'nope' });
      expect(missing).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Cannot use "dir" nope/) }] });
      mcp.end();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('refuses a session file that is a symlink', async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'gscode-elsewhere-'));
    try {
      await mkdir(path.join(root, DEBUG_DIR), { recursive: true });
      await writeFile(path.join(elsewhere, 'secret.txt'), '{"kind":"page","t":0,"page":1,"url":"https://x.example/"}');
      await symlink(path.join(elsewhere, 'secret.txt'), path.join(root, DEBUG_DIR, 'session-link.jsonl'));
      await writeFile(path.join(root, DEBUG_DIR, 'latest'), 'session-link.jsonl');
      const mcp = client(kitFor());
      const reply = await mcp.text('debug_events', {});
      expect(reply).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/not a regular file/) }] });
      mcp.end();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('only reads a session file named session-*.jsonl from .gtm/debug/latest', async () => {
    await mkdir(path.join(root, DEBUG_DIR), { recursive: true });
    const mcp = client(kitFor());
    for (const latest of ['../../tags/GA4 - purchase.json', '/etc/passwd', 'notes.jsonl']) {
      await writeFile(path.join(root, DEBUG_DIR, 'latest'), latest);
      const reply = await mcp.text('debug_events', {});
      expect(reply).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/does not name a session file/) }] });
    }
    mcp.end();
  });
});

describe('MCP request validation', () => {
  it('answers a null line or a request without a method with Invalid Request instead of crashing', async () => {
    const mcp = client(kitFor());
    mcp.raw('null');
    expect(await mcp.waitFor((reply) => reply.error?.code === -32600 && reply.id === null)).toBeTruthy();
    mcp.raw(JSON.stringify({ jsonrpc: '2.0', id: 'x1', params: {} }));
    expect(await mcp.waitFor((reply) => reply.id === 'x1')).toMatchObject({ error: { code: -32600 } });
    mcp.raw(JSON.stringify([1, 2]));
    mcp.raw(JSON.stringify({ jsonrpc: '2.0', id: 'x2', method: 5 }));
    expect(await mcp.waitFor((reply) => reply.id === 'x2')).toMatchObject({ error: { code: -32600 } });
    // The server is still alive afterwards.
    expect((await mcp.call('ping')).result).toEqual({});
    mcp.end();
  });

  it('reports an unknown method as -32601 Method not found', async () => {
    const mcp = client(kitFor());
    const reply = await mcp.call('no/such/method');
    expect(reply.error).toMatchObject({ code: -32601, message: expect.stringMatching(/Method not found/) });
    mcp.end();
  });
});
