// src/enhanced/pages/types.ts
//
// Contracts for the shared pages framework ("routed guest" architecture).
// A page is a real router destination: entering navigates through the host
// router (Emby.Page.show), which renders its #fallbackPage view for our
// route with the full native lifecycle; the framework adopts that routed
// element and renders the page inside it. Content therefore lives INSIDE a
// routed view and cannot outlive navigation.

import type { LifecycleHandle } from '../../types/jc';

/** Everything a page's render/refresh receives from the framework. */
export interface PageContext {
    /** The adopted routed element the page renders into. */
    host: HTMLElement;
    /**
     * Per-adoption dispose bag (a SHARED stable lifecycle handle). Every
     * listener, observer, timer, poll, fetch-abort and cleanup closure the
     * page creates MUST go through the ONE-SHOT track()/addListener()
     * surface — the framework drains it when the page leaves. NEVER use
     * onTeardown here: its hooks are persistent (re-fire on every later
     * drain) and would leak each adoption's closures.
     */
    handle: LifecycleHandle;
    /** AbortSignal tied to this adoption; aborted on drain. */
    signal: AbortSignal;
}

/** A registered page. Descriptors carry NO lifecycle code — only content. */
export interface PageDescriptor {
    /** Stable id, also the PagesOrder token (e.g. 'calendar'). */
    id: string;
    /** Router path WITHOUT the hash prefix (e.g. '/calendar'). Exact match. */
    route: string;
    /** Translation key for the page title / entry-point label. */
    titleKey: string;
    /** English fallback title (used until translations resolve). */
    titleFallback: string;
    /** Material icon name for entry points. */
    icon: string;
    /**
     * Live gate, evaluated per decision (never cached): typically reads the
     * plugin config feature flag for this page.
     */
    isEnabled(): boolean;
    /** Reserved: restrict adoption + entry points to administrators. */
    adminOnly?: boolean;
    /**
     * Render the page into ctx.host (already emptied by the framework).
     * Called on every adoption — each entry is a fresh render; durable page
     * state (filters, data caches) belongs in module state, not the DOM.
     */
    render(ctx: PageContext): void | Promise<void>;
    /** Optional teardown beyond the dispose bag (module-state resets). */
    onHide?(): void;
}
