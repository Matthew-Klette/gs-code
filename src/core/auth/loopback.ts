import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GtmError } from '../types';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

export interface Loopback {
  readonly redirectUri: string;
  readonly state: string;
  readonly code: Promise<string>;
  /**
   * Finish with the address the browser ended on (`http://127.0.0.1:PORT/?state=…&code=…`). For machines
   * the browser cannot reach (Codespaces, SSH without port forwarding, headless servers): the browser shows
   * "can't connect", and the user pastes that address instead.
   *
   * Returns why a paste was ignored (not an address, or from another sign-in attempt); the sign-in keeps
   * waiting so the user can paste again. A real failure (Google returned an error) rejects `code`.
   */
  submitRedirect(address: string): string | undefined;
  close(): void;
}

/** Listen on 127.0.0.1 (random port) for Google's OAuth redirect. */
export async function waitForLoopbackCode(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Loopback> {
  const state = randomBytes(16).toString('hex');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  code.catch(() => undefined);

  /** Outcome of one redirect (served or pasted): 'ok', 'stray' (not ours) or 'failed'. */
  const accept = (params: URLSearchParams): 'ok' | 'stray' | 'failed' => {
    if (params.get('state') !== state) return 'stray'; // only Google's redirect carries our state
    const error = params.get('error');
    const returnedCode = params.get('code');
    if (error || !returnedCode) {
      rejectCode(new GtmError(`Sign-in was not completed (${error ?? 'no code'}).`));
      return 'failed';
    }
    resolveCode(returnedCode);
    return 'ok';
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const outcome = accept(url.searchParams);
    if (outcome === 'stray') {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in failed', 'State mismatch. Start the sign-in again.'));
    } else if (outcome === 'failed') {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in cancelled', 'You can close this tab.'));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Signed in to Google Tag Manager', 'You can close this tab and return to your editor or terminal.'));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => rejectCode(new GtmError('Sign-in timed out.')), timeoutMs);

  return {
    redirectUri: `http://127.0.0.1:${port}`,
    state,
    code,
    submitRedirect: (address: string) => {
      let params: URLSearchParams;
      try {
        params = new URL(address.trim()).searchParams;
      } catch {
        return 'That is not the address from the browser. Copy the whole address bar (it starts with http://127.0.0.1).';
      }
      if (accept(params) === 'stray') return 'That address belongs to a different sign-in attempt. Paste the address from this one.';
      return undefined;
    },
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
