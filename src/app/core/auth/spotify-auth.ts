import { Service, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce';

const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

const CODE_VERIFIER_KEY = 'spotify_auth_code_verifier';
const STATE_KEY = 'spotify_auth_state';
const TOKENS_KEY = 'spotify_auth_tokens';

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

@Service()
export class SpotifyAuth {
  private readonly tokens = signal<StoredTokens | null>(this.readStoredTokens());
  readonly isAuthenticated = signal(this.tokens() !== null);

  async login(): Promise<void> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();

    sessionStorage.setItem(CODE_VERIFIER_KEY, codeVerifier);
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: environment.spotify.clientId,
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
        client_id: environment.spotify.clientId,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to exchange authorization code (${response.status})`);
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
        client_id: environment.spotify.clientId,
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
