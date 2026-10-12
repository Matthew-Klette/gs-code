import type { Credentials } from 'google-auth-library';
import type * as vscode from 'vscode';
import type { CredentialStore, OAuthClientConfig } from '../core/auth/oauth';

const CLIENT_KEY = 'gsCode.oauthClient';
const TOKENS_KEY = 'gsCode.tokens';

/** OAuth client and tokens in the OS keychain via VS Code SecretStorage. */
export class SecretCredentialStore implements CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async loadClient(): Promise<OAuthClientConfig | undefined> {
    return parse(await this.secrets.get(CLIENT_KEY));
  }

  async saveClient(client: OAuthClientConfig): Promise<void> {
    await this.secrets.store(CLIENT_KEY, JSON.stringify(client));
  }

  async loadTokens(): Promise<Credentials | undefined> {
    return parse(await this.secrets.get(TOKENS_KEY));
  }

  async saveTokens(tokens: Credentials): Promise<void> {
    await this.secrets.store(TOKENS_KEY, JSON.stringify(tokens));
  }

  async clearTokens(): Promise<void> {
    await this.secrets.delete(TOKENS_KEY);
  }
}

function parse<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
