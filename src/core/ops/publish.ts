import type { GtmApi } from '../api';
import { countChanges, isEmpty } from '../mirror/diff';
import { writeState, type MirrorState } from '../mirror/state';
import { GtmError, parseWorkspacePath } from '../types';
import { workingStatus } from './plan';
import { applySnapshot } from './pull';

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
 * Turns the workspace into a container version (GTM then deletes the workspace
 * and starts a fresh one), optionally publishes it, and re-points the mirror at
 * the new workspace.
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
  let nextState: MirrorState;
  try {
    nextState = await repointWorkspace(root, api, state, version.newWorkspacePath, versionId);
  } catch (error: unknown) {
    throw new GtmError(
      `Version ${versionId} was created and GTM replaced the workspace, but switching this folder to the new workspace failed: ${message(error)}. ` +
        'Open a fresh mirror of the new workspace ("Open Workspace…").',
    );
  }
  if (!request.publish) return { versionId, published: false, state: nextState };

  progress(`Publishing version ${versionId}…`);
  let published: { compilerError: boolean };
  try {
    published = await api.publishVersion(state.container.accountId, state.container.containerId, versionId);
  } catch (error: unknown) {
    throw new GtmError(`Version ${versionId} was created but NOT published: ${message(error)}. Publish it from Tag Manager → Versions, or sign in with allowPublish enabled.`);
  }
  if (published.compilerError) throw new GtmError(`Version ${versionId} was created but publishing hit a compiler error.`);
  return { versionId, published: true, state: nextState };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function repointWorkspace(root: string, api: GtmApi, state: MirrorState, newWorkspacePath: string | undefined, versionId: string): Promise<MirrorState> {
  if (!newWorkspacePath) throw new GtmError('GTM did not say which workspace replaced the old one.');
  const workspace = await api.getWorkspace(parseWorkspacePath(newWorkspacePath));
  // The new workspace starts from the version just created; its status is unknown, so the next check pulls.
  const moved: MirrorState = { ...state, workspace, remote: { versionId }, gtmConflicts: [] };
  await writeState(root, moved);
  const snapshot = await api.fetchSnapshot(workspace, state.container.usageContext);
  return (await applySnapshot(root, moved, snapshot)).state;
}
