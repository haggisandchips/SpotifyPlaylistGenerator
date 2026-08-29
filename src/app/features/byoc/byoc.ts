import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { SpotifyAuth } from '../../core/auth/spotify-auth';

@Component({
  imports: [],
  selector: 'app-byoc',
  styleUrl: './byoc.scss',
  templateUrl: './byoc.html',
})
export class Byoc {
  private readonly auth = inject(SpotifyAuth);
  private readonly router = inject(Router);

  protected readonly redirectUri = environment.spotify.redirectUri;
  protected readonly clientId = signal(this.auth.getCustomClientId() ?? '');
  protected readonly hasCustomClientId = signal(this.auth.getCustomClientId() !== null);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly isRedirecting = signal(false);
  protected readonly copied = signal(false);

  async copyRedirectUri(): Promise<void> {
    await navigator.clipboard.writeText(this.redirectUri);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  async saveAndRetry(): Promise<void> {
    const value = this.clientId().trim();
    if (!value) {
      this.errorMessage.set('Enter the Client ID from your Spotify app.');
      return;
    }

    this.errorMessage.set(null);
    this.auth.setCustomClientId(value);
    this.isRedirecting.set(true);
    try {
      await this.auth.login();
    } catch (err) {
      this.isRedirecting.set(false);
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to start Spotify login.');
    }
  }

  useDefaultInstead(): void {
    this.auth.setCustomClientId('');
    this.router.navigateByUrl('/');
  }
}
