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

/** The two `docker run` commands: a preview server and a tagging server that forwards preview traffic to it. */
export function localSgtmCommands(options: LocalSgtmOptions): string[][] {
  if (!/^[A-Za-z0-9+/=_-]{20,}$/.test(options.config)) throw new GtmError('That does not look like a CONTAINER_CONFIG value (GTM → Admin → Container settings).');
  const preview = ['docker', 'run', '--rm', '--name', 'gscode-sgtm-preview', '-p', `${options.previewPort}:8080`, '-e', `CONTAINER_CONFIG=${options.config}`, '-e', 'RUN_AS_PREVIEW_SERVER=true', SGTM_IMAGE];
  const tagging = [
    'docker', 'run', '--rm', '--name', 'gscode-sgtm', '-p', `${options.port}:8080`,
    '-e', `CONTAINER_CONFIG=${options.config}`,
    '-e', `PREVIEW_SERVER_URL=http://host.docker.internal:${options.previewPort}`,
    '--add-host', 'host.docker.internal:host-gateway',
    SGTM_IMAGE,
  ];
  return [preview, tagging];
}

/** Start both containers in the foreground; Ctrl+C stops them. Their logs (logToConsole) stream here. */
export async function runLocalSgtm(options: LocalSgtmOptions, log: (line: string) => void): Promise<void> {
  const commands = localSgtmCommands(options);
  const children = commands.map(([command, ...args]) => {
    const child = spawn(command as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
