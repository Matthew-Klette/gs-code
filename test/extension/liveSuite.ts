import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GsCodeExtensionApi } from '../../src/extension/extension';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const time = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const log = (line: string) => process.stdout.write(`  [${time()}] ${line}\n`);

export async function run(): Promise<void> {
  const mirror = process.env.GSCODE_LIVE_MIRROR as string;
  const target = path.join(mirror, process.env.GSCODE_LIVE_FILE as string);
  const timeoutMs = Number(process.env.GSCODE_LIVE_TIMEOUT) * 1000;
  const api = await vscode.extensions.getExtension<GsCodeExtensionApi>('matthew-klette.gs-code')!.activate();
  assert.equal(await vscode.commands.executeCommand('gsCode.importCliSignIn'), true, 'imported the CLI sign-in');
  const start = Date.now();
  let controller = api.controllers().find((item) => item.root === mirror);
  while (!controller?.autoPull.lastCheckedAt) {
    if (Date.now() - start > 120_000) throw new Error(`no successful check: ${String(controller?.autoPull.lastError)}`);
    await sleep(500);
    controller = api.controllers().find((item) => item.root === mirror);
  }
  log(`extension signed in, first auto-pull check done (${controller.label}), auto-pull active=${controller.autoPull.active}`);
  const before = await readFile(target, 'utf8');
  log(`READY: change ${process.env.GSCODE_LIVE_FILE} in the GTM UI now. Watching (no Pull command will be run)…`);
  let checks = 0;
  let lastChecked = controller.autoPull.lastCheckedAt;
  for (;;) {
    await sleep(1000);
    if (controller.autoPull.lastCheckedAt !== lastChecked) {
      lastChecked = controller.autoPull.lastCheckedAt;
      checks++;
      log(`auto-pull check #${checks}${controller.autoPull.lastPulledAt === lastChecked ? ' → pulled' : ' → no changes'}`);
    }
    const now = await readFile(target, 'utf8');
    if (now !== before) {
      log(`PICKED UP by auto-pull: ${process.env.GSCODE_LIVE_FILE} changed on disk. Status bar: "${controller.label}", scm count ${controller.scm.count}`);
      log(`last 3 lines now:\n${now.split('\n').slice(-3).join('\n')}`);
      assert.equal(controller.scm.count, 0, 'a remote-only change leaves nothing to push');
      return;
    }
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the remote change');
  }
}
