import { beforeEach, describe, expect, it } from 'vitest';
import {
    carryViewRootAcrossNavigation,
    recordViewRootShown,
    resetViewRootTrackingForTests,
    resolveCurrentViewRoot,
} from './view-root';

function buildRoot(classes = 'page libraryPage'): HTMLElement {
    const root = document.createElement('div');
    root.id = 'myPreferencesMenuPage';
    root.className = classes;
    document.body.appendChild(root);
    return root;
}

describe('resolveCurrentViewRoot', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        resetViewRootTrackingForTests();
        history.replaceState({}, '', '/web/#/home');
    });

    it('enumerates duplicate ids and adopts the only visible boot-time instance', () => {
        const stale = buildRoot('page libraryPage hide');
        const current = buildRoot('page libraryPage');

        const resolved = resolveCurrentViewRoot('myPreferencesMenuPage');

        expect(resolved?.root).toBe(current);
        expect(resolved?.root).not.toBe(stale);
    });

    it('waits for the current navigation viewshow instead of adopting the outgoing page', () => {
        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=old');
        const outgoing = buildRoot();
        recordViewRootShown(outgoing);
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')?.root).toBe(outgoing);

        // Jellyfin changes the route before it hides the outgoing cached view.
        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=new');
        const incoming = buildRoot('page libraryPage');
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')).toBeNull();

        incoming.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')?.root).toBe(incoming);
    });

    it('refreshes ownership when POP re-shows an older cached instance', () => {
        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=a');
        const cachedA = buildRoot();
        cachedA.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));

        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=b');
        cachedA.classList.add('hide');
        const cachedB = buildRoot();
        cachedB.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')?.root).toBe(cachedB);

        history.replaceState({}, '', '/web/#/mypreferencesmenu.html?instance=a');
        cachedB.classList.add('hide');
        cachedA.classList.remove('hide');
        cachedA.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')?.root).toBe(cachedA);
    });

    it('supports modern and legacy root class dialects without selector-order ownership', () => {
        const legacy = buildRoot('page libraryPage hide');
        const modern = buildRoot('page mainAnimatedPage');
        modern.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: true }));

        expect(resolveCurrentViewRoot('myPreferencesMenuPage')?.root).toBe(modern);
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')?.root).not.toBe(legacy);
    });

    it('carries only one exact previously shown root across an approved navigation', () => {
        history.replaceState({}, '', '/web/#/movies?topParentId=A');
        const root = buildRoot();
        recordViewRootShown(root);

        history.replaceState({}, '', '/web/#/movies?topParentId=B');
        const carried = carryViewRootAcrossNavigation(
            'myPreferencesMenuPage',
            (key) => key.includes('/movies?'),
        );

        expect(carried?.root).toBe(root);
        expect(carried?.navigationKey).toBe('/web/#/movies?topParentId=B');
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')?.root).toBe(root);
    });

    it('does not carry an unstamped or ambiguous visible root', () => {
        history.replaceState({}, '', '/web/#/movies?topParentId=A');
        const shown = buildRoot();
        recordViewRootShown(shown);

        history.replaceState({}, '', '/web/#/movies?topParentId=B');
        const unstamped = buildRoot();
        expect(carryViewRootAcrossNavigation('myPreferencesMenuPage', () => true)).toBeNull();

        shown.remove();
        expect(carryViewRootAcrossNavigation('myPreferencesMenuPage', () => true)).toBeNull();
        expect(resolveCurrentViewRoot('myPreferencesMenuPage')).toBeNull();
        unstamped.remove();
    });

    it('rejects an interrupted route chain even when it returns to the same path', () => {
        history.replaceState({}, '', '/web/#/movies?topParentId=A');
        const root = buildRoot();
        recordViewRootShown(root);

        history.replaceState({}, '', '/web/#/home');
        history.replaceState({}, '', '/web/#/movies?topParentId=B');

        expect(carryViewRootAcrossNavigation(
            'myPreferencesMenuPage',
            (key) => key.includes('/movies?'),
        )).toBeNull();
    });

    it('fails closed when a root predates the bounded navigation evidence', () => {
        history.replaceState({}, '', '/web/#/movies?topParentId=A');
        const root = buildRoot();
        recordViewRootShown(root);

        for (let index = 0; index < 70; index += 1) {
            history.replaceState({}, '', `/web/#/movies?topParentId=${index}`);
        }

        expect(carryViewRootAcrossNavigation(
            'myPreferencesMenuPage',
            (key) => key.includes('/movies?'),
        )).toBeNull();
    });
});
