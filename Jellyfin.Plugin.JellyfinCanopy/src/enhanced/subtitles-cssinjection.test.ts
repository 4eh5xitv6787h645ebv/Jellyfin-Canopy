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

    it('bottom-anchors custom DOM cues, clamps positions, and keeps backgrounds compact', async () => {
        const JC = window.JellyfinCanopy;
        JC.identity.transition('subtitle-server', 'geometry-user', 'subtitle-geometry');
        JC.currentSettings = {
            subtitleHorizontalPosition: 140,
            subtitleVerticalPosition: -20,
            disableCustomSubtitleStyles: false,
        };
        document.body.appendChild(document.createElement('video'));
        const container = document.createElement('div');
        container.className = 'videoSubtitles';
        const inner = document.createElement('div');
        inner.className = 'videoSubtitlesInner';
        inner.textContent = 'First line\nSecond line';
        container.appendChild(inner);
        document.body.appendChild(container);
        const clientSheet = document.createElement('style');
        clientSheet.id = 'htmlvideoplayer-cuestyle';
        document.head.appendChild(clientSheet);

        const subtitles = await import('./subtitles');
        disposeSubtitles = subtitles.installSubtitles();
        JC.applySubtitleStyles?.('#FFFFFFFF', '#000000CC', 2, 'Arial', 'none');

        expect(container.style.getPropertyValue('left')).toBe('0px');
        expect(container.style.getPropertyValue('right')).toBe('auto');
        expect(container.style.getPropertyValue('top')).toBe('2%');
        expect(container.style.getPropertyValue('width')).toBe('100%');
        expect(container.style.getPropertyValue('max-width')).toBe('none');
        expect(container.style.getPropertyValue('transform')).toBe('translateY(-100%)');
        expect(inner.style.getPropertyValue('left')).toBe('40%');
        expect(inner.style.getPropertyValue('max-width')).toBe('20%');
        expect(inner.style.getPropertyValue('margin-bottom')).toBe('0px');
        expect(inner.style.getPropertyValue('padding')).toBe('0.08em 0.2em');
        expect(inner.style.getPropertyValue('border-radius')).toBe('0.15em');

        JC.applySubtitleStyles?.('#FFFFFFFF', '#FF000000', 2, 'Arial', 'none');
        expect(inner.style.getPropertyValue('padding')).toBe('0px');
        expect(inner.style.getPropertyValue('border-radius')).toBe('');
        JC.applySubtitleStyles?.('#FFFFFFFF', '#FF000001', 2, 'Arial', 'none');
        expect(inner.style.getPropertyValue('padding')).toBe('0.08em 0.2em');
        expect(inner.style.getPropertyValue('border-radius')).toBe('0.15em');
        const cueRule = (document.getElementById('jc-html-videoplayer-cuestyle') as HTMLStyleElement)
            .sheet?.cssRules[0]?.cssText || '';
        expect(cueRule).not.toMatch(/(?:^|[;{])\s*(?:top|left|bottom|transform)\s*:/i);
    });

    it('restores host inline styles and removes its cue sheet on teardown', async () => {
        const JC = window.JellyfinCanopy;
        JC.identity.transition('subtitle-server', 'restore-user', 'subtitle-restore');
        JC.currentSettings = { disableCustomSubtitleStyles: false };
        document.body.appendChild(document.createElement('video'));
        const container = document.createElement('div');
        container.className = 'videoSubtitles';
        container.style.setProperty('position', 'fixed');
        container.style.setProperty('left', '10px');
        container.style.setProperty('right', '20px');
        container.style.setProperty('width', '60%');
        container.style.setProperty('transform', 'scale(1)');
        const inner = document.createElement('div');
        inner.className = 'videoSubtitlesInner';
        inner.style.setProperty('background-color', 'rgb(1, 2, 3)');
        inner.style.setProperty('padding', '1em');
        inner.style.setProperty('border-radius', '9px');
        inner.style.setProperty('margin-bottom', '2.7em');
        inner.style.setProperty('max-width', '70%');
        container.appendChild(inner);
        document.body.appendChild(container);
        const clientSheet = document.createElement('style');
        clientSheet.id = 'htmlvideoplayer-cuestyle';
        document.head.appendChild(clientSheet);

        const subtitles = await import('./subtitles');
        disposeSubtitles = subtitles.installSubtitles();
        JC.applySubtitleStyles?.('#FFFFFFFF', '#000000CC', 2, 'Arial', 'none');
        expect(container.style.getPropertyValue('position')).toBe('absolute');
        expect(inner.style.getPropertyValue('padding')).toBe('0.08em 0.2em');

        disposeSubtitles();
        disposeSubtitles = undefined;

        expect(container.style.getPropertyValue('position')).toBe('fixed');
        expect(container.style.getPropertyValue('left')).toBe('10px');
        expect(container.style.getPropertyValue('right')).toBe('20px');
        expect(container.style.getPropertyValue('width')).toBe('60%');
        expect(container.style.getPropertyValue('transform')).toBe('scale(1)');
        expect(inner.style.getPropertyValue('background-color')).toBe('rgb(1, 2, 3)');
        expect(inner.style.getPropertyValue('padding')).toBe('1em');
        expect(inner.style.getPropertyValue('border-radius')).toBe('9px');
        expect(inner.style.getPropertyValue('margin-bottom')).toBe('2.7em');
        expect(inner.style.getPropertyValue('max-width')).toBe('70%');
        expect(document.getElementById('jc-html-videoplayer-cuestyle')).toBeNull();
    });

    it('restores removed subtitle nodes and safely owns them again after reattachment', async () => {
        const JC = window.JellyfinCanopy;
        JC.identity.transition('subtitle-server', 'reattach-user', 'subtitle-reattach');
        JC.currentSettings = { disableCustomSubtitleStyles: false };
        document.body.appendChild(document.createElement('video'));
        const container = document.createElement('div');
        container.className = 'videoSubtitles';
        const inner = document.createElement('div');
        inner.className = 'videoSubtitlesInner';
        inner.style.padding = '1em';
        container.appendChild(inner);
        document.body.appendChild(container);
        const clientSheet = document.createElement('style');
        clientSheet.id = 'htmlvideoplayer-cuestyle';
        document.head.appendChild(clientSheet);

        const subtitles = await import('./subtitles');
        disposeSubtitles = subtitles.installSubtitles();
        JC.applySubtitleStyles?.('#FFFFFFFF', '#000000CC', 2, 'Arial', 'none');
        expect(inner.style.getPropertyValue('padding')).toBe('0.08em 0.2em');

        container.remove();
        await vi.waitFor(() => expect(inner.style.getPropertyValue('padding')).toBe('1em'));
        document.body.appendChild(container);
        await vi.waitFor(() => expect(inner.style.getPropertyValue('padding')).toBe('0.08em 0.2em'));

        disposeSubtitles();
        disposeSubtitles = undefined;
        expect(inner.style.getPropertyValue('padding')).toBe('1em');
    });
});
