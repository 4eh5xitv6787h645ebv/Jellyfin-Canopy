import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import {
    installThemeSelector,
    reconcileThemeSelectorIdentity,
    resetThemeSelector,
} from './theme-selector';

function switchIdentity(serverId: string, userId: string): void {
    JC.identity.transition(serverId, userId, 'theme-selector-test');
}

function mountPreferencesPage(): void {
    document.body.innerHTML = `
        <section class="verticalSection">
            <div class="headerUsername"></div>
            <a class="lnkUserProfile"></a>
        </section>
    `;
}

describe('theme selector identity lifecycle', () => {
    let disposeFeature: () => void;
    let unregisterReset: () => void;

    beforeEach(() => {
        vi.useFakeTimers();
        localStorage.clear();
        sessionStorage.clear();
        document.body.className = '';
        mountPreferencesPage();
        switchIdentity('server-a', 'user-a');
        JC.pluginConfig = { ThemeSelectorEnabled: true };
        disposeFeature = installThemeSelector();
        unregisterReset = JC.identity.registerReset('theme-selector-test', (change) => {
            resetThemeSelector();
            reconcileThemeSelectorIdentity(change);
        });
    });

    afterEach(() => {
        JC.identity.transition('', '', 'theme-selector-test-cleanup');
        unregisterReset();
        disposeFeature();
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('removes A UI and rejects a detached A control after a server switch', () => {
        JC.initializeThemeSelector!();
        vi.advanceTimersByTime(100);

        const select = document.getElementById('theme-selector-select') as HTMLSelectElement;
        expect(select).toBeTruthy();
        expect(JC.core.dom!.getBodySubscriberCount()).toBeGreaterThan(0);

        switchIdentity('server-b', 'user-a');
        JC.pluginConfig = { ThemeSelectorEnabled: false };
        expect(document.getElementById('jellyfin-theme-selector')).toBeNull();
        expect(document.body.classList.contains('theme-applying')).toBe(false);

        select.value = 'Ocean';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        vi.runOnlyPendingTimers();

        expect(localStorage.getItem('jc-theme:servera:usera:customCss')).toBeNull();
        expect(localStorage.getItem('usera-customCss')).toBeNull();
        expect(sessionStorage.length).toBe(0);
    });

    it('keeps equal user ids on different servers isolated and bounds subscriptions', () => {
        JC.initializeThemeSelector!();
        vi.advanceTimersByTime(100);
        const aSubscriberCount = JC.core.dom!.getBodySubscriberCount();

        const selectA = document.getElementById('theme-selector-select') as HTMLSelectElement;
        selectA.value = 'Aurora';
        selectA.dispatchEvent(new Event('change', { bubbles: true }));
        expect(localStorage.getItem('jc-theme:servera:usera:customCss')).toContain('aurora.css');

        switchIdentity('server-b', 'user-a');
        JC.pluginConfig = { ThemeSelectorEnabled: true };
        mountPreferencesPage();
        JC.initializeThemeSelector!();
        vi.advanceTimersByTime(100);

        const selectB = document.getElementById('theme-selector-select') as HTMLSelectElement;
        expect(selectB.value).toBe('Default');
        expect(localStorage.getItem('jc-theme:serverb:usera:customCss')).toBeNull();
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(aSubscriberCount);

        switchIdentity('server-a', 'user-a');
        expect(localStorage.getItem('usera-customCss')).toContain('aurora.css');
        mountPreferencesPage();
        JC.initializeThemeSelector!();
        vi.advanceTimersByTime(100);
        expect((document.getElementById('theme-selector-select') as HTMLSelectElement).value).toBe('Aurora');
        expect(JC.core.dom!.getBodySubscriberCount()).toBe(aSubscriberCount);
    });
});
