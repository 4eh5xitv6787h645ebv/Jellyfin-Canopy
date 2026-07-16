// src/enhanced/pages/early-mask.ts
//
// 404-flash prevention. The router's fallback view dispatches its events
// from a React effect (post-commit), so its stock "Page not found" content
// can paint before adoption — for a frame on hot navigations, and for the
// whole plugin-boot window (~0.5-1s) on a cold deep link or refresh.
//
// Two masks, one stylesheet:
//  * html[data-jc-page-nav]  — set by router-bridge just before it asks the
//    router to navigate to a page; cleared on adoption.
//  * html[data-jc-page-boot] — set here AT PARSE TIME when the current URL
//    already matches a page route (cold deep link / refresh / enforcement
//    reload), before any config or user fetch; cleared on adoption.
//
// While either attribute is present the fallback's stock children are
// hidden and a neutral loading state shows instead. The routes are a static
// list on purpose: config isn't loaded yet at parse time; availability is
// enforced later at adoption (an unavailable page just leaves the native
// 404 once the mask clears).

import { PAGE_NAV_ATTR } from './router-bridge';
import { catalogPages } from './registry';

const STATIC_ROUTES = catalogPages().map((descriptor) => descriptor.route);

const BOOT_ATTR = 'data-jc-page-boot';
const NAV_ATTR = PAGE_NAV_ATTR;

function currentPathFromHash(): string {
    const raw = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash;
    return raw.split('?')[0];
}

/** Install the mask stylesheet and, when parsing on a page URL, the boot attr. */
export function installEarlyMask(): void {
    if (document.getElementById('jc-pages-early-mask')) return;
    const style = document.createElement('style');
    style.id = 'jc-pages-early-mask';
    style.textContent = [
        `html[${BOOT_ATTR}] #fallbackPage > *, html[${NAV_ATTR}] #fallbackPage > * { display: none !important; }`,
        `html[${BOOT_ATTR}] #fallbackPage::after, html[${NAV_ATTR}] #fallbackPage::after {`,
        "  content: ''; display: block; width: 34px; height: 34px; margin: 20vh auto 0;",
        '  border: 3px solid rgba(255,255,255,0.2); border-top-color: rgba(255,255,255,0.75);',
        '  border-radius: 50%; animation: jc-page-boot-spin 0.9s linear infinite;',
        '}',
        '@keyframes jc-page-boot-spin { to { transform: rotate(360deg); } }'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);

    if (STATIC_ROUTES.includes(currentPathFromHash())) {
        document.documentElement.setAttribute(BOOT_ATTR, '');
        // Safety valve: if adoption never happens (page disabled, signed-out
        // edge, unexpected boot failure), reveal the native 404 rather than
        // spinning forever. Adoption clears the mask long before this.
        window.setTimeout(() => {
            document.documentElement.removeAttribute(BOOT_ATTR);
        }, 15_000);
    }
}

/** Clear both masks (called on adoption). */
export function clearEarlyMask(): void {
    document.documentElement.removeAttribute(BOOT_ATTR);
    document.documentElement.removeAttribute(NAV_ATTR);
}
