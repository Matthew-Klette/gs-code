import type { GtmApi } from '../src/core/api';
import { KIND_ORDER, KIND_SPECS, type EntityKind } from '../src/core/kinds';
import {
  GtmError,
  workspacePath,
  type AccountInfo,
  type ApiEntity,
  type BulkEntity,
  type ContainerInfo,
  type CreateVersionResult,
  type RemoteSnapshot,
  type WorkspaceInfo,
  type WorkspaceRef,
} from '../src/core/types';

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
  private nextId = 1000;
  private clock = 1;

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
    return [this.workspace];
  }

  async createWorkspace(_a: string, _c: string, name: string): Promise<WorkspaceInfo> {
    this.workspace = { ...this.workspace, workspaceId: String(this.nextId++), name };
    return this.workspace;
  }

  async getWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo> {
    this.assertWorkspace(ref);
    return this.workspace;
  }

  async fetchSnapshot(ref: WorkspaceRef): Promise<RemoteSnapshot> {
    this.assertWorkspace(ref);
    this.calls.push('snapshot');
    return {
      entities: structuredClone(this.entities),
      builtInVariables: [...this.builtIns].map((type) => ({ type, name: BUILTIN_NAMES[type] ?? type })),
    };
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
    const id = String(this.versions.length + 1);
    this.versions = [...this.versions, { id, name, published: false }];
    this.workspace = { ...this.workspace, workspaceId: String(this.nextId++), name: 'Default Workspace' };
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

  private byId(kind: EntityKind, id: string): ApiEntity {
    const found = this.entities[kind].find((entity) => String(entity[KIND_SPECS[kind].idField]) === id);
    if (!found) throw new GtmError(`${kind} ${id} not found`, 404);
    return found;
  }

  private assertUniqueName(kind: EntityKind, name: unknown): void {
    if (this.entities[kind].some((entity) => entity.name === name)) throw new GtmError(`duplicate ${kind} name ${String(name)}`, 400);
  }

  private assertWorkspace(ref: WorkspaceRef): void {
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
  gtm.seed('variable', { variableId: '10', name: 'DL - user_id', type: 'v', parameter: [{ type: 'TEMPLATE', key: 'name', value: 'user_id' }] });
  gtm.seed('variable', { variableId: '11', name: 'cJS - page type', type: 'jsm', parameter: [{ type: 'TEMPLATE', key: 'javascript', value: 'function() {\n  return "home";\n}' }] });
  gtm.seed('variable', { variableId: '12', name: 'Hashed email', type: 'cvt_200_50', parameter: [] });
  gtm.seed('trigger', { triggerId: '20', name: 'CE - purchase', type: 'customEvent', customEventFilter: [{ type: 'equals', parameter: [{ type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' }, { type: 'TEMPLATE', key: 'arg1', value: 'purchase' }] }] });
  gtm.seed('trigger', { triggerId: '21', name: 'TG - purchase group', type: 'triggerGroup', parameter: [{ type: 'LIST', key: 'triggerIds', list: [{ type: 'TRIGGER_REFERENCE', value: '20' }] }] });
  gtm.seed('tag', { tagId: '30', name: 'GA4 - purchase', type: 'gaawe', parentFolderId: '1', firingTriggerId: ['20'], parameter: [{ type: 'TEMPLATE', key: 'eventName', value: 'purchase' }, { type: 'TEMPLATE', key: 'userId', value: '{{DL - user_id}}' }] });
  gtm.seed('tag', { tagId: '31', name: 'cHTML - hello', type: 'html', firingTriggerId: ['2147479553'], parameter: [{ type: 'TEMPLATE', key: 'html', value: '<script>\n  console.log("hi");\n</script>' }] });
  return gtm;
}
