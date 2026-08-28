export const environment = {
  production: true,
  spotify: {
    clientId: '73ba150d645b4d7d8acfb32f635b1a91',
    redirectUri: 'https://haggisandchips.github.io/SpotifyPlaylistGenerator/callback',
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
