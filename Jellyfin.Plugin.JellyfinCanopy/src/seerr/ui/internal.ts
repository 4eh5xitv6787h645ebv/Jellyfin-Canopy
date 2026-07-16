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

const InternalOwner = Symbol.for('JellyfinCanopy.seerrUiInternal.v1');

function isSeerrUiInternal(value: unknown): value is SeerrUiInternal {
    if (!value || typeof value !== 'object') return false;
    const state = (value as Partial<SeerrUiInternal>).state;
    return Boolean(state && typeof state === 'object'
        && Object.prototype.hasOwnProperty.call(state, 'seerrHoverPopover')
        && typeof state.seerrHoverLock === 'boolean'
        && Object.prototype.hasOwnProperty.call(state, 'active4KPopup'));
}

const publishedUi = JC.seerrUI;
const publishedInternal = publishedUi
    ? Reflect.get(publishedUi, InternalOwner) as unknown
    : undefined;
const retryInternal = isSeerrUiInternal(publishedInternal)
    ? publishedInternal
    : null;

/**
 * Stable document-owned UI surface. A bounded module-graph retry evaluates
 * this module at a new URL, so reuse an already activated graph's facade
 * instead of splitting producers from consumers across two objects. Reading
 * the published owner is import-pure; first publication still belongs only to
 * installSeerrUiFacade(). A non-extensible legacy facade is copied so install
 * can add retry ownership without mutating or discarding its public members.
 */
export const ui: SeerrUI = retryInternal
    ? publishedUi!
    : publishedUi && !Object.isExtensible(publishedUi)
        ? Object.assign({}, publishedUi)
        : publishedUi ?? {};

export function installSeerrUiFacade(): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(ui, InternalOwner);
    if (descriptor && descriptor.value !== internal) {
        throw new TypeError('Seerr UI facade has conflicting internal ownership');
    }
    if (!descriptor) {
        Object.defineProperty(ui, InternalOwner, {
            value: internal,
            enumerable: false,
            configurable: false,
            writable: false,
        });
    }
    JC.seerrUI = ui;
    return () => undefined;
}

/** The shared internal bag, private to the ui-* family. */
export const internal: SeerrUiInternal = retryInternal ?? {
    state: { seerrHoverPopover: null, seerrHoverLock: false, active4KPopup: null }
};
