// #459 — the Canopy header button tray must stay a SINGLE horizontally
// scrollable row (never wrap to 2–3 rows) on both layouts, mobile and desktop,
// for admin and non-admin, with the modern profile avatar pinned.
//
// Canopy owns no bar element; buttons are injected into a native container
// resolved by getHeaderRightContainer(). The fix marks that container
// `jc-header-tray` and installs a layout-scoped stylesheet (helpers.ts
// ensureHeaderTrayCSS) forcing display:flex; flex-wrap:nowrap; overflow-x:auto
// with non-shrinking children, and on modern `flex:1 1 0` (a 0 flex-basis, not a
// bare flex-shrink:1, so the wrapping MUI Toolbar cannot push the avatar onto a
// 2nd row) plus `justify-content:flex-start` and an auto inline-start margin on
// the visually-leading child (the native-tabs order:-1 group when present, else
// the DOM first child) so the tray's buttons right-align against the avatar when
// it fits yet pack from the scroll origin (staying reachable) when the row
// overflows — the native MUI action Box is flex-end, which the override beats. On
// legacy the resolved `.headerRight` is overridden to
// justify-content:flex-start and its native profile button (.headerUserButton),
// which lives INSIDE that scrollport, is sticky-pinned to the inline-end edge so
// it stays put while the icon buttons scroll. Neither alignment path uses the
// `safe`/`unsafe` keyword.
//
// These specs seed a real layout before boot, drive the ACTUAL resolved tray,
// append deterministic test-only buttons until it overflows, and prove the
// single-row/scroll-containment contract geometrically — never relying on
// overflow-y:visible.
import type { Page } from 'playwright/test';
import { test, expect, loginAs, assertNoRuntimeErrors, type Role } from './fixtures/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Layout = 'modern' | 'legacy';
const LAYOUT_STAMP: Record<Layout, string> = {
    modern: 'jc-modern-layout',
    legacy: 'jc-legacy-layout',
};

const MOBILE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
// Wide enough to overflow the widest tested tray: 40 × 48px ≈ 1920px of
// buttons exceeds the 1280px desktop viewport (and therefore any tray, which is
// always ≤ the viewport), guaranteeing scrollWidth > clientWidth on every case.
const FILLER_COUNT = 40;

/**
 * jellyfin-web's `localStorage['layout']` value. On the pinned Jellyfin 12
 * (unstable) image the modern React layout is `modern` and the classic
 * AngularJS header lives behind `desktop-legacy` / `mobile-legacy` (the older
 * `experimental` / `desktop` names were renamed and now fall back to modern).
 * Seed the value that actually renders the container the case exercises.
 */
async function seedLayout(page: Page, seedValue: string): Promise<void> {
    await page.addInitScript((value) => localStorage.setItem('layout', value), seedValue);
}

/**
 * Force the plugin to resolve + mark its tray, then append deterministic
 * test-only icon buttons into the REAL resolved container until it overflows.
 * Also drops one absolutely-positioned badge child (a `.jc-as-sup` stand-in) so
 * badge clipping can be checked even on a non-admin tray without active-streams.
 * Returns whether the resolved tray was found.
 *
 * On the legacy layout the REAL native profile button (`.headerUserButton`) is
 * the trailing child of the resolved `.headerRight`; the caller gates on it via
 * `ensureLegacyAvatar` BEFORE filling, so the fillers are inserted in front of
 * the genuine avatar (never a synthesized stand-in) and the row shape matches
 * production. No synthetic avatar is ever created — the pinned-avatar assertions
 * exercise Jellyfin's own control.
 */
async function fillResolvedTray(page: Page): Promise<boolean> {
    return page.evaluate(({ count }) => {
        const helpers = (window as any).JellyfinCanopy?.helpers;
        const tray: HTMLElement | null = helpers?.getHeaderRightContainer?.() ?? null;
        if (!tray) return false;
        // In production Canopy inserts its buttons at the FRONT of the tray, so the
        // native profile button (.headerUserButton), when present on the legacy
        // header, stays the trailing child. Mirror that: insert the fillers BEFORE
        // that button when it exists (append otherwise) so the row shape matches
        // production and the trailing profile button stays pinned at the right.
        const avatar = tray.querySelector<HTMLElement>(':scope > .headerUserButton');
        for (let i = 0; i < count; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'headerButton headerButtonRight paper-icon-button-light jc-e2e-459-filler';
            btn.dataset.jcE2e459 = String(i);
            // Give the test button a fixed intrinsic size so overflow is
            // deterministic on BOTH layouts. On the legacy layout there is no
            // `.MuiToolbar-root` so Canopy's 48px button-sizing rule does not
            // apply; without an explicit size these would collapse and never
            // overflow. The fix's `flex:0 0 auto` (asserted via computed
            // flex-shrink === 0) is what keeps these 48px wide instead of
            // shrinking to fit — exactly the single-row behaviour under test.
            btn.style.cssText = 'position:relative;box-sizing:border-box;width:48px;min-width:48px;height:48px;padding:0;margin:0;';
            const glyph = document.createElement('span');
            glyph.className = 'material-icons';
            glyph.textContent = 'star';
            btn.appendChild(glyph);
            if (i === 0) {
                // Absolutely-positioned child mirroring the active-streams badge
                // geometry (top:2px; right:2px) to prove no clipping at scroll ends.
                const badge = document.createElement('span');
                badge.className = 'jc-e2e-459-badge';
                badge.textContent = '9';
                badge.style.cssText = 'position:absolute;top:2px;right:2px;font-size:11px;line-height:1.1;';
                btn.appendChild(badge);
            }
            if (avatar) tray.insertBefore(btn, avatar);
            else tray.appendChild(btn);
        }
        return tray.querySelectorAll('.jc-e2e-459-filler').length === count;
    }, { count: FILLER_COUNT });
}

interface TrayGeometry {
    found: boolean;
    stamp: boolean;
    marked: boolean;
    flexWrap: string;
    overflowX: string;
    scrollWidth: number;
    clientWidth: number;
    childShrink: string[];
    childCenterYs: number[];
    trayRight: number;
    trayTop: number;
    trayBottom: number;
    innerWidth: number;
    badge: { top: number; bottom: number; left: number; right: number } | null;
}

async function readTray(page: Page, stamp: string): Promise<TrayGeometry> {
    return page.evaluate((layoutStamp) => {
        const helpers = (window as any).JellyfinCanopy?.helpers;
        const tray: HTMLElement | null = helpers?.getHeaderRightContainer?.() ?? null;
        const empty: TrayGeometry = {
            found: false, stamp: false, marked: false, flexWrap: '', overflowX: '', scrollWidth: 0,
            clientWidth: 0, childShrink: [], childCenterYs: [], trayRight: 0, trayTop: 0,
            trayBottom: 0, innerWidth: window.innerWidth, badge: null,
        };
        if (!tray) return empty;
        const style = getComputedStyle(tray);
        const rect = tray.getBoundingClientRect();
        const fillers = Array.from(tray.querySelectorAll<HTMLElement>('.jc-e2e-459-filler'));
        const badgeEl = tray.querySelector<HTMLElement>('.jc-e2e-459-badge');
        const badgeRect = badgeEl?.getBoundingClientRect();
        return {
            found: true,
            stamp: document.documentElement.classList.contains(layoutStamp),
            marked: tray.classList.contains('jc-header-tray'),
            flexWrap: style.flexWrap,
            overflowX: style.overflowX,
            scrollWidth: tray.scrollWidth,
            clientWidth: tray.clientWidth,
            childShrink: fillers.map((el) => getComputedStyle(el).flexShrink),
            childCenterYs: fillers.map((el) => {
                const r = el.getBoundingClientRect();
                return Math.round(r.top + r.height / 2);
            }),
            trayRight: rect.right,
            trayTop: rect.top,
            trayBottom: rect.bottom,
            innerWidth: window.innerWidth,
            badge: badgeRect
                ? { top: badgeRect.top, bottom: badgeRect.bottom, left: badgeRect.left, right: badgeRect.right }
                : null,
        } as TrayGeometry;
    }, stamp);
}

/** Scroll the tray to a given scrollLeft and read back the achieved value. */
async function scrollTray(page: Page, to: number | 'end'): Promise<number> {
    return page.evaluate((target) => {
        const helpers = (window as any).JellyfinCanopy?.helpers;
        const tray: HTMLElement | null = helpers?.getHeaderRightContainer?.() ?? null;
        if (!tray) return -1;
        tray.scrollLeft = target === 'end' ? tray.scrollWidth : target;
        return tray.scrollLeft;
    }, to);
}

/** Compact layout/geometry snapshot for a failure message (lazy — only built
 *  on the failure branch, never on the passing path). */
async function diag(page: Page): Promise<string> {
    return page.evaluate(() => {
        const helpers = (window as any).JellyfinCanopy?.helpers;
        const tray: HTMLElement | null = helpers?.getHeaderRightContainer?.() ?? null;
        const style = tray ? getComputedStyle(tray) : null;
        return JSON.stringify({
            htmlClass: document.documentElement.className,
            innerWidth: window.innerWidth,
            trayClass: tray?.className?.toString().slice(0, 60) ?? null,
            tray: tray && style
                ? {
                    cw: tray.clientWidth, sw: tray.scrollWidth, disp: style.display,
                    dir: style.flexDirection, wrap: style.flexWrap, ox: style.overflowX,
                    justify: style.justifyContent,
                }
                : null,
            fillerCount: tray ? tray.querySelectorAll('.jc-e2e-459-filler').length : 0,
        });
    });
}

/** The profile / user-menu box geometry on the modern layout (avatar anchor). */
async function readProfile(
    page: Page,
): Promise<{ found: boolean; left: number; right: number; top: number; innerWidth: number; visible: boolean } | null> {
    return page.evaluate(() => {
        const button = document.querySelector<HTMLElement>('[aria-controls="app-user-menu"]');
        const toolbar = button?.closest('.MuiToolbar-root');
        if (!button || !toolbar) {
            return { found: false, left: 0, right: 0, top: 0, innerWidth: window.innerWidth, visible: false };
        }
        let box: HTMLElement | null = button;
        while (box && box.parentElement !== toolbar) box = box.parentElement;
        const target = box ?? button;
        const rect = target.getBoundingClientRect();
        return {
            found: true,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            innerWidth: window.innerWidth,
            visible: rect.width > 0 && rect.height > 0 && !target.classList.contains('jc-header-tray'),
        };
    });
}

/**
 * The native legacy profile button (`.headerUserButton`) geometry. On the legacy
 * header it is a trailing child of the resolved `.headerRight` scrollport (unlike
 * modern, where the avatar is a separate sibling Box OUTSIDE the tray). It is
 * sticky-pinned (`position:sticky; inset-inline-end:0`) to the scrollport's
 * inline-end edge so it stays visible at rest and stationary while the icon buttons
 * scroll beneath it (findings r9f2/r9f7/r9f11). Reports its computed position and
 * rect so a test can prove it is pinned (does not ride the row's scroll) and
 * on-screen at rest.
 */
async function readLegacyAvatar(
    page: Page,
): Promise<{ found: boolean; position: string; left: number; right: number; width: number } | null> {
    return page.evaluate(() => {
        const helpers = (window as any).JellyfinCanopy?.helpers;
        const tray: HTMLElement | null = helpers?.getHeaderRightContainer?.() ?? null;
        const avatar = tray?.querySelector<HTMLElement>(':scope > .headerUserButton') ?? null;
        if (!avatar) return { found: false, position: '', left: 0, right: 0, width: 0 };
        const rect = avatar.getBoundingClientRect();
        return {
            found: true,
            position: getComputedStyle(avatar).position,
            left: rect.left,
            right: rect.right,
            width: rect.width,
        };
    });
}

/**
 * Modern only: wait until the real MUI action Box (the user-menu Box's
 * previousElementSibling) has mounted, then confirm `getHeaderRightContainer()`
 * resolves to exactly that Box.
 *
 * The production resolver targets the REAL always-present action Box directly — via
 * the user-menu Box's previousElementSibling when the user has loaded, else the
 * toolbar's last child during the preload window — and NEVER synthesizes a container.
 * So there is no synthetic-fallback state for the test to repair; it simply waits for
 * the real header to finish mounting and asserts the resolver points at it. (An
 * earlier revision appended a synthetic `.headerRight` during preload and the cache
 * could pin it for the whole page — this helper used to delete that node before
 * asserting, masking the production race; the resolver fix removed the synthetic path
 * entirely, so the masking is gone too — r9f1/r9f8/r9f9/r9f12.)
 */
async function ensureRealModernTray(page: Page): Promise<void> {
    const ready = await page.waitForFunction(() => {
        const userMenu = document.querySelector('[aria-controls="app-user-menu"]');
        const toolbar = userMenu?.closest('.MuiToolbar-root');
        if (!userMenu || !toolbar) return false;
        let box: Element | null = userMenu;
        while (box && box.parentElement !== toolbar) box = box.parentElement;
        return !!(box && box.previousElementSibling);
    }, null, { timeout: 30_000 }).then(() => true, () => false);
    if (!ready) throw new Error(`modern MUI header (user-menu + action box) not ready. DIAG=${await diag(page)}`);

    // The resolver returns the real action Box (never a synthetic `.headerRight`).
    // Confirm it points at the user-menu Box's previousElementSibling and that no
    // synthetic fallback was ever created in the toolbar.
    const resolved = await page.waitForFunction(() => {
        const helpers = (window as any).JellyfinCanopy?.helpers;
        const userMenu = document.querySelector('[aria-controls="app-user-menu"]');
        const toolbar = userMenu?.closest('.MuiToolbar-root');
        if (!userMenu || !toolbar) return false;
        let box: Element | null = userMenu;
        while (box && box.parentElement !== toolbar) box = box.parentElement;
        const realActionBox = box?.previousElementSibling ?? null;
        const tray = helpers?.getHeaderRightContainer?.() ?? null;
        // No synthetic container is ever appended to the toolbar.
        const noSynthetic = !toolbar.querySelector(':scope > .headerRight');
        return !!tray && tray === realActionBox && noSynthetic;
    }, null, { timeout: 30_000 }).then(() => true, () => false);
    if (!resolved) throw new Error(`modern tray never resolved to the real action box. DIAG=${await diag(page)}`);
}

/**
 * Legacy only: wait until Jellyfin's REAL native profile button
 * (`.headerUserButton`) has mounted as a visible direct child of the resolved
 * `.headerRight` scrollport, then confirm the resolver marks that same tray.
 *
 * jellyfin-web builds `.headerUserButton` inside `.headerRight` but starts it
 * `.hide` (display:none, no geometry) and only un-hides it once the current user
 * has loaded (libraryMenu.js updateUserInHeader). Gating on the real, laid-out
 * avatar here — instead of ever synthesizing a stand-in — makes the pinned-avatar
 * assertions exercise Jellyfin's own control: if the native avatar were absent,
 * moved out of the tray, or still hidden, this throws rather than passing
 * vacuously (r10f1–r10f5).
 */
async function ensureLegacyAvatar(page: Page): Promise<void> {
    const ready = await page.waitForFunction(() => {
        const helpers = (window as any).JellyfinCanopy?.helpers;
        const tray: HTMLElement | null = helpers?.getHeaderRightContainer?.() ?? null;
        if (!tray) return false;
        const avatar = tray.querySelector<HTMLElement>(':scope > .headerUserButton');
        if (!avatar) return false;
        // Real + laid out: offsetParent is null while `.hide` (display:none) is set,
        // and a hidden button has a zero-area rect. Require both so the gate resolves
        // only once the genuine avatar is on-screen and measurable.
        const rect = avatar.getBoundingClientRect();
        return avatar.offsetParent !== null && rect.width > 0 && rect.height > 0;
    }, null, { timeout: 30_000 }).then(() => true, () => false);
    if (!ready) throw new Error(`legacy native profile avatar (.headerUserButton) never mounted visibly in the resolved tray. DIAG=${await diag(page)}`);
}

async function assertSingleScrollableRow(page: Page, layout: Layout): Promise<void> {
    const filled = await fillResolvedTray(page);
    expect(filled, 'the real resolved header tray must exist and accept test buttons').toBe(true);

    const geo = await readTray(page, LAYOUT_STAMP[layout]);
    expect(geo.found, 'resolved tray present').toBe(true);
    expect(geo.stamp, `${LAYOUT_STAMP[layout]} must be stamped on <html>`).toBe(true);
    expect(geo.marked, 'the resolved tray carries the jc-header-tray marker').toBe(true);

    // Single row: never wraps, and every button center shares one row band.
    expect(geo.flexWrap).toBe('nowrap');

    // The tray is genuinely a user-scrollable overflow container, not merely
    // programmatically reachable (finding r5f2). If native/theme CSS overrode the
    // tray to `overflow-x: hidden`, `scrollWidth > clientWidth` would still hold
    // and assigning `scrollLeft` would still reach both endpoints — so the
    // programmatic-scroll assertions below would pass while touch / wheel /
    // trackpad users could not scroll at all. Assert the REAL computed overflow-x
    // is `auto` in each layout: that is the property that makes the overflowing
    // buttons reachable to a touch/wheel/trackpad gesture, and the exact thing an
    // `overflow-x: hidden` regression would flip. (A synthetic wheel gesture is
    // intentionally NOT used — `page.mouse.wheel` does not reliably actuate an
    // inner overflow container in headless Chromium, which would make the check
    // flaky rather than more truthful; the computed-value assertion is the robust,
    // non-vacuous signal.)
    expect(
        geo.overflowX,
        `tray must be user-scrollable (computed overflow-x auto, not hidden/visible). DIAG=${await diag(page)}`,
    ).toBe('auto');
    const uniqueRows = new Set(geo.childCenterYs);
    expect(
        uniqueRows.size,
        `all ${geo.childCenterYs.length} buttons must occupy one row (centers: ${[...uniqueRows].join(',')})`
    ).toBe(1);

    // Horizontal scroll, not wrap: content exceeds the scrollport.
    if (geo.scrollWidth <= geo.clientWidth) {
        throw new Error(`tray must overflow its scrollport (scrollWidth ${geo.scrollWidth} vs clientWidth ${geo.clientWidth}). DIAG=${await diag(page)}`);
    }

    // Direct children never shrink (flex-shrink:0) so they cannot collapse/wrap.
    for (const shrink of geo.childShrink) expect(shrink).toBe('0');

    // The tray box itself stays within the viewport and clips its overflowing
    // content internally instead of widening the header past the screen edge.
    // (Whole-document horizontal overflow is deliberately NOT asserted here: the
    // seeded home page has its own horizontally-scrolling card shelves that load
    // asynchronously and leak into document scrollWidth — unrelated to the header
    // fix. The tray-scoped checks below are the correct, header-owned invariant.)
    if (geo.clientWidth > geo.innerWidth + 2) {
        throw new Error(`tray must fit within the viewport (clip, not widen the header): clientWidth ${geo.clientWidth} > innerWidth ${geo.innerWidth}. DIAG=${await diag(page)}`);
    }
    expect(geo.trayRight, 'tray right edge stays within the viewport').toBeLessThanOrEqual(geo.innerWidth + 2);

    // Both scroll endpoints reachable: the leading child's auto inline-start
    // margin (modern) / flex-start override (legacy) resolves to the scroll origin
    // on overflow, so nothing is stranded in unreachable negative overflow.
    const atStart = await scrollTray(page, 0);
    expect(atStart).toBe(0);
    const atEnd = await scrollTray(page, 'end');
    expect(atEnd).toBeGreaterThan(0);
}

async function assertBadgeInsideScrollport(page: Page, layout: Layout): Promise<void> {
    // At the endpoint where the badge-bearing (first) button is scrolled toward
    // the clipping edge, the absolutely-positioned badge must stay within the
    // tray's box (no clipping of .jc-as-sup-style children).
    await scrollTray(page, 0);
    const geo = await readTray(page, LAYOUT_STAMP[layout]);
    expect(geo.badge, 'badge stand-in present').not.toBeNull();
    const badge = geo.badge!;
    // Vertically inside the tray band (top:2px keeps it below the tray top).
    expect(badge.top).toBeGreaterThanOrEqual(geo.trayTop - 1);
    expect(badge.bottom).toBeLessThanOrEqual(geo.trayBottom + 1);
    expect(badge.right - badge.left, 'badge has non-zero width (rendered, not collapsed)').toBeGreaterThan(0);
}

interface Case {
    layout: Layout;
    role: Role;
    viewport: { width: number; height: number };
    seed: string;
    label: string;
}

const CASES: Case[] = [
    { layout: 'modern', role: 'admin', viewport: MOBILE, seed: 'modern', label: 'modern / mobile / admin' },
    { layout: 'modern', role: 'user', viewport: DESKTOP, seed: 'modern', label: 'modern / desktop / non-admin' },
    { layout: 'legacy', role: 'user', viewport: MOBILE, seed: 'mobile-legacy', label: 'legacy / mobile / non-admin' },
    { layout: 'legacy', role: 'admin', viewport: DESKTOP, seed: 'desktop-legacy', label: 'legacy / desktop / admin' },
];

test.describe('header button tray stays a single scrollable row (#459)', () => {
    for (const testCase of CASES) {
        test(testCase.label, async ({ page, consoleErrors }) => {
            await page.setViewportSize(testCase.viewport);
            await seedLayout(page, testCase.seed);
            await loginAs(page, testCase.role, consoleErrors);

            // Fail (not skip) if the requested layout never stamped — the seed
            // must have taken before boot.
            const stamp = LAYOUT_STAMP[testCase.layout];
            const stamped = await page.waitForFunction(
                (wanted) => document.documentElement.classList.contains(wanted),
                stamp,
                { timeout: 20_000 }
            ).then(() => true, () => false);
            if (!stamped) throw new Error(`layout stamp ${stamp} missing. DIAG=${await diag(page)}`);

            // Modern only: resolve off the synthetic `preload` fallback onto the real MUI
            // action box before driving the tray (the layout stamp alone races — see
            // ensureRealModernTray). Legacy resolves to the native `.headerRight` itself,
            // but its native profile button starts `.hide` and un-hides only after the
            // user loads — gate on the real, laid-out avatar so the pinned-avatar block
            // exercises Jellyfin's own control (never a synthesized stand-in).
            if (testCase.layout === 'modern') await ensureRealModernTray(page);
            else await ensureLegacyAvatar(page);

            await assertSingleScrollableRow(page, testCase.layout);
            await assertBadgeInsideScrollport(page, testCase.layout);

            // The profile avatar is a separate, unmarked toolbar child that must
            // stay pinned to the RIGHT of the scroll region and, critically, must
            // NOT be pushed onto a second row when the tray overflows. The tray
            // resolves off the toolbar's user-menu button, so wherever that button
            // renders (it is present in the MUI toolbar on BOTH modern mobile and
            // desktop — the avatar does not move into the drawer) the profile Box
            // sibling is present. Assert the same-row / on-screen / pinned contract
            // for EVERY modern case — mobile included — because the reported defect
            // (avatar shoved to a 2nd row, finding r3f1) reproduces worst at the
            // ~390px mobile viewport, exactly the case the previous desktop-only
            // guard never exercised. The legacy header has no such sibling and is
            // handled by its own block below.
            if (testCase.layout === 'modern') {
                await scrollTray(page, 0);
                const start = await readProfile(page);
                expect(start?.found, 'modern toolbar exposes the profile avatar').toBe(true);
                expect(start?.visible, 'profile avatar visible before scroll').toBe(true);

                // Same row, not wrapped below: the binding "profile avatar stays
                // pinned, never pushed to a 2nd row" criterion. flex-shrink alone
                // did NOT prevent this (the parent MUI Toolbar is flex-wrap:wrap and
                // collects lines from the tray's hypothetical main size before
                // shrink resolves); the flex-basis:0 fix keeps the avatar on the
                // tray's row. Compare the avatar's top against the tray's top band.
                const trayRow = await readTray(page, stamp);
                expect(
                    Math.abs(start!.top - trayRow.trayTop),
                    `profile avatar must share the tray's row, not wrap below `
                    + `(avatar.top ${start!.top} vs tray.top ${trayRow.trayTop}). DIAG=${await diag(page)}`,
                ).toBeLessThanOrEqual(4);
                // On-screen, not merely rendered: a positive getBoundingClientRect
                // width/height stays true for an element pushed off the right edge,
                // so `visible` alone cannot catch a shrink regression (flex-shrink:1
                // / min-width:0 removed) that lets the overflowing tray shove the
                // profile Box past innerWidth. Assert the avatar's right edge is
                // actually within the viewport — the binding "avatar stays pinned /
                // not pushed off" criterion. (trayRight <= avatar.left below is not
                // enough on its own: tray and avatar are siblings that shift right
                // together, so that inequality holds even off-screen.)
                expect(
                    start!.right,
                    `profile avatar must stay on-screen (right ${start!.right} within innerWidth ${start!.innerWidth})`,
                ).toBeLessThanOrEqual(start!.innerWidth + 2);
                expect(start!.left, 'profile avatar left edge within viewport').toBeLessThan(start!.innerWidth);

                const trayBefore = await readTray(page, stamp);
                // The scroll region ends at or left of the avatar (never over it).
                expect(trayBefore.trayRight).toBeLessThanOrEqual(start!.left + 1);

                await scrollTray(page, 'end');
                const end = await readProfile(page);
                expect(end?.visible, 'profile avatar visible after scroll').toBe(true);
                // Still on-screen after the tray scrolls to its end.
                expect(
                    end!.right,
                    `profile avatar must stay on-screen after scroll (right ${end!.right} within innerWidth ${end!.innerWidth})`,
                ).toBeLessThanOrEqual(end!.innerWidth + 2);
                // Stationary: internal tray scroll never moves the avatar.
                expect(Math.abs(end!.left - start!.left)).toBeLessThanOrEqual(1);
                expect(Math.abs(end!.top - start!.top)).toBeLessThanOrEqual(1);
            }

            // On the legacy header the native profile button lives INSIDE the
            // resolved .headerRight scrollport (not a separate sibling as on modern),
            // so it must be sticky-pinned to the scrollport's inline-end edge — it
            // stays visible at rest and stationary while the icon buttons scroll
            // beneath it (the binding pinned-avatar criterion, r9f2/r9f7/r9f11). Left
            // as an ordinary in-flow child it would start off-screen once the row
            // overflows and be reachable only after scrolling to the end. Prove the
            // avatar IS sticky, is on-screen at rest (scrollLeft=0), and does NOT ride
            // the row's scroll (moves ≈0px) — the pinned signature.
            if (testCase.layout === 'legacy') {
                await scrollTray(page, 0);
                const avatar = await readLegacyAvatar(page);
                // Non-vacuous precondition: ensureLegacyAvatar already waited for the
                // REAL native .headerUserButton to mount visibly as a direct tray child,
                // so this reads Jellyfin's own avatar (never a synthesized stand-in) and
                // the pinned criterion is genuinely exercised — the block cannot pass
                // green without proving it on the native control.
                expect(avatar?.found, 'legacy resolved tray must contain a .headerUserButton').toBe(true);
                // Pinned, not scrolling: computed position is sticky.
                expect(avatar!.position, 'legacy profile avatar must be sticky-pinned').toBe('sticky');
                // Visible at rest (scrollLeft=0): the pin holds it on-screen at the
                // right edge even before any scroll — an unpinned trailing child would
                // be stranded off the right edge here.
                expect(
                    avatar!.right,
                    `pinned avatar on-screen at rest (right ${avatar!.right} within viewport ${testCase.viewport.width})`,
                ).toBeLessThanOrEqual(testCase.viewport.width + 2);
                expect(avatar!.left, 'pinned avatar left edge within viewport at rest').toBeLessThan(testCase.viewport.width);

                const atStart = await readLegacyAvatar(page);
                const scrolledTo = await scrollTray(page, 'end');
                const atEnd = await readLegacyAvatar(page);
                // The tray genuinely scrolled a long way (else the stationarity test
                // is vacuous). A sticky-pinned avatar stays clamped to the scrollport's
                // inline-end edge, so its viewport position barely moves across the
                // whole scroll — the anti-scroll signature. An in-flow child riding the
                // row would instead move by ≈the full scroll distance. Assert the
                // movement is a tiny fraction (<10%) of the scroll: that cleanly
                // separates a pin (a few px of sub-pixel / scrollport-inset residual)
                // from a rider (≈100% of the scroll), without over-fitting to an exact
                // sub-pixel value.
                expect(scrolledTo, 'tray scrolled a meaningful distance').toBeGreaterThan(200);
                expect(
                    Math.abs(atEnd!.left - atStart!.left),
                    `pinned avatar stays put, does not ride the scroll (moved ${Math.abs(atEnd!.left - atStart!.left).toFixed(1)}px over a ${scrolledTo}px scroll)`,
                ).toBeLessThan(scrolledTo * 0.1);
                // Still on-screen within the viewport at the scroll end.
                expect(atEnd!.right).toBeLessThanOrEqual(testCase.viewport.width + 2);
                expect(atEnd!.left).toBeLessThan(testCase.viewport.width);
            }

            assertNoRuntimeErrors(consoleErrors);
        });
    }

    // Fit-state coverage for the native-tabs order:-1 group. The overflow cases
    // above force the auto inline-start margin to resolve to 0, so they cannot
    // catch a margin placed on the wrong child. native-tabs.ts appends
    // #jc-native-tabs-group as the DOM-LAST child but with order:-1, making it the
    // visually-FIRST flex item. When the row FITS, the right-align auto margin must
    // sit on that group; if it sat on the DOM :first-child instead, free space would
    // open BETWEEN the reordered group and the remaining buttons — the group
    // stranded at the tray's left edge, a visible split, not the native contiguous
    // right-packed tray. Prove the geometry on a roomy modern desktop tray.
    test('modern fit-state: the native-tabs order:-1 group stays right-packed and contiguous, not split to the left edge', async ({ page, consoleErrors }) => {
        await page.setViewportSize(DESKTOP);
        await seedLayout(page, 'modern');
        await loginAs(page, 'admin', consoleErrors);

        const stamp = LAYOUT_STAMP.modern;
        const stamped = await page.waitForFunction(
            (wanted) => document.documentElement.classList.contains(wanted),
            stamp,
            { timeout: 20_000 },
        ).then(() => true, () => false);
        if (!stamped) throw new Error(`layout stamp ${stamp} missing. DIAG=${await diag(page)}`);

        // Resolve off the synthetic `preload` fallback onto the real MUI action box
        // (the layout stamp alone races on a loaded machine — see ensureRealModernTray).
        await ensureRealModernTray(page);

        const geo = await page.evaluate(() => {
            const helpers = (window as any).JellyfinCanopy?.helpers;
            const tray: HTMLElement | null = helpers?.getHeaderRightContainer?.() ?? null;
            if (!tray) return null;

            const mkButton = (id: string): HTMLElement => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.id = id;
                btn.className = 'headerButton headerButtonRight paper-icon-button-light jc-e2e-459-fit';
                btn.style.cssText = 'box-sizing:border-box;width:48px;min-width:48px;height:48px;padding:0;margin:0;';
                return btn;
            };

            // Exactly one test-owned group: drop any real native-tabs group first so we
            // never create a duplicate #jc-native-tabs-group id. One guaranteed order-0
            // neighbour so contiguity is measurable even on an otherwise-bare tray.
            tray.querySelector(':scope > #jc-native-tabs-group')?.remove();
            const action = mkButton('jc-e2e-fit-action');
            tray.appendChild(action);

            // Mirror native-tabs.getOrCreateGroup: appended LAST, order:-1 → visually
            // first. Give it real width via a contained 48px button.
            const group = document.createElement('div');
            group.id = 'jc-native-tabs-group';
            group.style.cssText = 'display:flex;align-items:center;order:-1;';
            group.appendChild(mkButton('jc-e2e-fit-group-btn'));
            tray.appendChild(group);

            const trayRect = tray.getBoundingClientRect();
            const groupRect = group.getBoundingClientRect();
            // Every OTHER direct child's rendered box (excludes the group itself).
            const others = Array.from(tray.children)
                .filter((c) => c !== group)
                .map((c) => c.getBoundingClientRect())
                .filter((r) => r.width > 0 && r.height > 0);
            // The group's nearest neighbour to its right in VISUAL order — regardless of
            // how many real Canopy buttons sit in the cluster.
            const toRight = others
                .filter((r) => r.left >= groupRect.right - 1)
                .sort((a, b) => a.left - b.left);
            return {
                fits: tray.scrollWidth <= tray.clientWidth + 1,
                trayLeft: trayRect.left,
                trayRight: trayRect.right,
                groupLeft: groupRect.left,
                trayWidth: trayRect.width,
                neighbourCount: toRight.length,
                neighbourGap: toRight.length ? toRight[0].left - groupRect.right : null,
                rightmost: Math.max(groupRect.right, ...others.map((r) => r.right)),
            };
        });

        expect(geo, 'resolved modern tray present').not.toBeNull();
        // The scenario is only meaningful while the row fits (auto margin non-zero).
        expect(geo!.fits, `tray must fit for the fit-state check (DIAG=${await diag(page)})`).toBe(true);

        // Contiguous: the reordered group sits immediately left of its right neighbour —
        // no split. A margin on the DOM :first-child would open a large gap here (all
        // the tray's free space would land between the order:-1 group and the rest).
        expect(geo!.neighbourCount, 'the group has a right neighbour to be contiguous with').toBeGreaterThan(0);
        expect(
            geo!.neighbourGap,
            `native-tabs group must be contiguous with the following buttons, not split away `
            + `(gap ${geo!.neighbourGap}px)`,
        ).toBeLessThanOrEqual(8);

        // Right-packed: the auto margin sits to the LEFT of the (visually-leading)
        // group, pushing the whole cluster toward the avatar. So the group's left edge
        // is far from the tray's left/scroll origin. A margin on the DOM :first-child
        // would instead leave the group pinned at the tray's left edge (groupLeft ≈
        // trayLeft). Require the free space to have moved the cluster well right.
        expect(
            geo!.groupLeft - geo!.trayLeft,
            `native-tabs group must be right-packed (auto margin left of it), not stranded at `
            + `the tray's left edge (groupLeft-trayLeft ${geo!.groupLeft - geo!.trayLeft}px, trayWidth ${geo!.trayWidth}px)`,
        ).toBeGreaterThan(100);

        // The cluster packs against the avatar side: the rightmost content edge sits at
        // the tray's right edge (the scroll region ends left of the profile Box).
        expect(geo!.trayRight - geo!.rightmost, 'cluster packs against the tray right edge').toBeLessThanOrEqual(8);

        assertNoRuntimeErrors(consoleErrors);
    });
});
