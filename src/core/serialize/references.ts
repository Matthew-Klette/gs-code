import type { ApiEntity, RemoteSnapshot } from '../types';

/**
 * GTM links entities by numeric id (tag → trigger, entity → folder, tag → template type).
 * Locally we write names instead so files are readable and new entities can
 * reference each other before they have ids. This module translates both ways.
 *
 * Encodings used in local files:
 *   "My Trigger"         a trigger/folder by name
 *   "builtin:All Pages"  a built-in trigger that has no entity of its own
 *   "#2147479574"        any id we cannot name (passed through untouched)
 *   "template:My Tmpl"   a custom template, in a `type` field
 */

export const BUILTIN_TRIGGERS: Readonly<Record<string, string>> = {
  '2147479553': 'All Pages',
  '2147479572': 'Consent Initialization - All Pages',
  '2147479573': 'Initialization - All Pages',
};

const BUILTIN_PREFIX = 'builtin:';
const RAW_PREFIX = '#';
const TEMPLATE_PREFIX = 'template:';

export interface RefContext {
  readonly containerId: string;
  readonly triggerNames: ReadonlyMap<string, string>;
  readonly folderNames: ReadonlyMap<string, string>;
  /** cvt type → template name */
  readonly templateNames: ReadonlyMap<string, string>;
}

export interface IdLookup {
  readonly triggerIds: ReadonlyMap<string, string>;
  readonly folderIds: ReadonlyMap<string, string>;
  /** template name → cvt type */
  readonly templateTypes: ReadonlyMap<string, string>;
}

export function templateType(containerId: string, template: ApiEntity): string {
  const gallery = template.galleryReference as { galleryTemplateId?: string } | undefined;
  if (gallery?.galleryTemplateId) return `cvt_${gallery.galleryTemplateId}`;
  return `cvt_${containerId}_${String(template.templateId)}`;
}

export function buildRefContext(containerId: string, snapshot: RemoteSnapshot): RefContext {
  const byId = (items: readonly ApiEntity[], idField: string) =>
    new Map(items.map((item) => [String(item[idField]), String(item.name)]));
  const templateNames = new Map<string, string>();
  for (const template of snapshot.entities.template) {
    templateNames.set(templateType(containerId, template), String(template.name));
    // Some gallery templates are still referenced by their container-scoped type.
    templateNames.set(`cvt_${containerId}_${String(template.templateId)}`, String(template.name));
  }
  return {
    containerId,
    triggerNames: byId(snapshot.entities.trigger, 'triggerId'),
    folderNames: byId(snapshot.entities.folder, 'folderId'),
    templateNames,
  };
}

export function triggerIdToRef(id: string, ctx: RefContext): string {
  const builtin = BUILTIN_TRIGGERS[id];
  if (builtin) return `${BUILTIN_PREFIX}${builtin}`;
  return ctx.triggerNames.get(id) ?? `${RAW_PREFIX}${id}`;
}

export function triggerRefToId(ref: string, lookup: IdLookup): string | undefined {
  if (ref.startsWith(RAW_PREFIX)) return ref.slice(RAW_PREFIX.length);
  if (ref.startsWith(BUILTIN_PREFIX)) {
    const name = ref.slice(BUILTIN_PREFIX.length);
    return Object.entries(BUILTIN_TRIGGERS).find(([, builtinName]) => builtinName === name)?.[0];
  }
  return lookup.triggerIds.get(ref);
}

export function folderIdToRef(id: string, ctx: RefContext): string {
  return ctx.folderNames.get(id) ?? `${RAW_PREFIX}${id}`;
}

export function folderRefToId(ref: string, lookup: IdLookup): string | undefined {
  if (ref.startsWith(RAW_PREFIX)) return ref.slice(RAW_PREFIX.length);
  return lookup.folderIds.get(ref);
}

export function typeToRef(type: string, ctx: RefContext): string {
  const name = ctx.templateNames.get(type);
  return name ? `${TEMPLATE_PREFIX}${name}` : type;
}

export function typeRefToType(ref: string, lookup: IdLookup): string | undefined {
  if (!ref.startsWith(TEMPLATE_PREFIX)) return ref;
  return lookup.templateTypes.get(ref.slice(TEMPLATE_PREFIX.length));
}

export function isTemplateTypeRef(type: unknown): type is string {
  return typeof type === 'string' && type.startsWith(TEMPLATE_PREFIX);
}

export function templateNameFromTypeRef(ref: string): string {
  return ref.slice(TEMPLATE_PREFIX.length);
}

export function isNameRef(ref: string): boolean {
  return !ref.startsWith(RAW_PREFIX) && !ref.startsWith(BUILTIN_PREFIX);
}

/** The REST API spells parameter types `triggerReference`; container exports use `TRIGGER_REFERENCE`. */
function isTriggerReference(record: Record<string, unknown>): boolean {
  return (record.type === 'triggerReference' || record.type === 'TRIGGER_REFERENCE') && typeof record.value === 'string';
}

/** Map every trigger-reference value inside a parameter tree. Returns a new tree. */
export function mapTriggerReferences(value: unknown, map: (ref: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapTriggerReferences(item, map));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const mapped = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, mapTriggerReferences(child, map)]));
  if (isTriggerReference(record)) {
    return { ...mapped, value: map(record.value as string) };
  }
  return mapped;
}

/** Collect trigger-reference values from a parameter tree. */
export function collectTriggerReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectTriggerReferences);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = isTriggerReference(record) ? [record.value as string] : [];
  return [...own, ...Object.values(record).flatMap(collectTriggerReferences)];
}
