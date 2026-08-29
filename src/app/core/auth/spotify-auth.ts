import { Service, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce';

const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

const CODE_VERIFIER_KEY = 'spotify_auth_code_verifier';
const STATE_KEY = 'spotify_auth_state';
const TOKENS_KEY = 'spotify_auth_tokens';
const CUSTOM_CLIENT_ID_KEY = 'spotify_auth_custom_client_id';

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

/** Thrown when a request to Spotify fails, carrying the HTTP status so callers can
 *  distinguish a Development Mode access-denial (403) from other failures. */
export class SpotifyAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpotifyAuthError';
  }
}

@Service()
export class SpotifyAuth {
  private readonly tokens = signal<StoredTokens | null>(this.readStoredTokens());
  readonly isAuthenticated = signal(this.tokens() !== null);

  /** The client ID to use: a user-supplied BYOC client ID if one is stored, otherwise the app default. */
  getClientId(): string {
    return localStorage.getItem(CUSTOM_CLIENT_ID_KEY) || environment.spotify.clientId;
  }

  getCustomClientId(): string | null {
    return localStorage.getItem(CUSTOM_CLIENT_ID_KEY);
  }

  /** Stores a user-supplied Client ID for BYOC. Passing an empty/whitespace value reverts to the app default. */
  setCustomClientId(clientId: string): void {
    const trimmed = clientId.trim();
    if (trimmed) {
      localStorage.setItem(CUSTOM_CLIENT_ID_KEY, trimmed);
    } else {
      localStorage.removeItem(CUSTOM_CLIENT_ID_KEY);
    }
  }

  async login(): Promise<void> {
    if (!window.isSecureContext) {
      throw new Error(
        'Spotify login requires a secure connection. This page was loaded over plain HTTP from a ' +
          'non-localhost address, so the browser has disabled the crypto APIs PKCE needs. Serve the ' +
          'app over HTTPS (or from localhost/127.0.0.1) to sign in.',
      );
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    sessionStorage.setItem(CODE_VERIFIER_KEY, codeVerifier);
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.getClientId(),
      scope: environment.spotify.scopes.join(' '),
      redirect_uri: environment.spotify.redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
    });

    window.location.assign(`${AUTHORIZE_ENDPOINT}?${params.toString()}`);
  }

  async handleRedirectCallback(queryParams: URLSearchParams): Promise<void> {
    const error = queryParams.get('error');
    if (error) {
      throw new Error(`Spotify authorization failed: ${error}`);
    }

    const code = queryParams.get('code');
    const state = queryParams.get('state');
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const codeVerifier = sessionStorage.getItem(CODE_VERIFIER_KEY);

    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(CODE_VERIFIER_KEY);

    if (!code || !state || !expectedState || state !== expectedState) {
      throw new Error('Invalid or missing OAuth state. Please try logging in again.');
    }
    if (!codeVerifier) {
      throw new Error('Missing PKCE code verifier. Please try logging in again.');
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: environment.spotify.redirectUri,
        client_id: this.getClientId(),
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      throw new SpotifyAuthError(
        `Failed to exchange authorization code (${response.status})`,
        response.status,
      );
    }

    this.storeTokenResponse(await response.json());
  }

  async getAccessToken(): Promise<string | null> {
    const current = this.tokens();
    if (!current) {
      return null;
    }
    if (Date.now() < current.expiresAt) {
      return current.accessToken;
    }
    return this.refreshAccessToken(current.refreshToken);
  }

  logout(): void {
    localStorage.removeItem(TOKENS_KEY);
    this.tokens.set(null);
    this.isAuthenticated.set(false);
  }

  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.getClientId(),
      }),
    });

    if (!response.ok) {
      this.logout();
      return null;
    }

    const stored = this.storeTokenResponse(await response.json(), refreshToken);
    return stored.accessToken;
  }

  private storeTokenResponse(payload: TokenResponse, fallbackRefreshToken?: string): StoredTokens {
    const refreshToken = payload.refresh_token ?? fallbackRefreshToken;
    if (!refreshToken) {
      throw new Error('Spotify token response did not include a refresh token.');
    }

    const stored: StoredTokens = {
      accessToken: payload.access_token,
      refreshToken,
      expiresAt: Date.now() + (payload.expires_in - 60) * 1000,
    };

    localStorage.setItem(TOKENS_KEY, JSON.stringify(stored));
    this.tokens.set(stored);
    this.isAuthenticated.set(true);
    return stored;
  }

  private readStoredTokens(): StoredTokens | null {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      localStorage.removeItem(TOKENS_KEY);
      return null;
    }
  }
}
