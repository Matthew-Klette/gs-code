/** A network request that is a measurement hit, classified by vendor. */
export interface Hit {
  readonly vendor: HitVendor;
  readonly url: string;
  readonly host: string;
  readonly path: string;
  readonly method: string;
  /** Request time (ms since epoch). */
  readonly t: number;
  /** One entry per event in the request (GA4 batches several events in one POST body). */
  readonly events: readonly Record<string, string>[];
  /** GA4 `en`, Meta `ev`, Ads conversion label… whatever names the event, when known. */
  readonly name?: string;
  /** Measurement / pixel / tag id (GA4 `tid`, Meta `id`, Ads conversion id). */
  readonly id?: string;
  /** Sent to the server container (a first-party host) rather than to the vendor. */
  readonly firstParty: boolean;
  status?: number;
  responseBody?: string;
  setCookies?: readonly string[];
}

export type HitVendor = 'ga4' | 'google-ads' | 'floodlight' | 'meta' | 'bing' | 'tiktok' | 'linkedin' | 'pinterest' | 'snapchat' | 'criteo' | 'clarity' | 'reddit' | 'sgtm' | 'gtm';

interface Rule {
  readonly vendor: HitVendor;
  readonly match: (url: URL) => boolean;
  readonly name?: (event: Record<string, string>, url: URL) => string | undefined;
  readonly id?: (event: Record<string, string>, url: URL) => string | undefined;
}

const host = (url: URL, ...suffixes: string[]) => suffixes.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));

const RULES: readonly Rule[] = [
  { vendor: 'gtm', match: (url) => /\/gtm\.js$|\/gtag\/js$/.test(url.pathname) || (host(url, 'googletagmanager.com') && url.pathname === '/gtm.js'), id: (_e, url) => url.searchParams.get('id') ?? undefined },
  { vendor: 'ga4', match: (url) => /\/g\/collect$/.test(url.pathname), name: (e) => e.en, id: (e) => e.tid },
  {
    vendor: 'google-ads',
    match: (url) => (host(url, 'doubleclick.net', 'googleadservices.com', 'google.com') && /\/pagead\/(viewthrough)?conversion|\/ccm\/collect|\/pagead\/1p-conversion/.test(url.pathname)),
    name: (e) => e.label,
    id: (_e, url) => /\/conversion\/(\d+)/.exec(url.pathname)?.[1] ?? /\/viewthroughconversion\/(\d+)/.exec(url.pathname)?.[1],
  },
  { vendor: 'floodlight', match: (url) => host(url, 'fls.doubleclick.net') || /\/activityi?;/.test(url.pathname), name: (_e, url) => /cat=([^;]+)/.exec(url.pathname)?.[1] },
  { vendor: 'meta', match: (url) => host(url, 'facebook.com') && url.pathname === '/tr' || (host(url, 'facebook.com') && url.pathname === '/tr/'), name: (e) => e.ev, id: (e) => e.id },
  { vendor: 'bing', match: (url) => host(url, 'bat.bing.com') && url.pathname.startsWith('/action'), name: (e) => e.ea ?? e.evt, id: (e) => e.ti },
  { vendor: 'tiktok', match: (url) => host(url, 'analytics.tiktok.com') && url.pathname.includes('/pixel') },
  { vendor: 'linkedin', match: (url) => host(url, 'px.ads.linkedin.com') },
  { vendor: 'pinterest', match: (url) => host(url, 'ct.pinterest.com'), name: (e) => e.event, id: (e) => e.tid },
  { vendor: 'snapchat', match: (url) => host(url, 'tr.snapchat.com') },
  { vendor: 'criteo', match: (url) => host(url, 'criteo.com', 'criteo.net') && !/\.js$/.test(url.pathname) },
  { vendor: 'clarity', match: (url) => host(url, 'clarity.ms') && url.pathname.includes('/collect') },
  { vendor: 'reddit', match: (url) => host(url, 'alb.reddit.com') && url.pathname.startsWith('/rp.gif') },
];

const GOOGLE_HOSTS = ['google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'doubleclick.net', 'google.com', 'googleadservices.com'];

export interface ClassifyOptions {
  /** Hosts of the user's server container(s), e.g. `sgtm.example.com`. */
  readonly sgtmHosts?: readonly string[];
}

/** `undefined` for ordinary requests. */
export function classifyHit(rawUrl: string, method: string, postData: string | undefined, t: number, options: ClassifyOptions = {}): Hit | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const isSgtmHost = (options.sgtmHosts ?? []).some((name) => url.hostname === name || url.hostname.endsWith(`.${name}`));
  const rule = RULES.find((item) => item.match(url));
  // A GA4 hit to a non-Google host is going to a server container.
  const firstParty = isSgtmHost || (rule?.vendor === 'ga4' && !GOOGLE_HOSTS.some((name) => host(url, name)));
  if (!rule && !isSgtmHost) return undefined;
  const events = parseEvents(url, postData);
  const first = events[0] ?? {};
  return {
    vendor: rule?.vendor ?? 'sgtm',
    url: rawUrl,
    host: url.hostname,
    path: url.pathname,
    method,
    t,
    events,
    name: rule?.name?.(first, url),
    id: rule?.id?.(first, url),
    firstParty,
  };
}

/** Query string merged with each line of a batched (`\r\n`-separated) form body, or a JSON body. */
export function parseEvents(url: URL, postData: string | undefined): Record<string, string>[] {
  const base = Object.fromEntries(url.searchParams.entries());
  const body = postData?.trim();
  if (!body) return [base];
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(body);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((item) => ({ ...base, ...flatten(item) }));
    } catch {
      return [base];
    }
  }
  const lines = body.split(/\r?\n/).filter(Boolean);
  return lines.map((line) => ({ ...base, ...Object.fromEntries(new URLSearchParams(line).entries()) }));
}

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (value === null || typeof value !== 'object') return prefix ? { [prefix]: String(value) } : {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (out, [key, child]) => ({ ...out, ...flatten(child, prefix ? `${prefix}.${key}` : key) }),
    {},
  );
}

/** GA4 `gcs` (G1xy): x = ad_storage, y = analytics_storage granted. */
export function decodeGcs(gcs: string | undefined): { adStorage?: boolean; analyticsStorage?: boolean } {
  const match = /^G1([01-])([01-])$/.exec(gcs ?? '');
  if (!match) return {};
  const bit = (value: string | undefined) => (value === '1' ? true : value === '0' ? false : undefined);
  return { adStorage: bit(match[1]), analyticsStorage: bit(match[2]) };
}
