// src/enhanced/spoiler-guard/snooze.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    classifySnoozeExpiry, isDisableSnoozed, setDisableSnooze,
    snoozeStorageKey, SNOOZE_MS, MAX_SNOOZE_FUTURE_MS,
} from './snooze';
import { JC } from '../../globals';

const UID = 'test-user-id'; // the setup.ts ApiClient stub returns this

afterEach(() => {
    JC.identity.transition('test-server-id', UID, 'snooze-test-cleanup');
    localStorage.clear();
    vi.restoreAllMocks();
});

describe('spoiler-guard/snooze', () => {
    describe('classifySnoozeExpiry', () => {
        const now = 1_000_000;
        it('active while now < expiry (within cap)', () => {
            expect(classifySnoozeExpiry(now + SNOOZE_MS, now)).toBe('active');
        });
        it('expired once now passes expiry', () => {
            expect(classifySnoozeExpiry(now - 1, now)).toBe('expired');
        });
        it('invalid for non-finite / non-positive', () => {
            expect(classifySnoozeExpiry(NaN, now)).toBe('invalid');
            expect(classifySnoozeExpiry(0, now)).toBe('invalid');
            expect(classifySnoozeExpiry(-5, now)).toBe('invalid');
        });
        it('invalid for an absurd future expiry (corruption / clock skew)', () => {
            expect(classifySnoozeExpiry(now + MAX_SNOOZE_FUTURE_MS + 1, now)).toBe('invalid');
        });
    });

    describe('isDisableSnoozed', () => {
        it('is false when nothing stored', () => {
            expect(isDisableSnoozed()).toBe(false);
        });
        it('is true for a live snooze and false + purged for an expired one', () => {
            localStorage.setItem(snoozeStorageKey(UID), String(Date.now() + SNOOZE_MS));
            expect(isDisableSnoozed()).toBe(true);

            localStorage.setItem(snoozeStorageKey(UID), String(Date.now() - 1));
            expect(isDisableSnoozed()).toBe(false);
            expect(localStorage.getItem(snoozeStorageKey(UID))).toBeNull();
        });
        it('rejects and purges a corrupt / absurd-future value', () => {
            localStorage.setItem(snoozeStorageKey(UID), 'not-a-number');
            expect(isDisableSnoozed()).toBe(false);
            expect(localStorage.getItem(snoozeStorageKey(UID))).toBeNull();

            localStorage.setItem(snoozeStorageKey(UID), String(Date.now() + MAX_SNOOZE_FUTURE_MS + 5000));
            expect(isDisableSnoozed()).toBe(false);
            expect(localStorage.getItem(snoozeStorageKey(UID))).toBeNull();
        });
    });

    describe('setDisableSnooze', () => {
        it('persists a ~15-minute expiry for the current user', () => {
            const before = Date.now();
            setDisableSnooze();
            const stored = Number(localStorage.getItem(snoozeStorageKey(UID)));
            expect(stored).toBeGreaterThanOrEqual(before + SNOOZE_MS - 50);
            expect(stored).toBeLessThanOrEqual(Date.now() + SNOOZE_MS + 50);
        });

        it('does not replay a snooze for the same user id on another server', () => {
            setDisableSnooze();
            expect(isDisableSnoozed()).toBe(true);

            JC.identity.transition('other-server', UID, 'server-switch');
            expect(isDisableSnoozed()).toBe(false);
        });
    });
});
