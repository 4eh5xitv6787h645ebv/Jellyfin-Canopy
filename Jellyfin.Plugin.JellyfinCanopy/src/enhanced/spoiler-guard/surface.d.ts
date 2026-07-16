// src/enhanced/spoiler-guard/surface.d.ts
// JEGlobal surface owned by the Spoiler Guard modules. Consumers (ratingtags,
// reviews, the Seerr modal) read JC.spoilerGuard by these exact names.
import type {} from '../../types/jc';
import type { SpoilerUserPrefs, PromoteResponse, RemoveResponse } from './state';
import type { MovieScope } from './suppression';

declare module '../../types/jc' {
    /** The stable public JC.spoilerGuard surface (published by lazy activation). */
    interface SpoilerGuardApi {
        init(): void;
        addSpoilerBlurButton(itemId: string, visiblePage: Element, itemType: string): void;
        isEnabledFor(seriesId: unknown): boolean;
        isMovieEnabledFor(movieId: unknown): boolean;
        isCollectionEnabledFor(collectionId: unknown): boolean;
        hasEnabledCollections(): boolean;
        fetchMovieScope(movieId: string): Promise<MovieScope | null>;
        enableForSeries(seriesId: string): Promise<void>;
        disableForSeries(seriesId: string): Promise<void>;
        enableForMovie(movieId: string, movieName?: string): Promise<void>;
        disableForMovie(movieId: string): Promise<void>;
        enableForCollection(collectionId: string, collectionName?: string): Promise<void>;
        disableForCollection(collectionId: string): Promise<void>;
        isTmdbEnabled(mediaType: string, tmdbId: string, jellyfinMediaId?: string | null): boolean;
        enableForTmdb(mediaType: string, tmdbId: string, displayName?: string): Promise<PromoteResponse>;
        disableForTmdb(mediaType: string, tmdbId: string): Promise<RemoveResponse>;
        whenLoaded(): Promise<void>;
        isLoadOk(): boolean;
        confirmDisableSpoiler(): Promise<boolean>;
        getUserPrefs(): SpoilerUserPrefs;
        setUserPrefs(next: SpoilerUserPrefs): Promise<SpoilerUserPrefs>;
    }

    interface JEGlobal {
        /** The Spoiler Guard public API (published when its lazy feature activates). */
        spoilerGuard?: SpoilerGuardApi;
    }
}
