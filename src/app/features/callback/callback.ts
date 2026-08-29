import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SpotifyAuth, SpotifyAuthError } from '../../core/auth/spotify-auth';

@Component({
  imports: [],
  selector: 'app-callback',
  styleUrl: './callback.scss',
  templateUrl: './callback.html',
})
export class Callback implements OnInit {
  private readonly auth = inject(SpotifyAuth);
  private readonly router = inject(Router);

  protected readonly errorMessage = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      await this.auth.handleRedirectCallback(new URLSearchParams(window.location.search));
      await this.router.navigateByUrl('/dashboard');
    } catch (err) {
      if (err instanceof SpotifyAuthError && err.status === 403) {
        await this.router.navigateByUrl('/byoc');
        return;
      }
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Something went wrong signing in.',
      );
    }
  }

  goHome(): void {
    this.router.navigateByUrl('/');
  }
}
