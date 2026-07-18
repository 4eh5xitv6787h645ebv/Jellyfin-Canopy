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

// A proven-complete scan requires two consecutive full passes that agree, so
// each stable main-page sequence must be answered twice before enrichment.
function mockStablePasses(
  jf: ReturnType<typeof vi.fn>,
  pages: Array<Record<string, unknown>>
): ReturnType<typeof vi.fn> {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const page of pages) jf.mockResolvedValueOnce(page);
  }
  return jf;
}

function captureIdentity(userId = 'replacement-user'): IdentityContext {
  JC.identity.transition('replacement-server', '', 'replacement-test-reset');
  return JC.identity.transition('replacement-server', userId, 'replacement-test-user')!;
}

function expectMainRequest(
  call: unknown[],
  expectedUserId: string,
  expectedStartIndex: number
): void {
  const url = new URL(`http://jellyfin.test${String(call[0])}`);
  expect(url.pathname).toBe(`/Users/${expectedUserId.replace(/-/g, '').toLowerCase()}/Items`);
  expect(url.searchParams.get('Limit')).toBe('500');
  expect(url.searchParams.get('StartIndex')).toBe(String(expectedStartIndex));
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

  it('finds a logical replacement on page two without treating 500 as a hard cap', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`page-one-${index}`));
    const jf = mockStablePasses(vi.fn(), [
      { Items: firstPage, TotalRecordCount: 501, StartIndex: 0 },
      { Items: [item('page-two-match', 'target-tmdb')], TotalRecordCount: 501, StartIndex: 500 }
    ]);
    installApi(jf);
    const context = captureIdentity('regular-user');

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({
      status: 'match',
      items: [expect.objectContaining({ Id: 'page-two-match' })]
    });

    // Two proving passes over the two-page collection, offset advancing past 500.
    expect(jf).toHaveBeenCalledTimes(4);
    expectMainRequest(jf.mock.calls[0], 'regular-user', 0);
    expectMainRequest(jf.mock.calls[1], 'regular-user', 500);
    expectMainRequest(jf.mock.calls[2], 'regular-user', 0);
    expectMainRequest(jf.mock.calls[3], 'regular-user', 500);
  });

  it.each(['admin-user', 'regular-user'])('keeps the captured %s identity in every item request', async (userId) => {
    const jf = vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    installApi(jf);
    const context = captureIdentity(userId);

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({ status: 'no-match' });

    expect(jf).toHaveBeenCalledTimes(2);
    expectMainRequest(jf.mock.calls[0], userId, 0);
    expectMainRequest(jf.mock.calls[1], userId, 0);
  });

  it('never publishes a confident no-match from a scan two passes disagree on', async () => {
    // Same-count library churn shifts an unread replacement behind the offset:
    // one pass misses it, the other sees it. The prover must reject the
    // disagreement as failed/incomplete rather than emit a false no-match that
    // would gate a destructive migration.
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`churn-${index}`));
    const jf = vi.fn()
      .mockResolvedValueOnce({ Items: firstPage, TotalRecordCount: 501, StartIndex: 0 })
      .mockResolvedValueOnce({ Items: [item('churn-tail')], TotalRecordCount: 501, StartIndex: 500 })
      .mockResolvedValueOnce({ Items: firstPage, TotalRecordCount: 501, StartIndex: 0 })
      .mockResolvedValueOnce({
        Items: [item('surfaced-replacement', 'target-tmdb')],
        TotalRecordCount: 501,
        StartIndex: 500
      });
    installApi(jf);
    const context = captureIdentity();

    const result = await searchForReplacementItem(bookmark(), context);
    expect(result.status).toBe('failed');
    expect(result.status).not.toBe('no-match');
  });

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

  it('cancels after an account transition while a continuation page is in flight', async () => {
    const continuation = deferred<unknown>();
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`first-${index}`));
    const jf = vi.fn()
      .mockResolvedValueOnce({ Items: firstPage, TotalRecordCount: 501, StartIndex: 0 })
      .mockReturnValueOnce(continuation.promise);
    installApi(jf);
    const context = captureIdentity('first-user');

    const pending = searchForReplacementItem(bookmark(), context);
    await vi.waitFor(() => expect(jf).toHaveBeenCalledTimes(2));
    JC.identity.transition('replacement-server', 'second-user', 'replacement-test-mid-page-switch');
    continuation.resolve({ Items: [item('late-match', 'target-tmdb')], TotalRecordCount: 501, StartIndex: 500 });

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expectMainRequest(jf.mock.calls[0], 'first-user', 0);
    expectMainRequest(jf.mock.calls[1], 'first-user', 500);
  });

  it('cancels rather than degrading an aborted parent-series enrichment chunk', async () => {
    const abort = new Error('enrichment aborted');
    abort.name = 'AbortError';
    const episodePage = {
      Items: [{
        Id: 'episode', Name: 'Episode', Type: 'Episode', SeriesId: 'series',
        ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: {}
      }],
      TotalRecordCount: 1,
      StartIndex: 0
    };
    // Both proving passes complete, then the enrichment chunk aborts.
    const jf = mockStablePasses(vi.fn(), [episodePage]).mockRejectedValueOnce(abort);
    installApi(jf);
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark({
      mediaType: 'tv', itemType: 'episode', tmdbId: '', seriesTmdbId: 'series-tmdb',
      seasonNumber: 1, episodeNumber: 1, episodeEndNumber: 1
    }), context)).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns no-match only after a complete stable multi-page scan', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => item(`absent-${index}`));
    const jf = mockStablePasses(vi.fn(), [
      { Items: firstPage, TotalRecordCount: 501, StartIndex: 0 },
      { Items: [item('absent-last')], TotalRecordCount: 501, StartIndex: 500 }
    ]);
    installApi(jf);
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toEqual({ status: 'no-match' });
    // Two full passes agreed before the negative was published.
    expect(jf).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      name: 'empty continuation',
      pages: [
        { Items: [item('one')], TotalRecordCount: 2, StartIndex: 0 },
        { Items: [], TotalRecordCount: 2, StartIndex: 1 }
      ]
    },
    {
      name: 'non-advancing reported offset',
      pages: [
        { Items: [item('one')], TotalRecordCount: 2, StartIndex: 0 },
        { Items: [item('two')], TotalRecordCount: 2, StartIndex: 0 }
      ]
    },
    {
      name: 'repeated source identity',
      pages: [
        { Items: [item('one')], TotalRecordCount: 2, StartIndex: 0 },
        { Items: [item('one')], TotalRecordCount: 2, StartIndex: 1 }
      ]
    },
    {
      name: 'changing total metadata',
      pages: [
        { Items: [item('one')], TotalRecordCount: 2, StartIndex: 0 },
        { Items: [item('two')], TotalRecordCount: 3, StartIndex: 1 }
      ]
    }
  ])('fails closed on $name pagination', async ({ pages }) => {
    const jf = vi.fn();
    for (const page of pages) jf.mockResolvedValueOnce(page);
    installApi(jf);
    const context = captureIdentity();

    const result = await searchForReplacementItem(bookmark(), context);
    expect(result.status).toBe('failed');
    expect(jf).toHaveBeenCalledTimes(2);
  });

  it('fails on malformed pagination metadata instead of reporting absence', async () => {
    installApi(vi.fn().mockResolvedValueOnce({ Items: [], TotalRecordCount: '0', StartIndex: 0 }));
    const context = captureIdentity();

    await expect(searchForReplacementItem(bookmark(), context)).resolves.toMatchObject({ status: 'failed' });
  });

  it('fails before attempting an advertised collection beyond the explicit safety bound', async () => {
    const jf = vi.fn().mockResolvedValueOnce({
      Items: [item('one')],
      TotalRecordCount: 500_001,
      StartIndex: 0
    });
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
    installApi(vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
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
    held.resolve({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    await pending;

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();
  });

  it('offers the selection modal only for a proven match', async () => {
    installApi(vi.fn().mockResolvedValue({
      Items: [item('replacement', 'target-tmdb')],
      TotalRecordCount: 1,
      StartIndex: 0
    }));
    const context = captureIdentity('match-user');
    const button = document.createElement('button');

    await findAndOfferReplacement(group(), button, context);

    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).not.toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });

  it('never offers an orphan migration from failed partial search results', async () => {
    const first = bookmark({ itemId: 'missing-one', tmdbId: 'first-tmdb', name: 'First' });
    const second = bookmark({ itemId: 'missing-two', tmdbId: 'second-tmdb', name: 'Second' });
    mocks.getItemCached.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const failure = Object.assign(new Error('search unavailable'), { status: 503 });
    // First orphan's search fails on its first request; the second orphan's
    // search is a proven two-pass match. A single failed search still gates the
    // whole batch: no migration modal, distinct failure toast.
    const jf = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ Items: [item('second-replacement', 'second-tmdb')], TotalRecordCount: 1, StartIndex: 0 });
    installApi(jf);
    const context = captureIdentity('orphan-user');

    await findAllOrphanedAndOfferMigration({ first, second }, context);

    expect(jf).toHaveBeenCalledTimes(3);
    expect(mocks.toast.mock.calls).toEqual([['bookmark_orphaned_search_failed:1', 4000]]);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();
  });

  it('reports a failure-free orphan scan with no replacements as a proven absence', async () => {
    const orphan = bookmark({ itemId: 'missing-orphan' });
    mocks.getItemCached.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    installApi(vi.fn().mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
    const context = captureIdentity('orphan-absent-user');

    await findAllOrphanedAndOfferMigration({ orphan }, context);

    expect(mocks.toast.mock.calls).toEqual([['bookmark_orphaned_no_replacement:1', 4000]]);
    expect(document.querySelector('[data-jc-bookmark-library-modal="true"]')).toBeNull();
  });
});
