import { afterEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';
import { handleHistoryUpdate } from '../../core/navigation';
import {
    recordViewRootShown,
} from '../../core/view-root';
import {
    parseSettingsPreferencesRoute,
    type SettingsPanelLaunchContext,
} from './launch-context';

const mocks = vi.hoisted(() => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    return {
        held,
        loadCount: 0,
        release,
        reset: vi.fn(),
        show: vi.fn<
            (launch?: SettingsPanelLaunchContext | null) => Promise<void>
        >().mockResolvedValue(undefined),
    };
});

vi.mock('./panel', async () => {
    mocks.loadCount += 1;
    await mocks.held;
    return {
        resetSettingsPanel: mocks.reset,
        showEnhancedPanel: mocks.show,
    };
});

import {
    addUserPreferencesLink,
    installSettingsLauncher,
    openEnhancedPanel,
} from './entry-points';

let dispose: (() => void) | null = null;

afterEach(() => {
    dispose?.();
    dispose = null;
});

describe('settings panel dynamic import fence', () => {
    it('singleflights the graph and rejects navigation or identity-obsolete completions', async () => {
        JC.identity.transition('', '', 'settings-lazy-test-logout');
        JC.identity.transition('server', 'user-a', 'settings-lazy-test-a');
        dispose = installSettingsLauncher();

        const first = openEnhancedPanel();
        const second = openEnhancedPanel();
        await vi.waitFor(() => expect(mocks.loadCount).toBe(1));
        expect(mocks.show).not.toHaveBeenCalled();

        history.pushState({}, '', `#/settings-lazy-nav-${Date.now()}`);
        mocks.release();
        await Promise.all([first, second]);

        expect(mocks.loadCount).toBe(1);
        expect(mocks.show).not.toHaveBeenCalled();
        expect(mocks.reset).not.toHaveBeenCalled();

        await openEnhancedPanel();
        expect(mocks.show).toHaveBeenCalledTimes(1);
        mocks.show.mockClear();

        // loginAs can finish before the Home view lifecycle settles. An
        // unrelated late view must not retire the active panel (or cancel a
        // cold import in the equivalent real-browser race).
        mocks.reset.mockClear();
        const homePage = document.createElement('div');
        homePage.id = 'indexPage';
        document.body.appendChild(homePage);
        homePage.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: true }));
        homePage.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        expect(mocks.reset).not.toHaveBeenCalled();

        history.pushState({}, '', `#/settings-lazy-active-${Date.now()}`);
        handleHistoryUpdate();
        expect(mocks.reset).toHaveBeenCalledTimes(1);

        const targetA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const targetB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        history.pushState({}, '', `#/mypreferencesmenu.html?userId=${targetA}`);
        const page = document.createElement('div');
        page.id = 'myPreferencesMenuPage';
        page.innerHTML = '<div class="verticalSection"></div>';
        document.body.appendChild(page);
        recordViewRootShown(page);
        addUserPreferencesLink();
        const targetLink = page.querySelector<HTMLElement>('#jellyfinCanopyUserPrefsLink')!;

        mocks.show.mockClear();
        targetLink.click();
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce());
        const targetLaunch = mocks.show.mock.calls[0][0];
        expect(targetLaunch).toMatchObject({
            actor: JC.identity.capture(),
        });
        expect(parseSettingsPreferencesRoute(new URL(targetLaunch!.url)))
            .toEqual({ kind: 'preferences', targetUserId: targetA });

        // A same-URL React view replacement must retire the active panel even
        // when no history signal fires. The still-current root can reopen it.
        mocks.reset.mockClear();
        page.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: true }));
        expect(mocks.reset).toHaveBeenCalledOnce();
        mocks.show.mockClear();
        targetLink.click();
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce());
        expect(parseSettingsPreferencesRoute(new URL(mocks.show.mock.calls[0][0]!.url)))
            .toEqual({ kind: 'preferences', targetUserId: targetA });

        // Ownership then moves to a different cached root and target. The
        // retained A link is detached and inert; one click on B opens B once.
        mocks.show.mockClear();
        history.pushState({}, '', `#/mypreferencesmenu.html?userId=${targetB}`);
        page.classList.add('hide');
        const pageB = document.createElement('div');
        pageB.id = 'myPreferencesMenuPage';
        pageB.innerHTML = '<div class="verticalSection"></div>';
        document.body.appendChild(pageB);
        pageB.dispatchEvent(new CustomEvent('viewbeforeshow', { bubbles: true }));
        pageB.dispatchEvent(new CustomEvent('viewshow', { bubbles: true }));
        addUserPreferencesLink();
        const targetBLink = pageB.querySelector<HTMLElement>('#jellyfinCanopyUserPrefsLink')!;
        expect(targetBLink).toBeTruthy();
        expect(targetLink.isConnected).toBe(false);

        targetLink.click();
        await Promise.resolve();
        expect(mocks.show).not.toHaveBeenCalled();

        targetBLink.click();
        await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce());
        expect(parseSettingsPreferencesRoute(new URL(mocks.show.mock.calls[0][0]!.url)))
            .toEqual({ kind: 'preferences', targetUserId: targetB });

        mocks.show.mockClear();
        const obsoleteIdentity = openEnhancedPanel();
        JC.identity.transition('server', 'user-b', 'settings-lazy-test-b');
        await obsoleteIdentity;
        expect(mocks.show).not.toHaveBeenCalled();
    });
});
