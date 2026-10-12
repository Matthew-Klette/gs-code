import type { Credentials } from 'google-auth-library';
import type * as vscode from 'vscode';
import type { CredentialStore, OAuthClientConfig } from '../core/auth/oauth';

const CLIENT_KEY = 'gsCode.oauthClient';
const TOKENS_KEY = 'gsCode.tokens';

/** OAuth client and tokens in the OS keychain via VS Code SecretStorage. */
export class SecretCredentialStore implements CredentialStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {}

  async loadClient(): Promise<OAuthClientConfig | undefined> {
    return parse(await this.secrets.get(CLIENT_KEY), 'OAuth client', this.warn);
  }

  async saveClient(client: OAuthClientConfig): Promise<void> {
    await this.secrets.store(CLIENT_KEY, JSON.stringify(client));
  }

  async loadTokens(): Promise<Credentials | undefined> {
    return parse(await this.secrets.get(TOKENS_KEY), 'sign-in tokens', this.warn);
  }

  async saveTokens(tokens: Credentials): Promise<void> {
    await this.secrets.store(TOKENS_KEY, JSON.stringify(tokens));
  }

  async clearTokens(): Promise<void> {
    await this.secrets.delete(TOKENS_KEY);
  }

  async clearClient(): Promise<void> {
    await this.secrets.delete(CLIENT_KEY);
  }
}

/** Stored JSON, or undefined when missing or unreadable (with a warning, so "not signed in" is not the only clue). */
function parse<T>(text: string | undefined, what: string, warn: (message: string) => void): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (error: unknown) {
    warn(`The stored ${what} in the OS keychain could not be read (${error instanceof Error ? error.message : String(error)}). Treating it as missing; configure the client or sign in again to replace it.`);
    return undefined;
  }
}
