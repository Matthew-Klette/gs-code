import { KIND_SPECS, type EntityKind } from '../kinds';

export const STATE_DIR = '.gtm';
export const STATE_FILE = `${STATE_DIR}/state.json`;
/** Last pulled copy of every file, the "original" side of every diff. */
export const BASE_DIR = `${STATE_DIR}/base`;
/** Remote copies of entities in conflict, for side-by-side comparison. */
export const REMOTE_DIR = `${STATE_DIR}/remote`;
/** Latest container version's copy of entities in a GTM merge conflict. */
export const MERGE_DIR = `${STATE_DIR}/merge`;
export const FOLDERS_FILE = 'folders.json';
export const BUILTINS_FILE = 'built-in-variables.json';

const MAX_NAME_LENGTH = 120;

/** Turn a GTM display name into a portable file name. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const clipped = cleaned.slice(0, MAX_NAME_LENGTH).trim();
  return clipped || '_';
}

/**
 * Choose a base path for an entity that is new to the mirror.
 * `taken` holds lower-cased bases already in use (macOS and Windows are case-insensitive).
 */
export function allocateBase(kind: EntityKind, name: string, id: string, taken: ReadonlySet<string>): string {
  const dir = KIND_SPECS[kind].dir;
  const preferred = `${dir}/${safeFileName(name)}`;
  if (!taken.has(preferred.toLowerCase())) return preferred;
  const withId = `${dir}/${safeFileName(name)} (${id})`;
  if (!taken.has(withId.toLowerCase())) return withId;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${withId} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function entityLabel(kind: EntityKind, name: string | undefined): string {
  return `${kind} "${name ?? '(unnamed)'}"`;
}
