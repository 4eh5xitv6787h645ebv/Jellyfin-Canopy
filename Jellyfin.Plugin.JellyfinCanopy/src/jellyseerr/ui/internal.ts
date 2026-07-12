// src/jellyseerr/ui/internal.ts
//
// Shared singletons for the Jellyseerr UI family (ui-* modules). Replaces the
// former JC.internals.jellyseerrUi bag and the per-file
// `JC.jellyseerrUI = JC.jellyseerrUI || {}` pattern: every ui-* module imports
// these two objects and attaches/reads its helpers, so the object identities
// are shared exactly as before — real module bindings instead of a namespace
// stash. Methods accrue across files, so both surfaces carry an index
// signature; only `internal.state` is structurally pinned.

/* eslint-disable @typescript-eslint/no-explicit-any -- cross-file helper bag; typed incrementally */

import { JC } from '../../globals';

/**
 * The public Seerr UI surface (JC.jellyseerrUI). Members accrue across the
 * ui-* modules; every access resolves through the index signature to `any`
 * (callable), so cross-module call sites don't need per-member guards.
 */
export interface JellyseerrUI {
    [key: string]: any;
}

/** Shared internal helper bag (was JC.internals.jellyseerrUi). */
export interface JellyseerrUiInternal {
    state: {
        jellyseerrHoverPopover: any;
        jellyseerrHoverLock: boolean;
        active4KPopup: any;
    };
    [key: string]: any;
}

declare module '../../types/jc' {
    interface JEGlobal {
        /** Public Seerr UI surface (src/jellyseerr/ui-*.ts). */
        jellyseerrUI?: JellyseerrUI;
    }
}

/** The public UI surface, published on JC.jellyseerrUI. */
export const ui: JellyseerrUI = (JC.jellyseerrUI = JC.jellyseerrUI || {});

/** The shared internal bag, private to the ui-* family. */
export const internal: JellyseerrUiInternal = {
    state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null }
};
