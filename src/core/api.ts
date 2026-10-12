import { KIND_ORDER, KIND_SPECS, SERVER_ONLY_KINDS, type EntityKind } from './kinds';
import { backoffDelay, DEFAULT_RETRY, RateLimiter, systemClock, type Clock, type RetryPolicy } from './rateLimiter';
import {
  DailyQuotaError,
  GtmError,
  workspacePath,
  type AccountInfo,
  type ApiEntity,
  type BuiltInVariable,
  type BulkEntity,
  type ContainerInfo,
  type CreateVersionResult,
  type EnvironmentInfo,
  type VersionHeader,
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
  /** Id of the version that is live right now, if any. */
  liveVersionId(accountId: string, containerId: string): Promise<string | undefined>;
  /** Bring the workspace up to the latest container version. */
  syncWorkspace(ref: WorkspaceRef): Promise<SyncResult>;
  resolveConflict(ref: WorkspaceRef, entity: ApiChange, fingerprint?: string): Promise<void>;
  /**
   * Every entity in the workspace. With `only`, just those kinds (plus folders and built-ins, which are
   * always merged as whole lists); the rest are reported `unavailable`, so nothing reads them as deleted.
   */
  fetchSnapshot(ref: WorkspaceRef, usageContext?: readonly string[], only?: readonly EntityKind[]): Promise<RemoteSnapshot>;
  getEntity(ref: WorkspaceRef, kind: EntityKind, id: string): Promise<ApiEntity>;
  createEntity(ref: WorkspaceRef, kind: EntityKind, body: ApiEntity): Promise<ApiEntity>;
  updateEntity(ref: WorkspaceRef, kind: EntityKind, id: string, body: ApiEntity, fingerprint?: string): Promise<ApiEntity>;
  deleteEntity(ref: WorkspaceRef, kind: EntityKind, id: string): Promise<void>;
  bulkUpdate(ref: WorkspaceRef, changes: readonly BulkEntity[]): Promise<Record<string, unknown>[]>;
  enableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void>;
  disableBuiltIns(ref: WorkspaceRef, types: readonly string[]): Promise<void>;
  createVersion(ref: WorkspaceRef, name: string, notes: string): Promise<CreateVersionResult>;
  publishVersion(accountId: string, containerId: string, versionId: string): Promise<{ compilerError: boolean }>;
  listVersions(accountId: string, containerId: string): Promise<VersionHeader[]>;
  listEnvironments(accountId: string, containerId: string): Promise<EnvironmentInfo[]>;
  /** Compile the workspace without creating a version: GTM's own check for errors. */
  quickPreview(ref: WorkspaceRef): Promise<{ compilerError: boolean; mergeConflict: boolean }>;
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

  async liveVersionId(accountId: string, containerId: string): Promise<string | undefined> {
    try {
      const version = await this.request('GET', `accounts/${accountId}/containers/${containerId}/versions:live`);
      return typeof version.containerVersionId === 'string' ? version.containerVersionId : undefined;
    } catch (error: unknown) {
      if (error instanceof GtmError && error.status === 404) return undefined; // nothing published yet
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

  async fetchSnapshot(ref: WorkspaceRef, usageContext: readonly string[] = [], only?: readonly EntityKind[]): Promise<RemoteSnapshot> {
    const isServer = usageContext.includes('server');
    const base = workspacePath(ref);
    const entries: [EntityKind, ApiEntity[]][] = [];
    const unavailable: EntityKind[] = [];
    const wanted = only ? new Set<EntityKind>([...only, 'folder']) : undefined;
    for (const kind of KIND_ORDER) {
      if (wanted && !wanted.has(kind)) {
        unavailable.push(kind);
        entries.push([kind, []]);
        continue;
      }
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

  async getEntity(ref: WorkspaceRef, kind: EntityKind, id: string): Promise<ApiEntity> {
    return this.request('GET', `${workspacePath(ref)}/${KIND_SPECS[kind].collection}/${id}`);
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

  async listVersions(accountId: string, containerId: string): Promise<VersionHeader[]> {
    const items = await this.listAll(`accounts/${accountId}/containers/${containerId}/version_headers?includeDeleted=false`, 'containerVersionHeader');
    return items.map((item) => ({
      versionId: String(item.containerVersionId),
      name: typeof item.name === 'string' ? item.name : undefined,
      deleted: item.deleted === true,
      counts: Object.fromEntries(Object.entries(item).filter(([key]) => key.startsWith('num')).map(([key, value]) => [key.slice(3), Number(value)])),
    }));
  }

  async listEnvironments(accountId: string, containerId: string): Promise<EnvironmentInfo[]> {
    const items = await this.listAll(`accounts/${accountId}/containers/${containerId}/environments`, 'environment');
    return items.map((item) => ({
      environmentId: String(item.environmentId),
      name: String(item.name ?? ''),
      type: String(item.type ?? ''),
      authorizationCode: typeof item.authorizationCode === 'string' ? item.authorizationCode : undefined,
      workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : undefined,
      containerVersionId: typeof item.containerVersionId === 'string' ? item.containerVersionId : undefined,
      url: typeof item.url === 'string' ? item.url : undefined,
    }));
  }

  async quickPreview(ref: WorkspaceRef): Promise<{ compilerError: boolean; mergeConflict: boolean }> {
    const response = await this.request('POST', `${workspacePath(ref)}:quick_preview`);
    const sync = (response.syncStatus ?? {}) as { mergeConflict?: boolean };
    return { compilerError: response.compilerError === true, mergeConflict: sync.mergeConflict === true };
  }

  /** `undefined` means the kind is not available on this container (not "empty"). */
  private async listOptional(kind: EntityKind, path: string, field: string): Promise<ApiEntity[] | undefined> {
    try {
      return await this.listAll(path, field);
    } catch (error: unknown) {
      // 403 too: zones and Google tag configs are feature-gated on some accounts (non-360, older containers).
      const tolerated = error instanceof GtmError && (error.status === 400 || error.status === 403 || error.status === 404);
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
      if (isDailyQuota(response.status, parsed)) throw new DailyQuotaError(error.message);
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

/** "Requests per day" (or dailyLimitExceeded): waiting minutes will not help. */
export function isDailyQuota(status: number, parsed: Record<string, unknown>): boolean {
  if (!isQuotaError(status, parsed)) return false;
  if (errorReasons(parsed).some((reason) => /daily/i.test(reason))) return true;
  const message = String((parsed.error as { message?: string } | undefined)?.message ?? '');
  return /per day|daily/i.test(message);
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
  const raw = `${method} ${path.split('?')[0]} failed (${status}): ${apiMessage ?? (text.slice(0, 300) || 'no body')}`;
  const hint = explainError(method, path, status, apiMessage ?? '');
  return new GtmError(hint ? `${hint}\n${raw}` : raw, status, parsed.error);
}

/** One plain sentence for the errors people actually hit; the raw API message stays underneath. */
export function explainError(method: string, path: string, status: number, apiMessage: string): string | undefined {
  const message = apiMessage.toLowerCase();
  if (message.includes('has not been used in project') || message.includes('accessnotconfigured') || message.includes('is disabled')) {
    return 'The Tag Manager API is not enabled in the Google Cloud project of your OAuth client. Enable it under APIs & Services → Library.';
  }
  if (status === 403 && /insufficient.*scope|access_token_scope_insufficient/.test(message)) {
    return path.includes(':publish')
      ? 'Your sign-in has no publish permission (gsCode.allowPublish was off when you signed in). Sign in again with publishing allowed.'
      : 'Your sign-in is missing a permission GS Code needs. Sign in again.';
  }
  if (status === 403) {
    if (path.includes(':publish')) return 'Your Google account cannot publish this container (it needs the Publish permission in GTM).';
    if (path.includes(':create_version')) return 'Your Google account cannot create versions in this container (it needs Approve or Publish in GTM).';
    if (method !== 'GET') return 'Your Google account cannot edit this workspace (it needs Edit permission on the container in GTM).';
    return 'Your Google account cannot read this (check its permissions on the account and container in GTM).';
  }
  if (status === 409) return 'Someone changed this in GTM a moment ago. Pull, review, then try again.';
  if (status === 400 && /workspace.*limit|maximum number of workspaces|too many workspaces/.test(message)) {
    return 'This container already has the maximum number of workspaces (3 on free GTM). Delete or version one in GTM first.';
  }
  if (status === 400 && /submitted|approval/.test(message)) return 'This workspace was submitted for approval (GTM 360) and cannot be edited until the approval is resolved.';
  if (status === 400 && path.endsWith('/bulk_update')) {
    return 'GTM rejected the push. To find the entity it objects to, push with the sequential strategy (`gscode push --sequential`, or the gsCode.pushStrategy setting).';
  }
  return undefined;
}
