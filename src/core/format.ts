import type { ChangeSet } from './mirror/diff';
import type { Issue } from './mirror/validate';
import type { MirrorState } from './mirror/state';
import type { PullResult } from './ops/pull';
import type { RefreshResult } from './ops/sync';

const SYMBOL = { added: '+', updated: '~', deleted: '-' } as const;

export function describeChanges(changes: ChangeSet): string[] {
  return [
    ...changes.folders.map((change) => `${SYMBOL[change.type]} folder "${change.name}"`),
    ...changes.entities.map((change) => {
      const renamed = change.previousBase ? `  (was ${change.previousBase})` : '';
      return `${SYMBOL[change.type]} ${change.base}${renamed}`;
    }),
    ...changes.builtIns.enable.map((type) => `+ built-in ${type}`),
    ...changes.builtIns.disable.map((type) => `- built-in ${type}`),
  ];
}

export function describeIssues(issues: readonly Issue[]): string[] {
  return issues.map((issue) => `${issue.severity === 'error' ? 'error' : 'warn '} ${issue.path}: ${issue.message}`);
}

export function describePull(result: PullResult): string {
  const parts = [
    result.added.length && `${result.added.length} added`,
    result.updated.length && `${result.updated.length} updated`,
    result.removed.length && `${result.removed.length} removed`,
    result.conflicts.length && `${result.conflicts.length} conflict(s)`,
    result.orphaned.length && `${result.orphaned.length} kept locally (deleted in GTM)`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'already up to date';
}

/** One line for a refresh that pulled, e.g. "synced to version 95; 2 updated". */
export function describeRefresh(result: RefreshResult): string {
  const parts = [
    result.movedTo && `workspace replaced, now on "${result.movedTo.name}" (${result.movedTo.workspaceId})`,
    result.syncedTo && `workspace synced to container version ${result.syncedTo}`,
    result.pull && describePull(result.pull),
    result.state.gtmConflicts.length && `${result.state.gtmConflicts.length} GTM merge conflict(s)`,
  ].filter(Boolean);
  return parts.join('; ') || 'no changes';
}

/** Everything that blocks a push or version, as lines. */
export function describeConflicts(state: MirrorState): string[] {
  return [
    ...state.conflicts.map((base) => `conflict ${base}: changed locally and in GTM (resolve with --mine / --theirs)`),
    ...state.gtmConflicts.map(
      (item) => `GTM merge conflict ${item.base}: workspace ${item.workspaceChange ?? 'changed'}, latest version ${item.latestChange ?? 'changed'} (resolve-gtm --keep-workspace / --latest)`,
    ),
  ];
}
