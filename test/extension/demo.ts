import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stages a few edits and shows the Source Control view + a diff, then idles for a screenshot. */
export async function run(): Promise<void> {
  const mirror = process.env.GSCODE_MIRROR as string;
  await vscode.extensions.getExtension('matthew-klette.gs-code')?.activate();
  const tagFile = path.join(mirror, 'tags', 'GA4 - purchase.json');
  const tag = JSON.parse(await readFile(tagFile, 'utf8'));
  tag.parameter.push({ type: 'TEMPLATE', key: 'currency', value: 'USD' });
  tag.notes = 'Bulk edit from VS Code';
  await writeFile(tagFile, `${JSON.stringify(tag, null, 2)}\n`);
  await writeFile(path.join(mirror, 'tags', 'cHTML - hello.html'), '<script>\n  console.log("edited in VS Code");\n</script>');
  await writeFile(path.join(mirror, 'triggers', 'CE - signup.json'), `${JSON.stringify({ name: 'CE - signup', type: 'customEvent', customEventFilter: [] }, null, 2)}\n`);
  await sleep(1500);
  await vscode.commands.executeCommand('workbench.view.scm');
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(path.join(mirror, '.gtm/base/tags/GA4 - purchase.json')), vscode.Uri.file(tagFile), 'GA4 - purchase.json (GTM ↔ Local)');
  await sleep(Number(process.env.GSCODE_DEMO_MS ?? 25_000));
}
