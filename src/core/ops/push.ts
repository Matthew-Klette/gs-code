import type { GtmApi } from '../api';
import { KIND_ORDER, KIND_SPECS, type EntityKind } from '../kinds';
import { countChanges, isEmpty, type ChangeSet, type EntityChange, type FolderChange } from '../mirror/diff';
import { entityLabel } from '../mirror/layout';
import type { Overlay } from '../mirror/model';
import { entityKey, writeState, type MirrorState } from '../mirror/state';
import { docName, toApiBody, type EntityDoc } from '../serialize/entityFiles';
import { collectTriggerReferences, templateType, type IdLookup } from '../serialize/references';
import { GtmError, type ApiEntity, type BulkEntity, type RemoteSnapshot } from '../types';
import { workingStatus } from './plan';
import { applySnapshot, type PullResult } from './pull';
import { refreshMirror, statusSignature, type RefreshResult } from './sync';

export type PushStrategy = 'bulk' | 'sequential';

export interface PushOptions {
  readonly strategy?: PushStrategy;
  readonly onProgress?: (message: string) => void;
  /** Unsaved editor buffers, so the pre-push refresh never overwrites them. */
  readonly overlay?: Overlay;
}

export interface PushResult {
  readonly pushed: number;
  /** The pull that ran before pushing, when GTM had changed. */
  readonly before?: RefreshResult;
  readonly refresh?: PullResult;
}

export class PushBlockedError extends GtmError {
  constructor(
    message: string,
    readonly reasons: readonly string[],
  ) {
    super(`${message}\n${reasons.map((reason) => `  • ${reason}`).join('\n')}`);
    this.name = 'PushBlockedError';
  }
}

interface MutableLookup {
  readonly triggerIds: Map<string, string>;
  readonly folderIds: Map<string, string>;
  readonly templateTypes: Map<string, string>;
}

interface Applied {
  readonly forced: Set<string>;
  readonly hints: Map<string, string>;
}

/**
 * Pull first (cheap when GTM is unchanged), stop on any conflict, then push.
 * Remote-only changes are merged in before anything is sent, so a push never undoes them.
 */
export async function pushWorkspace(root: string, api: GtmApi, initial: MirrorState, options: PushOptions = {}): Promise<PushResult> {
  const progress = options.onProgress ?? (() => undefined);
  assertReady(await workingStatus(root, initial), initial);
  if (isEmpty((await workingStatus(root, initial)).changes)) return { pushed: 0 };

  progress('Checking GTM for changes before pushing…');
  const pulled = await refreshMirror(root, api, initial, { overlay: options.overlay, onProgress: progress });
  const state = pulled.state;
  const status = await workingStatus(root, state);
  if (state.conflicts.length || state.gtmConflicts.length) {
    throw new PushBlockedError('GTM had changes that conflict with yours. Nothing was pushed. Resolve these, then Push again:', [
      ...state.conflicts.map((base) => `${base}: changed locally and in GTM (Keep Mine / Take Theirs)`),
      ...state.gtmConflicts.map((item) => `${item.base}: GTM merge conflict with the latest version (Keep Workspace / Take Latest)`),
    ]);
  }
  assertReady(status, state);
  if (isEmpty(status.changes)) return { pushed: 0, before: pulled };

  progress('Checking GTM for changes made since your last pull…');
  const before = await api.fetchSnapshot(state.workspace, state.container.usageContext);
  const conflicts = remoteConflicts(status.changes, state, before);
  if (conflicts.length) throw new PushBlockedError('GTM changed since your last pull. Run Pull, resolve, then Push again:', conflicts);

  const lookup = buildLookup(status.local.docs, status.changes, state, before);
  const applied: Applied = { forced: new Set(), hints: new Map() };
  const total = countChanges(status.changes);
  let failure: unknown;
  try {
    if ((options.strategy ?? 'bulk') === 'bulk') await pushBulk(api, state, status.changes, lookup, applied, progress, before);
    else await pushSequential(api, state, status.changes, lookup, applied, progress);
  } catch (error: unknown) {
    failure = error;
  }

  progress('Refreshing from GTM…');
  // Status before snapshot: a change landing in between is picked up by the next check.
  const remoteStatus = await api.getWorkspaceStatus(state.workspace);
  const after = await api.fetchSnapshot(state.workspace, state.container.usageContext);
  const applied_ = await applySnapshot(root, state, after, { forceRemote: applied.forced, pathHints: applied.hints, adoptPushed: true, overlay: options.overlay });
  const refreshed: MirrorState = { ...applied_.state, remote: { ...state.remote, status: statusSignature(remoteStatus) } };
  await writeState(root, refreshed);
  const refresh = { ...applied_, state: refreshed };
  if (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new GtmError(`Push stopped: ${message}\nAnything already applied is now in sync; the rest is still a local change.`);
  }
  return { pushed: total, before: pulled, refresh };
}

function assertReady(status: Awaited<ReturnType<typeof workingStatus>>, state: MirrorState): void {
  assertPushable(
    status.problems.map((problem) => `${problem.path}: ${problem.message}`),
    status.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}: ${issue.message}`),
    state.conflicts,
  );
}

function assertPushable(problems: string[], errors: string[], conflicts: readonly string[]): void {
  const reasons = [
    ...problems,
    ...errors,
    ...conflicts.map((base) => `${base}: unresolved conflict (Keep Mine / Take Theirs)`),
  ];
  if (reasons.length) throw new PushBlockedError('Push blocked:', reasons);
}

/** Entities this push touches whose remote fingerprint moved since the last pull. */
export function remoteConflicts(changes: ChangeSet, state: MirrorState, snapshot: RemoteSnapshot): string[] {
  const remoteFp = new Map<string, string | undefined>();
  for (const kind of KIND_ORDER) {
    for (const entity of snapshot.entities[kind]) {
      remoteFp.set(entityKey(kind, String(entity[KIND_SPECS[kind].idField])), entity.fingerprint);
    }
  }
  const reasons: string[] = [];
  for (const change of changes.entities) {
    if (change.type === 'added' || !change.id) continue;
    const indexed = state.entities[change.previousBase ?? change.base];
    const key = entityKey(change.kind, change.id);
    if (!remoteFp.has(key)) reasons.push(`${change.base}: deleted in GTM`);
    else if (indexed?.fingerprint && remoteFp.get(key) !== indexed.fingerprint) reasons.push(`${change.base}: changed in GTM`);
  }
  for (const change of changes.folders) {
    if (change.type === 'added' || !change.id) continue;
    const fp = remoteFp.get(entityKey('folder', change.id));
    if (!remoteFp.has(entityKey('folder', change.id))) reasons.push(`folder "${change.name}": deleted in GTM`);
    else if (state.folders[change.name]?.fingerprint && fp !== state.folders[change.name]?.fingerprint) reasons.push(`folder "${change.name}": changed in GTM`);
  }
  return reasons;
}

function idForDoc(doc: EntityDoc, changes: ChangeSet, state: MirrorState): string | undefined {
  const change = changes.entities.find((item) => item.base === doc.base && item.kind === doc.kind);
  if (change) return change.id;
  return state.entities[doc.base]?.id;
}

function buildLookup(docs: ReadonlyMap<string, EntityDoc>, changes: ChangeSet, state: MirrorState, snapshot: RemoteSnapshot): MutableLookup {
  const triggerIds = new Map<string, string>();
  const templateTypes = new Map<string, string>();
  const remoteTemplates = new Map(snapshot.entities.template.map((template) => [String(template.templateId), template]));
  for (const doc of docs.values()) {
    const name = docName(doc);
    const id = idForDoc(doc, changes, state);
    if (!name || !id) continue;
    if (doc.kind === 'trigger') triggerIds.set(name, id);
    if (doc.kind === 'template') {
      const remote = remoteTemplates.get(id);
      if (remote) templateTypes.set(name, templateType(state.container.containerId, remote));
    }
  }
  const folderIds = new Map(Object.entries(state.folders).map(([name, entry]) => [name, entry.id]));
  return { triggerIds, folderIds, templateTypes };
}

function bodyFor(change: EntityChange, lookup: IdLookup, extra: ApiEntity): ApiEntity {
  const doc = change.local as EntityDoc;
  const { body, unresolved } = toApiBody(doc, lookup);
  if (unresolved.length) {
    const detail = unresolved.map((item) => `${item.field} "${item.ref}"`).join(', ');
    throw new GtmError(`${change.base}: cannot resolve ${detail}`);
  }
  return { ...body, ...extra };
}

function idPatch(kind: EntityKind, id: string, fingerprint?: string): ApiEntity {
  return { [KIND_SPECS[kind].idField]: id, ...(fingerprint ? { fingerprint } : {}) };
}

function fingerprintOf(change: EntityChange, state: MirrorState): string | undefined {
  return state.entities[change.previousBase ?? change.base]?.fingerprint;
}

function markApplied(applied: Applied, kind: EntityKind, id: string, base: string): void {
  const key = entityKey(kind, id);
  applied.forced.add(key);
  applied.hints.set(key, base);
}

async function createTemplates(api: GtmApi, state: MirrorState, changes: ChangeSet, lookup: MutableLookup, applied: Applied, progress: (m: string) => void) {
  for (const change of changes.entities.filter((item) => item.kind === 'template' && item.type === 'added')) {
    progress(`Creating ${entityLabel('template', docName(change.local as EntityDoc))}…`);
    const created = await api.createEntity(state.workspace, 'template', bodyFor(change, lookup, {}));
    lookup.templateTypes.set(String(created.name), templateType(state.container.containerId, created));
    markApplied(applied, 'template', String(created.templateId), change.base);
  }
}

// ---------------------------------------------------------------- bulk

async function pushBulk(
  api: GtmApi,
  state: MirrorState,
  changes: ChangeSet,
  lookup: MutableLookup,
  applied: Applied,
  progress: (m: string) => void,
  before: RemoteSnapshot,
): Promise<void> {
  const ref = state.workspace;
  // bulk_update validates the whole entity even for deletes, so send GTM's own current copy.
  const current = (kind: EntityKind, id: string): ApiEntity =>
    before.entities[kind].find((entity) => String(entity[KIND_SPECS[kind].idField]) === id) ?? idPatch(kind, id);
  await createTemplates(api, state, changes, lookup, applied, progress);
  if (changes.builtIns.enable.length) {
    progress(`Enabling built-in variables: ${changes.builtIns.enable.join(', ')}`);
    await api.enableBuiltIns(ref, changes.builtIns.enable);
  }

  let counter = 0;
  const placeholder = () => `new_${++counter}`;
  const addedFolders = changes.folders.filter((change) => change.type === 'added').map((change) => ({ change, id: placeholder() }));
  for (const { change, id } of addedFolders) lookup.folderIds.set(change.name, id);
  const addedEntities = changes.entities
    .filter((change) => change.type === 'added' && change.kind !== 'template')
    .map((change) => ({ change, id: placeholder() }));
  for (const { change, id } of addedEntities) {
    if (change.kind === 'trigger') lookup.triggerIds.set(docName(change.local as EntityDoc) ?? '', id);
  }

  const bulk: BulkEntity[] = [
    ...addedFolders.map(({ change, id }) => folderEntity('added', change, id)),
    ...changes.folders.filter((c) => c.type === 'updated').map((change) => folderEntity('updated', change, change.id as string, state.folders[change.name]?.fingerprint)),
    ...addedEntities.map(({ change, id }) => entityEntry('added', change.kind, bodyFor(change, lookup, idPatch(change.kind, id)))),
    ...changes.entities
      .filter((change) => change.type === 'updated')
      .map((change) => entityEntry('updated', change.kind, bodyFor(change, lookup, idPatch(change.kind, change.id as string, fingerprintOf(change, state))))),
    ...changes.entities
      .filter((change) => change.type === 'deleted')
      .map((change) => entityEntry('deleted', change.kind, current(change.kind, change.id as string))),
    ...changes.folders.filter((c) => c.type === 'deleted').map((change) => entityEntry('deleted', 'folder', current('folder', change.id as string))),
  ];

  if (bulk.length) {
    progress(`Sending ${bulk.length} change(s) in one bulk update…`);
    const response = await api.bulkUpdate(ref, bulk);
    recordBulkResults(response, changes, addedEntities, applied);
  }

  if (changes.builtIns.disable.length) {
    progress(`Disabling built-in variables: ${changes.builtIns.disable.join(', ')}`);
    await api.disableBuiltIns(ref, changes.builtIns.disable);
  }
}

function entityEntry(changeStatus: BulkEntity['changeStatus'], kind: EntityKind, body: ApiEntity): BulkEntity {
  return { changeStatus, [KIND_SPECS[kind].entityField]: body };
}

function folderEntity(changeStatus: BulkEntity['changeStatus'], change: FolderChange, id: string, fingerprint?: string): BulkEntity {
  const body = changeStatus === 'deleted' ? { name: change.name } : { ...change.local, name: change.name };
  return entityEntry(changeStatus, 'folder', { ...body, ...idPatch('folder', id, fingerprint) });
}

function recordBulkResults(
  response: readonly Record<string, unknown>[],
  changes: ChangeSet,
  added: readonly { change: EntityChange; id: string }[],
  applied: Applied,
): void {
  const returned = new Map<string, string>();
  for (const entry of response) {
    for (const kind of KIND_ORDER) {
      const entity = entry[KIND_SPECS[kind].entityField] as ApiEntity | undefined;
      if (entity?.name !== undefined) returned.set(`${kind}\u0000${entity.name}`, String(entity[KIND_SPECS[kind].idField]));
    }
  }
  for (const { change } of added) {
    const id = returned.get(`${change.kind}\u0000${docName(change.local as EntityDoc)}`);
    if (id) markApplied(applied, change.kind, id, change.base);
  }
  for (const change of changes.entities.filter((item) => item.type === 'updated')) {
    markApplied(applied, change.kind, change.id as string, change.base);
  }
}

// ---------------------------------------------------------------- sequential

async function pushSequential(
  api: GtmApi,
  state: MirrorState,
  changes: ChangeSet,
  lookup: MutableLookup,
  applied: Applied,
  progress: (m: string) => void,
): Promise<void> {
  const ref = state.workspace;
  if (changes.builtIns.enable.length) await api.enableBuiltIns(ref, changes.builtIns.enable);

  for (const change of changes.folders.filter((item) => item.type !== 'deleted')) {
    progress(`${change.type === 'added' ? 'Creating' : 'Updating'} folder "${change.name}"…`);
    const body = { ...change.local, name: change.name };
    const result = change.type === 'added'
      ? await api.createEntity(ref, 'folder', body)
      : await api.updateEntity(ref, 'folder', change.id as string, { ...body, folderId: change.id }, state.folders[change.name]?.fingerprint);
    lookup.folderIds.set(change.name, String(result.folderId));
  }

  await createTemplates(api, state, changes, lookup, applied, progress);

  for (const kind of KIND_ORDER) {
    const writes = changes.entities.filter((item) => item.kind === kind && item.type !== 'deleted' && !(kind === 'template' && item.type === 'added'));
    for (const change of orderTriggerGroupsLast(writes)) {
      const label = entityLabel(kind, docName(change.local as EntityDoc));
      if (change.type === 'added') {
        progress(`Creating ${label}…`);
        const created = await api.createEntity(ref, kind, bodyFor(change, lookup, {}));
        const id = String(created[KIND_SPECS[kind].idField]);
        if (kind === 'trigger') lookup.triggerIds.set(String(created.name), id);
        markApplied(applied, kind, id, change.base);
      } else {
        progress(`Updating ${label}…`);
        const id = change.id as string;
        await api.updateEntity(ref, kind, id, bodyFor(change, lookup, idPatch(kind, id)), fingerprintOf(change, state));
        markApplied(applied, kind, id, change.base);
      }
    }
  }

  for (const kind of [...KIND_ORDER].reverse()) {
    for (const change of changes.entities.filter((item) => item.kind === kind && item.type === 'deleted')) {
      progress(`Deleting ${entityLabel(kind, docName(change.original as EntityDoc))}…`);
      await api.deleteEntity(ref, kind, change.id as string);
    }
  }
  for (const change of changes.folders.filter((item) => item.type === 'deleted')) {
    progress(`Deleting folder "${change.name}"…`);
    await api.deleteEntity(ref, 'folder', change.id as string);
  }
  if (changes.builtIns.disable.length) await api.disableBuiltIns(ref, changes.builtIns.disable);
}

/** Trigger groups reference other triggers, so create them after plain triggers. */
function orderTriggerGroupsLast(changes: readonly EntityChange[]): EntityChange[] {
  const isGroup = (change: EntityChange) => collectTriggerReferences(change.local?.data.parameter).length > 0;
  return [...changes.filter((change) => !isGroup(change)), ...changes.filter(isGroup)];
}
