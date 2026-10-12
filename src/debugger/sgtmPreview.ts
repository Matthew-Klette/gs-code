import { GtmError } from '../core/types';
import type { Hit } from './hits';

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

/** Re-send a captured first-party hit to the server container with the preview header. */
export async function replayWithPreview(hit: Hit, header: string, fetchImpl: typeof fetch = fetch): Promise<ReplayResult> {
  decodePreviewHeader(header);
  if (!hit.firstParty) throw new GtmError('Only requests to your server container can be replayed into sGTM preview.');
  const response = await fetchImpl(hit.url, {
    method: hit.method,
    headers: { 'X-Gtm-Server-Preview': header.trim(), ...(hit.body ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {}) },
    body: hit.method === 'GET' || hit.method === 'HEAD' ? undefined : hit.body,
    redirect: 'manual',
  });
  return { status: response.status, body: (await response.text()).slice(0, 4000) };
}
