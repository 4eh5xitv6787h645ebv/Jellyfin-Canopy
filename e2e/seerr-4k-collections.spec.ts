// Feature guard: Seerr 4K requests are gated on the Seerr server's real 4K
// capability AND the signed-in user's 4K permission — not on the JC admin toggle
// alone. This spec drives the booted plugin's own gate (canRequest4k) and the
// user-status endpoint against the LIVE server for both an admin and a non-admin
// session, and proves that with the admin toggle forced ON the 4K option still
// stays hidden unless the server actually reports the capability for that user.
//
// It also asserts the collection request surface (showCollectionRequestModal)
// is present, and that the whole flow produces no runtime errors.
import { test, expect, loginAs, assertNoRuntimeErrors, type Role } from './fixtures/auth';
import { seerrReady } from './fixtures/seerr';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SEERR_OFF = 'Seerr not configured — set SEERR_* at seed time to run';

interface UserStatus {
    active?: boolean;
    userFound?: boolean;
    reason?: string;
    movie4kEnabled?: boolean;
    series4kEnabled?: boolean;
    canRequest4kMovie?: boolean;
    canRequest4kTv?: boolean;
}

async function fetchUserStatus(page: any): Promise<UserStatus> {
    return page.evaluate(async () => {
        const api = (window as any).ApiClient;
        return api.getJSON(api.getUrl('/JellyfinCanopy/seerr/user-status'));
    });
}

/** Resolve status, force the master switch, then render the real split-button owner. */
async function rendered4kToggle(page: any, mediaType: 'movie' | 'tv', adminToggle: boolean): Promise<boolean> {
    return page.evaluate(async (args: { mediaType: string; adminToggle: boolean }) => {
        const jc = (window as any).JellyfinCanopy;
        await jc.seerrAPI.checkUserStatus(); // ensure capability is resolved
        jc.pluginConfig.SeerrEnable4KRequests = args.adminToggle;
        jc.pluginConfig.SeerrEnable4KTvRequests = args.adminToggle;
        const identity = jc.identity.capture();
        const card = document.createElement('div');
        card.className = 'seerr-card';
        jc.identity.own(card, identity);
        const button = document.createElement('button');
        card.appendChild(button);
        jc.identity.own(button, identity);
        jc.seerrUI.configureRequestButton(button, {
            id: args.mediaType === 'tv' ? 1399 : 550,
            mediaType: args.mediaType,
            title: '4K lifecycle fixture',
            mediaInfo: { status: 1, status4k: 1, seasons: [] },
        }, true, true);
        const rendered = !!card.querySelector('.seerr-split-arrow[data-toggle4k="true"]');
        card.remove();
        return rendered;
    }, { mediaType, adminToggle });
}

for (const role of ['admin', 'user'] as Role[]) {
    test.describe(`Seerr 4K & collection requests — ${role}`, () => {
        test(`4K option is gated on Seerr capability + permission, not the admin toggle (${role})`, async ({ page, consoleErrors }) => {
            await loginAs(page, role, consoleErrors);
            test.skip(!(await seerrReady(page)), SEERR_OFF);

            // The shared gate and the collection modal are present on the facade.
            const surface = await page.evaluate(() => {
                const jc = (window as any).JellyfinCanopy;
                return {
                    hasGate: typeof jc?.seerrAPI?.canRequest4k === 'function',
                    hasCollectionModal: typeof jc?.seerrUI?.showCollectionRequestModal === 'function',
                };
            });
            expect(surface.hasGate, 'canRequest4k gate exposed').toBe(true);
            expect(surface.hasCollectionModal, 'showCollectionRequestModal exposed').toBe(true);

            // With the admin master switch OFF, the 4K option is always hidden.
            expect(await rendered4kToggle(page, 'movie', false)).toBe(false);
            expect(await rendered4kToggle(page, 'tv', false)).toBe(false);

            // The user-status endpoint always answers with a typed reason.
            const status = await fetchUserStatus(page);
            expect(status, 'user-status responds').toBeTruthy();

            // With the admin master switch ON, the option follows the server-
            // reported capability + permission — never the toggle alone.
            const movieOn = await rendered4kToggle(page, 'movie', true);
            const tvOn = await rendered4kToggle(page, 'tv', true);

            if (status.userFound) {
                // Linked user: the capability fields are present and are booleans,
                // and the gate matches them exactly.
                expect(typeof status.canRequest4kMovie).toBe('boolean');
                expect(typeof status.canRequest4kTv).toBe('boolean');
                expect(movieOn).toBe(!!status.canRequest4kMovie);
                expect(tvOn).toBe(!!status.canRequest4kTv);
            } else {
                // Unlinked user (no resolvable Seerr permissions): 4K stays hidden
                // EVEN with the admin toggle ON — the capability/permission gate.
                expect(movieOn, 'no 4K for an unlinked user even with toggle on').toBe(false);
                expect(tvOn, 'no 4K TV for an unlinked user even with toggle on').toBe(false);
            }

            assertNoRuntimeErrors(consoleErrors);
        });
    });
}
