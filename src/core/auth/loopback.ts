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

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const returnedCode = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state) {
      // Ignore stray requests; only Google's redirect carries our state.
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in failed', 'State mismatch. Start the sign-in again from VS Code.'));
      return;
    }
    if (error || !returnedCode) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(PAGE('Sign-in cancelled', 'You can close this tab.'));
      rejectCode(new GtmError(`Sign-in was not completed (${error ?? 'no code'}).`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE('Signed in to Google Tag Manager', 'You can close this tab and return to VS Code.'));
    resolveCode(returnedCode);
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
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
