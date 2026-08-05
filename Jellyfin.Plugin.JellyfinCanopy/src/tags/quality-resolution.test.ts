import { describe, expect, it } from 'vitest';
import { resolveQualityResolution } from './quality-resolution';

describe('Quality Tags resolution classifier', () => {
    it.each([
        ['8K', '8K'],
        ['4320p', '8K'],
        ['4k', '4K'],
        ['2160p', '4K'],
        ['1440p', '1440p'],
        ['1080p', '1080p'],
        ['720p', '720p'],
        ['480p', '480p'],
        ['520p', '480p'],
        ['404p', 'LOW-RES'],
    ])('recognizes the %s display token as %s', (token, expected) => {
        expect(resolveQualityResolution({
            DisplayTitle: `HEVC Main 10 ${token} HDR`,
            Width: 1,
            Height: 1,
        })).toBe(expected);
    });

    it.each([
        [7_680, 4_320, '8K'],
        [8_192, 4_096, '8K'],
        [3_840, 2_160, '4K'],
        [4_096, 1_716, '4K'],
        [2_560, 1_440, '1440p'],
        [1_920, 1_080, '1080p'],
        [1_920, 800, '1080p'],
        [1_919, 1_080, '1080p'],
        [1_440, 1_080, '1080p'],
        [1_280, 720, '720p'],
        [1_279, 720, '720p'],
        [960, 720, '720p'],
        [720, 480, '480p'],
        [960, 520, '480p'],
        [720, 479, 'LOW-RES'],
        [720, 404, 'LOW-RES'],
        [720, 384, 'LOW-RES'],
        [640, 360, 'LOW-RES'],
    ])('classifies %d×%d as %s', (width, height, expected) => {
        expect(resolveQualityResolution({ Width: width, Height: height })).toBe(expected);
        expect(resolveQualityResolution({ Width: height, Height: width })).toBe(expected);
    });

    it.each([
        [5_120, 1_440, '1440p'],
        [3_840, 1_080, '1080p'],
        [7_680, 2_160, '4K'],
        [7_679, 1_600, '1440p'],
        [7_680, 1_600, '1440p'],
        [12_000, 3_200, '4K'],
    ])('does not promote the extreme ultrawide %d×%d source above %s', (width, height, expected) => {
        expect(resolveQualityResolution({ Width: width, Height: height })).toBe(expected);
    });

    it.each([
        ['4320p', 7_680, 4_320, '8K'],
        ['2160p', 3_840, 2_160, '4K'],
        ['1440p', 2_560, 1_440, '1440p'],
        ['1080p', 1_920, 1_080, '1080p'],
        ['720p', 1_280, 720, '720p'],
        ['520p', 960, 520, '480p'],
        ['480p', 720, 480, '480p'],
        ['404p', 720, 404, 'LOW-RES'],
        ['384p', 720, 384, 'LOW-RES'],
        ['360p', 640, 360, 'LOW-RES'],
    ])('keeps the %s token and %d×%d dimension paths aligned as %s', (token, width, height, expected) => {
        expect(resolveQualityResolution({ DisplayTitle: `AV1 ${token}`, Width: width, Height: height })).toBe(expected);
        expect(resolveQualityResolution({ Width: width, Height: height })).toBe(expected);
    });

    it.each([
        [{ Height: 4_320 }, '8K'],
        [{ Width: 7_680 }, '8K'],
        [{ Height: 2_160 }, '4K'],
        [{ Width: 1_920 }, '1080p'],
        [{ Width: '7680', Height: '4320' }, null],
        [{ Width: Number.NaN, Height: Number.POSITIVE_INFINITY }, null],
        [{ Width: -1, Height: 0 }, null],
        [{}, null],
    ])('handles partial or malformed dimensions %# as %s', (stream, expected) => {
        expect(resolveQualityResolution(stream)).toBe(expected);
    });
});
