// Unit tests for src/enhanced/settings-panel/entry-points.ts — specifically the
// observer-free JC.addUserPreferencesLink gating (PERF(R3) fix: the old
// implementation created a NEW body-wide attribute MutationObserver on every
// call made off the preferences page, and never disconnected them).
import { beforeEach, describe, expect, it } from 'vitest';
import { JC } from '../../globals';
import './entry-points';

const addLink = (): void => (JC as unknown as { addUserPreferencesLink: () => void }).addUserPreferencesLink();

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
});
