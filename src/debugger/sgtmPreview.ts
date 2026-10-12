import { GtmError } from '../core/types';
import { isSgtmHost, type Hit } from './hits';

/**
 * Server-side GTM preview, the free and supported way: Tag Assistant's "Send requests manually" gives an
 * `X-Gtm-Server-Preview` header (base64 of `gtm_debug|gtm_preview|gtm_auth`, valid for that preview
 * session). Replaying a captured request with it makes the request show up in your own sGTM preview,
 * with the claiming client, tags fired and outgoing requests. GS Code never reads the preview server.
 */
export interface PreviewHeaderInfo {
  readonly debug: string;
  readonly environment: string;
  readonly auth: string;
}

export function decodePreviewHeader(value: string): PreviewHeaderInfo {
  let decoded: string;
  try {
    decoded = Buffer.from(value.trim(), 'base64').toString('utf8');
  } catch {
    throw new GtmError('That is not an X-Gtm-Server-Preview value (expected base64).');
  }
  const [debug, environment, auth] = decoded.split('|');
  if (!debug || !environment || !auth || !/^env-\d+$/.test(environment)) {
    throw new GtmError('That is not an X-Gtm-Server-Preview value. In sGTM preview open "Send requests manually" and copy the header value.');
  }
  return { debug, environment, auth };
}

export interface ReplayResult {
  readonly status: number;
  readonly body: string;
}

export interface ReplayOptions {
  /** The configured server-container hosts (gsCode.debug.sgtmHosts / GSCODE_SGTM_HOSTS). Replay only goes to these. */
  readonly sgtmHosts?: readonly string[];
  readonly fetchImpl?: typeof fetch;
}

const REPLAY_METHODS = new Set(['GET', 'POST']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Where a captured hit may be replayed to, or an error. The page decides which requests get captured, so
 * the target must be a configured sGTM host (exact or subdomain, as for recording), over https (plain http
 * only for a configured localhost / 127.0.0.1 entry), with GET or POST. Anything else would let a page
 * point the developer machine, and the preview header, at an arbitrary host.
 */
export function replayTarget(hit: Hit, sgtmHosts: readonly string[] = []): URL {
  const hosts = sgtmHosts.map((entry) => entry.trim()).filter(Boolean);
  if (hosts.length === 0) {
    throw new GtmError('Replay needs your server container host. Set gsCode.debug.sgtmHosts in VS Code or GSCODE_SGTM_HOSTS=sgtm.example.com for the CLI and MCP server.');
  }
  let url: URL;
  try {
    url = new URL(hit.url);
  } catch {
    throw new GtmError(`Not replaying ${hit.url.slice(0, 120)}: not a valid URL.`);
  }
  if (!isSgtmHost(url.hostname, hosts)) throw new GtmError(`Not replaying a request to ${url.hostname}: it is not one of the configured sgtmHosts (${hosts.join(', ')}).`);
  if (url.username || url.password) throw new GtmError(`Not replaying a request to ${url.hostname}: the URL carries credentials.`);
  const loopback = LOOPBACK_HOSTS.has(url.hostname) && hosts.some((entry) => entry.toLowerCase() === url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new GtmError(`Not replaying ${url.protocol}//${url.hostname}: replay uses https only (http only for a configured localhost or 127.0.0.1).`);
  const method = hit.method.toUpperCase();
  if (!REPLAY_METHODS.has(method)) throw new GtmError(`Not replaying a ${hit.method} request: only GET and POST are replayed.`);
  return url;
}

/** Re-send a captured first-party hit to the server container with the preview header. */
export async function replayWithPreview(hit: Hit, header: string, options: ReplayOptions = {}): Promise<ReplayResult> {
  decodePreviewHeader(header);
  if (!hit.firstParty) throw new GtmError('Only requests to your server container can be replayed into sGTM preview.');
  // Checked here, right before the request, so every replayed hit is checked on its own.
  const url = replayTarget(hit, options.sgtmHosts);
  const method = hit.method.toUpperCase();
  const response = await (options.fetchImpl ?? fetch)(url.href, {
    method,
    headers: { 'X-Gtm-Server-Preview': header.trim(), ...(hit.body ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {}) },
    body: method === 'GET' ? undefined : hit.body,
    redirect: 'manual',
  });
  return { status: response.status, body: (await response.text()).slice(0, 4000) };
}
