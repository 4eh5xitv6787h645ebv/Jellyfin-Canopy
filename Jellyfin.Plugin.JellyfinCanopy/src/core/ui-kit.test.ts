// Unit tests for src/core/ui-kit.ts (escapeHtml + CSS injection).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    escapeHtml,
    expandIn,
    injectCss,
    muiIconButton,
    muiMenuItem,
    notify,
    notifyAction,
    queueNotificationAnnouncementForTesting,
    queueTerminalNotificationAnnouncementForTesting,
    removeCss,
    sectionContainer,
    toast
} from './ui-kit';

describe('escapeHtml', () => {
    it('escapes every HTML special character', () => {
        expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`))
            .toBe('&lt;img src=&quot;x&quot; onerror=&#039;alert(1)&#039;&gt;&amp;');
    });

    it('returns plain strings unchanged', () => {
        expect(escapeHtml('The Matrix (1999)')).toBe('The Matrix (1999)');
    });

    it('stringifies non-string values', () => {
        expect(escapeHtml(42)).toBe('42');
        expect(escapeHtml(true)).toBe('true');
    });

    it('turns null and undefined into the empty string', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    it('double-escapes already-escaped input (no entity awareness by design)', () => {
        expect(escapeHtml('&amp;')).toBe('&amp;amp;');
    });

    it('escapes ampersands first so later entities are not corrupted', () => {
        expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
    });
});

describe('injectCss / removeCss', () => {
    it('injects a style element with the given id and content', () => {
        injectCss('jc-test-style', '.a { color: red; }');
        const el = document.getElementById('jc-test-style');
        expect(el?.tagName).toBe('STYLE');
        expect(el?.textContent).toBe('.a { color: red; }');
        removeCss('jc-test-style');
    });

    it('replaces (not duplicates) a style injected under the same id', () => {
        injectCss('jc-test-dedupe', '.a { color: red; }');
        injectCss('jc-test-dedupe', '.a { color: blue; }');
        const matches = document.querySelectorAll('#jc-test-dedupe');
        expect(matches.length).toBe(1);
        expect(matches[0].textContent).toBe('.a { color: blue; }');
        removeCss('jc-test-dedupe');
    });

    it('removeCss returns true when a style was removed, false otherwise', () => {
        injectCss('jc-test-remove', '.a {}');
        expect(removeCss('jc-test-remove')).toBe(true);
        expect(document.getElementById('jc-test-remove')).toBeNull();
        expect(removeCss('jc-test-remove')).toBe(false);
    });
});

describe('muiIconButton', () => {
    it('wears the MUI IconButton classes so the running theme styles it', () => {
        const btn = muiIconButton({ icon: 'casino', title: 'Random' });
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.classList.contains('MuiButtonBase-root')).toBe(true);
        expect(btn.classList.contains('MuiIconButton-root')).toBe(true);
        expect(btn.classList.contains('MuiIconButton-sizeLarge')).toBe(true);
        expect(btn.classList.contains('MuiIconButton-colorInherit')).toBe(true);
        expect(btn.title).toBe('Random');
        expect(btn.getAttribute('aria-label')).toBe('Random');
        const glyph = btn.querySelector('.material-icons');
        expect(glyph?.textContent).toBe('casino');
    });

    it('hardcodes no colour (theming comes from MUI classes / tokens)', () => {
        const css = document.getElementById('jc-ui-kit-css')?.textContent || '';
        // The only colour reference is a --jf-palette token, never a literal.
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
        expect(css).not.toMatch(/\brgb\(/);
        expect(css).toContain('var(--jf-palette-text-secondary');
    });

    it('applies size, id, extra classes and click handler', () => {
        const onClick = vi.fn();
        const btn = muiIconButton({ icon: 'tab', size: 'small', id: 'x', className: 'headerButton', onClick });
        expect(btn.id).toBe('x');
        expect(btn.classList.contains('MuiIconButton-sizeSmall')).toBe(true);
        expect(btn.classList.contains('headerButton')).toBe(true);
        btn.dispatchEvent(new MouseEvent('click'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

describe('muiMenuItem', () => {
    it('builds a MuiMenuItem-root li with optional icon and label', () => {
        const onClick = vi.fn();
        const li = muiMenuItem({ label: 'Settings', icon: 'tune', onClick });
        expect(li.tagName).toBe('LI');
        expect(li.classList.contains('MuiMenuItem-root')).toBe(true);
        expect(li.getAttribute('role')).toBe('menuitem');
        expect(li.querySelector('.MuiListItemIcon-root .material-icons')?.textContent).toBe('tune');
        expect(li.querySelector('.MuiTypography-root')?.textContent).toBe('Settings');
        li.dispatchEvent(new MouseEvent('click'));
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('omits the icon wrapper when no icon is given', () => {
        const li = muiMenuItem({ label: 'Plain' });
        expect(li.querySelector('.MuiListItemIcon-root')).toBeNull();
    });
});

describe('sectionContainer', () => {
    it('builds a .verticalSection with a title and accepts appended content', () => {
        const section = sectionContainer({ title: 'Enhanced', id: 'sec' });
        expect(section.classList.contains('verticalSection')).toBe(true);
        expect(section.id).toBe('sec');
        const title = section.querySelector('.sectionTitle');
        expect(title?.textContent).toBe('Enhanced');
        const child = document.createElement('div');
        section.appendChild(child);
        expect(section.lastElementChild).toBe(child);
    });

    it('omits the heading when no title is given', () => {
        const section = sectionContainer();
        expect(section.querySelector('.sectionTitle')).toBeNull();
    });
});

describe('expandIn', () => {
    it('is a no-op when instant is set (pre-paint injection)', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        expandIn(el, { instant: true });
        expect(el.style.width).toBe('');
        expect(el.style.overflow).toBe('');
        expect(el.style.transition).toBe('');
        el.remove();
    });

    it('is a no-op for detached or zero-width elements', () => {
        const detached = document.createElement('div');
        expandIn(detached);
        expect(detached.style.width).toBe('');

        // jsdom has no layout, so an attached element measures 0 wide — the
        // guard must leave it untouched rather than pinning width to 0.
        const attached = document.createElement('div');
        document.body.appendChild(attached);
        expandIn(attached);
        expect(attached.style.width).toBe('');
        expect(attached.style.overflow).toBe('');
        attached.remove();
    });

    it('collapses to width 0 then transitions to the measured natural width', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        el.getBoundingClientRect = () => ({ width: 48 } as DOMRect);

        expandIn(el);
        expect(el.style.width).toBe('48px');
        expect(el.style.overflow).toBe('hidden');
        expect(el.style.transition).toContain('width 150ms');
        el.remove();
    });

    it('removes every inline style once the transition ends', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        el.getBoundingClientRect = () => ({ width: 48 } as DOMRect);

        expandIn(el, { durationMs: 20 });
        el.dispatchEvent(new Event('transitionend'));
        expect(el.style.width).toBe('');
        expect(el.style.overflow).toBe('');
        expect(el.style.transition).toBe('');
        el.remove();
    });

    it('falls back to the timeout when transitionend never fires', async () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        el.getBoundingClientRect = () => ({ width: 48 } as DOMRect);

        expandIn(el, { durationMs: 10 });
        await new Promise((r) => setTimeout(r, 150));
        expect(el.style.width).toBe('');
        expect(el.style.transition).toBe('');
        el.remove();
    });
});

describe('toast scheduling', () => {
    afterEach(() => {
        history.pushState({}, '', `#notification-test-cleanup-${Date.now()}-${Math.random()}`);
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.querySelectorAll('.jellyfin-canopy-toast, #jc-notification-owner').forEach((node) => node.remove());
    });

    it('announces legacy toast text once through one document-life polite live region', () => {
        vi.useFakeTimers();
        toast('<strong>Saved</strong>', 1_000);

        expect(document.querySelectorAll('#jc-notification-owner')).toHaveLength(1);
        const visual = document.querySelector('.jellyfin-canopy-toast');
        expect(visual?.getAttribute('aria-live')).toBe('off');
        expect(visual?.getAttribute('role')).toBeNull();
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('Saved');
        expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    });

    it('coalesces byte-equivalent pending legacy announcements without dropping either visual event', () => {
        vi.useFakeTimers();
        toast('<strong>Saved</strong>', 1_000);
        toast('<strong>Saved</strong>', 1_000);

        expect(document.querySelectorAll('.jellyfin-canopy-toast')).toHaveLength(2);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('Saved');
        vi.advanceTimersByTime(550);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');
    });

    it('adopts cards from duplicate owners and stacks into one stable document owner', () => {
        vi.useFakeTimers();
        notify({ message: 'Owned card', persistent: true });
        const owner = document.getElementById('jc-notification-owner')!;
        const duplicateStack = document.createElement('div');
        duplicateStack.className = 'jc-notification-stack';
        const stackCard = document.createElement('div');
        stackCard.className = 'jc-notification';
        stackCard.dataset.testCard = 'stack';
        duplicateStack.appendChild(stackCard);
        owner.appendChild(duplicateStack);
        const duplicateOwner = document.createElement('div');
        duplicateOwner.id = 'jc-notification-owner';
        const ownerCard = document.createElement('div');
        ownerCard.className = 'jc-notification';
        ownerCard.dataset.testCard = 'owner';
        duplicateOwner.appendChild(ownerCard);
        document.body.appendChild(duplicateOwner);

        notify({ message: 'Triggers adoption', persistent: true });

        expect(document.querySelectorAll('#jc-notification-owner')).toHaveLength(1);
        expect(owner.querySelectorAll(':scope > .jc-notification-stack')).toHaveLength(1);
        expect(owner.querySelector('[data-test-card="stack"]')).toBe(stackCard);
        expect(owner.querySelector('[data-test-card="owner"]')).toBe(ownerCard);
    });

    it('shows, hides, and removes the toast on deterministic timers', () => {
        vi.useFakeTimers();
        toast('<strong>Saved</strong>', 1_000);

        const node = document.querySelector<HTMLElement>('.jellyfin-canopy-toast');
        expect(node).not.toBeNull();
        expect(node?.innerHTML).toBe('<strong>Saved</strong>');
        expect(node?.style.transform).toBe('translateX(100%)');

        vi.advanceTimersByTime(9);
        expect(node?.style.transform).toBe('translateX(100%)');

        vi.advanceTimersByTime(1);
        expect(node?.style.transform).toBe('translateX(0)');

        vi.advanceTimersByTime(990);
        expect(node?.style.transform).toBe('translateX(100%)');
        expect(node?.isConnected).toBe(true);

        vi.advanceTimersByTime(299);
        expect(node?.isConnected).toBe(true);

        vi.advanceTimersByTime(1);
        expect(node?.isConnected).toBe(false);
    });

    it('serializes rapid announcements without losing or duplicating text', () => {
        vi.useFakeTimers();
        notify({ message: 'First', duration: 2_000 });
        notify({ message: 'Second', duration: 2_000 });
        notify({ message: 'Third', duration: 2_000 });

        const polite = document.querySelector<HTMLElement>('[data-jc-announcer="polite"]')!;
        expect(polite.textContent).toBe('First');
        vi.advanceTimersByTime(500);
        expect(polite.textContent).toBe('');
        vi.advanceTimersByTime(50);
        expect(polite.textContent).toBe('Second');
        vi.advanceTimersByTime(500);
        expect(polite.textContent).toBe('');
        vi.advanceTimersByTime(50);
        expect(polite.textContent).toBe('Third');
        vi.advanceTimersByTime(500);
        expect(polite.textContent).toBe('');
        expect(document.querySelectorAll('#jc-notification-owner')).toHaveLength(1);
        expect(document.querySelectorAll('.jc-notification')).toHaveLength(3);
    });

    it('retires the announcement queue if its browser realm disappears between dwell and gap', () => {
        vi.useFakeTimers();
        queueNotificationAnnouncementForTesting('Active before teardown', 'info', 'active-before-teardown');
        queueNotificationAnnouncementForTesting('Pending before teardown', 'info', 'pending-before-teardown');
        const runtime = Reflect.get(
            window,
            Symbol.for('JellyfinCanopy.notificationRuntime.v1')
        ) as {
            announcements: unknown[];
            announcementTimer: number | null;
            announcementActive: boolean;
            announcementInGap: boolean;
            activeAnnouncementKey: string | null;
            activeAnnouncementAdmission: string | null;
        };
        expect(runtime.announcementActive).toBe(true);
        expect(runtime.announcements).toHaveLength(1);

        let callbackError: unknown;
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('document', undefined);
        try {
            vi.advanceTimersByTime(500);
        } catch (error) {
            callbackError = error;
        } finally {
            vi.unstubAllGlobals();
        }

        expect(callbackError).toBeUndefined();
        expect(runtime.announcements).toHaveLength(0);
        expect(runtime.announcementTimer).toBeNull();
        expect(runtime.announcementActive).toBe(false);
        expect(runtime.announcementInGap).toBe(false);
        expect(runtime.activeAnnouncementKey).toBeNull();
        expect(runtime.activeAnnouncementAdmission).toBeNull();

        expect(queueNotificationAnnouncementForTesting(
            'Recovered after teardown',
            'info',
            'recovered-after-teardown'
        )).toBe('queued');
        expect(runtime.announcementActive).toBe(true);
    });

    it('coalesces an explicit duplicate key in first-seen order', () => {
        vi.useFakeTimers();
        notify({ message: 'First copy', duration: 2_000, dedupeKey: 'same-event' });
        notify({ message: 'Duplicate copy', duration: 2_000, dedupeKey: 'same-event' });
        notify({ message: 'Distinct', duration: 2_000, dedupeKey: 'other-event' });

        const polite = document.querySelector<HTMLElement>('[data-jc-announcer="polite"]')!;
        expect(polite.textContent).toBe('First copy');
        vi.advanceTimersByTime(500);
        expect(polite.textContent).toBe('');
        vi.advanceTimersByTime(50);
        expect(polite.textContent).toBe('Distinct');
        vi.advanceTimersByTime(500);
        expect(polite.textContent).toBe('');
    });

    it('reserves bounded outcome capacity and rejects the 33rd pending primary message explicitly', () => {
        vi.useFakeTimers();
        for (let index = 0; index < 32; index += 1) {
            queueNotificationAnnouncementForTesting(`Message ${index}`, 'info', `message-${index}`);
        }

        expect(() => notify({
            message: 'Overflow',
            persistent: true,
            dedupeKey: 'overflow',
        })).toThrow(/backpressure/i);

        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => toast('Legacy overflow')).not.toThrow();
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Legacy toast rejected'),
            expect.objectContaining({ name: 'NotificationBackpressureError' })
        );

        history.pushState({}, '', `#notification-overflow-cleanup-${Date.now()}`);
    });

    it('bounds visible cards even when explicit announcement keys coalesce', () => {
        vi.useFakeTimers();
        for (let index = 0; index < 32; index += 1) {
            notify({
                message: `Visible ${index}`,
                persistent: true,
                dedupeKey: 'one-spoken-event',
            });
        }

        expect(document.querySelectorAll('.jc-notification')).toHaveLength(32);
        expect(() => notify({
            message: 'Visible overflow',
            persistent: true,
            dedupeKey: 'one-spoken-event',
        })).toThrow(/notifications backpressure/i);
        expect(document.querySelectorAll('.jc-notification')).toHaveLength(32);

        history.pushState({}, '', `#notification-card-overflow-cleanup-${Date.now()}`);
    });

    it('keeps reserved terminal capacity available when the primary queue is saturated', async () => {
        vi.useFakeTimers();
        const handle = notifyAction({
            message: 'Needs Undo',
            persistent: true,
            actionLabel: 'Undo',
            onAction: () => { throw new Error('write failed'); },
            actionErrorAnnouncement: 'Undo was not saved. Try again.',
        });
        for (let index = 0; index < 31; index += 1) {
            queueNotificationAnnouncementForTesting(`Primary ${index}`, 'info', `primary-${index}`);
        }

        handle.element.querySelector<HTMLButtonElement>('button')!.click();
        await Promise.resolve();
        expect(handle.element.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
        vi.advanceTimersByTime(550);
        expect(document.querySelector('[data-jc-announcer="assertive"]')?.textContent)
            .toBe('Undo was not saved. Try again.');

        history.pushState({}, '', `#notification-terminal-reserve-cleanup-${Date.now()}`);
    });

    it('starts an action expiry only after its queued availability event is presented', () => {
        vi.useFakeTimers();
        for (let index = 0; index < 31; index += 1) {
            queueNotificationAnnouncementForTesting(`Ahead ${index}`, 'info', `ahead-${index}`);
        }
        const action = vi.fn();
        const handle = notifyAction({
            message: 'Queued item hidden',
            actionAvailableAnnouncement: 'Queued item hidden. Undo is available.',
            duration: 8_000,
            actionLabel: 'Undo',
            onAction: action,
        });

        vi.advanceTimersByTime(17_049);
        expect(handle.element.isConnected).toBe(true);
        expect(handle.element.style.transform).toBe('translateX(0)');
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');

        vi.advanceTimersByTime(1);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent)
            .toBe('Queued item hidden. Undo is available.');
        vi.advanceTimersByTime(7_999);
        expect(handle.element.isConnected).toBe(true);
        expect(handle.element.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(1);
        expect(handle.element.style.transform).toBe('translateX(100%)');
        expect(action).not.toHaveBeenCalled();
    });

    it('keeps a terminal-saturation completion polite and readable for a full dwell', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const dismissed = vi.fn();
        const handle = notifyAction({
            message: 'Action ready',
            actionAvailableAnnouncement: 'Action ready. Resolve is available.',
            persistent: true,
            actionLabel: 'Resolve',
            onAction: vi.fn(),
            actionAnnouncement: 'Action completed',
            onDismiss: dismissed,
        });
        for (let index = 0; index < 95; index += 1) {
            queueTerminalNotificationAnnouncementForTesting(
                `Terminal ${index}`,
                'success',
                `terminal-${index}`
            );
        }

        handle.element.querySelector<HTMLButtonElement>('button')!.click();
        await Promise.resolve();
        await Promise.resolve();

        const status = handle.element.querySelector<HTMLElement>('.jc-notification-action-status')!;
        expect(status.textContent).toBe('Action completed');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.getAttribute('aria-atomic')).toBe('true');
        expect(handle.element.isConnected).toBe(true);
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Could not queue action completion'),
            expect.objectContaining({ name: 'NotificationBackpressureError' })
        );

        vi.advanceTimersByTime(2_999);
        expect(handle.element.isConnected).toBe(true);
        expect(dismissed).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(handle.element.isConnected).toBe(false);
        expect(dismissed).toHaveBeenCalledOnce();
        expect(dismissed).toHaveBeenCalledWith('action');
    });

    it('maps urgent severity to the assertive lane and renders typed text safely', () => {
        vi.useFakeTimers();
        const handle = notify({ message: '<img src=x onerror=alert(1)> Failed', severity: 'error' });

        expect(handle.element.textContent).toBe('<img src=x onerror=alert(1)> Failed');
        expect(handle.element.querySelector('img')).toBeNull();
        expect(handle.element.getAttribute('aria-live')).toBe('off');
        expect(document.querySelector('[data-jc-announcer="assertive"]')?.textContent)
            .toBe('<img src=x onerror=alert(1)> Failed');
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');
    });

    it('rejects typed notices without accessible message or action text before admission', () => {
        vi.useFakeTimers();
        expect(() => notify({ message: '   ' })).toThrow(/accessible text/i);
        expect(() => notifyAction({
            message: 'Action available',
            actionLabel: ' ',
            onAction: vi.fn(),
        })).toThrow(/accessible label/i);
        expect(document.querySelectorAll('.jc-notification')).toHaveLength(0);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent ?? '').toBe('');
    });

    it('lets audited legacy producers opt into assertive urgency without changing their HTML card', () => {
        vi.useFakeTimers();
        toast('<span aria-hidden="true">!</span><strong>Save failed</strong>', 2_000, 'error');

        const visual = document.querySelector<HTMLElement>('.jellyfin-canopy-toast')!;
        expect(visual.innerHTML).toBe('<span aria-hidden="true">!</span><strong>Save failed</strong>');
        expect(visual.dataset.jcNotificationSeverity).toBe('error');
        expect(document.querySelector('[data-jc-announcer="assertive"]')?.textContent)
            .toBe('Save failed');
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');
    });

    it('moves urgent work ahead of queued polite announcements without dropping either', () => {
        vi.useFakeTimers();
        notify({ message: 'First', duration: 2_000 });
        notify({ message: 'Second', duration: 2_000 });
        notify({ message: 'Urgent', severity: 'error', duration: 2_000 });
        const polite = document.querySelector<HTMLElement>('[data-jc-announcer="polite"]')!;
        const assertive = document.querySelector<HTMLElement>('[data-jc-announcer="assertive"]')!;

        expect(polite.textContent).toBe('First');
        vi.advanceTimersByTime(500);
        expect(assertive.textContent).toBe('');
        vi.advanceTimersByTime(50);
        expect(assertive.textContent).toBe('Urgent');
        vi.advanceTimersByTime(500);
        expect(polite.textContent).toBe('');
        vi.advanceTimersByTime(50);
        expect(polite.textContent).toBe('Second');
    });

    it('runs an action and terminal callback exactly once under repeated input', async () => {
        vi.useFakeTimers();
        const action = vi.fn();
        const dismissed = vi.fn();
        const handle = notifyAction({
            message: 'Hidden A',
            duration: 1_000,
            actionLabel: 'Undo',
            onAction: action,
            actionAnnouncement: 'A restored',
            onDismiss: dismissed,
        });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;

        button.click();
        button.click();
        await Promise.resolve();
        vi.advanceTimersByTime(550);
        vi.advanceTimersByTime(3_000);
        handle.dismiss();
        vi.advanceTimersByTime(300);

        expect(action).toHaveBeenCalledTimes(1);
        expect(dismissed).toHaveBeenCalledTimes(1);
        expect(dismissed).toHaveBeenCalledWith('action');
    });

    it('keeps an async action pending and announces completion only after it resolves', async () => {
        vi.useFakeTimers();
        let resolveAction!: () => void;
        const action = vi.fn(() => new Promise<void>((resolve) => {
            resolveAction = resolve;
        }));
        const handle = notifyAction({
            message: 'Saving Undo',
            duration: 1_000,
            actionLabel: 'Undo',
            onAction: action,
            actionAnnouncement: 'Undo saved',
        });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;

        button.click();
        vi.advanceTimersByTime(5_000);
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(handle.element.isConnected).toBe(true);
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');

        resolveAction();
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('Undo saved');
        expect(button.hasAttribute('aria-busy')).toBe(false);
        expect(handle.element.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(2_999);
        expect(handle.element.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(1);
        expect(handle.element.style.transform).toBe('translateX(100%)');
        expect(action).toHaveBeenCalledOnce();
    });

    it('announces a synchronous action failure and restores the same action for retry', async () => {
        vi.useFakeTimers();
        const action = vi.fn()
            .mockImplementationOnce(() => { throw new Error('first attempt failed'); })
            .mockImplementationOnce(() => undefined);
        const handle = notifyAction({
            message: 'Hidden A',
            persistent: true,
            actionLabel: 'Undo',
            onAction: action,
            actionErrorAnnouncement: 'Undo failed. Try again.',
        });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;

        button.click();
        await Promise.resolve();
        expect(handle.element.isConnected).toBe(true);
        expect(button.disabled).toBe(false);
        vi.advanceTimersByTime(500);
        vi.advanceTimersByTime(50);
        expect(document.querySelector('[data-jc-announcer="assertive"]')?.textContent)
            .toBe('Undo failed. Try again.');
        expect(handle.element.querySelector('.jc-notification-action-status')?.textContent)
            .toBe('Undo failed. Try again.');

        button.click();
        button.click();
        await Promise.resolve();
        expect(action).toHaveBeenCalledTimes(2);
    });

    it('announces a rejected async action and restores retry without an unhandled rejection', async () => {
        vi.useFakeTimers();
        const action = vi.fn().mockRejectedValue(new Error('network failed'));
        const handle = notifyAction({
            message: 'Needs retry',
            persistent: true,
            actionLabel: 'Retry',
            onAction: action,
            actionErrorAnnouncement: 'Retry failed. Try again.',
        });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;

        button.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(handle.element.isConnected).toBe(true);
        expect(button.disabled).toBe(false);
        button.click();
        await Promise.resolve();
        expect(action).toHaveBeenCalledTimes(2);
    });

    it('gives a restored action a complete fresh retry window after a slow rejection', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        let rejectFirst!: (error: Error) => void;
        const action = vi.fn(() => new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
        }));
        const dismissed = vi.fn();
        const handle = notifyAction({
            message: 'Hidden A',
            duration: 1_000,
            actionLabel: 'Undo',
            onAction: action,
            actionErrorAnnouncement: 'Undo failed. Try again.',
            onDismiss: dismissed,
        });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;

        vi.advanceTimersByTime(600);
        button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        button.click();
        button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
        handle.element.dispatchEvent(new Event('pointerleave'));
        vi.advanceTimersByTime(2_000);

        expect(handle.element.isConnected).toBe(true);
        expect(button.disabled).toBe(true);

        rejectFirst(new Error('slow failure'));
        await Promise.resolve();
        await Promise.resolve();

        expect(handle.element.isConnected).toBe(true);
        expect(button.disabled).toBe(false);
        expect(document.querySelector('[data-jc-announcer="assertive"]')?.textContent)
            .toBe('Undo failed. Try again.');

        vi.advanceTimersByTime(999);
        expect(handle.element.isConnected).toBe(true);
        expect(handle.element.style.transform).toBe('translateX(0)');
        expect(button.disabled).toBe(false);
        expect(dismissed).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(handle.element.style.transform).toBe('translateX(100%)');
        expect(dismissed).toHaveBeenCalledOnce();
        expect(dismissed).toHaveBeenCalledWith('timeout');
        vi.advanceTimersByTime(300);
        expect(handle.element.isConnected).toBe(false);
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('pauses expiry while pointer or keyboard focus remains within the notice', () => {
        vi.useFakeTimers();
        const handle = notifyAction({
            message: 'Hidden A',
            duration: 1_000,
            actionLabel: 'Undo',
            onAction: vi.fn(),
        });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;
        vi.advanceTimersByTime(400);
        handle.element.dispatchEvent(new Event('pointerenter'));
        button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        vi.advanceTimersByTime(2_000);
        expect(handle.element.isConnected).toBe(true);

        handle.element.dispatchEvent(new Event('pointerleave'));
        vi.advanceTimersByTime(2_000);
        expect(handle.element.isConnected).toBe(true);

        button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
        vi.advanceTimersByTime(599);
        expect(handle.element.style.transform).toBe('translateX(0)');
        vi.advanceTimersByTime(1);
        expect(handle.element.style.transform).toBe('translateX(100%)');
    });

    it('does not steal focus when an actionable notification is presented', () => {
        vi.useFakeTimers();
        const prior = document.createElement('button');
        document.body.appendChild(prior);
        prior.focus();

        notifyAction({ message: 'Hidden A', actionLabel: 'Undo', onAction: vi.fn() });

        expect(document.activeElement).toBe(prior);
        prior.remove();
    });

    it('returns focus to the prior connected control when a focused notice is removed', () => {
        vi.useFakeTimers();
        const prior = document.createElement('button');
        document.body.appendChild(prior);
        prior.focus();
        const handle = notifyAction({ message: 'Hidden A', actionLabel: 'Undo', onAction: vi.fn() });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;
        button.focus();
        expect(document.activeElement).toBe(button);

        handle.dismiss();
        vi.advanceTimersByTime(300);

        expect(document.activeElement).toBe(prior);
        expect(handle.element.isConnected).toBe(false);
        prior.remove();
    });

    it('blurs a focused action safely when its prior focus target is gone', () => {
        vi.useFakeTimers();
        const handle = notifyAction({ message: 'Hidden A', actionLabel: 'Undo', onAction: vi.fn() });
        const button = handle.element.querySelector<HTMLButtonElement>('button')!;
        button.focus();
        handle.dismiss();
        vi.advanceTimersByTime(300);

        expect(document.activeElement).not.toBe(button);
        expect(handle.element.isConnected).toBe(false);
    });

    it('isolates a throwing terminal callback while still removing the notice', () => {
        vi.useFakeTimers();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const handle = notify({
            message: 'Callback isolation',
            onDismiss: () => { throw new Error('consumer callback failed'); },
        });

        expect(() => handle.dismiss()).not.toThrow();
        vi.advanceTimersByTime(300);

        expect(handle.element.isConnected).toBe(false);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining('dismiss callback failed'),
            expect.any(Error)
        );
    });

    it('supports an explicitly persistent actionable notification', () => {
        vi.useFakeTimers();
        const handle = notifyAction({
            message: 'Needs a decision',
            persistent: true,
            actionLabel: 'Resolve',
            onAction: vi.fn(),
        });

        vi.advanceTimersByTime(60_000);
        expect(handle.element.isConnected).toBe(true);
        handle.dismiss();
        vi.advanceTimersByTime(300);
        expect(handle.element.isConnected).toBe(false);
    });

    it('skips enter and removal animation when reduced motion is requested', () => {
        vi.useFakeTimers();
        vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
        const handle = notify({ message: 'Saved', duration: 1_000 });

        expect(handle.element.style.transition).toBe('none');
        expect(handle.element.style.transform).toBe('translateX(0)');
        handle.dismiss();
        expect(handle.element.isConnected).toBe(false);
    });

    it('tears down route-owned notices and leaves retained actions inert', () => {
        vi.useFakeTimers();
        const prior = document.createElement('button');
        document.body.appendChild(prior);
        prior.focus();
        const action = vi.fn();
        const dismissed = vi.fn();
        const handle = notifyAction({
            message: 'Hidden A',
            duration: 8_000,
            actionLabel: 'Undo',
            onAction: action,
            onDismiss: dismissed,
        });
        const retainedButton = handle.element.querySelector<HTMLButtonElement>('button')!;
        retainedButton.focus();
        const priorFocus = vi.spyOn(prior, 'focus');

        history.pushState({}, '', `#notification-test-${Date.now()}`);

        expect(handle.element.isConnected).toBe(false);
        expect(priorFocus).not.toHaveBeenCalled();
        expect(document.activeElement).not.toBe(prior);
        expect(document.activeElement).not.toBe(retainedButton);
        retainedButton.click();
        vi.runOnlyPendingTimers();
        expect(action).not.toHaveBeenCalled();
        expect(dismissed).toHaveBeenCalledTimes(1);
        expect(dismissed).toHaveBeenCalledWith('navigation');
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');
        prior.remove();
    });

    it('tears down identity-owned notices synchronously and leaves retained actions inert', () => {
        vi.useFakeTimers();
        const prior = document.createElement('button');
        document.body.appendChild(prior);
        prior.focus();
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
        const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
        const action = vi.fn();
        const dismissed = vi.fn();
        const handle = notifyAction({
            message: 'Old account action',
            persistent: true,
            actionLabel: 'Undo',
            onAction: action,
            onDismiss: dismissed,
        });
        expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
        const notificationTimerIds: number[] = [];
        for (const result of setTimeoutSpy.mock.results) {
            notificationTimerIds.push(result.value as number);
        }
        const retainedButton = handle.element.querySelector<HTMLButtonElement>('button')!;
        retainedButton.focus();
        const priorFocus = vi.spyOn(prior, 'focus');

        const nextEpoch = window.JellyfinCanopy.identity.getEpoch() + 1;
        window.JellyfinCanopy.identity.transition(
            `notification-server-${nextEpoch}`,
            `notification-user-${nextEpoch}`,
            'notification-test-switch'
        );

        expect(handle.element.isConnected).toBe(false);
        expect(priorFocus).not.toHaveBeenCalled();
        expect(document.activeElement).not.toBe(prior);
        expect(document.activeElement).not.toBe(retainedButton);
        expect(dismissed).toHaveBeenCalledWith('identity');
        retainedButton.click();
        expect(action).not.toHaveBeenCalled();
        for (const timerId of notificationTimerIds) {
            expect(clearTimeoutSpy.mock.calls.some(([cleared]) => cleared === timerId)).toBe(true);
        }
        prior.remove();
    });

    it('suppresses a late async completion after route teardown', async () => {
        vi.useFakeTimers();
        let resolveAction!: () => void;
        const action = vi.fn(() => new Promise<void>((resolve) => {
            resolveAction = resolve;
        }));
        const dismissed = vi.fn();
        const handle = notifyAction({
            message: 'Pending route action',
            persistent: true,
            actionLabel: 'Run',
            onAction: action,
            actionAnnouncement: 'Should not be announced',
            onDismiss: dismissed,
        });
        handle.element.querySelector<HTMLButtonElement>('button')!.click();

        history.pushState({}, '', `#notification-pending-route-${Date.now()}`);
        resolveAction();
        await Promise.resolve();
        await Promise.resolve();

        expect(handle.element.isConnected).toBe(false);
        expect(dismissed).toHaveBeenCalledOnce();
        expect(dismissed).toHaveBeenCalledWith('navigation');
        expect(document.querySelector('[data-jc-announcer="polite"]')?.textContent).toBe('');
    });
});
