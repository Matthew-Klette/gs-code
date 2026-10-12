import type { EntityDoc } from '../core/serialize/entityFiles';
import { getPath, type DataModel } from './dataModel';

/** What we know about one event when explaining it. */
export interface EventContext {
  readonly event: string | undefined;
  /** The data model right after this push (rebuilt from all earlier pushes). */
  readonly model: DataModel;
  readonly pageUrl: string;
  readonly referrer?: string;
  readonly containerPublicId: string;
  /** Consent state at this event (type → granted?). */
  readonly consent: Readonly<Record<string, boolean | undefined>>;
}

/** A resolved `{{Variable}}`: `known: false` means GS Code cannot compute it offline. */
export interface Resolved {
  readonly value: unknown;
  readonly known: boolean;
  /** How the value was obtained, shown in explanations. */
  readonly source: string;
}

/** Evaluates JS in the page now (custom JS, JS variables, cookies, DOM): values as of now, not as of the event. */
export type PageEvaluator = (expression: string) => Promise<unknown>;

/** Built-in variable type → where GTM reads it from (data-model key, or a special source). */
const BUILT_IN_KEYS: Readonly<Record<string, string>> = {
  EVENT: 'event',
  CLICK_ELEMENT: 'gtm.element',
  CLICK_CLASSES: 'gtm.elementClasses',
  CLICK_ID: 'gtm.elementId',
  CLICK_TARGET: 'gtm.elementTarget',
  CLICK_URL: 'gtm.elementUrl',
  CLICK_TEXT: '@elementText',
  FORM_ELEMENT: 'gtm.element',
  FORM_CLASSES: 'gtm.elementClasses',
  FORM_ID: 'gtm.elementId',
  FORM_TARGET: 'gtm.elementTarget',
  FORM_URL: 'gtm.elementUrl',
  FORM_TEXT: '@elementText',
  ERROR_MESSAGE: 'gtm.errorMessage',
  ERROR_URL: 'gtm.errorUrl',
  ERROR_LINE: 'gtm.errorLineNumber',
  DEBUG_MODE: '@false',
  NEW_HISTORY_FRAGMENT: 'gtm.newUrlFragment',
  OLD_HISTORY_FRAGMENT: 'gtm.oldUrlFragment',
  NEW_HISTORY_STATE: 'gtm.newHistoryState',
  OLD_HISTORY_STATE: 'gtm.oldHistoryState',
  NEW_HISTORY_URL: 'gtm.newUrl',
  OLD_HISTORY_URL: 'gtm.oldUrl',
  HISTORY_SOURCE: 'gtm.historyChangeSource',
  SCROLL_DEPTH_THRESHOLD: 'gtm.scrollThreshold',
  SCROLL_DEPTH_UNITS: 'gtm.scrollUnits',
  SCROLL_DEPTH_DIRECTION: 'gtm.scrollDirection',
  ELEMENT_VISIBILITY_RATIO: 'gtm.visibleRatio',
  ELEMENT_VISIBILITY_TIME: 'gtm.visibleTime',
  ELEMENT_VISIBILITY_FIRST_TIME: 'gtm.visibleFirstTime',
  ELEMENT_VISIBILITY_RECENT_TIME: 'gtm.visibleLastTime',
  VIDEO_PROVIDER: 'gtm.videoProvider',
  VIDEO_URL: 'gtm.videoUrl',
  VIDEO_TITLE: 'gtm.videoTitle',
  VIDEO_DURATION: 'gtm.videoDuration',
  VIDEO_PERCENT: 'gtm.videoPercent',
  VIDEO_VISIBLE: 'gtm.videoVisible',
  VIDEO_STATUS: 'gtm.videoStatus',
  VIDEO_CURRENT_TIME: 'gtm.videoCurrentTime',
  PAGE_URL: '@url',
  PAGE_HOSTNAME: '@hostname',
  PAGE_PATH: '@path',
  REFERRER: '@referrer',
  CONTAINER_ID: '@container',
};

/** Resolves `{{Name}}` against the mirror's variables for one event. */
export class VariableResolver {
  private readonly byName: ReadonlyMap<string, EntityDoc>;
  private readonly builtInByName: ReadonlyMap<string, string>;

  constructor(
    variables: readonly EntityDoc[],
    /** Built-in type → display name, from the mirror state. */
    builtInNames: Readonly<Record<string, string>>,
    private readonly page?: PageEvaluator,
  ) {
    this.byName = new Map(variables.map((doc) => [String(doc.data.name), doc]));
    this.builtInByName = new Map(Object.entries(builtInNames).map(([type, name]) => [name, type]));
  }

  variableDoc(name: string): EntityDoc | undefined {
    return this.byName.get(name);
  }

  async resolve(name: string, ctx: EventContext, depth = 0): Promise<Resolved> {
    if (depth > 8) return { value: undefined, known: false, source: 'variable references nest too deep' };
    if (name === '_event') return { value: ctx.event, known: true, source: 'event name' };
    if (name === '_url') return { value: ctx.pageUrl, known: true, source: 'page URL' };
    const builtIn = this.builtInByName.get(name);
    if (builtIn) return this.builtIn(builtIn, ctx);
    const doc = this.byName.get(name);
    if (!doc) return { value: undefined, known: false, source: `{{${name}}} is not a variable in this workspace` };
    return this.userVariable(doc, ctx, depth);
  }

  /** Replace every `{{X}}` in a string with its resolved value (as GTM does in templates fields). */
  async interpolate(text: string, ctx: EventContext, depth = 0): Promise<Resolved> {
    const refs = [...text.matchAll(/\{\{([^{}]+)\}\}/g)];
    if (refs.length === 0) return { value: text, known: true, source: 'literal' };
    // A field that is exactly one variable keeps that variable's type (number, boolean…).
    if (refs.length === 1 && refs[0]?.[0] === text) return this.resolve((refs[0][1] ?? '').trim(), ctx, depth + 1);
    let out = text;
    let known = true;
    for (const ref of refs) {
      const resolved = await this.resolve((ref[1] ?? '').trim(), ctx, depth + 1);
      known &&= resolved.known;
      out = out.replace(ref[0], stringify(resolved.value));
    }
    return { value: out, known, source: 'interpolated' };
  }

  private builtIn(type: string, ctx: EventContext): Resolved {
    const key = BUILT_IN_KEYS[type];
    const url = safeUrl(ctx.pageUrl);
    switch (key) {
      case undefined:
        return { value: undefined, known: false, source: `built-in ${type} is not computed by the debugger` };
      case '@url':
        return { value: ctx.pageUrl, known: true, source: 'page URL' };
      case '@hostname':
        return { value: url?.hostname, known: !!url, source: 'page URL' };
      case '@path':
        return { value: url?.pathname, known: !!url, source: 'page URL' };
      case '@referrer':
        return { value: ctx.referrer, known: ctx.referrer !== undefined, source: 'document.referrer' };
      case '@container':
        return { value: ctx.containerPublicId, known: true, source: 'container' };
      case '@false':
        return { value: false, known: true, source: 'debugger (not GTM preview)' };
      case '@elementText': {
        const element = getPath(ctx.model, 'gtm.element') as { __element?: { text?: string } } | undefined;
        return { value: element?.__element?.text, known: !!element, source: 'clicked element' };
      }
      default:
        return { value: getPath(ctx.model, key), known: true, source: `data layer "${key}"` };
    }
  }

  private async userVariable(doc: EntityDoc, ctx: EventContext, depth: number): Promise<Resolved> {
    const params = paramMap(doc.data.parameter);
    const type = String(doc.data.type);
    const withDefault = async (resolved: Resolved): Promise<Resolved> => {
      if (resolved.value !== undefined || params.setDefaultValue !== 'true') return resolved;
      return this.interpolate(String(params.defaultValue ?? ''), ctx, depth);
    };
    switch (type) {
      case 'v': {
        const key = String(params.name ?? '');
        const value = params.dataLayerVersion === '1' ? ctx.model[key] : getPath(ctx.model, key);
        return withDefault({ value, known: true, source: `data layer "${key}"` });
      }
      case 'c':
        return this.interpolate(String(params.value ?? ''), ctx, depth);
      case 'e':
        return { value: ctx.event, known: true, source: 'event name' };
      case 'u':
        return this.urlVariable(params, ctx, depth);
      case 'aev':
        return this.autoEventVariable(params, ctx);
      case 'smm':
        return this.lookupTable(params, doc, ctx, depth, false);
      case 'remm':
        return this.lookupTable(params, doc, ctx, depth, true);
      case 'k':
        return this.inPage(`(function(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+'=([^;]*)'));return m?decodeURIComponent(m[1]):undefined})(${JSON.stringify(String(params.name ?? ''))})`, 'cookie, read now');
      case 'j':
        return this.inPage(`(function(p){try{return p.split('.').reduce(function(o,k){return o==null?undefined:o[k]},window)}catch(e){return undefined}})(${JSON.stringify(String(params.name ?? ''))})`, 'JavaScript variable, read now');
      case 'd': {
        const selector = String(params.elementSelector ?? params.elementId ?? '');
        const byId = params.selectorType !== 'CSS';
        const attr = params.attributeName ? JSON.stringify(String(params.attributeName)) : 'null';
        return this.inPage(`(function(s,id,a){var e=id?document.getElementById(s):document.querySelector(s);if(!e)return null;return a?e.getAttribute(a):(e.innerText||e.textContent||'').trim()})(${JSON.stringify(selector)},${byId},${attr})`, 'DOM element, read now');
      }
      case 'jsm':
        return this.customJs(String(params.javascript ?? ''), ctx, depth);
      default:
        return { value: undefined, known: false, source: `variable type "${type}" is not computed by the debugger` };
    }
  }

  private async urlVariable(params: Readonly<Record<string, unknown>>, ctx: EventContext, depth: number): Promise<Resolved> {
    const source = params.customUrlSource ? await this.interpolate(String(params.customUrlSource), ctx, depth) : { value: ctx.pageUrl, known: true, source: 'page URL' };
    const url = safeUrl(String(source.value ?? ''));
    if (!url) return { value: undefined, known: source.known, source: 'URL variable (not a URL)' };
    const component = String(params.component ?? 'URL');
    const value =
      component === 'PROTOCOL' ? url.protocol.replace(':', '')
      : component === 'HOST' ? (params.stripWww === 'true' ? url.hostname.replace(/^www\./, '') : url.hostname)
      : component === 'PORT' ? url.port || (url.protocol === 'https:' ? '443' : '80')
      : component === 'PATH' ? url.pathname
      : component === 'QUERY' ? (params.queryKey ? url.searchParams.get(String(params.queryKey)) ?? undefined : url.search.replace(/^\?/, ''))
      : component === 'FRAGMENT' ? url.hash.replace(/^#/, '')
      : url.href;
    return { value, known: source.known, source: `URL ${component.toLowerCase()}` };
  }

  private autoEventVariable(params: Readonly<Record<string, unknown>>, ctx: EventContext): Resolved {
    const varType = String(params.varType ?? 'ELEMENT');
    const keys: Record<string, string> = { ELEMENT: 'gtm.element', CLASSES: 'gtm.elementClasses', ID: 'gtm.elementId', TARGET: 'gtm.elementTarget', URL: 'gtm.elementUrl', HISTORY_NEW_URL_FRAGMENT: 'gtm.newUrlFragment' };
    if (varType === 'TEXT') return this.builtIn('CLICK_TEXT', ctx);
    const key = keys[varType];
    if (!key) return { value: undefined, known: false, source: `auto-event ${varType} is not computed by the debugger` };
    return { value: getPath(ctx.model, key), known: true, source: `data layer "${key}"` };
  }

  private async lookupTable(params: Readonly<Record<string, unknown>>, doc: EntityDoc, ctx: EventContext, depth: number, regex: boolean): Promise<Resolved> {
    const input = await this.interpolate(String(params.input ?? ''), ctx, depth);
    const text = stringify(input.value);
    const rows = rowsOf(doc.data.parameter);
    for (const row of rows) {
      const key = String(row.key ?? '');
      let hit = false;
      if (regex) {
        try {
          const pattern = params.fullMatch === 'false' ? key : `^(?:${key})$`;
          hit = new RegExp(pattern, params.ignoreCase === 'false' ? '' : 'i').test(text);
        } catch {
          hit = false;
        }
      } else {
        hit = key === text;
      }
      if (hit) {
        const out = await this.interpolate(String(row.value ?? ''), ctx, depth);
        return { value: out.value, known: input.known && out.known, source: `${regex ? 'regex' : 'lookup'} table row "${key}"` };
      }
    }
    if (params.setDefaultValue === 'true') {
      const fallback = await this.interpolate(String(params.defaultValue ?? ''), ctx, depth);
      return { value: fallback.value, known: input.known, source: 'table default' };
    }
    return { value: undefined, known: input.known, source: 'no table row matched' };
  }

  private async customJs(code: string, ctx: EventContext, depth: number): Promise<Resolved> {
    if (!this.page) return { value: undefined, known: false, source: 'custom JavaScript (needs the debug browser)' };
    let body = code;
    let known = true;
    for (const ref of [...code.matchAll(/\{\{([^{}]+)\}\}/g)]) {
      const resolved = await this.resolve((ref[1] ?? '').trim(), ctx, depth + 1);
      known &&= resolved.known;
      body = body.replace(ref[0], JSON.stringify(resolved.value) ?? 'undefined');
    }
    const result = await this.inPage(`(${body})()`, 'custom JavaScript, run now');
    return { ...result, known: result.known && known };
  }

  private async inPage(expression: string, source: string): Promise<Resolved> {
    if (!this.page) return { value: undefined, known: false, source: `${source} (needs the debug browser)` };
    try {
      return { value: await this.page(expression), known: true, source };
    } catch (error: unknown) {
      return { value: undefined, known: false, source: `${source}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

export function paramMap(parameter: unknown): Readonly<Record<string, unknown>> {
  if (!Array.isArray(parameter)) return {};
  return Object.fromEntries(
    (parameter as Record<string, unknown>[]).filter((item) => typeof item.key === 'string').map((item) => [item.key as string, item.value ?? item.list ?? item.map]),
  );
}

/** Rows of a lookup/regex table: the `map` list entries as {key, value}. */
function rowsOf(parameter: unknown): { key?: unknown; value?: unknown }[] {
  const map = (Array.isArray(parameter) ? (parameter as Record<string, unknown>[]) : []).find((item) => item.key === 'map');
  const list = Array.isArray(map?.list) ? (map.list as Record<string, unknown>[]) : [];
  return list.map((row) => paramMap(row.map) as { key?: unknown; value?: unknown });
}

/** How GTM turns a value into the string a condition compares. */
export function stringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value && '__element' in value) return '[object HTMLElement]';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function safeUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}
