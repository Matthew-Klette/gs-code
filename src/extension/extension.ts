import { promises as fs } from 'node:fs';
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
import { DebugPanel, debugSettings } from './debugPanel';
import type { Hit } from '../debugger/hits';
import { Timeline } from '../debugger/timeline';
import { DEBUG_DIR, Toolkit } from '../debugger/toolkit';
import { containedFile, planReplay, replayConfirmation, untrustedMessage } from './guards';

/** Returned from activate() so integration tests can inspect state. */
export interface GsCodeExtensionApi {
  readonly controllers: () => readonly MirrorController[];
}

/** Focusing the window checks GTM unless a check ran this recently. */
const FOCUS_RECHECK_MS = 10_000;
/** How often the "synced X ago" text is redrawn. */
const STATUS_TICK_MS = 15_000;
/** Agent tools that write to GTM, start a browser or send requests; refused in Restricted Mode. */
const TRUSTED_TOOLS: Readonly<Record<string, string>> = {
  gtm_push: 'push to GTM',
  debug_start: 'launch or attach a debug browser',
  debug_replay_sgtm: 'replay requests to a server container',
};

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

/** Which settings level gsCode.debug.sgtmHosts comes from, for the replay confirmation. */
function sgtmHostsSource(): string {
  const inspected = vscode.workspace.getConfiguration('gsCode.debug').inspect<string[]>('sgtmHosts');
  if (inspected?.workspaceFolderValue !== undefined) return 'folder settings';
  if (inspected?.workspaceValue !== undefined) return 'workspace settings';
  if (inspected?.globalValue !== undefined) return 'user settings';
  return 'the default';
}

/** The hits debug_replay_sgtm would read: the live session's, or the mirror's latest session file (symlinks resolved, kept inside the mirror). */
async function replayableHits(toolkit: Toolkit, defaultRoot: string | undefined, dir: unknown): Promise<readonly Hit[]> {
  const live = toolkit.activeSession;
  if (live) return live.timeline.allHits();
  if (!defaultRoot) throw new Error('no GTM mirror is open');
  const root = typeof dir === 'string' && dir ? await containedFile(defaultRoot, dir) : defaultRoot;
  if (!root) throw new Error('"dir" is not a folder inside the open mirror');
  const latest = (await fs.readFile(path.join(root, DEBUG_DIR, 'latest'), 'utf8').catch(() => '')).trim();
  const file = latest && latest === path.basename(latest) ? await containedFile(root, path.join(DEBUG_DIR, latest)) : undefined;
  if (!file) throw new Error('no recorded debug session');
  return (await Timeline.fromFile(file)).allHits();
}

export async function activate(context: vscode.ExtensionContext): Promise<GsCodeExtensionApi> {
  const output = vscode.window.createOutputChannel('GS Code');
  const store = new SecretCredentialStore(context.secrets, (message) => output.appendLine(message));
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

  let account: string | undefined;
  const refreshAccount = () => void tokens.account().then((email) => {
    account = email;
  });
  refreshAccount();

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
      .join('\n') + (account ? `\nSigned in as ${account}` : '');
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
      resetAuth: () => {
        tokens.reset();
        refreshAccount();
      },
      addMirror,
    }),
    { dispose: () => controllers.forEach((controller) => controller.dispose()) },
  );

  // ---- Debugger panel and agent tools (Copilot and other VS Code agents use the same live session)
  const pickRoot = async (): Promise<string | undefined> => {
    const list = [...controllers.values()];
    if (list.length <= 1) return list[0]?.root;
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const fromEditor = active ? list.find((controller) => active.startsWith(controller.root + path.sep)) : undefined;
    if (fromEditor) return fromEditor.root;
    const picked = await vscode.window.showQuickPick(list.map((controller) => ({ label: controller.label, root: controller.root })), { placeHolder: 'Debug which GTM workspace?' });
    return picked?.root;
  };
  const defaultRoot = () => DebugPanel.activeRoot() ?? [...controllers.values()][0]?.root;
  const toolkit = new Toolkit({
    api,
    defaultRoot,
    browser: () => debugSettings(context).browser,
    settings: () => {
      const settings = debugSettings(context);
      return { sgtmHosts: settings.sgtmHosts, loaderPatterns: settings.loaderPatterns, dataLayerName: settings.dataLayerName };
    },
    sharedSession: () => DebugPanel.activeSession(),
    onSession: (session) => {
      const root = DebugPanel.activeRoot() ?? [...controllers.values()][0]?.root;
      if (root) DebugPanel.show(context, api, root, output).adopt(session);
    },
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('gsCode.debug', async () => {
      const root = await pickRoot();
      if (!root) return void vscode.window.showInformationMessage('Open a GTM workspace mirror first ("GS Code: Open Workspace…").');
      DebugPanel.show(context, api, root, output);
    }),
    { dispose: () => void toolkit.activeSession?.stop() },
  );
  /** Confirmation for debug_replay_sgtm naming the exact hosts it will hit and where the allow-list came from. */
  const prepareReplay = async (input: Readonly<Record<string, unknown>>): Promise<vscode.PreparedToolInvocation> => {
    const name = typeof input.name === 'string' && input.name ? input.name : undefined;
    const sgtmHosts = debugSettings(context).sgtmHosts;
    let message: string;
    try {
      message = replayConfirmation(planReplay(await replayableHits(toolkit, defaultRoot(), input.dir), name, sgtmHosts), name, sgtmHosts, sgtmHostsSource());
    } catch (error: unknown) {
      message = `Could not list the target hosts (${error instanceof Error ? error.message : String(error)}). The replay only sends to gsCode.debug.sgtmHosts: ${sgtmHosts.join(', ') || '(empty)'}.`;
    }
    return { invocationMessage: 'Replaying into the sGTM preview', confirmationMessages: { title: 'Replay to the server container?', message } };
  };
  for (const tool of toolkit.definitions()) {
    context.subscriptions.push(
      vscode.lm.registerTool<Record<string, unknown>>(tool.name, {
        prepareInvocation: (options) => {
          if (tool.name === 'gtm_push') return { invocationMessage: 'Pushing to the GTM workspace', confirmationMessages: { title: 'Push to GTM?', message: 'Send the reviewed local changes to the GTM workspace (not live).' } };
          if (tool.name === 'debug_replay_sgtm') return prepareReplay(options.input);
          return { invocationMessage: `GS Code: ${tool.name.replace(/_/g, ' ')}${typeof options.input.url === 'string' ? ` ${options.input.url}` : ''}` };
        },
        invoke: async (options) => {
          const untrusted = tool.name in TRUSTED_TOOLS ? untrustedMessage(vscode.workspace.isTrusted, TRUSTED_TOOLS[tool.name]!) : undefined;
          if (untrusted) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Error: ${untrusted}`)]);
          try {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await tool.run(options.input))]);
          } catch (error: unknown) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Error: ${error instanceof Error ? error.message : String(error)}`)]);
          }
        },
      }),
    );
  }

  await scanFolders();
  return { controllers: () => [...controllers.values()] };
}

export function deactivate(): void {
  // Disposables are cleaned up through context.subscriptions.
}
