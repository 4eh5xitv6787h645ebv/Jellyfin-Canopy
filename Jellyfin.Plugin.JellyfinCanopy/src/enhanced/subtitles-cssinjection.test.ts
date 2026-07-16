// Unit test for the subtitle ::cue CSS-injection sink (THEME-1).
//
// A per-user customSubtitleBgColor round-trips through the settings-save
// endpoint and used to be interpolated RAW into a live stylesheet rule via
// insertRule — so a value like `red;background-image:url(https://evil/x)` would
// inject an extra CSS declaration. The pipeline must now route the colour
// through cssColorOr so a non-colour payload falls back to a safe default.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MALICIOUS = 'red;background-image:url(https://evil/x)';

describe('subtitles ::cue insertRule injection', () => {
    let disposeSubtitles: (() => void) | undefined;
    beforeEach(() => {
        vi.resetModules();
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        // Browser-like colour validator (jsdom has no CSS global).
        (globalThis as unknown as { CSS: unknown }).CSS = {
            supports: (prop: string, val: string) =>
                prop === 'color' && /^#[0-9a-f]{3,8}$/i.test(val.trim()),
        };
    });
    afterEach(() => {
        disposeSubtitles?.();
        disposeSubtitles = undefined;
        delete (globalThis as unknown as { CSS?: unknown }).CSS;
        vi.restoreAllMocks();
    });

    it('falls back to a safe colour instead of injecting the payload declaration', async () => {
        const JC = window.JellyfinCanopy;
        JC.currentSettings = {
            customSubtitleTextColor: '#FFFFFFFF',
            customSubtitleBgColor: MALICIOUS,
            disableCustomSubtitleStyles: false,
        };

        // A <video> must exist or the pipeline bails; the client cue sheet must
        // exist or applyNativeCueStyles returns before injecting.
        document.body.appendChild(document.createElement('video'));
        const clientSheet = document.createElement('style');
        clientSheet.id = 'htmlvideoplayer-cuestyle';
        document.head.appendChild(clientSheet);

        const subtitles = await import('./subtitles');
        disposeSubtitles = subtitles.installSubtitles();

        const insertSpy = vi.spyOn(CSSStyleSheet.prototype, 'insertRule');
        JC.applySavedStylesWhenReady?.();

        expect(insertSpy).toHaveBeenCalled();
        const rule = String(insertSpy.mock.calls[0][0]);
        expect(rule).not.toContain('background-image');
        expect(rule).not.toContain('url(');
        expect(rule).not.toContain('evil');
        // The bg colour is replaced by the transparent fallback.
        expect(rule).toContain('#00000000');
    });

    it('removes A styling and leaves B-disabled subtitles untouched', async () => {
        const JC = window.JellyfinCanopy;
        JC.identity.transition('server-a', 'user-a', 'subtitle-test-start');
        JC.currentSettings = {
            customSubtitleTextColor: '#FF0000FF',
            customSubtitleBgColor: '#000000FF',
            disableCustomSubtitleStyles: false,
        };
        document.body.appendChild(document.createElement('video'));
        const innerA = document.createElement('div');
        innerA.className = 'videoSubtitlesInner';
        document.body.appendChild(innerA);
        const clientSheet = document.createElement('style');
        clientSheet.id = 'htmlvideoplayer-cuestyle';
        document.head.appendChild(clientSheet);
        const subtitles = await import('./subtitles');
        disposeSubtitles = subtitles.installSubtitles();

        JC.applySavedStylesWhenReady?.();
        expect(innerA.style.getPropertyValue('color')).not.toBe('');
        expect((document.getElementById('jc-html-videoplayer-cuestyle') as HTMLStyleElement | null)
            ?.sheet?.cssRules.length).toBe(1);

        const contextB = JC.identity.transition('server-a', 'user-b', 'account-switch');
        expect(innerA.style.getPropertyValue('color')).toBe('');
        expect((document.getElementById('jc-html-videoplayer-cuestyle') as HTMLStyleElement | null)
            ?.sheet?.cssRules.length ?? 0).toBe(0);

        JC.currentSettings = { disableCustomSubtitleStyles: true };
        await JC.identity.activate(contextB);
        const innerB = document.createElement('div');
        innerB.className = 'videoSubtitlesInner';
        document.body.appendChild(innerB);
        await Promise.resolve();
        expect(innerB.getAttribute('style')).toBeNull();
    });
});
