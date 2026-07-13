// src/seerr/ui/internal.ts
//
// Shared singletons for the Seerr UI family (ui-* modules). Replaces the
// former JC.internals.seerrUi bag and the per-file
// `JC.seerrUI = JC.seerrUI || {}` pattern: every ui-* module imports
// these two objects and attaches/reads its helpers, so the object identities
// are shared exactly as before — real module bindings instead of a namespace
// stash. Methods accrue across files, so both surfaces carry an index
// signature; only `internal.state` is structurally pinned.

/* eslint-disable @typescript-eslint/no-explicit-any -- cross-file helper bag; typed incrementally */

import { JC } from '../../globals';

/**
 * The public Seerr UI surface (JC.seerrUI). Members accrue across the
 * ui-* modules; every access resolves through the index signature to `any`
 * (callable), so cross-module call sites don't need per-member guards.
 */
export interface SeerrUI {
    [key: string]: any;
}

/** Shared internal helper bag (was JC.internals.seerrUi). */
export interface SeerrUiInternal {
    state: {
        seerrHoverPopover: any;
        seerrHoverLock: boolean;
        active4KPopup: any;
    };
    [key: string]: any;
}

declare module '../../types/jc' {
    interface JEGlobal {
        /** Public Seerr UI surface (src/seerr/ui-*.ts). */
        seerrUI?: SeerrUI;
    }
}

/** The public UI surface, published on JC.seerrUI. */
export const ui: SeerrUI = (JC.seerrUI = JC.seerrUI || {});

/** The shared internal bag, private to the ui-* family. */
export const internal: SeerrUiInternal = {
    state: { seerrHoverPopover: null, seerrHoverLock: false, active4KPopup: null }
};
