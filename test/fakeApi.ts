import type { GtmApi } from '../src/core/api';
import { KIND_ORDER, KIND_SPECS, VOLATILE_FIELDS, type EntityKind } from '../src/core/kinds';
import { canonicalJson } from '../src/core/serialize/canonical';
import {
  GtmError,
  workspacePath,
  type AccountInfo,
  type ApiChange,
  type ApiEntity,
  type ApiMergeConflict,
  type BulkEntity,
  type ContainerInfo,
  type EnvironmentInfo,
  type VersionHeader,
  type CreateVersionResult,
  type RemoteSnapshot,
  type SyncResult,
  type WorkspaceInfo,
  type WorkspaceRef,
  type WorkspaceStatus,
} from '../src/core/types';

type Contents = Record<EntityKind, ApiEntity[]>;

const emptyContents = (): Contents => Object.fromEntries(KIND_ORDER.map((kind) => [kind, []])) as unknown as Contents;

/** Entity content without the fields GTM owns, for "did this change" comparisons. */
function content(entity: ApiEntity | undefined): string | undefined {
  if (!entity) return undefined;
  return canonicalJson(Object.fromEntries(Object.entries(entity).filter(([key]) => !VOLATILE_FIELDS.includes(key))));
}

export const CONTAINER: ContainerInfo = {
  accountId: '100',
  containerId: '200',
  publicId: 'GTM-TEST123',
  name: 'Test container',
  usageContext: ['web'],
};

const BUILTIN_NAMES: Record<string, string> = { PAGE_URL: 'Page URL', PAGE_PATH: 'Page Path', EVENT: 'Event', CLICK_URL: 'Click URL' };

/** In-memory GTM workspace with fingerprints, ids and new_N resolution, enough to exercise every op. */
export class FakeGtm implements GtmApi {
  entities: Record<EntityKind, ApiEntity[]> = Object.fromEntries(KIND_ORDER.map((kind) => [kind, []])) as unknown as Record<EntityKind, ApiEntity[]>;
  builtIns = new Set<string>(['PAGE_URL', 'EVENT']);
  workspace: WorkspaceInfo = { accountId: '100', containerId: '200', workspaceId: '7', name: 'Default Workspace' };
  calls: string[] = [];
  versions: { id: string; name: string; published: boolean }[] = [];
  failBulk = false;
  /** Contents of every container version, by version id. */
  versionContents = new Map<string, Contents>();
  /** The container version this workspace is based on (what getStatus diffs against). */
  baseContents: Contents = emptyContents();
  baseVersionId?: string;
  mergeConflicts: ApiMergeConflict[] = [];
  /** Real GTM only creates a replacement workspace when the versioned one was the last; set false to mimic other workspaces existing. */
  replaceWorkspaceOnVersion = true;
  /** The mirrored workspace was deleted and nothing replaced it. */
  private workspaceGone = false;
  private nextId = 1000;
  private clock = 1;

  /** Treat the current contents as the published baseline (version 0), like a fresh workspace. */
  markBaseline(): void {
    this.baseContents = structuredClone(this.entities);
  }

  /**
   * Someone edits and publishes another workspace: a new container version that our
   * workspace does not have yet.
   */
  publishElsewhere(name: string, edit: (contents: Contents) => Contents): string {
    const latestId = this.versions.at(-1)?.id;
    const previous = latestId ? (this.versionContents.get(latestId) as Contents) : this.baseContents;
    const edited = edit(structuredClone(previous));
    const id = String(this.versions.length + 1);
    this.versions = [...this.versions, { id, name, published: true }];
    this.versionContents.set(id, edited);
    return id;
  }

  /** Stamp an entity for publishElsewhere (new fingerprint). */
  restamp(kind: EntityKind, entity: ApiEntity): ApiEntity {
    return this.stamp(kind, entity);
  }

  /** Someone creates a version from our workspace in the GTM UI: it is deleted and a new Default Workspace appears. */
  versionFromUi(): void {
    const id = String(this.versions.length + 1);
    this.versions = [...this.versions, { id, name: 'from UI', published: true }];
    this.versionContents.set(id, structuredClone(this.entities));
    this.baseContents = structuredClone(this.entities);
    this.baseVersionId = id;
    this.workspace = { ...this.workspace, workspaceId: String(this.nextId++), name: 'Default Workspace' };
  }
  seed(kind: EntityKind, entity: ApiEntity): ApiEntity {
    const created = this.stamp(kind, { ...entity, [KIND_SPECS[kind].idField]: entity[KIND_SPECS[kind].idField] ?? String(this.nextId++) });
    this.entities[kind] = [...this.entities[kind], created];
    return created;
  }

  find(kind: EntityKind, name: string): ApiEntity | undefined {
    return this.entities[kind].find((entity) => entity.name === name);
  }

  /** Simulate someone editing in the GTM UI. */
  remoteEdit(kind: EntityKind, name: string, patch: ApiEntity): void {
    this.entities[kind] = this.entities[kind].map((entity) => (entity.name === name ? this.stamp(kind, { ...entity, ...patch }) : entity));
  }

  async listAccounts(): Promise<AccountInfo[]> {
    return [{ accountId: '100', name: 'Test account' }];
  }

  async listContainers(): Promise<ContainerInfo[]> {
    return [CONTAINER];
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    this.calls.push('listWorkspaces');
    return this.workspaceGone ? [] : [this.workspace];
  }

  async createWorkspace(_a: string, _c: string, name: string): Promise<WorkspaceInfo> {
    this.calls.push(`createWorkspace ${name}`);
    this.workspaceGone = false;
    this.workspace = { ...this.workspace, workspaceId: String(this.nextId++), name };
    return this.workspace;
  }

  async getWorkspaceStatus(ref: WorkspaceRef): Promise<WorkspaceStatus> {
    this.assertWorkspace(ref);
    this.calls.push('status');
    const workspaceChange: ApiChange[] = [];
    for (const kind of KIND_ORDER) {
      const field = KIND_SPECS[kind].entityField;
      const base = new Map(this.baseContents[kind].map((entity) => [this.idOf(kind, entity), entity]));
      const mine = new Map(this.entities[kind].map((entity) => [this.idOf(kind, entity), entity]));
      for (const [id, entity] of mine) {
        if (!base.has(id)) workspaceChange.push({ changeStatus: 'added', [field]: structuredClone(entity) });
        else if (content(base.get(id)) !== content(entity)) workspaceChange.push({ changeStatus: 'updated', [field]: structuredClone(entity) });
      }
      for (const [id, entity] of base) if (!mine.has(id)) workspaceChange.push({ changeStatus: 'deleted', [field]: structuredClone(entity) });
    }
    return { workspaceChange, mergeConflict: structuredClone(this.mergeConflicts) };
  }

  async liveVersionId(): Promise<string | undefined> {
    this.calls.push('liveVersion');
    return [...this.versions].reverse().find((version) => version.published)?.id;
  }

  environments: EnvironmentInfo[] = [];
  compilerError = false;

  async listVersions(): Promise<VersionHeader[]> {
    this.calls.push('listVersions');
    return this.versions.map((version) => ({ versionId: version.id, name: version.name, deleted: false, counts: {} }));
  }

  async listEnvironments(): Promise<EnvironmentInfo[]> {
    this.calls.push('listEnvironments');
    return structuredClone(this.environments);
  }

  async quickPreview(ref: WorkspaceRef): Promise<{ compilerError: boolean; mergeConflict: boolean }> {
    this.assertWorkspace(ref);
    this.calls.push('quickPreview');
    if (!this.environments.some((env) => env.type === 'workspace' && env.workspaceId === this.workspace.workspaceId)) {
      this.environments = [...this.environments, { environmentId: '9', name: 'Workspace preview', type: 'workspace', authorizationCode: 'auth-preview', workspaceId: this.workspace.workspaceId }];
    }
    return { compilerError: this.compilerError, mergeConflict: this.mergeConflicts.length > 0 };
  }

  async latestVersionId(): Promise<string | undefined> {
    this.calls.push('latestVersion');
    return this.versions.at(-1)?.id;
  }

  /** Three-way: entities untouched in the workspace take the latest version; changed on both sides conflict. */
  async syncWorkspace(ref: WorkspaceRef): Promise<SyncResult> {
    this.assertWorkspace(ref);
    this.calls.push('sync');
    const latestId = this.versions.at(-1)?.id;
    if (!latestId || latestId === this.baseVersionId) return { mergeConflict: this.mergeConflicts.length > 0, syncError: false, conflicts: this.mergeConflicts };
    const latest = this.versionContents.get(latestId) as Contents;
    const conflicts: ApiMergeConflict[] = [];
    const next = emptyContents();
    for (const kind of KIND_ORDER) {
      const field = KIND_SPECS[kind].entityField;
      const maps = [this.baseContents[kind], this.entities[kind], latest[kind]].map((list) => new Map(list.map((entity) => [this.idOf(kind, entity), entity])));
      const [base, mine, theirs] = maps as [Map<string, ApiEntity>, Map<string, ApiEntity>, Map<string, ApiEntity>];
      for (const id of new Set([...base.keys(), ...mine.keys(), ...theirs.keys()])) {
        const changedHere = content(mine.get(id)) !== content(base.get(id));
        const changedThere = content(theirs.get(id)) !== content(base.get(id));
        const keep = changedThere && !changedHere ? theirs.get(id) : mine.get(id);
        if (keep) next[kind].push(this.stamp(kind, keep));
        if (changedHere && changedThere && content(mine.get(id)) !== content(theirs.get(id))) {
          const side = (entity: ApiEntity | undefined, fallback: ApiEntity | undefined): ApiChange => ({
            changeStatus: entity ? 'updated' : 'deleted',
            [field]: structuredClone(entity ?? fallback),
          });
          conflicts.push({ entityInWorkspace: side(mine.get(id), base.get(id)), entityInBaseVersion: side(theirs.get(id), base.get(id)) });
        }
      }
    }
    this.entities = next;
    // Re-read the conflicting workspace side so its fingerprint matches what resolve_conflict expects.
    this.mergeConflicts = conflicts.map((conflict) => {
      const side = conflict.entityInWorkspace as ApiChange;
      const kind = KIND_ORDER.find((item) => side[KIND_SPECS[item].entityField]) as EntityKind;
      const current = this.entities[kind].find((entity) => this.idOf(kind, entity) === this.idOf(kind, side[KIND_SPECS[kind].entityField] as ApiEntity));
      return current ? { ...conflict, entityInWorkspace: { ...side, [KIND_SPECS[kind].entityField]: structuredClone(current) } } : conflict;
    });
    this.baseContents = structuredClone(latest);
    this.baseVersionId = latestId;
    return { mergeConflict: conflicts.length > 0, syncError: false, conflicts: structuredClone(this.mergeConflicts) };
  }

  async resolveConflict(ref: WorkspaceRef, entity: ApiChange, fingerprint?: string): Promise<void> {
    this.assertWorkspace(ref);
    this.calls.push('resolveConflict');
    const kind = KIND_ORDER.find((item) => entity[KIND_SPECS[item].entityField]) as EntityKind;
    const body = entity[KIND_SPECS[kind].entityField] as ApiEntity;
    const id = this.idOf(kind, body);
    const index = this.mergeConflicts.findIndex((conflict) => {
      const side = conflict.entityInWorkspace?.[KIND_SPECS[kind].entityField] as ApiEntity | undefined;
      return side && this.idOf(kind, side) === id;
    });
    if (index < 0) throw new GtmError(`no merge conflict for ${kind} ${id}`, 400);
    const current = this.entities[kind].find((item) => this.idOf(kind, item) === id);
    if (fingerprint && current?.fingerprint !== fingerprint) throw new GtmError('fingerprint mismatch', 409);
    const others = this.entities[kind].filter((item) => this.idOf(kind, item) !== id);
    this.entities[kind] = entity.changeStatus === 'deleted' ? others : [...others, this.stamp(kind, body)];
    this.mergeConflicts = this.mergeConflicts.filter((_, i) => i !== index);
  }

  async getWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo> {
    this.assertWorkspace(ref);
    return this.workspace;
  }

  async fetchSnapshot(ref: WorkspaceRef, _usage?: readonly string[], only?: readonly EntityKind[]): Promise<RemoteSnapshot> {
    this.assertWorkspace(ref);
    const wanted = only ? new Set<EntityKind>([...only, 'folder']) : undefined;
    this.calls.push(wanted ? `snapshot ${[...wanted].join(',')}` : 'snapshot');
    const entities = structuredClone(this.entities);
    const unavailable = wanted ? KIND_ORDER.filter((kind) => !wanted.has(kind)) : [];
    for (const kind of unavailable) entities[kind] = [];
    return {
      entities,
      builtInVariables: [...this.builtIns].map((type) => ({ type, name: BUILTIN_NAMES[type] ?? type })),
      unavailable,
    };
  }

  async getEntity(ref: WorkspaceRef, kind: EntityKind, id: string): Promise<ApiEntity> {
    this.assertWorkspace(ref);
    this.calls.push(`get ${kind}`);
    return structuredClone(this.byId(kind, id));
  }

  async createEntity(ref: WorkspaceRef, kind: EntityKind, body: ApiEntity): Promise<ApiEntity> {
    this.assertWorkspace(ref);
    this.calls.push(`create ${kind}`);
    this.assertUniqueName(kind, body.name);
    return structuredClone(this.seed(kind, { ...body, [KIND_SPECS[kind].idField]: undefined }));
  }

  async updateEntity(ref: WorkspaceRef, kind: EntityKind, id: string, body: ApiEntity, fingerprint?: string): Promise<ApiEntity> {
    this.assertWorkspace(ref);
    this.calls.push(`update ${kind}`);
    const current = this.byId(kind, id);
    if (fingerprint && current.fingerprint !== fingerprint) throw new GtmError('fingerprint mismatch', 409);
    const updated = this.stamp(kind, { ...body, [KIND_SPECS[kind].idField]: id });
    this.entities[kind] = this.entities[kind].map((entity) => (String(entity[KIND_SPECS[kind].idField]) === id ? updated : entity));
    return structuredClone(updated);
  }

  async deleteEntity(ref: WorkspaceRef, kind: EntityKind, id: string): Promise<void> {
    this.assertWorkspace(ref);
    this.calls.push(`delete ${kind}`);
    this.byId(kind, id);
    this.entities[kind] = this.entities[kind].filter((entity) => String(entity[KIND_SPECS[kind].idField]) !== id);
  }

  async bulkUpdate(ref: WorkspaceRef, changes: readonly BulkEntity[]): Promise<Record<string, unknown>[]> {
    this.assertWorkspace(ref);
    this.calls.push(`bulk ${changes.length}`);
    if (this.failBulk) throw new GtmError('bulk_update failed (400): simulated', 400);
    const placeholders = new Map<string, string>();
    const resolve = (id: unknown) => (typeof id === 'string' && placeholders.has(id) ? placeholders.get(id) : id);
    const results: Record<string, unknown>[] = [];
    for (const change of changes) {
      const kind = KIND_ORDER.find((item) => change[KIND_SPECS[item].entityField] !== undefined) as EntityKind;
      const spec = KIND_SPECS[kind];
      const body = structuredClone(change[spec.entityField]) as ApiEntity;
      const fixed: ApiEntity = {
        ...body,
        ...(body.parentFolderId ? { parentFolderId: resolve(body.parentFolderId) } : {}),
        ...(Array.isArray(body.firingTriggerId) ? { firingTriggerId: body.firingTriggerId.map(resolve) } : {}),
        ...(Array.isArray(body.blockingTriggerId) ? { blockingTriggerId: body.blockingTriggerId.map(resolve) } : {}),
      };
      const id = String(body[spec.idField]);
      if (change.changeStatus === 'added') {
        if (!/^new_\d+$/.test(id)) throw new GtmError(`bad new id ${id}`, 400);
        this.assertUniqueName(kind, fixed.name);
        const created = this.seed(kind, { ...fixed, [spec.idField]: undefined });
        placeholders.set(id, String(created[spec.idField]));
        results.push({ changeStatus: 'added', [spec.entityField]: structuredClone(created) });
      } else if (change.changeStatus === 'updated') {
        const current = this.byId(kind, id);
        if (fixed.fingerprint && current.fingerprint !== fixed.fingerprint) throw new GtmError('fingerprint mismatch', 409);
        const updated = this.stamp(kind, { ...fixed, [spec.idField]: id });
        this.entities[kind] = this.entities[kind].map((entity) => (String(entity[spec.idField]) === id ? updated : entity));
        results.push({ changeStatus: 'updated', [spec.entityField]: structuredClone(updated) });
      } else {
        this.byId(kind, id);
        // Real GTM validates the whole entity on delete (live-tested 2026-10-12).
        if (['tag', 'trigger', 'variable'].includes(kind) && !body.type) throw new GtmError(`${kind}.type: must have a type`, 400);
        this.entities[kind] = this.entities[kind].filter((entity) => String(entity[spec.idField]) !== id);
      }
    }
    return results;
  }

  async enableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void> {
    this.assertWorkspace(ref);
    this.calls.push(`enable ${types.join(',')}`);
    for (const type of types) this.builtIns.add(type);
  }

  async disableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void> {
    this.assertWorkspace(ref);
    this.calls.push(`disable ${types.join(',')}`);
    for (const type of types) this.builtIns.delete(type);
  }

  async createVersion(ref: WorkspaceRef, name: string): Promise<CreateVersionResult> {
    this.assertWorkspace(ref);
    this.calls.push('createVersion');
    if (this.mergeConflicts.length) return { compilerError: false, syncStatus: { mergeConflict: true } };
    const id = String(this.versions.length + 1);
    this.versions = [...this.versions, { id, name, published: false }];
    this.versionContents.set(id, structuredClone(this.entities));
    this.baseContents = structuredClone(this.entities);
    this.baseVersionId = id;
    this.workspace = { ...this.workspace, workspaceId: String(this.nextId++), name: 'Default Workspace' };
    if (!this.replaceWorkspaceOnVersion) {
      this.workspaceGone = true;
      return { containerVersionId: id, compilerError: false };
    }
    this.entities = Object.fromEntries(
      KIND_ORDER.map((kind) => [kind, this.entities[kind].map((entity) => this.stamp(kind, entity))]),
    ) as unknown as Record<EntityKind, ApiEntity[]>;
    return { containerVersionId: id, compilerError: false, newWorkspacePath: workspacePath(this.workspace) };
  }

  async publishVersion(_accountId: string, _containerId: string, versionId: string): Promise<{ compilerError: boolean }> {
    this.calls.push(`publish ${versionId}`);
    this.versions = this.versions.map((version) => (version.id === versionId ? { ...version, published: true } : version));
    return { compilerError: false };
  }

  private stamp(kind: EntityKind, entity: ApiEntity): ApiEntity {
    const { fingerprint: _fp, ...rest } = entity;
    return {
      ...rest,
      accountId: '100',
      containerId: '200',
      workspaceId: this.workspace.workspaceId,
      path: `${workspacePath(this.workspace)}/${KIND_SPECS[kind].collection}/${String(entity[KIND_SPECS[kind].idField])}`,
      fingerprint: String(this.clock++),
    };
  }

  private idOf(kind: EntityKind, entity: ApiEntity): string {
    return String(entity[KIND_SPECS[kind].idField]);
  }

  private byId(kind: EntityKind, id: string): ApiEntity {
    const found = this.entities[kind].find((entity) => String(entity[KIND_SPECS[kind].idField]) === id);
    if (!found) throw new GtmError(`${kind} ${id} not found`, 404);
    return found;
  }

  private assertUniqueName(kind: EntityKind, name: unknown): void {
    if (this.entities[kind].some((entity) => entity.name === name)) throw new GtmError(`duplicate ${kind} name ${String(name)}`, 400);
  }

  private assertWorkspace(ref: WorkspaceRef): void {
    if (this.workspaceGone) throw new GtmError(`workspace ${ref.workspaceId} not found`, 404);
    if (ref.workspaceId !== this.workspace.workspaceId) throw new GtmError(`workspace ${ref.workspaceId} not found`, 404);
  }
}

/** A small but realistic web container. */
export function seededFake(): FakeGtm {
  const gtm = new FakeGtm();
  gtm.seed('folder', { folderId: '1', name: 'GA4' });
  gtm.seed('template', {
    templateId: '50',
    name: 'Hash Email',
    templateData: '___INFO___\n\n{\n  "type": "MACRO"\n}\n\n\n___TEMPLATE_PARAMETERS___\n\n[]\n\n\n___SANDBOXED_JS_FOR_WEB_TEMPLATE___\n\nreturn data.email;\n\n\n___NOTES___\n\n\n\n\n',
  });
  gtm.seed('variable', { variableId: '10', name: 'DL - user_id', type: 'v', parameter: [{ type: 'template', key: 'name', value: 'user_id' }] });
  gtm.seed('variable', { variableId: '11', name: 'cJS - page type', type: 'jsm', parameter: [{ type: 'template', key: 'javascript', value: 'function() {\n  return "home";\n}' }] });
  gtm.seed('variable', { variableId: '12', name: 'Hashed email', type: 'cvt_200_50', parameter: [] });
  gtm.seed('trigger', { triggerId: '20', name: 'CE - purchase', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ type: 'template', key: 'arg0', value: '{{_event}}' }, { type: 'template', key: 'arg1', value: 'purchase' }] }] });
  gtm.seed('trigger', { triggerId: '21', name: 'TG - purchase group', type: 'triggerGroup', parameter: [{ type: 'list', key: 'triggerIds', list: [{ type: 'triggerReference', value: '20' }] }] });
  gtm.seed('tag', { tagId: '30', name: 'GA4 - purchase', type: 'gaawe', parentFolderId: '1', firingTriggerId: ['20'], parameter: [{ type: 'template', key: 'eventName', value: 'purchase' }, { type: 'template', key: 'userId', value: '{{DL - user_id}}' }] });
  gtm.seed('tag', { tagId: '31', name: 'cHTML - hello', type: 'html', firingTriggerId: ['2147479553'], parameter: [{ type: 'template', key: 'html', value: '<script>\n  console.log("hi");\n</script>' }] });
  gtm.markBaseline();
  return gtm;
}
