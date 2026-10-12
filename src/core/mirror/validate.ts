import { KIND_SPECS, type EntityKind } from '../kinds';
import { docName, type EntityDoc } from '../serialize/entityFiles';
import { collectTriggerReferences, isNameRef, isTemplateTypeRef, templateNameFromTypeRef } from '../serialize/references';
import type { MirrorModel } from './model';

export interface Issue {
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
}

const VARIABLE_REF = /\{\{([^{}]+)\}\}/g;

/**
 * Checks a working tree before push. Errors block the push; warnings are shown.
 * `builtInNames` maps enabled built-in variable types to display names (from the last pull).
 */
export function validateModel(model: MirrorModel, builtInNames: ReadonlyMap<string, string>): Issue[] {
  const docs = [...model.docs.values()];
  const namesOf = (kind: EntityKind) => new Set(docs.filter((doc) => doc.kind === kind).map(docName).filter(isString));
  const triggers = namesOf('trigger');
  const tags = namesOf('tag');
  const templates = namesOf('template');
  const folders = new Set(model.folders.map((folder) => folder.name));
  const variables = new Set([
    ...namesOf('variable'),
    ...model.builtIns.map((type) => builtInNames.get(type)).filter(isString),
  ]);

  return [
    ...duplicateNames(docs),
    ...duplicateFolders(model),
    ...docs.flatMap((doc) => checkDoc(doc, { triggers, tags, templates, folders, variables })),
  ];
}

interface Known {
  readonly triggers: ReadonlySet<string>;
  readonly tags: ReadonlySet<string>;
  readonly templates: ReadonlySet<string>;
  readonly folders: ReadonlySet<string>;
  readonly variables: ReadonlySet<string>;
}

export function docPath(doc: EntityDoc): string {
  return doc.kind === 'template' ? `${doc.base}/template.json` : `${doc.base}.json`;
}

function checkDoc(doc: EntityDoc, known: Known): Issue[] {
  const path = docPath(doc);
  const issues: Issue[] = [];
  const error = (message: string) => issues.push({ severity: 'error', path, message });
  const data = doc.data;

  if (KIND_SPECS[doc.kind].named && !docName(doc)) error('missing "name"');
  if (doc.kind === 'template') return issues;
  if (typeof data.type !== 'string' || !data.type) error('missing "type"');

  const triggerRefs = [
    ...stringArray(data.firingTriggers),
    ...stringArray(data.blockingTriggers),
    ...collectTriggerReferences(data.parameter),
  ];
  for (const ref of triggerRefs.filter(isNameRef)) {
    if (!known.triggers.has(ref)) error(`unknown trigger "${ref}"`);
  }
  if (typeof data.folder === 'string' && isNameRef(data.folder) && !known.folders.has(data.folder)) {
    error(`unknown folder "${data.folder}" (add it to folders.json)`);
  }
  if (isTemplateTypeRef(data.type) && !known.templates.has(templateNameFromTypeRef(data.type))) {
    error(`unknown template "${templateNameFromTypeRef(data.type)}"`);
  }
  for (const key of ['setupTag', 'teardownTag']) {
    for (const item of Array.isArray(data[key]) ? (data[key] as { tagName?: unknown }[]) : []) {
      if (typeof item.tagName === 'string' && !known.tags.has(item.tagName)) error(`${key} references unknown tag "${item.tagName}"`);
    }
  }
  for (const name of variableRefs(data)) {
    // `{{_event}}`, `{{_url}}`… are GTM-internal macros, not user variables.
    if (!known.variables.has(name) && !name.startsWith('_')) {
      issues.push({ severity: 'warning', path, message: `{{${name}}} is not a variable or enabled built-in in this workspace` });
    }
  }
  return issues;
}

function duplicateNames(docs: readonly EntityDoc[]): Issue[] {
  const seen = new Map<string, string>();
  const issues: Issue[] = [];
  for (const doc of docs) {
    const name = docName(doc);
    if (!name || !KIND_SPECS[doc.kind].named) continue;
    const key = `${doc.kind}\u0000${name}`;
    const first = seen.get(key);
    if (first) issues.push({ severity: 'error', path: docPath(doc), message: `duplicate ${doc.kind} name "${name}" (also in ${first})` });
    else seen.set(key, doc.base);
  }
  return issues;
}

function duplicateFolders(model: MirrorModel): Issue[] {
  const names = model.folders.map((folder) => folder.name);
  const dupes = names.filter((name, index) => names.indexOf(name) !== index);
  return [...new Set(dupes)].map((name) => ({ severity: 'error', path: 'folders.json', message: `duplicate folder "${name}"` }));
}

function variableRefs(value: unknown): string[] {
  const text = JSON.stringify(value ?? null);
  return [...new Set([...text.matchAll(VARIABLE_REF)].map((match) => (match[1] ?? '').trim()))].filter(Boolean);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
