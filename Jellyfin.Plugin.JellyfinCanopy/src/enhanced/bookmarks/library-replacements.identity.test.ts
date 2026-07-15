import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import {
  SERIES_ENRICHMENT_CHUNK_SIZE,
  SERIES_ENRICHMENT_MAX_URL_LENGTH,
  searchForReplacementItem
} from './library-replacements';

describe('bookmark replacement logical identity', () => {
  beforeEach(() => {
    JC.identity.transition('server', 'user', 'replacement-identity-test');
  });

  it('uses the same inclusive episode-range decision as playback and duplicates', async () => {
    const jf = vi.fn()
      .mockResolvedValueOnce({ Items: [
        {
          Id: 'alternate-s0e2-e3', Name: 'Special 2-3', Type: 'Episode', SeriesId: 'series-item',
          ParentIndexNumber: 0, IndexNumber: 2, IndexNumberEnd: 3, ProviderIds: {}
        },
        {
          Id: 'different-s0e2', Name: 'Special 2', Type: 'Episode', SeriesId: 'series-item',
          ParentIndexNumber: 0, IndexNumber: 2, IndexNumberEnd: 2, ProviderIds: {}
        }
      ] })
      .mockResolvedValueOnce({ Items: [{
        Id: 'series-item', Name: 'Series', Type: 'Series', ProviderIds: { Tmdb: 'series-55' }
      }] });
    JC.core.api = { jf } as unknown as ApiApi;
    const context = JC.identity.capture()!;

    const matches = await searchForReplacementItem({
      itemId: 'gone', identityVersion: 1, itemType: 'episode', mediaType: 'tv',
      tmdbId: '', tvdbId: '', seriesTmdbId: 'series-55', seriesTvdbId: '',
      seasonNumber: 0, episodeNumber: 2, episodeEndNumber: 3, name: 'Special 2-3'
    }, context);

    expect(matches?.map(item => item.Id)).toEqual(['alternate-s0e2-e3']);
  });

  it('never treats unnamespaced UserData.Key as an episode provider id', async () => {
    const jf = vi.fn().mockResolvedValueOnce({ Items: [{
      Id: 'wrong', Name: 'Wrong episode', Type: 'Episode',
      ParentIndexNumber: 1, IndexNumber: 1, IndexNumberEnd: 1,
      ProviderIds: {}, UserData: { Key: 'episode-900' }
    }] });
    JC.core.api = { jf } as unknown as ApiApi;
    const context = JC.identity.capture()!;

    await expect(searchForReplacementItem({
      itemId: 'gone', identityVersion: 1, itemType: 'episode', mediaType: 'tv',
      tmdbId: 'episode-900', tvdbId: '', seriesTmdbId: '', seriesTvdbId: '',
      seasonNumber: 1, episodeNumber: 1, episodeEndNumber: 1, name: 'Episode'
    }, context)).resolves.toBeNull();
  });

  it('bounds parent enrichment chunks and isolates one failed chunk from valid matches', async () => {
    const candidates = Array.from({ length: SERIES_ENRICHMENT_CHUNK_SIZE + 1 }, (_, index) => ({
      Id: index === 0 ? 'item-provider-match' : (index === SERIES_ENRICHMENT_CHUNK_SIZE
        ? 'series-range-match'
        : `filler-${index}`),
      Name: `Episode ${index}`,
      Type: 'Episode',
      SeriesId: `series-${String(index).padStart(3, '0')}`,
      ParentIndexNumber: 1,
      IndexNumber: 1,
      IndexNumberEnd: 1,
      ProviderIds: index === 0
        ? { Tmdb: 'episode-900' }
        : (index === SERIES_ENRICHMENT_CHUNK_SIZE ? {} : { Tmdb: `other-${index}` })
    }));
    const jf = vi.fn()
      .mockResolvedValueOnce({ Items: candidates })
      .mockRejectedValueOnce(new Error('first parent chunk unavailable'))
      .mockResolvedValueOnce({ Items: [{
        Id: `series-${String(SERIES_ENRICHMENT_CHUNK_SIZE).padStart(3, '0')}`,
        Name: 'Series',
        Type: 'Series',
        ProviderIds: { Tmdb: 'series-55' }
      }] });
    JC.core.api = { jf } as unknown as ApiApi;
    const context = JC.identity.capture()!;

    const matches = await searchForReplacementItem({
      itemId: 'gone', identityVersion: 1, itemType: 'episode', mediaType: 'tv',
      tmdbId: 'episode-900', tvdbId: '', seriesTmdbId: 'series-55', seriesTvdbId: '',
      seasonNumber: 1, episodeNumber: 1, episodeEndNumber: 1, name: 'Episode'
    }, context);

    expect(matches?.map(item => item.Id)).toEqual(['item-provider-match', 'series-range-match']);
    const enrichmentUrls = jf.mock.calls.slice(1).map(call => String(call[0]));
    expect(enrichmentUrls).toHaveLength(2);
    for (const url of enrichmentUrls) {
      expect(url.length).toBeLessThanOrEqual(SERIES_ENRICHMENT_MAX_URL_LENGTH);
      const ids = new URL(`http://jellyfin.test${url}`).searchParams.get('Ids')!.split(',');
      expect(ids.length).toBeLessThanOrEqual(SERIES_ENRICHMENT_CHUNK_SIZE);
    }
  });

  it('splits long encoded parent IDs before the URL-length bound', async () => {
    const longSeriesIds = Array.from({ length: 3 }, (_, index) =>
      `series-${index}-${'/'.repeat(500)}`
    );
    const candidates = longSeriesIds.map((SeriesId, index) => ({
      Id: `episode-${index}`,
      Name: `Episode ${index}`,
      Type: 'Episode',
      SeriesId,
      ParentIndexNumber: 1,
      IndexNumber: 1,
      ProviderIds: { Tmdb: `other-${index}` }
    }));
    const jf = vi.fn()
      .mockResolvedValueOnce({ Items: candidates })
      .mockResolvedValue({ Items: [] });
    JC.core.api = { jf } as unknown as ApiApi;
    const context = JC.identity.capture()!;

    await expect(searchForReplacementItem({
      itemId: 'gone', identityVersion: 1, itemType: 'episode', mediaType: 'tv',
      tmdbId: 'missing', tvdbId: '', seriesTmdbId: '', seriesTvdbId: '',
      seasonNumber: 1, episodeNumber: 1, episodeEndNumber: 1, name: 'Episode'
    }, context)).resolves.toBeNull();

    const enrichmentUrls = jf.mock.calls.slice(1).map(call => String(call[0]));
    expect(longSeriesIds.length).toBeLessThan(SERIES_ENRICHMENT_CHUNK_SIZE);
    expect(enrichmentUrls.length).toBeGreaterThan(1);
    for (const url of enrichmentUrls) {
      expect(url.length).toBeLessThanOrEqual(SERIES_ENRICHMENT_MAX_URL_LENGTH);
    }
  });
});
