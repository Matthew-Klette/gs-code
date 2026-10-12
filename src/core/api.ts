import { KIND_ORDER, KIND_SPECS, SERVER_ONLY_KINDS, type EntityKind } from './kinds';
import { backoffDelay, DEFAULT_RETRY, RateLimiter, systemClock, type Clock, type RetryPolicy } from './rateLimiter';
import {
  GtmError,
  workspacePath,
  type AccountInfo,
  type ApiEntity,
  type BuiltInVariable,
  type BulkEntity,
  type ContainerInfo,
  type CreateVersionResult,
  type ApiChange,
  type ApiMergeConflict,
  type RemoteSnapshot,
  type SyncResult,
  type WorkspaceInfo,
  type WorkspaceStatus,
  type WorkspaceRef,
} from './types';

const BASE_URL = 'https://tagmanager.googleapis.com/tagmanager/v2';

/** Kinds whose list call may legitimately fail on some containers (server-only, 360-only). */
const OPTIONAL_KINDS: ReadonlySet<EntityKind> = new Set(['client', 'transformation', 'zone', 'gtagConfig']);

export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

export interface GtmApi {
  listAccounts(): Promise<AccountInfo[]>;
  listContainers(accountId: string): Promise<ContainerInfo[]>;
  listWorkspaces(accountId: string, containerId: string): Promise<WorkspaceInfo[]>;
  createWorkspace(accountId: string, containerId: string, name: string, description?: string): Promise<WorkspaceInfo>;
  getWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo>;
  /** One cheap call that changes whenever any entity in the workspace changes. */
  getWorkspaceStatus(ref: WorkspaceRef): Promise<WorkspaceStatus>;
  /** Id of the newest container version (published or not), if any. */
  latestVersionId(accountId: string, containerId: string): Promise<string | undefined>;
  /** Bring the workspace up to the latest container version. */
  syncWorkspace(ref: WorkspaceRef): Promise<SyncResult>;
  resolveConflict(ref: WorkspaceRef, entity: ApiChange, fingerprint?: string): Promise<void>;
  fetchSnapshot(ref: WorkspaceRef, usageContext?: readonly string[]): Promise<RemoteSnapshot>;
  createEntity(ref: WorkspaceRef, kind: EntityKind, body: ApiEntity): Promise<ApiEntity>;
  updateEntity(ref: WorkspaceRef, kind: EntityKind, id: string, body: ApiEntity, fingerprint?: string): Promise<ApiEntity>;
  deleteEntity(ref: WorkspaceRef, kind: EntityKind, id: string): Promise<void>;
  bulkUpdate(ref: WorkspaceRef, changes: readonly BulkEntity[]): Promise<Record<string, unknown>[]>;
  enableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void>;
  disableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void>;
  createVersion(ref: WorkspaceRef, name: string, notes: string): Promise<CreateVersionResult>;
  publishVersion(accountId: string, containerId: string, versionId: string): Promise<{ compilerError: boolean }>;
}

export interface HttpApiOptions {
  readonly limiter?: RateLimiter;
  readonly retry?: RetryPolicy;
  readonly clock?: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class HttpGtmApi implements GtmApi {
  private readonly limiter: RateLimiter;
  private readonly retry: RetryPolicy;
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly tokens: TokenProvider,
    private readonly options: HttpApiOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? new RateLimiter(undefined, undefined, this.clock);
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listAccounts(): Promise<AccountInfo[]> {
    const items = await this.listAll('accounts', 'account');
    return items.map((item) => ({ accountId: String(item.accountId), name: String(item.name) }));
  }

  async listContainers(accountId: string): Promise<ContainerInfo[]> {
    const items = await this.listAll(`accounts/${accountId}/containers`, 'container');
    return items.map((item) => ({
      accountId: String(item.accountId),
      containerId: String(item.containerId),
      publicId: String(item.publicId),
      name: String(item.name),
      usageContext: Array.isArray(item.usageContext) ? item.usageContext.map(String) : [],
      tagManagerUrl: typeof item.tagManagerUrl === 'string' ? item.tagManagerUrl : undefined,
    }));
  }

  async listWorkspaces(accountId: string, containerId: string): Promise<WorkspaceInfo[]> {
    const items = await this.listAll(`accounts/${accountId}/containers/${containerId}/workspaces`, 'workspace');
    return items.map(toWorkspaceInfo);
  }

  async createWorkspace(accountId: string, containerId: string, name: string, description = ''): Promise<WorkspaceInfo> {
    const created = await this.request('POST', `accounts/${accountId}/containers/${containerId}/workspaces`, { name, description });
    return toWorkspaceInfo(created);
  }

  async getWorkspace(ref: WorkspaceRef): Promise<WorkspaceInfo> {
    return toWorkspaceInfo(await this.request('GET', workspacePath(ref)));
  }

  async getWorkspaceStatus(ref: WorkspaceRef): Promise<WorkspaceStatus> {
    const response = await this.request('GET', `${workspacePath(ref)}/status`);
    return {
      workspaceChange: Array.isArray(response.workspaceChange) ? (response.workspaceChange as ApiChange[]) : [],
      mergeConflict: Array.isArray(response.mergeConflict) ? (response.mergeConflict as ApiMergeConflict[]) : [],
    };
  }

  async latestVersionId(accountId: string, containerId: string): Promise<string | undefined> {
    try {
      const header = await this.request('GET', `accounts/${accountId}/containers/${containerId}/version_headers:latest`);
      return typeof header.containerVersionId === 'string' ? header.containerVersionId : undefined;
    } catch (error: unknown) {
      if (error instanceof GtmError && error.status === 404) return undefined; // container has no versions yet
      throw error;
    }
  }

  async syncWorkspace(ref: WorkspaceRef): Promise<SyncResult> {
    const response = await this.request('POST', `${workspacePath(ref)}:sync`);
    const status = (response.syncStatus ?? {}) as { mergeConflict?: boolean; syncError?: boolean };
    return {
      mergeConflict: status.mergeConflict === true,
      syncError: status.syncError === true,
      conflicts: Array.isArray(response.mergeConflict) ? (response.mergeConflict as ApiMergeConflict[]) : [],
    };
  }

  async resolveConflict(ref: WorkspaceRef, entity: ApiChange, fingerprint?: string): Promise<void> {
    const query = fingerprint ? `?fingerprint=${encodeURIComponent(fingerprint)}` : '';
    await this.request('POST', `${workspacePath(ref)}:resolve_conflict${query}`, entity);
  }

  async fetchSnapshot(ref: WorkspaceRef, usageContext: readonly string[] = []): Promise<RemoteSnapshot> {
    const isServer = usageContext.includes('server');
    const base = workspacePath(ref);
    const entries: [EntityKind, ApiEntity[]][] = [];
    const unavailable: EntityKind[] = [];
    for (const kind of KIND_ORDER) {
      if (SERVER_ONLY_KINDS.has(kind) && usageContext.length > 0 && !isServer) {
        entries.push([kind, []]);
        continue;
      }
      const spec = KIND_SPECS[kind];
      const items = await this.listOptional(kind, `${base}/${spec.collection}`, spec.listField);
      if (items === undefined) unavailable.push(kind);
      entries.push([kind, items ?? []]);
    }
    const builtIns = await this.listAll(`${base}/built_in_variables`, 'builtInVariable');
    return {
      entities: Object.fromEntries(entries) as Record<EntityKind, ApiEntity[]>,
      builtInVariables: builtIns.map((item): BuiltInVariable => ({ type: String(item.type), name: item.name as string | undefined })),
      unavailable,
    };
  }

  async createEntity(ref: WorkspaceRef, kind: EntityKind, body: ApiEntity): Promise<ApiEntity> {
    return this.request('POST', `${workspacePath(ref)}/${KIND_SPECS[kind].collection}`, body);
  }

  async updateEntity(ref: WorkspaceRef, kind: EntityKind, id: string, body: ApiEntity, fingerprint?: string): Promise<ApiEntity> {
    const query = fingerprint ? `?fingerprint=${encodeURIComponent(fingerprint)}` : '';
    return this.request('PUT', `${workspacePath(ref)}/${KIND_SPECS[kind].collection}/${id}${query}`, body);
  }

  async deleteEntity(ref: WorkspaceRef, kind: EntityKind, id: string): Promise<void> {
    await this.request('DELETE', `${workspacePath(ref)}/${KIND_SPECS[kind].collection}/${id}`);
  }

  async bulkUpdate(ref: WorkspaceRef, changes: readonly BulkEntity[]): Promise<Record<string, unknown>[]> {
    const response = await this.request('POST', `${workspacePath(ref)}/bulk_update`, { changes });
    return Array.isArray(response.changes) ? (response.changes as Record<string, unknown>[]) : [];
  }

  async enableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void> {
    if (types.length === 0) return;
    await this.request('POST', `${workspacePath(ref)}/built_in_variables?${typeQuery(types)}`);
  }

  async disableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void> {
    if (types.length === 0) return;
    await this.request('DELETE', `${workspacePath(ref)}/built_in_variables?${typeQuery(types)}`);
  }

  async createVersion(ref: WorkspaceRef, name: string, notes: string): Promise<CreateVersionResult> {
    const response = await this.request('POST', `${workspacePath(ref)}:create_version`, { name, notes });
    const version = (response.containerVersion ?? {}) as Record<string, unknown>;
    return {
      containerVersionId: version.containerVersionId as string | undefined,
      versionFingerprint: version.fingerprint as string | undefined,
      compilerError: response.compilerError === true,
      newWorkspacePath: response.newWorkspacePath as string | undefined,
      syncStatus: response.syncStatus as CreateVersionResult['syncStatus'],
    };
  }

  async publishVersion(accountId: string, containerId: string, versionId: string): Promise<{ compilerError: boolean }> {
    const response = await this.request('POST', `accounts/${accountId}/containers/${containerId}/versions/${versionId}:publish`);
    return { compilerError: response.compilerError === true };
  }

  /** `undefined` means the kind is not available on this container (not "empty"). */
  private async listOptional(kind: EntityKind, path: string, field: string): Promise<ApiEntity[] | undefined> {
    try {
      return await this.listAll(path, field);
    } catch (error: unknown) {
      const tolerated = error instanceof GtmError && (error.status === 400 || error.status === 404);
      if (OPTIONAL_KINDS.has(kind) && tolerated) return undefined;
      throw error;
    }
  }

  private async listAll(path: string, field: string): Promise<ApiEntity[]> {
    const pages: ApiEntity[][] = [];
    let pageToken: string | undefined;
    do {
      const separator = path.includes('?') ? '&' : '?';
      const url = pageToken ? `${path}${separator}pageToken=${encodeURIComponent(pageToken)}` : path;
      const response = await this.request('GET', url);
      pages.push(Array.isArray(response[field]) ? (response[field] as ApiEntity[]) : []);
      pageToken = typeof response.nextPageToken === 'string' && response.nextPageToken ? response.nextPageToken : undefined;
    } while (pageToken);
    return pages.flat();
  }

  private async request(method: Method, path: string, body?: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      const token = await this.tokens.getAccessToken();
      const response = await this.fetchImpl(`${BASE_URL}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      const parsed = parseJson(text);
      if (response.ok) return parsed;

      const error = toGtmError(method, path, response.status, parsed, text);
      // Writes may have been applied before a 5xx; retrying could duplicate them. Only retry quota errors.
      const retryable = method === 'GET' ? isRetryable(response.status, parsed) : isQuotaError(response.status, parsed);
      if (!retryable || attempt + 1 >= this.retry.maxAttempts) throw error;
      const delay = backoffDelay(attempt, this.retry);
      this.options.onRetry?.(attempt + 1, delay, error.message);
      await this.clock.sleep(delay);
    }
  }
}

function toWorkspaceInfo(item: Record<string, unknown>): WorkspaceInfo {
  return {
    accountId: String(item.accountId),
    containerId: String(item.containerId),
    workspaceId: String(item.workspaceId),
    name: String(item.name),
    description: typeof item.description === 'string' ? item.description : undefined,
    tagManagerUrl: typeof item.tagManagerUrl === 'string' ? item.tagManagerUrl : undefined,
  };
}

function typeQuery(types: readonly string[]): string {
  return types.map((type) => `type=${encodeURIComponent(type)}`).join('&');
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const QUOTA_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED']);

function errorReasons(parsed: Record<string, unknown>): string[] {
  const error = parsed.error as { errors?: { reason?: string }[]; status?: string; details?: { reason?: string }[] } | undefined;
  if (!error) return [];
  const reasons = [
    ...(error.errors ?? []).map((item) => item.reason),
    ...(error.details ?? []).map((item) => item.reason),
    error.status,
  ];
  return reasons.filter((reason): reason is string => typeof reason === 'string');
}

export function isRetryable(status: number, parsed: Record<string, unknown>): boolean {
  return status >= 500 || isQuotaError(status, parsed);
}

export function isQuotaError(status: number, parsed: Record<string, unknown>): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const reasons = errorReasons(parsed);
  if (reasons.some((reason) => QUOTA_REASONS.has(reason))) return true;
  const message = String((parsed.error as { message?: string } | undefined)?.message ?? '');
  return /quota|rate limit/i.test(message);
}

function toGtmError(method: Method, path: string, status: number, parsed: Record<string, unknown>, text: string): GtmError {
  const apiMessage = (parsed.error as { message?: string } | undefined)?.message;
  const message = `${method} ${path.split('?')[0]} failed (${status}): ${apiMessage ?? (text.slice(0, 300) || 'no body')}`;
  return new GtmError(message, status, parsed.error);
}
