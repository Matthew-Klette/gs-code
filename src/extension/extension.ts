import * as path from 'node:path';
import * as vscode from 'vscode';
import { HttpGtmApi } from '../core/api';
import { GoogleTokenProvider } from '../core/auth/oauth';
import { STATE_FILE } from '../core/mirror/layout';
import { hasState } from '../core/mirror/state';
import { registerCommands } from './commands';
import { fileStampStore } from '../cli/fileStore';
import { RateLimiter } from '../core/rateLimiter';
import { autoPullConfig, GtmDecorations, MirrorController } from './mirror';
import { SecretCredentialStore } from './secretStore';

/** Returned from activate() so integration tests can inspect state. */
export interface GsCodeExtensionApi {
  readonly controllers: () => readonly MirrorController[];
}

/** Focusing the window checks GTM unless a check ran this recently. */
const FOCUS_RECHECK_MS = 10_000;
/** How often the "synced X ago" text is redrawn. */
const STATUS_TICK_MS = 15_000;

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function syncedAt(controller: MirrorController): number | undefined {
  const pulled = controller.state?.pulledAt ? Date.parse(controller.state.pulledAt) : undefined;
  return controller.autoPull.lastCheckedAt ?? pulled;
}

export async function activate(context: vscode.ExtensionContext): Promise<GsCodeExtensionApi> {
  const output = vscode.window.createOutputChannel('GS Code');
  const store = new SecretCredentialStore(context.secrets);
  const tokens = new GoogleTokenProvider(store);
  const api = new HttpGtmApi(tokens, {
    // Same request history file as the gscode CLI, so both together stay inside the 25 requests / 100 s quota.
    limiter: new RateLimiter(undefined, undefined, undefined, (ms) => output.appendLine(`Waiting ${Math.ceil(ms / 1000)}s for the GTM API quota…`), fileStampStore()),
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
    const now = Date.now();
    const oldest = Math.min(...list.map((controller) => syncedAt(controller) ?? 0));
    const failing = list.some((controller) => controller.autoPull.lastError !== undefined);
    const synced = failing ? '$(warning) sync failed' : oldest ? `$(sync) ${formatAgo(now - oldest)}` : '$(sync) not synced';
    statusBar.text = `$(tag) ${list.length === 1 ? list[0]!.label : `${list.length} GTM workspaces`} ${synced}${pending ? ` $(cloud-upload) ${pending}` : ''}`;
    statusBar.tooltip = list
      .map((controller) => {
        const at = syncedAt(controller);
        const auto = controller.autoPull.active ? 'auto-pull on' : 'auto-pull off';
        return `${controller.label}: last synced with GTM ${at ? formatAgo(now - at) : 'never'} (${auto})`;
      })
      .join('\n');
    statusBar.show();
  };

  const addMirror = async (root: string) => {
    if (controllers.has(root) || !(await hasState(root))) return;
    try {
      const controller = await MirrorController.create(root, { api, output, diagnostics, autoPull: autoPullConfig(), onDidChange: updateStatusBar });
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
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      for (const controller of controllers.values()) if (controller.autoPull.active) void controller.autoPull.checkIfStale(FOCUS_RECHECK_MS);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // A whole file whose remote update waited for this save: merge it now.
      for (const controller of controllers.values()) {
        const rel = path.relative(controller.root, doc.uri.fsPath).split(path.sep).join('/');
        if (rel.startsWith('..')) continue;
        controller.autoPull.wake(); // someone is working here: poll at the normal rate
        if (controller.state?.deferred.includes(rel)) void controller.autoPull.check();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('gsCode.autoPull')) return;
      const settings = autoPullConfig();
      controllers.forEach((controller) => controller.applySettings(settings));
      updateStatusBar();
    }),
    (() => {
      const ticker = setInterval(updateStatusBar, STATUS_TICK_MS);
      return { dispose: () => clearInterval(ticker) };
    })(),
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
