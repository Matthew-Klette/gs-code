import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GtmApi } from '../core/api';
import { describeChanges, describeConflicts, describeIssues, describeRefresh } from '../core/format';
import { changeSignature, countChanges, isEmpty } from '../core/mirror/diff';
import { STATE_DIR } from '../core/mirror/layout';
import { readState } from '../core/mirror/state';
import { workingStatus } from '../core/ops/plan';
import { pushWorkspace } from '../core/ops/push';
import { refreshMirror } from '../core/ops/sync';
import { GtmError } from '../core/types';
import type { BrowserOptions } from './browser';
import { Explainer } from './explain';
import type { Hit } from './hits';
import { eventContext, loadMirrorDocs, predictClient, resolveWorkspacePreview } from './mirrorContext';
import { DebugSession } from './session';
import { Timeline, type TimelineEvent } from './timeline';
import { VariableResolver } from './variables';

export const DEBUG_DIR = `${STATE_DIR}/debug`;

/** JSON Schema for a tool's input (the subset MCP and VS Code language-model tools both accept). */
export interface ToolSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string; readonly enum?: readonly string[] }>>;
  readonly required?: readonly string[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolSchema;
  readonly run: (input: Readonly<Record<string, unknown>>) => Promise<string>;
}

export interface ToolkitOptions {
  readonly api: GtmApi;
  /** The mirror folder the tools work on (an agent may pass another with `dir`). */
  readonly defaultRoot: () => string | undefined;
  readonly browser: (root: string) => BrowserOptions;
  readonly settings?: () => { readonly sgtmHosts?: readonly string[]; readonly loaderPatterns?: readonly string[]; readonly dataLayerName?: string };
  /** A session started elsewhere in this process (the VS Code panel), shared with the tools. */
  readonly sharedSession?: () => DebugSession | undefined;
  readonly onSession?: (session: DebugSession) => void;
}

/**
 * Everything an AI agent can do with GS Code, as tools. Agents can read, pull, push to a workspace and
 * drive the debugger. They can never create versions or publish: that stays a human decision.
 */
export class Toolkit {
  private session?: DebugSession;
  private sessionRoot?: string;

  constructor(private readonly options: ToolkitOptions) {}

  get activeSession(): DebugSession | undefined {
    return this.options.sharedSession?.() ?? this.session;
  }

  definitions(): ToolDefinition[] {
    const dir = { dir: { type: 'string', description: 'Mirror folder (default: the open one)' } } as const;
    return [
      {
        name: 'gtm_status',
        description: 'Local changes in the GTM mirror that Push would send, plus conflicts and validation problems. No API calls.',
        inputSchema: { type: 'object', properties: { ...dir } },
        run: async (input) => this.status(this.root(input)),
      },
      {
        name: 'gtm_pull',
        description: 'Pull the latest workspace contents from GTM into the mirror (three-way merge; local edits are kept).',
        inputSchema: { type: 'object', properties: { ...dir } },
        run: async (input) => {
          const root = this.root(input);
          const result = await refreshMirror(root, this.options.api, await readState(root), { force: true });
          return [describeRefresh(result), ...describeConflicts(result.state)].join('\n');
        },
      },
      {
        name: 'gtm_push',
        description:
          'Push the mirror\'s local changes to the GTM workspace (never live: publishing is not available to agents). Pass the `expected` signature from gtm_status so only reviewed changes are sent.',
        inputSchema: { type: 'object', properties: { ...dir, expected: { type: 'string', description: 'Signature from gtm_status' } }, required: ['expected'] },
        run: async (input) => {
          const root = this.root(input);
          const result = await pushWorkspace(root, this.options.api, await readState(root), { expected: String(input.expected ?? '') });
          return `Pushed ${result.pushed} change(s) to the workspace.`;
        },
      },
      {
        name: 'debug_start',
        description:
          'Open a page in the debug browser and record dataLayer events, tag status, consent and network hits. mode "workspace" loads the mirror\'s unpublished workspace (preview), "live" the published container.',
        inputSchema: {
          type: 'object',
          properties: { ...dir, url: { type: 'string', description: 'Page to open' }, mode: { type: 'string', enum: ['workspace', 'live'], description: 'Default: workspace' } },
          required: ['url'],
        },
        run: async (input) => this.start(this.root(input), String(input.url), input.mode === 'live' ? 'live' : 'workspace'),
      },
      {
        name: 'debug_events',
        description: 'The recorded events (newest page by default): sequence number, event name, tags fired, hits sent.',
        inputSchema: { type: 'object', properties: { ...dir, page: { type: 'number', description: 'Page number (default: the latest)' } } },
        run: async (input) => this.events(await this.timeline(input), typeof input.page === 'number' ? input.page : undefined),
      },
      {
        name: 'debug_event',
        description: 'One event in detail: what was pushed, the data model after it, consent, tag statuses and network hits.',
        inputSchema: { type: 'object', properties: { ...dir, seq: { type: 'number', description: 'Event sequence number from debug_events' } }, required: ['seq'] },
        run: async (input) => this.event(await this.timeline(input), Number(input.seq)),
      },
      {
        name: 'debug_explain',
        description:
          'Why a tag fired or did not fire on an event: each firing/blocking trigger and condition with the values compared, and the mirror file to edit. Without a tag, explains every tag for the event.',
        inputSchema: { type: 'object', properties: { ...dir, seq: { type: 'number', description: 'Event sequence number' }, tag: { type: 'string', description: 'Tag name (optional)' } }, required: ['seq'] },
        run: async (input) => this.explain(this.root(input), await this.timeline(input), Number(input.seq), typeof input.tag === 'string' ? input.tag : undefined),
      },
      {
        name: 'debug_hits',
        description: 'Network hits (GA4, Google Ads, Meta, server container…), optionally filtered by vendor or event name. Server-container hits include the client predicted to claim them.',
        inputSchema: { type: 'object', properties: { ...dir, vendor: { type: 'string', description: 'ga4, google-ads, meta, sgtm…' }, name: { type: 'string', description: 'Event name, e.g. purchase' } } },
        run: async (input) => this.hits(this.root(input), await this.timeline(input), input),
      },
      {
        name: 'debug_navigate',
        description: 'Navigate the debug tab to a URL (keeps recording).',
        inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL' } }, required: ['url'] },
        run: async (input) => {
          await this.live().navigate(String(input.url));
          return `Navigating to ${String(input.url)}.`;
        },
      },
      {
        name: 'debug_reload',
        description: 'Reload the debug tab, e.g. after pushing a fix (workspace mode picks up the new draft).',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          await this.live().reload();
          return 'Reloading.';
        },
      },
      {
        name: 'debug_push',
        description: 'Push an object to the page\'s dataLayer, to reproduce an event (e.g. {"event":"purchase","ecommerce":{…}}).',
        inputSchema: { type: 'object', properties: { data: { type: 'string', description: 'JSON object to push' } }, required: ['data'] },
        run: async (input) => {
          const data = JSON.parse(String(input.data)) as Record<string, unknown>;
          await this.live().push(data);
          return 'Pushed to dataLayer.';
        },
      },
      {
        name: 'debug_stop',
        description: 'Stop the debug session (closes the tab, or the browser GS Code launched).',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          await this.activeSession?.stop();
          return 'Stopped.';
        },
      },
    ];
  }

  async run(name: string, input: Readonly<Record<string, unknown>>): Promise<string> {
    const tool = this.definitions().find((item) => item.name === name);
    if (!tool) throw new GtmError(`Unknown tool ${name}`);
    return tool.run(input);
  }

  private root(input: Readonly<Record<string, unknown>>): string {
    const root = typeof input.dir === 'string' && input.dir ? path.resolve(input.dir) : this.options.defaultRoot();
    if (!root) throw new GtmError('No GTM mirror is open. Pass "dir", or open a mirror folder.');
    return root;
  }

  private live(): DebugSession {
    const session = this.activeSession;
    if (!session?.running) throw new GtmError('No debug session is running. Start one with debug_start.');
    return session;
  }

  private async status(root: string): Promise<string> {
    const state = await readState(root);
    const status = await workingStatus(root, state);
    const lines = [`${state.container.publicId} / workspace "${state.workspace.name}"${state.remote?.behind ? ` (version ${state.remote.behind} was published since; pull)` : ''}`];
    lines.push(...status.problems.map((problem) => `error ${problem.path}: ${problem.message}`), ...describeConflicts(state), ...describeIssues(status.issues));
    if (isEmpty(status.changes)) lines.push('No local changes.');
    else lines.push(`${countChanges(status.changes)} change(s) to push:`, ...describeChanges(status.changes).map((line) => `  ${line}`), `expected: ${changeSignature(status.changes)}`);
    return lines.join('\n');
  }

  private async start(root: string, url: string, mode: 'workspace' | 'live'): Promise<string> {
    await this.activeSession?.stop();
    const state = await readState(root);
    const docs = await loadMirrorDocs(root, state);
    const preview = mode === 'workspace' ? await resolveWorkspacePreview(this.options.api, state) : undefined;
    const settings = this.options.settings?.() ?? {};
    const session = new DebugSession({
      url,
      browser: this.options.browser(root),
      preview,
      logDir: path.join(root, DEBUG_DIR),
      tagNames: docs.tagNames,
      container: state.container.publicId,
      workspace: state.workspace.name,
      sgtmHosts: settings.sgtmHosts,
      loaderPatterns: settings.loaderPatterns,
      dataLayerName: settings.dataLayerName,
    });
    await session.start();
    this.session = session;
    this.sessionRoot = root;
    this.options.onSession?.(session);
    return `Recording ${url} (${mode === 'workspace' ? `draft of workspace "${state.workspace.name}"` : 'live container'}). Session file: ${session.file ?? 'none'}`;
  }

  /** The live session's timeline, or the latest session file of the mirror (e.g. one the user ran in VS Code). */
  private async timeline(input: Readonly<Record<string, unknown>>): Promise<Timeline> {
    const live = this.activeSession;
    if (live) return live.timeline;
    const root = this.root(input);
    const debugDir = path.join(root, DEBUG_DIR);
    const latest = (await fs.readFile(path.join(debugDir, 'latest'), 'utf8').catch(() => '')).trim();
    if (!latest) throw new GtmError('No debug session recorded yet. Start one with debug_start.');
    const docs = await loadMirrorDocs(root, await readState(root));
    return Timeline.fromFile(path.join(debugDir, latest), docs.tagNames);
  }

  private events(timeline: Timeline, page?: number): string {
    const visit = page === undefined ? timeline.pages.at(-1) : timeline.pages.find((item) => item.page === page);
    if (!visit) return 'Nothing recorded yet.';
    const lines = [`Page ${visit.page}: ${visit.url}${visit.containers.length ? ` (containers: ${visit.containers.join(', ')})` : ''}`];
    for (const event of timeline.eventsOn(visit.page)) {
      const tags = event.tags.length ? ` · tags: ${event.tags.map((tag) => `${tag.name ?? tag.id} ${tag.status}`).join(', ')}` : '';
      const hits = event.hits.length ? ` · hits: ${event.hits.map(hitLabel).join(', ')}` : '';
      lines.push(`#${event.seq} ${event.event ?? '(message)'}${tags}${hits}`);
    }
    const notes = timeline.notes.slice(-5).map((note) => `${note.level}: ${note.message}`);
    return [...lines, ...notes].join('\n');
  }

  private event(timeline: Timeline, seq: number): string {
    const event = timeline.event(seq);
    if (!event) return `No event #${seq}.`;
    return JSON.stringify(
      {
        seq: event.seq,
        event: event.event,
        url: event.url,
        pushed: event.data ?? event.command,
        consent: event.consent,
        tags: event.tags,
        hits: event.hits.map((hit) => ({ vendor: hit.vendor, name: hit.name, id: hit.id, status: hit.status, firstParty: hit.firstParty, url: hit.url, params: hit.events })),
        dataModel: event.model,
      },
      null,
      2,
    );
  }

  private async explain(root: string, timeline: Timeline, seq: number, tag?: string): Promise<string> {
    const event = timeline.event(seq);
    if (!event) return `No event #${seq}.`;
    const state = await readState(root);
    const docs = await loadMirrorDocs(root, state);
    const live = this.activeSession?.running && this.sessionRoot === root ? this.activeSession : undefined;
    const explainer = new Explainer(docs, new VariableResolver(docs.variables, docs.builtInNames, live ? (expression) => live.evaluate(expression) : undefined));
    const ctx = eventContext(timeline, event, state.container.publicId);
    const names = tag ? [tag] : explainer.tagNames();
    const out: string[] = [`Event #${event.seq} ${event.event ?? ''} (${event.url})`];
    for (const name of names) {
      const result = await explainer.explainTag(name, ctx);
      if (!result) {
        out.push(`${name}: no such tag in the mirror.`);
        continue;
      }
      const observed = event.tags.find((item) => item.name === name);
      out.push(`${result.verdict === 'fires' ? '✔' : result.verdict === 'unknown' ? '?' : '✘'} ${name} [${result.file}]: ${result.summary}${observed ? ` (GTM reported: ${observed.status})` : ''}`);
      if (!tag) continue;
      for (const check of [...result.firing, ...result.blocking]) {
        out.push(`  trigger "${check.trigger}"${check.file ? ` [${check.file}]` : ''}: ${check.matched === true ? 'matches' : check.matched === false ? 'no match' : 'unknown'} (${check.reason})`);
        for (const condition of check.conditions) {
          out.push(`    ${condition.result === true ? '✔' : condition.result === false ? '✘' : '?'} ${condition.text} ← ${JSON.stringify(condition.left.value)} (${condition.left.source})`);
        }
      }
      result.notes.forEach((note) => out.push(`  note: ${note}`));
    }
    return out.join('\n');
  }

  private async hits(root: string, timeline: Timeline, input: Readonly<Record<string, unknown>>): Promise<string> {
    const vendor = typeof input.vendor === 'string' ? input.vendor : undefined;
    const name = typeof input.name === 'string' ? input.name : undefined;
    const list = timeline.allHits().filter((hit) => (!vendor || hit.vendor === vendor) && (!name || hit.name === name || hit.events.some((item) => Object.values(item).includes(name))));
    if (list.length === 0) return 'No matching hits.';
    const clients = list.some((hit) => hit.firstParty) ? (await loadMirrorDocs(root, await readState(root))).clients : [];
    return list
      .map((hit) => {
        const claimed = hit.firstParty && clients.length ? predictClient(hit, clients) : undefined;
        const client = claimed ? ` · client: ${claimed.client ?? '?'} (${claimed.confidence}: ${claimed.reason})` : '';
        return `${new Date(hit.t).toISOString().slice(11, 23)} ${hitLabel(hit)} ${hit.status ?? '…'} ${hit.url.slice(0, 160)}${client}`;
      })
      .join('\n');
  }
}

function hitLabel(hit: Hit): string {
  return `${hit.vendor}${hit.firstParty ? '(1p)' : ''}${hit.name ? ` ${hit.name}` : ''}${hit.id ? ` ${hit.id}` : ''}`;
}

export type { TimelineEvent };
