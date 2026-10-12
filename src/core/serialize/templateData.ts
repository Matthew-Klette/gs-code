/**
 * Custom template `templateData` is one text blob of `___SECTION___` blocks:
 *
 *   ___INFO___\n\n{...}\n\n\n___TEMPLATE_PARAMETERS___\n\n[...]\n\n\n
 *
 * We split it into one file per section so the sandboxed JS is a real .js file.
 */

export interface TemplateSection {
  readonly section: string;
  readonly content: string;
}

const HEADER = /^___([A-Z0-9_]+)___$/gm;
const LEAD = '\n\n';
const TRAIL = '\n\n\n';

export function splitTemplateData(data: string): TemplateSection[] {
  const normalized = data.replace(/\r\n/g, '\n');
  const headers = [...normalized.matchAll(HEADER)];
  return headers.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headers[index + 1]?.index ?? normalized.length;
    return { section: match[1] ?? '', content: unwrap(normalized.slice(start, end)) };
  });
}

export function joinTemplateData(sections: readonly TemplateSection[]): string {
  return sections.map(({ section, content }) => `___${section}___${LEAD}${content}${TRAIL}`).join('');
}

function unwrap(raw: string): string {
  const withoutLead = raw.startsWith(LEAD) ? raw.slice(LEAD.length) : raw.replace(/^\n+/, '');
  if (withoutLead.endsWith(TRAIL)) return withoutLead.slice(0, -TRAIL.length);
  return withoutLead.replace(/\n+$/, '');
}

const SECTION_FILES: Readonly<Record<string, string>> = {
  TERMS_OF_SERVICE: 'terms.txt',
  INFO: 'info.json',
  TEMPLATE_PARAMETERS: 'parameters.json',
  SANDBOXED_JS_FOR_WEB_TEMPLATE: 'code.js',
  SANDBOXED_JS_FOR_SERVER: 'code.js',
  WEB_PERMISSIONS: 'permissions.json',
  SERVER_PERMISSIONS: 'permissions.json',
  TESTS: 'tests.yaml',
  NOTES: 'notes.md',
};

/** Default section order for a template folder created by hand without a manifest. */
export const DEFAULT_SECTION_ORDER: readonly string[] = [
  'TERMS_OF_SERVICE',
  'INFO',
  'TEMPLATE_PARAMETERS',
  'SANDBOXED_JS_FOR_WEB_TEMPLATE',
  'SANDBOXED_JS_FOR_SERVER',
  'WEB_PERMISSIONS',
  'SERVER_PERMISSIONS',
  'TESTS',
  'NOTES',
];

/** File name for each section, unique within one template folder. */
export function sectionFileNames(sections: readonly string[]): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const section of sections) {
    const preferred = SECTION_FILES[section] ?? `${section.toLowerCase()}.txt`;
    const file = used.has(preferred) ? `${section.toLowerCase()}${extensionOf(preferred)}` : preferred;
    used.add(file);
    result.set(section, file);
  }
  return result;
}

/** Section a file belongs to when a template folder has no manifest. */
export function sectionForFile(file: string, isServer: boolean): string | undefined {
  if (file === 'code.js') return isServer ? 'SANDBOXED_JS_FOR_SERVER' : 'SANDBOXED_JS_FOR_WEB_TEMPLATE';
  if (file === 'permissions.json') return isServer ? 'SERVER_PERMISSIONS' : 'WEB_PERMISSIONS';
  const entry = Object.entries(SECTION_FILES).find(([, name]) => name === file);
  return entry?.[0];
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot >= 0 ? file.slice(dot) : '';
}
