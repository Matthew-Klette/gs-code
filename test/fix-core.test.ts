import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { explainError } from '../src/core/api';
import { readModel } from '../src/core/mirror/model';
import { readState } from '../src/core/mirror/state';
import { AutoPull } from '../src/core/ops/autoPull';
import { publishVersion } from '../src/core/ops/publish';
import { pushWorkspace } from '../src/core/ops/push';
import { switchWorkspace } from '../src/core/ops/sync';
import { initMirror } from '../src/core/ops/workspace';
import { ensureSgtmNetwork, localSgtmCommands, NETWORK_CREATE_COMMAND, SGTM_NETWORK } from '../src/cli/sgtmLocal';
import { GtmError, WorkspaceGoneError } from '../src/core/types';
import { CONTAINER, seededFake, type FakeGtm } from './fakeApi';

let root: string;
let gtm: FakeGtm;
const TAG = 'tags/GA4 - purchase.json';
const put = async (rel: string, value: string) => {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), value);
};
/** chmod 000 does not stop root, so the unreadable-file tests only mean something for a normal user. */
const canDenyReads = process.platform !== 'win32' && process.getuid?.() !== 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gscode-fixcore-'));
  gtm = seededFake();
  await initMirror(root, gtm, CONTAINER, gtm.workspace);
});
afterEach(async () => {
  await chmod(path.join(root, TAG), 0o644).catch(() => undefined);
  await chmod(path.join(root, 'tags'), 0o755).catch(() => undefined);
  // A background check stopped mid-round may still be finishing a write in .gtm; retry instead of failing on ENOTEMPTY.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('unreadable mirror files are problems, not deletions', () => {
  it.runIf(canDenyReads)('an unreadable entity file blocks the push instead of deleting the tag', async () => {
    await chmod(path.join(root, TAG), 0o000);
    const { model, problems } = await readModel(root, false);
    expect(model.docs.has('tags/GA4 - purchase')).toBe(false);
    expect(problems).toEqual([{ path: TAG, message: expect.stringMatching(/cannot read tags\/GA4 - purchase\.json: EACCES/) }]);
    await expect(pushWorkspace(root, gtm, await readState(root))).rejects.toThrow(/cannot read/);
    expect(gtm.find('tag', 'GA4 - purchase')).toBeDefined();
  });

  it.runIf(canDenyReads)('an unreadable entity folder blocks the push instead of deleting every tag', async () => {
    await chmod(path.join(root, 'tags'), 0o000);
    const { problems } = await readModel(root, false);
    expect(problems.map((problem) => problem.message)).toContain('cannot read tags: EACCES');
    await expect(pushWorkspace(root, gtm, await readState(root))).rejects.toThrow(/cannot read tags/);
    expect(gtm.find('tag', 'GA4 - purchase')).toBeDefined();
  });

  it('a file that is really gone still reads as a local deletion', async () => {
    await rm(path.join(root, TAG));
    const { model, problems } = await readModel(root, false);
    expect(problems).toEqual([]);
    expect(model.docs.has('tags/GA4 - purchase')).toBe(false);
  });
});

describe('gscode status exit code', () => {
  let cliDir: string;
  let cli: string;
  beforeAll(async () => {
    cliDir = await mkdtemp(path.join(tmpdir(), 'gscode-cli-'));
    cli = path.join(cliDir, 'cli.js');
    await build({ entryPoints: [path.join(__dirname, '../src/cli/main.ts')], outfile: cli, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  }, 30_000);
  afterAll(async () => rm(cliDir, { recursive: true, force: true }));
  const status = () =>
    spawnSync(process.execPath, [cli, 'status', root], { encoding: 'utf8', env: { ...process.env, GSCODE_CONFIG_DIR: cliDir, GSCODE_ACCESS_TOKEN: 'unused' } });

  it('exits 0 with pending changes, and 1 when the push would be blocked', () => {
    return (async () => {
      const tag = JSON.parse(await readFile(path.join(root, TAG), 'utf8'));
      await put(TAG, JSON.stringify({ ...tag, notes: 'pending' }));
      const pending = status();
      expect(pending.stdout).toContain('change(s) to push');
      expect(pending.status).toBe(0);

      await put(TAG, '{ broken');
      const blocked = status();
      expect(blocked.stdout).toContain('Push would be blocked');
      expect(blocked.status).toBe(1);
    })();
  }, 30_000);
});

describe('switching workspace', () => {
  it('leaves state on the old workspace when the pull fails, and names the backup', async () => {
    const before = await readState(root);
    const target = await gtm.createWorkspace(CONTAINER.accountId, CONTAINER.containerId, 'Other');
    gtm.fetchSnapshot = async () => {
      throw new GtmError('snapshot failed (500): simulated', 500);
    };
    const error = await switchWorkspace(root, gtm, before, target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GtmError);
    expect((error as GtmError).message).toMatch(/Could not switch to workspace "Other": snapshot failed/);
    expect((error as GtmError).message).toMatch(/backed up to \.gtm\/backups\//);
    expect((error as GtmError).status).toBe(500);
    const after = await readState(root);
    expect(after.workspace.workspaceId).toBe(before.workspace.workspaceId);
    expect(after.entities).toEqual(before.entities);
  });

  it('keeps WorkspaceGoneError (with its candidates) when the target workspace is gone', async () => {
    const before = await readState(root);
    const target = { ...before.workspace, workspaceId: '999', name: 'Gone' };
    const error = await switchWorkspace(root, gtm, before, target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceGoneError);
    const gone = error as WorkspaceGoneError;
    expect(gone.workspace.workspaceId).toBe('999');
    expect(gone.candidates.map((w) => w.workspaceId)).toEqual([before.workspace.workspaceId]);
    expect(gone.message).toMatch(/Workspace "Gone" no longer exists/);
    expect(gone.message).toMatch(/still follows ".+"\. Your working files were backed up to \.gtm\/backups\//);
    expect((await readState(root)).workspace.workspaceId).toBe(before.workspace.workspaceId);
  });

  it('backs up only mirror files, never .git or node_modules', async () => {
    await put('.git/HEAD', 'ref: refs/heads/main\n');
    await put('node_modules/x/index.js', '');
    await put('notes.txt', 'mine');
    const result = await switchWorkspace(root, gtm, await readState(root), gtm.workspace);
    const saved = await readdir(path.join(root, result.backup));
    expect(saved).toContain('tags');
    expect(saved).toContain('folders.json');
    expect(saved).not.toContain('.git');
    expect(saved).not.toContain('node_modules');
    expect(saved).not.toContain('notes.txt');
  });
});

describe('publish error hint', () => {
  const failPublish = (status: number) => {
    gtm.liveVersionId = async () => undefined;
    gtm.publishVersion = async () => {
      throw new GtmError(`publish failed (${status})`, status);
    };
  };
  const HINT = /allowPublish/;

  it('mentions the publish scope only for a 403', async () => {
    failPublish(403);
    await expect(publishVersion(gtm, await readState(root), '7', [])).rejects.toThrow(HINT);
  });

  it('does not blame the scope for other failures', async () => {
    failPublish(500);
    const error = await publishVersion(gtm, await readState(root), '7', []).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/publish failed \(500\)/);
    expect((error as Error).message).not.toMatch(HINT);
  });
});

describe('corrupt state.json', () => {
  it('says the state file is corrupt and how to recover', async () => {
    await put('.gtm/state.json', '{ "version": 1, ');
    await expect(readState(root)).rejects.toThrow(/\.gtm\/state\.json is corrupt .*gscode init/);
    await expect(readState(root)).rejects.toBeInstanceOf(GtmError);
  });
});

describe('sgtm-local docker commands', () => {
  const CONFIG = 'aWQ9R1RNLVhYWFgmZW52PTEmYXV0aD1hYmM=';

  it('publishes on 127.0.0.1 only and keeps CONTAINER_CONFIG out of the arguments', () => {
    const commands = localSgtmCommands({ config: CONFIG, port: 8080, previewPort: 8081 });
    expect(commands[0]).toContain('127.0.0.1:8081:8080');
    expect(commands[1]).toContain('127.0.0.1:8080:8080');
    for (const command of commands) {
      expect(command).toContain('CONTAINER_CONFIG');
      expect(command.join(' ')).not.toContain(CONFIG);
      expect(command.some((arg) => /^\d+:8080$/.test(arg))).toBe(false);
    }
  });

  it('runs both containers on the gscode-sgtm network; the tagging server finds the preview server by name', () => {
    const [preview, tagging] = localSgtmCommands({ config: CONFIG, port: 9000, previewPort: 9001 });
    for (const command of [preview ?? [], tagging ?? []]) expect(command[command.indexOf('--network') + 1]).toBe(SGTM_NETWORK);
    expect(tagging).toContain('PREVIEW_SERVER_URL=http://gscode-sgtm-preview:8080');
    expect(tagging?.join(' ')).not.toMatch(/host\.docker\.internal|host-gateway/);
  });

  it('creates the network, accepts only "already exists" as a failure to ignore', async () => {
    const seen: (readonly string[])[] = [];
    const answer = (code: number, stderr = '') => async (command: readonly string[]) => {
      seen.push(command);
      return { code, stderr };
    };
    await expect(ensureSgtmNetwork(answer(0))).resolves.toBeUndefined();
    expect(seen[0]).toEqual(NETWORK_CREATE_COMMAND);
    await expect(ensureSgtmNetwork(answer(1, 'Error response from daemon: network with name gscode-sgtm already exists'))).resolves.toBeUndefined();
    await expect(ensureSgtmNetwork(answer(1, 'Cannot connect to the Docker daemon'))).rejects.toThrow(/Could not create the docker network "gscode-sgtm": Cannot connect/);
    await expect(ensureSgtmNetwork(answer(125))).rejects.toThrow(/docker exited with 125/);
  });

  it('rejects ports that are not whole numbers from 1 to 65535', () => {
    for (const port of [0, 65536, Number.NaN, 80.5, -1]) {
      expect(() => localSgtmCommands({ config: CONFIG, port, previewPort: 8081 })).toThrow(/--port must be a whole number from 1 to 65535/);
    }
    expect(() => localSgtmCommands({ config: CONFIG, port: 8080, previewPort: 70000 })).toThrow(/--preview-port/);
    expect(() => localSgtmCommands({ config: CONFIG, port: 8080, previewPort: 8080 })).toThrow(/must be different/);
  });
});

describe('explainError', () => {
  it('reports a disabled API only when the message names Tag Manager', () => {
    expect(explainError('GET', '/x', 403, 'Tag Manager API has not been used in project 1 before or it is disabled')).toMatch(/not enabled/);
    expect(explainError('GET', '/x', 403, 'Tag Manager API is disabled for this project')).toMatch(/not enabled/);
    expect(explainError('POST', '/x', 400, 'This trigger is disabled')).toBeUndefined();
  });
});

describe('auto pull', () => {
  it('keeps polling when the onError callback throws', async () => {
    let calls = 0;
    gtm.getWorkspaceStatus = async () => {
      throw new GtmError('status failed (500): simulated', 500);
    };
    const watcher = new AutoPull(root, gtm, {
      intervalMs: 5,
      onError: () => {
        calls++;
        throw new Error('listener broke');
      },
    });
    // Backoff doubles per failure; keep it short so two rounds fit in the test.
    watcher.nextDelay = () => 5;
    watcher.start();
    const deadline = Date.now() + 3000;
    while (calls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    watcher.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((watcher.lastError as Error).message).toBe('listener broke');
  });
});
