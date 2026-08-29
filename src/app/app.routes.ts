import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth-guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  {
    path: 'callback',
    loadComponent: () => import('./features/callback/callback').then((m) => m.Callback),
  },
  {
    path: 'byoc',
    loadComponent: () => import('./features/byoc/byoc').then((m) => m.Byoc),
  },
  {
    path: 'dashboard',
    loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
    canActivate: [authGuard],
  },
  {
    path: '**',
    redirectTo: '',
  },
];
