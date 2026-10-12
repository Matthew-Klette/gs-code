import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GtmApi } from '../api';
import { KIND_ORDER, KIND_SPECS, VOLATILE_FIELDS } from '../kinds';
import { allocateBase, BASE_DIR, FOLDERS_FILE, REMOTE_DIR } from '../mirror/layout';
import {
  readModel,
  removeDoc,
  sameDoc,
  writeBuiltIns,
  writeDoc,
  writeFolders,
  type FolderDoc,
  type MirrorModel,
} from '../mirror/model';
import { entityKey, writeState, type FolderEntry, type IndexEntry, type MirrorState } from '../mirror/state';
import { canonicalJson } from '../serialize/canonical';
import { docName, toLocalData, type EntityDoc } from '../serialize/entityFiles';
import { buildRefContext } from '../serialize/references';
import type { ApiEntity, RemoteSnapshot } from '../types';

export interface ApplyOptions {
  /** `kind:id` keys whose remote version wins unconditionally (just pushed). */
  readonly forceRemote?: ReadonlySet<string>;
  /** `kind:id` → base path to use for that entity (new or renamed locally). */
  readonly pathHints?: ReadonlyMap<string, string>;
  /**
   * After a push: a new remote entity that matches an unindexed local file
   * (same name, or same content for unnamed kinds) is that file, just created. Take the remote.
   */
  readonly adoptPushed?: boolean;
}

export interface PullResult {
  readonly state: MirrorState;
  /** Files refreshed from GTM (no local edits in the way). */
  readonly updated: readonly string[];
  /** New entities from GTM. */
  readonly added: readonly string[];
  /** Entities deleted in GTM and removed locally. */
  readonly removed: readonly string[];
  /** Changed both locally and in GTM. Local kept; remote copy in `.gtm/remote`. */
  readonly conflicts: readonly string[];
  /** Changed locally but deleted in GTM. Kept as a local addition. */
  readonly orphaned: readonly string[];
}

export function isServerContainer(state: MirrorState): boolean {
  return state.container.usageContext.includes('server');
}

export async function pullWorkspace(root: string, api: GtmApi, state: MirrorState): Promise<PullResult> {
  const snapshot = await api.fetchSnapshot(state.workspace, state.container.usageContext);
  return applySnapshot(root, state, snapshot);
}

/** Three-way merge of a remote snapshot into the working tree and `.gtm/base`. */
export async function applySnapshot(
  root: string,
  state: MirrorState,
  snapshot: RemoteSnapshot,
  options: ApplyOptions = {},
): Promise<PullResult> {
  const isServer = isServerContainer(state);
  const baseRoot = path.join(root, BASE_DIR);
  const remoteRoot = path.join(root, REMOTE_DIR);
  const localRead = await readModel(root, isServer);
  const base = (await readModel(baseRoot, isServer)).model;
  const local = localRead.model;
  const brokenLocal = new Set(localRead.problems.map((problem) => problemBase(problem.path)));
  await fs.rm(remoteRoot, { recursive: true, force: true });

  const ctx = buildRefContext(state.container.containerId, snapshot);
  const forced = options.forceRemote ?? new Set<string>();
  const hints = options.pathHints ?? new Map<string, string>();
  const indexByKey = new Map(Object.entries(state.entities).map(([base, entry]) => [entityKey(entry.kind, entry.id), base]));
  const taken = new Set([...local.docs.keys(), ...base.docs.keys(), ...brokenLocal].map((item) => item.toLowerCase()));

  const entities: Record<string, IndexEntry> = {};
  const result = { updated: [] as string[], added: [] as string[], removed: [] as string[], conflicts: [] as string[], orphaned: [] as string[] };
  const seen = new Set<string>();
  const conflictFingerprints: Record<string, string> = {};
  const indexedBases = new Set(Object.keys(state.entities));
  const claimed = new Set<string>();
  const adopt = (kind: EntityDoc['kind'], data: Record<string, unknown>): EntityDoc | undefined =>
    [...local.docs.values()].find(
      (doc) =>
        doc.kind === kind &&
        !indexedBases.has(doc.base) &&
        !claimed.has(doc.base) &&
        (KIND_SPECS[kind].named ? docName(doc) === data.name : canonicalJson(doc.data) === canonicalJson(data)),
    );

  for (const kind of KIND_ORDER) {
    if (kind === 'folder') continue;
    const spec = KIND_SPECS[kind];
    for (const entity of snapshot.entities[kind]) {
      const id = String(entity[spec.idField]);
      const key = entityKey(kind, id);
      seen.add(key);
      const indexedBase = indexByKey.get(key);
      const data = toLocalData(kind, entity, ctx);
      const adopted = !indexedBase && !hints.has(key) ? adopt(kind, data) : undefined;
      const target = hints.get(key) ?? indexedBase ?? adopted?.base ?? allocateBase(kind, String(entity.name ?? id), id, taken);
      taken.add(target.toLowerCase());
      claimed.add(target);
      const remote: EntityDoc = { kind, base: target, data };
      const original = indexedBase ? base.docs.get(indexedBase) : undefined;
      const mine = local.docs.get(target);
      const entry: IndexEntry = { kind, id, fingerprint: entity.fingerprint };
      const oldEntry = indexedBase ? state.entities[indexedBase] : undefined;

      if (indexedBase && indexedBase !== target && original) {
        await removeDoc(baseRoot, original);
      }

      const isForced = forced.has(key) || (adopted !== undefined && options.adoptPushed === true);
      const outcome = decide({ remote, original, mine, forced: isForced, broken: brokenLocal.has(target), isNew: !indexedBase });
      switch (outcome) {
        case 'take-remote': {
          const changedLocally = !sameDoc(mine, remote);
          if (changedLocally) await writeDoc(root, remote, mine);
          await writeDoc(baseRoot, remote, original?.base === target ? original : undefined);
          if (!indexedBase && !hints.has(key) && !adopted) result.added.push(target);
          else if (changedLocally) result.updated.push(target);
          entities[target] = entry;
          break;
        }
        case 'refresh-base':
          if (!sameDoc(original, remote) || original?.base !== target) await writeDoc(baseRoot, remote, original?.base === target ? original : undefined);
          entities[target] = entry;
          break;
        case 'keep-local':
          // A broken local file keeps the old fingerprint so a later push still detects remote changes.
          entities[target] = brokenLocal.has(target) && oldEntry ? oldEntry : entry;
          break;
        case 'conflict':
          await writeDoc(remoteRoot, remote);
          result.conflicts.push(target);
          if (entity.fingerprint) conflictFingerprints[target] = entity.fingerprint;
          entities[target] = oldEntry ?? entry;
          break;
      }
    }
  }

  const unavailable = new Set(snapshot.unavailable ?? []);
  for (const [key, indexedBase] of indexByKey) {
    if (seen.has(key)) continue;
    const indexed = state.entities[indexedBase] as IndexEntry;
    if (unavailable.has(indexed.kind)) {
      entities[indexedBase] = indexed; // could not list this kind; keep everything as is
      continue;
    }
    const original = base.docs.get(indexedBase);
    const mine = local.docs.get(indexedBase);
    if (!original && mine) {
      // Base copy missing (interrupted earlier pull): never guess, keep the file and its index entry.
      entities[indexedBase] = state.entities[indexedBase] as IndexEntry;
      continue;
    }
    if (!mine || sameDoc(mine, original)) {
      if (mine) await removeDoc(root, mine);
      result.removed.push(indexedBase);
    } else {
      result.orphaned.push(indexedBase);
    }
    if (original) await removeDoc(baseRoot, original);
  }

  const folderMerge = await mergeFolders(root, baseRoot, remoteRoot, local, base, snapshot, state.folders);
  const folders = folderMerge.entries;
  for (const [name, fingerprint] of Object.entries(folderMerge.remoteFingerprints)) conflictFingerprints[`folder:${name}`] = fingerprint;
  if (folderMerge.collided.length) result.conflicts.push(FOLDERS_FILE);
  const builtIns = await mergeBuiltIns(root, baseRoot, local, base, snapshot);

  const nextState: MirrorState = {
    ...state,
    pulledAt: new Date().toISOString(),
    entities,
    folders,
    conflicts: result.conflicts,
    conflictFingerprints,
    builtInNames: Object.fromEntries(snapshot.builtInVariables.filter((item) => item.name).map((item) => [item.type, item.name as string])),
  };
  await writeState(root, nextState);
  return { state: nextState, ...result };
}

type Outcome = 'take-remote' | 'refresh-base' | 'keep-local' | 'conflict';

interface DecideInput {
  readonly remote: EntityDoc;
  readonly original?: EntityDoc;
  readonly mine?: EntityDoc;
  readonly forced: boolean;
  readonly broken: boolean;
  readonly isNew: boolean;
}

export function decide({ remote, original, mine, forced, broken, isNew }: DecideInput): Outcome {
  if (forced) return 'take-remote';
  if (broken) return 'keep-local';
  if (isNew || !original) return mine && !sameDoc(mine, remote) ? 'conflict' : 'take-remote';
  if (!mine) return sameDoc(original, remote) ? 'keep-local' : 'conflict';
  if (sameDoc(mine, original)) return sameDoc(remote, original) ? 'refresh-base' : 'take-remote';
  if (sameDoc(remote, original)) return 'keep-local';
  if (sameDoc(remote, mine)) return 'refresh-base';
  return 'conflict';
}

function problemBase(problemPath: string): string {
  if (problemPath.endsWith('/template.json')) return problemPath.slice(0, -'/template.json'.length);
  return problemPath.replace(/\.json$/, '');
}

function toFolderDoc(entity: ApiEntity): FolderDoc {
  const skip = new Set([...VOLATILE_FIELDS, 'folderId']);
  return Object.fromEntries(Object.entries(entity).filter(([key]) => !skip.has(key))) as FolderDoc;
}

interface FolderMerge {
  readonly entries: Record<string, FolderEntry>;
  /** Folders changed both locally and in GTM: local kept, old fingerprint kept so Push stops. */
  readonly collided: readonly string[];
  readonly remoteFingerprints: Readonly<Record<string, string>>;
}

async function mergeFolders(
  root: string,
  baseRoot: string,
  remoteRoot: string,
  local: MirrorModel,
  base: MirrorModel,
  snapshot: RemoteSnapshot,
  previous: Readonly<Record<string, FolderEntry>>,
): Promise<FolderMerge> {
  const remote = snapshot.entities.folder.map(toFolderDoc);
  const json = (folder: FolderDoc | undefined) => (folder ? canonicalJson(folder) : undefined);
  const localByName = new Map(local.folders.map((folder) => [folder.name, folder]));
  const baseByName = new Map(base.folders.map((folder) => [folder.name, folder]));
  const collided = remote
    .filter((folder) => {
      const before = json(baseByName.get(folder.name));
      const mine = json(localByName.get(folder.name));
      return before !== undefined && mine !== undefined && mine !== before && json(folder) !== before && json(folder) !== mine;
    })
    .map((folder) => folder.name);
  const merged = threeWay(
    local.folders.map((folder): [string, FolderDoc] => [folder.name, folder]),
    base.folders.map((folder): [string, FolderDoc] => [folder.name, folder]),
    remote.map((folder): [string, FolderDoc] => [folder.name, folder]),
  );
  if (canonicalJson(sortByName(merged)) !== canonicalJson(sortByName(local.folders)) || !(await exists(root, 'folders.json'))) {
    await writeFolders(root, merged);
  }
  await writeFolders(baseRoot, remote);
  if (collided.length) await writeFolders(remoteRoot, remote);
  const collidedSet = new Set(collided);
  const entries: Record<string, FolderEntry> = {};
  const remoteFingerprints: Record<string, string> = {};
  for (const folder of snapshot.entities.folder) {
    const name = String(folder.name);
    const fresh: FolderEntry = { id: String(folder.folderId), fingerprint: folder.fingerprint };
    entries[name] = collidedSet.has(name) ? (previous[name] ?? fresh) : fresh;
    if (collidedSet.has(name) && folder.fingerprint) remoteFingerprints[name] = folder.fingerprint;
  }
  return { entries, collided, remoteFingerprints };
}

async function mergeBuiltIns(root: string, baseRoot: string, local: MirrorModel, base: MirrorModel, snapshot: RemoteSnapshot): Promise<void> {
  const remote = snapshot.builtInVariables.map((item) => item.type);
  const pairs = (items: readonly string[]) => items.map((type): [string, string] => [type, type]);
  const merged = threeWay(pairs(local.builtIns), pairs(base.builtIns), pairs(remote));
  if (canonicalJson([...merged].sort()) !== canonicalJson([...local.builtIns].sort()) || !(await exists(root, 'built-in-variables.json'))) {
    await writeBuiltIns(root, merged);
  }
  await writeBuiltIns(baseRoot, remote);
}

/** Generic keyed three-way merge where local edits win over remote edits. */
export function threeWay<T>(local: [string, T][], base: [string, T][], remote: [string, T][]): T[] {
  const localMap = new Map(local);
  const baseMap = new Map(base);
  const remoteMap = new Map(remote);
  const result = new Map(localMap);
  for (const [key, value] of remoteMap) {
    const before = baseMap.get(key);
    const mine = localMap.get(key);
    if (before === undefined) {
      if (mine === undefined) result.set(key, value);
    } else if (mine !== undefined && canonicalJson(mine) === canonicalJson(before)) {
      result.set(key, value);
    }
  }
  for (const [key, before] of baseMap) {
    if (remoteMap.has(key)) continue;
    const mine = localMap.get(key);
    if (mine !== undefined && canonicalJson(mine) === canonicalJson(before)) result.delete(key);
  }
  return [...result.values()];
}

function sortByName(folders: readonly FolderDoc[]): FolderDoc[] {
  return [...folders].sort((a, b) => a.name.localeCompare(b.name));
}

async function exists(root: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
}
