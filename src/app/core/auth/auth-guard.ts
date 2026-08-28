import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SpotifyAuth } from './spotify-auth';

export const authGuard: CanActivateFn = () => {
  const auth = inject(SpotifyAuth);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return true;
  }

  return router.parseUrl('/');
};
