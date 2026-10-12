import { KIND_ORDER, type EntityKind } from '../kinds';
import { canonicalJson } from '../serialize/canonical';
import { docName, type EntityDoc } from '../serialize/entityFiles';
import type { FolderDoc, MirrorModel } from './model';
import { sameDoc } from './model';
import type { MirrorState } from './state';

export type ChangeType = 'added' | 'updated' | 'deleted';

export interface EntityChange {
  readonly type: ChangeType;
  readonly kind: EntityKind;
  /** Base path in the working tree (added/updated) or in `.gtm/base` (deleted). */
  readonly base: string;
  /** Base path in `.gtm/base` when the file was renamed locally. */
  readonly previousBase?: string;
  readonly id?: string;
  readonly local?: EntityDoc;
  readonly original?: EntityDoc;
}

export interface FolderChange {
  readonly type: ChangeType;
  readonly name: string;
  readonly id?: string;
  readonly local?: FolderDoc;
}

export interface ChangeSet {
  readonly entities: readonly EntityChange[];
  readonly folders: readonly FolderChange[];
  readonly builtIns: { readonly enable: readonly string[]; readonly disable: readonly string[] };
}

export function isEmpty(changes: ChangeSet): boolean {
  return (
    changes.entities.length === 0 &&
    changes.folders.length === 0 &&
    changes.builtIns.enable.length === 0 &&
    changes.builtIns.disable.length === 0
  );
}

export function countChanges(changes: ChangeSet): number {
  return changes.entities.length + changes.folders.length + changes.builtIns.enable.length + changes.builtIns.disable.length;
}

/**
 * Identity of exactly what a push would send. The confirmation dialog shows one change set; if
 * anything (an agent, another window) edits files before the push runs, this no longer matches.
 */
export function changeSignature(changes: ChangeSet): string {
  return canonicalJson({
    entities: changes.entities.map((change) => [change.type, change.kind, change.base, change.previousBase ?? null, change.local ? canonicalJson(change.local.data) : null]),
    folders: changes.folders.map((change) => [change.type, change.name, change.local ? canonicalJson(change.local) : null]),
    builtIns: changes.builtIns,
  });
}

/** Working tree vs `.gtm/base`, i.e. everything Push would send. */
export function diffModels(local: MirrorModel, base: MirrorModel, state: MirrorState): ChangeSet {
  return {
    entities: KIND_ORDER.flatMap((kind) => diffKind(kind, local, base, state)),
    folders: diffFolders(local.folders, base.folders, state),
    builtIns: diffBuiltIns(local.builtIns, base.builtIns),
  };
}

function docsOfKind(model: MirrorModel, kind: EntityKind): Map<string, EntityDoc> {
  return new Map([...model.docs].filter(([, doc]) => doc.kind === kind));
}

function diffKind(kind: EntityKind, localModel: MirrorModel, baseModel: MirrorModel, state: MirrorState): EntityChange[] {
  const local = docsOfKind(localModel, kind);
  const base = docsOfKind(baseModel, kind);
  const changes: EntityChange[] = [];
  const idOf = (path: string) => state.entities[path]?.id;

  for (const [path, doc] of local) {
    const original = base.get(path);
    if (original && !sameDoc(doc, original)) changes.push({ type: 'updated', kind, base: path, id: idOf(path), local: doc, original });
  }

  // A file renamed on disk keeps its identity when the entity name still matches.
  const orphanLocal = [...local.values()].filter((doc) => !base.has(doc.base));
  const orphanBase = new Map([...base.values()].filter((doc) => !local.has(doc.base)).map((doc) => [docName(doc) ?? doc.base, doc]));
  for (const doc of orphanLocal) {
    const name = docName(doc);
    const original = name === undefined ? undefined : orphanBase.get(name);
    if (original) {
      orphanBase.delete(name as string);
      changes.push({ type: 'updated', kind, base: doc.base, previousBase: original.base, id: idOf(original.base), local: doc, original });
    } else {
      changes.push({ type: 'added', kind, base: doc.base, local: doc });
    }
  }
  for (const original of orphanBase.values()) {
    changes.push({ type: 'deleted', kind, base: original.base, id: idOf(original.base), original });
  }
  return changes;
}

function diffFolders(local: readonly FolderDoc[], base: readonly FolderDoc[], state: MirrorState): FolderChange[] {
  const localByName = new Map(local.map((folder) => [folder.name, folder]));
  const baseByName = new Map(base.map((folder) => [folder.name, folder]));
  const changes: FolderChange[] = [];
  for (const [name, folder] of localByName) {
    const original = baseByName.get(name);
    if (!original) changes.push({ type: 'added', name, local: folder });
    else if (canonicalJson(folder) !== canonicalJson(original)) changes.push({ type: 'updated', name, id: state.folders[name]?.id, local: folder });
  }
  for (const name of baseByName.keys()) {
    if (!localByName.has(name)) changes.push({ type: 'deleted', name, id: state.folders[name]?.id });
  }
  return changes;
}

function diffBuiltIns(local: readonly string[], base: readonly string[]): ChangeSet['builtIns'] {
  const localSet = new Set(local);
  const baseSet = new Set(base);
  return {
    enable: [...localSet].filter((type) => !baseSet.has(type)).sort(),
    disable: [...baseSet].filter((type) => !localSet.has(type)).sort(),
  };
}
