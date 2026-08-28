import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { SpotifyApi, SpotifyArtist, SpotifyTrack } from '../../../core/spotify/spotify-api';

const SEARCH_DEBOUNCE_MS = 200;
// Each artist lookup fires 1-2 Spotify requests; looking up a big list (e.g. a festival
// lineup) in parallel triggers 429s. Start reasonably fast and processed top-down, but
// back off hard for the rest of the run the moment Spotify actually throttles us.
const ARTIST_LOOKUP_CONCURRENCY = 3;
const ARTIST_LOOKUP_THROTTLED_CONCURRENCY = 1;

// Runs `task` over `items` starting from the first item, preserving result order, with the
// number in flight capped by whatever `getConcurrencyLimit` currently returns — checked
// before each new item is started, so a caller can lower it mid-run in response to feedback
// (e.g. a rate-limit hit) without cancelling work already in flight.
function runWithAdaptiveConcurrency<T, R>(
  items: T[],
  getConcurrencyLimit: () => number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  return new Promise((resolve, reject) => {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    let active = 0;
    let completed = 0;
    let settled = false;

    const startMore = (): void => {
      if (settled) {
        return;
      }
      while (active < getConcurrencyLimit() && nextIndex < items.length) {
        const index = nextIndex++;
        active++;
        task(items[index]).then(
          (result) => {
            results[index] = result;
            active--;
            completed++;
            if (completed === items.length) {
              settled = true;
              resolve(results);
            } else {
              startMore();
            }
          },
          (err) => {
            settled = true;
            reject(err);
          },
        );
      }
    };

    startMore();
  });
}

type ArtistSlotStatus = 'loading' | 'searching' | 'resolved';

interface ArtistSlot {
  id: string;
  queryText: string;
  status: ArtistSlotStatus;
  artist?: SpotifyArtist;
  allTracks: SpotifyTrack[];
  tracks: SpotifyTrack[];
  excludedTrackIds: Set<string>;
  rawSearchResults: SpotifyArtist[];
  isSearching: boolean;
  searchError: string | null;
  fuzzyMatching: boolean;
}

interface ArtistPreviewState {
  tracks: SpotifyTrack[];
  isLoading: boolean;
  loaded: boolean;
  error: string | null;
}

interface HoveredCandidate {
  slotId: string;
  candidate: SpotifyArtist;
}

type GeneratorTab = 'artists' | 'songs' | 'generate';

const TAB_ORDER: GeneratorTab[] = ['artists', 'songs', 'generate'];

@Component({
  imports: [],
  selector: 'app-generator-panel',
  styleUrl: './generator-panel.scss',
  templateUrl: './generator-panel.html',
})
export class GeneratorPanel {
  private readonly spotifyApi = inject(SpotifyApi);
  private readonly searchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  readonly userId = input.required<string>();
  readonly market = input<string>('US');
  readonly selectedPlaylistId = input<string | null>(null);

  readonly playlistCreated = output<string>();
  readonly tracksAdded = output<void>();

  protected readonly activeTab = signal<GeneratorTab>('artists');
  // Tracks how far the wizard has progressed so completed tabs can be clicked to go back;
  // tabs ahead of this stay locked until reached normally via Next.
  protected readonly furthestTabIndex = signal(0);

  protected readonly artistsInput = signal('');
  protected readonly isLookingUp = signal(false);
  protected readonly lookupError = signal<string | null>(null);
  protected readonly artistSlots = signal<ArtistSlot[] | null>(null);
  protected readonly exhaustedSlotIds = signal<Set<string>>(new Set());
  protected readonly infoMessage = signal<string | null>(null);

  // Hover/focus preview shown in the resolution (ambiguous-match) panels only. Top-track
  // lookups are cached per artist id for as long as we're on the Songs tab, so re-hovering
  // the same candidate doesn't refetch.
  protected readonly hoveredCandidate = signal<HoveredCandidate | null>(null);
  protected readonly previewPlacement = signal<'above' | 'below'>('below');
  protected readonly artistPreviews = signal<ReadonlyMap<string, ArtistPreviewState>>(new Map());

  protected readonly playlistName = signal('');
  protected readonly playlistDescription = signal('');
  protected readonly isPrivate = signal(true);
  protected readonly isGenerating = signal(false);
  protected readonly generateError = signal<string | null>(null);

  protected readonly isAddingToPlaylist = signal(false);
  protected readonly addError = signal<string | null>(null);

  protected readonly hasArtists = computed(() => this.artistsInput().trim().length > 0);
  protected readonly hasAnyTracks = computed(() =>
    (this.artistSlots() ?? []).some((slot) => slot.tracks.length > 0),
  );
  protected readonly allArtistsResolved = computed(() =>
    (this.artistSlots() ?? []).every((slot) => slot.status === 'resolved'),
  );
  protected readonly hasPlaylistName = computed(() => this.playlistName().trim().length > 0);

  // Render order for the Songs tab: slots that still need the user to pick an artist are
  // pushed to the bottom (out of the way while they're being resolved) but keep their
  // relative order among themselves; everything else keeps its original list position, so a
  // slot lands right back where it was as soon as it's resolved.
  protected readonly displaySlots = computed(() => {
    const slots = this.artistSlots() ?? [];
    const inPlace: ArtistSlot[] = [];
    const needsResolution: ArtistSlot[] = [];
    for (const slot of slots) {
      (slot.status === 'searching' ? needsResolution : inPlace).push(slot);
    }
    return [...inPlace, ...needsResolution];
  });

  constructor() {
    // The Generate tab is hidden once a playlist is selected; if the wizard is
    // already sitting on it when a selection happens, fall back to Songs.
    effect(() => {
      if (this.selectedPlaylistId() && this.activeTab() === 'generate') {
        this.activeTab.set('songs');
      }
    });

    effect(() => {
      const index = TAB_ORDER.indexOf(this.activeTab());
      if (index > this.furthestTabIndex()) {
        this.furthestTabIndex.set(index);
      }
    });

    // The artist-preview cache (and any active hover) only makes sense while looking at the
    // Songs tab's resolution panels — drop it as soon as we leave.
    effect(() => {
      if (this.activeTab() !== 'songs') {
        this.hoveredCandidate.set(null);
        this.artistPreviews.set(new Map());
      }
    });
  }

  protected isTabReachable(tab: GeneratorTab): boolean {
    return TAB_ORDER.indexOf(tab) <= this.furthestTabIndex();
  }

  goToTab(tab: GeneratorTab): void {
    if (this.isTabReachable(tab)) {
      this.activeTab.set(tab);
    }
  }

  async lookupArtists(): Promise<void> {
    const names = this.artistsInput()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (names.length === 0) {
      return;
    }

    this.isLookingUp.set(true);
    this.lookupError.set(null);

    // Show a placeholder card per artist immediately and jump to Songs, rather than making
    // the user wait on the Artists tab for every lookup to finish — each placeholder is
    // replaced in place as its own lookup resolves.
    const placeholders: ArtistSlot[] = names.map((name) => ({
      id: crypto.randomUUID(),
      queryText: name,
      status: 'loading',
      allTracks: [],
      tracks: [],
      excludedTrackIds: new Set<string>(),
      rawSearchResults: [],
      isSearching: false,
      searchError: null,
      fuzzyMatching: false,
    }));
    this.artistSlots.set(placeholders);
    this.activeTab.set('songs');

    try {
      let concurrencyLimit = ARTIST_LOOKUP_CONCURRENCY;
      let rateLimitHitsSeen = this.spotifyApi.rateLimitHits();
      const getConcurrencyLimit = () => {
        const rateLimitHitsNow = this.spotifyApi.rateLimitHits();
        if (rateLimitHitsNow > rateLimitHitsSeen) {
          rateLimitHitsSeen = rateLimitHitsNow;
          concurrencyLimit = ARTIST_LOOKUP_THROTTLED_CONCURRENCY;
        }
        return concurrencyLimit;
      };

      await runWithAdaptiveConcurrency(placeholders, getConcurrencyLimit, async (placeholder) => {
        const resolved = await this.createInitialSlot(placeholder.queryText, placeholder.id);
        this.updateSlot(placeholder.id, resolved);
      });
    } catch (err) {
      this.lookupError.set(err instanceof Error ? err.message : 'Failed to look up artists.');
    } finally {
      this.isLookingUp.set(false);
    }
  }

  // Initial matching always uses strict (non-fuzzy) filtering, regardless of the fuzzy toggle —
  // that toggle only affects what's offered when browsing/searching manually. If exactly one
  // candidate's name actually contains what was typed, that's confident enough to auto-select.
  private async createInitialSlot(name: string, id: string): Promise<ArtistSlot> {
    const base = {
      id,
      queryText: name,
      allTracks: [] as SpotifyTrack[],
      tracks: [] as SpotifyTrack[],
      excludedTrackIds: new Set<string>(),
      isSearching: false,
      fuzzyMatching: false,
    };

    try {
      const candidates = await this.spotifyApi.searchArtists(name);
      const strictCandidates = this.applyStrictFilter(candidates, name);
      const resolved = this.resolveUniqueMatch(strictCandidates, name);

      if (resolved) {
        const allTracks = await this.spotifyApi.getArtistTopTracks(resolved.id, this.market());
        return {
          ...base,
          status: 'resolved',
          artist: resolved,
          allTracks,
          tracks: allTracks.slice(0, 5),
          rawSearchResults: [],
          searchError: null,
        };
      }

      return { ...base, status: 'searching', rawSearchResults: candidates, searchError: null };
    } catch {
      return {
        ...base,
        status: 'searching',
        rawSearchResults: [],
        searchError: 'Failed to search for this artist.',
      };
    }
  }

  private resolveUniqueMatch(strictCandidates: SpotifyArtist[], query: string): SpotifyArtist | undefined {
    if (strictCandidates.length === 1) {
      return strictCandidates[0];
    }
    const normalizedQuery = query.trim().toLowerCase();
    const exactMatches = strictCandidates.filter((candidate) => candidate.name.trim().toLowerCase() === normalizedQuery);
    return exactMatches.length === 1 ? exactMatches[0] : undefined;
  }

  onSearchTextChange(slotId: string, value: string): void {
    this.updateSlot(slotId, { queryText: value });

    const existing = this.searchDebounceTimers.get(slotId);
    if (existing) {
      clearTimeout(existing);
    }
    this.searchDebounceTimers.set(
      slotId,
      setTimeout(() => this.runSearch(slotId), SEARCH_DEBOUNCE_MS),
    );
  }

  private async runSearch(slotId: string): Promise<void> {
    const slot = (this.artistSlots() ?? []).find((s) => s.id === slotId);
    if (!slot) {
      return;
    }

    const query = slot.queryText.trim();
    if (!query) {
      this.updateSlot(slotId, { rawSearchResults: [], isSearching: false, searchError: null });
      return;
    }

    this.updateSlot(slotId, { isSearching: true, searchError: null });

    try {
      const results = await this.spotifyApi.searchArtists(query);
      this.updateSlot(slotId, { rawSearchResults: results, isSearching: false });
    } catch (err) {
      this.updateSlot(slotId, {
        isSearching: false,
        searchError: err instanceof Error ? err.message : 'Search failed.',
      });
    }
  }

  onCandidateHoverStart(slotId: string, candidate: SpotifyArtist, anchorEl: HTMLElement): void {
    this.hoveredCandidate.set({ slotId, candidate });
    // Whichever side of the anchor has more room wins, so the preview never has to push the
    // page around when hovering artists near the bottom of a long results list.
    const rect = anchorEl.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    this.previewPlacement.set(spaceAbove > spaceBelow ? 'above' : 'below');
    void this.loadArtistPreview(candidate.id);
  }

  onCandidateHoverEnd(slotId: string, candidateId: string): void {
    const current = this.hoveredCandidate();
    if (current && current.slotId === slotId && current.candidate.id === candidateId) {
      this.hoveredCandidate.set(null);
    }
  }

  private async loadArtistPreview(artistId: string): Promise<void> {
    const existing = this.artistPreviews().get(artistId);
    if (existing?.isLoading || existing?.loaded) {
      return;
    }

    this.setArtistPreview(artistId, { tracks: [], isLoading: true, loaded: false, error: null });

    try {
      const tracks = await this.spotifyApi.getArtistTopTracks(artistId, this.market());
      this.setArtistPreview(artistId, { tracks: tracks.slice(0, 5), isLoading: false, loaded: true, error: null });
    } catch (err) {
      this.setArtistPreview(artistId, {
        tracks: [],
        isLoading: false,
        loaded: false,
        error: err instanceof Error ? err.message : 'Failed to load top tracks.',
      });
    }
  }

  private setArtistPreview(artistId: string, state: ArtistPreviewState): void {
    this.artistPreviews.update((map) => {
      const next = new Map(map);
      next.set(artistId, state);
      return next;
    });
  }

  // The results actually shown for a slot: Spotify's raw matches when that slot's fuzzy
  // toggle is on, or narrowed to ones whose name contains what was typed when it's off.
  // Computed at display time (rather than baked in when fetched) so toggling updates
  // instantly, with no re-fetch — and each slot's toggle is independent of the others.
  protected visibleResults(slot: ArtistSlot): SpotifyArtist[] {
    return slot.fuzzyMatching ? slot.rawSearchResults : this.applyStrictFilter(slot.rawSearchResults, slot.queryText);
  }

  toggleFuzzyMatching(slot: ArtistSlot): void {
    this.updateSlot(slot.id, { fuzzyMatching: !slot.fuzzyMatching });
  }

  private applyStrictFilter(candidates: SpotifyArtist[], query: string): SpotifyArtist[] {
    const normalizedQuery = query.trim().toLowerCase();
    return candidates.filter((candidate) => candidate.name.toLowerCase().includes(normalizedQuery));
  }

  async selectArtist(slotId: string, artist: SpotifyArtist): Promise<void> {
    this.updateSlot(slotId, { isSearching: true, searchError: null });

    try {
      const allTracks = await this.spotifyApi.getArtistTopTracks(artist.id, this.market());
      this.updateSlot(slotId, {
        status: 'resolved',
        artist,
        allTracks,
        tracks: allTracks.slice(0, 5),
        excludedTrackIds: new Set(),
        rawSearchResults: [],
        isSearching: false,
      });
      this.exhaustedSlotIds.update((set) => {
        if (!set.has(slotId)) {
          return set;
        }
        const next = new Set(set);
        next.delete(slotId);
        return next;
      });
    } catch (err) {
      this.updateSlot(slotId, {
        isSearching: false,
        searchError: err instanceof Error ? err.message : 'Failed to load tracks for this artist.',
      });
    }
  }

  removeSlot(slotId: string): void {
    const timer = this.searchDebounceTimers.get(slotId);
    if (timer) {
      clearTimeout(timer);
      this.searchDebounceTimers.delete(slotId);
    }
    this.artistSlots.update((slots) => (slots ?? []).filter((s) => s.id !== slotId));
    this.exhaustedSlotIds.update((set) => {
      if (!set.has(slotId)) {
        return set;
      }
      const next = new Set(set);
      next.delete(slotId);
      return next;
    });
  }

  changeArtist(slot: ArtistSlot): void {
    const prefill = slot.artist?.name ?? slot.queryText;
    this.updateSlot(slot.id, {
      status: 'searching',
      queryText: prefill,
      rawSearchResults: [],
      isSearching: false,
      searchError: null,
    });
    this.runSearch(slot.id);
  }

  removeTrack(slotId: string, trackId: string): void {
    this.artistSlots.update((slots) =>
      (slots ?? []).map((s) => {
        if (s.id !== slotId) {
          return s;
        }
        const excludedTrackIds = new Set(s.excludedTrackIds);
        excludedTrackIds.add(trackId);
        return { ...s, tracks: s.tracks.filter((track) => track.id !== trackId), excludedTrackIds };
      }),
    );
  }

  addMoreTracks(slot: ArtistSlot): void {
    const includedIds = new Set(slot.tracks.map((track) => track.id));
    const pool = slot.allTracks.filter(
      (track) => !includedIds.has(track.id) && !slot.excludedTrackIds.has(track.id),
    );

    if (pool.length === 0) {
      this.exhaustedSlotIds.update((set) => new Set(set).add(slot.id));
      this.infoMessage.set(`No more tracks are available for ${slot.artist?.name ?? slot.queryText}.`);
      return;
    }

    const additional = pool.slice(0, 5);
    this.infoMessage.set(null);
    this.updateSlot(slot.id, { tracks: [...slot.tracks, ...additional] });
  }

  goToGenerateTab(): void {
    this.activeTab.set('generate');
  }

  async generatePlaylist(): Promise<void> {
    const name = this.playlistName().trim();
    if (!name) {
      return;
    }

    this.isGenerating.set(true);
    this.generateError.set(null);

    try {
      const uris = (this.artistSlots() ?? []).flatMap((slot) => slot.tracks.map((track) => track.uri));

      const playlist = await this.spotifyApi.createPlaylist(this.userId(), {
        name,
        description: this.playlistDescription().trim(),
        isPublic: !this.isPrivate(),
      });

      if (uris.length > 0) {
        await this.spotifyApi.addTracksToPlaylist(playlist.id, uris);
      }

      this.playlistCreated.emit(playlist.id);
      this.resetWizard();
    } catch (err) {
      this.generateError.set(err instanceof Error ? err.message : 'Failed to create the playlist.');
    } finally {
      this.isGenerating.set(false);
    }
  }

  async addSongsToSelectedPlaylist(playlistId: string): Promise<void> {
    this.isAddingToPlaylist.set(true);
    this.addError.set(null);

    try {
      const uris = (this.artistSlots() ?? []).flatMap((slot) => slot.tracks.map((track) => track.uri));

      if (uris.length > 0) {
        await this.spotifyApi.addTracksToPlaylist(playlistId, uris);
      }

      this.tracksAdded.emit();
      this.resetWizard();
    } catch (err) {
      this.addError.set(err instanceof Error ? err.message : 'Failed to add songs to the playlist.');
    } finally {
      this.isAddingToPlaylist.set(false);
    }
  }

  private updateSlot(slotId: string, patch: Partial<ArtistSlot>): void {
    this.artistSlots.update((slots) => (slots ?? []).map((s) => (s.id === slotId ? { ...s, ...patch } : s)));
  }

  private resetWizard(): void {
    for (const timer of this.searchDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.searchDebounceTimers.clear();

    this.activeTab.set('artists');
    this.furthestTabIndex.set(0);
    this.artistsInput.set('');
    this.artistSlots.set(null);
    this.exhaustedSlotIds.set(new Set());
    this.infoMessage.set(null);
    this.playlistName.set('');
    this.playlistDescription.set('');
    this.isPrivate.set(true);
    this.generateError.set(null);
    this.addError.set(null);
    this.lookupError.set(null);
  }
}
