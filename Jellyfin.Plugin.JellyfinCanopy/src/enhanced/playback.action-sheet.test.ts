import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { installPlayback } from './playback';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../core/ui-kit', () => ({ toast: mocks.toast }));

type TrackKind = 'subtitle' | 'audio';

interface MountedSheet {
    readonly container: HTMLElement;
    readonly scroller: HTMLElement;
    readonly clicks: ReturnType<typeof vi.fn>[];
}

function mountTrigger(kind: TrackKind, title = kind === 'subtitle' ? 'Subtitles' : 'Audio'): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = kind === 'subtitle' ? 'btnSubtitles' : 'btnAudio';
    button.title = title;
    document.body.appendChild(button);
    return button;
}

function mountSheet(
    kind: TrackKind,
    title: string,
    labels: string[],
    currentIndex = 0,
    ids: Array<string | undefined> = [],
): MountedSheet {
    const container = document.createElement('div');
    container.className = 'dialogContainer';
    const content = document.createElement('div');
    content.className = 'actionSheetContent';
    const heading = document.createElement('div');
    heading.className = 'actionSheetTitle';
    heading.textContent = title;
    const scroller = document.createElement('div');
    scroller.className = 'actionSheetScroller';
    const clicks: ReturnType<typeof vi.fn>[] = [];

    labels.forEach((label, index) => {
        const row = document.createElement('button');
        row.className = 'listItem';
        if (ids[index]) row.dataset.id = ids[index];
        const icon = document.createElement('span');
        icon.className = 'actionsheetMenuItemIcon listItemIcon' + (index === currentIndex ? ' check' : '');
        if (index === currentIndex) icon.style.visibility = 'visible';
        const text = document.createElement('div');
        text.className = kind === 'audio'
            ? 'listItemBodyText actionSheetItemText'
            : 'listItemBodyText';
        text.textContent = label;
        const click = vi.fn();
        row.addEventListener('click', click);
        clicks.push(click);
        row.append(icon, text);
        scroller.appendChild(row);
    });

    content.append(heading, scroller);
    container.appendChild(content);
    document.body.appendChild(container);
    return { container, scroller, clicks };
}

async function flushMutations(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('playback track action-sheet readiness', () => {
    let disposePlayback: (() => void) | undefined;
    let translate: ReturnType<typeof vi.fn>;
    let escapeHtml: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html#/video?id=track-test');
        const surface = JC as unknown as Record<string, unknown>;
        surface.isVideoPage = () => window.location.hash.startsWith('#/video');
        translate = vi.fn((key: string) => key);
        escapeHtml = vi.fn((value: unknown) => `escaped:${String(value)}`);
        surface.t = translate;
        surface.escapeHtml = escapeHtml;
        JC.identity.transition('track-server', 'track-user', 'track-sheet-test');
        disposePlayback = installPlayback();
        mocks.toast.mockReset();
    });

    afterEach(() => {
        disposePlayback?.();
        disposePlayback = undefined;
        JC.identity.transition('', '', 'track-sheet-cleanup');
        vi.clearAllTimers();
        vi.useRealTimers();
        document.body.innerHTML = '';
        window.history.replaceState(null, '', '/web/index.html#/home');
        vi.restoreAllMocks();
    });

    it.each([
        { kind: 'subtitle' as const, invoke: () => JC.cycleSubtitleTrack!(), title: 'Subtitles', toastKey: 'toast_subtitle' },
        { kind: 'audio' as const, invoke: () => JC.cycleAudioTrack!(), title: 'Audio', toastKey: 'toast_audio' },
    ])('cycles $kind exactly once when its rows mount after 200 ms', async ({ kind, invoke, title, toastKey }) => {
        const trigger = mountTrigger(kind, title);
        const triggerClick = vi.spyOn(trigger, 'click');

        invoke();
        vi.advanceTimersByTime(250);
        expect(mocks.toast).not.toHaveBeenCalled();
        const sheet = mountSheet(kind, title, ['Current', 'Next'], 0);
        await flushMutations();

        expect(triggerClick).toHaveBeenCalledTimes(1);
        expect(sheet.clicks[0]).not.toHaveBeenCalled();
        expect(sheet.clicks[1]).toHaveBeenCalledTimes(1);
        expect(escapeHtml).toHaveBeenCalledWith('Next');
        expect(translate).toHaveBeenCalledWith(
            toastKey,
            kind === 'subtitle' ? { subtitle: 'escaped:Next' } : { audio: 'escaped:Next' },
        );
        expect(mocks.toast).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(3_000);
        expect(sheet.clicks[1]).toHaveBeenCalledTimes(1);
    });

    it.each([
        { kind: 'subtitle' as const, invoke: () => JC.cycleSubtitleTrack!(), title: 'Subtitles' },
        { kind: 'audio' as const, invoke: () => JC.cycleAudioTrack!(), title: 'Audio' },
    ])('settles an atomic $kind mount exactly once', async ({ kind, invoke, title }) => {
        const trigger = mountTrigger(kind, title);
        let sheet: MountedSheet | undefined;
        trigger.addEventListener('click', () => {
            sheet = mountSheet(kind, title, ['Current', 'Next'], 0);
        });

        invoke();
        expect(sheet).toBeDefined();
        expect(sheet!.clicks[1]).toHaveBeenCalledTimes(1);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
        await flushMutations();
        vi.advanceTimersByTime(3_000);

        expect(sheet!.clicks[1]).toHaveBeenCalledTimes(1);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
    });

    it.each([
        { kind: 'subtitle' as const, invoke: () => JC.cycleSubtitleTrack!(), title: 'Subtitles', key: 'toast_no_subtitles_found' },
        { kind: 'audio' as const, invoke: () => JC.cycleAudioTrack!(), title: 'Audio', key: 'toast_no_audio_tracks_found' },
    ])('warns once only after the bounded window for an empty $kind sheet', ({ kind, invoke, title, key }) => {
        const trigger = mountTrigger(kind, title);
        const sheet = mountSheet(kind, title, []);
        const dispatch = vi.spyOn(sheet.container, 'dispatchEvent');
        const triggerClick = vi.spyOn(trigger, 'click');
        let duplicateMounted = false;
        trigger.addEventListener('click', () => {
            duplicateMounted = true;
            mountSheet(kind, title, ['Unexpected'], 0);
        });

        invoke();
        expect(triggerClick).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2_999);
        expect(mocks.toast).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);

        expect(mocks.toast).toHaveBeenCalledTimes(1);
        expect(mocks.toast).toHaveBeenCalledWith(key, undefined, 'warning');
        expect(dispatch).toHaveBeenCalled();
        expect(duplicateMounted).toBe(false);
        vi.advanceTimersByTime(3_000);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
    });

    it('coalesces repeated same-kind presses while the sheet is opening', async () => {
        const trigger = mountTrigger('audio');
        const triggerClick = vi.spyOn(trigger, 'click');

        JC.cycleAudioTrack!();
        JC.cycleAudioTrack!();
        const sheet = mountSheet('audio', 'Audio', ['English', 'Commentary'], 0);
        await flushMutations();

        expect(triggerClick).toHaveBeenCalledTimes(1);
        expect(sheet.clicks[1]).toHaveBeenCalledTimes(1);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
    });

    it('lets the latest cross-kind press win without a stale click or warning', async () => {
        mountTrigger('audio');
        mountTrigger('subtitle');

        JC.cycleAudioTrack!();
        JC.cycleSubtitleTrack!();
        const staleAudio = mountSheet('audio', 'Audio', ['English', 'Commentary'], 0);
        await flushMutations();
        const subtitles = mountSheet('subtitle', 'Subtitles', ['Off', 'English'], 0);
        await flushMutations();

        expect(staleAudio.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(subtitles.clicks[1]).toHaveBeenCalledTimes(1);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(3_000);
        expect(mocks.toast).toHaveBeenCalledTimes(1);
    });

    it('uses the localized trigger title, the newest sheet, and stable secondary-subtitle id', async () => {
        mountTrigger('subtitle', 'Untertitel');
        const stale = mountSheet('subtitle', 'Untertitel', ['Stale current', 'Stale next'], 0);
        const unrelated = mountSheet('audio', 'Tonspuren', ['Deutsch', 'English'], 0);

        JC.cycleSubtitleTrack!();
        const live = mountSheet(
            'subtitle',
            'Untertitel',
            ['Sekundäre Untertitel', 'Deutsch', 'English'],
            1,
            ['secondarysubtitle', 'de', 'en'],
        );
        await flushMutations();

        expect(stale.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(unrelated.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(live.clicks[0]).not.toHaveBeenCalled();
        expect(live.clicks[2]).toHaveBeenCalledTimes(1);
        expect(translate).toHaveBeenCalledWith('toast_subtitle', { subtitle: 'escaped:English' });
    });

    it('cancels silently when an owned target sheet is replaced', async () => {
        const trigger = mountTrigger('audio');
        const original = mountSheet('audio', 'Audio', []);
        const triggerClick = vi.spyOn(trigger, 'click');

        JC.cycleAudioTrack!();
        expect(triggerClick).not.toHaveBeenCalled();
        original.container.remove();
        const replacement = mountSheet('audio', 'Audio', ['Replacement current', 'Replacement next'], 0);
        const replacementDispatch = vi.spyOn(replacement.container, 'dispatchEvent');
        await flushMutations();
        vi.advanceTimersByTime(3_000);

        expect(replacement.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(replacementDispatch).not.toHaveBeenCalled();
        expect(mocks.toast).not.toHaveBeenCalled();
    });

    it('does not orphan readiness resources when a repeat races sheet replacement', async () => {
        mountTrigger('audio');
        const observe = vi.spyOn(MutationObserver.prototype, 'observe');
        const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
        const original = mountSheet('audio', 'Audio', []);

        JC.cycleAudioTrack!();
        expect(vi.getTimerCount()).toBe(1);
        original.container.remove();
        const replacement = mountSheet('audio', 'Audio', ['Replacement current', 'Replacement next'], 0);
        JC.cycleAudioTrack!();

        expect(observe).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await flushMutations();
        vi.advanceTimersByTime(3_000);
        expect(replacement.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(mocks.toast).not.toHaveBeenCalled();
    });

    it('cancels silently when navigation leaves the video route', async () => {
        mountTrigger('audio');
        JC.cycleAudioTrack!();

        window.history.replaceState(null, '', '/web/index.html#/home');
        const late = mountSheet('audio', 'Audio', ['English', 'Commentary'], 0);
        await flushMutations();
        vi.advanceTimersByTime(3_000);

        expect(late.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(mocks.toast).not.toHaveBeenCalled();
    });

    it('cancels silently across an account transition', async () => {
        mountTrigger('subtitle');
        JC.cycleSubtitleTrack!();

        JC.identity.transition('track-server-b', 'track-user-b', 'track-sheet-test');
        const late = mountSheet('subtitle', 'Subtitles', ['Off', 'English'], 0);
        await flushMutations();
        vi.advanceTimersByTime(3_000);

        expect(late.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(mocks.toast).not.toHaveBeenCalled();
    });

    it('cancels silently when the playback feature is disposed', async () => {
        mountTrigger('audio');
        JC.cycleAudioTrack!();
        disposePlayback?.();
        disposePlayback = undefined;

        const late = mountSheet('audio', 'Audio', ['English', 'Commentary'], 0);
        await flushMutations();
        vi.advanceTimersByTime(3_000);

        expect(late.clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
        expect(mocks.toast).not.toHaveBeenCalled();
    });
});
