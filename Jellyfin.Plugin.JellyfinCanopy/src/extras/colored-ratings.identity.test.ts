import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { installColoredRatings, resetColoredRatings } from './colored-ratings';

function switchIdentity(serverId: string, userId: string): void {
    JC.identity.transition(serverId, userId, 'colored-ratings-test');
}

function addRating(value = 'PG-13'): HTMLElement {
    const rating = document.createElement('span');
    rating.className = 'mediaInfoOfficialRating';
    rating.textContent = value;
    document.body.appendChild(rating);
    return rating;
}

describe('colored ratings identity lifecycle', () => {
    let disposeFeature: () => void;
    let unregisterReset: () => void;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        switchIdentity('ratings-server-a', 'ratings-user-a');
        JC.pluginConfig = { ColoredRatingsEnabled: true };
        disposeFeature = installColoredRatings();
        unregisterReset = JC.identity.registerReset('colored-ratings-test', resetColoredRatings);
    });

    afterEach(() => {
        JC.identity.transition('', '', 'colored-ratings-test-cleanup');
        unregisterReset();
        disposeFeature();
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('undoes A annotations and queued work when B disables the feature', () => {
        const rating = addRating();
        JC.initializeColoredRatings!();
        expect(rating.getAttribute('rating')).toBe('PG-13');
        expect(document.getElementById('jellyfin-ratings-style')).toBeTruthy();

        document.dispatchEvent(new Event('visibilitychange'));
        switchIdentity('ratings-server-b', 'ratings-user-b');
        JC.pluginConfig = { ColoredRatingsEnabled: false };
        JC.initializeColoredRatings!();
        vi.runOnlyPendingTimers();

        expect(rating.hasAttribute('rating')).toBe(false);
        expect(rating.dataset.jcColoredRating).toBeUndefined();
        expect(document.getElementById('jellyfin-ratings-style')).toBeNull();
    });

    it('keeps observer/navigation counts bounded across A to B to A', () => {
        addRating('R');
        JC.initializeColoredRatings!();
        const bodyCount = JC.core.dom!.getBodySubscriberCount();
        const navCount = JC.core.navigation!.getNavCallbackCount();

        JC.initializeColoredRatings!();
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(bodyCount);
        expect(JC.core.navigation!.getNavCallbackCount()).toBe(navCount);

        switchIdentity('ratings-server-b', 'ratings-user-b');
        JC.pluginConfig = { ColoredRatingsEnabled: true };
        JC.initializeColoredRatings!();
        switchIdentity('ratings-server-a', 'ratings-user-a');
        JC.initializeColoredRatings!();

        expect(JC.core.dom!.getBodySubscriberCount()).toBe(bodyCount);
        expect(JC.core.navigation!.getNavCallbackCount()).toBe(navCount);
        expect(document.querySelectorAll('[data-jc-colored-rating="true"]')).toHaveLength(1);
    });
});
