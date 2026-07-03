// src/extras/plugin-icons.ts
// Replaces default plugin icons with custom icons on the dashboard

import { JE as JEBase } from '../globals';
import type { LifecycleApi, LifecycleHandle, NavigationApi } from '../types/je';

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
const JE = JEBase as typeof JEBase & {
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
let customPluginsCache: CustomPlugin[] | null = null;
let lastProcessedPluginsCount = 0;

// Get custom plugins from server configuration
async function getCustomPlugins(): Promise<CustomPlugin[]> {
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
    if (customPluginsCache) {
        return customPluginsCache;
    }

    try {
        // Wait for ApiClient to be available
        if (typeof ApiClient === 'undefined') {
            return [];
        }

        // Use the same API pattern as the configuration page
        const pluginId = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';
        const getPluginConfiguration = ApiClient.getPluginConfiguration as (id: string) => Promise<{ CustomPluginLinks?: string }>;
        const config = await getPluginConfiguration(pluginId);
        const customLinksText = config.CustomPluginLinks || '';
        customPluginsCache = parseCustomPluginLinks(customLinksText);
        return customPluginsCache;
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
    const existingLink = pluginsSection.querySelector(`[data-jellyfin-enhanced-plugin-id="${plugin.id}"]`);
    if (existingLink) return;

    // Get current base URL
    const baseUrl = window.location.origin + window.location.pathname;
    const pluginUrl = `${baseUrl}#/configurationpage?name=${encodeURIComponent(plugin.name)}`;

    // Create the link element
    const link = document.createElement('a');
    link.className = 'MuiButtonBase-root MuiListItemButton-root MuiListItemButton-gutters MuiListItemButton-root MuiListItemButton-gutters css-yknuxp';
    link.tabIndex = 0;
    link.href = pluginUrl;
    // Use data attribute similar to KefinTweaks pattern
    link.setAttribute('data-jellyfin-enhanced-plugin-id', plugin.id);

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
        oldIcon.replaceWith(iconElement);
        return true;
    }
    return false;
}

async function processPluginIcons(): Promise<void> {
    if (isProcessing) return;
    isProcessing = true;

    try {
        // Find the plugins section regardless of page
        const pluginsSection = document.querySelector('ul[aria-labelledby="plugins-subheader"]');
        if (!pluginsSection) {
            return;
        }

        // Count current plugins to detect changes
        const currentPluginsCount = pluginsSection.querySelectorAll('a[href*="configurationpage"]').length;

        // Only clean up test links to avoid flickering
        const existingTestLinks = pluginsSection.querySelectorAll('[data-jellyfin-enhanced-plugin-id^="test-"]');
        existingTestLinks.forEach(link => link.remove());

        // Replace built-in plugin icons
        const iconConfigs: IconConfig[] = [
            {
                selector: 'a[href*="Jellyfin%20Enhanced"]',
                type: 'image',
                src: 'https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico',
                alt: 'Jellyfin Enhanced'
            },
            {
                selector: 'a[href*="JavaScript%20Injector"]',
                type: 'image',
                src: 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/javascript.svg',
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
                selector: 'a[href*="Segment%Editor"]',
                type: 'material',
                icon: 'content_cut'
            },
            {
                selector: 'a[href*="Jellyfin%20Helper"]',
                type: 'image',
                src: 'https://cdn.jsdelivr.net/gh/JellyPlugins/jellyfin-helper@2.0.0.2/media/favicon.ico',
                alt: 'Jellyfin Helper'
            }
        ];

        iconConfigs.forEach(config => {
            replacePluginIcon(config.selector, config);
        });

        // Add custom user-defined plugins
        const customPlugins = await getCustomPlugins();
        customPlugins.forEach(plugin => {
            createCustomPluginLink(plugin);
        });

        lastProcessedPluginsCount = currentPluginsCount;
    } finally {
        isProcessing = false;
    }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Monitor for changes similar to KefinTweaks approach
function startMonitoring(): void {
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
            debounceTimer = setTimeout(() => { void processPluginIcons(); }, 100);
        }
    };

    if (JE?.helpers?.onBodyMutation) {
        observer = JE.helpers.onBodyMutation('plugin-icons', callback);
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
    }
    if (lifecycle) {
        lifecycle.teardown();
        lifecycle = null;
    }
}

// Handle page navigation via the shared deduplicated pipeline (covers
// hashchange, popstate and pushState navs). Tracked through a lifecycle
// handle so stopMonitoring() can remove it.
function setupNavigationListener(): void {
    lifecycle = JE.core.lifecycle.register('plugin-icons');
    lifecycle.track(JE.core.navigation.onNavigate(() => {
        const hash = window.location.hash;
        // Process plugin icons when navigating to dashboard, settings, or configuration pages
        if (hash.includes('#/dashboard') || hash.includes('#/settings') || hash.includes('#/configurationpage')) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => { void processPluginIcons(); }, 300);
        }
    }));
}

function initialize(): void {
    // Inject CSS for Material Icons
    injectCSS();
    setupNavigationListener();

    // Wait for ApiClient to be available
    let retries = 0;
    const maxRetries = 10;

    const tryInitialize = async (): Promise<void> => {
        if (typeof ApiClient !== 'undefined') {
            await processPluginIcons();
            startMonitoring();
        } else if (retries < maxRetries) {
            retries++;
            setTimeout(() => { void tryInitialize(); }, 500);
        } else {
            console.warn('ApiClient not available after retries, custom plugin links will not work');
            // Still set up the basic icon replacement and monitoring
            await processPluginIcons();
            startMonitoring();
        }
    };

    void tryInitialize();
}

JE.initializePluginIcons = initialize;
JE.stopPluginIconsMonitoring = stopMonitoring;

// Expose API for refreshing custom plugins
JE.customPlugins = {
    refresh: () => {
        // Clear cache to force reload
        customPluginsCache = null;
        void processPluginIcons();
    }
};
