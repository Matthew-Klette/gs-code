import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GsCodeExtensionApi } from '../../src/extension/extension';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(100);
  }
}

export async function run(): Promise<void> {
  const mirror = process.env.GSCODE_MIRROR as string;
  const log = (line: string) => process.stdout.write(`  ✓ ${line}\n`);
  const extension = vscode.extensions.getExtension<GsCodeExtensionApi>('matthew-klette.gs-code');
  assert.ok(extension, 'extension is installed');
  const api = await extension.activate();
  log('extension activates from workspaceContains:.gtm/state.json');

  const commands = await vscode.commands.getCommands(true);
  const expected = ['configureClient', 'signIn', 'signOut', 'open', 'pull', 'push', 'refresh', 'createVersion', 'publish', 'openInGtm', 'discard', 'resolveMine', 'resolveTheirs', 'gtmKeepWorkspace', 'gtmTakeLatest', 'importCliSignIn', 'switchWorkspace', 'removeClient', 'adoptFolder', 'tidy', 'versions', 'debug'];
  for (const id of expected) assert.ok(commands.includes(`gsCode.${id}`), `command gsCode.${id} registered`);
  log(`all ${expected.length} commands registered`);

  const controller = await waitFor('mirror controller', () => api.controllers().find((c) => c.root === mirror));
  await waitFor('initial status', () => controller.status);
  assert.equal(controller.scm.count, 0);
  assert.equal(controller.label, 'GTM-TEST123 · Default Workspace');
  log('mirror detected, clean, Source Control labelled GTM GTM-TEST123');

  // This test profile is not signed in: the auto-pull that starts when a mirror opens must fail as a sign-in error and stop, not retry forever.
  await waitFor('auto-pull ran on open and stopped (signed out)', () => controller.autoPull.lastError !== undefined && !controller.autoPull.active);
  assert.match(String((controller.autoPull.lastError as Error).message), /Sign In|OAuth client/);
  log('auto-pull runs as soon as the mirror opens; a sign-in error stops it cleanly');

  const tagFile = path.join(mirror, 'tags', 'GA4 - purchase.json');
  const tag = JSON.parse(await readFile(tagFile, 'utf8'));
  await writeFile(tagFile, JSON.stringify({ ...tag, notes: 'edited in VS Code' }, null, 2));
  await waitFor('file watcher picks up edit', () => controller.scm.count === 1);
  const changed = controller.status?.changes.entities.map((c) => `${c.type} ${c.base}`);
  assert.deepEqual(changed, ['updated tags/GA4 - purchase']);
  log('editing a tag file shows 1 change in Source Control (via file watcher)');

  const original = controller.provideOriginalResource(vscode.Uri.file(tagFile));
  assert.equal(original?.fsPath, path.join(mirror, '.gtm', 'base', 'tags', 'GA4 - purchase.json'));
  assert.equal(controller.decorationFor(vscode.Uri.file(tagFile)), 'M');
  log('quick diff original points at .gtm/base, Explorer badge = M');

  await vscode.commands.executeCommand('vscode.diff', original, vscode.Uri.file(tagFile), 'diff');
  assert.ok(vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputTextDiff));
  log('diff editor opens for the change');

  await writeFile(tagFile, JSON.stringify({ ...tag, firingTriggers: ['Does not exist'] }, null, 2));
  const diagnostics = await waitFor('validation diagnostic', () => {
    const found = vscode.languages.getDiagnostics(vscode.Uri.file(tagFile));
    return found.length ? found : undefined;
  });
  assert.match(diagnostics[0]!.message, /unknown trigger "Does not exist"/);
  assert.equal(diagnostics[0]!.severity, vscode.DiagnosticSeverity.Error);
  log('bad trigger reference shows as an error in the Problems panel');

  await writeFile(path.join(mirror, 'tags', 'New tag.json'), JSON.stringify({ name: 'New tag', type: 'html', firingTriggers: ['builtin:All Pages'] }));
  await waitFor('added file', () => controller.status?.changes.entities.some((c) => c.type === 'added'));
  assert.equal(controller.decorationFor(vscode.Uri.file(path.join(mirror, 'tags', 'New tag.json'))), 'A');
  log('new file shows as Added');
}
