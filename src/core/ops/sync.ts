import { createHash } from 'node:crypto';
import type { GtmApi } from '../api';
import { KIND_ORDER, KIND_SPECS, type EntityKind } from '../kinds';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { allocateBase, MERGE_DIR, STATE_DIR } from '../mirror/layout';
import { withMirrorLock } from '../mirror/lock';
import { writeDoc, type Overlay } from '../mirror/model';
import { toLocalData } from '../serialize/entityFiles';
import { buildRefContext } from '../serialize/references';
import { entityKey, writeState, type GtmConflict, type MirrorState } from '../mirror/state';
import { canonicalJson } from '../serialize/canonical';
import {
  GtmError,
  isWorkspaceGoneStatus,
  WorkspaceGoneError,
  type ApiChange,
  type ApiEntity,
  type ApiMergeConflict,
  type RemoteSnapshot,
  type WorkspaceInfo,
  type WorkspaceStatus,
} from '../types';
import { applySnapshot, type PullResult } from './pull';

export interface RefreshOptions {
  /** Pull even if GTM looks unchanged (the Pull command). */
  readonly force?: boolean;
  /** Unsaved editor buffers; they count as local edits and are never overwritten. */
  readonly overlay?: Overlay;
  readonly onProgress?: (message: string) => void;
  /**
   * Bring the workspace up to a newer container version (`workspaces.sync`). That writes to GTM, so
   * only explicit actions (Pull, before Create Version) ask for it; background checks never do.
   */
  readonly sync?: boolean;
  /** How long to wait for another process working on this folder (0 = skip this round). */
  readonly lockWaitMs?: number;
}

export interface RefreshResult {
  readonly state: MirrorState;
  /** True when a full pull ran. */
  readonly pulled: boolean;
  readonly pull?: PullResult;
  /** Set when the workspace was brought up to a newer container version. */
  readonly syncedTo?: string;
  /** Set when the mirror moved to another workspace (Switch Workspace). */
  readonly movedTo?: WorkspaceInfo;
  /** A newer container version exists that this workspace was not synced to. */
  readonly behind?: string;
  /** Why a requested sync did not happen (e.g. no permission to update the workspace). */
  readonly syncSkipped?: string;
  /** The full snapshot a pull just applied, so a push right after can reuse it. */
  readonly snapshot?: RemoteSnapshot;
}

const NO_VERSION = '0';

/** Stable hash of a `workspaces.getStatus` response. Every entity edit changes it (verified live). */
export function statusSignature(status: WorkspaceStatus): string {
  return createHash('sha256').update(canonicalJson(status)).digest('hex').slice(0, 32);
}

/**
 * Bring the mirror up to date with GTM, cheaply when nothing changed.
 *
 * 1. `getStatus` + `version_headers:latest` (2 requests): has anything changed?
 * 2. A newer container version exists → recorded as `behind`. Only with `sync` is the workspace
 *    brought up to it (`workspaces.sync`; GTM merge conflicts are recorded, never auto-resolved).
 * 3. Only if something changed: the full pull (~10 requests) with the usual three-way merge,
 *    so local edits, including unsaved editor buffers, are never overwritten.
 *
 * The status is read before the snapshot, so an edit that lands in between is caught by the next check.
 * A workspace that no longer exists raises `WorkspaceGoneError`; the mirror never guesses a replacement.
 */
export async function refreshMirror(root: string, api: GtmApi, initial: MirrorState, options: RefreshOptions = {}): Promise<RefreshResult> {
  return withMirrorLock(root, 'pull', () => refreshLocked(root, api, initial, options), options.lockWaitMs);
}

async function refreshLocked(root: string, api: GtmApi, initial: MirrorState, options: RefreshOptions, movedTo?: WorkspaceInfo): Promise<RefreshResult> {
  const progress = options.onProgress ?? (() => undefined);
  const state = initial;
  let status = await statusOrGone(api, state);

  const latest = await api.latestVersionId(state.container.accountId, state.container.containerId);
  const known = state.remote?.versionId;
  let syncedTo: string | undefined;
  let syncSkipped: string | undefined;
  // A new mirror adopts the latest version as its starting point instead of syncing on its first check.
  let behind = latest && known && latest !== known ? latest : undefined;
  if (behind && options.sync) {
    progress(`Bringing workspace "${state.workspace.name}" up to container version ${behind}…`);
    try {
      const sync = await api.syncWorkspace(state.workspace);
      if (sync.syncError) throw new GtmError(`GTM could not sync workspace "${state.workspace.name}" to version ${behind}. Open it in Tag Manager to see why.`);
      syncedTo = behind;
      behind = undefined;
      status = await api.getWorkspaceStatus(state.workspace);
    } catch (error: unknown) {
      if (!(error instanceof GtmError) || error.status !== 403) throw error;
      syncSkipped = `no permission to update workspace "${state.workspace.name}" to version ${behind}; pulled without syncing`;
      progress(syncSkipped);
    }
  }
  // '0' = the container had no versions yet, so the first version published later counts as newer.
  const versionId = syncedTo ?? known ?? latest ?? NO_VERSION;

  const signature = statusSignature(status);
  const waitingOnSave = state.deferred.length > 0 && !state.deferred.some((file) => options.overlay?.has(file));
  const changed = options.force || movedTo !== undefined || syncedTo !== undefined || waitingOnSave || signature !== state.remote?.status;
  if (!changed) {
    if (behind === state.remote?.behind && versionId === known) return { state, pulled: false, behind, syncSkipped };
    const marked: MirrorState = { ...state, remote: { ...state.remote, versionId, behind } };
    await writeState(root, marked);
    return { state: marked, pulled: false, behind, syncSkipped };
  }

  progress('Pulling changes from GTM…');
  const snapshot = await api.fetchSnapshot(state.workspace, state.container.usageContext);
  const pull = await applySnapshot(root, state, snapshot, { overlay: options.overlay });
  const next: MirrorState = {
    ...pull.state,
    remote: { status: signature, versionId, behind },
    gtmConflicts: toGtmConflicts(status.mergeConflict, pull.state),
  };
  await writeState(root, next);
  await writeMergeCopies(root, next, status.mergeConflict, snapshot);
  return { state: next, pulled: true, pull: { ...pull, state: next }, syncedTo, movedTo, behind, syncSkipped, snapshot };
}

/** `getStatus`, turning "workspace gone" into `WorkspaceGoneError` with the workspaces to choose from. */
async function statusOrGone(api: GtmApi, state: MirrorState): Promise<WorkspaceStatus> {
  try {
    return await api.getWorkspaceStatus(state.workspace);
  } catch (error: unknown) {
    if (!isWorkspaceGoneStatus(error)) throw error;
    const candidates = await api.listWorkspaces(state.container.accountId, state.container.containerId);
    // Still listed: a different problem (permissions, a typo'd id); show the real error.
    if (candidates.some((workspace) => workspace.workspaceId === state.workspace.workspaceId)) throw error;
    throw new WorkspaceGoneError(state.workspace, candidates);
  }
}

export interface SwitchResult extends RefreshResult {
  /** Copy of the working files taken before switching, in case the new workspace replaces some. */
  readonly backup: string;
}

/**
 * Point the mirror at another workspace (after the old one was versioned or deleted, or by choice).
 * Working files are backed up first; then a full three-way pull keeps your unpushed edits.
 */
export async function switchWorkspace(root: string, api: GtmApi, state: MirrorState, target: WorkspaceInfo, options: RefreshOptions = {}): Promise<SwitchResult> {
  return withMirrorLock(root, 'switch workspace', async () => {
    const backup = await backupWorkingFiles(root);
    const moved: MirrorState = { ...state, workspace: target, remote: undefined, gtmConflicts: [] };
    await writeState(root, moved);
    const result = await refreshLocked(root, api, moved, { ...options, force: true }, target);
    return { ...result, backup };
  }, options.lockWaitMs);
}

export const BACKUP_DIR = `${STATE_DIR}/backups`;

async function backupWorkingFiles(root: string): Promise<string> {
  const target = path.join(root, BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(root)) {
    if (entry === STATE_DIR) continue;
    await fs.cp(path.join(root, entry), path.join(target, entry), { recursive: true });
  }
  return path.relative(root, target).split(path.sep).join('/');
}

/**
 * After Create Version: GTM deleted the workspace and returned no replacement (it only does when the
 * versioned workspace was the last one). Create a fresh one with the same name; never adopt someone
 * else's workspace that happens to share it.
 */
export async function replacementWorkspace(api: GtmApi, state: MirrorState): Promise<WorkspaceInfo> {
  const { accountId, containerId } = state.container;
  try {
    return await api.createWorkspace(accountId, containerId, state.workspace.name, state.workspace.description);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkspaceGoneError(state.workspace, await api.listWorkspaces(accountId, containerId).catch(() => []), reason);
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
