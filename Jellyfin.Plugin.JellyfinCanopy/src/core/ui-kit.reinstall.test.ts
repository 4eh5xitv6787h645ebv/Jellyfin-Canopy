import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';

describe('notification document owner reinstall', () => {
    const originalEvents = window.Events;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        window.Events = {
            on: vi.fn(),
            off: vi.fn(),
            trigger: vi.fn(),
        };
    });

    afterEach(() => {
        window.Events = originalEvents;
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    it('reuses one queue, lifecycle registration, owner, and teardown across module reevaluation', async () => {
        const registerReset = vi.spyOn(JC.identity, 'registerReset');
        const action = vi.fn();
        const dismissed = vi.fn();
        const firstGraph = await import('./ui-kit');
        const first = firstGraph.notifyAction({
            message: 'First graph action',
            persistent: true,
            actionLabel: 'Run first',
            onAction: action,
            onDismiss: dismissed,
        });
        const retainedFirstButton = first.element.querySelector<HTMLButtonElement>('button')!;
        firstGraph.queueNotificationAnnouncementForTesting(
            'Retained pre-callback announcement',
            'info',
            'retained-pre-callback'
        );
        type RetainedAnnouncement = {
            message: string;
            urgency: 'polite' | 'assertive';
            dedupeKey: string | null;
            admission: 'primary' | 'terminal';
            presentedCallbacks?: Array<() => void>;
        };
        const runtime = Reflect.get(
            window,
            Symbol.for('JellyfinCanopy.notificationRuntime.v1')
        ) as {
            announcements: RetainedAnnouncement[];
            announcementTimer: number | null;
            announcementActive: boolean;
            announcementInGap: boolean;
            activeAnnouncementKey: string | null;
            activeAnnouncementAdmission: 'primary' | 'terminal' | null;
        };
        const retainedPreCallback = runtime.announcements
            .find((announcement) => announcement.dedupeKey === 'retained-pre-callback')!;
        delete retainedPreCallback.presentedCallbacks;

        // Emulate the pre-callback v1 graph retaining timer ownership. Its
        // closed-over drain can present later events but cannot run their new
        // presentedCallbacks, so a repaired graph must cancel and re-arm it.
        const retireThroughLegacyClosure = (lane: HTMLElement): void => {
            runtime.announcementTimer = window.setTimeout(() => {
                lane.textContent = '';
                runtime.announcementActive = false;
                runtime.announcementInGap = true;
                runtime.activeAnnouncementKey = null;
                runtime.activeAnnouncementAdmission = null;
                runtime.announcementTimer = window.setTimeout(() => {
                    runtime.announcementTimer = null;
                    runtime.announcementInGap = false;
                    legacyDrainWithoutCallbacks();
                }, 50);
            }, 500);
        };
        const legacyDrainWithoutCallbacks = (): void => {
            if (runtime.announcementActive || runtime.announcementInGap) return;
            const next = runtime.announcements.shift();
            if (!next) return;
            const lane = document.querySelector<HTMLElement>(`[data-jc-announcer="${next.urgency}"]`)!;
            lane.textContent = next.message;
            runtime.announcementActive = true;
            runtime.activeAnnouncementKey = next.dedupeKey;
            runtime.activeAnnouncementAdmission = next.admission;
            retireThroughLegacyClosure(lane);
        };
        clearTimeout(runtime.announcementTimer!);
        retireThroughLegacyClosure(
            document.querySelector<HTMLElement>('[data-jc-announcer="polite"]')!
        );

        vi.resetModules();
        const secondGraph = await import('./ui-kit');
        const second = secondGraph.notifyAction({
            message: 'Second graph action',
            duration: 8_000,
            actionLabel: 'Run second',
            actionAvailableAnnouncement: 'Second graph action available',
            onAction: action,
            onDismiss: dismissed,
        });
        const retainedSecondButton = second.element.querySelector<HTMLButtonElement>('button')!;

        expect(registerReset).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('#jc-notification-owner')).toHaveLength(1);
        expect(document.querySelectorAll('.jc-notification')).toHaveLength(2);
        expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
        expect(document.querySelectorAll('[aria-live="assertive"]')).toHaveLength(1);

        vi.advanceTimersByTime(550);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent)
            .toBe('Retained pre-callback announcement');
        vi.advanceTimersByTime(550);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent)
            .toBe('Second graph action available');
        vi.advanceTimersByTime(7_999);
        expect(second.element.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(1);
        expect(second.element.style.transform).toBe('translateX(100%)');

        history.pushState({}, '', `#notification-reinstall-${Date.now()}`);

        expect(document.querySelectorAll('.jc-notification')).toHaveLength(0);
        expect(dismissed).toHaveBeenCalledTimes(2);
        expect(dismissed).toHaveBeenNthCalledWith(1, 'timeout');
        expect(dismissed).toHaveBeenNthCalledWith(2, 'navigation');
        retainedFirstButton.click();
        retainedSecondButton.click();
        expect(action).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
