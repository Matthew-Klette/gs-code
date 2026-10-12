import { GoogleAuth, OAuth2Client, type Credentials } from 'google-auth-library';
import type { TokenProvider } from '../api';
import { AuthError, GtmError } from '../types';
import { waitForLoopbackCode, type Loopback } from './loopback';

const BASE_SCOPES = [
  // openid + email: only to show which Google account is signed in.
  'openid',
  'email',
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
  clearClient(): Promise<void>;
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
  /**
   * Map the local redirect address to one the user's browser can reach (VS Code Remote: `asExternalUri`).
   * Only loopback results are used; Google refuses any other redirect for a Desktop client.
   */
  readonly externalRedirect?: (local: string) => Promise<string>;
  /**
   * Ask the user for the address the browser ended on, in case the redirect cannot reach this machine.
   * Runs alongside the loopback listener; whichever finishes first wins. Resolve `undefined` to skip.
   * Asked again, with `problem` saying why, when a pasted address is not this sign-in's redirect.
   */
  readonly pasteRedirect?: (problem?: string) => Promise<string | undefined>;
}

/** Google only accepts http://127.0.0.1 / http://localhost redirects for Desktop clients. */
export function isLoopbackAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The signed-in account's email, from the id_token Google returns (no extra request). */
export function emailFromTokens(tokens: Credentials | undefined): string | undefined {
  const payload = tokens?.id_token?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

/** Desktop OAuth with a loopback redirect and PKCE. Stores the refresh token in `store`. */
export async function signIn(store: CredentialStore, options: SignInOptions): Promise<void> {
  const client = await store.loadClient();
  if (!client) throw new GtmError('No OAuth client configured. Run "Configure OAuth Client" first.');
  const loopback = await waitForLoopbackCode(options.timeoutMs);
  try {
    const mapped = options.externalRedirect ? await options.externalRedirect(loopback.redirectUri).catch(() => loopback.redirectUri) : loopback.redirectUri;
    // asExternalUri may return the same port, a forwarded local port, or (Codespaces) an https tunnel Google rejects.
    const redirectUri = isLoopbackAddress(mapped) ? mapped.replace(/\/$/, '') : loopback.redirectUri;
    const oauth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret, redirectUri });
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const url = oauth.generateAuthUrl({
      access_type: 'offline',
      // select_account: lets you pick (or switch) the Google account; consent: always returns a refresh token.
      prompt: 'select_account consent',
      scope: scopesFor(options.allowPublish),
      state: loopback.state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256' as never,
    });
    await options.openBrowser(url);
    if (options.pasteRedirect) void pasteUntilDone(loopback, options.pasteRedirect);
    const code = await loopback.code;
    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) throw new GtmError('Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and sign in again.');
    await store.saveTokens(tokens);
  } finally {
    loopback.close();
  }
}

/**
 * Feed pasted addresses to the loopback until one is accepted, the user skips, or the sign-in ends.
 * Never rejects: a broken prompt is not fatal, because the loopback listener is still waiting.
 */
async function pasteUntilDone(loopback: Loopback, ask: (problem?: string) => Promise<string | undefined>): Promise<void> {
  let settled = false;
  loopback.code.then(
    () => (settled = true),
    () => (settled = true),
  );
  let problem: string | undefined;
  try {
    while (!settled) {
      const address = await ask(problem);
      if (!address || settled) return;
      problem = loopback.submitRedirect(address);
      if (!problem) return;
    }
  } catch (error: unknown) {
    // The prompt itself failed (stdin closed, input box disposed). Say so; the browser redirect can still finish.
    process.stderr.write(`Could not read the pasted address (${error instanceof Error ? error.message : String(error)}); still waiting for the browser.\n`);
  }
}

/** Sign out for real: revoke the refresh token at Google (best effort), then forget it locally. */
export async function signOut(store: CredentialStore): Promise<void> {
  const tokens = await store.loadTokens();
  const client = await store.loadClient();
  if (tokens?.refresh_token && client) {
    const oauth = new OAuth2Client({ clientId: client.clientId, clientSecret: client.clientSecret });
    await oauth.revokeToken(tokens.refresh_token).catch(() => undefined); // already revoked or offline: still sign out
  }
  await store.clearTokens();
}

/**
 * Application Default Credentials for CI and servers: a service-account key file
 * (`GOOGLE_APPLICATION_CREDENTIALS`), workload identity federation (e.g. GitHub Actions OIDC) or
 * `gcloud auth application-default login`. Add the service account's email as a user in GTM.
 */
export class AdcTokenProvider implements TokenProvider {
  private auth?: GoogleAuth;

  constructor(private readonly allowPublish: boolean) {}

  async getAccessToken(): Promise<string> {
    this.auth ??= new GoogleAuth({ scopes: scopesFor(this.allowPublish).filter((scope) => scope.startsWith('https://')) });
    try {
      const token = await this.auth.getAccessToken();
      if (!token) throw new AuthError('Application Default Credentials returned no access token.');
      return token;
    } catch (error: unknown) {
      if (error instanceof GtmError) throw error;
      throw new AuthError(`Application Default Credentials failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A ready access token from the environment (`GSCODE_ACCESS_TOKEN`), e.g. minted by a CI step. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}

  async getAccessToken(): Promise<string> {
    return this.token;
  }
}

export class GoogleTokenProvider implements TokenProvider {
  private client?: OAuth2Client;
  /** Why the last save of refreshed tokens failed, if it did. Shown when the sign-in later stops working. */
  private saveError?: string;

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
        const unsaved = this.saveError ? ` (GS Code could not save a refreshed sign-in earlier: ${this.saveError})` : '';
        throw new AuthError(`Your Google sign-in expired or was revoked. Sign in again.${unsaved}`);
      }
      throw new GtmError(`Token refresh failed: ${message}`);
    }
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.store.loadTokens())?.refresh_token !== undefined;
  }

  async account(): Promise<string | undefined> {
    return emailFromTokens(await this.store.loadTokens());
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
      this.store.saveTokens({ ...tokens, ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token }).then(
        () => (this.saveError = undefined),
        (error: unknown) => {
          // The access token in memory still works; only the next start would use stale tokens. Keep the reason for later.
          this.saveError = error instanceof Error ? error.message : String(error);
        },
      );
    });
    this.client = client;
    return client;
  }
}
