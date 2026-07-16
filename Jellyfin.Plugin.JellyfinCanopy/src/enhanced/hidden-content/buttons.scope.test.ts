import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import {
    acquireHomeRowScopes,
    primeHomeRowScopes,
    resetHomeRowScopes,
    resolveHomeRowScope,
} from '../home-row-scope';
import { addLibraryHideButtons, resetButtonUi } from './buttons';
import { resetFromUserConfig } from './data';
import { resetDialogUi } from './dialogs';
import { clearFilterIdentityState, setupNativeObserver } from './filter';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('home-row hide button scope safety', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        resetHomeRowScopes();
        JC.identity.transition('button-scope-server', `button-scope-${Date.now()}-${Math.random()}`, 'button-scope-test');
        JC.t = (key: string) => key;
        JC.userConfig = {
            hiddenContent: {
                items: {},
                settings: {
                    showHideButtons: true,
                    showButtonLibrary: true,
                    experimentalHideCollections: false,
                },
            },
        };
        resetFromUserConfig();
    });

    afterEach(() => {
        resetButtonUi();
        clearFilterIdentityState();
        resetDialogUi();
        resetHomeRowScopes();
        vi.restoreAllMocks();
    });

    it('blocks click-time global fallback and removes a stale button after ordinary-to-collection reuse', async () => {
        ApiClient.getDisplayPreferences = vi.fn().mockResolvedValue({ CustomPrefs: {} });
        const release = acquireHomeRowScopes(() => {});
        primeHomeRowScopes();

        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = 'collection-item';
        const box = document.createElement('div');
        box.className = 'cardBox';
        card.appendChild(box);
        document.body.appendChild(card);
        addLibraryHideButtons();
        const staleButton = box.querySelector<HTMLButtonElement>('.jc-hide-btn');
        expect(staleButton).not.toBeNull();

        const container = document.createElement('div');
        container.className = 'homeSectionsContainer';
        const collectionRow = document.createElement('div');
        collectionRow.className = 'verticalSection section0';
        container.appendChild(collectionRow);
        document.body.appendChild(container);
        collectionRow.appendChild(card);
        await vi.waitFor(() => expect(resolveHomeRowScope(card).kind).toBe('collection'));

        staleButton!.click();
        await Promise.resolve();
        expect(document.querySelector('.jc-hide-confirm-overlay')).toBeNull();
        expect((JC.userConfig!.hiddenContent as { items: Record<string, unknown> }).items).toEqual({});

        addLibraryHideButtons();
        expect(box.querySelector('.jc-hide-btn')).toBeNull();
        expect(box.style.position).toBe('');
        release();
    });

    it('restores cast-only buttons when an unresolved snapshot becomes ready', async () => {
        const held = deferred<{ CustomPrefs: Record<string, string> }>();
        ApiClient.getDisplayPreferences = vi.fn(() => held.promise);
        JC.userConfig = {
            hiddenContent: {
                items: {},
                settings: {
                    showHideButtons: true,
                    showButtonLibrary: false,
                    showButtonCast: true,
                },
            },
        };
        resetFromUserConfig();

        const container = document.createElement('div');
        container.className = 'homeSectionsContainer';
        const section = document.createElement('div');
        section.className = 'verticalSection section0';
        const person = document.createElement('div');
        person.className = 'card personCard';
        person.dataset.id = 'person-id';
        person.dataset.type = 'Person';
        const box = document.createElement('div');
        box.className = 'cardBox';
        person.appendChild(box);
        section.appendChild(person);
        container.appendChild(section);
        document.body.appendChild(container);

        setupNativeObserver();
        addLibraryHideButtons();
        expect(box.querySelector('.jc-hide-btn')).toBeNull();

        held.resolve({ CustomPrefs: {} });
        await vi.waitFor(() => expect(box.querySelector('.jc-hide-btn')).not.toBeNull());
    });
});
