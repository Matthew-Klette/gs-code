import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import type { Hit } from '../src/debugger/hits';
import { containedFile, parseWebviewMessage, planReplay, replayConfirmation, untrustedMessage } from '../src/extension/guards';
import { SecretCredentialStore } from '../src/extension/secretStore';

let base: string;
let root: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'gscode-fixext-')));
  root = path.join(base, 'mirror');
  await mkdir(path.join(root, 'tags'), { recursive: true });
  await writeFile(path.join(root, 'tags', 'A.json'), '{}');
  await writeFile(path.join(base, 'secret.txt'), 'outside');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('debugger panel openFile containment', () => {
  it('returns the real path of a file inside the mirror', async () => {
    expect(await containedFile(root, 'tags/A.json')).toBe(path.join(root, 'tags', 'A.json'));
  });

  it('refuses ../ escapes and missing files', async () => {
    expect(await containedFile(root, '../secret.txt')).toBeUndefined();
    expect(await containedFile(root, 'tags/missing.json')).toBeUndefined();
  });

  it('refuses a symlink inside the mirror that points outside it', async () => {
    await symlink(path.join(base, 'secret.txt'), path.join(root, 'tags', 'link.json'));
    expect(await containedFile(root, 'tags/link.json')).toBeUndefined();
  });

  it('works when the mirror root itself is reached through a symlink', async () => {
    const alias = path.join(base, 'alias');
    await symlink(root, alias);
    expect(await containedFile(alias, 'tags/A.json')).toBe(path.join(root, 'tags', 'A.json'));
  });
});

describe('debugger panel message validation', () => {
  it('accepts the messages panel.js sends', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'start', url: 'https://example.com', mode: 'live' })).toEqual({ type: 'start', url: 'https://example.com', mode: 'live' });
    expect(parseWebviewMessage({ type: 'select', seq: 3, live: true })).toEqual({ type: 'select', seq: 3, live: true });
    expect(parseWebviewMessage({ type: 'select', seq: 3 })).toEqual({ type: 'select', seq: 3, live: undefined });
    expect(parseWebviewMessage({ type: 'openFile', file: 'tags/A.json' })).toEqual({ type: 'openFile', file: 'tags/A.json' });
    expect(parseWebviewMessage({ type: 'push', json: '{}' })).toEqual({ type: 'push', json: '{}' });
  });

  it('ignores unknown types and wrongly typed fields', () => {
    for (const raw of [
      undefined,
      null,
      'start',
      { type: 'eval' },
      { type: 'start', url: 1, mode: 'live' },
      { type: 'start', url: 'https://example.com', mode: 'other' },
      { type: 'navigate' },
      { type: 'select', seq: '3' },
      { type: 'select', seq: 1.5 },
      { type: 'select', seq: 1, live: 'yes' },
      { type: 'openFile', file: ['x'] },
      { type: 'push', json: { event: 'x' } },
    ]) {
      expect(parseWebviewMessage(raw)).toBeUndefined();
    }
  });

  it('drops extra fields', () => {
    expect(parseWebviewMessage({ type: 'stop', extra: 'x' })).toEqual({ type: 'stop' });
  });
});

describe('workspace trust', () => {
  it('blocks only in an untrusted workspace, naming the action', () => {
    expect(untrustedMessage(true, 'push to GTM')).toBeUndefined();
    expect(untrustedMessage(false, 'push to GTM')).toMatch(/does not push to GTM in Restricted Mode/);
  });

  it('package.json scopes the dangerous settings and restricts them in untrusted workspaces', async () => {
    const pkg = JSON.parse(await readFile(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      capabilities: { untrustedWorkspaces: { supported: unknown; restrictedConfigurations: string[] } };
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    const props = pkg.contributes.configuration.properties;
    expect(props['gsCode.debug.browserPath']?.scope).toBe('machine');
    expect(props['gsCode.debug.browserUrl']?.scope).toBe('machine');
    expect(props['gsCode.allowPublish']?.scope).toBe('application');
    expect(props['gsCode.protectedContainers']?.scope).toBe('application');
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe('limited');
    expect([...pkg.capabilities.untrustedWorkspaces.restrictedConfigurations].sort()).toEqual(
      ['gsCode.allowPublish', 'gsCode.debug.browserPath', 'gsCode.debug.browserUrl', 'gsCode.debug.sgtmHosts', 'gsCode.protectedContainers'],
    );
    for (const key of pkg.capabilities.untrustedWorkspaces.restrictedConfigurations) expect(props[key]).toBeDefined();
  });
});

describe('SecretCredentialStore', () => {
  const secrets = (values: Record<string, string>): vscode.SecretStorage => ({ get: async (key: string) => values[key] }) as unknown as vscode.SecretStorage;

  it('warns when stored credentials are corrupt and still reports them as missing', async () => {
    const warnings: string[] = [];
    const store = new SecretCredentialStore(secrets({ 'gsCode.tokens': '{not json', 'gsCode.oauthClient': 'nope' }), (message) => warnings.push(message));
    expect(await store.loadTokens()).toBeUndefined();
    expect(await store.loadClient()).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/sign-in tokens .* could not be read/);
    expect(warnings[1]).toMatch(/OAuth client .* could not be read/);
  });

  it('stays quiet when nothing is stored and parses valid JSON', async () => {
    const warnings: string[] = [];
    const store = new SecretCredentialStore(secrets({ 'gsCode.tokens': '{"access_token":"x"}' }), (message) => warnings.push(message));
    expect(await store.loadTokens()).toEqual({ access_token: 'x' });
    expect(await store.loadClient()).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe('sGTM replay confirmation', () => {
  const hit = (url: string, extra: Partial<Hit> = {}): Hit => {
    const parsed = new URL(url);
    return { vendor: 'ga4', url, host: parsed.host, path: parsed.pathname, method: 'POST', t: 0, events: [], name: 'purchase', firstParty: true, body: 'x', ...extra } as Hit;
  };
  const hits = [
    hit('https://sgtm.example.com/g/collect?en=purchase'),
    hit('https://sgtm.example.com/g/collect?en=purchase&x=2'),
    hit('https://data.example.org:8443/g/collect?en=purchase'),
    hit('https://evil.example.net/g/collect?en=purchase'),
    hit('https://sgtm.example.com/g/collect?en=page_view', { name: 'page_view' }),
    hit('https://sgtm.example.com/gtm.js?id=GTM-XXXXXXX', { vendor: 'gtm', method: 'GET' }),
    hit('https://www.google-analytics.com/g/collect', { firstParty: false }),
  ];
  const allowed = ['sgtm.example.com', 'data.example.org'];

  it('lists the distinct allowed hosts the replay will hit, with ports, and the refusals', () => {
    const plan = planReplay(hits, 'purchase', allowed);
    expect(plan.hosts).toEqual(['data.example.org:8443', 'sgtm.example.com']);
    expect(plan.count).toBe(3);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]).toMatch(/evil\.example\.net/);
  });

  it('without a name, takes every first-party non-gtm.js hit like the tool does', () => {
    const plan = planReplay(hits, undefined, allowed);
    expect(plan.count).toBe(4);
    expect(plan.hosts).toEqual(['data.example.org:8443', 'sgtm.example.com']);
  });

  it('names the hosts and the allow-list source in the message', () => {
    const message = replayConfirmation(planReplay(hits, 'purchase', allowed), 'purchase', allowed, 'workspace settings');
    expect(message).toMatch(/Send 3 "purchase" requests again to data\.example\.org:8443, sgtm\.example\.com\./);
    expect(message).toMatch(/from workspace settings\): sgtm\.example\.com, data\.example\.org/);
    expect(message).toMatch(/Refused: .*evil\.example\.net/);
    expect(message).toMatch(/recorded twice/);
  });

  it('says nothing will be sent when no hit passes the allow-list', () => {
    const plan = planReplay(hits, 'purchase', []);
    expect(plan.hosts).toEqual([]);
    expect(replayConfirmation(plan, 'purchase', [], 'the default')).toMatch(/nothing will be sent[\s\S]*\(empty\)/);
  });
});
