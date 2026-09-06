import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

describe('Seerr rendering beside the native search empty state', () => {
    let resetResults: () => void;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        document.body.innerHTML = '<div id="searchPage"></div>';
        JC.identity.transition('native-search-server', 'native-search-user', 'test setup');
        JC.t = (key: string) => key;
        JC.seerrUI = {};
        const { installSeerrUiFacade } = await import('./internal');
        const { resetSeerrResultsIdentity } = await import('./results');
        installSeerrUiFacade();
        resetResults = resetSeerrResultsIdentity;
    });

    afterEach(() => {
        resetResults();
        vi.useRealTimers();
        document.body.replaceChildren();
    });

    it.each(['initial', 'repeated', 'delayed'] as const)(
        'preserves native child identities during %s placement and subsequent host reconciliation',
        async (placement) => {
            const searchPage = document.getElementById('searchPage')!;
            if (placement === 'repeated') {
                searchPage.innerHTML = '<div class="verticalSection"><h2 class="sectionTitle">Movies</h2></div>';
                JC.seerrUI!.renderSeerrResults([], 'earlier query', false, true, true);
            } else if (placement === 'delayed') {
                JC.seerrUI!.renderSeerrResults([], 'current query', false, true, true);
                expect(searchPage.querySelector('.seerr-section')).toBeNull();
            }

            // React may retain both direct text nodes and nested elements for
            // its next commit. Equal replacement text is not equivalent ownership.
            const message = document.createElement('div');
            message.className = 'noItemsMessage';
            const prefix = document.createTextNode('Native search: ');
            const emphasis = document.createElement('strong');
            const nativeText = document.createTextNode('No matching items');
            emphasis.appendChild(nativeText);
            message.append(prefix, emphasis);
            searchPage.appendChild(message);

            if (placement === 'delayed') {
                await vi.advanceTimersByTimeAsync(0);
            } else {
                JC.seerrUI!.renderSeerrResults([], 'current query', false, true, true);
            }

            expect(message.textContent).toBe('Native search: No matching items');
            expect(message.childNodes).toHaveLength(2);
            expect(message.childNodes[0]).toBe(prefix);
            expect(message.childNodes[1]).toBe(emphasis);
            expect(emphasis.firstChild).toBe(nativeText);
            expect(searchPage.querySelectorAll('.seerr-section')).toHaveLength(1);
            expect(searchPage.querySelector('.seerr-section .sectionTitle')?.textContent)
                .toContain('seerr_discover_title');

            // Exercise the removeChild operation the host reconciler performs,
            // using its original references rather than rediscovering new nodes.
            expect(() => {
                emphasis.removeChild(nativeText);
                message.removeChild(emphasis);
                message.removeChild(prefix);
                searchPage.removeChild(message);
            }).not.toThrow();
            const nativeResults = document.createElement('div');
            nativeResults.className = 'verticalSection';
            nativeResults.textContent = 'Native matching items';
            searchPage.appendChild(nativeResults);

            JC.seerrUI!.renderSeerrResults([], 'matching query', true, true, true);
            expect(nativeResults.textContent).toBe('Native matching items');
            expect(searchPage.querySelectorAll('.seerr-section')).toHaveLength(1);
            expect(searchPage.querySelector('.seerr-section .sectionTitle')?.textContent)
                .toContain('seerr_results_title');
        },
    );
});
