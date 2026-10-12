import { docPath } from '../core/mirror/validate';
import type { EntityDoc } from '../core/serialize/entityFiles';
import { BUILTIN_TRIGGERS } from '../core/serialize/references';
import { getPath } from './dataModel';
import { paramMap, stringify, VariableResolver, type EventContext, type Resolved } from './variables';

/** Which GTM events each trigger type listens to. */
const TYPE_EVENTS: Readonly<Record<string, readonly string[]>> = {
  pageview: ['gtm.js'],
  domReady: ['gtm.dom'],
  windowLoaded: ['gtm.load'],
  init: ['gtm.init'],
  consentInit: ['gtm.init_consent'],
  click: ['gtm.click'],
  linkClick: ['gtm.linkClick'],
  formSubmission: ['gtm.formSubmit'],
  historyChange: ['gtm.historyChange', 'gtm.historyChange-v2'],
  jsError: ['gtm.pageError'],
  timer: ['gtm.timer'],
  scrollDepth: ['gtm.scrollDepth'],
  elementVisibility: ['gtm.elementVisibility'],
  youTubeVideo: ['gtm.video'],
};

/** The three built-in triggers that have no entity of their own. */
const BUILT_IN_TRIGGER_TYPES: Readonly<Record<string, string>> = {
  'All Pages': 'pageview',
  'Initialization - All Pages': 'init',
  'Consent Initialization - All Pages': 'consentInit',
};

export interface ConditionCheck {
  /** "{{Event}} equals purchase" as written in the trigger. */
  readonly text: string;
  readonly left: Resolved;
  readonly right: string;
  /** `undefined` when a value could not be computed. */
  readonly result: boolean | undefined;
}

export interface TriggerCheck {
  readonly trigger: string;
  /** Mirror file of the trigger, to open from an explanation. */
  readonly file?: string;
  readonly matched: boolean | undefined;
  readonly reason: string;
  readonly conditions: readonly ConditionCheck[];
}

export type Verdict = 'fires' | 'does-not-fire' | 'unknown';

export interface TagExplanation {
  readonly tag: string;
  readonly file: string;
  readonly verdict: Verdict;
  /** One sentence: the decisive reason. */
  readonly summary: string;
  readonly firing: readonly TriggerCheck[];
  readonly blocking: readonly TriggerCheck[];
  readonly notes: readonly string[];
}

export interface MirrorDocs {
  readonly tags: readonly EntityDoc[];
  readonly triggers: readonly EntityDoc[];
  readonly variables: readonly EntityDoc[];
  readonly builtInNames: Readonly<Record<string, string>>;
  /** Trigger name → GTM trigger id (from the mirror state), to read `gtm.triggers` stamps. */
  readonly triggerIds?: ReadonlyMap<string, string>;
}

/**
 * Why a tag did (or did not) fire on an event, worked out from the mirror files: its firing and
 * blocking triggers, each condition with the values it compared, plus pause, schedule and consent.
 * GTM's own preview only says "not fired"; this says which file and which condition decided it.
 */
export class Explainer {
  private readonly triggers: ReadonlyMap<string, EntityDoc>;
  readonly resolver: VariableResolver;

  constructor(
    private readonly docs: MirrorDocs,
    resolver?: VariableResolver,
  ) {
    this.triggers = new Map(docs.triggers.map((doc) => [String(doc.data.name), doc]));
    this.resolver = resolver ?? new VariableResolver(docs.variables, docs.builtInNames);
  }

  tagNames(): string[] {
    return this.docs.tags.map((doc) => String(doc.data.name));
  }

  async explainTag(name: string, ctx: EventContext): Promise<TagExplanation | undefined> {
    const tag = this.docs.tags.find((doc) => doc.data.name === name);
    if (!tag) return undefined;
    const notes: string[] = [];
    const firing = await Promise.all(stringList(tag.data.firingTriggers).map((ref) => this.checkTrigger(ref, ctx)));
    const blocking = await Promise.all(stringList(tag.data.blockingTriggers).map((ref) => this.checkTrigger(ref, ctx)));
    const file = docPath(tag);

    if (tag.data.paused === true) return done('does-not-fire', 'The tag is paused.');
    const schedule = scheduleProblem(tag.data);
    if (schedule) return done('does-not-fire', schedule);
    if (firing.length === 0) return done('does-not-fire', 'The tag has no firing triggers.');

    const blocked = blocking.find((check) => check.matched === true);
    if (blocked) return done('does-not-fire', `Blocked by trigger "${blocked.trigger}".`);
    const consent = consentProblem(tag.data, ctx);
    if (consent) notes.push(consent);

    const fired = firing.find((check) => check.matched === true);
    if (fired) {
      const unsure = blocking.find((check) => check.matched === undefined);
      if (unsure) return done('unknown', `"${fired.trigger}" matches, but blocking trigger "${unsure.trigger}" could not be evaluated.`);
      if (consent) return done('does-not-fire', `"${fired.trigger}" matches, but ${consent}`);
      return done('fires', `Fires on "${fired.trigger}".`);
    }
    const unknown = firing.find((check) => check.matched === undefined);
    if (unknown) return done('unknown', `"${unknown.trigger}" could not be evaluated: ${unknown.reason}`);
    return done('does-not-fire', firing.length === 1 ? `Trigger "${firing[0]?.trigger}": ${firing[0]?.reason}` : `None of its ${firing.length} triggers match this event.`);

    function done(verdict: Verdict, summary: string): TagExplanation {
      return { tag: name, file, verdict, summary, firing, blocking, notes };
    }
  }

  async checkTrigger(ref: string, ctx: EventContext): Promise<TriggerCheck> {
    if (ref.startsWith('builtin:') || ref.startsWith('#')) {
      const name = ref.startsWith('builtin:') ? ref.slice('builtin:'.length) : BUILTIN_TRIGGERS[ref.slice(1)];
      const type = name ? BUILT_IN_TRIGGER_TYPES[name] : undefined;
      if (!type) return { trigger: ref, matched: undefined, reason: `unknown built-in trigger ${ref}`, conditions: [] };
      const matched = (TYPE_EVENTS[type] ?? []).includes(ctx.event ?? '');
      return { trigger: name ?? ref, matched, reason: matched ? `event is ${ctx.event}` : `listens to ${(TYPE_EVENTS[type] ?? []).join(' / ')}, this event is "${ctx.event}"`, conditions: [] };
    }
    const doc = this.triggers.get(ref);
    if (!doc) return { trigger: ref, matched: undefined, reason: 'trigger not found in the workspace', conditions: [] };
    const file = docPath(doc);
    const type = String(doc.data.type);

    if (type === 'triggerGroup') {
      return { trigger: ref, file, matched: undefined, reason: 'trigger groups depend on earlier events; check each member trigger', conditions: [] };
    }
    const eventMatch = await this.eventMatches(doc, type, ctx);
    if (eventMatch.matched === false) return { trigger: ref, file, matched: false, reason: eventMatch.reason, conditions: eventMatch.conditions };

    const conditions = [
      ...eventMatch.conditions,
      ...(await this.conditions(doc.data.autoEventFilter, ctx)),
      ...(await this.conditions(doc.data.filter, ctx)),
    ];
    const failed = conditions.find((check) => check.result === false);
    if (failed) return { trigger: ref, file, matched: false, reason: `condition not met: ${failed.text} (was "${stringify(failed.left.value)}")`, conditions };
    const open = conditions.find((check) => check.result === undefined);
    if (open || eventMatch.matched === undefined) {
      return { trigger: ref, file, matched: undefined, reason: open ? `cannot compute ${open.text}: ${open.left.source}` : eventMatch.reason, conditions };
    }
    return { trigger: ref, file, matched: true, reason: 'event and every condition match', conditions };
  }

  private async eventMatches(doc: EntityDoc, type: string, ctx: EventContext): Promise<{ matched: boolean | undefined; reason: string; conditions: ConditionCheck[] }> {
    if (type === 'customEvent') {
      const conditions = await this.conditions(doc.data.customEventFilter, ctx);
      const failed = conditions.find((check) => check.result === false);
      if (failed) return { matched: false, reason: `event name "${ctx.event}" does not match ${failed.text}`, conditions };
      return { matched: conditions.every((check) => check.result === true) ? true : undefined, reason: 'custom event name matches', conditions };
    }
    const events = TYPE_EVENTS[type];
    if (!events) return { matched: undefined, reason: `trigger type "${type}" is not evaluated by the debugger`, conditions: [] };
    if (!events.includes(ctx.event ?? '')) return { matched: false, reason: `listens to ${events.join(' / ')}, this event is "${ctx.event}"`, conditions: [] };
    // Auto-event listeners stamp which triggers produced the event (gtm.triggers = "containerNum_triggerId,…").
    const stamped = getPath(ctx.model, 'gtm.triggers');
    const id = this.docs.triggerIds?.get(String(doc.data.name));
    if (typeof stamped === 'string' && id !== undefined && !stamped.split(',').some((item) => item.endsWith(`_${String(id)}`))) {
      return { matched: false, reason: `this ${ctx.event} came from another trigger's listener (gtm.triggers=${stamped})`, conditions: [] };
    }
    return { matched: true, reason: `event is ${ctx.event}`, conditions: [] };
  }

  private async conditions(list: unknown, ctx: EventContext): Promise<ConditionCheck[]> {
    if (!Array.isArray(list)) return [];
    const checks: ConditionCheck[] = [];
    for (const condition of list as Record<string, unknown>[]) checks.push(await this.condition(condition, ctx));
    return checks;
  }

  private async condition(condition: Record<string, unknown>, ctx: EventContext): Promise<ConditionCheck> {
    const params = paramMap(condition.parameter);
    const operator = String(condition.type ?? '');
    const leftRef = String(params.arg0 ?? '');
    const right = String(params.arg1 ?? '');
    const negate = params.negate === 'true';
    const text = `${leftRef} ${negate ? 'NOT ' : ''}${operator} ${right}`;
    const left = await this.resolver.interpolate(leftRef, ctx);
    if (!left.known) return { text, left, right, result: undefined };
    const raw = compare(operator, stringify(left.value), right, params.ignore_case === 'true');
    return { text, left, right, result: raw === undefined ? undefined : negate ? !raw : raw };
  }
}

/** GTM's condition operators (API spelling; export spelling is normalised before this). */
export function compare(operator: string, left: string, right: string, ignoreCase = false): boolean | undefined {
  const a = ignoreCase ? left.toLowerCase() : left;
  const b = ignoreCase ? right.toLowerCase() : right;
  switch (operator.toLowerCase().replace(/_/g, '')) {
    case 'equals':
      return a === b;
    case 'contains':
      return a.includes(b);
    case 'startswith':
      return a.startsWith(b);
    case 'endswith':
      return a.endsWith(b);
    case 'matchregex':
      try {
        return new RegExp(right, ignoreCase ? 'i' : '').test(left);
      } catch {
        return undefined;
      }
    case 'less':
      return Number(a) < Number(b);
    case 'lessorequals':
      return Number(a) <= Number(b);
    case 'greater':
      return Number(a) > Number(b);
    case 'greaterorequals':
      return Number(a) >= Number(b);
    default:
      return undefined; // cssSelector and friends need the element itself
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function scheduleProblem(data: Readonly<Record<string, unknown>>, now = Date.now()): string | undefined {
  const start = Number(data.scheduleStartMs);
  const end = Number(data.scheduleEndMs);
  if (Number.isFinite(start) && start > 0 && now < start) return `The tag is scheduled to start ${new Date(start).toISOString()}.`;
  if (Number.isFinite(end) && end > 0 && now > end) return `The tag's schedule ended ${new Date(end).toISOString()}.`;
  return undefined;
}

/** Tag-level "additional consent" (consentSettings.consentStatus = needed) vs the consent state at the event. */
function consentProblem(data: Readonly<Record<string, unknown>>, ctx: EventContext): string | undefined {
  const settings = data.consentSettings as { consentStatus?: string; consentType?: { list?: { value?: string }[] } } | undefined;
  if (settings?.consentStatus !== 'needed') return undefined;
  const needed = (settings.consentType?.list ?? []).map((item) => item.value).filter((value): value is string => !!value);
  const missing = needed.filter((type) => ctx.consent[type] !== true);
  return missing.length ? `it requires consent that was not granted at this event: ${missing.join(', ')}.` : undefined;
}
