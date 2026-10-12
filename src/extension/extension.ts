import * as path from 'node:path';
import * as vscode from 'vscode';
import { HttpGtmApi } from '../core/api';
import { GoogleTokenProvider } from '../core/auth/oauth';
import { STATE_FILE } from '../core/mirror/layout';
import { hasState } from '../core/mirror/state';
import { registerCommands } from './commands';
import { GtmDecorations, MirrorController } from './mirror';
import { SecretCredentialStore } from './secretStore';

/** Returned from activate() so integration tests can inspect state. */
export interface GsCodeExtensionApi {
  readonly controllers: () => readonly MirrorController[];
}

export async function activate(context: vscode.ExtensionContext): Promise<GsCodeExtensionApi> {
  const output = vscode.window.createOutputChannel('GS Code');
  const store = new SecretCredentialStore(context.secrets);
  const tokens = new GoogleTokenProvider(store);
  const api = new HttpGtmApi(tokens, {
    onRetry: (attempt, delayMs, reason) => output.appendLine(`retry ${attempt} in ${Math.round(delayMs / 1000)}s: ${reason}`),
  });
  const diagnostics = vscode.languages.createDiagnosticCollection('gtm');
  const controllers = new Map<string, MirrorController>();
  const decorations = new GtmDecorations(() => [...controllers.values()]);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'workbench.view.scm';

  const updateStatusBar = () => {
    decorations.refresh();
    const list = [...controllers.values()];
    if (list.length === 0) return statusBar.hide();
    const pending = list.reduce((sum, controller) => sum + controller.scm.count!, 0);
    statusBar.text = `$(tag) ${list.length === 1 ? list[0]!.label : `${list.length} GTM workspaces`}${pending ? ` $(cloud-upload) ${pending}` : ''}`;
    statusBar.tooltip = 'GS Code: open Source Control';
    statusBar.show();
  };

  const addMirror = async (root: string) => {
    if (controllers.has(root) || !(await hasState(root))) return;
    try {
      const controller = await MirrorController.create(root, diagnostics, updateStatusBar);
      controllers.set(root, controller);
      await controller.refresh();
    } catch (error: unknown) {
      output.appendLine(`Could not load ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeMirror = (root: string) => {
    controllers.get(root)?.dispose();
    controllers.delete(root);
    updateStatusBar();
  };

  const scanFolders = async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found = await vscode.workspace.findFiles(`**/${STATE_FILE}`, '**/node_modules/**', 50);
    const roots = new Set([...folders.map((folder) => folder.uri.fsPath), ...found.map((uri) => path.dirname(path.dirname(uri.fsPath)))]);
    for (const root of roots) await addMirror(root);
  };

  context.subscriptions.push(
    output,
    diagnostics,
    statusBar,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      event.removed.forEach((folder) => removeMirror(folder.uri.fsPath));
      for (const folder of event.added) await addMirror(folder.uri.fsPath);
    }),
    ...registerCommands({
      api,
      store,
      output,
      controllers: () => [...controllers.values()],
      resetAuth: () => tokens.reset(),
      addMirror,
    }),
    { dispose: () => controllers.forEach((controller) => controller.dispose()) },
  );

  await scanFolders();
  return { controllers: () => [...controllers.values()] };
}

export function deactivate(): void {
  // Disposables are cleaned up through context.subscriptions.
}
