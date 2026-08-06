import { describe, expect, it } from 'vitest';
import { detectFileSource, FILE_SOURCE_VALUES } from './file-source';

describe('file-source detector', () => {
    it.each([
        ['/media/Movie.BluRay.disc', 'BluRay'],
        ['/media/Movie.blu-ray.disc', 'BluRay'],
        ['/media/Movie.BluRayRemux.disc', 'BluRay'],
        ['/media/Movie.BluRay-Rip.disc', 'BluRay'],
        ['/media/Movie.BD-RIP.disc', 'BluRay'],
        ['/media/Movie.BDRemux.disc', 'BluRay'],
        ['/media/Movie.HD-DVD.disc', 'HD DVD'],
        ['/media/Movie.HD DVD.disc', 'HD DVD'],
        ['/media/Movie.DVDRip.disc', 'DVD'],
        ['/media/Movie.DVD-REMUX.disc', 'DVD'],
        ['/media/Movie.VHS.disc', 'VHS'],
        ['/media/Movie.HDTV.disc', 'HDTV'],
        ['/media/Movie.disc', 'Physical'],
    ])('normalizes %s to %s', (Path, expected) => {
        expect(detectFileSource({ Path })).toBe(expected);
    });

    it('exports the stable poster/details vocabulary in display order', () => {
        expect(FILE_SOURCE_VALUES).toEqual(['BluRay', 'HD DVD', 'DVD', 'VHS', 'HDTV', 'Physical']);
    });

    it.each([
        null,
        undefined,
        '',
        [],
        {},
        { Path: '/media/Movie.BluRay.mkv' },
        { Path: 42, Name: false },
        { MediaSources: 'not-an-array' },
    ])('keeps malformed, ordinary, or unsupported input %# silent', (value) => {
        expect(detectFileSource(value)).toBeNull();
    });

    it('does not promote a DVD substring without token boundaries', () => {
        expect(detectFileSource({ Path: '/media/notdvd.disc' })).toBe('Physical');
    });

    it('uses item metadata when no usable MediaSources exist', () => {
        expect(detectFileSource({
            Name: 'Movie BluRay',
            Path: '/media/Movie.disc',
            MediaSources: [{}, null, 42],
        })).toBe('BluRay');
    });

    it('accepts unanimous multi-version values independent of order', () => {
        const left = { Path: '/media/A.BluRay.disc' };
        const right = { Name: 'B blu-ray', Path: '/media/B.disc' };
        expect(detectFileSource({ MediaSources: [left, right] })).toBe('BluRay');
        expect(detectFileSource({ MediaSources: [right, left] })).toBe('BluRay');
    });

    it.each([
        [[{ Path: '/media/A.BluRay.disc' }, { Path: '/media/B.DVD.disc' }]],
        [[{ Path: '/media/A.BluRay.disc' }, { Path: '/media/B.mkv' }]],
        [[{ Path: '/media/A.BluRay.disc' }, { Path: '/media/B.disc' }]],
    ])('keeps conflicting or partly unresolved multi-version input silent', (MediaSources) => {
        expect(detectFileSource({ MediaSources })).toBeNull();
    });

    it('merges generic item/source evidence symmetrically and rejects specific conflicts', () => {
        expect(detectFileSource({
            Path: '/media/Item.DVD.disc',
            MediaSources: [{ Path: '/media/Version.BluRay.disc' }],
        })).toBeNull();
        expect(detectFileSource({
            Path: '/media/Item.disc',
            MediaSources: [{ Path: '/media/Version.BluRay.disc' }],
        })).toBe('BluRay');
        expect(detectFileSource({
            Name: 'Item BluRay',
            Path: '/media/Item.disc',
            MediaSources: [{ Path: '/media/Version.disc' }],
        })).toBe('BluRay');
    });
});
