import type { GtmApi } from '../api';
import { countChanges, isEmpty } from '../mirror/diff';
import { writeState, type MirrorState } from '../mirror/state';
import { GtmError, parseWorkspacePath } from '../types';
import { workingStatus } from './plan';
import { applySnapshot } from './pull';
import { followWorkspace } from './sync';

export class ProtectedContainerError extends GtmError {
  constructor(publicId: string) {
    super(`${publicId} is in gsCode.protectedContainers. Create Version and Publish are blocked for it; do that in the Tag Manager UI.`);
    this.name = 'ProtectedContainerError';
  }
}

export function isProtected(state: MirrorState, protectedContainers: readonly string[]): boolean {
  const ids = new Set([state.container.publicId, state.container.containerId].map((id) => id.toUpperCase()));
  return protectedContainers.some((id) => ids.has(id.trim().toUpperCase()));
}

export function assertNotProtected(state: MirrorState, protectedContainers: readonly string[]): void {
  if (isProtected(state, protectedContainers)) throw new ProtectedContainerError(state.container.publicId);
}

export interface VersionRequest {
  readonly name: string;
  readonly notes: string;
  readonly protectedContainers: readonly string[];
  readonly publish: boolean;
  readonly onProgress?: (message: string) => void;
}

export interface VersionResult {
  readonly versionId: string;
  readonly published: boolean;
  readonly state: MirrorState;
}

/**
 * Turns the workspace into a container version and optionally publishes it. GTM deletes the
 * workspace; it only creates a replacement when that was the last one, so the mirror moves to
 * GTM's replacement or to a workspace with the same name (reused or created).
 */
export async function createVersion(root: string, api: GtmApi, state: MirrorState, request: VersionRequest): Promise<VersionResult> {
  const progress = request.onProgress ?? (() => undefined);
  assertNotProtected(state, request.protectedContainers);
  const status = await workingStatus(root, state);
  if (state.conflicts.length) throw new GtmError('Resolve conflicts before creating a version.');
  if (state.gtmConflicts.length) {
    throw new GtmError(`Resolve the GTM merge conflicts first (Keep Workspace / Take Latest): ${state.gtmConflicts.map((item) => item.base).join(', ')}`);
  }
  if (!isEmpty(status.changes)) {
    throw new GtmError(`You have ${countChanges(status.changes)} unpushed change(s). Push or discard them before creating a version.`);
  }

  progress('Creating version…');
  const version = await api.createVersion(state.workspace, request.name, request.notes);
  if (version.compilerError) throw new GtmError('GTM reported a compiler error; no version was created. Open the workspace in Tag Manager to see it.');
  if (version.syncStatus?.mergeConflict) throw new GtmError('The workspace has merge conflicts with the latest version. Resolve them in Tag Manager first.');
  if (!version.containerVersionId) throw new GtmError('GTM did not return a container version id.');

  const versionId = version.containerVersionId;
  // Publish first: it does not depend on any workspace, so a failed re-point never leaves the version unpublished.
  const publishError = request.publish ? await publishOrError(api, state, versionId, progress) : undefined;
  const publishedNote = request.publish && !publishError ? ' and published' : '';

  let nextState: MirrorState;
  try {
    nextState = await repointWorkspace(root, api, state, version.newWorkspacePath, versionId);
  } catch (error: unknown) {
    throw new GtmError(
      `Version ${versionId} was created${publishedNote}, but switching this folder to a new workspace failed: ${message(error)}. ` +
        `${publishError ? `Publishing also failed: ${publishError}. ` : ''}Open a fresh mirror ("Open Workspace…").`,
    );
  }
  if (publishError) {
    throw new GtmError(`Version ${versionId} was created but NOT published: ${publishError}. This folder now follows workspace "${nextState.workspace.name}". Publish it with \`gscode publish --version ${versionId}\` or from Tag Manager → Versions.`);
  }
  return { versionId, published: request.publish, state: nextState };
}

/** Publish an existing container version (e.g. one whose publish failed), with the same guards. */
export async function publishVersion(api: GtmApi, state: MirrorState, versionId: string, protectedContainers: readonly string[]): Promise<void> {
  assertNotProtected(state, protectedContainers);
  const error = await publishOrError(api, state, versionId, () => undefined);
  if (error) throw new GtmError(`Version ${versionId} was NOT published: ${error}`);
}

async function publishOrError(api: GtmApi, state: MirrorState, versionId: string, progress: (message: string) => void): Promise<string | undefined> {
  progress(`Publishing version ${versionId}…`);
  try {
    const published = await api.publishVersion(state.container.accountId, state.container.containerId, versionId);
    return published.compilerError ? 'GTM reported a compiler error' : undefined;
  } catch (error: unknown) {
    return `${message(error)} (sign in with allowPublish enabled if the token lacks the publish scope)`;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function repointWorkspace(root: string, api: GtmApi, state: MirrorState, newWorkspacePath: string | undefined, versionId: string): Promise<MirrorState> {
  // GTM only creates a replacement when the versioned workspace was the last one (verified live 2026-10-12).
  const workspace = newWorkspacePath ? await api.getWorkspace(parseWorkspacePath(newWorkspacePath)) : await followWorkspace(api, state);
  // The new workspace starts from the version just created; its status is unknown, so the next check pulls.
  const moved: MirrorState = { ...state, workspace, remote: { versionId }, gtmConflicts: [] };
  await writeState(root, moved);
  const snapshot = await api.fetchSnapshot(workspace, state.container.usageContext);
  return (await applySnapshot(root, moved, snapshot)).state;
}
