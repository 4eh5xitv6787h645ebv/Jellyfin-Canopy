import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import type { ApiApi } from '../../types/jc';
import {
    addRemoveButton,
    detectCardSurface,
    hideEmptyHomeSections,
    installRemoveHome,
    removeFromHomeSurface,
} from './remove-home';

let disposeFeature: (() => void) | null = null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('Continue Watching removal identity ownership', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        JC.identity.transition('test-server-id', 'user-a', 'remove-home-test-start');
        JC.t = (key: string) => key;
        JC.escapeHtml = (value: unknown) => typeof value === 'string' ? value : '';
        disposeFeature = installRemoveHome();
    });

    afterEach(() => {
        disposeFeature?.();
        disposeFeature = null;
    });

    it('drops a held A completion without mutating B UI or hidden state', async () => {
        const held = deferred<unknown>();
        const plugin = vi.fn(() => held.promise);
        JC.core.api = { plugin } as unknown as ApiApi;
        const markScopedHidden = vi.fn();
        JC.hiddenContent = {
            flushPendingSave: vi.fn().mockResolvedValue(undefined),
            markScopedHidden,
        } as unknown as NonNullable<typeof JC.hiddenContent>;

        const card = document.createElement('div');
        document.body.appendChild(card);
        const result = removeFromHomeSurface('item-a', 'continuewatching', card);
        await vi.waitFor(() => expect(plugin).toHaveBeenCalledTimes(1));

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        held.resolve({});

        await expect(result).resolves.toBe(false);
        expect(card.style.display).toBe('');
        expect(markScopedHidden).not.toHaveBeenCalled();
    });

    it('reverses an A-owned optimistic hide synchronously on transition', async () => {
        JC.core.api = { plugin: vi.fn().mockResolvedValue({}) } as unknown as ApiApi;
        JC.hiddenContent = {
            flushPendingSave: vi.fn().mockResolvedValue(undefined),
            markScopedHidden: vi.fn(),
        } as unknown as NonNullable<typeof JC.hiddenContent>;
        const card = document.createElement('div');
        document.body.appendChild(card);

        await expect(removeFromHomeSurface('item-a', 'continuewatching', card)).resolves.toBe(true);
        expect(card.style.display).toBe('none');

        JC.identity.transition('test-server-id', 'user-b', 'account-switch');
        expect(card.style.display).toBe('');
        expect(card.dataset.jcHomeRemoved).toBeUndefined();
    });

    it('fails visible while a localized scoped row is empty/loading, then hides and restores owned rows', () => {
        const section = document.createElement('div');
        section.id = 'resumableSection';
        section.className = 'verticalSection';
        section.innerHTML = '<h2 class="sectionTitle">Continuar viendo</h2>';
        document.body.appendChild(section);

        hideEmptyHomeSections();
        expect(section.style.display).toBe('');
        expect(section.dataset.jcHomeSectionHidden).toBeUndefined();

        const card = document.createElement('div');
        card.className = 'card jc-hidden';
        card.dataset.id = 'late-item';
        section.appendChild(card);
        hideEmptyHomeSections();
        expect(section.style.display).toBe('none');
        expect(section.dataset.jcHomeSectionHidden).toBe('1');

        card.classList.remove('jc-hidden');
        hideEmptyHomeSections();
        expect(section.style.display).toBe('');
        expect(section.dataset.jcHomeSectionHidden).toBeUndefined();
    });

    it('restores a plugin-hidden row when Jellyfin inserts a visible replacement card', async () => {
        window.location.hash = '#/home';
        const section = document.createElement('div');
        section.id = 'resumableSection';
        section.className = 'verticalSection';
        section.innerHTML = '<div class="card jc-hidden" data-id="HIDDEN"></div>';
        document.body.appendChild(section);
        hideEmptyHomeSections();
        expect(section.style.display).toBe('none');

        const replacement = document.createElement('div');
        replacement.className = 'card';
        replacement.dataset.id = 'VISIBLE';
        section.appendChild(replacement);

        await vi.waitFor(() => expect(section.style.display).toBe(''));
        expect(section.dataset.jcHomeSectionHidden).toBeUndefined();
    });

    it('reconciles the first already-open menu when row preferences arrive', async () => {
        disposeFeature?.();
        disposeFeature = null;
        const held = deferred<{ CustomPrefs: Record<string, string> }>();
        ApiClient.getDisplayPreferences = vi.fn(() => held.promise);
        disposeFeature = installRemoveHome();
        JC.state = {
            activeShortcuts: {},
            removeContext: null,
            pauseScreenClickTimer: null,
        };
        JC.currentSettings = {
            ...(JC.currentSettings || {}),
            removeContinueWatchingEnabled: true,
        };

        const container = document.createElement('div');
        container.className = 'homeSectionsContainer';
        const section = document.createElement('div');
        section.className = 'verticalSection section1';
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = 'first-menu-item';
        section.appendChild(card);
        container.appendChild(section);
        document.body.appendChild(container);

        const scroller = document.createElement('div');
        scroller.className = 'actionSheetScroller';
        scroller.innerHTML = '<button class="actionSheetMenuItem" data-id="play"><span class="actionSheetItemText">Play</span></button>';
        document.body.appendChild(scroller);

        const initialSurface = detectCardSurface(card);
        expect(initialSurface).toBeNull();
        JC.state.removeContext = {
            itemId: 'first-menu-item',
            surface: initialSurface,
            card,
            ts: Date.now(),
        };
        addRemoveButton();
        expect(scroller.querySelector('[data-id="remove-continue-watching"]')).toBeNull();
        expect(JC.state.removeContext).not.toBeNull();

        held.resolve({ CustomPrefs: {} });
        await vi.waitFor(() => {
            const button = scroller.querySelector<HTMLElement>('[data-id="remove-continue-watching"]');
            expect(button?.dataset.jcSurface).toBe('continuewatching');
        });
        expect(JC.state.removeContext).toBeNull();
    });
});
