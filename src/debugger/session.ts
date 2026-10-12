import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GtmError } from '../core/types';
import { openBrowser, type Browser, type BrowserOptions } from './browser';
import type { CdpEvent } from './cdp';
import { classifyHit, redactGtmAuth } from './hits';
import { probeSource } from './probe';
import { Timeline, type SessionRecord } from './timeline';

const BINDING = '__gsCodeEmit';
/** Largest probe message accepted from the page; the page controls the binding, so bigger ones are dropped. */
const MAX_PROBE_PAYLOAD = 256 * 1024;
/** Shorter credentials are only redacted as `gtm_auth=` values, so a short string can't mangle a record. */
const MIN_REDACTED_SECRET = 8;
const GTM_HOSTS: ReadonlySet<string> = new Set(['www.googletagmanager.com', 'googletagmanager.com']);
const GTM_JS_PATTERNS = ['https://www.googletagmanager.com/gtm.js*', 'https://googletagmanager.com/gtm.js*'];

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
  /** Set once appending to the session file has failed; recording carries on in memory only. */
  private fileFailed = false;
  private readonly pendingHits = new Set<string>();

  constructor(private readonly options: DebugSessionOptions) {
    super();
    this.timeline = new Timeline(options.tagNames);
  }

  get running(): boolean {
    return !!this.browser && !this.stopped && !this.browser.cdp.isClosed;
  }

  async start(): Promise<void> {
    checkNavigableUrl(this.options.url);
    if (this.options.logDir) {
      await fs.mkdir(this.options.logDir, { recursive: true });
      this.file = path.join(this.options.logDir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      await fs.writeFile(path.join(this.options.logDir, 'latest'), path.basename(this.file), 'utf8');
    }
    await this.record({ kind: 'session', t: Date.now(), url: this.options.url, mode: this.options.preview ? 'workspace' : 'live', container: this.options.container, workspace: this.options.workspace });
    this.browser = await openBrowser(this.options.browser);
    const cdp = this.browser.cdp;
    cdp.on('event', (event: CdpEvent) => void this.onEvent(event).catch((error: unknown) => this.reportError(error)));
    cdp.on('close', () => {
      this.stopped = true;
      this.emit('stopped');
    });
    // A socket error would otherwise be an uncaught 'error' event: note it and treat it as a close.
    cdp.on('error', (error: Error) => {
      this.reportError(`The browser connection failed: ${error.message}`);
      cdp.close();
    });
    try {
      await this.attach();
    } catch (error) {
      // Don't leave a launched browser (or our tab in the user's browser) behind.
      this.stopped = true;
      await this.release().catch((releaseError: unknown) => this.reportError(`Could not close the browser: ${String(releaseError)}`));
      throw error;
    }
  }

  private async attach(): Promise<void> {
    const cdp = (this.browser as Browser).cdp;
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
      const patterns = [...GTM_JS_PATTERNS, ...(this.options.loaderPatterns ?? [])].map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
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
    checkNavigableUrl(url);
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
    if (!this.browser) return;
    await this.release();
    this.emit('stopped');
  }

  /** Close the browser if we launched it, else only the tab we opened (or detach from the user's tab). */
  private async release(): Promise<void> {
    const browser = this.browser;
    if (!browser) return;
    if (browser.launched) await browser.close();
    else {
      // Attached to the user's own browser: close only a tab we opened, never their browser or their tab.
      if (this.targetId && this.ownTab) await browser.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
      else if (this.sessionId) await browser.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => undefined);
      browser.cdp.close();
    }
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
        const payload = String(params.payload);
        if (payload.length > MAX_PROBE_PAYLOAD) {
          await this.note('warning', `Dropped a ${Math.round(payload.length / 1024)} KB probe message (limit ${MAX_PROBE_PAYLOAD / 1024} KB).`);
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(payload);
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
        // The request stays paused until continued, so continue it whatever happens on the way.
        let rewritten: string | undefined;
        try {
          const request = params.request as { url: string };
          rewritten = this.options.preview ? draftUrl(request.url, this.options.preview, this.options.loaderPatterns ?? []) : undefined;
          if (rewritten && rewritten !== request.url) await this.note('info', `Loading the draft workspace: ${redactGtmAuth(rewritten)}`);
        } finally {
          await this.send('Fetch.continueRequest', { requestId: params.requestId, ...(rewritten ? { url: rewritten } : {}) });
        }
      }
    }
  }

  private async note(level: 'info' | 'warning' | 'error', message: string): Promise<void> {
    await this.record({ kind: 'note', t: Date.now(), level, message });
  }

  /** Never throws: an error that can't even be noted goes out as a 'fault' event. */
  private reportError(error: unknown): void {
    this.note('error', String(error)).catch((noteError: unknown) => this.emit('fault', noteError));
  }

  private async record(original: SessionRecord): Promise<void> {
    const record = this.redact(original);
    this.timeline.apply(record);
    this.emit('record', record);
    if (!this.file || this.fileFailed) return;
    try {
      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      // Keep debugging in memory rather than crash or stall the page; say so once.
      this.fileFailed = true;
      this.emit('fault', error);
      await this.note('error', `Stopped writing ${this.file}: ${error instanceof Error ? error.message : String(error)}. The session continues in memory only.`);
    }
  }

  /** Strip the draft preview credential (gtm_auth) from anything recorded, saved or shown to an agent. */
  private redact(record: SessionRecord): SessionRecord {
    const json = JSON.stringify(record);
    const auth = this.options.preview?.gtmAuth;
    let redacted = redactGtmAuth(json);
    if (auth && auth.length >= MIN_REDACTED_SECRET) redacted = redacted.split(auth).join('…');
    return redacted === json ? record : (JSON.parse(redacted) as SessionRecord);
  }
}

/** Only web pages: no file:, chrome:, javascript: or view-source: URLs (about:blank is allowed). */
export function checkNavigableUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GtmError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.href === 'about:blank') return;
  throw new GtmError(`Only http:// and https:// pages can be debugged, not ${parsed.protocol} URLs.`);
}

/**
 * The gtm.js URL with the draft workspace's preview credentials. Only `id` and `l` are kept (so
 * `gtm_cookies_win` is dropped and the URL, not some old preview cookie, decides what loads). Custom
 * loader URLs are redirected to googletagmanager.com.
 */
export function draftUrl(url: string, preview: DraftPreview, loaderPatterns: readonly string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // Exact hosts over https only, so a look-alike host never receives the preview credentials.
  const isGoogle = parsed.protocol === 'https:' && GTM_HOSTS.has(parsed.hostname) && parsed.pathname === '/gtm.js';
  if (isGoogle && parsed.searchParams.get('id')?.toUpperCase() !== preview.publicId.toUpperCase()) return undefined;
  if (!isGoogle && !loaderPatterns.some((pattern) => globToRegExp(pattern).test(url))) return undefined;
  // Always a fresh Google URL carrying only id and l, whatever else the original had.
  const target = new URL('https://www.googletagmanager.com/gtm.js');
  target.searchParams.set('id', preview.publicId);
  const layer = parsed.searchParams.get('l');
  if (layer) target.searchParams.set('l', layer);
  target.searchParams.set('gtm_auth', preview.gtmAuth);
  target.searchParams.set('gtm_preview', preview.gtmPreview);
  return target.toString();
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}
