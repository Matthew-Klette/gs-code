import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Live check of auto-pull in a real VS Code against a real GTM mirror (never run in CI).
 *   GSCODE_LIVE_MIRROR=~/gtm-mirrors/<mirror> GSCODE_LIVE_FILE=tags/X.html npm run test:live
 * Signs in with the gscode CLI credentials, then waits for GSCODE_LIVE_FILE to change by itself
 * while you edit that entity in the GTM UI.
 */
const VSCODE = process.env.VSCODE_PATH ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const INTERVAL_SECONDS = 15;

async function main(): Promise<void> {
  const mirror = process.env.GSCODE_LIVE_MIRROR;
  const file = process.env.GSCODE_LIVE_FILE;
  if (!mirror || !file) throw new Error('Set GSCODE_LIVE_MIRROR and GSCODE_LIVE_FILE.');
  const profile = await mkdtemp(path.join(tmpdir(), 'gscode-live-'));
  await mkdir(path.join(profile, 'data', 'User'), { recursive: true });
  await writeFile(path.join(profile, 'data', 'User', 'settings.json'), JSON.stringify({ 'gsCode.autoPull.intervalSeconds': INTERVAL_SECONDS }));
  await runTests({
    vscodeExecutablePath: VSCODE,
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, 'liveSuite.js'),
    launchArgs: [mirror, '--user-data-dir', path.join(profile, 'data'), '--extensions-dir', path.join(profile, 'ext'), '--disable-workspace-trust', '--skip-welcome'],
    extensionTestsEnv: { GSCODE_LIVE_MIRROR: mirror, GSCODE_LIVE_FILE: file, GSCODE_LIVE_TIMEOUT: process.env.GSCODE_LIVE_TIMEOUT ?? '600' },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
