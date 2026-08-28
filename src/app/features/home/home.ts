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

  goToDashboard(): void {
    this.router.navigateByUrl('/dashboard');
  }

  async login(): Promise<void> {
    this.isRedirecting.set(true);
    await this.auth.login();
  }
}
