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

/** UTF-8 bytes, leaving room for " (id) 2", the extension and sidecar suffixes under the 255-byte limit. */
const MAX_NAME_BYTES = 120;
/** Windows refuses these as file names, with any extension, in any case. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Turn a GTM display name into a file name that works on macOS, Windows and Linux. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC') // macOS and git otherwise disagree on accented names
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const clipped = clipBytes(cleaned, MAX_NAME_BYTES).trim().replace(/[. ]+$/, '');
  const safe = clipped || '_';
  return RESERVED.test(safe) ? `_${safe}` : safe;
}

/** Cut to at most `max` UTF-8 bytes without splitting a character (or an emoji's surrogate pair). */
function clipBytes(text: string, max: number): string {
  let bytes = 0;
  let result = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > max) break;
    bytes += size;
    result += char;
  }
  return result;
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
