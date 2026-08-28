import { Service, inject } from '@angular/core';
import { SpotifyAuth } from '../auth/spotify-auth';

const API_BASE = 'https://api.spotify.com/v1';

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyUserProfile {
  id: string;
  display_name: string | null;
  email: string;
  images: SpotifyImage[];
  followers: { total: number };
  product: string;
  external_urls: { spotify: string };
}

@Service()
export class SpotifyApi {
  private readonly auth = inject(SpotifyAuth);

  async getCurrentUser(): Promise<SpotifyUserProfile> {
    return this.request<SpotifyUserProfile>('/me');
  }

  private async request<T>(path: string): Promise<T> {
    const accessToken = await this.auth.getAccessToken();
    if (!accessToken) {
      throw new Error('Not authenticated with Spotify.');
    }

    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Spotify API request to ${path} failed (${response.status})`);
    }

    return response.json() as Promise<T>;
  }
}
