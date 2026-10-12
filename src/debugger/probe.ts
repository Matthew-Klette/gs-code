/**
 * The script GS Code injects into every page before any of the page's own scripts run
 * (`Page.addScriptToEvaluateOnNewDocument`). It only observes:
 *
 * - every dataLayer push (GTM's auto-events included), recorded after GTM processed it so the
 *   `gtm.uniqueEventId` is known, with the time it started so network hits can be attributed;
 * - tag status per event through `eventCallback(containerId, eventData)` (eventData.tags lists
 *   each tag's id, status and execution time), chaining any callback the site set itself;
 * - Consent Mode state (`google_tag_data.ics`, read only) and which containers are loaded.
 *
 * Results go back through a CDP binding (`Runtime.addBinding`), never over the network.
 * Kept as a plain ES2017 function so it can be unit-tested in a VM and stringified as is.
 */
export interface ProbeOptions {
  readonly binding: string;
  readonly dataLayerName: string;
  readonly tagStatus: boolean;
}

export function probeSource(options: ProbeOptions): string {
  return `(${probe.toString()})(${JSON.stringify(options)});`;
}

/* eslint-disable */
// prettier-ignore
export function probe(options: ProbeOptions): void {
  const w = globalThis as any;
  if (w.__gsCodeProbe) return;
  Object.defineProperty(w, '__gsCodeProbe', { value: true });
  const MAX_DEPTH = 6;
  const MAX_ITEMS = 200;
  const MAX_TEXT = 2000;
  let seq = 0;

  function emit(type: string, payload: Record<string, unknown>): void {
    const send = w[options.binding];
    if (typeof send !== 'function') return;
    try {
      send(JSON.stringify(Object.assign({ type: type, t: Date.now(), url: String(w.location && w.location.href) }, payload)));
    } catch (e) {
      // never break the page
    }
  }

  function describeElement(el: any): Record<string, unknown> {
    const text = String(el.innerText || el.textContent || '').trim().slice(0, 120);
    return { __element: { tag: String(el.tagName || '').toLowerCase(), id: el.id || undefined, classes: el.className && typeof el.className === 'string' ? el.className : undefined, href: el.href || undefined, text: text || undefined } };
  }

  function safe(value: any, depth: number, seen: any[]): unknown {
    if (value === null || value === undefined) return value === undefined ? { __undefined: true } : null;
    const kind = typeof value;
    if (kind === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '…' : value;
    if (kind === 'number' || kind === 'boolean') return value;
    if (kind === 'function') return { __function: String(value.name || 'anonymous') };
    if (kind === 'bigint' || kind === 'symbol') return String(value);
    if (w.Element && value instanceof w.Element) return describeElement(value);
    if (value === w || value === w.document) return { __object: value === w ? 'window' : 'document' };
    if (depth >= MAX_DEPTH) return { __truncated: true };
    if (seen.indexOf(value) >= 0) return { __circular: true };
    const next = seen.concat([value]);
    if (Array.isArray(value) || Object.prototype.toString.call(value) === '[object Arguments]') {
      const out: unknown[] = [];
      for (let i = 0; i < Math.min(value.length, MAX_ITEMS); i++) out.push(safe(value[i], depth + 1, next));
      return out;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (count++ >= MAX_ITEMS) break;
      try {
        out[key] = safe(value[key], depth + 1, next);
      } catch (e) {
        out[key] = { __unreadable: true };
      }
    }
    return out;
  }

  let lastConsent = '';
  function consentState(): void {
    const ics = w.google_tag_data && w.google_tag_data.ics && w.google_tag_data.ics.entries;
    if (!ics) return;
    const state: Record<string, unknown> = {};
    for (const type in ics) {
      const entry = ics[type] || {};
      state[type] = { default: entry.default, update: entry.update };
    }
    const text = JSON.stringify(state);
    if (text === lastConsent) return;
    lastConsent = text;
    emit('consent', { state: state });
  }

  let lastContainers = '';
  function containers(): void {
    const ids = Object.keys(w.google_tag_manager || {}).filter((key) => /^(GTM|G|AW|DC|GT)-/.test(key)).sort();
    const text = ids.join(',');
    if (text === lastContainers) return;
    lastContainers = text;
    emit('containers', { ids: ids });
  }

  function isPlainObject(item: any): boolean {
    return !!item && typeof item === 'object' && !Array.isArray(item) && Object.prototype.toString.call(item) !== '[object Arguments]';
  }

  function prepare(item: any, id: number): void {
    if (!options.tagStatus || !isPlainObject(item) || typeof item.event !== 'string') return;
    const original = item.eventCallback;
    if (original && original.__gsCode) return;
    const callback = function (this: unknown, containerId: unknown, eventData: unknown) {
      emit('tags', { seq: id, containerId: String(containerId), eventData: safe(eventData, 0, []) });
      if (typeof original === 'function') return original.apply(this, arguments as any);
    };
    (callback as any).__gsCode = true;
    try {
      item.eventCallback = callback;
    } catch (e) {
      // frozen object: no tag status for this event
    }
  }

  function record(item: any, started: number, id: number, source: string): void {
    const isCommand = !isPlainObject(item);
    emit('push', {
      seq: id,
      started: started,
      source: source,
      command: isCommand ? safe(item, 0, []) : undefined,
      data: isCommand ? undefined : safe(item, 0, []),
      event: isPlainObject(item) && typeof item.event === 'string' ? item.event : undefined,
      uniqueEventId: isPlainObject(item) && typeof item['gtm.uniqueEventId'] === 'number' ? item['gtm.uniqueEventId'] : undefined,
    });
    containers();
    consentState();
  }

  function instrument(list: any): any {
    if (!Array.isArray(list) || (list as any).__gsCodeHooked) return list;
    Object.defineProperty(list, '__gsCodeHooked', { value: true });
    for (let i = 0; i < list.length; i++) record(list[i], Date.now(), ++seq, 'initial');
    // Every push function assigned so far, oldest first (native push, then each GTM container's).
    // GTM saves the push it found (our wrapper) and calls it from its own, so a nested call must go
    // to the function assigned before the caller, not back to the newest one.
    const chain: any[] = [list.push];
    let depth = 0;
    const wrapped = function (this: unknown) {
      const items = Array.prototype.slice.call(arguments);
      const target = chain[Math.max(0, chain.length - 1 - depth)];
      if (depth > 0) {
        depth++;
        try {
          return target.apply(list, items);
        } finally {
          depth--;
        }
      }
      const started = Date.now();
      const ids = items.map(() => ++seq);
      items.forEach((item: any, index: number) => prepare(item, ids[index] as number));
      depth++;
      let result: unknown;
      try {
        result = target.apply(list, items);
      } finally {
        depth--;
      }
      items.forEach((item: any, index: number) => record(item, started, ids[index] as number, 'push'));
      return result;
    };
    // GTM replaces dataLayer.push when it loads; keep wrapping whatever is assigned.
    Object.defineProperty(list, 'push', {
      configurable: true,
      enumerable: false,
      get: () => wrapped,
      set: (fn: unknown) => {
        if (typeof fn === 'function' && fn !== wrapped) chain.push(fn);
      },
    });
    return list;
  }

  let current = instrument(w[options.dataLayerName]);
  try {
    Object.defineProperty(w, options.dataLayerName, {
      configurable: true,
      get: () => current,
      set: (value: unknown) => {
        current = instrument(value);
      },
    });
  } catch (e) {
    emit('warning', { message: 'Could not watch window.' + options.dataLayerName + '; only pushes to the existing array are seen.' });
  }

  w.addEventListener('load', () => {
    containers();
    consentState();
    emit('page', { title: String(w.document && w.document.title) });
  });
}
