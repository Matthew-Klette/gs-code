import type { Credentials } from 'google-auth-library';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { CredentialStore, OAuthClientConfig } from '../core/auth/oauth';
import type { StampStore } from '../core/rateLimiter';

export interface CliConfig {
  readonly protectedContainers?: readonly string[];
  readonly allowPublish?: boolean;
}

export function configDir(): string {
  return process.env.GSCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'gs-code');
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Credentials in ~/.config/gs-code, readable only by the current user. */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly dir = configDir()) {}

  loadClient(): Promise<OAuthClientConfig | undefined> {
    return readJson(path.join(this.dir, 'client.json'));
  }

  saveClient(client: OAuthClientConfig): Promise<void> {
    return writePrivate(path.join(this.dir, 'client.json'), client);
  }

  loadTokens(): Promise<Credentials | undefined> {
    return readJson(path.join(this.dir, 'tokens.json'));
  }

  saveTokens(tokens: Credentials): Promise<void> {
    return writePrivate(path.join(this.dir, 'tokens.json'), tokens);
  }

  async clearTokens(): Promise<void> {
    await fs.rm(path.join(this.dir, 'tokens.json'), { force: true });
  }

  async clearClient(): Promise<void> {
    await fs.rm(path.join(this.dir, 'client.json'), { force: true });
  }
}

export async function loadCliConfig(dir = configDir()): Promise<CliConfig> {
  const fromFile = (await readJson<CliConfig>(path.join(dir, 'config.json'))) ?? {};
  const fromEnv = process.env.GSCODE_PROTECTED?.split(',').map((id) => id.trim()).filter(Boolean) ?? [];
  return { ...fromFile, protectedContainers: [...(fromFile.protectedContainers ?? []), ...fromEnv] };
}

/** Request timestamps shared by every `gscode` run, so back-to-back commands respect the quota. */
/** Stamps older than this are dropped from the shared file (the quota window is 100 s). */
const STAMP_HORIZON_MS = 200_000;

export function fileStampStore(dir = configDir()): StampStore {
  const file = path.join(dir, 'ratelimit.json');
  const load = (): number[] => {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
    } catch {
      return [];
    }
  };
  return {
    load,
    save: (stamps) => {
      try {
        // Write a private temp file and rename it over, so a concurrent reader never sees half a file
        // (which would parse as "no recent requests" and allow a burst).
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        // Merge with what other processes saved since we loaded, so nobody's requests are forgotten.
        const horizon = Date.now() - STAMP_HORIZON_MS;
        const merged = [...new Set([...load(), ...stamps])].filter((stamp) => stamp > horizon).sort((a, b) => a - b);
        writeFileSync(temp, JSON.stringify(merged), { mode: 0o600 });
        renameSync(temp, file);
      } catch {
        // best effort: the in-process limiter still applies
      }
    },
  };
}
