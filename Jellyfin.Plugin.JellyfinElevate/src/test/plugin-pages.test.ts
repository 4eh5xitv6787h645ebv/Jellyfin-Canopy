// Behavioural tests for the standalone nav-page bootstrap scripts shipped as
// PluginPages/*.html (Calendar / Downloads / HiddenContent / Bookmarks). These
// run the REAL inline <script> from each file against jsdom.
//
// SRV-3: when no visible #userPluginPreferencesPage exists, the cleanup used to
//        remove the authored container while the recreate was guarded on that
//        same (absent) preferences page → zero mount targets → blank page. The
//        container must survive / be recreated into the page's own container.
// SRV-5: the DownloadsPage fallback poll read a different visibility flag than
//        the load block set, and only cleared its interval on beforeunload (never
//        on SPA nav-away). It must read the flag it set and stop when the page is
//        gone.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

// Resolve PluginPages/ from this test's path (src/test/) without node's fs/path
// (which aren't in the src tsconfig); read via the TS compiler host like the
// other source-scanning guards do.
const TEST_PATH = decodeURIComponent(new URL(import.meta.url).pathname);
const PAGES_DIR = TEST_PATH.replace(/src\/test\/plugin-pages\.test\.ts$/, 'PluginPages/');

function readPage(name: string): string {
    return ts.sys.readFile(PAGES_DIR + name) ?? '';
}

/** Markup before the first <script> (the authored page divs). */
function markupOf(html: string): string {
    return html.split('<script>')[0];
}

/** The first <script> body. */
function firstScript(html: string): string {
    return html.match(/<script>([\s\S]*?)<\/script>/)![1];
}

/**
 * Execute an inline page <script> body against the current jsdom document. The
 * scripts are the plugin's OWN shipped page bootstraps read from disk (trusted,
 * no interpolation), executed to exercise their real DOM wiring.
 */
function runInlineScript(text: string): void {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    new Function(text)();
}

interface DownloadsJE {
    downloadsPage: { _pluginPagePollTimer: number | null };
}

describe('nav-page container never self-destructs (SRV-3)', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
        delete (window as unknown as Record<string, unknown>).JellyfinElevate;
    });

    const cases = [
        { file: 'CalendarPage.html', containerId: 'je-calendar-container', pageClass: 'je-calendar-page' },
        { file: 'DownloadsPage.html', containerId: 'je-downloads-container', pageClass: 'je-downloads-page' },
        { file: 'HiddenContentPage.html', containerId: 'je-hidden-content-container', pageClass: 'je-hidden-content-page' },
        { file: 'BookmarksPage.html', containerId: null, pageClass: 'je-bookmarks-page' }, // reference: sections.bookmarks
    ];

    for (const c of cases) {
        it(`${c.file}: authored container survives with no visible preferences page`, () => {
            // Neuter the bootstrap poll — we only assert the synchronous container wiring.
            vi.stubGlobal('setInterval', () => 0 as unknown);
            vi.stubGlobal('clearInterval', () => { /* no-op */ });
            (window as unknown as Record<string, unknown>).JellyfinElevate = {}; // not "ready" → poll would spin, but it's stubbed

            document.body.innerHTML = markupOf(readPage(c.file)); // NO #userPluginPreferencesPage in the DOM
            const ownPage = document.querySelector(`.${c.pageClass}`)!;
            const selector = c.containerId ? `#${c.containerId}` : '.sections.bookmarks';
            expect(ownPage.querySelector(selector), 'authored container present before script').not.toBeNull();

            runInlineScript(firstScript(readPage(c.file)));

            // The container must still be mounted inside the page's own container.
            expect(ownPage.querySelector(selector), 'container removed and never recreated (blank page)').not.toBeNull();
        });

        if (c.containerId) {
            it(`${c.file}: recreates the container into its own page when missing`, () => {
                vi.stubGlobal('setInterval', () => 0 as unknown);
                vi.stubGlobal('clearInterval', () => { /* no-op */ });
                (window as unknown as Record<string, unknown>).JellyfinElevate = {};

                document.body.innerHTML = markupOf(readPage(c.file));
                const ownPage = document.querySelector(`.${c.pageClass}`)!;
                ownPage.querySelector(`#${c.containerId}`)!.remove(); // simulate a stray-only state

                runInlineScript(firstScript(readPage(c.file)));

                expect(ownPage.querySelector(`#${c.containerId}`), 'container not recreated into own page').not.toBeNull();
            });
        }
    }
});

describe('DownloadsPage fallback poll (SRV-5)', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.useRealTimers();
        vi.unstubAllGlobals();
        delete (window as unknown as Record<string, unknown>).JellyfinElevate;
    });

    function runDownloadsBootstrap(refresh: () => void): void {
        vi.useFakeTimers();
        document.body.innerHTML = markupOf(readPage('DownloadsPage.html'));

        // Make the authored container report as visible (jsdom otherwise reports 0).
        const container = document.getElementById('je-downloads-container')!;
        Object.defineProperty(container, 'offsetHeight', { get: () => 10, configurable: true });
        Object.defineProperty(container, 'offsetWidth', { get: () => 10, configurable: true });

        (window as unknown as Record<string, unknown>).JellyfinElevate = {
            pluginConfig: { DownloadsPagePollingEnabled: true, DownloadsPollIntervalSeconds: 0.01 },
            downloadsPage: {
                injectStyles: () => { /* no-op */ },
                renderPage: () => { /* no-op */ },
                refresh,
                _state: { _pluginPageVisible: true }, // load block sets visibility HERE
                // no startPolling → the HTML uses startPollingFallback()
            },
        };

        // Run the real page script, then let the 50ms bootstrap poll fire once so it
        // reaches the "ready" branch and installs the fallback poll.
        runInlineScript(firstScript(readPage('DownloadsPage.html')));
        vi.advanceTimersByTime(50);
    }

    it('polls using the same visibility flag the load block set (_state._pluginPageVisible)', () => {
        const refresh = vi.fn();
        runDownloadsBootstrap(refresh);
        // The bootstrap ready-branch calls refresh() once directly; clear it so we
        // isolate the fallback POLL's refresh, which is what the flag gates.
        refresh.mockClear();

        vi.advanceTimersByTime(30); // > the 10ms poll interval
        expect(refresh).toHaveBeenCalled();
    });

    it('stops the poll once the page (container) is gone', () => {
        const refresh = vi.fn();
        runDownloadsBootstrap(refresh);
        const JE = (window as unknown as { JellyfinElevate: DownloadsJE }).JellyfinElevate;
        expect(JE.downloadsPage._pluginPagePollTimer).toBeTruthy();

        document.getElementById('je-downloads-container')!.remove();
        refresh.mockClear();
        vi.advanceTimersByTime(30);

        expect(JE.downloadsPage._pluginPagePollTimer).toBeNull(); // interval cleared on nav-away
        expect(refresh).not.toHaveBeenCalled();
    });
});
