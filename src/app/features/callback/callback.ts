import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SpotifyAuth } from '../../core/auth/spotify-auth';

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
      this.errorMessage.set(err instanceof Error ? err.message : 'Something went wrong signing in.');
    }
  }

  goHome(): void {
    this.router.navigateByUrl('/');
  }
}
