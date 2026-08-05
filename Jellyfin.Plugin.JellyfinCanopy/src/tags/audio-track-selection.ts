import { resolveMediaLanguage } from '../core/media-language';

/** Cache discriminator for the deterministic audio-track selection contract. */
export const AUDIO_SELECTION_VERSION = 1;

/** The subset of Jellyfin stream metadata used to select and describe audio. */
export interface AudioStreamLike {
    Type?: unknown;
    Language?: unknown;
    Codec?: unknown;
    Profile?: unknown;
    DisplayTitle?: unknown;
    Channels?: unknown;
    ChannelLayout?: unknown;
    IsDefault?: unknown;
    Index?: unknown;
    SourceIndex?: unknown;
    [key: string]: unknown;
}

interface ResolvedCandidate {
    stream: AudioStreamLike;
    semanticTag: string;
    baseLanguage: string;
    fingerprint: string;
}

const CODEC_RANK: Record<string, number> = {
    ATMOS: 5,
    'DTS-X': 4,
    TRUEHD: 3,
    DTS: 2,
    'Dolby Digital+': 1,
};

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asFiniteInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function isAudio(stream: unknown): stream is AudioStreamLike {
    return !!stream && typeof stream === 'object' && !Array.isArray(stream)
        && asString((stream as AudioStreamLike).Type).toLowerCase() === 'audio';
}

/**
 * Canonicalize one dedicated audio-language preference.
 *
 * `null` means invalid/not supplied; the empty string is the explicit
 * Automatic mode; every non-empty result is canonical BCP-47.
 */
export function canonicalizeAudioLanguagePreference(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed === '') return '';
    const resolved = resolveMediaLanguage(trimmed);
    return resolved.status === 'valid' ? resolved.canonicalTag : null;
}

/** Resolve nullable per-user inheritance against the administrator default. */
export function resolveEffectiveAudioLanguagePreference(
    userPreference: unknown,
    administratorDefault: unknown,
): string {
    if (userPreference === null || userPreference === undefined) {
        return canonicalizeAudioLanguagePreference(administratorDefault) ?? '';
    }
    return canonicalizeAudioLanguagePreference(userPreference) ?? '';
}

/** Detect the existing quality-tag codec label from one and only one track. */
export function detectAudioCodecTag(stream: AudioStreamLike): string | null {
    const displayTitle = asString(stream.DisplayTitle);
    if (/atmos/i.test(displayTitle)) return 'ATMOS';
    if (/truehd/i.test(displayTitle)) return 'TRUEHD';
    if (/dts-x/i.test(displayTitle)) return 'DTS-X';
    if (/\bdts\b/i.test(displayTitle)) return 'DTS';
    if (/dolby\s*digital\+/i.test(displayTitle)) return 'Dolby Digital+';

    const codec = asString(stream.Codec).toLowerCase();
    const profile = asString(stream.Profile).toLowerCase();
    if (codec.includes('truehd') || profile.includes('truehd')) {
        return codec.includes('atmos') || profile.includes('atmos') ? 'ATMOS' : 'TRUEHD';
    }
    if (codec.includes('dts')) {
        return codec.includes('x') || profile.includes('x') ? 'DTS-X' : 'DTS';
    }
    if (codec.includes('eac3') || codec.includes('ddp')) return 'Dolby Digital+';
    return null;
}

/** Detect the channel label from the same selected track as the codec. */
export function detectAudioChannelTag(stream: AudioStreamLike): string | null {
    const layoutSignals = `${asString(stream.ChannelLayout)} ${asString(stream.DisplayTitle)}`.toLowerCase();
    if (/\b7[. ]?1\b/.test(layoutSignals)) return '7.1';
    if (/\b5[. ]?1\b/.test(layoutSignals)) return '5.1';
    if (/\bstereo\b|\b2[. ]?0\b/.test(layoutSignals)) return '2.0';

    const channels = typeof stream.Channels === 'number' && Number.isFinite(stream.Channels)
        ? stream.Channels
        : 0;
    if (channels >= 8) return '7.1';
    if (channels >= 6) return '5.1';
    if (channels >= 2) return '2.0';
    return null;
}

/** Build the existing composite badge from a single selected track. */
export function describeSelectedAudioTrack(stream: AudioStreamLike | null): string | null {
    if (!stream) return null;
    const codec = detectAudioCodecTag(stream);
    const channels = detectAudioChannelTag(stream);
    if (codec) return channels && !codec.includes(channels) ? `${codec} ${channels}` : codec;
    return channels === '7.1' || channels === '5.1' ? channels : null;
}

function candidateFingerprint(stream: AudioStreamLike): string {
    return [
        asFiniteInteger(stream.SourceIndex) ?? '',
        asFiniteInteger(stream.Index) ?? '',
        stream.IsDefault === true ? '1' : '0',
        asString(stream.Language).trim().toLowerCase(),
        asString(stream.Codec).trim().toLowerCase(),
        asString(stream.Profile).trim().toLowerCase(),
        asString(stream.ChannelLayout).trim().toLowerCase(),
        typeof stream.Channels === 'number' && Number.isFinite(stream.Channels) ? stream.Channels : '',
        asString(stream.DisplayTitle).trim().toLowerCase(),
    ].join('\u0001');
}

function channelRank(stream: AudioStreamLike): number {
    const label = detectAudioChannelTag(stream);
    return label === '7.1' ? 3 : label === '5.1' ? 2 : label === '2.0' ? 1 : 0;
}

function compareCandidates(left: ResolvedCandidate, right: ResolvedCandidate): number {
    const defaultDifference = Number(right.stream.IsDefault === true) - Number(left.stream.IsDefault === true);
    if (defaultDifference !== 0) return defaultDifference;

    const codecDifference = (CODEC_RANK[detectAudioCodecTag(right.stream) || ''] || 0)
        - (CODEC_RANK[detectAudioCodecTag(left.stream) || ''] || 0);
    if (codecDifference !== 0) return codecDifference;

    const channelDifference = channelRank(right.stream) - channelRank(left.stream);
    if (channelDifference !== 0) return channelDifference;

    const leftIndex = asFiniteInteger(left.stream.Index) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = asFiniteInteger(right.stream.Index) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.fingerprint < right.fingerprint
        ? -1
        : left.fingerprint > right.fingerprint
            ? 1
            : 0;
}

function primaryAudioStreams(mediaStreams: unknown, mediaSources: unknown): AudioStreamLike[] {
    if (Array.isArray(mediaSources) && mediaSources.length > 0) {
        const first = mediaSources[0];
        if (first && typeof first === 'object') {
            const sourceStreams = (first as { MediaStreams?: unknown }).MediaStreams;
            if (Array.isArray(sourceStreams)) {
                const sourceAudio = sourceStreams.filter(isAudio);
                if (sourceAudio.length > 0) return sourceAudio;
            }
        }
    }

    if (!Array.isArray(mediaStreams)) return [];
    const audio = mediaStreams.filter(isAudio);
    const hasSourceIdentity = audio.some((stream) => asFiniteInteger(stream.SourceIndex) !== null);
    return hasSourceIdentity
        ? audio.filter((stream) => asFiniteInteger(stream.SourceIndex) === 0)
        : audio;
}

/**
 * Select one deterministic primary-source audio track.
 *
 * Cohorts are exact canonical language, same base language, Jellyfin default,
 * then all remaining tracks. The fixed comparator makes every tier invariant
 * to API array ordering.
 */
export function selectPreferredAudioTrack(
    mediaStreams: unknown,
    mediaSources: unknown,
    canonicalPreference: string,
): AudioStreamLike | null {
    const unique = new Map<string, ResolvedCandidate>();
    for (const stream of primaryAudioStreams(mediaStreams, mediaSources)) {
        const fingerprint = candidateFingerprint(stream);
        if (unique.has(fingerprint)) continue;
        const language = resolveMediaLanguage(stream.Language);
        unique.set(fingerprint, {
            stream,
            semanticTag: language.status === 'valid' ? language.semanticTag : '',
            baseLanguage: language.status === 'valid' ? language.language || '' : '',
            fingerprint,
        });
    }
    const candidates = Array.from(unique.values());
    if (candidates.length === 0) return null;

    const preference = resolveMediaLanguage(canonicalPreference);
    const cohorts: ResolvedCandidate[][] = [];
    if (preference.status === 'valid') {
        cohorts.push(candidates.filter((entry) => entry.semanticTag === preference.semanticTag));
        cohorts.push(candidates.filter((entry) => entry.baseLanguage === preference.language));
    }
    cohorts.push(candidates.filter((entry) => entry.stream.IsDefault === true));
    cohorts.push(candidates);

    for (const cohort of cohorts) {
        if (cohort.length > 0) return cohort.slice().sort(compareCandidates)[0].stream;
    }
    return null;
}
