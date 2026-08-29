import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SpotifyAuth } from '../../core/auth/spotify-auth';
import { SpotifyApi, SpotifyPlaylist, SpotifyUserProfile } from '../../core/spotify/spotify-api';
import { GeneratorPanel } from './generator-panel/generator-panel';

@Component({
  imports: [GeneratorPanel],
  selector: 'app-dashboard',
  styleUrl: './dashboard.scss',
  templateUrl: './dashboard.html',
})
export class Dashboard implements OnInit {
  private readonly auth = inject(SpotifyAuth);
  private readonly spotifyApi = inject(SpotifyApi);
  private readonly router = inject(Router);

  protected readonly profile = signal<SpotifyUserProfile | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly playlists = signal<SpotifyPlaylist[] | null>(null);
  protected readonly playlistsError = signal<string | null>(null);
  protected readonly selectedPlaylistId = signal<string | null>(null);
  protected readonly highlightPlaylistId = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const profilePromise = this.spotifyApi.getCurrentUser();
    const playlistsPromise = this.spotifyApi.getCurrentUserPlaylists();

    try {
      this.profile.set(await profilePromise);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load your Spotify profile.');
    }

    try {
      this.playlists.set(await playlistsPromise);
    } catch (err) {
      this.playlistsError.set(err instanceof Error ? err.message : 'Failed to load your playlists.');
    }
  }

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/');
  }

  onPlaylistSelected(id: string | null): void {
    this.selectedPlaylistId.set(id);
    this.highlightPlaylistId.set(null);
  }

  onWizardReset(): void {
    this.selectedPlaylistId.set(null);
  }

  async onPlaylistCreated(playlistId: string): Promise<void> {
    try {
      this.playlists.set(await this.spotifyApi.getCurrentUserPlaylists());
    } catch (err) {
      this.playlistsError.set(err instanceof Error ? err.message : 'Failed to load your playlists.');
      return;
    }

    this.highlightPlaylistId.set(playlistId);
  }

  async onTracksAdded(playlistId: string): Promise<void> {
    try {
      this.playlists.set(await this.spotifyApi.getCurrentUserPlaylists());
    } catch (err) {
      this.playlistsError.set(err instanceof Error ? err.message : 'Failed to load your playlists.');
      return;
    }

    this.highlightPlaylistId.set(playlistId);
  }
}
