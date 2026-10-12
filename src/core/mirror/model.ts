import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { KIND_ORDER, KIND_SPECS } from '../kinds';
import { canonicalJson, normalizeNewlines, prettyJson } from '../serialize/canonical';
import { parsePlain, parseTemplate, renderFiles, TEMPLATE_MANIFEST, type EntityDoc, type ReadFile } from '../serialize/entityFiles';
import { BUILTINS_FILE, FOLDERS_FILE } from './layout';

export interface FolderDoc {
  readonly name: string;
  readonly [field: string]: unknown;
}

/** Everything in one mirror tree (the working folder or `.gtm/base`). */
export interface MirrorModel {
  readonly docs: ReadonlyMap<string, EntityDoc>;
  readonly folders: readonly FolderDoc[];
  readonly builtIns: readonly string[];
}

export interface ParseProblem {
  readonly path: string;
  readonly message: string;
}

export interface ReadResult {
  readonly model: MirrorModel;
  readonly problems: readonly ParseProblem[];
}

export const EMPTY_MODEL: MirrorModel = { docs: new Map(), folders: [], builtIns: [] };

export function fileReader(root: string): ReadFile {
  return async (relPath) => {
    try {
      return await fs.readFile(path.join(root, relPath), 'utf8');
    } catch {
      return undefined;
    }
  };
}

async function listDir(dir: string): Promise<{ files: string[]; dirs: string[] }> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(),
      dirs: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    };
  } catch {
    return { files: [], dirs: [] };
  }
}

export async function readModel(root: string, isServer: boolean): Promise<ReadResult> {
  const read = fileReader(root);
  const docs = new Map<string, EntityDoc>();
  const problems: ParseProblem[] = [];
  const capture = async (relPath: string, load: () => Promise<EntityDoc>) => {
    try {
      const doc = await load();
      docs.set(doc.base, doc);
    } catch (error: unknown) {
      problems.push({ path: relPath, message: error instanceof Error ? error.message : String(error) });
    }
  };

  for (const kind of KIND_ORDER) {
    if (kind === 'folder') continue;
    const dir = KIND_SPECS[kind].dir;
    const listing = await listDir(path.join(root, dir));
    if (kind === 'template') {
      for (const name of listing.dirs) {
        const base = `${dir}/${name}`;
        const inner = await listDir(path.join(root, base));
        await capture(`${base}/${TEMPLATE_MANIFEST}`, () => parseTemplate(base, inner.files, read, isServer));
      }
      continue;
    }
    for (const file of listing.files.filter((name) => name.endsWith('.json'))) {
      const base = `${dir}/${file.slice(0, -'.json'.length)}`;
      await capture(`${base}.json`, () => parsePlain(kind, base, read));
    }
  }

  const folders = await readJsonArray(read, FOLDERS_FILE, problems);
  const builtIns = await readJsonArray(read, BUILTINS_FILE, problems);
  return {
    model: {
      docs,
      folders: folders.filter(isFolderDoc),
      builtIns: builtIns.filter((item): item is string => typeof item === 'string'),
    },
    problems,
  };
}

function isFolderDoc(value: unknown): value is FolderDoc {
  return !!value && typeof value === 'object' && typeof (value as FolderDoc).name === 'string';
}

async function readJsonArray(read: ReadFile, relPath: string, problems: ParseProblem[]): Promise<unknown[]> {
  const text = await read(relPath);
  if (text === undefined) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value;
    problems.push({ path: relPath, message: 'expected a JSON array' });
  } catch (error: unknown) {
    problems.push({ path: relPath, message: `invalid JSON (${error instanceof Error ? error.message : String(error)})` });
  }
  return [];
}

// ---------------------------------------------------------------- writing

async function writeFileAt(root: string, relPath: string, content: string): Promise<void> {
  const file = path.join(root, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

/** Write a doc's files. Files that belonged to `previous` but not to `doc` are removed. */
export async function writeDoc(root: string, doc: EntityDoc, previous?: EntityDoc): Promise<void> {
  const files = renderFiles(doc);
  if (previous) {
    const stale = [...renderFiles(previous).keys()].filter((file) => !files.has(file));
    await Promise.all(stale.map((file) => fs.rm(path.join(root, file), { force: true })));
    if (previous.kind === 'template' && previous.base !== doc.base) await removeEmptyDir(path.join(root, previous.base));
  }
  for (const [relPath, content] of files) await writeFileAt(root, relPath, content);
}

/** Remove only the files this doc renders to; a template folder goes only if nothing else is left in it. */
export async function removeDoc(root: string, doc: EntityDoc): Promise<void> {
  await Promise.all([...renderFiles(doc).keys()].map((file) => fs.rm(path.join(root, file), { force: true })));
  if (doc.kind === 'template') await removeEmptyDir(path.join(root, doc.base));
}

async function removeEmptyDir(dir: string): Promise<void> {
  try {
    const left = await fs.readdir(dir);
    if (left.length === 0) await fs.rmdir(dir);
  } catch {
    // already gone
  }
}

export async function writeFolders(root: string, folders: readonly FolderDoc[]): Promise<void> {
  const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  await writeFileAt(root, FOLDERS_FILE, prettyJson(sorted));
}

export async function writeBuiltIns(root: string, builtIns: readonly string[]): Promise<void> {
  await writeFileAt(root, BUILTINS_FILE, prettyJson([...new Set(builtIns)].sort()));
}

export function sameDoc(a: EntityDoc | undefined, b: EntityDoc | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && canonicalJson(a.data) === canonicalJson(b.data);
}

export function sameText(a: string, b: string): boolean {
  return normalizeNewlines(a) === normalizeNewlines(b);
}
