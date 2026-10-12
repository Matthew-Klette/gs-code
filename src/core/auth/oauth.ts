import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { TokenProvider } from '../api';
import { AuthError, GtmError } from '../types';
import { waitForLoopbackCode } from './loopback';

const BASE_SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
];
const PUBLISH_SCOPE = 'https://www.googleapis.com/auth/tagmanager.publish';

/** Without the publish scope the token physically cannot publish, whatever the UI does. */
export function scopesFor(allowPublish: boolean): string[] {
  return allowPublish ? [...BASE_SCOPES, PUBLISH_SCOPE] : [...BASE_SCOPES];
}

export interface OAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface CredentialStore {
  loadClient(): Promise<OAuthClientConfig | undefined>;
  saveClient(client: OAuthClientConfig): Promise<void>;
  loadTokens(): Promise<Credentials | undefined>;
  saveTokens(tokens: Credentials): Promise<void>;
  clearTokens(): Promise<void>;
}

/** Accepts the `client_secret_*.json` file Google Cloud Console downloads for a Desktop app client. */
export function parseClientSecretJson(text: string): OAuthClientConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GtmError('That file is not valid JSON. Download the OAuth client JSON from Google Cloud Console → Credentials.');
  }
  const record = parsed as { installed?: Record<string, unknown>; web?: Record<string, unknown> };
  if (record.web) throw new GtmError('This is a "Web application" client. Create a "Desktop app" OAuth client instead.');
  const installed = record.installed;
  if (!installed || typeof installed.client_id !== 'string' || typeof installed.client_secret !== 'string') {
    throw new GtmError('Expected a Desktop app OAuth client JSON with "installed.client_id" and "installed.client_secret".');
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

export interface SignInOptions {
  readonly allowPublish: boolean;
  readonly openBrowser: (url: string) => Promise<void> | void;
  readonly timeoutMs?: number;
}

/** Desktop OAuth with a loopback redirect and PKCE. Stores the refresh token in `store`. */
export async function signIn(store: CredentialStore, options: SignInOptions): Promise<void> {
  const client = await store.loadClient();
  if (!client) throw new GtmError('No OAuth client configured. Run "Configure OAuth Client" first.');
  const loopback = await waitForLoopbackCode(options.timeoutMs);
  try {
    const oauth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: loopback.redirectUri });
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const url = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopesFor(options.allowPublish),
      state: loopback.state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256' as never,
    });
    await options.openBrowser(url);
    const code = await loopback.code;
    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: loopback.redirectUri });
    if (!tokens.refresh_token) throw new GtmError('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and sign in again.');
    await store.saveTokens(tokens);
  } finally {
    loopback.close();
  }
}

export class GoogleTokenProvider implements TokenProvider {
  private client?: OAuth2Client;

  constructor(private readonly store: CredentialStore) {}

  async getAccessToken(): Promise<string> {
    const client = await this.ensureClient();
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new AuthError('Could not get an access token. Sign in again.');
      return token;
    } catch (error: unknown) {
      if (error instanceof GtmError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/invalid_grant/i.test(message)) {
        this.client = undefined;
        throw new AuthError('Your Google sign-in expired or was revoked. Sign in again.');
      }
      throw new GtmError(`Token refresh failed: ${message}`);
    }
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.store.loadTokens())?.refresh_token !== undefined;
  }

  /** Scopes granted at sign-in, for showing whether publish is possible. */
  async grantedScopes(): Promise<string[]> {
    return ((await this.store.loadTokens())?.scope ?? '').split(' ').filter(Boolean);
  }

  reset(): void {
    this.client = undefined;
  }

  private async ensureClient(): Promise<OAuth2Client> {
    if (this.client) return this.client;
    const config = await this.store.loadClient();
    const tokens = await this.store.loadTokens();
    if (!config) throw new AuthError('No OAuth client configured. Run "Configure OAuth Client" first.');
    if (!tokens?.refresh_token) throw new AuthError('Not signed in. Run "Sign In" first.');
    const client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret });
    client.setCredentials(tokens);
    client.on('tokens', (fresh) => {
      if (this.client !== client) return; // signed out or reset while refreshing
      this.store.saveTokens({ ...tokens, ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token }).catch(() => undefined);
    });
    this.client = client;
    return client;
  }
}
