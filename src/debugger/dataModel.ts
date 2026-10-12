/**
 * GTM's data model, rebuilt from the recorded pushes with GTM's own merge rules: plain objects and
 * arrays merge recursively (arrays index by index: the classic "old ecommerce items linger" effect,
 * which is why sites push `{ ecommerce: null }` first), everything else replaces. Rebuilding it here means the debugger never
 * depends on GTM internals, and the model "as of event N" is exact for every event.
 */
export type DataModel = Readonly<Record<string, unknown>>;

const TRANSIENT = new Set(['eventCallback', 'eventTimeout']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !('__element' in (value as object));
}

export function mergePush(model: DataModel, push: Readonly<Record<string, unknown>>): DataModel {
  const next: Record<string, unknown> = { ...model };
  for (const [key, value] of Object.entries(push)) {
    if (TRANSIENT.has(key)) continue;
    // Dotted keys ("ecommerce.items") address nested paths, like GTM does.
    setPath(next, key.split('.'), value);
  }
  return next;
}

function setPath(target: Record<string, unknown>, keys: readonly string[], value: unknown): void {
  const [head, ...rest] = keys;
  if (head === undefined) return;
  if (rest.length === 0) {
    const existing = target[head];
    target[head] = mergeValue(existing, value);
    return;
  }
  const child = isPlainObject(target[head]) ? { ...(target[head] as Record<string, unknown>) } : {};
  setPath(child, rest, value);
  target[head] = child;
}

function mergeValue(base: unknown, update: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(update)) {
    const out = [...base];
    update.forEach((item, index) => {
      out[index] = mergeValue(base[index], item);
    });
    return out;
  }
  if (isPlainObject(base) && isPlainObject(update)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(update)) out[key] = mergeValue(out[key], value);
    return out;
  }
  return update;
}

/** `dataLayer.get('a.b.c')` semantics, with GTM's version-2 dotted lookup. */
export function getPath(model: DataModel, path: string): unknown {
  let current: unknown = model;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
