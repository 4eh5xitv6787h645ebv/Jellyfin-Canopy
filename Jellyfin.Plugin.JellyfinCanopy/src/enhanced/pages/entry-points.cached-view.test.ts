import { describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { initEntryPoints } from './entry-points';
import { registerPage } from './registry';

function buildPreferencesPage(hidden: boolean): HTMLElement {
    const page = document.createElement('div');
    page.id = 'myPreferencesMenuPage';
    page.className = 'page libraryPage';
    if (hidden) page.classList.add('hide');
    const section = document.createElement('div');
    section.className = 'verticalSection';
    page.appendChild(section);
    document.body.appendChild(page);
    return page;
}

describe('page entry points in cached native preferences views', () => {
    it('removes a stale owned link and mounts exactly once in the current page', async () => {
        document.body.innerHTML = '';
        const context = JC.identity.transition('server-a', 'user-a', 'cached-preferences-test');
        registerPage({
            id: 'cached-preferences-entry',
            route: '/cached-preferences-entry',
            titleKey: 'cached_preferences_entry',
            titleFallback: 'Cached preferences entry',
            icon: 'event',
            isEnabled: () => true,
            render: vi.fn(),
        });
        const stalePage = buildPreferencesPage(true);
        const staleLink = document.createElement('a');
        staleLink.id = 'jcPagePrefs-cached-preferences-entry';
        staleLink.setAttribute('data-jc-identity-owned', 'true');
        JC.identity.own(staleLink, context);
        stalePage.querySelector('.verticalSection')!.appendChild(staleLink);
        const currentPage = buildPreferencesPage(false);

        initEntryPoints();
        await JC.identity.activate(context);

        expect(stalePage.querySelector('#jcPagePrefs-cached-preferences-entry')).toBeNull();
        expect(currentPage.querySelectorAll('#jcPagePrefs-cached-preferences-entry')).toHaveLength(1);
        JC.core.dom!.removeBodySubscriber('jc-pages-entries');
    });
});
