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

    it('keeps the visible and accessible FSK value canonical, then restores host state', () => {
        const rating = addRating('DE-12');
        rating.setAttribute('rating', 'host-rating');
        rating.setAttribute('aria-label', 'Host DE-12 label');
        rating.setAttribute('title', 'Host DE-12 title');

        JC.initializeColoredRatings!();

        expect(rating.textContent).toBe('FSK-12');
        expect(rating.getAttribute('rating')).toBe('FSK-12');
        expect(rating.getAttribute('aria-label')).toBe('Content rated FSK-12');
        expect(rating.getAttribute('title')).toBe('Rating: FSK-12');

        resetColoredRatings();
        expect(rating.textContent).toBe('DE-12');
        expect(rating.getAttribute('rating')).toBe('host-rating');
        expect(rating.getAttribute('aria-label')).toBe('Host DE-12 label');
        expect(rating.getAttribute('title')).toBe('Host DE-12 title');
        expect(rating.dataset.jcColoredRating).toBeUndefined();
    });

    it('updates a retained text node through the production observer path', async () => {
        const rating = addRating('FSK 6');
        JC.initializeColoredRatings!();
        expect(rating.textContent).toBe('FSK-6');

        // Move beyond the fixed navigation-settle window, then model React's
        // retained text-node update. No compatibility resume hook is invoked.
        await vi.advanceTimersByTimeAsync(600);
        expect(rating.firstChild).toBeInstanceOf(Text);
        rating.firstChild!.nodeValue = 'DE-16';
        await vi.advanceTimersByTimeAsync(100);

        expect(rating.textContent).toBe('FSK-16');
        expect(rating.getAttribute('rating')).toBe('FSK-16');
        expect(rating.getAttribute('aria-label')).toBe('Content rated FSK-16');
        expect(rating.getAttribute('title')).toBe('Rating: FSK-16');

        resetColoredRatings();
        expect(rating.textContent).toBe('DE-16');
        expect(rating.hasAttribute('rating')).toBe(false);
        expect(rating.hasAttribute('aria-label')).toBe(false);
        expect(rating.hasAttribute('title')).toBe(false);
    });

    it('updates plugin-owned accessibility metadata from FSK to non-FSK', async () => {
        const rating = addRating('DE-12');
        JC.initializeColoredRatings!();

        rating.firstChild!.nodeValue = 'PG-13';
        await vi.advanceTimersByTimeAsync(100);

        expect(rating.textContent).toBe('PG-13');
        expect(rating.getAttribute('rating')).toBe('PG-13');
        expect(rating.getAttribute('aria-label')).toBe('Content rated PG-13');
        expect(rating.getAttribute('title')).toBe('Rating: PG-13');

        resetColoredRatings();
        expect(rating.textContent).toBe('PG-13');
        expect(rating.hasAttribute('rating')).toBe(false);
        expect(rating.hasAttribute('aria-label')).toBe(false);
        expect(rating.hasAttribute('title')).toBe(false);
    });

    it('restores host accessibility metadata when a retained FSK node becomes non-FSK', async () => {
        const rating = addRating('DE-12');
        rating.setAttribute('aria-label', 'Host rating label');
        rating.setAttribute('title', 'Host rating title');
        JC.initializeColoredRatings!();

        rating.firstChild!.nodeValue = 'PG-13';
        await vi.advanceTimersByTimeAsync(100);

        expect(rating.getAttribute('aria-label')).toBe('Host rating label');
        expect(rating.getAttribute('title')).toBe('Host rating title');

        resetColoredRatings();
        expect(rating.textContent).toBe('PG-13');
        expect(rating.getAttribute('aria-label')).toBe('Host rating label');
        expect(rating.getAttribute('title')).toBe('Host rating title');
    });

    it('does not process retained text updates after lifecycle cleanup', async () => {
        const rating = addRating('DE-12');
        JC.initializeColoredRatings!();
        resetColoredRatings();

        rating.firstChild!.nodeValue = 'DE-16';
        await vi.advanceTimersByTimeAsync(200);

        expect(rating.textContent).toBe('DE-16');
        expect(rating.hasAttribute('rating')).toBe(false);
        expect(rating.hasAttribute('aria-label')).toBe(false);
        expect(rating.hasAttribute('title')).toBe(false);
    });

    it('preserves host metadata for unsupported FSK-prefixed values', () => {
        const rating = addRating('FSK-21');
        rating.setAttribute('aria-label', 'Host unknown FSK label');
        rating.setAttribute('title', 'Host unknown FSK title');

        JC.initializeColoredRatings!();

        expect(rating.textContent).toBe('FSK-21');
        expect(rating.getAttribute('rating')).toBe('FSK-21');
        expect(rating.getAttribute('aria-label')).toBe('Host unknown FSK label');
        expect(rating.getAttribute('title')).toBe('Host unknown FSK title');
    });
});
