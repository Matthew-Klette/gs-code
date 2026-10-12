import type { GtmApi } from '../core/api';
import { readModel } from '../core/mirror/model';
import type { MirrorState } from '../core/mirror/state';
import { isServerContainer } from '../core/ops/pull';
import type { EntityDoc } from '../core/serialize/entityFiles';
import { GtmError } from '../core/types';
import type { MirrorDocs } from './explain';
import type { Hit } from './hits';
import type { DraftPreview } from './session';
import type { Timeline, TimelineEvent } from './timeline';
import { paramMap, type EventContext } from './variables';

/** The mirror's tags, triggers and variables, as the explainer needs them. */
export async function loadMirrorDocs(root: string, state: MirrorState): Promise<MirrorDocs & { readonly clients: readonly EntityDoc[]; readonly tagNames: ReadonlyMap<string, string> }> {
  const { model } = await readModel(root, isServerContainer(state));
  const docs = [...model.docs.values()];
  const of = (kind: EntityDoc['kind']) => docs.filter((doc) => doc.kind === kind);
  const idsOf = (kind: EntityDoc['kind']) =>
    new Map(Object.entries(state.entities).filter(([, entry]) => entry.kind === kind).map(([base, entry]) => [base, entry.id]));
  const triggerIdByBase = idsOf('trigger');
  const tagIdByBase = idsOf('tag');
  return {
    tags: of('tag'),
    triggers: of('trigger'),
    variables: of('variable'),
    clients: of('client'),
    builtInNames: state.builtInNames,
    triggerIds: new Map(of('trigger').flatMap((doc) => (triggerIdByBase.get(doc.base) ? [[String(doc.data.name), triggerIdByBase.get(doc.base) as string]] : []))),
    tagNames: new Map(of('tag').flatMap((doc) => (tagIdByBase.get(doc.base) ? [[tagIdByBase.get(doc.base) as string, String(doc.data.name)]] : []))),
  };
}

/**
 * Preview credentials for the mirrored workspace: `quick_preview` compiles it (and makes GTM create
 * the workspace's preview environment), then the environment with `type: workspace` for this
 * workspace gives `gtm_auth` and `env-N`. Nothing is published.
 */
export async function resolveWorkspacePreview(api: GtmApi, state: MirrorState): Promise<DraftPreview> {
  const compiled = await api.quickPreview(state.workspace);
  if (compiled.compilerError) {
    throw new GtmError('GTM cannot compile this workspace (a compiler error: usually an unknown variable or a broken template). Fix the Problems shown for the mirror, push, then debug again.');
  }
  const { accountId, containerId } = state.container;
  const environments = await api.listEnvironments(accountId, containerId);
  const env = environments.find((item) => item.type === 'workspace' && item.workspaceId === state.workspace.workspaceId);
  if (!env?.authorizationCode) {
    throw new GtmError(`GTM returned no preview environment for workspace "${state.workspace.name}". Click Preview once in the GTM UI for this workspace, then try again.`);
  }
  return { publicId: state.container.publicId, gtmAuth: env.authorizationCode, gtmPreview: `env-${env.environmentId}` };
}

export function eventContext(timeline: Timeline, event: TimelineEvent, containerPublicId: string): EventContext {
  return {
    event: typeof event.data?.event === 'string' ? event.data.event : event.event,
    model: event.model,
    pageUrl: event.url,
    containerPublicId,
    consent: event.consent,
    referrer: undefined,
  };
}

export interface ClientPrediction {
  readonly client?: string;
  readonly file?: string;
  readonly confidence: 'likely' | 'unknown';
  readonly reason: string;
}

/**
 * Which server-container client would claim a request. GTM runs clients by priority and the first one
 * that claims wins; built-in clients claim known paths, custom ones are guessed from a path parameter.
 * This is a prediction from the files, labelled as such: the real answer is only in sGTM preview.
 */
export function predictClient(hit: Hit, clients: readonly EntityDoc[]): ClientPrediction {
  const ordered = [...clients].sort((a, b) => Number(b.data.priority ?? 0) - Number(a.data.priority ?? 0));
  for (const doc of ordered) {
    const type = String(doc.data.type ?? '');
    const params = paramMap(doc.data.parameter);
    const file = `${doc.base}.json`;
    const name = String(doc.data.name);
    if (/gaaw|ga4/i.test(type) && /\/g\/collect$|\/j\/collect$/.test(hit.path)) {
      return { client: name, file, confidence: 'likely', reason: `GA4 client claims ${hit.path}` };
    }
    if (/gtm/i.test(type) && /\/gtm\.js$|\/gtag\/js$|\/ns\.html$/.test(hit.path)) {
      return { client: name, file, confidence: 'likely', reason: `Web Container client serves ${hit.path}` };
    }
    const declared = Object.entries(params).find(([key]) => /path|endpoint/i.test(key))?.[1];
    if (typeof declared === 'string' && declared && hit.path.startsWith(declared.startsWith('/') ? declared : `/${declared}`)) {
      return { client: name, file, confidence: 'likely', reason: `its ${declared} path matches ${hit.path}` };
    }
  }
  return { confidence: 'unknown', reason: `no client in the mirror obviously claims ${hit.path}; check with sGTM preview (replay with the preview header)` };
}
