import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GtmError } from '../core/types';
import { openBrowser, type Browser, type BrowserOptions } from './browser';
import type { CdpEvent } from './cdp';
import { classifyHit } from './hits';
import { probeSource } from './probe';
import { Timeline, type SessionRecord } from './timeline';

const BINDING = '__gsCodeEmit';

/** Load the unpublished workspace instead of the live container (an environment's preview credentials). */
export interface DraftPreview {
  readonly publicId: string;
  readonly gtmAuth: string;
  /** `env-<id>` */
  readonly gtmPreview: string;
}

export interface DebugSessionOptions {
  readonly url: string;
  readonly browser: BrowserOptions;
  readonly preview?: DraftPreview;
  /** Where the session file goes (normally `<mirror>/.gtm/debug`). */
  readonly logDir?: string;
  readonly dataLayerName?: string;
  readonly tagStatus?: boolean;
  readonly sgtmHosts?: readonly string[];
  /** Extra URL patterns that load gtm.js through a custom loader (e.g. a first-party sGTM path). */
  readonly loaderPatterns?: readonly string[];
  /** Tag id → name, to label tag statuses. */
  readonly tagNames?: ReadonlyMap<string, string>;
  readonly container?: string;
  readonly workspace?: string;
  /**
   * Use a tab that is already open in the attached browser (its URL starts with this) instead of
   * opening a new one. The tab is left open when the session stops.
   */
  readonly attachToTab?: string;
}

/**
 * One debugging session: a browser tab with the probe injected, optionally forced onto the draft
 * workspace, recording into a Timeline and a session file. Emits 'record' for every new record.
 */
export class DebugSession extends EventEmitter {
  readonly timeline: Timeline;
  file?: string;
  private browser?: Browser;
  private sessionId?: string;
  private targetId?: string;
  private ownTab = true;
  private page = 0;
  private stopped = false;
  private readonly pendingHits = new Set<string>();

  constructor(private readonly options: DebugSessionOptions) {
    super();
    this.timeline = new Timeline(options.tagNames);
  }

  get running(): boolean {
    return !!this.browser && !this.stopped && !this.browser.cdp.isClosed;
  }

  async start(): Promise<void> {
    if (this.options.logDir) {
      await fs.mkdir(this.options.logDir, { recursive: true });
      this.file = path.join(this.options.logDir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      await fs.writeFile(path.join(this.options.logDir, 'latest'), path.basename(this.file), 'utf8');
    }
    await this.record({ kind: 'session', t: Date.now(), url: this.options.url, mode: this.options.preview ? 'workspace' : 'live', container: this.options.container, workspace: this.options.workspace });
    this.browser = await openBrowser(this.options.browser);
    const cdp = this.browser.cdp;
    cdp.on('event', (event: CdpEvent) => void this.onEvent(event).catch((error: unknown) => this.note('error', String(error))));
    cdp.on('close', () => {
      this.stopped = true;
      this.emit('stopped');
    });
    const targetId = await this.pickTarget();
    this.targetId = targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Network.enable', { maxPostDataSize: 65536 });
    await this.send('Runtime.addBinding', { name: BINDING });
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: probeSource({ binding: BINDING, dataLayerName: this.options.dataLayerName ?? 'dataLayer', tagStatus: this.options.tagStatus !== false }),
    });
    if (this.options.preview) {
      const patterns = ['*googletagmanager.com/gtm.js*', ...(this.options.loaderPatterns ?? [])].map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
      await this.send('Fetch.enable', { patterns });
    }
    await this.navigate(this.options.url);
  }

  private async pickTarget(): Promise<string> {
    const cdp = (this.browser as Browser).cdp;
    if (this.options.attachToTab) {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
      const tab = targetInfos.find((info) => info.type === 'page' && info.url.startsWith(this.options.attachToTab as string));
      if (!tab) throw new GtmError(`No open tab starts with ${this.options.attachToTab}. Open the page in the browser first.`);
      this.ownTab = false;
      return tab.targetId;
    }
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    return targetId;
  }

  async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
  }

  async reload(): Promise<void> {
    await this.send('Page.reload', { ignoreCache: true });
  }

  /** Evaluate JS in the page (custom JS variables, cookies, DOM) and return its value. */
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new GtmError(result.exceptionDetails.exception?.description?.split('\n')[0] ?? result.exceptionDetails.text ?? 'evaluation failed');
    return result.result?.value;
  }

  /** Push to the page's dataLayer, as a site would (for reproducing events). */
  async push(data: Readonly<Record<string, unknown>>): Promise<void> {
    await this.evaluate(`window[${JSON.stringify(this.options.dataLayerName ?? 'dataLayer')}] = window[${JSON.stringify(this.options.dataLayerName ?? 'dataLayer')}] || []; window[${JSON.stringify(this.options.dataLayerName ?? 'dataLayer')}].push(${JSON.stringify(data)}); true`);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const browser = this.browser;
    if (!browser) return;
    if (browser.launched) await browser.close();
    else {
      // Attached to the user's own browser: close only a tab we opened, never their browser or their tab.
      if (this.targetId && this.ownTab) await browser.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
      else if (this.sessionId) await browser.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => undefined);
      browser.cdp.close();
    }
    this.emit('stopped');
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.browser) return Promise.reject(new GtmError('The debug session has not started.'));
    return this.browser.cdp.send<T>(method, params, this.sessionId);
  }

  private async onEvent(event: CdpEvent): Promise<void> {
    if (event.sessionId !== this.sessionId) return;
    const params = event.params;
    switch (event.method) {
      case 'Page.frameNavigated': {
        const frame = params.frame as { parentId?: string; url?: string };
        if (frame.parentId) return;
        this.page++;
        await this.record({ kind: 'page', t: Date.now(), page: this.page, url: String(frame.url ?? '') });
        return;
      }
      case 'Runtime.bindingCalled': {
        if (params.name !== BINDING) return;
        let message: unknown;
        try {
          message = JSON.parse(String(params.payload));
        } catch {
          return;
        }
        await this.record({ kind: 'probe', page: this.page, message: message as never });
        return;
      }
      case 'Network.requestWillBeSent': {
        const request = params.request as { url: string; method: string; postData?: string; hasPostData?: boolean };
        const wallTime = typeof params.wallTime === 'number' ? params.wallTime * 1000 : Date.now();
        let postData = request.postData;
        if (!postData && request.hasPostData) {
          postData = await this.send<{ postData?: string }>('Network.getRequestPostData', { requestId: params.requestId }).then((r) => r.postData, () => undefined);
        }
        const hit = classifyHit(request.url, request.method, postData, wallTime, { sgtmHosts: this.options.sgtmHosts });
        if (!hit) return;
        const requestId = String(params.requestId);
        this.pendingHits.add(requestId);
        await this.record({ kind: 'hit', page: this.page, requestId, hit });
        return;
      }
      case 'Network.responseReceived': {
        const requestId = String(params.requestId);
        if (!this.pendingHits.has(requestId)) return;
        const response = params.response as { status: number; headers?: Record<string, string> };
        const cookieHeader = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === 'set-cookie')?.[1];
        await this.record({ kind: 'response', requestId, status: response.status, setCookies: cookieHeader ? cookieHeader.split('\n') : undefined });
        return;
      }
      case 'Network.loadingFinished': {
        const requestId = String(params.requestId);
        if (!this.pendingHits.delete(requestId)) return;
        const hit = this.timeline.hitFor(requestId);
        if (!hit?.firstParty) return;
        // Responses from a server container are worth reading (errors, debug output); vendor pixels are not.
        const body = await this.send<{ body?: string; base64Encoded?: boolean }>('Network.getResponseBody', { requestId }).catch(() => undefined);
        if (body?.body && !body.base64Encoded) await this.record({ kind: 'response', requestId, status: hit.status ?? 0, body: body.body.slice(0, 20_000) });
        return;
      }
      case 'Fetch.requestPaused': {
        const request = params.request as { url: string };
        const rewritten = this.options.preview ? draftUrl(request.url, this.options.preview, this.options.loaderPatterns ?? []) : undefined;
        if (rewritten && rewritten !== request.url) await this.note('info', `Loading the draft workspace: ${rewritten.replace(/gtm_auth=[^&]+/, 'gtm_auth=…')}`);
        await this.send('Fetch.continueRequest', { requestId: params.requestId, ...(rewritten ? { url: rewritten } : {}) });
      }
    }
  }

  private async note(level: 'info' | 'warning' | 'error', message: string): Promise<void> {
    await this.record({ kind: 'note', t: Date.now(), level, message });
  }

  private async record(record: SessionRecord): Promise<void> {
    this.timeline.apply(record);
    if (this.file) await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    this.emit('record', record);
  }
}

/**
 * The gtm.js URL with the draft workspace's preview credentials. `gtm_cookies_win` is dropped so the URL,
 * not some old preview cookie, decides what loads. Custom loader URLs are redirected to googletagmanager.com.
 */
export function draftUrl(url: string, preview: DraftPreview, loaderPatterns: readonly string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const isGoogle = parsed.hostname.endsWith('googletagmanager.com') && parsed.pathname === '/gtm.js';
  if (isGoogle && parsed.searchParams.get('id')?.toUpperCase() !== preview.publicId.toUpperCase()) return undefined;
  if (!isGoogle && !loaderPatterns.some((pattern) => globToRegExp(pattern).test(url))) return undefined;
  const target = isGoogle ? parsed : new URL('https://www.googletagmanager.com/gtm.js');
  if (!isGoogle) {
    target.searchParams.set('id', preview.publicId);
    const layer = parsed.searchParams.get('l');
    if (layer) target.searchParams.set('l', layer);
  }
  target.searchParams.set('gtm_auth', preview.gtmAuth);
  target.searchParams.set('gtm_preview', preview.gtmPreview);
  target.searchParams.delete('gtm_cookies_win');
  return target.toString();
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}
