// INT-1 regression test: a global JC shortcut must NOT fire while any JC modal
// is open. The global key listener used to only bail inside INPUT/TEXTAREA, so
// a configured shortcut key fired *through* an open modal and navigated the SPA
// away behind the dialog. The jc-modal-open body class (set by modal-a11y) now
// gates every global shortcut.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../core/ui-kit'; // real toast/escapeHtml so the control case runs cleanly

describe('keyListener modal guard (INT-1)', () => {
    let keyListener: EventListener;

    beforeEach(async () => {
        vi.resetModules();
        const JC = window.JellyfinCanopy as unknown as Record<string, any>;
        JC.state = { activeShortcuts: { GoToHome: 'H' } };
        JC.pluginConfig = {};
        JC.t = (k: string) => k;
        // The listener falls through to a video-page section after the global
        // shortcut chain; stub so the control case doesn't throw on it.
        JC.isVideoPage = () => false;
        await import('./events');
        keyListener = (window.JellyfinCanopy as unknown as { keyListener: EventListener }).keyListener;
        document.addEventListener('keydown', keyListener);
        window.location.hash = '#/start';
        document.body.className = '';
    });

    afterEach(() => {
        document.removeEventListener('keydown', keyListener);
        document.body.className = '';
    });

    function pressH(): void {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', bubbles: true }));
    }

    it('does NOT fire the GoToHome shortcut while a modal is open', () => {
        document.body.classList.add('jc-modal-open');
        pressH();
        expect(window.location.hash).toBe('#/start'); // navigation suppressed
    });

    it('DOES fire the shortcut when no modal is open (control)', () => {
        // No jc-modal-open class → the shortcut is wired and only the gate blocks it.
        pressH();
        expect(window.location.hash).toBe('#/home.html');
    });
});
