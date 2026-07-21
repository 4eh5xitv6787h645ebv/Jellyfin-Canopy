import type { Page } from 'playwright/test';

/**
 * Give Theme Studio the same coarse/fine pointer evidence in every Playwright
 * engine. Chromium can use its native emulation protocol; Firefox and WebKit
 * receive a narrow matchMedia shim because neither exposes CDP.
 */
export async function emulatePointer(page: Page, coarse: boolean): Promise<void> {
    const browserName = page.context().browser()?.browserType().name();
    if (browserName === 'chromium') {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', coarse
            ? { enabled: true, maxTouchPoints: 1 }
            : { enabled: false });
        return;
    }

    await page.addInitScript((coarsePointer) => {
        const nativeMatchMedia = window.matchMedia.bind(window);
        window.matchMedia = ((query: string): MediaQueryList => {
            const nativeList = nativeMatchMedia(query);
            const pointerOnly = /^\(pointer:\s*coarse\)$/.test(query.trim());
            if (!/\(pointer:\s*coarse\)/.test(query)) return nativeList;
            const remainingQuery = query
                .replace(/\s+and\s+\(pointer:\s*coarse\)/g, '')
                .replace(/\(pointer:\s*coarse\)\s+and\s+/g, '')
                .trim();
            const matches = () => coarsePointer
                && (pointerOnly || nativeMatchMedia(remainingQuery).matches);
            return new Proxy(nativeList, {
                get(target, property) {
                    if (property === 'matches') return matches();
                    const value = Reflect.get(target, property, target) as unknown;
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }) as typeof window.matchMedia;
    }, coarse);
}
