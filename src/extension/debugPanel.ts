import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GtmApi } from '../core/api';
import { readState } from '../core/mirror/state';
import type { BrowserOptions } from '../debugger/browser';
import { Explainer, type TagExplanation } from '../debugger/explain';
import { eventContext, loadMirrorDocs, predictClient, resolveWorkspacePreview } from '../debugger/mirrorContext';
import { DebugSession } from '../debugger/session';
import { Timeline } from '../debugger/timeline';
import { DEBUG_DIR } from '../debugger/toolkit';
import { VariableResolver } from '../debugger/variables';

const UPDATE_MS = 250;

export interface DebugSettings {
  readonly browser: BrowserOptions;
  readonly sgtmHosts: readonly string[];
  readonly loaderPatterns: readonly string[];
  readonly dataLayerName: string;
  readonly tagStatus: boolean;
}

export function debugSettings(context: vscode.ExtensionContext): DebugSettings {
  const section = vscode.workspace.getConfiguration('gsCode.debug');
  const browserUrl = section.get<string>('browserUrl', '').trim();
  const browserPath = section.get<string>('browserPath', '').trim();
  return {
    browser: {
      browserUrl: browserUrl || undefined,
      executablePath: browserPath || undefined,
      profileDir: path.join(context.globalStorageUri.fsPath, 'browser-profile'),
    },
    sgtmHosts: section.get<string[]>('sgtmHosts', []),
    loaderPatterns: section.get<string[]>('loaderPatterns', []),
    dataLayerName: section.get<string>('dataLayerName', 'dataLayer'),
    tagStatus: section.get<boolean>('tagStatus', true),
  };
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'start'; url: string; mode: 'workspace' | 'live' }
  | { type: 'stop' | 'reload' | 'openLast' }
  | { type: 'navigate'; url: string }
  | { type: 'select'; seq: number; live?: boolean }
  | { type: 'openFile'; file: string }
  | { type: 'push'; json: string };

/** The "GS Code Debugger" panel for one mirror: drives a DebugSession and shows its timeline. */
export class DebugPanel implements vscode.Disposable {
  private static current?: DebugPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private session?: DebugSession;
  private timeline?: Timeline;
  private timer?: NodeJS.Timeout;
  private selected?: number;

  static show(context: vscode.ExtensionContext, api: GtmApi, root: string, output: vscode.OutputChannel): DebugPanel {
    if (DebugPanel.current && DebugPanel.current.root === root) {
      DebugPanel.current.panel.reveal();
      return DebugPanel.current;
    }
    DebugPanel.current?.dispose();
    DebugPanel.current = new DebugPanel(context, api, root, output);
    return DebugPanel.current;
  }

  /** The live session, shared with the language-model tools so Copilot sees what the panel sees. */
  static activeSession(): DebugSession | undefined {
    return DebugPanel.current?.session;
  }

  static activeRoot(): string | undefined {
    return DebugPanel.current?.root;
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: GtmApi,
    readonly root: string,
    private readonly output: vscode.OutputChannel,
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'debugger');
    this.panel = vscode.window.createWebviewPanel('gsCode.debugger', `Debug: ${path.basename(root)}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.html(media);
    this.panel.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(message).catch((error: unknown) => this.error(error)), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Start from a command (or an agent tool) without going through the webview form. */
  async start(url: string, mode: 'workspace' | 'live'): Promise<DebugSession> {
    await this.session?.stop();
    const state = await readState(this.root);
    const docs = await loadMirrorDocs(this.root, state);
    const settings = debugSettings(this.context);
    this.post({ type: 'status', text: mode === 'workspace' ? `Preparing a preview of workspace "${state.workspace.name}"…` : 'Opening the browser…' });
    const preview = mode === 'workspace' ? await resolveWorkspacePreview(this.api, state) : undefined;
    const session = new DebugSession({
      url,
      browser: settings.browser,
      preview,
      logDir: path.join(this.root, DEBUG_DIR),
      tagNames: docs.tagNames,
      container: state.container.publicId,
      workspace: state.workspace.name,
      sgtmHosts: settings.sgtmHosts,
      loaderPatterns: settings.loaderPatterns,
      dataLayerName: settings.dataLayerName,
      tagStatus: settings.tagStatus,
    });
    session.on('record', () => this.scheduleUpdate());
    session.on('stopped', () => this.postSession());
    await session.start();
    this.session = session;
    this.timeline = session.timeline;
    this.selected = undefined;
    this.output.appendLine(`Debugger: recording ${url} (${mode}). Session file: ${session.file ?? 'none'}`);
    this.postSession();
    this.scheduleUpdate();
    return session;
  }

  /** Show a session started elsewhere (an agent's debug_start) in this panel. */
  adopt(session: DebugSession): void {
    if (this.session === session) return;
    this.session = session;
    this.timeline = session.timeline;
    this.selected = undefined;
    session.on('record', () => this.scheduleUpdate());
    session.on('stopped', () => this.postSession());
    this.postSession();
    this.scheduleUpdate();
  }

  dispose(): void {
    if (DebugPanel.current === this) DebugPanel.current = undefined;
    clearTimeout(this.timer);
    void this.session?.stop();
    this.disposables.forEach((item) => item.dispose());
    this.panel.dispose();
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postSession();
        if (!this.timeline) await this.loadLast(false);
        this.update();
        return;
      case 'start':
        await this.start(message.url, message.mode);
        return;
      case 'stop':
        await this.session?.stop();
        this.postSession();
        return;
      case 'reload':
        await this.session?.reload();
        return;
      case 'navigate':
        await this.session?.navigate(message.url);
        return;
      case 'openLast':
        await this.loadLast(true);
        return;
      case 'select':
        this.selected = message.seq;
        await this.postDetail(message.seq, message.live === true);
        return;
      case 'openFile': {
        const file = path.join(this.root, message.file);
        if (!file.startsWith(this.root + path.sep)) return;
        await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.One, preview: false });
        return;
      }
      case 'push':
        await this.session?.push(JSON.parse(message.json) as Record<string, unknown>);
    }
  }

  private async loadLast(complain: boolean): Promise<void> {
    const dir = path.join(this.root, DEBUG_DIR);
    const latest = (await fs.readFile(path.join(dir, 'latest'), 'utf8').catch(() => '')).trim();
    if (!latest) {
      if (complain) this.post({ type: 'status', text: 'No recorded session yet.' });
      return;
    }
    const docs = await loadMirrorDocs(this.root, await readState(this.root));
    this.timeline = await Timeline.fromFile(path.join(dir, latest), docs.tagNames);
    this.post({ type: 'status', text: `Showing the last recorded session (${latest}).` });
    this.update();
  }

  private scheduleUpdate(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.update();
    }, UPDATE_MS);
  }

  private update(): void {
    const timeline = this.timeline;
    if (!timeline) return;
    this.post({
      type: 'timeline',
      pages: timeline.pages,
      events: timeline.events.map((event) => ({
        seq: event.seq,
        page: event.page,
        t: event.t,
        event: event.event ?? '(message)',
        command: event.command !== undefined,
        fired: event.tags.filter((tag) => tag.status === 'success').length,
        failed: event.tags.filter((tag) => tag.status !== 'success').length,
        hits: event.hits.length,
      })),
      notes: timeline.notes.slice(-20),
    });
    if (this.selected !== undefined) void this.postDetail(this.selected, false);
  }

  private async postDetail(seq: number, live: boolean): Promise<void> {
    const timeline = this.timeline;
    const event = timeline?.event(seq);
    if (!timeline || !event) return;
    const state = await readState(this.root);
    const docs = await loadMirrorDocs(this.root, state);
    const session = live && this.session?.running ? this.session : undefined;
    const explainer = new Explainer(docs, new VariableResolver(docs.variables, docs.builtInNames, session ? (expression) => session.evaluate(expression) : undefined));
    const ctx = eventContext(timeline, event, state.container.publicId);
    const explanations: (TagExplanation & { observed?: string })[] = [];
    for (const name of explainer.tagNames()) {
      const result = await explainer.explainTag(name, ctx);
      if (result) explanations.push({ ...result, observed: event.tags.find((tag) => tag.name === name)?.status });
    }
    const order = { fires: 0, unknown: 1, 'does-not-fire': 2 } as const;
    explanations.sort((a, b) => Number(!!b.observed) - Number(!!a.observed) || order[a.verdict] - order[b.verdict] || a.tag.localeCompare(b.tag));
    this.post({
      type: 'detail',
      live: !!session,
      event: { seq: event.seq, event: event.event, url: event.url, pushed: event.data ?? event.command, model: event.model, consent: event.consent, tags: event.tags, uniqueEventId: event.uniqueEventId },
      hits: event.hits.map((hit) => ({ ...hit, client: hit.firstParty ? predictClient(hit, docs.clients) : undefined })),
      explanations,
    });
  }

  private postSession(): void {
    const record = this.session?.timeline.session ?? this.timeline?.session;
    this.post({ type: 'session', running: this.session?.running === true, url: record?.url, mode: record?.mode, container: record?.container, workspace: record?.workspace, file: this.session?.file });
  }

  private error(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`Debugger: ${message}`);
    this.post({ type: 'error', text: message });
  }

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>GS Code Debugger</title>
</head>
<body>
<form id="toolbar" class="toolbar" autocomplete="off">
  <label class="sr-only" for="url">Page URL</label>
  <input id="url" type="url" placeholder="https://your-site.example/page" required>
  <label class="sr-only" for="mode">What to load</label>
  <select id="mode" title="What to load">
    <option value="workspace">Workspace draft (unpublished)</option>
    <option value="live">Live container</option>
  </select>
  <button id="start" type="submit">Start</button>
  <button id="reload" type="button" class="secondary" disabled>Reload</button>
  <button id="stop" type="button" class="secondary" disabled>Stop</button>
  <button id="openLast" type="button" class="secondary">Last session</button>
</form>
<p id="status" class="status" role="status" aria-live="polite"></p>
<main class="layout">
  <nav class="events" aria-label="Events">
    <ol id="events"></ol>
    <p id="eventsEmpty" class="empty">Start a session to record dataLayer events, tags, consent and hits.</p>
  </nav>
  <section class="detail" aria-label="Event detail">
    <div id="detailEmpty" class="empty">Select an event.</div>
    <div id="detail" hidden>
      <header class="detail-head">
        <h1 id="detailTitle"></h1>
        <p id="detailMeta" class="meta"></p>
      </header>
      <div class="tabs" role="tablist" aria-label="Event detail">
        <button role="tab" id="tab-tags" aria-controls="pane-tags" aria-selected="true">Tags</button>
        <button role="tab" id="tab-hits" aria-controls="pane-hits" aria-selected="false">Hits</button>
        <button role="tab" id="tab-model" aria-controls="pane-model" aria-selected="false">Data model</button>
        <button role="tab" id="tab-pushed" aria-controls="pane-pushed" aria-selected="false">Pushed</button>
        <button role="tab" id="tab-consent" aria-controls="pane-consent" aria-selected="false">Consent</button>
      </div>
      <div role="tabpanel" id="pane-tags" aria-labelledby="tab-tags">
        <div class="pane-tools">
          <label><input type="checkbox" id="onlyRelevant" checked> Only tags that fired or might</label>
          <button id="live" type="button" class="secondary" title="Re-evaluate custom JavaScript, cookies, JS and DOM variables in the open page">Evaluate in page</button>
        </div>
        <ul id="tags" class="tags"></ul>
      </div>
      <div role="tabpanel" id="pane-hits" aria-labelledby="tab-hits" hidden><ul id="hits" class="hits"></ul></div>
      <div role="tabpanel" id="pane-model" aria-labelledby="tab-model" hidden><pre id="model"></pre></div>
      <div role="tabpanel" id="pane-pushed" aria-labelledby="tab-pushed" hidden><pre id="pushed"></pre></div>
      <div role="tabpanel" id="pane-consent" aria-labelledby="tab-consent" hidden><table id="consent" class="consent"></table></div>
    </div>
  </section>
</main>
<form id="pushForm" class="push" autocomplete="off">
  <label for="pushJson">Push to dataLayer</label>
  <input id="pushJson" placeholder='{"event":"purchase","ecommerce":{"value":10}}'>
  <button type="submit" class="secondary">Push</button>
</form>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
