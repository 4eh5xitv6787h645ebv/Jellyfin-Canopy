import { describe, expect, it } from 'vitest';
import {
    canonicalizeAudioLanguagePreference,
    describeSelectedAudioTrack,
    resolveEffectiveAudioLanguagePreference,
    selectPreferredAudioTrack,
    type AudioStreamLike,
} from './audio-track-selection';

function audio(overrides: Partial<AudioStreamLike> = {}): AudioStreamLike {
    return { Type: 'Audio', Index: 0, ...overrides };
}

function permutations<T>(values: T[]): T[][] {
    if (values.length < 2) return [values];
    return values.flatMap((value, index) =>
        permutations(values.filter((_, candidate) => candidate !== index))
            .map((tail) => [value, ...tail]));
}

describe('audio language preference', () => {
    it.each([
        [' por-BR ', 'pt-BR'],
        ['eng', 'en'],
        ['zh-hant-tw', 'zh-Hant-TW'],
        ['', ''],
        ['   ', ''],
    ])('canonicalizes %j to %j', (input, expected) => {
        expect(canonicalizeAudioLanguagePreference(input)).toBe(expected);
    });

    it.each(['bad_tag', 'root', 'und', 'x-private', 'a'.repeat(256)])(
        'rejects invalid or undetermined preference %j',
        (input) => expect(canonicalizeAudioLanguagePreference(input)).toBeNull(),
    );

    it('keeps null inheritance distinct from explicit Automatic', () => {
        expect(resolveEffectiveAudioLanguagePreference(null, 'pt-BR')).toBe('pt-BR');
        expect(resolveEffectiveAudioLanguagePreference(undefined, 'por-BR')).toBe('pt-BR');
        expect(resolveEffectiveAudioLanguagePreference('', 'pt-BR')).toBe('');
        expect(resolveEffectiveAudioLanguagePreference('eng', 'pt-BR')).toBe('en');
    });
});

describe('selectPreferredAudioTrack', () => {
    it('selects exact regional language before base-language and default tracks', () => {
        const streams = [
            audio({ Index: 1, Language: 'pt-PT', Codec: 'dts', Channels: 8, IsDefault: true }),
            audio({ Index: 2, Language: 'por-BR', Codec: 'eac3', Channels: 6 }),
            audio({ Index: 3, Language: 'pt', Codec: 'truehd', Channels: 2 }),
        ];
        const selected = selectPreferredAudioTrack(streams, null, 'pt-BR');
        expect(selected?.Index).toBe(2);
        expect(describeSelectedAudioTrack(selected)).toBe('Dolby Digital+ 5.1');
    });

    it('uses exact base-only tags before regional variants, then the same-base cohort', () => {
        const exactBase = audio({ Index: 9, Language: 'en', Codec: 'eac3', Channels: 2 });
        const regional = audio({ Index: 1, Language: 'en-US', Codec: 'truehd', Channels: 8 });
        expect(selectPreferredAudioTrack([regional, exactBase], null, 'en')?.Index).toBe(9);
        expect(selectPreferredAudioTrack([regional], null, 'en-GB')?.Index).toBe(1);
    });

    it('falls through to Jellyfin default, then a deterministic metadata-ranked track', () => {
        const defaultTrack = audio({ Index: 8, Language: 'ja', Codec: 'eac3', Channels: 2, IsDefault: true });
        const richer = audio({ Index: 2, Language: 'fr', Codec: 'truehd', Channels: 8 });
        expect(selectPreferredAudioTrack([richer, defaultTrack], null, 'de')?.Index).toBe(8);
        expect(selectPreferredAudioTrack([defaultTrack, richer], null, '')?.Index).toBe(8);

        const noDefault = [
            audio({ Index: 5, Language: 'ja', Codec: 'eac3', Channels: 8 }),
            audio({ Index: 1, Language: 'fr', Codec: 'truehd', Channels: 2 }),
        ];
        expect(selectPreferredAudioTrack(noDefault, null, '')?.Index).toBe(1);
    });

    it('is invariant to stream ordering at every fallback tier', () => {
        const streams = [
            audio({ Index: 6, Language: 'pt-PT', Codec: 'dts', Channels: 8 }),
            audio({ Index: 2, Language: 'pt-BR', Codec: 'eac3', Channels: 6 }),
            audio({ Index: 4, Language: 'pt-BR', Codec: 'truehd', Channels: 2 }),
            audio({ Index: 1, Language: 'ja', Codec: 'dts', Channels: 8, IsDefault: true }),
        ];
        for (const ordered of permutations(streams)) {
            const selected = selectPreferredAudioTrack(ordered, null, 'pt-BR');
            expect(selected?.Index).toBe(4);
            expect(describeSelectedAudioTrack(selected)).toBe('TRUEHD 2.0');
        }
    });

    it('never combines codec and channel metadata from different tracks', () => {
        const atmosStereo = audio({ Index: 1, Language: 'en', DisplayTitle: 'Dolby Atmos Stereo', Channels: 2 });
        const dtsSurround = audio({ Index: 2, Language: 'ja', DisplayTitle: 'DTS 7.1', Channels: 8, IsDefault: true });
        expect(describeSelectedAudioTrack(selectPreferredAudioTrack(
            [atmosStereo, dtsSurround], null, 'en',
        ))).toBe('ATMOS 2.0');
        expect(describeSelectedAudioTrack(selectPreferredAudioTrack(
            [atmosStereo, dtsSurround], null, 'ja',
        ))).toBe('DTS 7.1');
    });

    it('uses the first media source and ignores alternate-version streams', () => {
        const topLevel = [audio({ Index: 1, Language: 'en', Codec: 'truehd', Channels: 8 })];
        const sources = [
            { MediaStreams: [audio({ Index: 7, Language: 'ja', Codec: 'eac3', Channels: 6 })] },
            { MediaStreams: [audio({ Index: 3, Language: 'en', Codec: 'dts', Channels: 8 })] },
        ];
        expect(selectPreferredAudioTrack(topLevel, sources, 'en')?.Index).toBe(7);
    });

    it('falls back to top-level primary streams when the first source has no audio metadata', () => {
        const topLevel = [audio({ Index: 4, Language: 'en', Codec: 'eac3', Channels: 6 })];
        expect(selectPreferredAudioTrack(topLevel, [{ MediaStreams: [] }], 'en')?.Index).toBe(4);
        expect(selectPreferredAudioTrack(topLevel, [{ MediaStreams: [{ Type: 'Video', Index: 0 }] }], 'en')?.Index)
            .toBe(4);
    });

    it('filters flattened server-cache streams to source zero and deduplicates repeats', () => {
        const first = audio({ SourceIndex: 0, Index: 3, Language: 'en', Codec: 'eac3', Channels: 6 });
        const alternate = audio({ SourceIndex: 1, Index: 1, Language: 'en', Codec: 'truehd', Channels: 8 });
        expect(selectPreferredAudioTrack([alternate, first, { ...first }], [{ Name: 'primary' }], 'en'))
            .toMatchObject({ SourceIndex: 0, Index: 3 });
    });

    it('handles missing and invalid language metadata deterministically', () => {
        const missing = audio({ Index: 4, Codec: 'dts', Channels: 8 });
        const invalid = audio({ Index: 2, Language: 'bad_tag', Codec: 'eac3', Channels: 6 });
        expect(selectPreferredAudioTrack([missing, invalid], null, 'pt-BR')?.Index).toBe(4);
        expect(selectPreferredAudioTrack([], null, 'pt-BR')).toBeNull();
    });
});
