import { createHash } from 'node:crypto';
import type { GtmApi } from '../api';
import { KIND_ORDER, KIND_SPECS, type EntityKind } from '../kinds';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { allocateBase, MERGE_DIR } from '../mirror/layout';
import { writeDoc, type Overlay } from '../mirror/model';
import { toLocalData } from '../serialize/entityFiles';
import { buildRefContext } from '../serialize/references';
import { entityKey, writeState, type GtmConflict, type MirrorState } from '../mirror/state';
import { canonicalJson } from '../serialize/canonical';
import { GtmError, type ApiChange, type ApiEntity, type ApiMergeConflict, type RemoteSnapshot, type WorkspaceInfo, type WorkspaceStatus } from '../types';
import { applySnapshot, type PullResult } from './pull';

export interface RefreshOptions {
  /** Pull even if GTM looks unchanged (the Pull command). */
  readonly force?: boolean;
  /** Unsaved editor buffers; they count as local edits and are never overwritten. */
  readonly overlay?: Overlay;
  readonly onProgress?: (message: string) => void;
}

export interface RefreshResult {
  readonly state: MirrorState;
  /** True when a full pull ran. */
  readonly pulled: boolean;
  readonly pull?: PullResult;
  /** Set when the workspace was brought up to a newer container version. */
  readonly syncedTo?: string;
  /** Set when the mirrored workspace was gone and the mirror moved to another one. */
  readonly movedTo?: WorkspaceInfo;
}

/** Stable hash of a `workspaces.getStatus` response. Every entity edit changes it (verified live). */
export function statusSignature(status: WorkspaceStatus): string {
  return createHash('sha256').update(canonicalJson(status)).digest('hex').slice(0, 32);
}

/**
 * Bring the mirror up to date with GTM, cheaply when nothing changed.
 *
 * 1. `getStatus` + `version_headers:latest` (2 requests): has anything changed?
 * 2. A newer container version exists → `workspaces.sync` so the workspace itself catches up
 *    (GTM merge conflicts are recorded, never auto-resolved).
 * 3. Only if something changed: the full pull (~10 requests) with the usual three-way merge,
 *    so local edits, including unsaved editor buffers, are never overwritten.
 *
 * The status is read before the snapshot, so an edit that lands in between is caught by the next check.
 */
export async function refreshMirror(root: string, api: GtmApi, initial: MirrorState, options: RefreshOptions = {}): Promise<RefreshResult> {
  const progress = options.onProgress ?? (() => undefined);
  let state = initial;
  let movedTo: WorkspaceInfo | undefined;

  let status: WorkspaceStatus;
  try {
    status = await api.getWorkspaceStatus(state.workspace);
  } catch (error: unknown) {
    if (!(error instanceof GtmError) || error.status !== 404) throw error;
    progress(`Workspace "${state.workspace.name}" no longer exists in GTM (it was probably versioned or deleted). Moving to a replacement…`);
    movedTo = await followWorkspace(api, state);
    state = { ...state, workspace: movedTo, remote: undefined };
    await writeState(root, state);
    status = await api.getWorkspaceStatus(state.workspace);
  }

  const latest = await api.latestVersionId(state.container.accountId, state.container.containerId);
  let syncedTo: string | undefined;
  if (latest && latest !== state.remote?.versionId) {
    progress(`Bringing workspace "${state.workspace.name}" up to container version ${latest}…`);
    const sync = await api.syncWorkspace(state.workspace);
    if (sync.syncError) throw new GtmError(`GTM could not sync workspace "${state.workspace.name}" to version ${latest}. Open it in Tag Manager to see why.`);
    syncedTo = latest;
    status = await api.getWorkspaceStatus(state.workspace);
  }

  const signature = statusSignature(status);
  const waitingOnSave = state.deferred.length > 0 && !state.deferred.some((file) => options.overlay?.has(file));
  const changed = options.force || movedTo !== undefined || syncedTo !== undefined || waitingOnSave || signature !== state.remote?.status;
  if (!changed) return { state, pulled: false };

  progress('Pulling changes from GTM…');
  const snapshot = await api.fetchSnapshot(state.workspace, state.container.usageContext);
  const pull = await applySnapshot(root, state, snapshot, { overlay: options.overlay });
  const next: MirrorState = {
    ...pull.state,
    remote: { status: signature, versionId: latest ?? state.remote?.versionId },
    gtmConflicts: toGtmConflicts(status.mergeConflict, pull.state),
  };
  await writeState(root, next);
    await writeMergeCopies(root, next, status.mergeConflict, snapshot);
  return { state: next, pulled: true, pull: { ...pull, state: next }, syncedTo, movedTo };
}

/**
 * The mirrored workspace is gone (GTM deletes a workspace when a version is created from it).
 * Reuse a workspace with the same name, or create one: it starts from the latest version,
 * and entity ids are container-wide, so the three-way merge carries on as before.
 */
async function followWorkspace(api: GtmApi, state: MirrorState): Promise<WorkspaceInfo> {
  const { accountId, containerId } = state.container;
  const existing = (await api.listWorkspaces(accountId, containerId)).find((workspace) => workspace.name === state.workspace.name);
  if (existing) return existing;
  try {
    return await api.createWorkspace(accountId, containerId, state.workspace.name, state.workspace.description);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GtmError(`Workspace "${state.workspace.name}" no longer exists in GTM and a replacement could not be created: ${reason}`);
  }
}

/** The entity inside one side of a merge conflict, with its kind. */
export function changedEntity(change: ApiChange | undefined): { kind: EntityKind; entity: ApiEntity } | undefined {
  if (!change) return undefined;
  for (const kind of KIND_ORDER) {
    const entity = change[KIND_SPECS[kind].entityField];
    if (entity && typeof entity === 'object') return { kind, entity: entity as ApiEntity };
  }
  return undefined;
}

export function conflictKey(conflict: ApiMergeConflict): string | undefined {
  const side = changedEntity(conflict.entityInWorkspace) ?? changedEntity(conflict.entityInBaseVersion);
  return side ? entityKey(side.kind, String(side.entity[KIND_SPECS[side.kind].idField])) : undefined;
}

function toGtmConflicts(conflicts: readonly ApiMergeConflict[], state: MirrorState): GtmConflict[] {
  const byKey = new Map(Object.entries(state.entities).map(([base, entry]) => [entityKey(entry.kind, entry.id), base]));
  const taken = new Set(Object.keys(state.entities).map((base) => base.toLowerCase()));
  return conflicts.flatMap((conflict): GtmConflict[] => {
    const side = changedEntity(conflict.entityInWorkspace) ?? changedEntity(conflict.entityInBaseVersion);
    if (!side) return [];
    const id = String(side.entity[KIND_SPECS[side.kind].idField]);
    const name = typeof side.entity.name === 'string' ? side.entity.name : undefined;
    return [{
      kind: side.kind,
      id,
      name,
      base: byKey.get(entityKey(side.kind, id)) ?? allocateBase(side.kind, name ?? id, id, taken),
      workspaceChange: conflict.entityInWorkspace?.changeStatus,
      latestChange: conflict.entityInBaseVersion?.changeStatus,
    }];
  });
}

/** The latest version's side of each GTM merge conflict, rendered as files for a side-by-side diff. */
async function writeMergeCopies(root: string, state: MirrorState, conflicts: readonly ApiMergeConflict[], snapshot: RemoteSnapshot): Promise<void> {
  const mergeRoot = path.join(root, MERGE_DIR);
  await fs.rm(mergeRoot, { recursive: true, force: true });
  const ctx = buildRefContext(state.container.containerId, snapshot);
  for (const conflict of conflicts) {
    const latest = changedEntity(conflict.entityInBaseVersion);
    const record = state.gtmConflicts.find((item) => entityKey(item.kind, item.id) === conflictKey(conflict));
    if (!latest || !record || conflict.entityInBaseVersion?.changeStatus === 'deleted') continue;
    await writeDoc(mergeRoot, { kind: latest.kind, base: record.base, data: toLocalData(latest.kind, latest.entity, ctx) });
  }
}

export type GtmResolution = 'workspace' | 'latest';

/**
 * Settle a GTM merge conflict: keep this workspace's version of the entity, or take the
 * latest container version's. Then pull so the files match.
 */
export async function resolveGtmConflict(
  root: string,
  api: GtmApi,
  state: MirrorState,
  target: string,
  resolution: GtmResolution,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const wanted = state.gtmConflicts.find((item) => item.base === target || entityKey(item.kind, item.id) === target || item.name === target);
  if (!wanted) throw new GtmError(`${target} is not a GTM merge conflict.`);
  const status = await api.getWorkspaceStatus(state.workspace);
  const conflict = status.mergeConflict.find((item) => conflictKey(item) === entityKey(wanted.kind, wanted.id));
  if (conflict) {
    const chosen = resolution === 'workspace' ? conflict.entityInWorkspace : conflict.entityInBaseVersion;
    if (!chosen) throw new GtmError(`GTM returned no ${resolution} side for ${wanted.base}.`);
    const fingerprint = changedEntity(conflict.entityInWorkspace)?.entity.fingerprint;
    await api.resolveConflict(state.workspace, chosen, fingerprint);
  }
  return refreshMirror(root, api, state, { ...options, force: true });
}
