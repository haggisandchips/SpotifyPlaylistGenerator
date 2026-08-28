import { Component, ElementRef, OnInit, inject, signal, viewChild } from '@angular/core';
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

  private readonly carouselTrack = viewChild<ElementRef<HTMLElement>>('carouselTrack');

  protected readonly profile = signal<SpotifyUserProfile | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly playlists = signal<SpotifyPlaylist[] | null>(null);
  protected readonly playlistsError = signal<string | null>(null);
  protected readonly selectedPlaylistId = signal<string | null>(null);

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

  scrollCarousel(direction: 1 | -1): void {
    this.carouselTrack()?.nativeElement.scrollBy({ left: direction * 320, behavior: 'smooth' });
  }

  selectPlaylist(id: string): void {
    this.selectedPlaylistId.set(this.selectedPlaylistId() === id ? null : id);
  }

  async onPlaylistCreated(playlistId: string): Promise<void> {
    try {
      this.playlists.set(await this.spotifyApi.getCurrentUserPlaylists());
    } catch (err) {
      this.playlistsError.set(err instanceof Error ? err.message : 'Failed to load your playlists.');
      return;
    }

    this.selectedPlaylistId.set(playlistId);

    // Defer until the carousel has re-rendered with the refreshed list.
    setTimeout(() => this.scrollToPlaylist(playlistId), 0);
  }

  async onTracksAdded(): Promise<void> {
    try {
      this.playlists.set(await this.spotifyApi.getCurrentUserPlaylists());
    } catch (err) {
      this.playlistsError.set(err instanceof Error ? err.message : 'Failed to load your playlists.');
    }
  }

  private scrollToPlaylist(playlistId: string): void {
    const items = this.playlists();
    const track = this.carouselTrack()?.nativeElement;
    if (!items || !track) {
      return;
    }

    const index = items.findIndex((playlist) => playlist.id === playlistId);
    if (index === -1) {
      return;
    }

    const card = track.children[index] as HTMLElement | undefined;
    card?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
}
