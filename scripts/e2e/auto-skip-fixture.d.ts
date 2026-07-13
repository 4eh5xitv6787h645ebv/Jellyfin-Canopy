export interface AutoSkipFixtureContract {
    name: string;
    filePrefix: string;
    durationSeconds: number;
    segmentStartSeconds: number;
    segmentEndSeconds: number;
    minimumMarginSeconds: number;
}

export interface JellyfinItem {
    Id?: string;
    Name?: string;
    RunTimeTicks?: number;
}

export interface PlaybackMediaSource {
    Id?: string;
    RunTimeTicks?: number;
    SupportsDirectPlay?: boolean;
    SupportsDirectStream?: boolean;
    SupportsTranscoding?: boolean;
}

export interface PlaybackInfo {
    MediaSources?: PlaybackMediaSource[];
}

export interface FixtureApiClient {
    getCurrentUserId(): string;
    getItems(userId: string, options: Record<string, unknown>): Promise<{ Items?: JellyfinItem[] }>;
    getItem(userId: string, itemId: string): Promise<JellyfinItem>;
    getPlaybackInfo(
        itemId: string,
        options: Record<string, unknown>,
        deviceProfile: Record<string, unknown>
    ): Promise<PlaybackInfo>;
}

export interface ResolvedAutoSkipFixture {
    id: string;
    name: string;
    durationSeconds: number;
    mediaSourceId: string;
    playbackMode: 'direct-play' | 'direct-stream' | 'transcode';
}

export const AUTO_SKIP_FIXTURE: Readonly<AutoSkipFixtureContract>;
export const PLAYWRIGHT_DEVICE_PROFILE: Readonly<Record<string, unknown>>;
export const TICKS_PER_SECOND: number;
export const minimumDurationSeconds: number;

export function selectFixtureItem(items: JellyfinItem[], overrideId?: string): JellyfinItem;
export function validatePlaybackInfo(
    item: JellyfinItem,
    playbackInfo: PlaybackInfo,
    overrideId?: string
): Readonly<ResolvedAutoSkipFixture>;
export function resolveAutoSkipFixture(
    apiClient: FixtureApiClient,
    overrideId?: string
): Promise<Readonly<ResolvedAutoSkipFixture>>;
