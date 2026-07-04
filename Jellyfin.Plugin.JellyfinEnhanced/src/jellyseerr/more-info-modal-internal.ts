// src/jellyseerr/more-info-modal-internal.ts
//
// Shared mutable bag for the Jellyseerr more-info modal family. Replaces the
// former JE.internals.moreInfoModal global: the eight more-info-modal-*
// modules each import this singleton and attach/read their helpers on it, so
// the object identity is shared exactly as before — just as a real module
// binding instead of a namespace stash. Methods are added across files, so the
// surface is an index signature; only `state` is structurally pinned.

/* eslint-disable @typescript-eslint/no-explicit-any -- cross-file helper bag; typed incrementally */

/** The shared more-info modal helper bag (was JE.internals.moreInfoModal). */
export interface MoreInfoModalInternal {
    state: { currentModal: any };
    [key: string]: any;
}

/** Singleton shared across the more-info-modal-* modules. */
export const internal: MoreInfoModalInternal = { state: { currentModal: null } };
