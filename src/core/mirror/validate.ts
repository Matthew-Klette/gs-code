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

  const builtInDisplayNames = new Set(model.builtIns.map((type) => builtInNames.get(type)).filter(isString));
  return [
    ...duplicateNames(docs),
    ...duplicateFolders(model),
    ...builtInClashes(docs, builtInDisplayNames),
    ...sequencingCycles(docs),
    ...templateNameMismatches(docs),
    ...docs.flatMap((doc) => checkDoc(doc, { triggers, tags, templates, folders, variables })),
  ];
}

/** A user variable named like an enabled built-in makes `{{…}}` ambiguous; GTM rejects it. */
function builtInClashes(docs: readonly EntityDoc[], builtIns: ReadonlySet<string>): Issue[] {
  return docs
    .filter((doc) => doc.kind === 'variable' && builtIns.has(docName(doc) ?? ''))
    .map((doc) => ({ severity: 'error', path: docPath(doc), message: `variable name "${docName(doc)}" is already used by an enabled built-in variable` }));
}

/** Tag sequencing (setupTag / teardownTag) that loops back on itself never compiles. */
function sequencingCycles(docs: readonly EntityDoc[]): Issue[] {
  const edges = new Map<string, string[]>();
  const pathOf = new Map<string, string>();
  for (const doc of docs.filter((item) => item.kind === 'tag')) {
    const name = docName(doc);
    if (!name) continue;
    pathOf.set(name, docPath(doc));
    const linked = ['setupTag', 'teardownTag'].flatMap((key) =>
      (Array.isArray(doc.data[key]) ? (doc.data[key] as { tagName?: unknown }[]) : []).map((item) => item.tagName).filter(isString),
    );
    edges.set(name, linked);
  }
  const issues: Issue[] = [];
  const reported = new Set<string>();
  const visit = (name: string, trail: readonly string[]): void => {
    const loopAt = trail.indexOf(name);
    if (loopAt >= 0) {
      const loop = [...trail.slice(loopAt), name];
      const key = [...new Set(trail.slice(loopAt))].sort().join('\u0000');
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({ severity: 'error', path: pathOf.get(name) ?? 'tags', message: `tag sequencing loops: ${loop.join(' → ')}` });
      }
      return;
    }
    for (const next of edges.get(name) ?? []) visit(next, [...trail, name]);
  };
  for (const name of edges.keys()) visit(name, []);
  return issues;
}

/** The template's name and its INFO displayName should agree, or references by name drift after a push. */
function templateNameMismatches(docs: readonly EntityDoc[]): Issue[] {
  const issues: Issue[] = [];
  for (const doc of docs.filter((item) => item.kind === 'template')) {
    const info = ((doc.data.sections ?? []) as { section?: string; content?: string }[]).find((section) => section.section === 'INFO');
    let displayName: unknown;
    try {
      displayName = info?.content ? (JSON.parse(info.content) as { displayName?: unknown }).displayName : undefined;
    } catch {
      issues.push({ severity: 'error', path: `${doc.base}/info.json`, message: 'info.json is not valid JSON' });
      continue;
    }
    if (typeof displayName === 'string' && displayName !== docName(doc)) {
      issues.push({ severity: 'warning', path: docPath(doc), message: `name "${docName(doc)}" differs from info.json displayName "${displayName}"; keep them the same` });
    }
  }
  return issues;
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
  const { notes: _notes, ...compiled } = data;
  for (const name of variableRefs(compiled)) {
    // `{{_event}}`, `{{_url}}`… are GTM-internal macros, not user variables.
    // GTM refuses to create a version with an unknown variable reference, so catch it before pushing.
    if (!known.variables.has(name) && !name.startsWith('_')) {
      error(`{{${name}}} is not a variable or enabled built-in in this workspace (renamed or deleted? enable it in built-in-variables.json)`);
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
