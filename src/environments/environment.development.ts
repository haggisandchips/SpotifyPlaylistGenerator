export const environment = {
  production: false,
  spotify: {
    clientId: '73ba150d645b4d7d8acfb32f635b1a91',
    // Derived from wherever this build is actually being served (localhost, a LAN IP, a tunnel, …)
    // so dev testing works from any device without editing this file. Whatever origin you load the
    // app from must be added as a Redirect URI in the Spotify Developer Dashboard, and it must be
    // HTTPS unless the origin is exactly http://127.0.0.1 (Spotify rejects plain HTTP otherwise).
    redirectUri: `${window.location.origin}/callback`,
    scopes: [
      'user-read-private',
      'user-read-email',
      'user-top-read',
      'user-library-read',
      'playlist-read-private',
      'playlist-read-collaborative',
      'playlist-modify-public',
      'playlist-modify-private',
    ],
  },
};
