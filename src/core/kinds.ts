/**
 * Static description of every GTM workspace entity kind this tool mirrors.
 * One table drives the API client, the serializer and the local layout.
 */

export type EntityKind =
  | 'folder'
  | 'template'
  | 'variable'
  | 'trigger'
  | 'tag'
  | 'client'
  | 'transformation'
  | 'zone'
  | 'gtagConfig';

export interface KindSpec {
  readonly kind: EntityKind;
  /** REST collection segment under a workspace path, e.g. `tags`. */
  readonly collection: string;
  /** Field holding the entity id, e.g. `tagId`. */
  readonly idField: string;
  /** Array key in the list response, e.g. `tag`. */
  readonly listField: string;
  /** Union key inside a bulk_update `Entity`, e.g. `customTemplate`. */
  readonly entityField: string;
  /** Local directory. Folders are stored in a single `folders.json` instead. */
  readonly dir: string;
  /** Whether the entity has a unique `name` used for identity and file names. */
  readonly named: boolean;
}

export const KIND_SPECS: Readonly<Record<EntityKind, KindSpec>> = {
  folder: { kind: 'folder', collection: 'folders', idField: 'folderId', listField: 'folder', entityField: 'folder', dir: 'folders', named: true },
  template: { kind: 'template', collection: 'templates', idField: 'templateId', listField: 'template', entityField: 'customTemplate', dir: 'templates', named: true },
  variable: { kind: 'variable', collection: 'variables', idField: 'variableId', listField: 'variable', entityField: 'variable', dir: 'variables', named: true },
  trigger: { kind: 'trigger', collection: 'triggers', idField: 'triggerId', listField: 'trigger', entityField: 'trigger', dir: 'triggers', named: true },
  tag: { kind: 'tag', collection: 'tags', idField: 'tagId', listField: 'tag', entityField: 'tag', dir: 'tags', named: true },
  client: { kind: 'client', collection: 'clients', idField: 'clientId', listField: 'client', entityField: 'client', dir: 'clients', named: true },
  transformation: { kind: 'transformation', collection: 'transformations', idField: 'transformationId', listField: 'transformation', entityField: 'transformation', dir: 'transformations', named: true },
  zone: { kind: 'zone', collection: 'zones', idField: 'zoneId', listField: 'zone', entityField: 'zone', dir: 'zones', named: true },
  gtagConfig: { kind: 'gtagConfig', collection: 'gtag_config', idField: 'gtagConfigId', listField: 'gtagConfig', entityField: 'gtagConfig', dir: 'gtag-configs', named: false },
};

/**
 * Dependency order for creates/updates: things referenced come first.
 * Deletes run in reverse.
 */
export const KIND_ORDER: readonly EntityKind[] = [
  'folder',
  'template',
  'variable',
  'trigger',
  'tag',
  'client',
  'transformation',
  'zone',
  'gtagConfig',
];

/** Server-only kinds return 4xx on web containers; the API client tolerates that on list. */
export const SERVER_ONLY_KINDS: ReadonlySet<EntityKind> = new Set(['client', 'transformation']);

/** Fields the API owns. They are stripped from local files and never sent back on update. */
export const VOLATILE_FIELDS: readonly string[] = [
  'path',
  'accountId',
  'containerId',
  'workspaceId',
  'fingerprint',
  'tagManagerUrl',
];

export function kindFromDir(dir: string): EntityKind | undefined {
  return KIND_ORDER.find((kind) => KIND_SPECS[kind].dir === dir);
}
