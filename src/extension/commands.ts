import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GtmApi } from '../core/api';
import { emailFromTokens, parseClientSecretJson, signIn, signOut, type CredentialStore } from '../core/auth/oauth';
import { describeChanges, describeConflicts, describePull } from '../core/format';
import { changeSignature, countChanges, isEmpty } from '../core/mirror/diff';
import { safeFileName } from '../core/mirror/layout';
import { readState } from '../core/mirror/state';
import { assertNotProtected, createVersion, publishVersion } from '../core/ops/publish';
import { pushWorkspace, type PushStrategy } from '../core/ops/push';
import { refreshMirror, resolveGtmConflict, switchWorkspace, type GtmResolution, type RefreshResult } from '../core/ops/sync';
import { discardChanges, initMirror, resolveConflict, tidyFileNames } from '../core/ops/workspace';
import { WorkspaceGoneError, type ContainerInfo, type WorkspaceInfo } from '../core/types';
import { FileCredentialStore } from '../cli/fileStore';
import { untrustedMessage } from './guards';
import { autoPullConfig, dirtyOverlay, type MirrorController, type ResourceState } from './mirror';

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

/** False (after telling the user) when the workspace is untrusted: writes to GTM need Workspace Trust. */
function trusted(action: string): boolean {
  const message = untrustedMessage(vscode.workspace.isTrusted, action);
  if (message) void vscode.window.showErrorMessage(message);
  return !message;
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
    const actions = error instanceof WorkspaceGoneError ? ['Switch Workspace…', 'Show Details'] : ['Show Details'];
    void vscode.window.showErrorMessage(message.split('\n')[0] ?? message, ...actions).then((choice) => {
      if (choice === 'Switch Workspace…') void vscode.commands.executeCommand('gsCode.switchWorkspace');
      else if (choice) deps.output.show();
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
      await signOut(deps.store);
      deps.resetAuth();
      void vscode.window.showInformationMessage('Signed out of Google Tag Manager (access revoked at Google).');
    }),
    register('removeClient', async () => {
      const ok = await vscode.window.showWarningMessage('Sign out and remove the OAuth client from the keychain?', { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      await signOut(deps.store);
      await deps.store.clearClient();
      deps.resetAuth();
      void vscode.window.showInformationMessage('Signed out and removed the OAuth client.');
    }),
    register('importCliSignIn', () => importCliSignIn(deps)),
    register('open', () => openWorkspace(deps)),
    register('refresh', async (arg) => (await pickController(deps, arg))?.refresh()),
    register('pull', (arg) => pull(deps, arg)),
    register('switchWorkspace', (arg) => switchTo(deps, arg)),
    register('adoptFolder', () => adoptFolder(deps)),
    register('versions', (arg) => versions(deps, arg)),
    register('tidy', async (arg) => {
      const controller = await pickController(deps, arg);
      if (!controller?.state) return;
      const result = await run(deps, 'Renaming files to match GTM…', () =>
        controller.exclusive(async () => tidyFileNames(controller.root, await readState(controller.root))),
      );
      if (!result) return;
      result.renamed.forEach(([from, to]) => deps.output.appendLine(`renamed ${from} → ${to}`));
      await controller.refresh();
      void vscode.window.showInformationMessage(result.renamed.length ? `Renamed ${result.renamed.length} file(s) to match GTM.` : 'All file names already match GTM.');
    }),
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
    register('gtmKeepWorkspace', (...states) => resolveGtm(deps, states, 'workspace')),
    register('gtmTakeLatest', (...states) => resolveGtm(deps, states, 'latest')),
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

/** Reuse the `gscode login` client and tokens (~/.config/gs-code) instead of signing in again. */
async function importCliSignIn(deps: CommandDeps): Promise<boolean> {
  const cli = new FileCredentialStore();
  const [client, tokens] = await Promise.all([cli.loadClient(), cli.loadTokens()]);
  if (!client || !tokens?.refresh_token) {
    void vscode.window.showWarningMessage('No gscode CLI sign-in found. Run `gscode login` first, or use "GS Code: Sign In".');
    return false;
  }
  await deps.store.saveClient(client);
  await deps.store.saveTokens(tokens);
  deps.resetAuth();
  deps.output.appendLine('Imported the gscode CLI sign-in into the keychain.');
  for (const controller of deps.controllers()) controller.applySettings(autoPullConfig());
  void vscode.window.showInformationMessage('Signed in with the gscode CLI credentials.');
  return true;
}

async function doSignIn(deps: CommandDeps): Promise<boolean> {
  if (!(await deps.store.loadClient())) {
    const choice = await vscode.window.showWarningMessage('Configure your OAuth client first (a Desktop app client from Google Cloud Console).', 'Configure', 'How?');
    if (choice === 'Configure') await configureClient(deps);
    if (choice === 'How?') await vscode.env.openExternal(vscode.Uri.parse('https://github.com/Matthew-Klette/gs-code#getting-started'));
    return false;
  }
  // Remote windows (SSH, WSL, containers, Codespaces): the browser may not reach this machine's 127.0.0.1.
  const remote = vscode.env.remoteName !== undefined;
  let pasteBox: vscode.InputBox | undefined;
  const done = await run(deps, 'Signing in to Google Tag Manager (finish in your browser)…', async () => {
    try {
      await signIn(deps.store, {
        allowPublish: config().allowPublish,
        openBrowser: async (url) => void (await vscode.env.openExternal(vscode.Uri.parse(url))),
        externalRedirect: async (local) => (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString(true),
        pasteRedirect: remote
          ? () =>
              new Promise<string | undefined>((resolve) => {
                pasteBox = vscode.window.createInputBox();
                pasteBox.title = 'GS Code sign-in';
                pasteBox.prompt = 'If the browser ends on a "can\'t connect" page, paste its full address (http://127.0.0.1:…) here.';
                pasteBox.ignoreFocusOut = true;
                pasteBox.onDidAccept(() => {
                  resolve(pasteBox?.value);
                  pasteBox?.hide();
                });
                pasteBox.onDidHide(() => resolve(undefined));
                pasteBox.show();
              })
          : undefined,
      });
    } finally {
      pasteBox?.dispose();
    }
    deps.resetAuth();
    return true;
  });
  // Auto-pull stops on sign-in errors; start it again now that there is a token.
  if (done) for (const controller of deps.controllers()) controller.applySettings(autoPullConfig());
  if (done) {
    const account = emailFromTokens(await deps.store.loadTokens());
    void vscode.window.showInformationMessage(`Signed in to Google Tag Manager${account ? ` as ${account}` : ''}.`);
  }
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

/** Container versions, with the live one marked; publishing an older one is a deliberate rollback. */
async function versions(deps: CommandDeps, arg?: unknown): Promise<void> {
  if (!trusted('publish or roll back versions')) return;
  const controller = await pickController(deps, arg);
  const state = controller?.state;
  if (!state) return;
  const { accountId, containerId, publicId } = state.container;
  const loaded = await run(deps, 'Loading versions…', async () =>
    Promise.all([deps.api.listVersions(accountId, containerId), deps.api.liveVersionId(accountId, containerId)]),
  );
  if (!loaded) return;
  const [list, live] = loaded;
  const picked = await vscode.window.showQuickPick(
    [...list].reverse().map((version) => ({ label: `${version.versionId === live ? '$(broadcast) ' : ''}${version.versionId}`, description: version.name, detail: version.versionId === live ? 'live' : undefined, version })),
    { placeHolder: `${publicId} versions (newest first)` },
  );
  if (!picked || picked.version.versionId === live) return;
  const { protectedContainers, allowPublish } = config();
  if (!allowPublish) return void vscode.window.showErrorMessage('Publishing is disabled (gsCode.allowPublish is false).');
  const older = live !== undefined && Number(picked.version.versionId) < Number(live);
  const typed = await vscode.window.showInputBox({
    prompt: `${older ? `ROLL BACK ${publicId} from version ${live} to ${picked.version.versionId}` : `Publish version ${picked.version.versionId}`}. Type ${publicId} to confirm.`,
    validateInput: (value) => (value.trim().toUpperCase() === publicId.toUpperCase() ? undefined : `Type ${publicId}`),
  });
  if (!typed) return;
  const done = await run(deps, `Publishing version ${picked.version.versionId}…`, async () => {
    await publishVersion(deps.api, state, picked.version.versionId, protectedContainers, { rollback: older });
    return true;
  });
  if (done) void vscode.window.showInformationMessage(`Version ${picked.version.versionId} is now live on ${publicId}.`);
}

/** A folder cloned from git (a teammate's mirror) gets its own link to a workspace; the files stay as they are. */
async function adoptFolder(deps: CommandDeps): Promise<void> {
  const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Adopt this folder', title: 'Folder with GS Code mirror files (e.g. a git clone)' });
  if (!folder?.[0]) return;
  const accounts = await run(deps, 'Loading accounts…', () => deps.api.listAccounts());
  if (!accounts) return;
  const account = await vscode.window.showQuickPick(accounts.map((item) => ({ label: item.name, description: item.accountId, item })), { placeHolder: 'GTM account' });
  if (!account) return;
  const containers = await run(deps, 'Loading containers…', () => deps.api.listContainers(account.item.accountId));
  if (!containers) return;
  const container = await vscode.window.showQuickPick(containers.map((item) => ({ label: item.name, description: item.publicId, item })), { placeHolder: 'Container these files belong to' });
  if (!container) return;
  const workspace = await pickWorkspace(deps, container.item, 'Your own workspace for these files (create one per person)');
  if (!workspace) return;
  const root = folder[0].fsPath;
  const result = await run(deps, `Adopting ${path.basename(root)}…`, () => initMirror(root, deps.api, container.item, workspace, { adopt: true }));
  if (!result) return;
  await deps.addMirror(root);
  void vscode.window.showInformationMessage(`Linked ${path.basename(root)} to ${container.item.publicId} / "${workspace.name}". Differences from GTM show as your changes.`);
}

async function pickWorkspace(deps: CommandDeps, container: ContainerInfo, placeHolder = 'Workspace'): Promise<WorkspaceInfo | undefined> {
  const workspaces = await run(deps, 'Loading workspaces…', () => deps.api.listWorkspaces(container.accountId, container.containerId));
  if (!workspaces) return undefined;
  const CREATE = { label: '$(add) Create new workspace…', item: undefined };
  const picked = await vscode.window.showQuickPick([CREATE, ...workspaces.map((item) => ({ label: item.name, description: item.workspaceId, item }))], { placeHolder });
  if (!picked) return undefined;
  if (picked.item) return picked.item;
  const name = await vscode.window.showInputBox({ prompt: 'New workspace name', validateInput: (value) => (value.trim() ? undefined : 'Required') });
  if (!name) return undefined;
  return run(deps, `Creating workspace "${name}"…`, () => deps.api.createWorkspace(container.accountId, container.containerId, name.trim()));
}

/**
 * Pull (only when GTM changed, unless forced). With `sync`, also bring the workspace up to a newer
 * container version: that writes to GTM, so only explicit actions ask for it.
 */
function refreshNow(deps: CommandDeps, controller: MirrorController, force: boolean, report?: (message: string) => void, sync = false): Promise<RefreshResult> {
  return controller.exclusive(async () =>
    refreshMirror(controller.root, deps.api, await readState(controller.root), { force, sync, overlay: dirtyOverlay(controller.root), onProgress: report }),
  );
}

async function pull(deps: CommandDeps, arg?: unknown): Promise<void> {
  const controller = await pickController(deps, arg);
  if (!controller?.state) return;
  const result = await run(deps, `Pulling ${controller.label}…`, (report) => refreshNow(deps, controller, true, report, true));
  if (!result) return;
  await controller.afterRefresh(result, 'command');
  const summary = result.pull ? describePull(result.pull) : 'already up to date';
  const blocked = describeConflicts(result.state);
  if (blocked.length) void vscode.window.showWarningMessage(`Pull: ${summary}. Resolve conflicts in the Source Control view.`);
  else void vscode.window.showInformationMessage(`Pull: ${summary}${result.syncedTo ? ` (workspace synced to version ${result.syncedTo})` : ''}${result.syncSkipped ? ` (${result.syncSkipped})` : ''}.`);
}

/** Follow another workspace: after yours was versioned or deleted, or just by choice. */
async function switchTo(deps: CommandDeps, arg?: unknown): Promise<void> {
  const controller = await pickController(deps, arg);
  const state = controller?.state;
  if (!controller || !state) return;
  const workspace = await pickWorkspace(deps, state.container, `Workspace this folder should follow (now "${state.workspace.name}")`);
  if (!workspace) return;
  const ok = await vscode.window.showWarningMessage(
    `Follow workspace "${workspace.name}"? Your unpushed edits are kept, and the working files are backed up to .gtm/backups first.`,
    { modal: true },
    'Switch',
  );
  if (ok !== 'Switch') return;
  const result = await run(deps, `Switching to "${workspace.name}"…`, (report) =>
    controller.exclusive(async () =>
      switchWorkspace(controller.root, deps.api, await readState(controller.root), workspace, { overlay: dirtyOverlay(controller.root), onProgress: report }),
    ),
  );
  if (!result) return;
  await controller.afterRefresh(result, 'command');
  controller.applySettings(autoPullConfig());
  void vscode.window.showInformationMessage(`Now following "${workspace.name}". Backup of the previous files: ${result.backup}`);
}

/** Pull before Push / Create Version; returns false (and says why) if conflicts must be settled first. */
async function refreshBeforeWrite(deps: CommandDeps, controller: MirrorController, action: string): Promise<boolean> {
  const result = await run(deps, `Checking GTM for changes before ${action}…`, (report) => refreshNow(deps, controller, false, report));
  if (!result) return false;
  await controller.afterRefresh(result, 'command');
  const blocked = describeConflicts(result.state);
  if (!blocked.length) return true;
  blocked.forEach((line) => deps.output.appendLine(line));
  void vscode.window.showWarningMessage(`GTM has changes that conflict with yours. Resolve them in Source Control, then ${action} again.`, 'Show Details').then((choice) => {
    if (choice) deps.output.show();
  });
  return false;
}

async function push(deps: CommandDeps, arg?: unknown): Promise<void> {
  if (!trusted('push to GTM')) return;
  const controller = await pickController(deps, arg);
  if (!controller) return;
  await controller.refresh();
  if (controller.status && isEmpty(controller.status.changes)) {
    void vscode.window.showInformationMessage('Nothing to push.');
    return;
  }
  if (!(await refreshBeforeWrite(deps, controller, 'Push'))) return;
  const { state, status } = controller;
  if (!state || !status) return;
  if (isEmpty(status.changes)) {
    void vscode.window.showInformationMessage('Nothing to push.');
    return;
  }
  const lines = describeChanges(status.changes);
  // Pin exactly what the dialog shows: if an agent or another window saves files meanwhile, nothing is sent.
  const expected = changeSignature(status.changes);
  const ok = await vscode.window.showWarningMessage(
    `Push ${countChanges(status.changes)} change(s) to ${state.container.publicId} / "${state.workspace.name}"?`,
    { modal: true, detail: preview(lines) },
    'Push',
  );
  if (ok !== 'Push') return;
  const result = await run(deps, `Pushing to ${controller.label}…`, (report) =>
    controller.exclusive(async () =>
      pushWorkspace(controller.root, deps.api, await readState(controller.root), { strategy: config().pushStrategy, expected, onProgress: report, overlay: dirtyOverlay(controller.root) }),
    ),
  );
  await controller.refresh();
  if (result) void vscode.window.showInformationMessage(`Pushed ${result.pushed} change(s) to ${state.container.publicId}.`);
}

async function version(deps: CommandDeps, arg: unknown, publish: boolean): Promise<void> {
  if (!trusted(publish ? 'publish' : 'create versions')) return;
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
  if (!(await refreshBeforeWrite(deps, controller, publish ? 'publishing' : 'creating a version'))) return;
  const behind = controller.state?.remote?.behind;
  if (behind) {
    const update = await vscode.window.showWarningMessage(
      `Container version ${behind} was published after this workspace was last updated. Bring the workspace up to date first?`,
      { modal: true, detail: 'This merges the published changes into the workspace (GTM "Update"). Conflicts, if any, are shown in Source Control.' },
      'Update Workspace',
    );
    if (update !== 'Update Workspace') return;
    const synced = await run(deps, 'Updating the workspace…', (report) => refreshNow(deps, controller, true, report, true));
    if (!synced) return;
    await controller.afterRefresh(synced, 'command');
    if (describeConflicts(synced.state).length) {
      void vscode.window.showWarningMessage('Updating the workspace produced conflicts. Resolve them in Source Control, then try again.');
      return;
    }
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
      createVersion(controller.root, deps.api, await readState(controller.root), { name, notes, publish, protectedContainers, onProgress: report, overlay: dirtyOverlay(controller.root) }),
    ),
  );
  await controller.refresh();
  if (result) void controller.autoPull.check();
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

async function resolveGtm(deps: CommandDeps, args: unknown[], resolution: GtmResolution): Promise<void> {
  const states = statesFrom(args).filter((state) => state.gtmConflict);
  const controller = await pickController(deps, states[0]?.resourceUri);
  if (!controller?.state || states.length === 0) return;
  for (const base of new Set(states.map((state) => state.base))) {
    const result = await run(deps, `Resolving GTM merge conflict ${base}…`, () =>
      controller.exclusive(async () =>
        resolveGtmConflict(controller.root, deps.api, await readState(controller.root), base, resolution, { overlay: dirtyOverlay(controller.root) }),
      ),
    );
    if (result) await controller.afterRefresh(result, 'command');
  }
  await controller.refresh();
}
