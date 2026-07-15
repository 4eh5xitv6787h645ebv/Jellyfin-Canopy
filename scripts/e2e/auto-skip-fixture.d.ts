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

export interface PlaybackUserData {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
}

export interface PlaybackStateApiClient {
    markUnplayed(itemId: string): Promise<PlaybackUserData | null>;
    getUserData(itemId: string): Promise<PlaybackUserData | null>;
}

export interface PlaybackResetOptions {
    attempts?: number;
    settleMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
}

export interface PlaybackProgressResponseCandidate {
    method?: string;
    pathname?: string;
    status?: number;
    body?: {
        ItemId?: string;
        PositionTicks?: number;
    };
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
export function isAutoSkipZeroProgressResponse(
    candidate: PlaybackProgressResponseCandidate,
    itemId: string
): boolean;
export function preservePrimaryError(primary: unknown, cleanupErrors?: unknown[]): Error;
export function resetAutoSkipPlaybackState(
    apiClient: PlaybackStateApiClient,
    itemId: string,
    options?: PlaybackResetOptions
): Promise<void>;
