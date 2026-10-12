import type { ChangeSet } from './mirror/diff';
import type { Issue } from './mirror/validate';
import type { PullResult } from './ops/pull';

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
