// Unit tests for src/enhanced/settings-panel/entry-points.ts — specifically the
// observer-free JC.addUserPreferencesLink gating (PERF(R3) fix: the old
// implementation created a NEW body-wide attribute MutationObserver on every
// call made off the preferences page, and never disconnected them).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../../globals';
import { resetViewRootTrackingForTests } from '../../core/view-root';
import { addUserPreferencesLink, resetSettingsLauncher } from './entry-points';

const addLink = (): void => addUserPreferencesLink();

function buildPrefsPage(hidden = false): HTMLElement {
    const page = document.createElement('div');
    page.id = 'myPreferencesMenuPage';
    if (hidden) page.classList.add('hide');
    const section = document.createElement('div');
    section.className = 'verticalSection';
    page.appendChild(section);
    document.body.appendChild(page);
    return page;
}

describe('JC.addUserPreferencesLink', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        resetViewRootTrackingForTests();
    });

    afterEach(() => {
        resetSettingsLauncher();
    });

    it('creates no observers and no link when off the preferences page', () => {
        const observersBefore = JC.core.dom!.getObserverCount();
        const subscribersBefore = JC.core.dom!.getBodySubscriberCount();

        addLink();
        addLink();
        addLink();

        expect(document.getElementById('jellyfinCanopyUserPrefsLink')).toBeNull();
        // The whole point of the fix: repeated off-page calls must not
        // accumulate observers (previously: one new body observer per call).
        expect(JC.core.dom!.getObserverCount()).toBe(observersBefore);
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(subscribersBefore);
    });

    it('adds the link exactly once when the preferences page is visible', () => {
        buildPrefsPage();

        addLink();
        addLink();

        const links = document.querySelectorAll('#jellyfinCanopyUserPrefsLink');
        expect(links.length).toBe(1);
        expect(links[0].closest('.verticalSection')).not.toBeNull();
    });

    it('does not add the link into a hidden (cached) preferences page', () => {
        buildPrefsPage(true);

        addLink();

        expect(document.getElementById('jellyfinCanopyUserPrefsLink')).toBeNull();
    });

    it('reconciles a hidden cached page into the current visible page', () => {
        const stalePage = buildPrefsPage(true);
        const staleLink = document.createElement('a');
        staleLink.id = 'jellyfinCanopyUserPrefsLink';
        stalePage.querySelector('.verticalSection')!.appendChild(staleLink);
        const currentPage = buildPrefsPage();

        addLink();

        expect(stalePage.querySelector('#jellyfinCanopyUserPrefsLink')).toBeNull();
        expect(currentPage.querySelectorAll('#jellyfinCanopyUserPrefsLink')).toHaveLength(1);
    });

    it('adds the link via the navigation hook once the cached page is re-shown', () => {
        const page = buildPrefsPage(true);
        addLink(); // wires the nav hooks; page hidden so no link yet
        expect(document.getElementById('jellyfinCanopyUserPrefsLink')).toBeNull();

        // Simulate the legacy viewManager re-showing the cached page (class
        // flip, no structural mutation) followed by the nav dispatch.
        page.classList.remove('hide');
        history.pushState({}, '', '/test-prefs-link-reshow');

        expect(document.getElementById('jellyfinCanopyUserPrefsLink')).not.toBeNull();
    });

    it('moves ownership across repeated cached-view re-shows without accumulating links', () => {
        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=a');
        const pageA = buildPrefsPage();
        pageA.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        addLink();

        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=b');
        pageA.classList.add('hide');
        const pageB = buildPrefsPage();
        pageB.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        addLink();

        expect(pageA.querySelector('#jellyfinCanopyUserPrefsLink')).toBeNull();
        expect(pageB.querySelectorAll('#jellyfinCanopyUserPrefsLink')).toHaveLength(1);

        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=a');
        pageB.classList.add('hide');
        pageA.classList.remove('hide');
        pageA.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        addLink();

        expect(pageB.querySelector('#jellyfinCanopyUserPrefsLink')).toBeNull();
        expect(pageA.querySelectorAll('#jellyfinCanopyUserPrefsLink')).toHaveLength(1);
        expect(document.querySelectorAll('#jellyfinCanopyUserPrefsLink')).toHaveLength(1);
    });
});
