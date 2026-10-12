import { KIND_SPECS, VOLATILE_FIELDS, type EntityKind } from '../kinds';
import { GtmError, type ApiEntity } from '../types';
import { canonicalJson, normalizeNewlines, prettyJson } from './canonical';
import {
  folderIdToRef,
  folderRefToId,
  mapTriggerReferences,
  triggerIdToRef,
  triggerRefToId,
  typeRefToType,
  typeToRef,
  type IdLookup,
  type RefContext,
} from './references';
import {
  DEFAULT_SECTION_ORDER,
  joinTemplateData,
  sectionFileNames,
  sectionForFile,
  splitTemplateData,
  type TemplateSection,
} from './templateData';

/**
 * An entity in local format with code inlined: the unit we diff and push.
 * `base` is the path without extension, relative to the mirror root,
 * e.g. `tags/GA4 - purchase` (→ .json + .html) or `templates/Meta CAPI` (→ folder).
 */
export interface EntityDoc {
  readonly kind: EntityKind;
  readonly base: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type FileMap = ReadonlyMap<string, string>;
export type ReadFile = (relPath: string) => Promise<string | undefined>;

export const TEMPLATE_MANIFEST = 'template.json';
const VALUE_FILE = 'valueFile';

/** Code parameters written to their own file so they get real syntax highlighting. */
const SIDECARS: readonly { kind: EntityKind; type: string; key: string; ext: string }[] = [
  { kind: 'tag', type: 'html', key: 'html', ext: '.html' },
  { kind: 'variable', type: 'jsm', key: 'javascript', ext: '.js' },
];

// ---------------------------------------------------------------- API → local

export function toLocalData(kind: EntityKind, entity: ApiEntity, ctx: RefContext): Record<string, unknown> {
  if (kind === 'template') return templateToLocal(entity);
  const spec = KIND_SPECS[kind];
  const skip = new Set([...VOLATILE_FIELDS, spec.idField, 'parentFolderId', 'firingTriggerId', 'blockingTriggerId', 'name', 'type']);
  const rest = Object.fromEntries(Object.entries(entity).filter(([key]) => !skip.has(key)));
  const firing = idList(entity.firingTriggerId).map((id) => triggerIdToRef(id, ctx));
  const blocking = idList(entity.blockingTriggerId).map((id) => triggerIdToRef(id, ctx));
  const parameters = rest.parameter === undefined ? {} : { parameter: normalizeSidecars(kind, entity.type, mapTriggerReferences(rest.parameter, (id) => triggerIdToRef(id, ctx))) };
  return {
    ...(entity.name === undefined ? {} : { name: entity.name }),
    ...(typeof entity.type === 'string' ? { type: typeToRef(entity.type, ctx) } : {}),
    ...(firing.length ? { firingTriggers: firing } : {}),
    ...(blocking.length ? { blockingTriggers: blocking } : {}),
    ...(entity.parentFolderId ? { folder: folderIdToRef(String(entity.parentFolderId), ctx) } : {}),
    ...rest,
    ...parameters,
  };
}

/** Sidecar files are read back with LF line endings, so store them that way from the start. */
function normalizeSidecars(kind: EntityKind, type: unknown, parameter: unknown): unknown {
  const sidecar = SIDECARS.find((item) => item.kind === kind && item.type === type);
  if (!sidecar || !Array.isArray(parameter)) return parameter;
  return parameter.map((param: Record<string, unknown>) =>
    param.key === sidecar.key && typeof param.value === 'string' ? { ...param, value: normalizeNewlines(param.value) } : param,
  );
}

function templateToLocal(entity: ApiEntity): Record<string, unknown> {
  return {
    name: entity.name,
    ...(entity.galleryReference ? { galleryReference: entity.galleryReference } : {}),
    sections: splitTemplateData(String(entity.templateData ?? '')),
  };
}

function idList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// ---------------------------------------------------------------- local → API

export interface Unresolved {
  readonly field: string;
  readonly ref: string;
}

export interface ApiBody {
  readonly body: ApiEntity;
  readonly unresolved: readonly Unresolved[];
}

export function toApiBody(doc: EntityDoc, lookup: IdLookup): ApiBody {
  if (doc.kind === 'template') return { body: templateToApi(doc.data), unresolved: [] };
  const unresolved: Unresolved[] = [];
  const resolve = (field: string, ref: string, fn: (ref: string) => string | undefined): string => {
    const id = fn(ref);
    if (id === undefined) unresolved.push({ field, ref });
    return id ?? ref;
  };
  const { firingTriggers, blockingTriggers, folder, type, parameter, ...rest } = doc.data;
  const triggerFn = (ref: string) => triggerRefToId(ref, lookup);
  const body: ApiEntity = {
    ...rest,
    ...(typeof type === 'string' ? { type: resolve('type', type, (ref) => typeRefToType(ref, lookup)) } : {}),
    ...(Array.isArray(firingTriggers) ? { firingTriggerId: firingTriggers.map((ref) => resolve('firingTriggers', String(ref), triggerFn)) } : {}),
    ...(Array.isArray(blockingTriggers) ? { blockingTriggerId: blockingTriggers.map((ref) => resolve('blockingTriggers', String(ref), triggerFn)) } : {}),
    ...(typeof folder === 'string' ? { parentFolderId: resolve('folder', folder, (ref) => folderRefToId(ref, lookup)) } : {}),
    ...(parameter === undefined ? {} : { parameter: mapTriggerReferences(parameter, (ref) => resolve('parameter', ref, triggerFn)) }),
  };
  return { body, unresolved };
}

function templateToApi(data: Readonly<Record<string, unknown>>): ApiEntity {
  const sections = (data.sections ?? []) as TemplateSection[];
  return {
    name: data.name as string,
    templateData: joinTemplateData(sections),
    ...(data.galleryReference ? { galleryReference: data.galleryReference } : {}),
  };
}

// ---------------------------------------------------------------- doc ⇄ files

export function renderFiles(doc: EntityDoc): FileMap {
  return doc.kind === 'template' ? renderTemplate(doc) : renderPlain(doc);
}

function renderPlain(doc: EntityDoc): FileMap {
  const files = new Map<string, string>();
  const fileBase = basename(doc.base);
  const sidecar = SIDECARS.find((item) => item.kind === doc.kind && item.type === doc.data.type);
  let data = doc.data;
  if (sidecar && Array.isArray(doc.data.parameter)) {
    const parameter = doc.data.parameter.map((param: Record<string, unknown>) => {
      if (param.key !== sidecar.key || typeof param.value !== 'string') return param;
      const fileName = `${fileBase}${sidecar.ext}`;
      files.set(`${doc.base}${sidecar.ext}`, param.value);
      const { value: _value, ...withoutValue } = param;
      return { ...withoutValue, [VALUE_FILE]: fileName };
    });
    data = { ...doc.data, parameter };
  }
  files.set(`${doc.base}.json`, prettyJson(data));
  return files;
}

function renderTemplate(doc: EntityDoc): FileMap {
  const sections = (doc.data.sections ?? []) as TemplateSection[];
  const names = sectionFileNames(sections.map((item) => item.section));
  const files = new Map<string, string>();
  const manifestSections = sections.map(({ section, content }) => {
    const file = names.get(section) ?? `${section.toLowerCase()}.txt`;
    files.set(`${doc.base}/${file}`, content);
    return { section, file };
  });
  const { sections: _sections, ...meta } = doc.data;
  files.set(`${doc.base}/${TEMPLATE_MANIFEST}`, prettyJson({ ...meta, sections: manifestSections }));
  return files;
}

/** Read one plain entity from `<base>.json` plus any `valueFile` sidecars. */
export async function parsePlain(kind: EntityKind, base: string, read: ReadFile): Promise<EntityDoc> {
  const jsonPath = `${base}.json`;
  const data = parseJsonFile(jsonPath, await read(jsonPath));
  const dir = dirname(base);
  if (!Array.isArray(data.parameter)) return { kind, base, data };
  const parameter = await Promise.all(
    data.parameter.map(async (param: Record<string, unknown>) => {
      if (typeof param[VALUE_FILE] !== 'string') return param;
      const sidecarPath = joinPath(dir, param[VALUE_FILE] as string);
      const content = await read(sidecarPath);
      if (content === undefined) throw new GtmError(`${jsonPath}: ${VALUE_FILE} "${param[VALUE_FILE]}" not found`);
      const { [VALUE_FILE]: _file, ...rest } = param;
      return { ...rest, value: normalizeNewlines(content) };
    }),
  );
  return { kind, base, data: { ...data, parameter } };
}

/** Read one template folder. `files` lists the file names inside it (for manifest-less folders). */
export async function parseTemplate(base: string, files: readonly string[], read: ReadFile, isServer: boolean): Promise<EntityDoc> {
  const manifestPath = `${base}/${TEMPLATE_MANIFEST}`;
  const manifestText = await read(manifestPath);
  const manifest = manifestText === undefined ? { name: basename(base) } : parseJsonFile(manifestPath, manifestText);
  const declared = Array.isArray(manifest.sections) ? (manifest.sections as { section: string; file: string }[]) : inferSections(files, isServer);
  const sections = await Promise.all(
    declared.map(async ({ section, file }): Promise<TemplateSection> => {
      const content = await read(`${base}/${file}`);
      if (content === undefined) throw new GtmError(`${manifestPath}: section file "${file}" not found`);
      return { section, content: normalizeNewlines(content) };
    }),
  );
  const { sections: _declared, ...meta } = manifest;
  return { kind: 'template', base, data: { ...meta, sections } };
}

function inferSections(files: readonly string[], isServer: boolean): { section: string; file: string }[] {
  const found = files
    .map((file) => ({ file, section: sectionForFile(file, isServer) }))
    .filter((item): item is { file: string; section: string } => item.section !== undefined);
  return found.sort((a, b) => DEFAULT_SECTION_ORDER.indexOf(a.section) - DEFAULT_SECTION_ORDER.indexOf(b.section));
}

export function canonicalDoc(doc: EntityDoc): string {
  return canonicalJson(doc.data);
}

export function docName(doc: EntityDoc): string | undefined {
  return typeof doc.data.name === 'string' ? doc.data.name : undefined;
}

function parseJsonFile(path: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined) throw new GtmError(`${path} not found`);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
    return value as Record<string, unknown>;
  } catch (error: unknown) {
    throw new GtmError(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function joinPath(dir: string, file: string): string {
  return dir ? `${dir}/${file}` : file;
}
