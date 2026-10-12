import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { initMirror } from '../../src/core/ops/workspace';
import { CONTAINER, seededFake } from '../fakeApi';

const VSCODE = process.env.VSCODE_PATH ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

async function main(): Promise<void> {
  const mirror = await mkdtemp(path.join(tmpdir(), 'gscode-ext-'));
  const gtm = seededFake();
  await initMirror(mirror, gtm, CONTAINER, gtm.workspace);
  const profile = await mkdtemp(path.join(tmpdir(), 'gscode-profile-'));
  await runTests({
    vscodeExecutablePath: VSCODE,
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, 'suite.js'),
    launchArgs: [mirror, '--user-data-dir', path.join(profile, 'data'), '--extensions-dir', path.join(profile, 'ext'), '--disable-workspace-trust', '--skip-welcome', '--disable-gpu'],
    extensionTestsEnv: { GSCODE_MIRROR: mirror },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
