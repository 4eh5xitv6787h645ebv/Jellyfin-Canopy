// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately with placeholders
    window.JellyfinEnhanced = {
        // Shared core layer, populated by js/core/*.js (navigation, lifecycle,
        // dom, api, ui). Created here so core modules can attach to it.
        core: {},
        pluginConfig: {},
        userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } },
        translations: {},
        pluginVersion: 'unknown',
        // Stub functions that will be overwritten by modules
        icon: (name) => {
            // Fallback icon function until icons.js loads
            // Returns the token unchanged so t() can keep the placeholder
            return name ? `{{ICON_PENDING:${name}}}` : '';
        },
        IconName: {}, // Will be replaced by icons.js
        state: {
            activeShortcuts: {},
            // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger
            // so the action-sheet observer knows which Remove button (if any) to add.
            removeContext: null,
            skipToastShown: false,
            pauseScreenClickTimer: null
         },
        // Unified cache manager for tag systems
        _cacheManager: {
            callbacks: new Set(),
            dirty: false,
            scheduleId: null,
            register(saveCallback) {
                this.callbacks.add(saveCallback);
            },
            unregister(saveCallback) {
                this.callbacks.delete(saveCallback);
            },
            markDirty() {
                this.dirty = true;
                if (!this.scheduleId) {
                    // Use requestIdleCallback to defer cache saves
                    if (typeof requestIdleCallback !== 'undefined') {
                        this.scheduleId = requestIdleCallback(() => this._flush(), { timeout: 5000 });
                    } else {
                        this.scheduleId = setTimeout(() => this._flush(), 1000);
                    }
                }
            },
            _flush() {
                if (this.dirty) {
                    this.callbacks.forEach(cb => {
                        try { cb(); } catch (e) { console.error('Cache save error:', e); }
                    });
                    this.dirty = false;
                }
                this.scheduleId = null;
            },
            forceSave() {
                this.dirty = true;
                this._flush();
            }
        },
        /**
         * Escapes HTML special characters to prevent XSS when interpolating into HTML strings.
         * Bootstrap copy only — replaced by the canonical JE.core.ui.escapeHtml
         * as soon as js/core/ui-kit.js loads.
         * @param {string} str - The value to escape.
         * @returns {string} The escaped string safe for HTML interpolation.
         */
        escapeHtml: (str) => {
            if (typeof str !== 'string') return String(str ?? '');
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        },
        // Placeholder functions
        t: (key, params = {}) => { // Actual implementation defined later
            const translations = window.JellyfinEnhanced?.translations || {};
            let text = translations[key] || key;
            if (params) {
                for (const [param, value] of Object.entries(params)) {
                    text = text.replace(new RegExp(`{${param}}`, 'g'), value);
                }
            }
            // Replace {{icon:name}} tokens with JE.icon() calls
            text = text.replace(/\{\{icon:([a-zA-Z]+)\}\}/g, (match, iconName) => {
                const iconKey = iconName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
                const iconConstant = window.JellyfinEnhanced.IconName?.[iconKey];

                // If IconName not loaded yet, keep the placeholder
                if (!iconConstant) {
                    console.debug(`[JE.t] IconName.${iconKey} not available yet, keeping placeholder`);
                    return match;
                }

                const iconResult = window.JellyfinEnhanced.icon?.(iconConstant);

                // If icon function returns a pending token, keep original placeholder
                if (iconResult && iconResult.startsWith('{{ICON_PENDING:')) {
                    console.debug(`[JE.t] Icon system not ready, keeping placeholder for ${iconName}`);
                    return match;
                }

                return iconResult || match;
            });

            return text;
        },
        loadSettings: () => { console.warn("🪼 Jellyfin Enhanced: loadSettings called before config.js loaded"); return {}; },
        initializeShortcuts: () => { console.warn("🪼 Jellyfin Enhanced: initializeShortcuts called before config.js loaded"); },
        saveUserSettings: async (fileName) => { console.warn(`🪼 Jellyfin Enhanced: saveUserSettings(${fileName}) called before config.js loaded`); }
    };

    const JE = window.JellyfinEnhanced; // Alias for internal use

    /**
     * Converts PascalCase object keys to camelCase recursively.
     * @param {object} obj - The object to convert.
     * @returns {object} - A new object with camelCase keys.
     */
    function toCamelCase(obj) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            return obj; // Return primitives and arrays as-is
        }
        const camelCased = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const camelKey = key.charAt(0).toLowerCase() + key.slice(1);
                camelCased[camelKey] = toCamelCase(obj[key]); // Recursive for nested objects
            }
        }
        return camelCased;
    }
    JE.toPascalCase = toPascalCase;
    JE.toCamelCase = toCamelCase;
    /**
     * Converts object keys from camelCase to PascalCase (recursively).
     * @param {object} obj - The object to convert.
     * @returns {object} - A new object with PascalCase keys.
     */
    function toPascalCase(obj) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            return obj; // Return primitives and arrays as-is
        }
        const pascalCased = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const pascalKey = key.charAt(0).toUpperCase() + key.slice(1);
                pascalCased[pascalKey] = toPascalCase(obj[key]); // Recursive for nested objects
            }
        }
        return pascalCased;
    }

    /**
     * Injects Druidblack metadata icons CSS.
     * @param {boolean} enabled
     */
    function injectMetadataIcons(enabled) {
        const existing = document.getElementById('metadataIconsCss');
        if (enabled && !existing) {
            const link = document.createElement('link');
            link.id = 'metadataIconsCss';
            link.rel = 'stylesheet';
            link.href = 'https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/public-icon.css';
            document.head.appendChild(link);
        } else if (!enabled && existing) {
            existing.remove();
        }
    }

    /**
     * Returns the plugin version for use as a cache-busting query parameter.
     * Reads synchronously from the injected script tag's version attribute so it
     * is available before the async version fetch resolves. Falls back to
     * JE.pluginVersion when already set (post-init calls), and to Date.now() if
     * neither source is available.
     * @returns {string}
     */
    function getScriptVersion() {
        const scriptEl = document.querySelector('script[plugin="Jellyfin Enhanced"]');
        if (scriptEl?.getAttribute('dev') === 'true') return Date.now();
        // Always prefer the script tag's version attribute, it holds the full
        // cacheKey (version + DLL timestamp) baked in at server startup.
        // JE.pluginVersion is just the bare version number from the API and
        // does not include the timestamp component.
        return scriptEl?.getAttribute('version') || JE.pluginVersion || Date.now();
    }

    /**
     * Loads the translation module and exposes JE.loadTranslations.
     * @returns {Promise<void>}
     */
    async function loadTranslationsModule() {
        if (typeof JE.loadTranslations === 'function') return;
        await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = ApiClient.getUrl(`/JellyfinEnhanced/js/enhanced/translations.js?v=${getScriptVersion()}`);
            script.onload = () => resolve();
            script.onerror = (e) => {
                console.error('🪼 Jellyfin Enhanced: Failed to load translations module', e);
                resolve();
            };
            document.head.appendChild(script);
        });
    }

    /**
     * Loads the appropriate language file based on the user's settings.
     * Attempts to fetch from GitHub first (with caching), falls back to bundled translations.
     * @returns {Promise<object>} A promise that resolves to the translations object.
     */
    async function loadTranslations() {
        if (typeof JE.loadTranslations === 'function') {
            return JE.loadTranslations();
        }
        console.warn('🪼 Jellyfin Enhanced: Translations module not loaded, falling back to empty translations');
        return {};
    }

     /**
     * Fetches plugin configuration and version from the server.
     * @returns {Promise<[object, string]>} A promise that resolves with config and version.
     */
     function loadPluginData() {
        const configPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
            dataType: 'json'
        }).catch((e) => {
            console.error("🪼 Jellyfin Enhanced: Failed to fetch public config", e);
            return {}; // Return empty object on error
        });

        const versionPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/version'),
            dataType: 'text'
        }).catch((e) => {
             console.error("🪼 Jellyfin Enhanced: Failed to fetch version", e);
            return 'unknown'; // Return placeholder on error
        });

        return Promise.all([configPromise, versionPromise]);
    }

    /**
     * Fetches sensitive configuration from the authenticated endpoint.
     * @returns {Promise<void>}
     */
    async function loadPrivateConfig() {
        try {
            const privateConfig = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/private-config'),
                dataType: 'json'
            });
            // Merge the sensitive keys into the main config object
            Object.assign(JE.pluginConfig, privateConfig);
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Could not load private configuration. Some features may be limited.', error);
            // Don't assign anything if it fails
        }
    }


    /**
     * Loads the client bundle (src/main.ts + all remaining component scripts,
     * concatenated in load order) as a single script. The bundle is generated
     * at build time by scripts/build-bundle.js and embedded in the DLL, so it
     * is present in every build; it is the ONLY way component code is loaded
     * (dev mode included — DevMode serves it with no-store + a fresh
     * cache-buster, and with a sourcemap for real-file stack traces).
     * @returns {Promise<boolean>} true when the bundle loaded, false on failure.
     */
    function loadBundle() {
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.async = false;
            script.src = ApiClient.getUrl(`/JellyfinEnhanced/dist/je.bundle.js?v=${getScriptVersion()}`);
            script.onload = () => resolve(true);
            script.onerror = (e) => {
                console.error(
                    '🪼 Jellyfin Enhanced: FATAL — the client bundle (/JellyfinEnhanced/dist/je.bundle.js) ' +
                    'failed to load. The plugin cannot start without it; no per-file fallback exists. ' +
                    'This usually means the plugin DLL was built without the bundle step (dotnet build ' +
                    'runs scripts/build-bundle.js automatically) or the server failed to serve the resource.',
                    e
                );
                script.remove();
                resolve(false);
            };
            document.head.appendChild(script);
        });
    }

     /**
     * Loads the splash screen script early.
     */
     function loadSplashScreenEarly() {
        if (typeof ApiClient === 'undefined') {
            setTimeout(loadSplashScreenEarly, 50);
            return;
        }
        const splashScript = document.createElement('script');
        splashScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/others/splashscreen.js?v=' + getScriptVersion());
        splashScript.onload = () => {
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen(); // Initialize if available
            }
        };
         splashScript.onerror = () => console.error('🪼 Jellyfin Enhanced: Failed to load splash screen script.');
        document.head.appendChild(splashScript);
    }

    /**
     * Injects a maintenance banner at the top of the page.
     */
    function injectMaintenanceBanner(message) {
        if (document.getElementById('je-maintenance-banner')) return;
        const text = (message || '').trim() || 'This server is currently undergoing maintenance. Please try again later.';
        const banner = document.createElement('div');
        banner.id = 'je-maintenance-banner';
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
            'background:#b71c1c', 'color:#fff', 'text-align:center',
            'padding:10px 16px', 'font-size:14px', 'font-weight:600',
            'letter-spacing:0.02em', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
            'font-family:inherit'
        ].join(';');
        banner.textContent = text;
        document.body.appendChild(banner);
        // Inject a stylesheet that shifts Jellyfin's fixed header + body down by the banner height.
        // We use a <style> tag so the rule applies even if Jellyfin re-renders its header.
        requestAnimationFrame(function() {
            const h = banner.offsetHeight;
            if (h <= 0) return;
            const existing = document.getElementById('je-maintenance-banner-style');
            if (existing) return;
            const style = document.createElement('style');
            style.id = 'je-maintenance-banner-style';
            style.textContent = [
                'body { padding-top: ' + h + 'px !important; }',
                '.skinHeader { top: ' + h + 'px !important; }',
                '.mainDrawer { top: ' + h + 'px !important; }',
                '.videoOsdBottom { bottom: 0 !important; }'
            ].join('\n');
            document.head.appendChild(style);
        });
    }

    /**
     * Loads the login image script early (checks config first).
     * Also injects a maintenance banner when maintenance mode is active.
     */
    function loadLoginImageEarly() {
        if (typeof ApiClient === 'undefined') {
            setTimeout(loadLoginImageEarly, 50);
            return;
        }

        // Fetch the public config to check if login image / maintenance banner is needed
        ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
            dataType: 'json'
        }).then((config) => {
            // Show maintenance banner for all users (admins can dismiss it mentally)
            if (config?.MaintenanceModeEnabled === true) {
                injectMaintenanceBanner(config.MaintenanceModeMessage);
            }

            // Only load login image if enabled (default to false)
            if (config?.EnableLoginImage === true) {
                const loginImageScript = document.createElement('script');
                loginImageScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/extras/login-image.js?v=' + getScriptVersion());
                loginImageScript.onerror = () => console.error('🪼 Jellyfin Enhanced: Failed to load login image script.');
                document.head.appendChild(loginImageScript);
            }
        }).catch(() => {
            console.warn('🪼 Jellyfin Enhanced: Could not fetch config for login image, skipping.');
        });
    }

    /**
     * Checks if there's a server ID mismatch (stale credentials from previous server)
     * @returns {boolean}
     */
    function hasServerIdMismatch() {
        try {
            if (typeof ApiClient === 'undefined') return false;

            const creds = localStorage.getItem('jellyfin_credentials');
            if (!creds) return false;

            const servers = JSON.parse(creds)?.Servers;
            if (!Array.isArray(servers) || servers.length === 0) return false;

            const currentServerId = ApiClient._serverInfo?.Id ||
                (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId);
            if (!currentServerId) return false;

            // Check if stored server matches current server
            const hasMatch = servers.some(s => s.Id === currentServerId || s.ServerId === currentServerId);
            return !hasMatch;
        } catch (e) {
            return false;
        }
    }

    let mismatchRetryCount = 0;
    const MAX_MISMATCH_RETRIES = 100; // ~30s at 300ms intervals

    /**
     * Main initialization function.
     */
    async function initialize() {
        // Check for server ID mismatch - stop retrying if credentials are stale
        if (hasServerIdMismatch()) {
            mismatchRetryCount++;
            if (mismatchRetryCount >= MAX_MISMATCH_RETRIES) {
                console.warn('🪼 Jellyfin Enhanced: Server ID mismatch detected - stopping to allow re-authentication');
                window.JE?.hideSplashScreen?.();
                return;
            }
            setTimeout(initialize, 300);
            return;
        }

        // Normal retry logic (no mismatch)
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId?.()) {
            setTimeout(initialize, 300);
            return;
        }

        // Reset mismatch counter on success
        mismatchRetryCount = 0;

        try {
            // Stage 1: Load base configs and translations
            await loadTranslationsModule();
            const [[config, version], translations] = await Promise.all([
                loadPluginData(),
                loadTranslations() // Load translations first
            ]);

            JE.pluginConfig = config && typeof config === 'object' ? config : {};
            JE.pluginVersion = version || 'unknown';
            JE.translations = translations || {};
            JE.t = window.JellyfinEnhanced.t; // Ensure the real function is assigned
            await loadPrivateConfig();

            // Clear stale UseCustomTabs / UsePluginPages config flags when those
            // plugins are not installed.  Settings persist after uninstall, which
            // causes sidebar injection to be skipped even though the delivery
            // plugin is no longer present.
            try {
                const installedPlugins = await ApiClient.ajax({
                    type: 'GET', url: ApiClient.getUrl('/Plugins'), dataType: 'json'
                });
                if (!Array.isArray(installedPlugins)) throw new Error('Unexpected /Plugins response');
                const hasCustomTabs = installedPlugins.some(p => p.Name === 'Custom Tabs');
                const hasPluginPages = installedPlugins.some(p => p.Name === 'Plugin Pages');
                if (!hasCustomTabs) {
                    JE.pluginConfig.BookmarksUseCustomTabs = false;
                    JE.pluginConfig.CalendarUseCustomTabs = false;
                    JE.pluginConfig.HiddenContentUseCustomTabs = false;
                    JE.pluginConfig.DownloadsUseCustomTabs = false;
                }
                if (!hasPluginPages) {
                    JE.pluginConfig.BookmarksUsePluginPages = false;
                    JE.pluginConfig.HiddenContentUsePluginPages = false;
                    JE.pluginConfig.DownloadsUsePluginPages = false;
                    JE.pluginConfig.CalendarUsePluginPages = false;
                }
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Could not verify installed plugins:', e);
            }

            // Check if server has triggered a translation cache clear
            const serverTranslationClearTs = JE.pluginConfig.ClearTranslationCacheTimestamp || 0;
            const localTranslationClearTs = parseInt(localStorage.getItem('JE_translation_clear_ts') || '0', 10);
            if (serverTranslationClearTs > localTranslationClearTs) {
                console.log(`🪼 Jellyfin Enhanced: Server-triggered translation cache clear (${new Date(serverTranslationClearTs).toISOString()})`);
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('JE_translation_') || key.startsWith('JE_translation_ts_'))) {
                        localStorage.removeItem(key);
                    }
                }
                localStorage.setItem('JE_translation_clear_ts', serverTranslationClearTs.toString());
                // Reload translations with fresh data
                JE.translations = await loadTranslations() || {};
                JE.t = window.JellyfinEnhanced.t;
            }

            // Inject metadata icons CSS if enabled
            try {
                injectMetadataIcons(!!JE.pluginConfig?.MetadataIconsEnabled);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to inject Metadata icons CSS', e);
            }

            // Stage 2: Fetch user-specific settings
            const userId = ApiClient.getCurrentUserId();

            // Prefetch full user object once (needed for admin check in arr-links etc.)
            // Fire-and-forget alongside stage-2 network calls; result available as JE.currentUser
            ApiClient.getCurrentUser().then(u => { JE.currentUser = u; }).catch(() => {});

            const fetchPromises = [
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/settings.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'settings', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'settings', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/shortcuts.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'shortcuts', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'shortcuts', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/bookmark.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'bookmark', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'bookmark', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/elsewhere.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'elsewhere', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'elsewhere', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'hiddenContent', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'hiddenContent', status: 'rejected', reason: e }))
            ];
            // Use allSettled to get results even if some fetches fail
            const results = await Promise.allSettled(fetchPromises);

            JE.userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } };
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    const data = result.value;
                    if (data.status === 'fulfilled' && data.value && typeof data.value === 'object') {
                        // *** CONVERT PASCALCASE TO CAMELCASE ***
                        if (data.name === 'settings' || data.name === 'bookmark' || data.name === 'hiddenContent') {
                            JE.userConfig[data.name] = toCamelCase(data.value);
                        } else {
                            JE.userConfig[data.name] = data.value;
                        }
                    } else if (data.status === 'rejected') {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else if (data.name === 'hiddenContent') JE.userConfig.hiddenContent = { items: {}, settings: {} };
                        else JE.userConfig[data.name] = {};
                    } else {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else if (data.name === 'hiddenContent') JE.userConfig.hiddenContent = { items: {}, settings: {} };
                        else JE.userConfig[data.name] = {};
                    }
                } else {
                    const name = result.value?.name || result.reason?.name || '';
                    if (name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                    else if (name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                    else if (name === 'elsewhere') JE.userConfig.elsewhere = {};
                    else if (name === 'hiddenContent') JE.userConfig.hiddenContent = { items: {}, settings: {} };
                    else if (name) JE.userConfig[name] = {};
                }
            });


            // Initialize splash screen
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen();
            }

            // Stage 3: Load ALL component scripts (one bundle).
            //
            // The core layer (navigation detection, lifecycle registry, shared
            // body observer, fetch layer, base UI primitives) lives in the
            // TypeScript tree (src/core/*, entry src/main.ts) and executes
            // FIRST in the bundle — before every script listed here.
            //
            // This array is the load-order source of truth for the files NOT
            // yet converted to src/. It is consumed at BUILD time by
            // scripts/build-bundle.js (which appends these files after
            // src/main.ts in the bundle); nothing reads it at runtime —
            // converting a file to TypeScript means removing its entry here
            // and importing it from src/ instead.
            // eslint-disable-next-line no-unused-vars -- build-time manifest parsed by scripts/build-bundle.js
            const allComponentScripts = [
                // enhanced
                'enhanced/config.js',
                'enhanced/helpers.js',
                'enhanced/native-tabs.js',
                'enhanced/tag-pipeline.js',
                'enhanced/icons.js',
                // features modules — order matters: -details-media-info.js and
                // -release-dates.js publish the chip renderers that
                // -details-page.js consumes via JE.internals.features, and
                // -remove-home.js publishes the action-sheet/remove helpers
                // that -remove-multiselect.js consumes.
                'enhanced/features-random-button.js',
                'enhanced/features-details-media-info.js',
                'enhanced/features-release-dates.js',
                'enhanced/features-details-page.js',
                'enhanced/features-remove-home.js',
                'enhanced/features-remove-multiselect.js',
                'enhanced/events.js',
                'enhanced/playback.js',
                // hidden-content modules — order matters: -data.js owns the
                // store + lookup sets that the later files consume via
                // JE.internals.hiddenContent; -init.js exposes the frozen
                // JE.initializeHiddenContent / JE.hiddenContent surface last.
                'enhanced/hidden-content-data.js',
                'enhanced/hidden-content-save.js',
                'enhanced/hidden-content-styles.js',
                'enhanced/hidden-content-dialogs.js',
                'enhanced/hidden-content-panel.js',
                'enhanced/hidden-content-filter.js',
                'enhanced/hidden-content-buttons.js',
                'enhanced/hidden-content-init.js',
                // hidden-content-page modules — order matters: -state.js owns
                // the shared page state read by the later files via
                // JE.internals.hiddenContentPage; -init.js exposes the frozen
                // JE.hiddenContentPage / JE.initializeHiddenContentPage last.
                'enhanced/hidden-content-page-state.js',
                'enhanced/hidden-content-page-styles.js',
                'enhanced/hidden-content-page-admin.js',
                'enhanced/hidden-content-page-cards.js',
                'enhanced/hidden-content-page-render.js',
                'enhanced/hidden-content-page-nav.js',
                'enhanced/hidden-content-page-init.js',
                'enhanced/hidden-content-custom-tab.js',
                'enhanced/subtitles.js',
                'enhanced/themer.js',
                // ui modules — order matters: -release-notes.js publishes
                // GITHUB_REPO + the release-notes panel that the template and
                // settings wiring consume via JE.internals.enhancedUi;
                // ui-panel.js hosts JE.showEnhancedPanel and orchestrates the
                // buildPanelHtml/wire* pieces last.
                'enhanced/ui-styles.js',
                'enhanced/ui-entry-points.js',
                'enhanced/ui-release-notes.js',
                'enhanced/ui-panel-template.js',
                'enhanced/ui-panel-shortcut-editor.js',
                'enhanced/ui-panel-settings.js',
                'enhanced/ui-panel-hidden-content.js',
                'enhanced/ui-panel-language.js',
                'enhanced/ui-panel.js',
                'enhanced/bookmarks.js',
                // bookmarks-library modules — order matters: styles/page/render
                // publish JE.internals.bookmarksLibrary pieces that the later
                // files consume; -init.js boots last.
                'enhanced/bookmarks-library-styles.js',
                'enhanced/bookmarks-library-page.js',
                'enhanced/bookmarks-library-render.js',
                'enhanced/bookmarks-library-items.js',
                'enhanced/bookmarks-library-modals.js',
                'enhanced/bookmarks-library-replacements.js',
                'enhanced/bookmarks-library-init.js',
                'enhanced/osd-rating.js',
                'enhanced/pausescreen.js',

                // elsewhere
                'elsewhere/elsewhere.js',
                'elsewhere/reviews.js',

                // jellyseerr
                'jellyseerr/seerr-status.js',
                'jellyseerr/request-manager.js',
                'jellyseerr/api.js',
                'jellyseerr/jellyseerr.js',
                'jellyseerr/ui-icons.js',
                'jellyseerr/ui-styles.js',
                'jellyseerr/ui-popover.js',
                'jellyseerr/ui-badges.js',
                'jellyseerr/ui-cards.js',
                'jellyseerr/ui-buttons.js',
                'jellyseerr/ui-quota.js',
                'jellyseerr/ui-results.js',
                'jellyseerr/ui-request-modals.js',
                'jellyseerr/ui-season-modal.js',
                'jellyseerr/modal.js',
                'jellyseerr/more-info-modal-styles.js',
                'jellyseerr/more-info-modal-data.js',
                'jellyseerr/more-info-modal-seasons.js',
                'jellyseerr/more-info-modal-badges.js',
                'jellyseerr/more-info-modal-render.js',
                'jellyseerr/more-info-modal-actions-tv.js',
                'jellyseerr/more-info-modal-actions.js',
                'jellyseerr/more-info-modal-init.js',
                'jellyseerr/hss-discovery-handler.js',
                'jellyseerr/item-details.js',
                'jellyseerr/issue-reporter.js',
                'jellyseerr/seamless-scroll.js',
                'jellyseerr/discovery-filter-utils.js',
                'jellyseerr/discovery-base.js',
                'jellyseerr/network-discovery.js',
                'jellyseerr/person-discovery.js',
                'jellyseerr/genre-discovery.js',
                'jellyseerr/tag-discovery.js',
                'jellyseerr/collection-discovery.js',

                // tags
                'tags/genretags.js',
                'tags/languagetags.js',
                'tags/peopletags.js',
                'tags/qualitytags.js',
                'tags/ratingtags.js',
                'tags/userreviewtags.js',

                // arr
                'arr/requests-page-styles.js',
                'arr/requests-page-data.js',
                'arr/requests-page-render-helpers.js',
                'arr/requests-page-render-cards.js',
                'arr/requests-page-render.js',
                'arr/requests-page-actions.js',
                'arr/requests-page-init.js',
                'arr/calendar-page-styles.js',
                'arr/calendar-page-data.js',
                'arr/calendar-page-render-events.js',
                'arr/calendar-page-render-views.js',
                'arr/calendar-page-actions.js',
                'arr/calendar-page-init.js',
                'arr/requests-custom-tab.js',
                'arr/calendar-custom-tab.js',

                // extras
                'extras/colored-activity-icons.js',
                'extras/colored-ratings.js',
                'extras/plugin-icons.js',
                'extras/theme-selector.js',
                'extras/active-streams.js',

                // others
                'others/letterboxd-links.js',
            ];
            // One bundle for every mode. Production serves it immutable behind a
            // versioned URL; DevMode serves the same route with no-store + a fresh
            // cache-buster per load (getScriptVersion() returns Date.now() in dev)
            // and the linked sourcemap keeps stack traces on real source files.
            const bundleLoaded = await loadBundle();
            if (!bundleLoaded) {
                if (typeof JE.hideSplashScreen === 'function') JE.hideSplashScreen();
                return;
            }
            console.log('🪼 Jellyfin Enhanced: All component scripts loaded.');

            // Stage 4: Initialize core settings/shortcuts using potentially defined functions
            if (typeof JE.loadSettings === 'function' && typeof JE.initializeShortcuts === 'function') {
                JE.currentSettings = JE.loadSettings(); // This happens AFTER config.js is loaded
                JE.initializeShortcuts();
            } else {
                 console.error("🪼 Jellyfin Enhanced: FATAL - config.js functions not defined after script loading.");
                 if (typeof JE.hideSplashScreen === 'function') JE.hideSplashScreen();
                 return;
            }

            if (userId) {
                const languageKey = `${userId}-language`;
                // Only seed the admin's default language if the user has no language set yet.
                // This prevents overwriting the user's own language choice on every page load.
                if (localStorage.getItem(languageKey) === null) {
                    const desiredLanguage = (JE.currentSettings?.displayLanguage || '').trim();
                    if (desiredLanguage) {
                        const normalizeLangCode = (code) => {
                            if (!code) return '';
                            const parts = code.split('-');
                            if (parts.length === 1) return parts[0].toLowerCase();
                            if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
                            return code;
                        };
                        localStorage.setItem(languageKey, normalizeLangCode(desiredLanguage));
                    }
                }
            }

            // Stage 5: Initialize theme system first
            if (typeof JE.themer?.init === 'function') {
                JE.themer.init();
                console.log('🪼 Jellyfin Enhanced: Theme system initialized.');
            }

            // Register unified cache save on page unload
            window.addEventListener('beforeunload', () => {
                JE._cacheManager.forceSave();
            });

            // Stage 6: Initialize feature modules
            if (typeof JE.initializeEnhancedScript === 'function') JE.initializeEnhancedScript();
            if (typeof JE.initializeElsewhereScript === 'function' && JE.pluginConfig?.ElsewhereEnabled) JE.initializeElsewhereScript();
            if (typeof JE.initializeJellyseerrScript === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowSearchResults !== false) JE.initializeJellyseerrScript();
            if (typeof JE.jellyseerrIssueReporter?.initialize === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowReportButton) JE.jellyseerrIssueReporter.initialize();
            if (typeof JE.initializePauseScreen === 'function') JE.initializePauseScreen();
            if (typeof JE.initializeBookmarks === 'function') JE.initializeBookmarks();
            if (typeof JE.initializeQualityTags === 'function' && JE.currentSettings?.qualityTagsEnabled) JE.initializeQualityTags();
            if (typeof JE.initializeGenreTags === 'function' && JE.currentSettings?.genreTagsEnabled) JE.initializeGenreTags();
            if (typeof JE.initializeRatingTags === 'function' && JE.currentSettings?.ratingTagsEnabled) JE.initializeRatingTags();
            if (typeof JE.initializeUserReviewTags === 'function' && JE.pluginConfig?.ShowUserReviews && JE.pluginConfig?.ShowUserRatingOnPosters && JE.currentSettings?.ratingTagsEnabled) JE.initializeUserReviewTags();
            if (typeof JE.initializeArrLinksScript === 'function' && JE.pluginConfig?.ArrLinksEnabled) JE.initializeArrLinksScript();
            if (typeof JE.initializeArrTagLinksScript === 'function' && JE.pluginConfig?.ArrTagsShowAsLinks) JE.initializeArrTagLinksScript();
            if (typeof JE.initializeLetterboxdLinksScript === 'function' && JE.pluginConfig?.LetterboxdEnabled) JE.initializeLetterboxdLinksScript();
            if (typeof JE.initializeReviewsScript === 'function' && (JE.pluginConfig?.ShowReviews || JE.pluginConfig?.ShowUserReviews)) JE.initializeReviewsScript();
            if (typeof JE.initializeLanguageTags === 'function' && JE.currentSettings?.languageTagsEnabled) JE.initializeLanguageTags();
            if (typeof JE.initializePeopleTags === 'function' && JE.currentSettings?.peopleTagsEnabled) JE.initializePeopleTags();
            // Initialize the unified tag pipeline AFTER all tag renderers have registered
            if (typeof JE.tagPipeline?.initialize === 'function') JE.tagPipeline.initialize();
            if (typeof JE.initializeOsdRating === 'function') JE.initializeOsdRating();
            // Skip hidden content initialization when feature is disabled server-wide — JE.hiddenContent stays undefined, safely disabling all downstream consumers
            if (typeof JE.initializeHiddenContent === 'function' && JE.pluginConfig?.HiddenContentEnabled) JE.initializeHiddenContent();

            if (JE.pluginConfig?.ColoredRatingsEnabled && typeof JE.initializeColoredRatings === 'function') {
                JE.initializeColoredRatings();
            }
            if (JE.pluginConfig?.ThemeSelectorEnabled && typeof JE.initializeThemeSelector === 'function') {
                JE.initializeThemeSelector();
            }
            if (JE.pluginConfig?.ColoredActivityIconsEnabled && typeof JE.initializeActivityIcons === 'function') {
                JE.initializeActivityIcons();
            }
            if (JE.pluginConfig?.PluginIconsEnabled && typeof JE.initializePluginIcons === 'function') {
                JE.initializePluginIcons();
            }
            if (JE.pluginConfig?.ActiveStreamsEnabled && typeof JE.activeStreams?.initialize === 'function') {
                JE.activeStreams.initialize();
            }
            if (JE.pluginConfig?.DownloadsPageEnabled && typeof JE.initializeDownloadsPage === 'function') {
                JE.initializeDownloadsPage();
            }
            if (JE.pluginConfig?.CalendarPageEnabled && typeof JE.initializeCalendarPage === 'function') {
                JE.initializeCalendarPage();
            }
            if (JE.pluginConfig?.HiddenContentEnabled && typeof JE.initializeHiddenContentPage === 'function') {
                JE.initializeHiddenContentPage();
            }

            console.log('🪼 Jellyfin Enhanced: All components initialized successfully.');

            // Programmatic boot-complete marker: every component script has executed
            // and every enabled initializeX() has run. Automation (E2E) waits on this
            // instead of racing individual JE.* properties that appear mid-boot.
            JE.initialized = true;

            // Final Stage: Hide splash screen
            if (typeof JE.hideSplashScreen === 'function') {
                JE.hideSplashScreen();
            }

        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: CRITICAL INITIALIZATION FAILURE:', error);
             if (typeof JE.hideSplashScreen === 'function') {
                JE.hideSplashScreen();
            }
        }
    }

    // Load splash screen immediately (before main initialization)
    loadSplashScreenEarly();

    // Load login image immediately (before main initialization)
    loadLoginImageEarly();

    // Then start main initialization
    initialize();

})();
