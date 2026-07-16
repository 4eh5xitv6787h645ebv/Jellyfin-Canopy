// Loader-owned registry for self-contained tabs in Jellyfin's native Home tab
// strip. Importing this module is deliberately side-effect free.

import { createStableMethodFacade } from '../core/feature-loader';
import type { FeatureScope } from '../core/feature-loader';
import { isOnHomePage } from '../core/route-match';
import { JC } from '../globals';

declare global {
    interface Window {
        /** Custom-elements polyfill hook exposed by jellyfin-web. */
        CustomElements?: { upgradeSubtree?: (root: Element) => void };
    }
}

interface NativeTabEntry {
    id: string;
    title: string;
    onMount: (panel: HTMLElement) => void;
    icon?: string;
    index?: number | null;
}

export interface NativeTabsApi {
    register: (id: string, title: string, onMount: (panel: HTMLElement) => void, icon?: string) => void;
    unregister: (id: string) => void;
}

const inactiveApi: NativeTabsApi = Object.freeze({
    register: () => undefined,
    unregister: () => undefined,
});
const stableApi = createStableMethodFacade<NativeTabsApi>(inactiveApi);
let activationGeneration = 0;
let currentGeneration = 0;

interface NativeTabsRuntime {
    readonly api: NativeTabsApi;
    dispose(): void;
}

function nextFreeIndex(slider: Element): number {
    let max = 1;
    slider.querySelectorAll('[data-index]').forEach((element) => {
        const index = Number.parseInt(element.getAttribute('data-index') || '', 10);
        if (Number.isInteger(index) && index > max) max = index;
    });
    return max + 1;
}

function headerRightContainer(): HTMLElement | null {
    const helpers = JC.helpers as { getHeaderRightContainer?: () => HTMLElement | null } | undefined;
    return helpers?.getHeaderRightContainer?.() ?? null;
}

function createRuntime(scope: FeatureScope): NativeTabsRuntime {
    const generation = ++activationGeneration;
    currentGeneration = generation;
    let disposed = false;
    let injectFrame: number | null = null;
    const entries: NativeTabEntry[] = [];
    const animatedLinkIds = new Set<string>();
    const ownedNodes = new Set<HTMLElement>();
    const ownedEntryNodes = new Map<string, Set<HTMLElement>>();
    const animationCleanups = new Set<() => void>();

    const isCurrent = (): boolean => !disposed
        && currentGeneration === generation
        && scope.isCurrent();

    const markOwned = <T extends HTMLElement>(node: T, entryId?: string): T => {
        node.dataset.jcNativeTabsOwner = String(generation);
        ownedNodes.add(node);
        if (entryId) {
            let nodes = ownedEntryNodes.get(entryId);
            if (!nodes) {
                nodes = new Set<HTMLElement>();
                ownedEntryNodes.set(entryId, nodes);
            }
            nodes.add(node);
        }
        return node;
    };

    const forgetOwned = (node: HTMLElement): void => {
        ownedNodes.delete(node);
        for (const [entryId, nodes] of ownedEntryNodes) {
            nodes.delete(node);
            if (nodes.size === 0) ownedEntryNodes.delete(entryId);
        }
    };

    const removeOwned = (node: HTMLElement): void => {
        node.remove();
        forgetOwned(node);
    };

    const removeOwnedEntryNodes = (id: string): void => {
        const nodes = ownedEntryNodes.get(id);
        if (!nodes) return;
        for (const node of [...nodes]) removeOwned(node);
        ownedEntryNodes.delete(id);
    };

    const getTabsRoot = (): HTMLElement | null => {
        const nativePanel = document.querySelector('.tabContent.pageTabContent[data-index="0"]');
        return nativePanel?.parentElement ?? null;
    };

    const removeGroupIfEmpty = (): void => {
        const group = document.getElementById('jc-native-tabs-group');
        if (group && group.children.length <= 1) {
            removeOwned(group);
        }
    };

    const getOrCreateGroup = (headerRight: HTMLElement): HTMLElement => {
        const existing = document.getElementById('jc-native-tabs-group');
        if (existing?.dataset.jcNativeTabsOwner === String(generation)) return existing;
        existing?.remove();

        const group = markOwned(document.createElement('div'));
        group.id = 'jc-native-tabs-group';
        group.style.cssText = 'display:flex;align-items:center;order:-1;';
        const separator = document.createElement('span');
        separator.id = 'jc-native-tabs-separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.style.cssText = 'display:inline-block;width:1px;height:1.4em;margin:0 0.5em;background:rgba(255,255,255,0.3);';
        group.appendChild(separator);
        headerRight.appendChild(group);
        return group;
    };

    const expandOwned = (element: HTMLElement, instant: boolean): void => {
        if (instant || !element.isConnected) return;
        const targetWidth = element.getBoundingClientRect().width;
        if (targetWidth <= 0) return;
        const previousOverflow = element.style.overflow;
        element.style.overflow = 'hidden';
        element.style.width = '0px';
        void element.offsetWidth;
        element.style.transition = 'width 150ms ease';
        element.style.width = `${targetWidth}px`;
        let timer: number | null = null;
        let cleaned = false;
        const cleanup = (): void => {
            if (cleaned) return;
            cleaned = true;
            element.removeEventListener('transitionend', cleanup);
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
            element.style.transition = '';
            element.style.width = '';
            element.style.overflow = previousOverflow;
            animationCleanups.delete(cleanup);
        };
        animationCleanups.add(cleanup);
        element.addEventListener('transitionend', cleanup, { once: true });
        timer = window.setTimeout(cleanup, 250);
    };

    const syncDeepLink = (): void => {
        if (!isCurrent()) return;
        const match = /[?&]tab=(\d+)/.exec(window.location.hash);
        if (!match) return;
        const wantedIndex = Number.parseInt(match[1], 10);
        const entry = entries.find((candidate) => candidate.index === wantedIndex);
        if (!entry) return;
        const button = document.getElementById(`jc-native-tab-btn-${entry.id}`);
        const tabs = document.querySelector<HTMLElement & { selectedIndex?: (index?: number) => number }>('[is="emby-tabs"]');
        if (button && tabs?.selectedIndex && tabs.selectedIndex() !== wantedIndex) {
            tabs.selectedIndex(wantedIndex);
        }
    };

    const ensureDiscoverable = (entry: NativeTabEntry): void => {
        if (!isCurrent()) return;
        const button = document.getElementById(`jc-native-tab-btn-${entry.id}`);
        const linkId = `jc-native-tab-link-${entry.id}`;
        if (button && button.offsetParent !== null) {
            const link = document.getElementById(linkId);
            if (link?.dataset.jcNativeTabsOwner === String(generation)) removeOwned(link);
            removeGroupIfEmpty();
            return;
        }
        const existingLink = document.getElementById(linkId);
        if (existingLink?.dataset.jcNativeTabsOwner === String(generation)) return;
        existingLink?.remove();
        const headerRight = headerRightContainer();
        if (!headerRight || !isCurrent()) return;
        const groupExisted = document.getElementById('jc-native-tabs-group') !== null;
        const group = getOrCreateGroup(headerRight);
        const separator = document.getElementById('jc-native-tabs-separator');
        if (!separator) return;
        const link = markOwned(JC.core.ui!.muiIconButton({
            id: linkId,
            icon: entry.icon || 'tab',
            title: entry.title,
            className: 'headerButton headerButtonRight paper-icon-button-light',
            onClick: () => {
                if (!isCurrent()) return;
                const hash = window.location.hash;
                const base = hash.indexOf('#/home') === 0 ? hash.split('?')[0] : '#/home';
                window.location.hash = `${base}?tab=${entry.index}`;
            },
        }), entry.id);
        group.insertBefore(link, separator);
        const firstAppearance = !animatedLinkIds.has(entry.id);
        animatedLinkIds.add(entry.id);
        expandOwned(groupExisted ? link : group, !firstAppearance);
    };

    const ensureInjected = (): void => {
        if (!isCurrent() || entries.length === 0 || !isOnHomePage()) return;
        for (const node of [...ownedNodes]) {
            if (!node.isConnected) forgetOwned(node);
        }
        const slider = document.querySelector('.emby-tabs-slider');
        const root = getTabsRoot();
        if (!slider || !root) return;

        for (const entry of entries) {
            if (!isCurrent()) return;
            entry.index ??= nextFreeIndex(slider);
            const buttonId = `jc-native-tab-btn-${entry.id}`;
            const existingButton = document.getElementById(buttonId);
            if (existingButton?.dataset.jcNativeTabsOwner !== String(generation)) existingButton?.remove();
            if (!document.getElementById(buttonId)) {
                const button = markOwned(document.createElement('button'), entry.id);
                button.type = 'button';
                button.setAttribute('is', 'emby-button');
                button.id = buttonId;
                button.className = 'emby-tab-button';
                button.setAttribute('data-index', String(entry.index));
                const label = document.createElement('div');
                label.className = 'emby-button-foreground';
                label.textContent = entry.title;
                button.appendChild(label);
                slider.appendChild(button);
                window.CustomElements?.upgradeSubtree?.(slider);
            }
            const panelId = `jc-native-tab-panel-${entry.id}`;
            const existingPanel = document.getElementById(panelId);
            if (existingPanel?.dataset.jcNativeTabsOwner !== String(generation)) existingPanel?.remove();
            if (!document.getElementById(panelId)) {
                const panel = markOwned(document.createElement('div'), entry.id);
                panel.id = panelId;
                panel.className = 'tabContent pageTabContent';
                panel.setAttribute('data-index', String(entry.index));
                root.appendChild(panel);
                entry.onMount(panel);
                if (!isCurrent()) return;
            }
            ensureDiscoverable(entry);
        }
        syncDeepLink();
    };

    const scheduleInject = (): void => {
        if (!isCurrent() || injectFrame !== null) return;
        injectFrame = window.requestAnimationFrame(() => {
            injectFrame = null;
            if (!isCurrent()) return;
            ensureInjected();
        });
    };

    const bodySubscription = JC.core.dom!.onBodyMutation(`native-tabs-${generation}`, scheduleInject);
    const unsubscribeNavigation = JC.core.navigation!.onNavigate(scheduleInject);

    const api: NativeTabsApi = Object.freeze({
        register(id: string, title: string, onMount: (panel: HTMLElement) => void, icon?: string): void {
            if (!isCurrent() || entries.some((entry) => entry.id === id)) return;
            entries.push({ id, title, onMount, icon });
            scheduleInject();
        },
        unregister(id: string): void {
            if (!isCurrent()) return;
            const index = entries.findIndex((entry) => entry.id === id);
            if (index >= 0) entries.splice(index, 1);
            removeOwnedEntryNodes(id);
            removeGroupIfEmpty();
        },
    });

    return {
        api,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            if (currentGeneration === generation) currentGeneration = 0;
            if (injectFrame !== null) window.cancelAnimationFrame(injectFrame);
            injectFrame = null;
            bodySubscription.unsubscribe();
            unsubscribeNavigation();
            for (const cleanup of [...animationCleanups]) cleanup();
            for (const node of [...ownedNodes].reverse()) node.remove();
            ownedNodes.clear();
            ownedEntryNodes.clear();
            entries.length = 0;
            animatedLinkIds.clear();
        },
    };
}

/** Loader-owned activation; the public facade remains frozen across epochs. */
export function activateNativeTabs(scope: FeatureScope): void {
    if (!scope.isCurrent()) return;
    if (JC.nativeTabs !== stableApi.facade) {
        JC.nativeTabs = stableApi.facade;
    }
    const runtime = createRuntime(scope);
    const uninstallDelegate = stableApi.install(runtime.api);
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        runtime.dispose();
        uninstallDelegate();
    };
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    scope.track(dispose);
}

export const nativeTabsFacade = stableApi.facade;
