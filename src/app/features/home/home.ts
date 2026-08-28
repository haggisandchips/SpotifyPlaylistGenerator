import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SpotifyAuth } from '../../core/auth/spotify-auth';

@Component({
  imports: [],
  selector: 'app-home',
  styleUrl: './home.scss',
  templateUrl: './home.html',
})
export class Home {
  private readonly auth = inject(SpotifyAuth);
  private readonly router = inject(Router);

  protected readonly isAuthenticated = this.auth.isAuthenticated;
  protected readonly isRedirecting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  goToDashboard(): void {
    this.router.navigateByUrl('/dashboard');
  }

  async login(): Promise<void> {
    this.errorMessage.set(null);
    this.isRedirecting.set(true);
    try {
      await this.auth.login();
    } catch (err) {
      this.isRedirecting.set(false);
      this.errorMessage.set(err instanceof Error ? err.message : 'Failed to start Spotify login.');
    }
  }
}
