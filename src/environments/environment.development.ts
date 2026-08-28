export const environment = {
  production: false,
  spotify: {
    clientId: '73ba150d645b4d7d8acfb32f635b1a91',
    redirectUri: 'http://127.0.0.1:4200/callback',
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
