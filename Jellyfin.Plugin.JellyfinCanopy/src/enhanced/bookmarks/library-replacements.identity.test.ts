import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import { searchForReplacementItem } from './library-replacements';

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
});
