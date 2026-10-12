import { spawn } from 'node:child_process';
import { GtmError } from '../core/types';

/** Google's official server-side tagging image (free; Docker runs it locally, no Cloud project needed). */
export const SGTM_IMAGE = 'gcr.io/cloud-tagging-10302018/gtm-cloud-image:stable';

export interface LocalSgtmOptions {
  /** CONTAINER_CONFIG from GTM → Admin → Container settings (server container). */
  readonly config: string;
  readonly port: number;
  readonly previewPort: number;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

function assertPort(flag: string, port: number): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new GtmError(`${flag} must be a whole number from ${MIN_PORT} to ${MAX_PORT} (got ${String(port)}).`);
  }
}

/** User-defined docker network both containers join, so the tagging server finds the preview server by name. */
export const SGTM_NETWORK = 'gscode-sgtm';
const PREVIEW_NAME = 'gscode-sgtm-preview';
const TAGGING_NAME = 'gscode-sgtm';
/** Port the official image listens on inside the container. */
const CONTAINER_PORT = 8080;

/** Creates the network. Fails with "already exists" when an earlier run made it, which `ensureSgtmNetwork` accepts. */
export const NETWORK_CREATE_COMMAND: readonly string[] = ['docker', 'network', 'create', SGTM_NETWORK];

/**
 * The two `docker run` commands: a preview server and a tagging server that forwards preview traffic to it.
 * Both run on SGTM_NETWORK (the tagging server reaches the preview server as http://gscode-sgtm-preview:8080,
 * on every Docker, including native Linux). Host ports are published on 127.0.0.1 only. CONTAINER_CONFIG is
 * passed by name (`-e CONTAINER_CONFIG`), so its value never shows in `ps`; `runLocalSgtm` puts it in
 * docker's environment instead.
 */
export function localSgtmCommands(options: LocalSgtmOptions): string[][] {
  if (!/^[A-Za-z0-9+/=_-]{20,}$/.test(options.config)) throw new GtmError('That does not look like a CONTAINER_CONFIG value (GTM → Admin → Container settings).');
  assertPort('--port', options.port);
  assertPort('--preview-port', options.previewPort);
  if (options.port === options.previewPort) throw new GtmError('--port and --preview-port must be different.');
  const preview = [
    'docker', 'run', '--rm', '--name', PREVIEW_NAME, '--network', SGTM_NETWORK,
    '-p', `127.0.0.1:${options.previewPort}:${CONTAINER_PORT}`,
    '-e', 'CONTAINER_CONFIG',
    '-e', 'RUN_AS_PREVIEW_SERVER=true',
    SGTM_IMAGE,
  ];
  const tagging = [
    'docker', 'run', '--rm', '--name', TAGGING_NAME, '--network', SGTM_NETWORK,
    '-p', `127.0.0.1:${options.port}:${CONTAINER_PORT}`,
    '-e', 'CONTAINER_CONFIG',
    '-e', `PREVIEW_SERVER_URL=http://${PREVIEW_NAME}:${CONTAINER_PORT}`,
    SGTM_IMAGE,
  ];
  return [preview, tagging];
}

export interface CommandOutcome {
  readonly code: number | null;
  readonly stderr: string;
}

export type RunCommand = (command: readonly string[]) => Promise<CommandOutcome>;

/** Run a command to completion, collecting stderr. Rejects only when it cannot start (docker not installed). */
const runToEnd: RunCommand = (command) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command;
    const child = spawn(file as string, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += String(chunk)));
    child.on('error', (error) => reject(new GtmError(`Could not start docker: ${error.message}. Is Docker installed and running?`)));
    child.on('close', (code) => resolve({ code, stderr }));
  });

/** Create SGTM_NETWORK unless it exists. Only docker's "already exists" answer is accepted; any other failure throws. */
export async function ensureSgtmNetwork(run: RunCommand = runToEnd): Promise<void> {
  const { code, stderr } = await run(NETWORK_CREATE_COMMAND);
  if (code === 0) return;
  if (/already exists/i.test(stderr)) return;
  throw new GtmError(`Could not create the docker network "${SGTM_NETWORK}": ${stderr.trim() || `docker exited with ${String(code)}`}`);
}

/** Start both containers in the foreground; Ctrl+C stops them. Their logs (logToConsole) stream here. */
export async function runLocalSgtm(options: LocalSgtmOptions, log: (line: string) => void): Promise<void> {
  const commands = localSgtmCommands(options);
  await ensureSgtmNetwork();
  const env = { ...process.env, CONTAINER_CONFIG: options.config };
  const children = commands.map(([command, ...args]) => {
    const child = spawn(command as string, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const name = args[3];
    child.stdout?.on('data', (chunk: Buffer) => String(chunk).split('\n').filter(Boolean).forEach((line) => log(`[${name}] ${line}`)));
    child.stderr?.on('data', (chunk: Buffer) => String(chunk).split('\n').filter(Boolean).forEach((line) => log(`[${name}] ${line}`)));
    child.on('error', (error) => log(`[${name}] could not start docker: ${error.message}`));
    return child;
  });
  log(`Tagging server: http://localhost:${options.port}  (point a test page or your sGTM host setting at it)`);
  log(`Preview server: http://localhost:${options.previewPort}`);
  log('These send real requests to vendors when tags fire: use test ids, or block egress.');
  await new Promise<void>((resolve) => {
    let open = children.length;
    for (const child of children) child.on('exit', () => --open === 0 && resolve());
    process.once('SIGINT', () => children.forEach((child) => child.kill('SIGINT')));
  });
}
