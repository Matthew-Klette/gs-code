import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GtmApi } from '../core/api';
import { parseClientSecretJson, signIn, type CredentialStore } from '../core/auth/oauth';
import { describeChanges, describePull } from '../core/format';
import { countChanges, isEmpty } from '../core/mirror/diff';
import { safeFileName } from '../core/mirror/layout';
import { readState } from '../core/mirror/state';
import { assertNotProtected, createVersion } from '../core/ops/publish';
import { pullWorkspace } from '../core/ops/pull';
import { pushWorkspace, type PushStrategy } from '../core/ops/push';
import { discardChanges, initMirror, resolveConflict } from '../core/ops/workspace';
import type { ContainerInfo, WorkspaceInfo } from '../core/types';
import type { MirrorController, ResourceState } from './mirror';

const MAX_PREVIEW_LINES = 20;

export interface CommandDeps {
  readonly api: GtmApi;
  readonly store: CredentialStore;
  readonly output: vscode.OutputChannel;
  readonly controllers: () => readonly MirrorController[];
  readonly resetAuth: () => void;
  readonly addMirror: (root: string) => Promise<void>;
}

function config() {
  const section = vscode.workspace.getConfiguration('gsCode');
  return {
    protectedContainers: section.get<string[]>('protectedContainers', []),
    pushStrategy: section.get<PushStrategy>('pushStrategy', 'bulk'),
    allowPublish: section.get<boolean>('allowPublish', true),
  };
}

function preview(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_PREVIEW_LINES);
  const more = lines.length > shown.length ? `\n…and ${lines.length - shown.length} more` : '';
  return shown.join('\n') + more;
}

/** Run with a progress notification; errors go to a message and the output channel. */
async function run<T>(deps: CommandDeps, title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, (progress) =>
      task((message) => {
        deps.output.appendLine(message);
        progress.report({ message });
      }),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.output.appendLine(`✖ ${title}: ${message}`);
    void vscode.window.showErrorMessage(message.split('\n')[0] ?? message, 'Show Details').then((choice) => {
      if (choice) deps.output.show();
    });
    return undefined;
  }
}

async function pickController(deps: CommandDeps, arg?: unknown): Promise<MirrorController | undefined> {
  const controllers = deps.controllers();
  const fromArg = controllers.find((controller) => controller.scm === arg || (arg instanceof vscode.Uri && arg.fsPath.startsWith(controller.root)));
  if (fromArg) return fromArg;
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const fromEditor = active ? controllers.find((controller) => active.startsWith(controller.root + path.sep)) : undefined;
  if (fromEditor || controllers.length === 1) return fromEditor ?? controllers[0];
  if (controllers.length === 0) {
    void vscode.window.showInformationMessage('No GTM workspace is open. Run "GS Code: Open Workspace…" first.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(controllers.map((controller) => ({ label: controller.label, controller })), { placeHolder: 'Which GTM workspace?' });
  return picked?.controller;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const register = (id: string, handler: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(`gsCode.${id}`, handler);
  return [
    register('configureClient', () => configureClient(deps)),
    register('signIn', () => doSignIn(deps)),
    register('signOut', async () => {
      await deps.store.clearTokens();
      deps.resetAuth();
      void vscode.window.showInformationMessage('Signed out of Google Tag Manager.');
    }),
    register('open', () => openWorkspace(deps)),
    register('refresh', async (arg) => (await pickController(deps, arg))?.refresh()),
    register('pull', (arg) => pull(deps, arg)),
    register('push', (arg) => push(deps, arg)),
    register('createVersion', (arg) => version(deps, arg, false)),
    register('publish', (arg) => version(deps, arg, true)),
    register('openInGtm', async (arg) => {
      const controller = await pickController(deps, arg);
      const url = controller?.state?.workspace.tagManagerUrl ?? controller?.state?.container.tagManagerUrl;
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    register('discard', (...states) => discard(deps, states)),
    register('resolveMine', (...states) => resolve(deps, states, 'mine')),
    register('resolveTheirs', (...states) => resolve(deps, states, 'theirs')),
  ];
}

async function configureClient(deps: CommandDeps): Promise<void> {
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'OAuth client JSON': ['json'] }, title: 'Select the Desktop app OAuth client JSON from Google Cloud Console' });
  if (!files?.[0]) return;
  try {
    await deps.store.saveClient(parseClientSecretJson(await fs.readFile(files[0].fsPath, 'utf8')));
    deps.resetAuth();
    const choice = await vscode.window.showInformationMessage('OAuth client saved to your keychain. Sign in now?', 'Sign In');
    if (choice) await doSignIn(deps);
  } catch (error: unknown) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

async function doSignIn(deps: CommandDeps): Promise<boolean> {
  if (!(await deps.store.loadClient())) {
    const choice = await vscode.window.showWarningMessage('Configure your OAuth client first (a Desktop app client from Google Cloud Console).', 'Configure', 'How?');
    if (choice === 'Configure') await configureClient(deps);
    if (choice === 'How?') await vscode.env.openExternal(vscode.Uri.parse('https://github.com/Matthew-Klette/gs-code#1-create-a-google-oauth-client-one-time-2-minutes'));
    return false;
  }
  const done = await run(deps, 'Signing in to Google Tag Manager (finish in your browser)…', async () => {
    await signIn(deps.store, { allowPublish: config().allowPublish, openBrowser: async (url) => void (await vscode.env.openExternal(vscode.Uri.parse(url))) });
    deps.resetAuth();
    return true;
  });
  if (done) void vscode.window.showInformationMessage('Signed in to Google Tag Manager.');
  return done === true;
}

async function openWorkspace(deps: CommandDeps): Promise<void> {
  const accounts = await run(deps, 'Loading accounts…', () => deps.api.listAccounts());
  if (!accounts) return;
  const account = await vscode.window.showQuickPick(accounts.map((item) => ({ label: item.name, description: item.accountId, item })), { placeHolder: 'GTM account' });
  if (!account) return;
  const containers = await run(deps, 'Loading containers…', () => deps.api.listContainers(account.item.accountId));
  if (!containers) return;
  const container = await vscode.window.showQuickPick(
    containers.map((item) => ({ label: item.name, description: `${item.publicId} · ${item.usageContext.join(', ')}`, item })),
    { placeHolder: 'Container' },
  );
  if (!container) return;
  const workspace = await pickWorkspace(deps, container.item);
  if (!workspace) return;
  const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create mirror here', title: 'Folder to create the mirror in' });
  if (!parent?.[0]) return;
  const root = path.join(parent[0].fsPath, safeFileName(`${container.item.publicId} - ${workspace.name}`));
  const result = await run(deps, `Pulling ${container.item.publicId} / ${workspace.name}…`, async () => {
    await fs.mkdir(root, { recursive: true });
    return initMirror(root, deps.api, container.item, workspace);
  });
  if (!result) return;
  deps.output.appendLine(`Mirrored into ${root}: ${describePull(result)}`);
  const choice = await vscode.window.showInformationMessage(`Mirrored ${container.item.publicId} / ${workspace.name}.`, 'Open Folder', 'Add to Workspace');
  if (choice === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root));
  if (choice === 'Add to Workspace') {
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: vscode.Uri.file(root) });
    await deps.addMirror(root);
  }
}

async function pickWorkspace(deps: CommandDeps, container: ContainerInfo): Promise<WorkspaceInfo | undefined> {
  const workspaces = await run(deps, 'Loading workspaces…', () => deps.api.listWorkspaces(container.accountId, container.containerId));
  if (!workspaces) return undefined;
  const CREATE = { label: '$(add) Create new workspace…', item: undefined };
  const picked = await vscode.window.showQuickPick([CREATE, ...workspaces.map((item) => ({ label: item.name, description: item.workspaceId, item }))], { placeHolder: 'Workspace' });
  if (!picked) return undefined;
  if (picked.item) return picked.item;
  const name = await vscode.window.showInputBox({ prompt: 'New workspace name', validateInput: (value) => (value.trim() ? undefined : 'Required') });
  if (!name) return undefined;
  return run(deps, `Creating workspace "${name}"…`, () => deps.api.createWorkspace(container.accountId, container.containerId, name.trim()));
}

async function pull(deps: CommandDeps, arg?: unknown): Promise<void> {
  const controller = await pickController(deps, arg);
  if (!controller?.state) return;
  const result = await run(deps, `Pulling ${controller.label}…`, () =>
    controller.exclusive(async () => pullWorkspace(controller.root, deps.api, await readState(controller.root))),
  );
  await controller.refresh();
  if (!result) return;
  const summary = describePull(result);
  if (result.conflicts.length) void vscode.window.showWarningMessage(`Pull: ${summary}. Resolve conflicts in the Source Control view.`);
  else void vscode.window.showInformationMessage(`Pull: ${summary}.`);
}

async function push(deps: CommandDeps, arg?: unknown): Promise<void> {
  const controller = await pickController(deps, arg);
  if (!controller) return;
  await controller.refresh();
  const { state, status } = controller;
  if (!state || !status) return;
  if (isEmpty(status.changes)) {
    void vscode.window.showInformationMessage('Nothing to push.');
    return;
  }
  const lines = describeChanges(status.changes);
  const ok = await vscode.window.showWarningMessage(
    `Push ${countChanges(status.changes)} change(s) to ${state.container.publicId} / "${state.workspace.name}"?`,
    { modal: true, detail: preview(lines) },
    'Push',
  );
  if (ok !== 'Push') return;
  const result = await run(deps, `Pushing to ${controller.label}…`, (report) =>
    controller.exclusive(async () =>
      pushWorkspace(controller.root, deps.api, await readState(controller.root), { strategy: config().pushStrategy, onProgress: report }),
    ),
  );
  await controller.refresh();
  if (result) void vscode.window.showInformationMessage(`Pushed ${result.pushed} change(s) to ${state.container.publicId}.`);
}

async function version(deps: CommandDeps, arg: unknown, publish: boolean): Promise<void> {
  const controller = await pickController(deps, arg);
  if (!controller) return;
  await controller.refresh();
  const state = controller.state;
  if (!state) return;
  const { protectedContainers, allowPublish } = config();
  try {
    assertNotProtected(state, protectedContainers);
  } catch (error: unknown) {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return;
  }
  if (publish && !allowPublish) {
    void vscode.window.showErrorMessage('Publishing is disabled (gsCode.allowPublish is false).');
    return;
  }
  const name = await vscode.window.showInputBox({ prompt: 'Version name', value: `${state.workspace.name} (${new Date().toISOString().slice(0, 10)})` });
  if (name === undefined) return;
  const notes = await vscode.window.showInputBox({ prompt: 'Version notes (optional)' });
  if (notes === undefined) return;
  if (publish) {
    const typed = await vscode.window.showInputBox({
      prompt: `Publishing makes this live. Type ${state.container.publicId} to confirm.`,
      validateInput: (value) => (value.trim().toUpperCase() === state.container.publicId.toUpperCase() ? undefined : `Type ${state.container.publicId}`),
    });
    if (!typed) return;
  } else {
    const ok = await vscode.window.showWarningMessage(`Create version "${name}" from ${state.container.publicId} / "${state.workspace.name}"? GTM replaces the workspace with a fresh one.`, { modal: true }, 'Create Version');
    if (ok !== 'Create Version') return;
  }
  const result = await run(deps, publish ? 'Publishing…' : 'Creating version…', (report) =>
    controller.exclusive(async () =>
      createVersion(controller.root, deps.api, await readState(controller.root), { name, notes, publish, protectedContainers, onProgress: report }),
    ),
  );
  await controller.refresh();
  if (result) void vscode.window.showInformationMessage(`Version ${result.versionId} ${result.published ? 'published' : 'created'}. Now editing "${result.state.workspace.name}".`);
}

function statesFrom(args: unknown[]): ResourceState[] {
  return args.flat().filter((item): item is ResourceState => !!item && typeof item === 'object' && 'base' in item);
}

async function discard(deps: CommandDeps, args: unknown[]): Promise<void> {
  const states = statesFrom(args);
  const controller = await pickController(deps, states[0]?.resourceUri);
  if (!controller?.state) return;
  const bases = [...new Set(states.map((state) => state.base))];
  const label = bases.length ? bases.join(', ') : 'ALL local changes';
  const ok = await vscode.window.showWarningMessage(`Discard ${label}? This cannot be undone.`, { modal: true }, 'Discard');
  if (ok !== 'Discard') return;
  await run(deps, 'Discarding…', () =>
    controller.exclusive(async () => discardChanges(controller.root, await readState(controller.root), bases.length ? bases : undefined)),
  );
  await controller.refresh();
}

async function resolve(deps: CommandDeps, args: unknown[], resolution: 'mine' | 'theirs'): Promise<void> {
  const states = statesFrom(args);
  const controller = await pickController(deps, states[0]?.resourceUri);
  if (!controller?.state) return;
  for (const base of new Set(states.map((state) => state.base))) {
    await run(deps, `Resolving ${base}…`, () =>
      controller.exclusive(async () => resolveConflict(controller.root, await readState(controller.root), base, resolution)),
    );
  }
  await controller.refresh();
}
