import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Hit } from '../debugger/hits';
import { replayTarget } from '../debugger/sgtmPreview';

// Pure checks used by the extension, kept free of the vscode module so they can be unit tested.

/** Messages the debugger webview may send. Anything else is ignored. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'start'; url: string; mode: 'workspace' | 'live' }
  | { type: 'stop' | 'reload' | 'openLast' }
  | { type: 'navigate'; url: string }
  | { type: 'select'; seq: number; live?: boolean }
  | { type: 'openFile'; file: string }
  | { type: 'push'; json: string };

const isString = (value: unknown): value is string => typeof value === 'string';

/** Validate a raw webview message; undefined when the type is unknown or a field has the wrong type. */
export function parseWebviewMessage(raw: unknown): FromWebview | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
    case 'stop':
    case 'reload':
    case 'openLast':
      return { type: message.type };
    case 'start':
      if (!isString(message.url) || (message.mode !== 'workspace' && message.mode !== 'live')) return undefined;
      return { type: 'start', url: message.url, mode: message.mode };
    case 'navigate':
      return isString(message.url) ? { type: 'navigate', url: message.url } : undefined;
    case 'select':
      if (!Number.isInteger(message.seq) || (message.live !== undefined && typeof message.live !== 'boolean')) return undefined;
      return { type: 'select', seq: message.seq as number, live: message.live as boolean | undefined };
    case 'openFile':
      return isString(message.file) ? { type: 'openFile', file: message.file } : undefined;
    case 'push':
      return isString(message.json) ? { type: 'push', json: message.json } : undefined;
    default:
      return undefined;
  }
}

/**
 * Resolve `relative` inside `root`, following symlinks on both, and return the real path only if it
 * stays inside root. Undefined when it escapes or does not exist.
 */
export async function containedFile(root: string, relative: string): Promise<string | undefined> {
  try {
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(path.resolve(realRoot, relative));
    return real.startsWith(realRoot + path.sep) ? real : undefined;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Message shown when an action needs a trusted workspace; undefined when the workspace is trusted. */
export function untrustedMessage(trusted: boolean, action: string): string | undefined {
  return trusted ? undefined : `GS Code does not ${action} in Restricted Mode. Trust this workspace first (Manage Workspace Trust).`;
}

/** What a debug_replay_sgtm call would hit, for its confirmation dialog. */
export interface ReplayPlan {
  /** Distinct hosts (with port when one is set) of the hits that pass the sgtmHosts allow-list. */
  readonly hosts: readonly string[];
  /** Hits replay would send. */
  readonly count: number;
  /** Why matching hits would be refused (the replay stops at the first one). */
  readonly refused: readonly string[];
}

/** Mirror the replay tool's selection (first-party, not gtm.js, optional event name) and check each hit's target. */
export function planReplay(hits: readonly Hit[], name: string | undefined, sgtmHosts: readonly string[]): ReplayPlan {
  const hosts = new Set<string>();
  const refused = new Set<string>();
  let count = 0;
  for (const hit of hits) {
    if (!hit.firstParty || hit.vendor === 'gtm' || (name && hit.name !== name)) continue;
    try {
      hosts.add(replayTarget(hit, sgtmHosts).host);
      count += 1;
    } catch (error: unknown) {
      refused.add(error instanceof Error ? error.message : String(error));
    }
  }
  return { hosts: [...hosts].sort(), count, refused: [...refused] };
}

/** Confirmation text naming the exact hosts, and where the allow-list came from. */
export function replayConfirmation(plan: ReplayPlan, name: string | undefined, sgtmHosts: readonly string[], hostsSource: string): string {
  const which = name ? `"${name}" requests` : 'every captured server-container request';
  const lines = [
    plan.hosts.length
      ? `Send ${plan.count} ${which} again to ${plan.hosts.join(', ')}.`
      : `No captured ${name ? `"${name}" ` : ''}request passes the sgtmHosts allow-list, so nothing will be sent.`,
    `Allow-list gsCode.debug.sgtmHosts (from ${hostsSource}): ${sgtmHosts.join(', ') || '(empty)'}.`,
    ...plan.refused.slice(0, 3).map((reason) => `Refused: ${reason}`),
    'The server container\'s tags run for real and vendors receive the requests, so conversions can be recorded twice.',
  ];
  return lines.join('\n\n');
}
