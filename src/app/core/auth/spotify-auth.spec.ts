import { TestBed } from '@angular/core/testing';
import { SpotifyAuth } from './spotify-auth';

describe('SpotifyAuth', () => {
  let service: SpotifyAuth;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SpotifyAuth);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
