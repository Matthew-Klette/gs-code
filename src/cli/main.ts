import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { HttpGtmApi } from '../core/api';
import { AdcTokenProvider, emailFromTokens, GoogleTokenProvider, parseClientSecretJson, signIn, signOut, StaticTokenProvider } from '../core/auth/oauth';
import type { TokenProvider } from '../core/api';
import { describeChanges, describeConflicts, describeIssues, describePull, describeRefresh } from '../core/format';
import { changeSignature, countChanges, isEmpty } from '../core/mirror/diff';
import { readState } from '../core/mirror/state';
import { workingStatus } from '../core/ops/plan';
import { assertNotProtected, createVersion, publishVersion } from '../core/ops/publish';
import { AutoPull, clampInterval, DEFAULT_INTERVAL_SECONDS } from '../core/ops/autoPull';
import { pushWorkspace } from '../core/ops/push';
import { refreshMirror, resolveGtmConflict, switchWorkspace } from '../core/ops/sync';
import { discardChanges, initMirror, resolveConflict, tidyFileNames } from '../core/ops/workspace';
import { GtmError, WorkspaceGoneError, type WorkspaceInfo } from '../core/types';
import { FileCredentialStore, fileStampStore, loadCliConfig } from './fileStore';
import { RateLimiter } from '../core/rateLimiter';

const HELP = `gscode: edit a Google Tag Manager workspace as files

  gscode login [--client client_secret.json] [--no-publish] [--manual]
                                     --manual: for machines your browser cannot reach (SSH, containers)
  gscode logout [--forget-client]    revokes the sign-in at Google, then forgets it
  gscode whoami                      which Google account and permissions are in use
  gscode accounts
  gscode containers <accountId>
  gscode workspaces <accountId> <GTM-XXXX|containerId>
  gscode init <dir> --account <id> --container <GTM-XXXX|id> --workspace <name|id> [--create] [--adopt]
                                     --adopt: the folder already has mirror files (a git clone); keep them
  gscode tidy [dir]                  rename files to match their GTM names (keeps clones consistent)
  gscode status [dir]
  gscode pull [dir] [--no-sync]      sync the workspace to the latest version, then pull
  gscode watch [dir] [--interval <seconds>] [--verbose]
                                     keep pulling GTM changes as they happen (default every ${DEFAULT_INTERVAL_SECONDS}s)
  gscode push [dir] [--sequential] [--yes]
  gscode switch [dir] (--workspace <name|id> | --new <name>)
                                     follow another workspace (after yours was versioned or deleted)
  gscode discard [dir] [--path <base>]...
  gscode resolve <base> (--mine | --theirs) [--dir dir]
  gscode resolve-gtm <base> (--keep-workspace | --latest) [--dir dir]
  gscode version [dir] --name <name> [--notes <text>] [--publish --confirm <GTM-XXXX>]
  gscode publish [dir] --version <id> --confirm <GTM-XXXX>     publish an existing version

Protected containers (version/publish blocked): ~/.config/gs-code/config.json
{"protectedContainers": ["GTM-XXXXXXX"]} or GSCODE_PROTECTED=GTM-A,GTM-B

CI and servers (no browser):
  GSCODE_AUTH=adc        Application Default Credentials: a service-account key file in
                         GOOGLE_APPLICATION_CREDENTIALS, workload identity federation, or
                         \`gcloud auth application-default login\`. Add the service account's
                         email as a user in GTM. Publishing needs GSCODE_ALLOW_PUBLISH=1.
  GSCODE_ACCESS_TOKEN    use this access token as is
Config dir: GSCODE_CONFIG_DIR, else $XDG_CONFIG_HOME/gs-code, else ~/.config/gs-code`;

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const store = new FileCredentialStore();
const userTokens = new GoogleTokenProvider(store);

/** A browser sign-in by default; ADC or a ready token when the environment asks for it (CI). */
function tokenProvider(): TokenProvider {
  if (process.env.GSCODE_ACCESS_TOKEN) return new StaticTokenProvider(process.env.GSCODE_ACCESS_TOKEN);
  if (process.env.GSCODE_AUTH === 'adc') return new AdcTokenProvider(process.env.GSCODE_ALLOW_PUBLISH === '1');
  return userTokens;
}

const api = new HttpGtmApi(tokenProvider(), {
  limiter: new RateLimiter(undefined, undefined, undefined, (ms) => process.stderr.write(`  waiting ${Math.ceil(ms / 1000)}s for the GTM API quota…\n`), fileStampStore()),
  onRetry: (attempt, delayMs, reason) => process.stderr.write(`  retry ${attempt} in ${Math.round(delayMs / 1000)}s (${reason})\n`),
});

function openBrowser(url: string): void {
  out(`Opening your browser to sign in. If it does not open, visit:\n${url}\n`);
  // Windows: rundll32 takes the URL verbatim; `cmd /c start` would cut it at the first '&'.
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

/** No browser on this machine (or it cannot be reached): sign in elsewhere and paste the final address. */
function isRemoteShell(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.CODESPACES || process.env.REMOTE_CONTAINERS) ||
    (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function resolveContainer(accountId: string, idOrPublic: string) {
  const containers = await api.listContainers(accountId);
  const match = containers.find((c) => c.containerId === idOrPublic || c.publicId.toUpperCase() === idOrPublic.toUpperCase());
  if (!match) throw new GtmError(`Container ${idOrPublic} not found in account ${accountId}.`);
  return match;
}

async function cmdLogin(values: { client?: string; 'no-publish'?: boolean; manual?: boolean }) {
  if (values.client) {
    await store.saveClient(parseClientSecretJson(await fs.readFile(values.client, 'utf8')));
    out('OAuth client saved.');
  }
  const config = await loadCliConfig();
  const manual = values.manual === true || isRemoteShell();
  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    await signIn(store, {
      allowPublish: !values['no-publish'] && config.allowPublish !== false,
      openBrowser: manual ? (url) => out(`Open this address in a browser on any machine and sign in:\n${url}\n`) : openBrowser,
      pasteRedirect: manual
        ? async () => {
            rl = createInterface({ input: process.stdin, output: process.stdout });
            out('The browser then tries to open http://127.0.0.1:… and may show "can\'t connect". That is expected.');
            return rl.question('Paste that whole address here: ');
          }
        : undefined,
    });
  } finally {
    rl?.close();
  }
  const account = emailFromTokens(await store.loadTokens());
  out(`Signed in${account ? ` as ${account}` : ''}.`);
}

async function cmdWhoami() {
  if (process.env.GSCODE_ACCESS_TOKEN) return out('Using GSCODE_ACCESS_TOKEN from the environment.');
  if (process.env.GSCODE_AUTH === 'adc') return out(`Using Application Default Credentials${process.env.GOOGLE_APPLICATION_CREDENTIALS ? ` (${process.env.GOOGLE_APPLICATION_CREDENTIALS})` : ''}.`);
  const tokens = await store.loadTokens();
  if (!tokens?.refresh_token) return out('Not signed in. Run `gscode login`.');
  const scopes = (tokens.scope ?? '').split(' ');
  out(`Signed in as ${emailFromTokens(tokens) ?? '(account unknown: signed in before GS Code asked for it)'}`);
  out(`Publishing: ${scopes.some((scope) => scope.endsWith('tagmanager.publish')) ? 'allowed' : 'not allowed (signed in without the publish scope)'}`);
}

async function cmdInit(dir: string | undefined, values: { account?: string; container?: string; workspace?: string; create?: boolean; adopt?: boolean }) {
  if (!dir || !values.account || !values.container || !values.workspace) throw new GtmError('Usage: gscode init <dir> --account <id> --container <GTM-XXXX|id> --workspace <name|id> [--create]');
  const container = await resolveContainer(values.account, values.container);
  const workspaces = await api.listWorkspaces(container.accountId, container.containerId);
  let workspace = workspaces.find((w) => w.workspaceId === values.workspace || w.name === values.workspace);
  if (!workspace && values.create) workspace = await api.createWorkspace(container.accountId, container.containerId, values.workspace);
  if (!workspace) throw new GtmError(`Workspace "${values.workspace}" not found. Add --create to create it.`);
  const root = path.resolve(dir);
  await fs.mkdir(root, { recursive: true });
  const result = await initMirror(root, api, container, workspace, { adopt: values.adopt === true });
  out(`Mirrored ${container.publicId} / ${workspace.name} into ${root}: ${describePull(result)}`);
}

const stamp = (): string => new Date().toLocaleTimeString('en-GB', { hour12: false });

async function cmdStatus(root: string) {
  const state = await readState(root);
  const status = await workingStatus(root, state);
  out(`${state.container.publicId} (${state.container.name}) / workspace "${state.workspace.name}"`);
  out(`last pull: ${state.pulledAt ?? 'never'}${state.remote?.versionId ? ` (synced to container version ${state.remote.versionId})` : ''}`);
  for (const problem of status.problems) out(`error ${problem.path}: ${problem.message}`);
  describeConflicts(state).forEach((line) => out(line));
  describeIssues(status.issues).forEach((line) => out(line));
  if (isEmpty(status.changes)) out('No local changes.');
  else {
    out(`${countChanges(status.changes)} change(s) to push:`);
    describeChanges(status.changes).forEach((line) => out(`  ${line}`));
  }
}

/** Pull first so the change list is current and conflicts show up before anything is sent. */
async function refreshFirst(root: string) {
  const result = await refreshMirror(root, api, await readState(root), { onProgress: (m) => out(`  ${m}`) });
  if (result.pulled) out(`Pulled from GTM first: ${describeRefresh(result)}`);
  const blockers = describeConflicts(result.state);
  if (blockers.length) {
    blockers.forEach((line) => out(line));
    throw new GtmError('Resolve the conflicts above first. Nothing was sent to GTM.');
  }
  return result.state;
}

async function cmdPull(root: string, values: { 'no-sync'?: boolean }) {
  const result = await refreshMirror(root, api, await readState(root), { force: true, sync: !values['no-sync'], onProgress: (m) => out(`  ${m}`) });
  out(describeRefresh(result));
  if (result.syncSkipped) out(`Note: ${result.syncSkipped}.`);
  if (result.behind && !result.syncSkipped) out(`Container version ${result.behind} is newer than this workspace. Run \`gscode pull\` without --no-sync to bring it up to date.`);
  describeConflicts(result.state).forEach((line) => out(line));
}

async function cmdWatch(root: string, values: { interval?: string; verbose?: boolean }) {
  const state = await readState(root);
  const intervalMs = clampInterval(values.interval === undefined ? undefined : Number(values.interval));
  out(`Watching ${state.container.publicId} / "${state.workspace.name}" every ${intervalMs / 1000}s (2 requests per check, full pull only on change). Ctrl+C to stop.`);
  await new Promise<void>((resolve) => {
    const watcher = new AutoPull(root, api, {
      intervalMs,
      onResult: (result) => {
        if (result.pulled) {
          out(`${stamp()} pulled: ${describeRefresh(result)}`);
          [...(result.pull?.updated ?? []), ...(result.pull?.added ?? [])].forEach((base) => out(`  ~ ${base}`));
          (result.pull?.removed ?? []).forEach((base) => out(`  - ${base}`));
          describeConflicts(result.state).forEach((line) => out(`  ${line}`));
        } else if (values.verbose) out(`${stamp()} no changes`);
        if (result.behind) out(`${stamp()} container version ${result.behind} was published; run \`gscode pull\` to bring this workspace up to date`);
      },
      onError: (error, fatal) => {
        process.stderr.write(`${stamp()} ${fatal ? 'stopped' : 'check failed, retrying with backoff'}: ${error instanceof Error ? error.message : String(error)}\n`);
        if (fatal) {
          process.exitCode = 1;
          resolve();
        }
      },
    });
    process.once('SIGINT', () => {
      watcher.stop();
      out('Stopped.');
      resolve();
    });
    watcher.start();
  });
}

async function cmdPush(root: string, values: { sequential?: boolean; yes?: boolean }) {
  const before = await readState(root);
  if (isEmpty((await workingStatus(root, before)).changes)) return out('Nothing to push.');
  const state = await refreshFirst(root);
  const status = await workingStatus(root, state);
  if (isEmpty(status.changes)) return out('Nothing to push.');
  out(`Push ${countChanges(status.changes)} change(s) to ${state.container.publicId} / "${state.workspace.name}":`);
  describeChanges(status.changes).forEach((line) => out(`  ${line}`));
  describeIssues(status.issues).forEach((line) => out(line));
  // Pin the exact change set shown above: anything saved while the prompt is open stops the push.
  const expected = changeSignature(status.changes);
  if (!values.yes && !(await confirm('Push these changes?'))) return out('Cancelled.');
  const result = await pushWorkspace(root, api, await readState(root), { strategy: values.sequential ? 'sequential' : 'bulk', expected, onProgress: (m) => out(`  ${m}`) });
  out(`Pushed ${result.pushed} change(s).${result.refresh ? ` Refresh: ${describePull(result.refresh)}` : ''}`);
}

async function cmdVersion(root: string, values: { name?: string; notes?: string; publish?: boolean; confirm?: string }) {
  if (!values.name) throw new GtmError('--name is required.');
  const state = await readState(root);
  const config = await loadCliConfig();
  const protectedContainers = config.protectedContainers ?? [];
  assertNotProtected(state, protectedContainers);
  if (values.publish && values.confirm?.toUpperCase() !== state.container.publicId.toUpperCase()) {
    throw new GtmError(`Publishing goes live. Repeat the container id: --confirm ${state.container.publicId}`);
  }
  const current = await refreshFirst(root);
  const result = await createVersion(root, api, current, { name: values.name, notes: values.notes ?? '', publish: !!values.publish, protectedContainers, onProgress: (m) => out(`  ${m}`) });
  out(`Version ${result.versionId} created${result.published ? ' and published' : ''}. Now on workspace "${result.state.workspace.name}".`);
}

async function cmdSwitch(root: string, values: { workspace?: string; new?: string }) {
  const state = await readState(root);
  const { accountId, containerId } = state.container;
  let target: WorkspaceInfo | undefined;
  if (values.new) {
    target = await api.createWorkspace(accountId, containerId, values.new);
  } else if (values.workspace) {
    const workspaces = await api.listWorkspaces(accountId, containerId);
    target = workspaces.find((w) => w.workspaceId === values.workspace || w.name === values.workspace);
    if (!target) throw new GtmError(`Workspace "${values.workspace}" not found. Workspaces: ${workspaces.map((w) => `${w.workspaceId} "${w.name}"`).join(', ') || 'none'}`);
  } else {
    throw new GtmError('Usage: gscode switch [dir] (--workspace <name|id> | --new <name>)');
  }
  const result = await switchWorkspace(root, api, state, target, { onProgress: (m) => out(`  ${m}`) });
  out(`Now following workspace "${target.name}" (${target.workspaceId}). ${describeRefresh(result)}`);
  out(`Your working files from before the switch are backed up in ${result.backup}.`);
  describeConflicts(result.state).forEach((line) => out(line));
}

async function cmdPublish(root: string, values: { version?: string; confirm?: string }) {
  if (!values.version) throw new GtmError('--version <id> is required.');
  const state = await readState(root);
  const protectedContainers = (await loadCliConfig()).protectedContainers ?? [];
  assertNotProtected(state, protectedContainers);
  if (values.confirm?.toUpperCase() !== state.container.publicId.toUpperCase()) {
    throw new GtmError(`Publishing goes live. Repeat the container id: --confirm ${state.container.publicId}`);
  }
  await publishVersion(api, state, values.version, protectedContainers);
  out(`Version ${values.version} published on ${state.container.publicId}.`);
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      client: { type: 'string' }, 'no-publish': { type: 'boolean' }, account: { type: 'string' }, container: { type: 'string' },
      workspace: { type: 'string' }, create: { type: 'boolean' }, sequential: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
      path: { type: 'string', multiple: true }, mine: { type: 'boolean' }, theirs: { type: 'boolean' }, dir: { type: 'string' },
      name: { type: 'string' }, notes: { type: 'string' }, publish: { type: 'boolean' }, confirm: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      interval: { type: 'string' }, verbose: { type: 'boolean', short: 'v' }, latest: { type: 'boolean' }, 'keep-workspace': { type: 'boolean' }, version: { type: 'string' },
      'no-sync': { type: 'boolean' }, new: { type: 'string' }, manual: { type: 'boolean' }, 'forget-client': { type: 'boolean' }, adopt: { type: 'boolean' },
    },
  });
  const [command, ...rest] = positionals;
  const root = path.resolve(rest[0] ?? '.');
  switch (command) {
    case 'login': return cmdLogin(values);
    case 'logout': {
      await signOut(store);
      if (values['forget-client']) await store.clearClient();
      return out(`Signed out (access revoked at Google)${values['forget-client'] ? ' and the OAuth client removed' : ''}.`);
    }
    case 'whoami': return cmdWhoami();
    case 'tidy': {
      const { renamed } = await tidyFileNames(root, await readState(root));
      renamed.forEach(([from, to]) => out(`  ${from} → ${to}`));
      return out(renamed.length ? `Renamed ${renamed.length} file(s).` : 'All file names already match GTM.');
    }
    case 'accounts': return (await api.listAccounts()).forEach((a) => out(`${a.accountId}\t${a.name}`));
    case 'containers': return (await api.listContainers(rest[0] ?? '')).forEach((c) => out(`${c.publicId}\t${c.containerId}\t${c.usageContext.join(',')}\t${c.name}`));
    case 'workspaces': {
      const container = await resolveContainer(rest[0] ?? '', rest[1] ?? '');
      return (await api.listWorkspaces(container.accountId, container.containerId)).forEach((w) => out(`${w.workspaceId}\t${w.name}`));
    }
    case 'init': return cmdInit(rest[0], values);
    case 'status': return cmdStatus(root);
    case 'pull': return cmdPull(root, values);
    case 'watch': return cmdWatch(root, values);
    case 'push': return cmdPush(root, values);
    case 'discard': return out(`Discarded ${await discardChanges(root, await readState(root), values.path)} change(s).`);
    case 'resolve': {
      if (!rest[0] || values.mine === values.theirs) throw new GtmError('Usage: gscode resolve <base> (--mine | --theirs)');
      const dir = path.resolve(values.dir ?? '.');
      await resolveConflict(dir, await readState(dir), rest[0], values.mine ? 'mine' : 'theirs');
      return out(`Resolved ${rest[0]}.`);
    }
    case 'resolve-gtm': {
      const keep = values['keep-workspace'] === true;
      if (!rest[0] || keep === (values.latest === true)) throw new GtmError('Usage: gscode resolve-gtm <base> (--keep-workspace | --latest)');
      const dir = path.resolve(values.dir ?? '.');
      const result = await resolveGtmConflict(dir, api, await readState(dir), rest[0], keep ? 'workspace' : 'latest');
      out(`Resolved ${rest[0]} (${keep ? 'kept the workspace version' : 'took the latest version'}). ${describeRefresh(result)}`);
      describeConflicts(result.state).forEach((line) => out(line));
      return;
    }
    case 'version': return cmdVersion(root, values);
    case 'publish': return cmdPublish(root, values);
    case 'switch': return cmdSwitch(root, { workspace: values.workspace, new: values.new });
    default: return out(HELP);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof WorkspaceGoneError) {
    error.candidates.forEach((w) => process.stderr.write(`  ${w.workspaceId}\t${w.name}\n`));
    process.stderr.write('Follow one with `gscode switch --workspace <id>`, or `gscode switch --new <name>`.\n');
  }
  process.exitCode = 1;
});
