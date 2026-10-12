import { promises as fs } from 'node:fs';
import { mergePush, type DataModel } from './dataModel';
import { decodeGcs, type Hit } from './hits';

/**
 * Everything a debug session records, as an append-only list of records. The same reducer rebuilds the
 * timeline live (in the session) or from the session file (`.gtm/debug/*.jsonl`), so the VS Code panel,
 * the CLI and an AI agent connected through `gscode mcp` all see the same thing.
 */
export type SessionRecord =
  | { readonly kind: 'session'; readonly t: number; readonly url: string; readonly mode: 'workspace' | 'live'; readonly container?: string; readonly workspace?: string }
  | { readonly kind: 'page'; readonly t: number; readonly page: number; readonly url: string }
  | { readonly kind: 'probe'; readonly page: number; readonly message: ProbeMessage }
  | { readonly kind: 'hit'; readonly page: number; readonly requestId: string; readonly hit: Hit }
  | { readonly kind: 'response'; readonly requestId: string; readonly status: number; readonly setCookies?: readonly string[]; readonly body?: string }
  | { readonly kind: 'note'; readonly t: number; readonly level: 'info' | 'warning' | 'error'; readonly message: string };

/** What the in-page probe sends (see probe.ts). */
export interface ProbeMessage {
  readonly type: 'push' | 'tags' | 'consent' | 'containers' | 'page' | 'warning';
  readonly t: number;
  readonly url: string;
  readonly [field: string]: unknown;
}

export interface TagStatus {
  readonly id: string;
  /** From the mirror (tag id → name), or GTM's "Include tag name" metadata. */
  readonly name?: string;
  readonly status: string;
  readonly executionTime?: number;
  readonly containerId: string;
}

export interface TimelineEvent {
  readonly seq: number;
  readonly page: number;
  readonly t: number;
  readonly started: number;
  readonly url: string;
  /** `event` key of the push, or the command for `gtag()`-style pushes. */
  readonly event?: string;
  readonly command?: unknown;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly uniqueEventId?: number;
  /** Data model right after this push. */
  readonly model: DataModel;
  readonly consent: Readonly<Record<string, boolean | undefined>>;
  tags: TagStatus[];
  hits: Hit[];
}

export interface PageVisit {
  readonly page: number;
  readonly url: string;
  readonly t: number;
  title?: string;
  containers: string[];
}

export class Timeline {
  readonly events: TimelineEvent[] = [];
  readonly pages: PageVisit[] = [];
  readonly notes: { t: number; level: string; message: string }[] = [];
  /** Hits that happened before any event on their page (or while no page was known). */
  readonly orphanHits: Hit[] = [];
  session?: Extract<SessionRecord, { kind: 'session' }>;
  private model: DataModel = {};
  private consent: Record<string, boolean | undefined> = {};
  private readonly hitsById = new Map<string, Hit>();

  constructor(private readonly tagNames: ReadonlyMap<string, string> = new Map()) {}

  static async fromFile(file: string, tagNames?: ReadonlyMap<string, string>): Promise<Timeline> {
    const timeline = new Timeline(tagNames);
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    let unreadable = 0;
    lines.forEach((line, index) => {
      try {
        timeline.apply(JSON.parse(line) as SessionRecord);
      } catch {
        // A half-written last line is expected while the session is still running; anything else is damage.
        if (index < lines.length - 1) unreadable++;
      }
    });
    if (unreadable) timeline.notes.push({ t: Date.now(), level: 'warning', message: `Skipped ${unreadable} unreadable line${unreadable === 1 ? '' : 's'} in ${file}.` });
    return timeline;
  }

  apply(record: SessionRecord): void {
    switch (record.kind) {
      case 'session':
        this.session = record;
        return;
      case 'page':
        this.pages.push({ page: record.page, url: record.url, t: record.t, containers: [] });
        this.model = {};
        return;
      case 'note':
        this.notes.push({ t: record.t, level: record.level, message: record.message });
        return;
      case 'hit':
        this.addHit(record.page, record.requestId, record.hit);
        return;
      case 'response': {
        const hit = this.hitsById.get(record.requestId);
        if (!hit) return;
        hit.status = record.status;
        if (record.setCookies) hit.setCookies = record.setCookies;
        if (record.body !== undefined) hit.responseBody = record.body;
        return;
      }
      case 'probe':
        this.applyProbe(record.page, record.message);
    }
  }

  hitFor(requestId: string): Hit | undefined {
    return this.hitsById.get(requestId);
  }

  event(seq: number): TimelineEvent | undefined {
    return this.events.find((event) => event.seq === seq);
  }

  /** Events on the current (last) page, or a given page. */
  eventsOn(page = this.pages.at(-1)?.page): TimelineEvent[] {
    return this.events.filter((event) => event.page === page);
  }

  allHits(): Hit[] {
    return [...this.orphanHits, ...this.events.flatMap((event) => event.hits)].sort((a, b) => a.t - b.t);
  }

  private applyProbe(page: number, message: ProbeMessage): void {
    switch (message.type) {
      case 'push': {
        const data = message.data as Record<string, unknown> | undefined;
        if (data) this.model = mergePush(this.model, data);
        this.applyConsentCommand(message.command);
        this.events.push({
          seq: Number(message.seq),
          page,
          t: message.t,
          started: Number(message.started ?? message.t),
          url: message.url,
          event: typeof message.event === 'string' ? message.event : commandName(message.command),
          command: message.command,
          data,
          uniqueEventId: typeof message.uniqueEventId === 'number' ? message.uniqueEventId : undefined,
          model: this.model,
          consent: { ...this.consent },
          tags: [],
          hits: [],
        });
        return;
      }
      case 'tags': {
        const event = this.events.find((item) => item.seq === Number(message.seq) && item.page === page);
        const data = message.eventData as { tags?: { id?: unknown; status?: unknown; executionTime?: unknown; name?: unknown }[] } | undefined;
        if (!event || !Array.isArray(data?.tags)) return;
        for (const tag of data.tags) {
          const id = String(tag.id ?? '');
          event.tags.push({
            id,
            name: this.tagNames.get(id) ?? (typeof tag.name === 'string' ? tag.name : undefined),
            status: String(tag.status ?? 'unknown'),
            executionTime: typeof tag.executionTime === 'number' ? tag.executionTime : undefined,
            containerId: String(message.containerId ?? ''),
          });
        }
        return;
      }
      case 'consent': {
        const state = (message.state ?? {}) as Record<string, { default?: boolean; update?: boolean }>;
        this.consent = Object.fromEntries(Object.entries(state).map(([type, entry]) => [type, entry.update ?? entry.default]));
        const last = this.events.at(-1);
        if (last && last.page === page) (last as { consent: Record<string, boolean | undefined> }).consent = { ...this.consent };
        return;
      }
      case 'containers': {
        const visit = this.pages.find((item) => item.page === page);
        if (visit) visit.containers = (message.ids as string[]) ?? [];
        return;
      }
      case 'page': {
        const visit = this.pages.find((item) => item.page === page);
        if (visit) visit.title = String(message.title ?? '');
        return;
      }
      case 'warning':
        this.notes.push({ t: message.t, level: 'warning', message: String(message.message ?? '') });
    }
  }

  /** `gtag('consent', 'default'|'update', {...})` pushes, so consent is known even before GTM reports it. */
  private applyConsentCommand(command: unknown): void {
    if (!Array.isArray(command) || command[0] !== 'consent' || !command[2] || typeof command[2] !== 'object') return;
    for (const [type, value] of Object.entries(command[2] as Record<string, unknown>)) {
      if (value === 'granted' || value === 'denied') this.consent[type] = value === 'granted';
    }
  }

  /** A hit belongs to the latest event on its page that started before it. */
  private addHit(page: number, requestId: string, hit: Hit): void {
    this.hitsById.set(requestId, hit);
    const candidates = this.events.filter((event) => event.page === page && event.started <= hit.t);
    const owner = candidates.at(-1);
    if (owner) owner.hits.push(hit);
    else this.orphanHits.push(hit);
    if (hit.vendor === 'ga4' && owner) {
      const gcs = decodeGcs(hit.events[0]?.gcs);
      if (gcs.analyticsStorage !== undefined && owner.consent.analytics_storage === undefined) {
        (owner as { consent: Record<string, boolean | undefined> }).consent = { ...owner.consent, analytics_storage: gcs.analyticsStorage, ad_storage: gcs.adStorage };
      }
    }
  }
}

function commandName(command: unknown): string | undefined {
  if (!Array.isArray(command) || typeof command[0] !== 'string') return undefined;
  return `${command[0]}${typeof command[1] === 'string' ? ` ${command[1]}` : ''}`;
}
