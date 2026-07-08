// src/arr/search/types.ts
//
// Client-side mirrors of the ArrSearchController wire DTOs (Model/Arr/ArrSearchModels.cs).
// Kept in lockstep with the server [JsonPropertyName] names.

export type ArrKind = 'movie' | 'series' | 'season' | 'episode' | 'unknown';
export type ArrService = 'sonarr' | 'radarr';

export interface ArrTarget {
    instanceName: string;
    service: ArrService;
    arrId: number;
    episodeId?: number | null;
    monitored: boolean;
    hasFile: boolean;
}

export interface ArrError {
    instanceName: string;
    reason: string;
}

export interface ArrContext {
    kind: ArrKind;
    service?: ArrService | null;
    name?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    serviceConfigured: boolean;
    supportsInteractive: boolean;
    canManage: boolean;
    targets: ArrTarget[];
    addableInstances: string[];
    errors: ArrError[];
}

export interface ArrRelease {
    guid: string;
    indexerId: number;
    indexer?: string | null;
    title?: string | null;
    quality?: string | null;
    qualityWeight: number;
    size: number;
    ageHours: number;
    seeders?: number | null;
    leechers?: number | null;
    protocol?: string | null;
    approved: boolean;
    downloadAllowed: boolean;
    rejections: string[];
    seasonNumber?: number | null;
    fullSeason: boolean;
    releaseGroup?: string | null;
    customFormatScore: number;
    languages: string[];
    indexerFlags: string[];
}

export interface ArrReleaseList {
    instanceName: string;
    service: ArrService;
    releases: ArrRelease[];
    error?: string | null;
}

export interface ArrDispatched {
    instanceName: string;
    commandId: number;
    commandName: string;
}

export interface ArrDispatchResult {
    dispatched: ArrDispatched[];
    errors: ArrError[];
}

export interface ArrNamedId { id: number; name: string; }
export interface ArrRootFolder { path: string; freeSpace: number; }

export interface ArrAddOptions {
    service: ArrService;
    instanceName: string;
    qualityProfiles: ArrNamedId[];
    rootFolders: ArrRootFolder[];
    minimumAvailabilityOptions?: string[] | null;
    error?: string | null;
}

export interface ArrQueueRow {
    instanceName: string;
    service: ArrService;
    title?: string | null;
    status?: string | null;
    trackedDownloadState?: string | null;
    progress: number;
    timeRemaining?: string | null;
}

/** What the capture layer records at menu-trigger time (the only moment the source item is known). */
export interface ArrSearchContext {
    itemId: string;
    /** Jellyfin item type, when known synchronously (card dataset / cached details item). */
    type?: string | null;
    ts: number;
}
