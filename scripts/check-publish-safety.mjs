#!/usr/bin/env node
// Fails if anything tracked by git looks like real GTM data: a mirror folder,
// its .gtm state, or a container export. This repo ships the extension only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const problems = [];
for (const file of tracked) {
  if (/(^|\/)\.gtm\//.test(file)) problems.push(`${file}: GTM mirror state`);
  if (/(^|\/)GTM-[A-Z0-9]+/.test(file)) problems.push(`${file}: named after a GTM container`);
  if (!/\.(json|md|ts|mjs|mts|js)$/.test(file) || file === 'package-lock.json') continue;
  const text = readFileSync(file, 'utf8');
  if (/"exportFormatVersion"\s*:/.test(text) || /"containerVersion"\s*:\s*\{/.test(text)) problems.push(`${file}: looks like a GTM container export`);
  if (/"tagManagerUrl"\s*:\s*"https:\/\/tagmanager\.google\.com\/#\/container\/accounts\/\d{6,}/.test(text)) problems.push(`${file}: contains a real Tag Manager URL`);
}

if (problems.length) {
  process.stderr.write(`Publish safety check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Publish safety check passed (${tracked.length} files, no GTM data).\n`);
