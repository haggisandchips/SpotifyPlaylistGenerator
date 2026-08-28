# Spotify Playlist Generator

An Angular app with Spotify OAuth (Authorization Code + PKCE) built in. Users log in with
Spotify, the app exchanges the auth code for tokens client-side (no backend, no client secret),
and the dashboard proves the flow by loading the signed-in user's Spotify profile.

## Spotify app configuration

This app is registered in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
with client ID `73ba150d645b4d7d8acfb32f635b1a91`. The dashboard's **Redirect URIs** must include
both of these, exactly:

- `http://127.0.0.1:4200/callback` (local development)
- `https://haggisandchips.github.io/SpotifyPlaylistGenerator/callback` (GitHub Pages)

## Development server

```bash
npm start
```

Open `http://127.0.0.1:4200/` (not `localhost` — Spotify's redirect URI must match exactly what's
registered, and `127.0.0.1` is what's configured above). The dev environment
(`src/environments/environment.development.ts`) points at the local redirect URI automatically.

## Building

```bash
npm run build -- --configuration production
```

Builds with the `/SpotifyPlaylistGenerator/` base href GitHub Pages requires, output in
`dist/spotify-playlist-generator/browser`.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds and publishes `main` to GitHub Pages automatically via the
official `actions/deploy-pages` action. It also copies `index.html` to `404.html` so that direct
navigation to `/callback` (Spotify's redirect) is handled by Angular's router instead of GitHub's
static 404 page.

One-time repo setup: **Settings → Pages → Source → GitHub Actions**.

## Running unit tests

```bash
npm test
```

## How the OAuth flow works

- `src/app/core/auth/pkce.ts` — generates the PKCE code verifier/challenge and OAuth `state`.
- `src/app/core/auth/spotify-auth.ts` — starts the Spotify authorize redirect, exchanges the
  returned code for tokens, refreshes expired access tokens, and persists tokens in
  `localStorage`.
- `src/app/core/auth/auth-guard.ts` — route guard that protects `/dashboard`.
- `src/app/features/callback` — the page Spotify redirects back to; it completes the token
  exchange, then routes to `/dashboard`.
- `src/app/core/spotify/spotify-api.ts` — thin wrapper around the Spotify Web API using the
  stored access token.
