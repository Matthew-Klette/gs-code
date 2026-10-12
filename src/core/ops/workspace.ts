import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GtmApi } from '../api';
import { BASE_DIR, FOLDERS_FILE, REMOTE_DIR, STATE_DIR } from '../mirror/layout';
import { readModel, removeDoc, writeBuiltIns, writeDoc, writeFolders } from '../mirror/model';
import { emptyState, hasState, readState, writeState, type MirrorState } from '../mirror/state';
import { renderFiles, type EntityDoc } from '../serialize/entityFiles';
import { GtmError, type ContainerInfo, type WorkspaceInfo } from '../types';
import { workingStatus } from './plan';
import { isServerContainer, type PullResult } from './pull';
import { refreshMirror } from './sync';

const README = `This folder mirrors a Google Tag Manager workspace.

Edit any file, then Push. Folders:
  tags/ triggers/ variables/ templates/ clients/ transformations/ zones/ gtag-configs/
  folders.json              folder names
  built-in-variables.json   enabled built-in variable types

.gtm/ is bookkeeping (last pulled copy + ids). Do not edit it by hand.
`;

/** Create a mirror for a workspace in `root` and pull it. */
/** Web and server containers only; mobile (Android/iOS) and AMP containers have different entity models. */
export function assertSupportedContainer(container: ContainerInfo): void {
  const unsupported = container.usageContext.filter((context) => !['web', 'server'].includes(context));
  if (container.usageContext.length > 0 && unsupported.length === container.usageContext.length) {
    throw new GtmError(`${container.publicId} is a ${unsupported.join('/')} container. GS Code supports web and server containers only.`);
  }
}

export async function initMirror(root: string, api: GtmApi, container: ContainerInfo, workspace: WorkspaceInfo): Promise<PullResult> {
  assertSupportedContainer(container);
  if (await hasState(root)) {
    const existing = await readState(root);
    if (existing.workspace.workspaceId !== workspace.workspaceId || existing.container.containerId !== container.containerId) {
      throw new GtmError(`${root} already mirrors ${existing.container.publicId} / ${existing.workspace.name}. Pick an empty folder.`);
    }
    return firstPull(root, api, existing);
  }
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  if (entries.some((entry) => !entry.startsWith('.'))) {
    throw new GtmError(`${root} is not empty. Pick an empty folder for the mirror.`);
  }
  await fs.mkdir(path.join(root, STATE_DIR), { recursive: true });
  await fs.writeFile(path.join(root, STATE_DIR, 'README.txt'), README, 'utf8');
  const state = emptyState(container, workspace);
  await writeState(root, state);
  return firstPull(root, api, state);
}

/** A full pull that also records GTM's status and latest version, so the next check costs two requests. */
async function firstPull(root: string, api: GtmApi, state: MirrorState): Promise<PullResult> {
  const result = await refreshMirror(root, api, state, { force: true });
  return result.pull as PullResult;
}

/** Restore working files for the given base paths (or everything) from `.gtm/base`. */
export async function discardChanges(root: string, state: MirrorState, bases?: readonly string[]): Promise<number> {
  const status = await workingStatus(root, state);
  const wanted = bases ? new Set(bases) : undefined;
  let count = 0;
  for (const change of status.changes.entities) {
    if (wanted && !wanted.has(change.base) && !(change.previousBase && wanted.has(change.previousBase))) continue;
    if (change.local) await removeDoc(root, change.local);
    if (change.original) await writeDoc(root, change.original);
    count++;
  }
  const wholeFile = (file: string) => !wanted || wanted.has(file);
  if (status.changes.folders.length && wholeFile('folders.json')) {
    await writeFolders(root, status.base.folders);
    count += status.changes.folders.length;
  }
  const builtInCount = status.changes.builtIns.enable.length + status.changes.builtIns.disable.length;
  if (builtInCount && wholeFile('built-in-variables.json')) {
    await writeBuiltIns(root, status.base.builtIns);
    count += builtInCount;
  }
  return count;
}

export type Resolution = 'mine' | 'theirs';

/**
 * Settle a conflict recorded by Pull.
 * mine:   accept the remote as the new base, so Push sends your version over it.
 * theirs: overwrite your file with the remote version.
 */
export async function resolveConflict(root: string, state: MirrorState, base: string, resolution: Resolution): Promise<MirrorState> {
  if (!state.conflicts.includes(base)) throw new GtmError(`${base} is not in conflict.`);
  if (base === FOLDERS_FILE) return resolveFolders(root, state, resolution);
  if (state.deletedRemotely.includes(base)) return resolveDeleted(root, state, base, resolution);
  const isServer = isServerContainer(state);
  const remote = (await readModel(path.join(root, REMOTE_DIR), isServer)).model.docs.get(base);
  const local = (await readModel(root, isServer)).model.docs.get(base);
  const baseDoc = (await readModel(path.join(root, BASE_DIR), isServer)).model.docs.get(base);
  if (!remote) throw new GtmError(`No remote copy for ${base}. Pull again.`);

  if (resolution === 'theirs') {
    await writeDoc(root, remote, local);
  }
  await writeDoc(path.join(root, BASE_DIR), remote, baseDoc);
  await removeDoc(path.join(root, REMOTE_DIR), remote);

  const entry = state.entities[base];
  const fingerprint = state.conflictFingerprints[base] ?? entry?.fingerprint;
  const { [base]: _settled, ...conflictFingerprints } = state.conflictFingerprints;
  const next: MirrorState = {
    ...state,
    conflicts: state.conflicts.filter((item) => item !== base),
    conflictFingerprints,
    entities: entry ? { ...state.entities, [base]: { ...entry, fingerprint } } : state.entities,
  };
  await writeState(root, next);
  return next;
}

/** GTM deleted an entity you edited. mine: keep the file, so Push creates it again. theirs: delete the file. */
async function resolveDeleted(root: string, state: MirrorState, base: string, resolution: Resolution): Promise<MirrorState> {
  if (resolution === 'theirs') {
    const local = (await readModel(root, isServerContainer(state))).model.docs.get(base);
    if (local) await removeDoc(root, local);
  }
  const next: MirrorState = {
    ...state,
    conflicts: state.conflicts.filter((item) => item !== base),
    deletedRemotely: state.deletedRemotely.filter((item) => item !== base),
  };
  await writeState(root, next);
  return next;
}

async function resolveFolders(root: string, state: MirrorState, resolution: Resolution): Promise<MirrorState> {
  const isServer = isServerContainer(state);
  if (resolution === 'theirs') {
    const remote = (await readModel(path.join(root, REMOTE_DIR), isServer)).model.folders;
    await writeFolders(root, remote);
  }
  const prefix = 'folder:';
  const folders = { ...state.folders };
  const conflictFingerprints: Record<string, string> = {};
  for (const [key, fingerprint] of Object.entries(state.conflictFingerprints)) {
    if (!key.startsWith(prefix)) {
      conflictFingerprints[key] = fingerprint;
      continue;
    }
    const name = key.slice(prefix.length);
    const entry = folders[name];
    if (entry) folders[name] = { ...entry, fingerprint };
  }
  await fs.rm(path.join(root, REMOTE_DIR, FOLDERS_FILE), { force: true });
  const next: MirrorState = { ...state, folders, conflictFingerprints, conflicts: state.conflicts.filter((item) => item !== FOLDERS_FILE) };
  await writeState(root, next);
  return next;
}

/** Files that make up an entity, for opening diffs. */
export function filesOf(doc: EntityDoc): string[] {
  return [...renderFiles(doc).keys()];
}
