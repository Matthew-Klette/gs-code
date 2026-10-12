import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EntityKind } from '../kinds';
import { GtmError, type ContainerInfo, type WorkspaceInfo } from '../types';
import { STATE_FILE } from './layout';

export interface IndexEntry {
  readonly kind: EntityKind;
  readonly id: string;
  readonly fingerprint?: string;
  /**
   * The exact `cvt_…` type GTM stores for a template-based entity. A gallery template can be referenced
   * as `cvt_<galleryId>` or `cvt_<container>_<template>`; an edit sends back the one GTM has.
   */
  readonly rawType?: string;
}

export interface FolderEntry {
  readonly id: string;
  readonly fingerprint?: string;
}

/** What the mirror last saw of GTM, so a poll can tell "nothing changed" with two cheap calls. */
export interface RemoteMark {
  /** Hash of `workspaces.getStatus` taken just before the last full pull. */
  readonly status?: string;
  /** Container version the workspace was last synced to. */
  readonly versionId?: string;
  /** A newer container version that exists but the workspace was not synced to (auto-pull never syncs). */
  readonly behind?: string;
}

/** What a push sent, kept until a pull has taken GTM's copy of it (survives a failed refresh). */
export interface PendingPush {
  /** `kind:id` → base path and the canonical local content that was sent. */
  readonly pushed: Readonly<Record<string, PushedDoc>>;
  /** Unnamed or unmatched new entities: base path → canonical content sent; adopted by content. */
  readonly created: Readonly<Record<string, string>>;
  /** Adopting existing files (init --adopt): GTM's copy becomes the base, the files stay as they are. */
  readonly keepLocal?: boolean;
}

export interface PushedDoc {
  readonly base: string;
  readonly content: string;
}

/** A GTM merge conflict: the entity changed in this workspace and in a newer container version. */
export interface GtmConflict {
  readonly kind: EntityKind;
  readonly id: string;
  readonly name?: string;
  /** Mirror path of the entity. */
  readonly base: string;
  /** `changeStatus` on each side (`updated`, `deleted`, …). */
  readonly workspaceChange?: string;
  readonly latestChange?: string;
}

export interface MirrorState {
  readonly version: 1;
  readonly container: ContainerInfo;
  readonly workspace: WorkspaceInfo;
  readonly pulledAt?: string;
  /** base path → remote identity, for every entity present in `.gtm/base`. */
  readonly entities: Readonly<Record<string, IndexEntry>>;
  /** folder name → remote identity. */
  readonly folders: Readonly<Record<string, FolderEntry>>;
  /** Base paths whose local and remote versions both changed since the last pull. */
  readonly conflicts: readonly string[];
  /** Remote fingerprint of each conflicted entity, applied when you Keep Mine. */
  readonly conflictFingerprints: Readonly<Record<string, string>>;
  /** Built-in variable type → display name, for `{{…}}` validation. */
  readonly builtInNames: Readonly<Record<string, string>>;
  readonly remote?: RemoteMark;
  /** Unresolved GTM merge conflicts after syncing to the latest version. Push and versioning stop until they are settled. */
  readonly gtmConflicts: readonly GtmConflict[];
  /** Whole files (folders.json, built-in-variables.json) whose remote update waits until their open editor is saved. */
  readonly deferred: readonly string[];
  /** Conflicts where GTM deleted an entity you edited: Keep Mine recreates it, Take Theirs deletes your file. */
  readonly deletedRemotely: readonly string[];
  readonly pendingPush?: PendingPush;
}

export function emptyState(container: ContainerInfo, workspace: WorkspaceInfo): MirrorState {
  return { version: 1, container, workspace, entities: {}, folders: {}, conflicts: [], conflictFingerprints: {}, builtInNames: {}, gtmConflicts: [], deferred: [], deletedRemotely: [] };
}

export function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

export async function readState(root: string): Promise<MirrorState> {
  const file = path.join(root, STATE_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    throw new GtmError(`No GTM mirror here (missing ${STATE_FILE}). Run "GS Code: Open Workspace…" or \`gscode init\` first.`);
  }
  const parsed = JSON.parse(text) as MirrorState;
  if (parsed.version !== 1 || !parsed.container || !parsed.workspace) {
    throw new GtmError(`${STATE_FILE} is not a valid GTM mirror state file.`);
  }
  return {
    ...parsed,
    entities: parsed.entities ?? {},
    folders: parsed.folders ?? {},
    conflicts: parsed.conflicts ?? [],
    conflictFingerprints: parsed.conflictFingerprints ?? {},
    builtInNames: parsed.builtInNames ?? {},
    gtmConflicts: parsed.gtmConflicts ?? [],
    deferred: parsed.deferred ?? [],
    deletedRemotely: parsed.deletedRemotely ?? [],
  };
}

export async function writeState(root: string, state: MirrorState): Promise<void> {
  const file = path.join(root, STATE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Unique temp name: two writers (CLI + extension) never clobber each other's half-written file.
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

export async function hasState(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, STATE_FILE));
    return true;
  } catch {
    return false;
  }
}
