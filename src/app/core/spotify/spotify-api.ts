import { Service, inject, signal } from '@angular/core';
import { SpotifyAuth } from '../auth/spotify-auth';

const API_BASE = 'https://api.spotify.com/v1';
const MAX_RATE_LIMIT_RETRIES = 3;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SpotifyUserProfile {
  id: string;
  display_name: string | null;
  email: string;
  images: SpotifyImage[] | null;
  followers: { total: number };
  product: string;
  country: string;
  external_urls: { spotify: string };
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  images: SpotifyImage[] | null;
  external_urls: { spotify: string };
}

export interface SpotifyArtist {
  id: string;
  name: string;
  images: SpotifyImage[] | null;
  genres: string[];
  popularity: number;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  artists: { name: string }[];
}

interface SpotifyPlaylistsPage {
  items: SpotifyPlaylist[];
}

interface SpotifySearchArtistsResponse {
  artists: { items: SpotifyArtist[] };
}

interface SpotifyTopTracksResponse {
  tracks: SpotifyTrack[];
}

export interface SpotifyCreatedPlaylist {
  id: string;
  external_urls: { spotify: string };
}

@Service()
export class SpotifyApi {
  private readonly auth = inject(SpotifyAuth);

  // Bumped every time Spotify responds 429, before the retry backoff runs. Callers doing
  // bulk work can watch this to throttle themselves down instead of waiting to be told.
  readonly rateLimitHits = signal(0);

  async getCurrentUser(): Promise<SpotifyUserProfile> {
    return this.request<SpotifyUserProfile>('/me');
  }

  async getCurrentUserPlaylists(): Promise<SpotifyPlaylist[]> {
    const page = await this.request<SpotifyPlaylistsPage>('/me/playlists?limit=50');
    return page.items;
  }

  async searchArtists(name: string): Promise<SpotifyArtist[]> {
    const params = new URLSearchParams({ q: name, type: 'artist', limit: '5' });
    const result = await this.request<SpotifySearchArtistsResponse>(`/search?${params}`);
    return result.artists.items;
  }

  async getArtistTopTracks(artistId: string, market: string): Promise<SpotifyTrack[]> {
    const params = new URLSearchParams({ market });
    const result = await this.request<SpotifyTopTracksResponse>(`/artists/${artistId}/top-tracks?${params}`);
    return result.tracks;
  }

  async createPlaylist(
    userId: string,
    details: { name: string; description: string; isPublic: boolean },
  ): Promise<SpotifyCreatedPlaylist> {
    return this.request<SpotifyCreatedPlaylist>(`/users/${userId}/playlists`, {
      method: 'POST',
      body: JSON.stringify({
        name: details.name,
        description: details.description,
        public: details.isPublic,
      }),
    });
  }

  async addTracksToPlaylist(playlistId: string, uris: string[]): Promise<void> {
    for (let i = 0; i < uris.length; i += 100) {
      const chunk = uris.slice(i, i + 100);
      await this.request(`/playlists/${playlistId}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ uris: chunk }),
      });
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, retriesLeft = MAX_RATE_LIMIT_RETRIES): Promise<T> {
    const accessToken = await this.auth.getAccessToken();
    if (!accessToken) {
      throw new Error('Not authenticated with Spotify.');
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });

    if (response.status === 429 && retriesLeft > 0) {
      this.rateLimitHits.update((count) => count + 1);
      const retryAfterSeconds = Number(response.headers.get('Retry-After'));
      await delay((Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 1) * 1000);
      return this.request<T>(path, init, retriesLeft - 1);
    }

    if (!response.ok) {
      throw new Error(`Spotify API request to ${path} failed (${response.status})`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}
