// src/extras/plugin-icons.ts
// Replaces default plugin icons with custom icons on the dashboard

import { JC as JEBase } from '../globals';
import { assetUrl } from '../core/asset-urls';
import { routeHref } from '../core/navigation';
import { createStableMethodFacade } from '../core/feature-loader';
import type { IdentityContext, LifecycleApi, LifecycleHandle, NavigationApi } from '../types/jc';

/** Icon override descriptor for a built-in plugin link. */
interface IconConfig {
    selector: string;
    type: 'image' | 'material';
    src?: string;
    alt?: string;
    icon?: string;
}

/** A user-defined custom plugin link parsed from admin config. */
interface CustomPlugin {
    name: string;
    icon: string;
    iconType: string;
    id: string;
}

/**
 * Local view of the shared namespace adding the public members this module
 * OWNS plus the core surfaces it uses (core executes first in the bundle).
 */
const JC = JEBase as typeof JEBase & {
    initializePluginIcons?: () => void;
    stopPluginIconsMonitoring?: () => void;
    customPlugins?: { refresh: () => void };
    core: { navigation: NavigationApi; lifecycle: LifecycleApi };
    helpers?: { onBodyMutation?: (id: string, cb: (mutations: MutationRecord[]) => void) => { unsubscribe(): void } };
};

function injectCSS(): void {
    const styleId = 'plugin-icons-material';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
    .plugin-material-icon {
      font-family: 'Material Icons';
      font-size: 24px;
      line-height: 1;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      -webkit-font-smoothing: antialiased;
    }
  `;
    document.head.appendChild(style);
}

let isProcessing = false;
let observer: { unsubscribe(): void } | null = null;
let lifecycle: LifecycleHandle | null = null;
let customPluginsCache: { context: IdentityContext; value: CustomPlugin[] } | null = null;
let generation = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const replacedIcons = new WeakMap<Element, Node>();

function isActive(context: IdentityContext, expectedGeneration: number): boolean {
    return generation === expectedGeneration && JC.identity.isCurrent(context);
}

// Get custom plugins from server configuration
async function getCustomPlugins(context: IdentityContext, expectedGeneration: number): Promise<CustomPlugin[]> {
    // Check for test data first (used by configuration page test button)
    const testLinks = (window as { testCustomPluginLinks?: Array<{ name: string; icon: string }> }).testCustomPluginLinks;
    if (testLinks) {
        const testData = testLinks.map((plugin, index) => ({
            name: plugin.name,
            icon: plugin.icon,
            iconType: 'material',
            id: `test-${index}`
        }));
        return testData;
    }

    // Return cached data if available
    if (customPluginsCache && JC.identity.isCurrent(customPluginsCache.context)) {
        return customPluginsCache.value;
    }

    try {
        // Wait for ApiClient to be available
        if (typeof ApiClient === 'undefined') {
            return [];
        }

        // Use the same API pattern as the configuration page
        const pluginId = '9ffa12bc-f4b5-406c-ab1d-d575acbeea7b';
        const getPluginConfiguration = ApiClient.getPluginConfiguration as (id: string) => Promise<{ CustomPluginLinks?: string }>;
        const config = await getPluginConfiguration(pluginId);
        if (!isActive(context, expectedGeneration)) return [];
        const customLinksText = config.CustomPluginLinks || '';
        const value = parseCustomPluginLinks(customLinksText);
        customPluginsCache = { context, value };
        return value;
    } catch (e) {
        console.warn('Failed to load custom plugins from server:', e);
    }
    return [];
}

// Parse custom plugin links text into plugin objects
function parseCustomPluginLinks(text: string): CustomPlugin[] {
    if (!text || !text.trim()) return [];

    const plugins: CustomPlugin[] = [];
    const lines = text.split('\n');

    lines.forEach((line, index) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        const parts = trimmedLine.split('|').map(part => part.trim());
        if (parts.length >= 2) {
            plugins.push({
                name: parts[0],
                icon: parts[1],
                iconType: 'material',
                id: `custom-${index}`
            });
        }
    });

    return plugins;
}

function createCustomPluginLink(plugin: CustomPlugin): void {
    const pluginsSection = document.querySelector('ul[aria-labelledby="plugins-subheader"]');
    if (!pluginsSection) return;

    // Check if link already exists using data attribute (similar to KefinTweaks approach)
    const existingLink = pluginsSection.querySelector(`[data-jellyfin-canopy-plugin-id="${plugin.id}"]`);
    if (existingLink) return;

    const pluginUrl = routeHref('configurationpage', { name: plugin.name });

    // Create the link element
    const link = document.createElement('a');
    link.className = 'MuiButtonBase-root MuiListItemButton-root MuiListItemButton-gutters MuiListItemButton-root MuiListItemButton-gutters css-yknuxp';
    link.tabIndex = 0;
    link.href = pluginUrl;
    // Use data attribute similar to KefinTweaks pattern
    link.setAttribute('data-jellyfin-canopy-plugin-id', plugin.id);

    // Create icon container
    const iconDiv = document.createElement('div');
    iconDiv.className = 'MuiListItemIcon-root css-5pks8q';

    // Create material icon
    const iconElement = document.createElement('span');
    iconElement.className = 'material-icons plugin-material-icon';
    iconElement.textContent = plugin.icon;
    iconElement.setAttribute('aria-hidden', 'true');

    iconDiv.appendChild(iconElement);

    // Create text container
    const textDiv = document.createElement('div');
    textDiv.className = 'MuiListItemText-root css-t3p1a1';

    const textSpan = document.createElement('span');
    textSpan.className = 'MuiTypography-root MuiTypography-body1 MuiListItemText-primary css-pl8nxc';
    textSpan.textContent = plugin.name;

    textDiv.appendChild(textSpan);

    // Assemble the link
    link.appendChild(iconDiv);
    link.appendChild(textDiv);

    // Insert the link (append to end of plugins section)
    pluginsSection.appendChild(link);
}

function replacePluginIcon(selector: string, iconConfig: IconConfig): boolean {
    const link = document.querySelector(selector);
    if (!link) return false;

    const iconDiv = link.querySelector('.MuiListItemIcon-root');
    if (!iconDiv) return false;

    // Already replaced on a previous pass - skip.
    if (iconDiv.querySelector('.plugin-material-icon, .plugin-custom-icon-img')) return false;

    // Jellyfin 12 dropped the <Folder /> SVG default icon in favor of MUI's
    // <Icon> ligature-font wrapper (a <span class="material-icons">folder</span>,
    // no svg at all), so match either shape rather than requiring an svg.
    const oldIcon = iconDiv.querySelector('svg, .material-icons');
    if (!oldIcon) return false;

    let iconElement: HTMLElement | undefined;
    if (iconConfig.type === 'image') {
        const img = document.createElement('img');
        img.src = iconConfig.src!;
        img.style.width = '24px';
        img.style.height = '24px';
        img.alt = iconConfig.alt!;
        img.className = 'plugin-custom-icon-img';
        iconElement = img;
    } else if (iconConfig.type === 'material') {
        iconElement = document.createElement('span');
        iconElement.className = 'material-icons plugin-material-icon';
        iconElement.textContent = iconConfig.icon!;
        iconElement.setAttribute('aria-hidden', 'true');
    }

    if (iconElement) {
        iconElement.setAttribute('data-jc-plugin-icon-owned', 'true');
        replacedIcons.set(iconElement, oldIcon.cloneNode(true));
        oldIcon.replaceWith(iconElement);
        return true;
    }
    return false;
}

async function processPluginIcons(
    context = JC.identity.capture(),
    expectedGeneration = generation
): Promise<void> {
    if (!context || !isActive(context, expectedGeneration)) return;
    if (isProcessing) return;
    isProcessing = true;

    try {
        // Find the plugins section regardless of page
        const pluginsSection = document.querySelector('ul[aria-labelledby="plugins-subheader"]');
        if (!pluginsSection) {
            return;
        }

        // Only clean up test links to avoid flickering
        const existingTestLinks = pluginsSection.querySelectorAll('[data-jellyfin-canopy-plugin-id^="test-"]');
        existingTestLinks.forEach(link => link.remove());

        // Replace built-in plugin icons.
        // PERF(R6): no remote assets — image icons served from the local asset cache.
        const iconConfigs: IconConfig[] = [
            {
                selector: 'a[href*="Jellyfin%20Canopy"]',
                type: 'image',
                // The plugin's own entry carries the Canopy brand mark (embedded
                // asset), not the legacy jellyfish glyph.
                src: assetUrl('branding/canopy-mark.svg'),
                alt: 'Jellyfin Canopy'
            },
            {
                selector: 'a[href*="JavaScript%20Injector"]',
                type: 'image',
                src: assetUrl('icons/javascript.svg'),
                alt: 'JavaScript'
            },
            {
                selector: 'a[href*="Intro%20Skipper"]',
                type: 'material',
                icon: 'redo'
            },
            {
                selector: 'a[href*="reports"]',
                type: 'material',
                icon: 'insert_chart_outlined'
            },
            {
                selector: 'a[href*="Jellysleep"]',
                type: 'material',
                icon: 'dark_mode'
            },
            {
                selector: 'a[href*="Home%20Screen%20Sections"]',
                type: 'material',
                icon: 'dashboard_customize'
            },
            {
                selector: 'a[href*="File%20Transformation"]',
                type: 'material',
                icon: 'file_open'
            },
            {
                selector: 'a[href*="Newsletters"]',
                type: 'material',
                icon: 'newspaper'
            },
            {
                selector: 'a[href*="Segment%20Editor"]',
                type: 'material',
                icon: 'content_cut'
            },
            {
                selector: 'a[href*="Jellyfin%20Helper"]',
                type: 'image',
                src: assetUrl('icons/jellyfin-helper-favicon.ico'),
                alt: 'Jellyfin Helper'
            }
        ];

        iconConfigs.forEach(config => {
            replacePluginIcon(config.selector, config);
        });

        // Add custom user-defined plugins
        const customPlugins = await getCustomPlugins(context, expectedGeneration);
        if (!isActive(context, expectedGeneration)) return;
        customPlugins.forEach(plugin => {
            createCustomPluginLink(plugin);
        });

    } finally {
        if (generation === expectedGeneration) isProcessing = false;
    }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Monitor for changes similar to KefinTweaks approach
function startMonitoring(context: IdentityContext, expectedGeneration: number): void {
    if (observer) return;

    const callback = (mutations: MutationRecord[]): void => {
        let shouldProcess = false;

        mutations.forEach((mutation) => {
            // Check if plugins section was modified
            if (mutation.type === 'childList') {
                const target = mutation.target as Element;

                // Check if we're in the plugins section or its parent
                if (target.matches && (
                    target.matches('ul[aria-labelledby="plugins-subheader"]') ||
                    target.querySelector('ul[aria-labelledby="plugins-subheader"]') ||
                    target.closest('ul[aria-labelledby="plugins-subheader"]')
                )) {
                    shouldProcess = true;
                }

                // Check for dashboard/settings page container changes
                if (target === document.body || (target.classList && (
                    target.classList.contains('dashboardDocument') ||
                    target.classList.contains('settingsDocument') ||
                    target.classList.contains('dashboardPage')
                ))) {
                    shouldProcess = true;
                }
            }
        });

        if (shouldProcess) {
            // Debounce the processing
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void processPluginIcons(context, expectedGeneration);
            }, 100);
        }
    };

    if (JC?.helpers?.onBodyMutation) {
        observer = JC.helpers.onBodyMutation('plugin-icons', callback);
    } else {
        const mo = new MutationObserver(callback);
        mo.observe(document.body, { childList: true, subtree: true });
        observer = { unsubscribe() { mo.disconnect(); } };
    }
}

function stopMonitoring(): void {
    if (observer) {
        observer.unsubscribe();
        observer = null;
    }
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (lifecycle) {
        lifecycle.teardown();
        lifecycle = null;
    }
}

// Handle page navigation via the shared deduplicated pipeline (covers
// hashchange, popstate and pushState navs). Tracked through a lifecycle
// handle so stopMonitoring() can remove it.
function setupNavigationListener(context: IdentityContext, expectedGeneration: number): void {
    lifecycle = JC.core.lifecycle.register('plugin-icons');
    lifecycle.track(JC.core.navigation.onNavigate(() => {
        const hash = window.location.hash;
        // Process plugin icons when navigating to dashboard, settings, or configuration pages
        if (hash.includes('#/dashboard') || hash.includes('#/settings') || hash.includes('#/configurationpage')) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void processPluginIcons(context, expectedGeneration);
            }, 300);
        }
    }));
}

function restoreOwnedUi(): void {
    document.querySelectorAll('[data-jc-plugin-icon-owned="true"]').forEach((icon) => {
        const original = replacedIcons.get(icon);
        if (original) icon.replaceWith(original);
        else icon.remove();
    });
    document.querySelectorAll('[data-jellyfin-canopy-plugin-id]').forEach((link) => link.remove());
}

function initialize(): void {
    stopMonitoring();
    const context = JC.identity.capture();
    if (!context) return;
    const expectedGeneration = ++generation;
    isProcessing = false;

    // Inject CSS for Material Icons
    injectCSS();
    setupNavigationListener(context, expectedGeneration);

    // Wait for ApiClient to be available
    let retries = 0;
    const maxRetries = 10;

    const tryInitialize = async (): Promise<void> => {
        if (!isActive(context, expectedGeneration)) return;
        if (typeof ApiClient !== 'undefined') {
            await processPluginIcons(context, expectedGeneration);
            if (isActive(context, expectedGeneration)) startMonitoring(context, expectedGeneration);
        } else if (retries < maxRetries) {
            retries++;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                void tryInitialize();
            }, 500);
        } else {
            console.warn('ApiClient not available after retries, custom plugin links will not work');
            // Still set up the basic icon replacement and monitoring
            await processPluginIcons(context, expectedGeneration);
            if (isActive(context, expectedGeneration)) startMonitoring(context, expectedGeneration);
        }
    };

    void tryInitialize();
}

function resetPluginIcons(): void {
    generation++;
    isProcessing = false;
    customPluginsCache = null;
    stopMonitoring();
    restoreOwnedUi();
    document.getElementById('plugin-icons-material')?.remove();
}

const pluginIconsApi = {
    initialize,
    stopMonitoring,
    refresh: () => {
        // Clear cache to force reload
        customPluginsCache = null;
        void processPluginIcons();
    }
};

const stablePluginIcons = createStableMethodFacade<typeof pluginIconsApi>({
    initialize() {},
    stopMonitoring() {},
    refresh() {},
});

const customPluginsFacade = Object.freeze({
    refresh: (): void => stablePluginIcons.facade.refresh(),
});

/** Publish stable compatibility facades for one loader-owned activation. */
export function installPluginIcons(): () => void {
    const uninstall = stablePluginIcons.install(pluginIconsApi);
    JC.initializePluginIcons = stablePluginIcons.facade.initialize;
    JC.stopPluginIconsMonitoring = stablePluginIcons.facade.stopMonitoring;
    JC.customPlugins = customPluginsFacade;
    const unregisterReset = JC.identity.registerReset('plugin-icons', resetPluginIcons);
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetPluginIcons();
        unregisterReset();
        uninstall();
    };
}

/** Start the installed feature without resolving through its global facade. */
export function initializePluginIcons(): void {
    pluginIconsApi.initialize();
}
