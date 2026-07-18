import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi, IdentityContext } from '../../types/jc';

const mocks = vi.hoisted(() => ({
  currentPageHandle: vi.fn(),
  getItemCached: vi.fn(),
  toast: vi.fn()
}));

vi.mock('../pages/fallback-host', () => ({
  currentPageHandle: mocks.currentPageHandle
}));
vi.mock('../helpers', () => ({
  getItemCached: mocks.getItemCached
}));
vi.mock('./library-render', () => ({
  renderActiveBookmarks: vi.fn()
}));
vi.mock('../../core/ui-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/ui-kit')>();
  return { ...actual, toast: mocks.toast };
});

import {
  findAllOrphanedAndOfferMigration,
  findAndOfferReplacement,
  searchForReplacementItem
} from './library-replacements';

interface TestBookmark {
  [key: string]: unknown;
  itemId: string;
  tmdbId: string;
  tvdbId: string;
  mediaType: string;
  identityVersion: number;
  itemType: string;
  seriesTmdbId: string;
  seriesTvdbId: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeEndNumber: number | null;
  name: string;
}

function bookmark(overrides: Partial<TestBookmark> = {}): TestBookmark {
  return {
    itemId: 'missing-item',
    tmdbId: 'target-tmdb',
    tvdbId: '',
    mediaType: 'movie',
    identityVersion: 1,
    itemType: 'movie',
    seriesTmdbId: '',
    seriesTvdbId: '',
    seasonNumber: null,
    episodeNumber: null,
    episodeEndNumber: null,
    name: 'Missing movie',
    ...overrides
  };
}

function item(id: string, tmdbId = `other-${id}`): Record<string, unknown> {
  return {
    Id: id,
    Name: `Item ${id}`,
    Type: 'Movie',
    ProviderIds: { Tmdb: tmdbId }
  };
}

function page(items: Array<Record<string, unknown>>, total: number, startIndex: number): Record<string, unknown> {
  return { Items: items, TotalRecordCount: total, StartIndex: startIndex };
}

function group(details = bookmark()): {
  details: TestBookmark;
  bookmarks: Array<TestBookmark & { id: string }>;
} {
  return {
    details,
    bookmarks: [{ id: 'bookmark-1', ...details }]
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function installApi(jf: ReturnType<typeof vi.fn>): void {
  JC.core.api = { jf } as unknown as ApiApi;
}

function captureIdentity(userId = 'replacement-user'): IdentityContext {
  JC.identity.transition('replacement-server', '', 'replacement-test-reset');
  return JC.identity.transition('replacement-server', userId, 'replacement-test-user')!;
}

function expectMainRequest(
  call: unknown[],
  expectedUserId: string,
  expectedStartIndex: number,
  expectedItemTypes = 'Movie,MusicVideo'
): void {
  const url = new URL(`http://jellyfin.test${String(call[0])}`);
  expect(url.pathname).toBe(`/Users/${expectedUserId.replace(/-/g, '').toLowerCase()}/Items`);
  expect(url.searchParams.get('Limit')).toBe('500');
  expect(url.searchParams.get('StartIndex')).toBe(String(expectedStartIndex));
  // Replacement identity never reads mutable playback state; the payload must
  // exclude it so a progress update mid-scan cannot perturb the result.
  expect(url.searchParams.get('EnableUserData')).toBe('false');
  // These params are what make a negative scan sound: a recursive search of the
  // right item types, deterministically ordered so StartIndex pagination is
  // stable. Dropping Recursive collapses TotalRecordCount to top-level items and
  // manufactures a false no-match; narrowing IncludeItemTypes or the sort has
  // the same effect. Assert them so such a regression fails here.
  expect(url.searchParams.get('Recursive')).toBe('true');
  expect(url.searchParams.get('IncludeItemTypes')).toBe(expectedItemTypes);
  expect(url.searchParams.get('SortBy')).toBe('DateCreated');
  expect(url.searchParams.get('SortOrder')).toBe('Descending');
  expect(call[1]).toEqual({ skipCache: true });
}

describe('bookmark replacement library search', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.currentPageHandle.mockReset().mockReturnValue({ track: vi.fn() });
    mocks.getItemCached.mockReset();
    mocks.toast.mockReset();
    JC.t = (key: string) => key.startsWith('bookmark_orphaned_') ? `${key}:{count}` : key;
    JC.escapeHtml = (value: unknown) => typeof value === 'string' ? value : '';
    window.ApiClient = {
      getCurrentUserId: () => JC.identity.capture()?.userId || '',
      getImageUrl: (id: string) => `http://jellyfin.test/Items/${id}/Images/Primary`,
      getItem: vi.fn()
    } as unknown as typeof window.ApiClient;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // AC1: a replacement sorting after item 500 is found on page two — 500 is a
  // page size, not a hard truncation cap.
  it('finds a logical replacement on page two without treating 500 as a hard cap', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`page-one-${index}`));
    const jf = vi.fn()
      .mockResolvedValueOnce(page(firstPage, 501, 0))
      .mockResolvedValueOnce(page([item('page-two-match', 'target-tmdb')], 501, 500));
    installApi(jf);
    const context = captureIdentity('regular-user');

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({
      status: 'match',
      items: [expect.objectContaining({ Id: 'page-two-match' })]
    });

    // One forward pass, offset advancing past 500 — no whole-library re-scan.
    expect(jf).toHaveBeenCalledTimes(2);
    expectMainRequest(jf.mock.calls[0], 'regular-user', 0);
    expectMainRequest(jf.mock.calls[1], 'regular-user', 500);
  });

  // AC1: a server that trims a page below the requested Limit must not leave a
  // gap — the next request starts at the rows actually returned, not at +500, so
  // a replacement in the skipped range is still found.
  it('advances the offset by rows returned when a page is shorter than the limit', async () => {
    const shortPage = Array.from({ length: 100 }, (_, index) => item(`short-${index}`));
    const jf = vi.fn()
      .mockResolvedValueOnce(page(shortPage, 600, 0))
      .mockResolvedValueOnce(page([item('gap-match', 'target-tmdb')], 600, 100));
    installApi(jf);
    const context = captureIdentity('regular-user');

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({
      status: 'match',
      items: [expect.objectContaining({ Id: 'gap-match' })]
    });

    expect(jf).toHaveBeenCalledTimes(2);
    // Second request continues at 100 (rows returned), never jumping to 500 and
    // skipping rows 100-499.
    expectMainRequest(jf.mock.calls[0], 'regular-user', 0);
    expectMainRequest(jf.mock.calls[1], 'regular-user', 100);
  });

  // AC3/AC4: a repeated boundary row cannot pass a truncated scan off as a proven
  // absence — exhaustion is decided by DISTINCT ids, so a duplicate leaves the
  // scan short and it fails closed rather than reporting a false no-match.
  it('fails closed when a repeated row would otherwise fake exhaustion', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`dup-${index}`));
    const jf = vi.fn()
      // Page two repeats a page-one id (shifted DateCreated window) instead of
      // the genuine 501st item. Raw rows would total 501 == advertised, but only
      // 500 distinct ids were ever examined.
      .mockResolvedValueOnce(page(firstPage, 501, 0))
      .mockResolvedValueOnce(page([item('dup-0')], 501, 500))
      .mockResolvedValueOnce(page([], 501, 501));
    installApi(jf);
    const context = captureIdentity();

    const result = await searchForReplacementItem(bookmark(), context);
    expect(result.status).toBe('failed');
  });

  // A page that carries a logical match but advertises fewer rows than it
  // returns is internally inconsistent; the bounds check runs BEFORE the match is
  // published, so it fails closed rather than seeding a migration from a bad
  // envelope.
  it('fails closed on a matching row that arrives on an over-full page', async () => {
    const jf = vi.fn().mockResolvedValueOnce(
      page([item('over-match', 'target-tmdb'), item('extra')], 1, 0)
    );
    installApi(jf);
    const context = captureIdentity();

    const result = await searchForReplacementItem(bookmark(), context);
    expect(result.status).toBe('failed');
    expect(jf).toHaveBeenCalledTimes(1);
  });

  // AC4: a match on the first page short-circuits without downloading the rest
  // of a huge library.
  it('returns a first-page match without scanning the advertised remainder', async () => {
    const jf = vi.fn().mockResolvedValueOnce(page([item('early', 'target-tmdb')], 50_000, 0));
    installApi(jf);
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({
      status: 'match',
      items: [expect.objectContaining({ Id: 'early' })]
    });
    expect(jf).toHaveBeenCalledTimes(1);
  });

  it.each(['admin-user', 'regular-user'])('keeps the captured %s identity in every item request', async (userId) => {
    const jf = vi.fn().mockResolvedValue(page([], 0, 0));
    installApi(jf);
    const context = captureIdentity(userId);

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({ status: 'no-match' });

    expect(jf).toHaveBeenCalledTimes(1);
    expectMainRequest(jf.mock.calls[0], userId, 0);
  });

  // AC2: transport/HTTP failures must be distinguishable from a proven absence.
  it.each([401, 403, 429, 500, 503])('classifies HTTP %s as failed and retains the status', async (status) => {
    const error = Object.assign(new Error(`HTTP ${status}`), { status });
    installApi(vi.fn().mockRejectedValue(error));
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({
      status: 'failed',
      error
    });
  });

  it('classifies transport and main-page JSON parse failures as failed', async () => {
    const transport = new TypeError('network unavailable');
    installApi(vi.fn().mockRejectedValueOnce(transport));
    const transportContext = captureIdentity('transport-user');
    await expect(searchForReplacementItem(bookmark(), transportContext)).resolves.toEqual({
      status: 'failed',
      error: transport
    });

    // jf parses the body internally and REJECTS with a SyntaxError on malformed
    // JSON (it never resolves a raw string), so a rejected SyntaxError is the
    // real production parse path: it must reach the outer catch as failed with
    // the SyntaxError preserved, not be misread as a no-match.
    const parseError = new SyntaxError('Unexpected token < in JSON at position 0');
    installApi(vi.fn().mockRejectedValueOnce(parseError));
    const parseContext = captureIdentity('parse-user');
    const result = await searchForReplacementItem(bookmark(), parseContext);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed parse outcome');
    expect(result.error).toBe(parseError);
    expect(result.error).toBeInstanceOf(SyntaxError);
  });

  // AC2/AC4: aborts and stale identity are cancellations, never failures or a
  // false no-match.
  it('classifies aborts and stale identities as cancelled', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    installApi(vi.fn().mockRejectedValueOnce(abort));
    const abortContext = captureIdentity('abort-user');
    await expect(searchForReplacementItem(bookmark(), abortContext)).resolves.toEqual({ status: 'cancelled' });

    const staleContext = captureIdentity('old-user');
    JC.identity.transition('replacement-server', 'new-user', 'replacement-test-switch');
    const jf = vi.fn();
    installApi(jf);
    await expect(searchForReplacementItem(bookmark(), staleContext)).resolves.toEqual({ status: 'cancelled' });
    expect(jf).not.toHaveBeenCalled();
  });

  // AC4: an account switch mid-pagination cancels and never adopts a match from
  // the new account's page.
  it('cancels after an account transition while a continuation page is in flight', async () => {
    const continuation = deferred<unknown>();
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`first-${index}`));
    const jf = vi.fn()
      .mockResolvedValueOnce(page(firstPage, 501, 0))
      .mockReturnValueOnce(continuation.promise);
    installApi(jf);
    const context = captureIdentity('first-user');

    const pending = searchForReplacementItem(bookmark(), context);
    await vi.waitFor(() => expect(jf).toHaveBeenCalledTimes(2));
    JC.identity.transition('replacement-server', 'second-user', 'replacement-test-mid-page-switch');
    continuation.resolve(page([item('late-match', 'target-tmdb')], 501, 500));

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expectMainRequest(jf.mock.calls[0], 'first-user', 0);
    expectMainRequest(jf.mock.calls[1], 'first-user', 500);
  });

  it('cancels rather than degrading an aborted parent-series enrichment chunk', async () => {
    const abort = new Error('enrichment aborted');
    abort.name = 'AbortError';
    const episodePage = page([{
      Id: 'episode', Name: 'Episode', Type: 'Episode', SeriesId: 'series',
      ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: {}
    }], 1, 0);
    // Main page resolves, then the per-page enrichment chunk aborts.
    const jf = vi.fn().mockResolvedValueOnce(episodePage).mockRejectedValueOnce(abort);
    installApi(jf);
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark({
      mediaType: 'tv', itemType: 'episode', tmdbId: '', seriesTmdbId: 'series-tmdb',
      seasonNumber: 1, episodeNumber: 1, episodeEndNumber: 1
    }), context)).resolves.toEqual({ status: 'cancelled' });
  });

  // AC5: episode identity is matched by series provider + season/episode number
  // via parent-series enrichment (reusing compareBookmarkIdentity).
  it('matches an episode by enriched series provider and episode range', async () => {
    const episodePage = page([{
      Id: 'replacement-episode', Name: 'S1E1', Type: 'Episode', SeriesId: 'series-x',
      ParentIndexNumber: 1, IndexNumber: 1, IndexNumberEnd: 1, ProviderIds: {}
    }], 1, 0);
    const jf = vi.fn()
      .mockResolvedValueOnce(episodePage)
      .mockResolvedValueOnce({ Items: [{
        Id: 'series-x', Name: 'Series', Type: 'Series', ProviderIds: { Tmdb: 'series-tmdb' }
      }] });
    installApi(jf);
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark({
      mediaType: 'tv', itemType: 'episode', tmdbId: '', seriesTmdbId: 'series-tmdb',
      seasonNumber: 1, episodeNumber: 1, episodeEndNumber: 1
    }), context)).resolves.toEqual({
      status: 'match',
      items: [expect.objectContaining({ Id: 'replacement-episode' })]
    });
  });

  // AC3: a full, failure-free scan that finds nothing is the only path to a
  // confident no-match.
  it('returns no-match only after examining every advertised item', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`absent-${index}`));
    const jf = vi.fn()
      .mockResolvedValueOnce(page(firstPage, 501, 0))
      .mockResolvedValueOnce(page([item('absent-last')], 501, 500));
    installApi(jf);
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({ status: 'no-match' });
    expect(jf).toHaveBeenCalledTimes(2);
  });

  // AC4: fail-closed on any pagination that cannot prove exhaustion — never a
  // confident no-match from a truncated or inconsistent scan.
  it.each([
    {
      name: 'empty page before exhaustion',
      pages: [
        page(Array.from({ length: 500 }, (_, i) => item(`a-${i}`)), 501, 0),
        page([], 501, 500)
      ]
    },
    {
      name: 'non-advancing reported offset',
      pages: [
        page(Array.from({ length: 500 }, (_, i) => item(`b-${i}`)), 501, 0),
        page([item('b-tail')], 501, 0)
      ]
    },
    {
      name: 'more rows than advertised',
      pages: [page([item('one'), item('two')], 1, 0)]
    },
    {
      name: 'shifting total metadata',
      pages: [
        page(Array.from({ length: 500 }, (_, i) => item(`c-${i}`)), 501, 0),
        page([item('c-tail')], 502, 500)
      ]
    }
  ])('fails closed on $name', async ({ pages }) => {
    const jf = vi.fn();
    for (const p of pages) jf.mockResolvedValueOnce(p);
    installApi(jf);
    const context = captureIdentity();

    const result = await searchForReplacementItem(bookmark(), context);
    expect(result.status).toBe('failed');
    expect(jf).toHaveBeenCalledTimes(pages.length);
  });

  it('fails on malformed pagination metadata instead of reporting absence', async () => {
    installApi(vi.fn().mockResolvedValueOnce({ Items: [], TotalRecordCount: '0', StartIndex: 0 }));
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toMatchObject({ status: 'failed' });
  });

  // AC4: a negative that would require scanning past the item safety bound is a
  // failure, not a confident no-match — and the bound is not re-imposed as a
  // truncation of a present match (covered above by the first-page-match test).
  it('fails a negative that exceeds the explicit item safety bound rather than reporting absence', async () => {
    const jf = vi.fn().mockResolvedValueOnce(page([item('one')], 500_001, 0));
    installApi(jf);
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toMatchObject({ status: 'failed' });
    expect(jf).toHaveBeenCalledTimes(1);
  });

  it('uses separate single-item failure and absence messages and always restores the trigger', async () => {
    const failedButton = document.createElement('button');
    const failure = Object.assign(new Error('unavailable'), { status: 500 });
    installApi(vi.fn().mockRejectedValueOnce(failure));
    const failedContext = captureIdentity('failed-user');

    await findAndOfferReplacement(group(), failedButton, failedContext);

    expect(mocks.toast).toHaveBeenCalledWith('bookmark_search_failed', 3000);
    expect(mocks.toast).not.toHaveBeenCalledWith('bookmark_no_replacement', expect.anything());
    expect(failedButton.disabled).toBe(false);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();

    mocks.toast.mockClear();
    const absentButton = document.createElement('button');
    installApi(vi.fn().mockResolvedValue(page([], 0, 0)));
    const absentContext = captureIdentity('absent-user');

    await findAndOfferReplacement(group(), absentButton, absentContext);

    expect(mocks.toast).toHaveBeenCalledWith('bookmark_no_replacement', 3000);
    expect(mocks.toast).not.toHaveBeenCalledWith('bookmark_search_failed', expect.anything());
    expect(absentButton.disabled).toBe(false);
  });

  it('keeps a cancelled single-item search silent and restores its trigger', async () => {
    const held = deferred<unknown>();
    installApi(vi.fn().mockReturnValueOnce(held.promise));
    const context = captureIdentity('cancelled-user');
    const button = document.createElement('button');

    const pending = findAndOfferReplacement(group(), button, context);
    expect(button.disabled).toBe(true);
    JC.identity.transition('replacement-server', 'next-user', 'replacement-caller-switch');
    held.resolve(page([], 0, 0));
    await pending;

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();
  });

  it('offers the selection modal only for a proven match', async () => {
    installApi(vi.fn().mockResolvedValue(page([item('replacement', 'target-tmdb')], 1, 0)));
    const context = captureIdentity('match-user');
    const button = document.createElement('button');

    await findAndOfferReplacement(group(), button, context);

    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).not.toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  // AC6: a single failed search gates the whole batch — no migration modal, a
  // distinct failure toast rather than a false 'no replacement found'.
  it('never offers an orphan migration from failed partial search results', async () => {
    const first = bookmark({ itemId: 'missing-one', tmdbId: 'first-tmdb', name: 'First' });
    const second = bookmark({ itemId: 'missing-two', tmdbId: 'second-tmdb', name: 'Second' });
    mocks.getItemCached.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const failure = Object.assign(new Error('search unavailable'), { status: 503 });
    // First orphan's search fails; the second orphan's search is a clean match.
    // A single failed search still gates the whole batch.
    const jf = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(page([item('second-replacement', 'second-tmdb')], 1, 0));
    installApi(jf);
    const context = captureIdentity('orphan-user');

    await findAllOrphanedAndOfferMigration({ first, second }, context);

    expect(mocks.toast.mock.calls).toEqual([['bookmark_orphaned_search_failed:1', 4000]]);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();
  });

  it('reports a failure-free orphan scan with no replacements as a proven absence', async () => {
    const orphan = bookmark({ itemId: 'missing-orphan' });
    mocks.getItemCached.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    installApi(vi.fn().mockResolvedValue(page([], 0, 0)));
    const context = captureIdentity('orphan-absent-user');

    await findAllOrphanedAndOfferMigration({ orphan }, context);

    expect(mocks.toast.mock.calls).toEqual([['bookmark_orphaned_no_replacement:1', 4000]]);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();
  });
});
