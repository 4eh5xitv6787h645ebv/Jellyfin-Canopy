// Unit tests for src/core/tag-renderer-base.ts ignore-selector scoping (MISC-1).
//
// The tag pipeline renders every quality/language/rating tag into a
// `.jc-tag-host` div that is a *sibling* of `.cardImageContainer` inside
// `.cardScalable`. The shared ignore selectors therefore have to be
// CONTAINER-scoped (like genre's) — an ignore selector ending in
// `.cardImageContainer` never matches the render target, so
// `DisableTagsOnSearchPage` (and the detail-page infoWrapper suppression)
// silently did nothing for those three families. These tests exercise the
// real `register()` → `ctx.shouldIgnore()` path against a faithful card
// fixture, plus a source guard that keeps the shared list container-scoped.

import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { register, resetAllTagRenderers } from './tag-renderer-base';
import type { TagSpec } from '../types/jc';

// A minimal spec: no cache / pipeline, so register() → initialize() is a clean
// no-op beyond building the ignore-selector list from the standard list.
function minimalSpec(): TagSpec {
    return {
        logPrefix: 'x',
        settingKey: 'qualityTagsEnabled',
        containerClass: 'jc-q',
        taggedAttr: 'jcQTagged',
    };
}

/**
 * Build a faithful card and return the `.jc-tag-host` render target — the
 * sibling of `.cardImageContainer` inside `.cardScalable`, exactly what the
 * pipeline hands to `renderer.render()`.
 * @param pageId - id for the outer page element (e.g. 'searchPage').
 * @param wrapperClass - optional class inserted between page and card.
 */
function buildCardHost(pageId: string, wrapperClass?: string): HTMLElement {
    document.body.innerHTML = '';
    const page = document.createElement('div');
    page.id = pageId;

    let mount: HTMLElement = page;
    if (wrapperClass) {
        const wrapper = document.createElement('div');
        wrapper.className = wrapperClass;
        page.appendChild(wrapper);
        mount = wrapper;
    }

    const card = document.createElement('div');
    card.className = 'card';
    const cardBox = document.createElement('div');
    cardBox.className = 'cardBox';
    const scalable = document.createElement('div');
    scalable.className = 'cardScalable';
    const imageContainer = document.createElement('div');
    imageContainer.className = 'cardImageContainer';
    const overlayContainer = document.createElement('div');
    overlayContainer.className = 'cardOverlayContainer';
    const host = document.createElement('div');
    host.className = 'jc-tag-host';

    scalable.append(imageContainer, overlayContainer, host);
    cardBox.appendChild(scalable);
    card.appendChild(cardBox);
    mount.appendChild(card);
    document.body.appendChild(page);
    return host;
}

describe('tag-renderer-base ignore selectors (MISC-1)', () => {
    beforeEach(() => {
        JC.pluginConfig = {};
    });

    afterEach(() => {
        JC.pluginConfig = {};
        document.body.innerHTML = '';
    });

    it('ignores the jc-tag-host render target on #searchPage when DisableTagsOnSearchPage is on', () => {
        JC.pluginConfig = { DisableTagsOnSearchPage: true };
        const host = buildCardHost('searchPage');
        // A distinct name per case keeps the module-scoped tag cache isolated.
        const ctx = register('test-quality-search', minimalSpec());
        // Pre-fix the pushed selector was `#searchPage .cardImageContainer`, and
        // the host is the *sibling* of `.cardImageContainer` → no match → false.
        expect(ctx.shouldIgnore(host)).toBe(true);
    });

    it('does NOT ignore search-page cards when DisableTagsOnSearchPage is off', () => {
        JC.pluginConfig = { DisableTagsOnSearchPage: false };
        const host = buildCardHost('searchPage');
        const ctx = register('test-quality-search-off', minimalSpec());
        expect(ctx.shouldIgnore(host)).toBe(false);
    });

    it('ignores the jc-tag-host on #itemDetailPage .infoWrapper cards', () => {
        const host = buildCardHost('itemDetailPage', 'infoWrapper');
        const ctx = register('test-quality-info', minimalSpec());
        // Pre-fix the selector was `.infoWrapper .cardImageContainer` → no match.
        expect(ctx.shouldIgnore(host)).toBe(true);
    });

    it('still renders (does not ignore) a plain #indexPage library card host (guards against over-scoping)', () => {
        const host = buildCardHost('indexPage');
        const ctx = register('test-quality-index', minimalSpec());
        expect(ctx.shouldIgnore(host)).toBe(false);
    });
});

describe('tag-renderer-base STANDARD_IGNORE_SELECTORS stay container-scoped (MISC-1 class guard)', () => {
    it('has no shared ignore selector terminated on .cardImageContainer or .card', () => {
        // vite statically rewrites new URL(import.meta.url); resolve the sibling
        // source from the test's own pathname (same idiom as the guard tests).
        const testPath = decodeURIComponent(new URL(import.meta.url).pathname);
        const srcPath = testPath.replace(/\.test\.ts$/, '.ts');
        const src = ts.sys.readFile(srcPath) ?? '';
        const block = src.match(/const STANDARD_IGNORE_SELECTORS:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);
        expect(block, 'STANDARD_IGNORE_SELECTORS literal not found').toBeTruthy();

        const selectors = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
        // Sanity: we actually parsed the list.
        expect(selectors.length).toBeGreaterThan(0);

        for (const sel of selectors) {
            expect(
                sel.endsWith('.cardImageContainer'),
                `leaf-scoped ignore selector re-introduced (ends in .cardImageContainer): ${sel}`,
            ).toBe(false);
            expect(
                sel.endsWith('.card'),
                `leaf-scoped ignore selector re-introduced (ends in .card): ${sel}`,
            ).toBe(false);
        }
    });
});

describe('tag-renderer-base projection invalidation (BI-SEC-035)', () => {
    it('clears targeted persistent/hot values plus the overlay and tagged marker', () => {
        const registerRenderer = vi.fn();
        JC.tagPipeline = { registerRenderer };
        JC.pluginConfig = { TagCacheServerMode: false };

        const name = `projection-cache-${Date.now()}`;
        const cacheKey = `jc-test-${name}`;
        const spec: TagSpec = {
            logPrefix: 'projection-test',
            settingKey: 'qualityTagsEnabled',
            containerClass: 'projection-overlay',
            taggedAttr: 'jcProjectionTagged',
            cache: {
                key: cacheKey,
                legacyPrefix: `${cacheKey}-legacy`,
                hotBucket: `${name}-hot`,
                saveOnUnload: false,
            },
            pipeline: { render: () => undefined },
        };
        const ctx = register(name, spec);
        const itemId = '11111111111111111111111111111111';
        ctx.setPersistent(itemId, { value: 'secret', timestamp: Date.now() });
        ctx.hot?.set(itemId, { value: 'secret', timestamp: Date.now() });

        const host = buildCardHost('indexPage');
        const card = host.closest<HTMLElement>('.card')!;
        card.dataset.jcProjectionTagged = '1';
        const overlay = document.createElement('div');
        overlay.className = 'projection-overlay';
        host.appendChild(overlay);

        const config = registerRenderer.mock.calls.at(-1)![1] as {
            onServerCacheRefresh(ids: string[] | null): void;
            invalidateCard(el: HTMLElement): void;
        };
        config.onServerCacheRefresh([itemId]);
        config.invalidateCard(host);

        expect(ctx.getPersistent(itemId)).toBeUndefined();
        expect(ctx.hot!.get(itemId)).toBeUndefined();
        expect(host.querySelector('.projection-overlay')).toBeNull();
        expect(card.dataset.jcProjectionTagged).toBeUndefined();

        localStorage.removeItem(cacheKey);
    });
});

describe('tag-renderer-base identity ownership', () => {
    afterEach(() => {
        JC.identity.transition('test-server-id', 'test-user-id', 'tag-renderer-test-cleanup');
        JC.tagPipeline = undefined;
        JC.pluginConfig = {};
        document.body.innerHTML = '';
    });

    it('drops A caches synchronously and rejects a retained A renderer context under B', () => {
        const registerRenderer = vi.fn();
        JC.tagPipeline = { registerRenderer };
        JC.pluginConfig = { TagCacheServerMode: false };

        const suffix = `${Date.now()}-${Math.random()}`;
        const name = `identity-cache-${suffix}`;
        const cacheKey = `jc-test-${name}`;
        let retainedA: ReturnType<typeof register> | null = null;
        const spec: TagSpec = {
            logPrefix: 'identity-test',
            settingKey: 'qualityTagsEnabled',
            containerClass: `identity-overlay-${suffix.replaceAll('.', '-')}`,
            taggedAttr: 'jcIdentityTestTagged',
            cache: {
                key: cacheKey,
                legacyPrefix: `${cacheKey}-legacy`,
                hotBucket: `${name}-hot`,
                saveOnUnload: false,
            },
            pipeline: {
                render(ctx) { retainedA = ctx; },
            },
        };

        const ctxA = register(name, spec);
        const hotA = ctxA.hot!;
        ctxA.setPersistent('item', { value: 'A', timestamp: Date.now() });
        hotA.set('item', { value: 'A' });
        localStorage.setItem(cacheKey, JSON.stringify({ item: { value: 'A' } }));

        const host = buildCardHost('indexPage');
        const rendererA = registerRenderer.mock.calls.at(-1)![1] as {
            render(el: HTMLElement, item: unknown): void;
        };
        rendererA.render(host, {});
        expect(retainedA).not.toBeNull();

        JC.identity.transition('server-b', `user-b-${suffix}`, 'tag-renderer-test');
        resetAllTagRenderers();
        expect(localStorage.getItem(cacheKey)).toBeNull();
        expect(hotA.get('item')).toBeUndefined();
        expect(ctxA.getPersistent('item')).toBeUndefined();

        const ctxB = register(name, spec);
        ctxA.setPersistent('late-public-a', { value: 'A' });
        retainedA!.setPersistent('late-a', { value: 'A' });
        const lateOverlay = document.createElement('div');
        lateOverlay.className = spec.containerClass;
        lateOverlay.appendChild(document.createElement('span'));
        expect(retainedA!.commitOverlay(host, lateOverlay)).toBe(false);
        expect(host.querySelector(`.${spec.containerClass}`)).toBeNull();
        expect(ctxB.getPersistent('late-public-a')).toBeUndefined();
        expect(ctxB.getPersistent('late-a')).toBeUndefined();

        ctxB.setPersistent('item', { value: 'B' });
        expect(ctxB.getPersistent('item')).toEqual({ value: 'B' });
    });
});
