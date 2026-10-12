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

/** One side of a GTM merge conflict: `{ changeStatus, tag | trigger | variable | … }`. */
export type ApiChange = Record<string, unknown> & { changeStatus?: string };

/** An entity changed both in this workspace and in a newer container version. */
export interface ApiMergeConflict {
  readonly entityInWorkspace?: ApiChange;
  readonly entityInBaseVersion?: ApiChange;
}

/** `workspaces.getStatus`: what the workspace changed relative to its base version. */
export interface WorkspaceStatus {
  readonly workspaceChange: readonly ApiChange[];
  readonly mergeConflict: readonly ApiMergeConflict[];
}

export interface SyncResult {
  readonly mergeConflict: boolean;
  readonly syncError: boolean;
  readonly conflicts: readonly ApiMergeConflict[];
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

/** Not signed in, or the sign-in expired. Retrying will not help; the user has to sign in again. */
export class AuthError extends GtmError {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
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
