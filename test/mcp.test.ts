import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveMcp } from '../src/cli/mcp';
import { initMirror } from '../src/core/ops/workspace';
import { DEBUG_DIR, Toolkit } from '../src/debugger/toolkit';
import { CONTAINER, seededFake, type FakeGtm } from './fakeApi';

let root: string;
let gtm: FakeGtm;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-mcp-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function client(kit: Toolkit) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Record<string, any>[] = [];
  output.on('data', (chunk) => String(chunk).split('\n').filter(Boolean).forEach((line) => replies.push(JSON.parse(line))));
  void serveMcp(kit, input, output);
  let id = 0;
  const call = async (method: string, params?: Record<string, unknown>) => {
    const request = { jsonrpc: '2.0', id: ++id, method, params };
    input.write(`${JSON.stringify(request)}\n`);
    for (let i = 0; i < 200; i++) {
      const reply = replies.find((item) => item.id === request.id);
      if (reply) return reply;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no reply to ${method}`);
  };
  return { call, end: () => input.end() };
}

const kitFor = () => new Toolkit({ api: gtm, defaultRoot: () => root, browser: () => ({ profileDir: path.join(root, 'profile') }) });

describe('MCP server', () => {
  it('initialises, lists tools and never offers publishing to agents', async () => {
    const mcp = client(kitFor());
    const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'gs-code' }, capabilities: { tools: {} } });
    const tools = (await mcp.call('tools/list')).result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['gtm_status', 'gtm_push', 'debug_start', 'debug_explain', 'debug_hits']));
    expect(tools.some((name: string) => /publish|version/.test(name))).toBe(false);
    mcp.end();
  });

  it('runs the status → push loop with the reviewed-changes signature', async () => {
    const mcp = client(kitFor());
    const tag = JSON.parse(await readFile(path.join(root, 'tags/GA4 - purchase.json'), 'utf8'));
    await writeFile(path.join(root, 'tags/GA4 - purchase.json'), JSON.stringify({ ...tag, notes: 'agent fix' }, null, 2));
    const status = (await mcp.call('tools/call', { name: 'gtm_status', arguments: {} })).result.content[0].text as string;
    expect(status).toContain('1 change(s) to push');
    const expected = /expected: (.+)$/m.exec(status)?.[1];
    const wrong = await mcp.call('tools/call', { name: 'gtm_push', arguments: { expected: 'stale' } });
    expect(wrong.result.isError).toBe(true);
    const pushed = await mcp.call('tools/call', { name: 'gtm_push', arguments: { expected } });
    expect(pushed.result.content[0].text).toBe('Pushed 1 change(s) to the workspace.');
    expect(gtm.find('tag', 'GA4 - purchase')?.notes).toBe('agent fix');
    mcp.end();
  });

  it('reads a session recorded by someone else (the VS Code panel) from the session file', async () => {
    await mkdir(path.join(root, DEBUG_DIR), { recursive: true });
    const records = [
      { kind: 'page', t: 1, page: 1, url: 'https://shop.example/' },
      { kind: 'probe', page: 1, message: { type: 'push', t: 2, url: 'https://shop.example/', seq: 1, started: 2, data: { event: 'purchase' }, event: 'purchase' } },
    ];
    await writeFile(path.join(root, DEBUG_DIR, 'session-test.jsonl'), records.map((record) => JSON.stringify(record)).join('\n'));
    await writeFile(path.join(root, DEBUG_DIR, 'latest'), 'session-test.jsonl');
    const mcp = client(kitFor());
    const events = (await mcp.call('tools/call', { name: 'debug_events', arguments: {} })).result.content[0].text as string;
    expect(events).toContain('#1 purchase');
    const explain = (await mcp.call('tools/call', { name: 'debug_explain', arguments: { seq: 1, tag: 'GA4 - purchase' } })).result.content[0].text as string;
    expect(explain).toContain('✔ GA4 - purchase [tags/GA4 - purchase.json]: Fires on "CE - purchase".');
    expect(explain).toMatch(/✔ \{\{_event\}\} equals purchase|✔ \{\{Event\}\} equals purchase/);
    mcp.end();
  });

  it('reports tool errors as results the model can read', async () => {
    const mcp = client(kitFor());
    const reply = await mcp.call('tools/call', { name: 'debug_reload', arguments: {} });
    expect(reply.result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringMatching(/No debug session/) }] });
    mcp.end();
  });
});

describe('VS Code language-model tools', () => {
  it('package.json declares exactly the toolkit\'s tools', async () => {
    const pkg = JSON.parse(await readFile(path.join(__dirname, '..', 'package.json'), 'utf8')) as { contributes: { languageModelTools: { name: string }[] } };
    const declared = pkg.contributes.languageModelTools.map((tool) => tool.name).sort();
    expect(declared).toEqual(kitFor().definitions().map((tool) => tool.name).sort());
  });
});
