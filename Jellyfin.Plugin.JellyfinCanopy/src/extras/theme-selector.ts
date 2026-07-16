// src/extras/theme-selector.ts
// Theme selector for Jellyfish theme color variants

import { JC as JEBase } from '../globals';
import { themeCssUrl } from '../core/asset-urls';
import { onBodyMutation } from '../core/dom-observer';
import { createStableMethodFacade } from '../core/feature-loader';
import { escapeHtml } from '../core/ui-kit';
import type { IdentityChange, IdentityContext } from '../types/jc';

/**
 * Local view of the shared namespace adding the public member this module
 * OWNS plus the legacy helper it optionally uses.
 */
const JC = JEBase as typeof JEBase & {
    initializeThemeSelector?: () => void;
};

const THEMES: Readonly<Record<string, string>> = Object.freeze({
    'Default': '',
    'Aurora': 'aurora.css',
    'Banana': 'banana.css',
    'Coal': 'coal.css',
    'Coral': 'coral.css',
    'Forest': 'forest.css',
    'Grass': 'grass.css',
    'Jellyblue': 'jellyblue.css',
    'Jellyflix': 'jellyflix.css',
    'Jellypurple': 'jellypurple.css',
    'Lavender': 'lavender.css',
    'Midnight': 'midnight.css',
    'Mint': 'mint.css',
    'Ocean': 'ocean.css',
    'Peach': 'peach.css',
    'Watermelon': 'watermelon.css'
});

const RANDOM_THEME_DEFAULT = false;
const CSS_STYLE_ID = 'jellyfin-theme-selector-css';
const SELECTOR_ID = 'jellyfin-theme-selector';
const INIT_DELAY = 250;
const NOTIFICATION_DELAY = 1000;
const DEBOUNCE_DELAY = 100;
const TRANSITION_DURATION = 300;
const STORAGE_PREFIX = 'jc-theme:';
const STORAGE_MIGRATION_KEY = 'jc-theme-storage-v2-migrated';
const LEGACY_NOTIFICATION_KEY = 'jellyfin-theme-applied';

// PERF(R6): no remote assets — Jellyfish theme CSS served from the local asset
// cache (with its logo/background image urls rewritten to local copies).
const getThemeImport = (filename: string): string => filename ? `@import url("${themeCssUrl(filename)}");` : '';

const getStorageKey = (context: IdentityContext, key: string): string =>
    `${STORAGE_PREFIX}${context.serverId}:${context.userId}:${key}`;

// Jellyfish consumes this compatibility key while booting its stylesheet. It
// is only a mirror of the current server-scoped value; the canonical value
// above prevents equal user ids on two Jellyfin servers from sharing a theme.
const getCompatibilityKey = (context: IdentityContext, key: string): string => `${context.userId}-${key}`;

const getLocalStorageValue = (context: IdentityContext, key: string, defaultValue: string | null = null): string | null => {
    const result = JC.storage.local.read('theme-selector', getStorageKey(context, key), `theme-${key}`);
    return result.state === 'Valid' ? result.value : defaultValue;
};

const setLocalStorageValue = (context: IdentityContext, key: string, value: string): boolean => {
    const canonical = JC.storage.local.write('theme-selector', getStorageKey(context, key), value, `theme-${key}`);
    if (canonical.state !== 'Valid') return false;
    if (key === 'customCss' && JC.identity.isCurrent(context)) {
        return JC.storage.local.write(
            'theme-selector', getCompatibilityKey(context, key), value, 'compatibility-theme',
        ).state === 'Valid';
    }
    return true;
};

const removeLocalStorageValue = (context: IdentityContext, key: string): boolean => {
    const canonical = JC.storage.local.remove('theme-selector', getStorageKey(context, key), `theme-${key}`);
    if (key === 'customCss' && JC.identity.isCurrent(context)) {
        const compatibility = JC.storage.local.remove(
            'theme-selector', getCompatibilityKey(context, key), 'compatibility-theme',
        );
        return canonical.state === 'Valid' && compatibility.state === 'Valid';
    }
    return canonical.state === 'Valid';
};

// --- Random Theme Functions ---
const isRandomThemeEnabled = (context: IdentityContext): boolean => {
    const setting = getLocalStorageValue(context, 'randomThemeEnabled');
    return setting === null ? RANDOM_THEME_DEFAULT : setting === 'true';
};

const setRandomThemeEnabled = (context: IdentityContext, isEnabled: boolean): void => {
    setLocalStorageValue(context, 'randomThemeEnabled', String(isEnabled));
};

const getLastRandomDate = (context: IdentityContext): string | null => getLocalStorageValue(context, 'lastRandomThemeDate');

const setLastRandomDate = (context: IdentityContext, date: string): void => {
    setLocalStorageValue(context, 'lastRandomThemeDate', date);
};

const getTodayDate = (): string => new Date().toISOString().split('T')[0];

// --- CSS Injection ---
const injectCustomCss = (): void => {
    if (document.getElementById(CSS_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = CSS_STYLE_ID;
    style.textContent = `
        #theme-selector-body {
            display: flex !important;
            align-items: center;
            justify-content: flex-start;
            flex-direction: row;
            flex-wrap: wrap;
            gap: 1em;
            padding: .4em .75em;
        }
        #theme-selector-select {
            max-width: 200px !important;
            min-width: 150px !important;
            transition: opacity ${TRANSITION_DURATION}ms ease;
        }
        #theme-selector-select:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #random-theme-button {
            padding: 0.5em 0.5em !important;
            height: auto !important;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.3em;
            background-color: transparent;
            border-radius: 10px;
            transition: background-color 0.3s ease, opacity ${TRANSITION_DURATION}ms ease;
        }
        #random-theme-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #random-theme-button.active {
            background-color: #4CAF50;
            color: white;
        }
        .theme-applying {
            opacity: 0;
            transition: opacity ${TRANSITION_DURATION}ms ease;
        }
        .theme-applied {
            opacity: 1;
            transition: opacity ${TRANSITION_DURATION}ms ease;
        }
    `;
    document.head.appendChild(style);
    console.log('🪼🎨Jellyfish Theme Selector :  Custom CSS injected');
};



// --- Theme Management ---
const getCurrentTheme = (context: IdentityContext): string => getLocalStorageValue(context, 'customCss', '') || '';

const setTheme = (context: IdentityContext, themeFilename: string, themeName = 'Default'): void => {
    if (!JC.identity.isCurrent(context)) return;
    const themeValue = getThemeImport(themeFilename);
    if (themeValue) {
        setLocalStorageValue(context, 'customCss', themeValue);
        console.log(`🪼🎨Jellyfish Theme Selector :  Theme set to: ${themeName}`);
    } else {
        removeLocalStorageValue(context, 'customCss');
        console.log('🪼🎨Jellyfish Theme Selector :  Theme cleared (default)');
    }
};

const getNotificationKey = (context: IdentityContext): string =>
    `${LEGACY_NOTIFICATION_KEY}:${context.serverId}:${context.userId}`;

/**
 * Adopt the old user-only keys once, for the identity active during upgrade.
 * Every later identity uses server-scoped keys exclusively. This avoids an A
 * compatibility mirror being mistaken for B's preference when user ids happen
 * to match across servers.
 */
const migrateLegacyStorageOnce = (context: IdentityContext): void => {
    const migration = JC.storage.local.read('theme-selector', STORAGE_MIGRATION_KEY, 'migration-marker');
    if (migration.state === 'Missing' || (migration.state === 'Valid' && migration.value !== 'true')) {
        let complete = true;
        for (const key of ['customCss', 'randomThemeEnabled', 'lastRandomThemeDate']) {
            const scopedKey = getStorageKey(context, key);
            const scoped = JC.storage.local.read('theme-selector', scopedKey, `theme-${key}`);
            if (scoped.state === 'Missing') {
                const legacy = JC.storage.local.read(
                    'theme-selector', getCompatibilityKey(context, key), `legacy-theme-${key}`,
                );
                if (legacy.state === 'Valid') {
                    complete = JC.storage.local.write(
                        'theme-selector', scopedKey, legacy.value, `theme-${key}`,
                    ).state === 'Valid' && complete;
                } else if (legacy.state !== 'Missing') complete = false;
            } else if (scoped.state !== 'Valid') complete = false;
        }
        if (complete) JC.storage.local.write('theme-selector', STORAGE_MIGRATION_KEY, 'true', 'migration-marker');
    }

    if (migration.state !== 'Valid' && migration.state !== 'Missing') return;
    // Keep Jellyfish's boot-time compatibility key synchronized with the
    // current canonical value. A missing B value removes A's old mirror.
    const currentTheme = getCurrentTheme(context);
    const compatibilityKey = getCompatibilityKey(context, 'customCss');
    if (currentTheme) JC.storage.local.write('theme-selector', compatibilityKey, currentTheme, 'compatibility-theme');
    else JC.storage.local.remove('theme-selector', compatibilityKey, 'compatibility-theme');
};

// --- Notifications ---
const showNotification = (message: string): void => {
    try {
        const win = window as { Dashboard?: { alert?: (msg: string) => void }; require?: (deps: string[], cb: (toast: (msg: string) => void) => void) => void };
        if (win.Dashboard?.alert) {
            win.Dashboard.alert(message);
        } else if (win.require) {
            win.require(['toast'], (toast) => toast(message));
        } else {
            console.log(`🪼🎨Jellyfish Theme Selector :  Notification: ${message}`);
        }
    } catch (e) {
        console.error('🪼🎨Jellyfish Theme Selector :  Failed to show notification:', e);
    }
};

const checkPostRefreshNotification = (context: IdentityContext, expectedGeneration: number): void => {
    const notificationKey = getNotificationKey(context);
    let pendingNotification = JC.storage.session.read(
        'theme-selector', notificationKey, 'pending-notification',
    ).value;
    // Compatibility with a reload initiated by a pre-upgrade bundle. The
    // unscoped value is consumed once and cannot survive an SPA switch.
    if (!pendingNotification) {
        pendingNotification = JC.storage.session.read(
            'theme-selector', LEGACY_NOTIFICATION_KEY, 'legacy-notification',
        ).value;
    }
    JC.storage.session.remove('theme-selector', LEGACY_NOTIFICATION_KEY, 'legacy-notification');
    if (pendingNotification) {
        JC.storage.session.remove('theme-selector', notificationKey, 'pending-notification');
        notificationTimer = window.setTimeout(() => {
            notificationTimer = null;
            if (isActive(context, expectedGeneration)) {
                showNotification(`Theme applied: ${escapeHtml(pendingNotification)}`);
            }
        }, NOTIFICATION_DELAY);
    }
};

// --- Random Theme Logic ---
const applyRandomThemeIfNeeded = (context: IdentityContext, expectedGeneration: number): void => {
    if (!isActive(context, expectedGeneration) || !isRandomThemeEnabled(context)) return;

    const today = getTodayDate();
    const lastDate = getLastRandomDate(context);

    if (today !== lastDate) {
        console.log('🪼🎨Jellyfish Theme Selector :  New day detected! Applying a random theme.');
        const availableThemes = Object.keys(THEMES).filter(name => name !== 'Default');
        const randomThemeName = availableThemes[Math.floor(Math.random() * availableThemes.length)];
        const randomThemeFilename = THEMES[randomThemeName];

        setTheme(context, randomThemeFilename, randomThemeName);
        setLastRandomDate(context, today);

        JC.storage.session.write(
            'theme-selector',
            getNotificationKey(context),
            `Random Daily (${randomThemeName})`,
            'pending-notification',
        );
        if (isActive(context, expectedGeneration)) window.location.reload();
    } else {
        console.log('🪼🎨Jellyfish Theme Selector :  Random theme already applied for today.');
    }
};

// --- UI Creation ---
const createIcon = (iconName: string, className = 'material-icons'): HTMLElement => {
    const icon = document.createElement('span');
    icon.className = className;
    icon.textContent = iconName;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
};

const createThemeSelect = (
    context: IdentityContext,
    expectedGeneration: number,
    currentThemeValue: string
): HTMLSelectElement => {
    const select = document.createElement('select');
    select.setAttribute('is', 'emby-select');
    select.className = 'emby-select-withcolor emby-select';
    select.id = 'theme-selector-select';
    select.setAttribute('aria-label', 'Select theme');
    select.removeAttribute('label');

    let selectedThemeName = 'Default';
    for (const [name, filename] of Object.entries(THEMES)) {
        const themeValue = getThemeImport(filename);
        if (themeValue === currentThemeValue) {
            selectedThemeName = name;
            break;
        }
    }

    Object.keys(THEMES).forEach(themeName => {
        const option = document.createElement('option');
        option.value = themeName;
        option.textContent = themeName;
        if (themeName === selectedThemeName) option.selected = true;
        select.appendChild(option);
    });

    select.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isActive(context, expectedGeneration)) return;

        const newThemeName = (e.target as HTMLSelectElement).value;
        const newThemeFilename = THEMES[newThemeName];

        // Disable controls during transition
        select.disabled = true;
        const randomButton = document.getElementById('random-theme-button') as HTMLButtonElement | null;
        if (randomButton) randomButton.disabled = true;

        // Add fade-out class
        document.body.classList.add('theme-applying');

        // Save to localStorage
        setTheme(context, newThemeFilename, newThemeName);

        // Store notification for after reload
        JC.storage.session.write(
            'theme-selector', getNotificationKey(context), newThemeName, 'pending-notification',
        );

        // Wait for fade-out transition, then reload
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = window.setTimeout(() => {
            reloadTimer = null;
            if (!isActive(context, expectedGeneration)) return;
            console.log(`🪼🎨Jellyfish Theme Selector :  Reloading to apply theme: ${newThemeName}`);
            window.location.reload();
        }, TRANSITION_DURATION);
    });

    return select;
};

const createRandomButton = (context: IdentityContext, expectedGeneration: number): HTMLButtonElement => {
    const button = document.createElement('button');
    button.setAttribute('is', 'emby-button');
    button.className = 'emby-button';
    button.id = 'random-theme-button';
    button.setAttribute('aria-label', 'Toggle random daily theme');
    button.setAttribute('title', 'Random daily theme');

    const icon = createIcon('shuffle');
    const text = document.createElement('span');
    text.style.fontSize = '0.85em';

    const updateButtonState = (): void => {
        const isEnabled = isRandomThemeEnabled(context);
        button.classList.toggle('active', isEnabled);
        text.textContent = isEnabled ? 'Daily' : '';
        button.setAttribute('aria-pressed', isEnabled.toString());
    };

    button.appendChild(icon);
    button.appendChild(text);
    updateButtonState();

    button.addEventListener('click', () => {
        if (!isActive(context, expectedGeneration)) return;
        const newState = !isRandomThemeEnabled(context);
        setRandomThemeEnabled(context, newState);
        showNotification(`Random daily theme turned ${newState ? 'ON' : 'OFF'}.`);
        console.log(`🪼🎨Jellyfish Theme Selector :  Random daily theme set to: ${newState}`);
        updateButtonState();

        if (newState) {
            applyRandomThemeIfNeeded(context, expectedGeneration);
        }
    });

    return button;
};

const createThemeSelector = (context: IdentityContext, expectedGeneration: number): HTMLElement => {
    const container = document.createElement('div');
    container.className = 'theme-selector-container listItem-border';
    container.id = SELECTOR_ID;

    const listItem = document.createElement('div');
    listItem.className = 'listItem';
    listItem.id = 'theme-selector-item';

    const icon = createIcon('palette', 'material-icons listItemIcon listItemIcon-transparent');
    icon.id = 'theme-selector-icon';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'listItemBody';
    contentDiv.id = 'theme-selector-body';

    const textLabel = document.createElement('div');
    textLabel.className = 'listItemBodyText';
    textLabel.id = 'theme-selector-label';
    textLabel.textContent = 'Theme';

    const currentThemeValue = getCurrentTheme(context);
    const select = createThemeSelect(context, expectedGeneration, currentThemeValue);
    const randomButton = createRandomButton(context, expectedGeneration);

    contentDiv.appendChild(textLabel);
    contentDiv.appendChild(randomButton);
    contentDiv.appendChild(select);
    listItem.appendChild(icon);
    listItem.appendChild(contentDiv);
    container.appendChild(listItem);

    return container;
};

// --- DOM Injection ---
const injectThemeSelector = (context: IdentityContext, expectedGeneration: number): boolean => {
    try {
        if (!isActive(context, expectedGeneration)) return false;
        const targetDiv = document.querySelector('.verticalSection .headerUsername');
        if (!targetDiv) return false;

        const parentSection = targetDiv.closest('.verticalSection');
        if (!parentSection) return false;

        if (!isActive(context, expectedGeneration)) return false;

        console.log('🪼🎨Jellyfish Theme Selector :  Creating theme selector element...');
        const themeSelector = createThemeSelector(context, expectedGeneration);
        themeSelector.dataset.jcIdentityOwned = 'true';
        if (!isActive(context, expectedGeneration)) return false;
        parentSection.appendChild(themeSelector);
        console.log('🪼🎨Jellyfish Theme Selector :  Successfully injected!');
        return true;
    } catch (e) {
        console.error('🪼🎨Jellyfish Theme Selector :  Injection error:', e);
        return false;
    }
};

const isOnPreferencesPage = (): boolean => {
    try {
        return !!(document.querySelector('.headerUsername') && document.querySelector('.lnkUserProfile'));
    } catch (e) {
        return false;
    }
};

// --- Initialization ---
let observerInstance: { unsubscribe(): void } | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let initTimer: ReturnType<typeof setTimeout> | null = null;
let notificationTimer: ReturnType<typeof setTimeout> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function isActive(context: IdentityContext, expectedGeneration: number): boolean {
    return generation === expectedGeneration && JC.identity.isCurrent(context);
}

function isFeatureEnabled(): boolean {
    return JC.pluginConfig?.ThemeSelectorEnabled === true;
}

function cleanup(): void {
    observerInstance?.unsubscribe();
    observerInstance = null;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (initTimer) clearTimeout(initTimer);
    if (notificationTimer) clearTimeout(notificationTimer);
    if (reloadTimer) clearTimeout(reloadTimer);
    debounceTimer = null;
    initTimer = null;
    notificationTimer = null;
    reloadTimer = null;
    document.getElementById(SELECTOR_ID)?.remove();
    document.getElementById(CSS_STYLE_ID)?.remove();
    document.body.classList.remove('theme-applying', 'theme-applied');
}

export function resetThemeSelector(): void {
    generation += 1;
    cleanup();
}

// ~25s at 250ms: enough for a slow ApiClient boot, then give up so a login page
// left open (never authenticates) can't busy-loop the poller for the session.
const MAX_INIT_ATTEMPTS = 100;

const initialize = (attempt = 0): void => {
    // Browser-only module — never reschedule in a non-DOM (SSR/test) context.
    if (typeof window === 'undefined') return;
    if (attempt === 0) resetThemeSelector();
    const context = JC.identity.capture();
    if (!context || !isFeatureEnabled()) return;
    const expectedGeneration = generation;
    if (typeof ApiClient === 'undefined' || typeof ApiClient.getCurrentUserId !== 'function') {
        if (attempt >= MAX_INIT_ATTEMPTS) {
            console.warn('🪼🎨Jellyfish Theme Selector :  ApiClient never became available; giving up.');
            return;
        }
        console.log('🪼🎨Jellyfish Theme Selector :  Waiting for ApiClient...');
        initTimer = window.setTimeout(() => {
            initTimer = null;
            if (isActive(context, expectedGeneration)) initialize(attempt + 1);
        }, INIT_DELAY);
        return;
    }

    console.log('🪼🎨Jellyfish Theme Selector :  ApiClient is available. Starting persistent element monitoring.');
    migrateLegacyStorageOnce(context);
    applyRandomThemeIfNeeded(context, expectedGeneration);
    injectCustomCss();
    checkPostRefreshNotification(context, expectedGeneration);

    // Cleanup existing observer if present
    if (observerInstance) {
        observerInstance.unsubscribe();
        observerInstance = null;
    }

    const callback = (): void => {
        if (!isActive(context, expectedGeneration) || !isFeatureEnabled()) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            debounceTimer = null;
            if (!isActive(context, expectedGeneration) || !isFeatureEnabled()) return;
            const selectorExists = document.getElementById(SELECTOR_ID);
            if (isOnPreferencesPage() && !selectorExists) {
                console.log('🪼🎨Jellyfish Theme Selector :  Preferences page detected and selector is missing. Injecting...');
                injectThemeSelector(context, expectedGeneration);
            }
        }, DEBOUNCE_DELAY);
    };

    observerInstance = onBodyMutation('theme-selector', callback);
    callback();
};

/** Reconcile the Jellyfish compatibility mirror during an identity handoff. */
export function reconcileThemeSelectorIdentity(change: IdentityChange): void {
    if (change.previous) {
        JC.storage.local.remove('theme-selector', getCompatibilityKey(change.previous, 'customCss'), 'compatibility-theme');
        JC.storage.session.remove('theme-selector', getNotificationKey(change.previous), 'pending-notification');
    }
    if (change.current) {
        const currentTheme = getCurrentTheme(change.current);
        const compatibilityKey = getCompatibilityKey(change.current, 'customCss');
        if (currentTheme) JC.storage.local.write('theme-selector', compatibilityKey, currentTheme, 'compatibility-theme');
        else JC.storage.local.remove('theme-selector', compatibilityKey, 'compatibility-theme');
    }
    JC.storage.session.remove('theme-selector', LEGACY_NOTIFICATION_KEY, 'legacy-notification');
}

const themeSelectorApi = { initialize };
const stableThemeSelector = createStableMethodFacade<typeof themeSelectorApi>({
    initialize() {},
});

/** Publish the stable compatibility method for one lazy-feature activation. */
export function installThemeSelector(): () => void {
    const uninstall = stableThemeSelector.install(themeSelectorApi);
    JC.initializeThemeSelector = stableThemeSelector.facade.initialize;
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        resetThemeSelector();
        uninstall();
    };
}

/** Start the installed implementation without resolving through the global facade. */
export function initializeThemeSelector(): void {
    themeSelectorApi.initialize();
}
