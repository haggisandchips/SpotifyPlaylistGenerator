import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { SpotifyApi, SpotifyArtist, SpotifyPlaylist, SpotifyTrack } from '../../../core/spotify/spotify-api';

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
  // True only while a slot is searching because the initial automatic lookup couldn't
  // confirm a match — used to push it to the bottom of the list on that first attempt. A
  // slot the user later sends back to searching via "Change" keeps its place instead.
  needsInitialResolution: boolean;
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

interface MixTrackItem {
  key: string;
  track: SpotifyTrack;
  artistName: string;
}

type GeneratorTab = 'playlists' | 'artists' | 'songs' | 'mix' | 'generate';

const TAB_ORDER: GeneratorTab[] = ['playlists', 'artists', 'songs', 'mix', 'generate'];

@Component({
  imports: [DragDropModule],
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
  readonly playlists = input<SpotifyPlaylist[] | null>(null);
  readonly playlistsError = input<string | null>(null);
  // Id of a playlist just created/edited elsewhere, so the Playlists tab can scroll it into
  // view once the wizard resets back onto that tab.
  readonly highlightPlaylistId = input<string | null>(null);

  private readonly playlistGrid = viewChild<ElementRef<HTMLElement>>('playlistGrid');
  private readonly artistPanelsEl = viewChild<ElementRef<HTMLElement>>('artistPanels');
  private readonly artistsInputEl = viewChild<ElementRef<HTMLTextAreaElement>>('artistsInputEl');
  private readonly playlistNameEl = viewChild<ElementRef<HTMLInputElement>>('playlistNameEl');

  readonly playlistSelected = output<string | null>();
  readonly playlistCreated = output<string>();
  readonly tracksAdded = output<string>();
  // Fired whenever the wizard returns to its default state (after a successful generate/add),
  // so the parent can drop any playlist selection and show the Generate tab again.
  readonly wizardReset = output<void>();

  protected readonly activeTab = signal<GeneratorTab>('playlists');
  // Tracks how far the wizard has progressed so completed tabs can be clicked to go back;
  // tabs ahead of this stay locked until reached normally via Next.
  protected readonly furthestTabIndex = signal(0);

  protected readonly artistsInput = signal('');
  // How many of an artist's top tracks to pull in initially, and per "Add More" click.
  protected readonly songsPerArtist = signal(5);
  protected readonly isLookingUp = signal(false);
  protected readonly lookupError = signal<string | null>(null);
  protected readonly artistSlots = signal<ArtistSlot[] | null>(null);

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

  // Custom track order for the Mix It Up tab. Null means "untouched" — the list just tracks
  // the natural (per-artist) order live, so tracks added/removed on the Songs tab slot straight
  // into place. Once the user drags or shuffles, this holds the full ordering going forward, and
  // any track added afterwards (e.g. via "Add More") is appended at the end rather than being
  // spliced into the middle of a list they've already arranged.
  protected readonly mixOrder = signal<string[] | null>(null);

  protected readonly hasArtists = computed(() => this.artistsInput().trim().length > 0);
  protected readonly hasAnyTracks = computed(() =>
    (this.artistSlots() ?? []).some((slot) => slot.tracks.length > 0),
  );
  protected readonly allArtistsResolved = computed(() =>
    (this.artistSlots() ?? []).every((slot) => slot.status === 'resolved'),
  );
  // Slots still loading or awaiting manual confirmation — surfaced in the stage-info panel so
  // the user knows there's something to act on even if it's scrolled out of view below.
  protected readonly unresolvedSlots = computed(() =>
    (this.artistSlots() ?? []).filter((slot) => slot.status !== 'resolved'),
  );
  // How many artists the initial lookup has finished with (resolved or needing manual
  // confirmation) vs. the total, so the stage-info panel can show visible progress on a long list.
  protected readonly lookupProgress = computed(() => {
    const slots = this.artistSlots() ?? [];
    return { processed: slots.filter((slot) => slot.status !== 'loading').length, total: slots.length };
  });
  protected readonly hasPlaylistName = computed(() => this.playlistName().trim().length > 0);
  // Combined length of every currently-selected track across all artists, shown as a
  // standout summary at the bottom of the Songs step.
  protected readonly totalDurationMs = computed(() =>
    (this.artistSlots() ?? []).reduce((sum, slot) => sum + this.slotDurationMs(slot), 0),
  );

  // Every selected track, flattened across artists in their natural (Songs-tab) order. A
  // track's key combines its slot and track id since the same track could in principle be
  // pulled in under two different artist searches (e.g. a duet).
  private readonly naturalMixItems = computed<MixTrackItem[]>(() =>
    (this.artistSlots() ?? []).flatMap((slot) =>
      slot.tracks.map((track) => ({
        key: `${slot.id}:${track.id}`,
        track,
        artistName: slot.artist?.name ?? slot.queryText,
      })),
    ),
  );

  // The Mix It Up tab's actual display/playlist order: the natural order, with any stored
  // manual ordering applied on top and reconciled against whatever's currently selected —
  // stale (removed) keys drop out, newly-selected tracks land at the end.
  protected readonly mixedTracks = computed<MixTrackItem[]>(() => {
    const natural = this.naturalMixItems();
    const order = this.mixOrder();
    if (!order) {
      return natural;
    }

    const byKey = new Map(natural.map((item) => [item.key, item]));
    const ordered: MixTrackItem[] = [];
    for (const key of order) {
      const item = byKey.get(key);
      if (item) {
        ordered.push(item);
        byKey.delete(key);
      }
    }
    for (const item of natural) {
      if (byKey.has(item.key)) {
        ordered.push(item);
      }
    }
    return ordered;
  });

  // Render order for the Songs tab: slots the initial automatic lookup couldn't confirm are
  // pushed to the bottom (out of the way while they're being resolved) but keep their
  // relative order among themselves; everything else keeps its original list position, so a
  // slot lands right back where it was as soon as it's resolved. A slot the user sends back
  // to searching via "Change" is excluded from this regrouping and stays put.
  protected readonly displaySlots = computed(() => {
    const slots = this.artistSlots() ?? [];
    const inPlace: ArtistSlot[] = [];
    const needsResolution: ArtistSlot[] = [];
    for (const slot of slots) {
      (slot.status === 'searching' && slot.needsInitialResolution ? needsResolution : inPlace).push(slot);
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

    // Focus the primary field on tabs that start with one, so typing doesn't need an extra
    // click. Reads only activeTab() so this fires on tab switches, never on keystrokes.
    effect(() => {
      const tab = this.activeTab();
      if (tab === 'artists') {
        queueMicrotask(() => this.artistsInputEl()?.nativeElement.focus());
      } else if (tab === 'generate') {
        queueMicrotask(() => this.playlistNameEl()?.nativeElement.focus());
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

    // Scroll a just-created/edited playlist into view once its tile is actually in the DOM
    // (the Playlists tab is active and the refreshed list has rendered).
    effect(() => {
      const id = this.highlightPlaylistId();
      const onPlaylistsTab = this.activeTab() === 'playlists';
      this.playlists();
      if (!id || !onPlaylistsTab) {
        return;
      }
      queueMicrotask(() => {
        const grid = this.playlistGrid()?.nativeElement;
        const target = grid?.querySelector<HTMLElement>(`[data-playlist-id="${id}"]`);
        target?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
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

  selectExistingPlaylist(playlistId: string): void {
    this.playlistSelected.emit(playlistId);
    this.activeTab.set('artists');
  }

  startNewPlaylist(): void {
    this.playlistSelected.emit(null);
    this.activeTab.set('artists');
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
      needsInitialResolution: false,
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
          tracks: allTracks.slice(0, this.songsPerArtist()),
          rawSearchResults: [],
          searchError: null,
          needsInitialResolution: false,
        };
      }

      // No strict match at all means the artist's name doesn't literally appear in any
      // candidate (e.g. a typo or alternate spelling), so start with fuzzy results shown
      // since strict filtering would otherwise leave the list empty. More than one strict
      // match means the query is genuinely ambiguous between distinct real matches, so start
      // narrowed to strict so the user isn't shown noise on top of a already-plausible list.
      return {
        ...base,
        status: 'searching',
        rawSearchResults: candidates,
        searchError: null,
        fuzzyMatching: strictCandidates.length === 0,
        needsInitialResolution: true,
      };
    } catch {
      return {
        ...base,
        status: 'searching',
        rawSearchResults: [],
        searchError: 'Failed to search for this artist.',
        needsInitialResolution: true,
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

  // Below 10k, followers show the exact count; above that the precision isn't meaningful
  // to a user browsing artist candidates, so switch to a rounded K/M form (e.g. 4.2M).
  protected formatFollowers(count: number): string {
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 10_000) {
      return `${Math.round(count / 1_000)}K`;
    }
    return count.toLocaleString();
  }

  // Sum of the selected tracks' lengths for one artist panel.
  protected slotDurationMs(slot: ArtistSlot): number {
    return slot.tracks.reduce((sum, track) => sum + track.duration_ms, 0);
  }

  // Per-artist panel subtotal — compact clock form, always hh:mm:ss.
  protected formatDurationClock(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  // Bottom-of-wizard grand total — spelled out in words rather than a clock, so it reads as
  // a headline figure rather than another timestamp.
  protected formatDurationWords(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (hours > 0) {
      parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    }
    if (minutes > 0) {
      parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    }
    if (seconds > 0 || parts.length === 0) {
      parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
    }
    return parts.join(', ');
  }

  onMixDrop(event: CdkDragDrop<MixTrackItem[]>): void {
    const keys = this.mixedTracks().map((item) => item.key);
    moveItemInArray(keys, event.previousIndex, event.currentIndex);
    this.mixOrder.set(keys);
  }

  shuffleMix(): void {
    const keys = this.mixedTracks().map((item) => item.key);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    this.mixOrder.set(keys);
  }

  resetMixOrder(): void {
    this.mixOrder.set(null);
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
        tracks: allTracks.slice(0, this.songsPerArtist()),
        excludedTrackIds: new Set(),
        rawSearchResults: [],
        isSearching: false,
        needsInitialResolution: false,
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
  }

  // Top tracks not yet included in or excluded from a slot's selection — what's left in the
  // ≤10-track pool Spotify gave us for this artist to draw more from.
  protected remainingCount(slot: ArtistSlot): number {
    const includedIds = new Set(slot.tracks.map((track) => track.id));
    return slot.allTracks.filter((track) => !includedIds.has(track.id) && !slot.excludedTrackIds.has(track.id)).length;
  }

  // How many tracks the primary "Add N More" button would actually add — capped by what's
  // left in the pool once fewer remain than the Songs Per Artist setting.
  protected addMoreCount(slot: ArtistSlot): number {
    return Math.min(this.songsPerArtist(), this.remainingCount(slot));
  }

  // Reopens search using whatever the user last typed into this slot's own search box,
  // never the name of the artist they ended up selecting — those can differ (e.g. typing
  // "mega" then picking the wrong "Meghan Thee Stallion" result should reopen to "mega",
  // not to her name).
  changeArtist(slot: ArtistSlot): void {
    this.updateSlot(slot.id, {
      status: 'searching',
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

  addMoreTracks(slot: ArtistSlot, count: number): void {
    const includedIds = new Set(slot.tracks.map((track) => track.id));
    const pool = slot.allTracks.filter(
      (track) => !includedIds.has(track.id) && !slot.excludedTrackIds.has(track.id),
    );
    const additional = pool.slice(0, count);
    this.updateSlot(slot.id, { tracks: [...slot.tracks, ...additional] });
  }

  scrollToFirstUnresolved(): void {
    const firstUnresolved = this.unresolvedSlots()[0];
    if (!firstUnresolved) {
      return;
    }
    const container = this.artistPanelsEl()?.nativeElement;
    const target = container?.querySelector<HTMLElement>(`[data-slot-id="${firstUnresolved.id}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  goToMixTab(): void {
    this.activeTab.set('mix');
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
      const uris = this.mixedTracks().map((item) => item.track.uri);

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
      const uris = this.mixedTracks().map((item) => item.track.uri);

      if (uris.length > 0) {
        await this.spotifyApi.addTracksToPlaylist(playlistId, uris);
      }

      this.tracksAdded.emit(playlistId);
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

    this.wizardReset.emit();
    this.activeTab.set('playlists');
    this.furthestTabIndex.set(0);
    this.artistsInput.set('');
    this.songsPerArtist.set(5);
    this.artistSlots.set(null);
    this.mixOrder.set(null);
    this.playlistName.set('');
    this.playlistDescription.set('');
    this.isPrivate.set(true);
    this.generateError.set(null);
    this.addError.set(null);
    this.lookupError.set(null);
  }
}
