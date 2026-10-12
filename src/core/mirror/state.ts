import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EntityKind } from '../kinds';
import { GtmError, type ContainerInfo, type WorkspaceInfo } from '../types';
import { STATE_FILE } from './layout';

export interface IndexEntry {
  readonly kind: EntityKind;
  readonly id: string;
  readonly fingerprint?: string;
}

export interface FolderEntry {
  readonly id: string;
  readonly fingerprint?: string;
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
}

export function emptyState(container: ContainerInfo, workspace: WorkspaceInfo): MirrorState {
  return { version: 1, container, workspace, entities: {}, folders: {}, conflicts: [], conflictFingerprints: {}, builtInNames: {} };
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
  };
}

export async function writeState(root: string, state: MirrorState): Promise<void> {
  const file = path.join(root, STATE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
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
