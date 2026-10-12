import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GtmApi } from '../core/api';
import { describeRefresh } from '../core/format';
import { countChanges, type EntityChange } from '../core/mirror/diff';
import { BASE_DIR, BUILTINS_FILE, FOLDERS_FILE, MERGE_DIR, REMOTE_DIR, STATE_DIR } from '../core/mirror/layout';
import type { Overlay } from '../core/mirror/model';
import { readState, type GtmConflict, type MirrorState } from '../core/mirror/state';
import { AutoPull, clampInterval, DEFAULT_INTERVAL_SECONDS } from '../core/ops/autoPull';
import { workingStatus, type WorkingStatus } from '../core/ops/plan';
import type { RefreshResult } from '../core/ops/sync';
import { renderFiles } from '../core/serialize/entityFiles';
import { WorkspaceGoneError } from '../core/types';

const DEBOUNCE_MS = 300;

type Letter = 'M' | 'A' | 'D' | 'C';

export interface AutoPullSettings {
  readonly enabled: boolean;
  readonly intervalMs: number;
}

export interface MirrorDeps {
  readonly api: GtmApi;
  readonly output: vscode.OutputChannel;
  readonly diagnostics: vscode.DiagnosticCollection;
  readonly autoPull: AutoPullSettings;
  readonly onDidChange: () => void;
}

export function autoPullConfig(): AutoPullSettings {
  const section = vscode.workspace.getConfiguration('gsCode.autoPull');
  return {
    enabled: section.get<boolean>('enabled', true),
    intervalMs: clampInterval(section.get<number>('intervalSeconds', DEFAULT_INTERVAL_SECONDS)),
  };
}

/** Unsaved editors under `root`, keyed by mirror-relative path. They count as local edits. */
export function dirtyOverlay(root: string): Overlay {
  const overlay = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty || doc.uri.scheme !== 'file' || !doc.uri.fsPath.startsWith(root + path.sep)) continue;
    overlay.set(path.relative(root, doc.uri.fsPath).split(path.sep).join('/'), doc.getText());
  }
  return overlay;
}
const COLORS: Record<Letter, string> = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.untrackedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  C: 'gitDecoration.conflictingResourceForeground',
};
const LABELS: Record<Letter, string> = { M: 'Modified', A: 'Added', D: 'Deleted', C: 'Conflict' };

export interface ResourceState extends vscode.SourceControlResourceState {
  readonly base: string;
  readonly letter: Letter;
  readonly gtmConflict?: GtmConflict;
}

/** One mirrored GTM workspace folder: its Source Control view, decorations and diagnostics. */
export class MirrorController implements vscode.Disposable, vscode.QuickDiffProvider {
  readonly scm: vscode.SourceControl;
  private readonly changes: vscode.SourceControlResourceGroup;
  private readonly conflicts: vscode.SourceControlResourceGroup;
  private readonly gtmConflicts: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decorated = new Map<string, Letter>();
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly onDidChange: () => void;
  private notifiedConflicts = '';
  private notifiedBehind?: string;
  readonly autoPull: AutoPull;
  state?: MirrorState;
  status?: WorkingStatus;

  static async create(root: string, deps: MirrorDeps): Promise<MirrorController> {
    const state = await readState(root);
    const controller = new MirrorController(root, `GTM ${state.container.publicId}`, deps);
    controller.state = state;
    return controller;
  }

  private constructor(
    readonly root: string,
    scmLabel: string,
    private readonly deps: MirrorDeps,
  ) {
    this.diagnostics = deps.diagnostics;
    this.onDidChange = deps.onDidChange;
    this.autoPull = new AutoPull(root, deps.api, {
      intervalMs: deps.autoPull.intervalMs,
      exclusive: (task) => this.exclusive(task),
      overlay: () => dirtyOverlay(root),
      onResult: (result) => void this.afterRefresh(result, 'auto'),
      onError: (error, fatal) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.output.appendLine(`Auto-pull ${this.label}: ${fatal ? 'stopped' : 'failed, will retry'}: ${message}`);
        if (fatal && error instanceof WorkspaceGoneError) {
          void vscode.window.showWarningMessage(`GS Code: ${message}`, 'Switch Workspace…').then((choice) => {
            if (choice) void vscode.commands.executeCommand('gsCode.switchWorkspace', this.scm);
          });
        } else if (fatal) {
          void vscode.window.showWarningMessage(`GS Code stopped checking GTM for changes: ${message}`, 'Sign In').then((choice) => {
            if (choice) void vscode.commands.executeCommand('gsCode.signIn');
          });
        }
        this.onDidChange();
      },
    });
    const rootUri = vscode.Uri.file(root);
    this.scm = vscode.scm.createSourceControl('gtm', scmLabel, rootUri);
    this.scm.quickDiffProvider = this;
    this.scm.inputBox.visible = false;
    this.gtmConflicts = this.scm.createResourceGroup('gtmConflicts', 'GTM merge conflicts (latest version)');
    this.conflicts = this.scm.createResourceGroup('conflicts', 'Conflicts');
    this.changes = this.scm.createResourceGroup('changes', 'Changes to push');
    this.conflicts.hideWhenEmpty = true;
    this.gtmConflicts.hideWhenEmpty = true;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, '**/*'));
    const schedule = (uri: vscode.Uri) => {
      const internal = [BASE_DIR, REMOTE_DIR, MERGE_DIR].some((dir) => uri.fsPath.startsWith(path.join(root, dir)));
      if (!internal) this.scheduleRefresh();
    };
    watcher.onDidChange(schedule, null, this.disposables);
    watcher.onDidCreate(schedule, null, this.disposables);
    watcher.onDidDelete(schedule, null, this.disposables);
    this.disposables.push(watcher, this.scm, { dispose: () => this.autoPull.stop() });
    if (deps.autoPull.enabled) this.autoPull.start();
  }

  applySettings(settings: AutoPullSettings): void {
    if (!settings.enabled) {
      this.autoPull.stop();
      return;
    }
    this.autoPull.setInterval(settings.intervalMs);
    this.autoPull.start();
  }

  /** Update the views after any refresh (auto or a command) and tell the user what arrived. */
  async afterRefresh(result: RefreshResult, source: 'auto' | 'command'): Promise<void> {
    await this.refresh();
    if (result.behind && result.behind !== this.notifiedBehind && !result.syncSkipped) {
      this.notifiedBehind = result.behind;
      void vscode.window
        .showInformationMessage(`GS Code: container version ${result.behind} was published. Pull to bring "${this.state?.workspace.name ?? 'this workspace'}" up to date.`, 'Pull')
        .then((choice) => {
          if (choice) void vscode.commands.executeCommand('gsCode.pull', this.scm);
        });
    }
    if (!result.pulled) return;
    const summary = describeRefresh(result);
    this.deps.output.appendLine(`${new Date().toLocaleTimeString()} ${source === 'auto' ? 'Auto-pull' : 'Pull'} ${this.label}: ${summary}`);
    if (source === 'auto') vscode.window.setStatusBarMessage(`$(cloud-download) GS Code: ${summary}`, 8000);
    const conflicts = [...result.state.conflicts, ...result.state.gtmConflicts.map((item) => `gtm:${item.base}`)].sort().join('|');
    if (conflicts && conflicts !== this.notifiedConflicts) {
      void vscode.window.showWarningMessage(`GS Code: GTM changes conflict with yours in ${this.label}. Resolve them in Source Control before pushing.`, 'Show').then((choice) => {
        if (choice) void vscode.commands.executeCommand('workbench.view.scm');
      });
    }
    this.notifiedConflicts = conflicts;
  }

  get label(): string {
    return this.state ? `${this.state.container.publicId} · ${this.state.workspace.name}` : path.basename(this.root);
  }

  /** Run one mirror operation at a time; refreshes wait until it finishes. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.busy = true;
      try {
        return await task();
      } finally {
        this.busy = false;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    if (this.busy) {
      this.scheduleRefresh();
      return;
    }
    this.state = await readState(this.root);
    this.status = await workingStatus(this.root, this.state);
    this.scm.count = countChanges(this.status.changes) + this.state.conflicts.length + this.state.gtmConflicts.length;
    this.conflicts.resourceStates = this.state.conflicts.flatMap((base) => this.conflictStates(base));
    this.gtmConflicts.resourceStates = this.state.gtmConflicts.map((conflict) => this.gtmConflictState(conflict));
    this.changes.resourceStates = [
      ...this.status.changes.entities.flatMap((change) => this.changeStates(change)),
      ...this.wholeFileStates(),
    ];
    this.updateDecorations();
    this.updateDiagnostics();
    this.onDidChange();
  }

  /** Original side for inline quick diff in the editor gutter. */
  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    const rel = path.relative(this.root, uri.fsPath);
    if (rel.startsWith('..') || rel.startsWith(STATE_DIR)) return undefined;
    return vscode.Uri.file(path.join(this.root, BASE_DIR, rel));
  }

  decorationFor(uri: vscode.Uri): Letter | undefined {
    return this.decorated.get(uri.fsPath);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((item) => item.dispose());
  }

  private changeStates(change: EntityChange): ResourceState[] {
    const localFiles = change.local ? renderFiles(change.local) : new Map<string, string>();
    const baseFiles = change.original ? renderFiles(change.original) : new Map<string, string>();
    const letter: Letter = change.type === 'added' ? 'A' : change.type === 'deleted' ? 'D' : 'M';
    const files = change.type === 'deleted'
      ? [...baseFiles.keys()]
      : [...localFiles].filter(([file, content]) => change.type === 'added' || baseFiles.get(this.baseFileFor(change, file)) !== content).map(([file]) => file);
    return files.map((file) => this.state_(file, change.base, letter, change.type === 'deleted' ? file : this.baseFileFor(change, file)));
  }

  private baseFileFor(change: EntityChange, file: string): string {
    return change.previousBase ? change.previousBase + file.slice(change.base.length) : file;
  }

  private wholeFileStates(): ResourceState[] {
    const changes = this.status?.changes;
    if (!changes) return [];
    const states: ResourceState[] = [];
    if (changes.folders.length) states.push(this.state_(FOLDERS_FILE, FOLDERS_FILE, 'M', FOLDERS_FILE));
    if (changes.builtIns.enable.length || changes.builtIns.disable.length) states.push(this.state_(BUILTINS_FILE, BUILTINS_FILE, 'M', BUILTINS_FILE));
    return states;
  }

  private conflictStates(base: string): ResourceState[] {
    const doc = this.status?.local.docs.get(base) ?? this.status?.base.docs.get(base);
    const files = doc ? [...renderFiles(doc).keys()] : [`${base}.json`];
    return files.map((file): ResourceState => {
      const localUri = vscode.Uri.file(path.join(this.root, file));
      const remoteUri = vscode.Uri.file(path.join(this.root, REMOTE_DIR, file));
      return {
        base,
        letter: 'C',
        resourceUri: localUri,
        contextValue: 'conflict',
        decorations: { tooltip: 'Changed locally and in GTM', iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor(COLORS.C)) },
        command: { title: 'Compare', command: 'vscode.diff', arguments: [remoteUri, localUri, `${path.basename(file)} (GTM ↔ Local)`] },
      };
    });
  }

  private gtmConflictState(conflict: GtmConflict): ResourceState {
    const doc = this.status?.local.docs.get(conflict.base);
    const file = doc ? ([...renderFiles(doc).keys()][0] ?? `${conflict.base}.json`) : `${conflict.base}.json`;
    const localUri = vscode.Uri.file(path.join(this.root, file));
    const latestUri = vscode.Uri.file(path.join(this.root, MERGE_DIR, file));
    const tooltip = `Workspace: ${conflict.workspaceChange ?? 'changed'} · Latest version: ${conflict.latestChange ?? 'changed'}`;
    return {
      base: conflict.base,
      letter: 'C',
      gtmConflict: conflict,
      resourceUri: localUri,
      contextValue: 'gtmConflict',
      decorations: { tooltip, iconPath: new vscode.ThemeIcon('git-merge', new vscode.ThemeColor(COLORS.C)) },
      command: conflict.latestChange === 'deleted'
        ? { title: 'Open', command: 'vscode.open', arguments: [localUri] }
        : { title: 'Compare', command: 'vscode.diff', arguments: [latestUri, localUri, `${path.basename(file)} (Latest version ↔ Workspace)`] },
    };
  }

  private state_(file: string, base: string, letter: Letter, baseFile: string): ResourceState {
    const localUri = vscode.Uri.file(path.join(this.root, file));
    const baseUri = vscode.Uri.file(path.join(this.root, BASE_DIR, baseFile));
    const title = `${path.basename(file)} (${LABELS[letter]})`;
    const command: vscode.Command =
      letter === 'A' ? { title: 'Open', command: 'vscode.open', arguments: [localUri] }
      : letter === 'D' ? { title: 'Open', command: 'vscode.open', arguments: [baseUri] }
      : { title: 'Compare', command: 'vscode.diff', arguments: [baseUri, localUri, `${path.basename(file)} (GTM ↔ Local)`] };
    return {
      base,
      letter,
      resourceUri: localUri,
      contextValue: 'change',
      command,
      decorations: {
        strikeThrough: letter === 'D',
        tooltip: `${LABELS[letter]}: ${title}`,
        iconPath: new vscode.ThemeIcon(letter === 'A' ? 'diff-added' : letter === 'D' ? 'diff-removed' : 'diff-modified', new vscode.ThemeColor(COLORS[letter])),
      },
    };
  }

  private updateDecorations(): void {
    this.decorated.clear();
    for (const state of [...this.changes.resourceStates, ...this.conflicts.resourceStates, ...this.gtmConflicts.resourceStates] as ResourceState[]) {
      this.decorated.set(state.resourceUri.fsPath, state.letter);
    }
  }

  private updateDiagnostics(): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (rel: string, message: string, severity: vscode.DiagnosticSeverity) => {
      const file = path.join(this.root, rel);
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, severity);
      diagnostic.source = 'GTM';
      byFile.set(file, [...(byFile.get(file) ?? []), diagnostic]);
    };
    for (const problem of this.status?.problems ?? []) add(problem.path, problem.message, vscode.DiagnosticSeverity.Error);
    for (const issue of this.status?.issues ?? []) {
      add(issue.path, issue.message, issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    }
    this.diagnostics.forEach((uri) => {
      if (uri.fsPath.startsWith(this.root)) this.diagnostics.delete(uri);
    });
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(file), list);
  }
}

export class GtmDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly controllers: () => readonly MirrorController[]) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    for (const controller of this.controllers()) {
      const letter = controller.decorationFor(uri);
      if (letter) return new vscode.FileDecoration(letter, LABELS[letter], new vscode.ThemeColor(COLORS[letter]));
    }
    return undefined;
  }
}
