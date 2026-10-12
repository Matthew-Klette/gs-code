import type { EntityKind } from './kinds';

/** A raw entity exactly as the GTM API returns it. */
export type ApiEntity = Record<string, unknown> & { name?: string; fingerprint?: string };

export interface BuiltInVariable {
  type: string;
  name?: string;
}

/** Everything in a workspace, keyed by kind. */
export interface RemoteSnapshot {
  readonly entities: Readonly<Record<EntityKind, readonly ApiEntity[]>>;
  readonly builtInVariables: readonly BuiltInVariable[];
  /** Kinds whose list call failed as unsupported; their absence must not be read as deletion. */
  readonly unavailable?: readonly EntityKind[];
}

export interface WorkspaceRef {
  readonly accountId: string;
  readonly containerId: string;
  readonly workspaceId: string;
}

export interface ContainerInfo {
  readonly accountId: string;
  readonly containerId: string;
  readonly publicId: string;
  readonly name: string;
  readonly usageContext: readonly string[];
  readonly tagManagerUrl?: string;
}

export interface WorkspaceInfo extends WorkspaceRef {
  readonly name: string;
  readonly description?: string;
  readonly tagManagerUrl?: string;
}

export interface AccountInfo {
  readonly accountId: string;
  readonly name: string;
}

export type ChangeStatus = 'added' | 'updated' | 'deleted';

export interface BulkEntity {
  changeStatus: ChangeStatus;
  [entityField: string]: unknown;
}

export interface CreateVersionResult {
  readonly containerVersionId?: string;
  readonly versionFingerprint?: string;
  readonly compilerError: boolean;
  readonly newWorkspacePath?: string;
  readonly syncStatus?: { mergeConflict?: boolean; syncError?: boolean };
}

export class GtmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GtmError';
  }
}

export function workspacePath(ref: WorkspaceRef): string {
  return `accounts/${ref.accountId}/containers/${ref.containerId}/workspaces/${ref.workspaceId}`;
}

export function parseWorkspacePath(path: string): WorkspaceRef {
  const match = /^accounts\/(\d+)\/containers\/(\d+)\/workspaces\/(\d+)$/.exec(path);
  if (!match || !match[1] || !match[2] || !match[3]) {
    throw new GtmError(`Not a workspace path: ${path}`);
  }
  return { accountId: match[1], containerId: match[2], workspaceId: match[3] };
}
