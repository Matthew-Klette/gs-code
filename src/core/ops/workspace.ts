import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GtmApi } from '../api';
import { BASE_DIR, FOLDERS_FILE, REMOTE_DIR, STATE_DIR } from '../mirror/layout';
import { readModel, removeDoc, writeBuiltIns, writeDoc, writeFolders } from '../mirror/model';
import { emptyState, hasState, readState, writeState, type MirrorState } from '../mirror/state';
import { withMirrorLock } from '../mirror/lock';
import { allocateBase } from '../mirror/layout';
import { KIND_SPECS } from '../kinds';
import { canonicalJson } from '../serialize/canonical';
import { docName, renderFiles, type EntityDoc } from '../serialize/entityFiles';
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

export interface InitOptions {
  /**
   * The folder already holds mirror files (a git clone of a teammate's mirror): match them to GTM
   * entities by kind and name, keep their file names, and treat any difference as your local edit.
   */
  readonly adopt?: boolean;
}

/** `.gtm/` is per person and per workspace; the files are what a team shares through git. */
const GITIGNORE = `# GS Code: .gtm/ is this machine's link to one GTM workspace. Never commit it.
.gtm/
`;

export async function initMirror(root: string, api: GtmApi, container: ContainerInfo, workspace: WorkspaceInfo, options: InitOptions = {}): Promise<PullResult> {
  assertSupportedContainer(container);
  if (await hasState(root)) {
    const existing = await readState(root);
    if (existing.workspace.workspaceId !== workspace.workspaceId || existing.container.containerId !== container.containerId) {
      throw new GtmError(`${root} already mirrors ${existing.container.publicId} / ${existing.workspace.name}. Pick an empty folder.`);
    }
    return firstPull(root, api, existing);
  }
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  if (!options.adopt && entries.some((entry) => !entry.startsWith('.'))) {
    throw new GtmError(`${root} is not empty. Pick an empty folder, or adopt the files already there (gscode init --adopt).`);
  }
  await fs.mkdir(path.join(root, STATE_DIR), { recursive: true });
  await fs.writeFile(path.join(root, STATE_DIR, 'README.txt'), README, 'utf8');
  if (!entries.includes('.gitignore')) await fs.writeFile(path.join(root, '.gitignore'), GITIGNORE, 'utf8');
  const empty = emptyState(container, workspace);
  const state = options.adopt ? await withAdoption(root, empty) : empty;
  await writeState(root, state);
  return firstPull(root, api, state);
}

/** Every existing entity file may be adopted by the first pull (by name, or by content when unnamed). */
async function withAdoption(root: string, state: MirrorState): Promise<MirrorState> {
  const { model } = await readModel(root, isServerContainer(state));
  const created = Object.fromEntries([...model.docs.values()].map((doc) => [doc.base, canonicalJson(doc.data)]));
  return { ...state, pendingPush: { pushed: {}, created, keepLocal: true } };
}

/**
 * Rename files whose name no longer matches their GTM name (renamed in GTM, or created on another
 * machine), so every clone of a shared mirror uses the same file names.
 */
export async function tidyFileNames(root: string, state: MirrorState): Promise<{ readonly state: MirrorState; readonly renamed: readonly [string, string][] }> {
  return withMirrorLock(root, 'tidy', async () => {
    const isServer = isServerContainer(state);
    const baseRoot = path.join(root, BASE_DIR);
    const local = (await readModel(root, isServer)).model;
    const base = (await readModel(baseRoot, isServer)).model;
    const taken = new Set([...local.docs.keys(), ...base.docs.keys()].map((item) => item.toLowerCase()));
    const entities = { ...state.entities };
    const renamed: [string, string][] = [];
    const busy = new Set([...state.conflicts, ...state.gtmConflicts.map((item) => item.base)]);
    for (const [from, entry] of Object.entries(state.entities)) {
      const mine = local.docs.get(from);
      const original = base.docs.get(from);
      const doc = original ?? mine;
      const name = doc ? docName(doc) : undefined;
      if (busy.has(from) || !name || !KIND_SPECS[entry.kind].named) continue;
      taken.delete(from.toLowerCase());
      const to = allocateBase(entry.kind, name, entry.id, taken);
      taken.add(to.toLowerCase());
      if (to === from) continue;
      if (mine) {
        await writeDoc(root, { ...mine, base: to });
        await removeDoc(root, mine);
      }
      if (original) {
        await writeDoc(baseRoot, { ...original, base: to });
        await removeDoc(baseRoot, original);
      }
      delete entities[from];
      entities[to] = entry;
      renamed.push([from, to]);
    }
    const next: MirrorState = { ...state, entities };
    await writeState(root, next);
    return { state: next, renamed };
  });
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
