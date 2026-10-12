import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GtmError } from '../core/types';
import { CdpConnection } from './cdp';

/**
 * The browser the debugger drives. GS Code never downloads a browser: it launches the Chrome, Edge,
 * Brave or Chromium already installed, with a dedicated profile (Chrome ignores remote debugging on
 * the default profile), or attaches to any Chromium browser that already exposes the DevTools
 * protocol (`--remote-debugging-port`).
 */
export interface BrowserOptions {
  /** Attach instead of launching, e.g. `http://127.0.0.1:9222`. */
  readonly browserUrl?: string;
  /** Path to a Chromium-based browser executable. Default: the first one found. */
  readonly executablePath?: string;
  /** Profile directory for a launched browser (kept between sessions so consent choices stick). */
  readonly profileDir: string;
  readonly headless?: boolean;
}

export interface Browser {
  readonly cdp: CdpConnection;
  /** True when GS Code started the browser (and should close it at the end). */
  readonly launched: boolean;
  close(): Promise<void>;
}

const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'],
};

export function findBrowser(platform = process.platform, exists: (file: string) => boolean = existsSync): string | undefined {
  return (CANDIDATES[platform] ?? CANDIDATES.linux ?? []).find((file) => file && exists(file));
}

export async function openBrowser(options: BrowserOptions): Promise<Browser> {
  if (options.browserUrl) {
    const cdp = await CdpConnection.connect(await browserWebSocketUrl(options.browserUrl));
    return { cdp, launched: false, close: async () => cdp.close() };
  }
  const executable = options.executablePath ?? findBrowser();
  if (!executable) {
    throw new GtmError('No Chrome, Edge, Brave or Chromium found. Install one, or set gsCode.debug.browserPath (or attach to a running browser with gsCode.debug.browserUrl).');
  }
  await fs.mkdir(options.profileDir, { recursive: true });
  const portFile = path.join(options.profileDir, 'DevToolsActivePort');
  await fs.rm(portFile, { force: true });
  const args = [
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const child = spawn(executable, args, { stdio: 'ignore' });
  const exited = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code) => reject(new GtmError(`The browser exited before it was ready (code ${code ?? 'none'}). Is another copy using ${options.profileDir}?`)));
    child.once('error', (error) => reject(new GtmError(`Could not start ${executable}: ${error.message}`)));
  });
  const wsUrl = await Promise.race([readPortFile(portFile), exited]);
  const cdp = await CdpConnection.connect(wsUrl);
  return { cdp, launched: true, close: () => closeLaunched(cdp, child) };
}

/** Chrome writes "<port>\n<browser ws path>" once its DevTools server is listening. */
async function readPortFile(file: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [port, wsPath] = (await fs.readFile(file, 'utf8')).split('\n');
      if (port && wsPath) return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new GtmError('The browser did not open its DevTools port in time.');
}

/** `http://127.0.0.1:9222` → the browser-level WebSocket URL from /json/version. */
export async function browserWebSocketUrl(browserUrl: string): Promise<string> {
  if (browserUrl.startsWith('ws://') || browserUrl.startsWith('wss://')) return browserUrl;
  const response = await fetch(new URL('/json/version', browserUrl)).catch((error: unknown) => {
    throw new GtmError(`No browser answering at ${browserUrl} (${error instanceof Error ? error.message : String(error)}). Start it with --remote-debugging-port.`);
  });
  const info = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) throw new GtmError(`${browserUrl} did not report a DevTools WebSocket URL.`);
  return info.webSocketDebuggerUrl;
}

async function closeLaunched(cdp: CdpConnection, child: ChildProcess): Promise<void> {
  await cdp.send('Browser.close').catch(() => undefined);
  cdp.close();
  setTimeout(() => {
    if (child.exitCode === null) child.kill();
  }, 3000).unref();
}
