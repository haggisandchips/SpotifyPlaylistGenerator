import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SpotifyAuth } from '../../core/auth/spotify-auth';
import { SpotifyApi, SpotifyUserProfile } from '../../core/spotify/spotify-api';

@Component({
  imports: [],
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

  async ngOnInit(): Promise<void> {
    try {
      this.profile.set(await this.spotifyApi.getCurrentUser());
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to load your Spotify profile.');
    }
  }

  logout(): void {
    this.auth.logout();
    this.router.navigateByUrl('/');
  }
}
