<p align="center">
  <img src="docs/brand/banner.svg" alt="Spotify Playlist Generator" width="720" />
</p>

An Angular app with Spotify OAuth (Authorization Code + PKCE) built in. Users log in with
Spotify, the app exchanges the auth code for tokens client-side (no backend, no client secret),
and the dashboard proves the flow by loading the signed-in user's Spotify profile.

## Spotify app configuration

This app is registered in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
with client ID `73ba150d645b4d7d8acfb32f635b1a91`. The dashboard's **Redirect URIs** must include,
exactly:

- `http://127.0.0.1:4200/callback` (local development)
- `https://haggisandchips.github.io/SpotifyPlaylistGenerator/callback` (GitHub Pages)
- any other origin you serve the dev build from — see [Testing on a phone](#testing-on-a-phone)

The dev redirect URI (`src/environments/environment.development.ts`) is derived from
`window.location.origin` rather than hardcoded, so it automatically matches whatever origin you
load the app from — but that origin must still be registered above, or Spotify will reject it.
Spotify also requires the redirect URI to be HTTPS, with the sole exception of `http://127.0.0.1`.

## Development server

```bash
npm start
```

Open `http://127.0.0.1:4200/` (not `localhost` — Spotify's redirect URI must match exactly what's
registered, and `127.0.0.1` is what's configured above).

## Testing on a phone

Spotify won't redirect back to a plain-HTTP LAN address, and browsers disable the crypto APIs PKCE
needs outside of HTTPS/localhost — so a phone on the same network needs an HTTPS dev server:

```bash
npm run start:mobile
```

This runs `ng serve --ssl --host 0.0.0.0`, serving on your machine's LAN IP with a self-signed
certificate. Then, one time only:

1. Add `https://<your-lan-ip>:4200/callback` as a Redirect URI in the
   [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) (find your LAN IP with
   `ipconfig`).
2. On your phone, open `https://<your-lan-ip>:4200/` and accept the self-signed certificate
   warning.

Your LAN IP can change between networks/reboots — update the registered redirect URI to match if
login stops working.

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
