// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately with placeholders
    window.JellyfinElevate = {
        // Shared core layer, populated by js/core/*.js (navigation, lifecycle,
        // dom, api, ui). Created here so core modules can attach to it.
        core: {},
        pluginConfig: {},
        userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } },
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
            const translations = window.JellyfinElevate?.translations || {};
            let text = translations[key] || key;
            if (params) {
                for (const [param, value] of Object.entries(params)) {
                    // Escape regex metacharacters in the param name and match the
                    // braces literally; use a function replacer so `$&`, `$1`, `$$`
                    // etc. inside a value are inserted verbatim, not as replacement
                    // patterns.
                    const safeParam = String(param).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    text = text.replace(new RegExp(`\\{${safeParam}\\}`, 'g'), () => String(value));
                }
            }
            // Replace {{icon:name}} tokens with JE.icon() calls
            text = text.replace(/\{\{icon:([a-zA-Z]+)\}\}/g, (match, iconName) => {
                const iconKey = iconName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
                const iconConstant = window.JellyfinElevate.IconName?.[iconKey];

                // If IconName not loaded yet, keep the placeholder
                if (!iconConstant) {
                    console.debug(`[JE.t] IconName.${iconKey} not available yet, keeping placeholder`);
                    return match;
                }

                const iconResult = window.JellyfinElevate.icon?.(iconConstant);

                // If icon function returns a pending token, keep original placeholder
                if (iconResult && iconResult.startsWith('{{ICON_PENDING:')) {
                    console.debug(`[JE.t] Icon system not ready, keeping placeholder for ${iconName}`);
                    return match;
                }

                return iconResult || match;
            });

            return text;
        },
        loadSettings: () => { console.warn("🪼 Jellyfin Elevate: loadSettings called before config.js loaded"); return {}; },
        initializeShortcuts: () => { console.warn("🪼 Jellyfin Elevate: initializeShortcuts called before config.js loaded"); },
        saveUserSettings: async (fileName) => { console.warn(`🪼 Jellyfin Elevate: saveUserSettings(${fileName}) called before config.js loaded`); }
    };

    const JE = window.JellyfinElevate; // Alias for internal use

    /**
     * Converts PascalCase object keys to camelCase recursively.
     * @param {object} obj - The object to convert.
     * @param {{preserveKey?: (key: string) => boolean}} [opts] - When
     *   opts.preserveKey(key) is true the key is copied verbatim (not
     *   camelCased) — used to keep ID-keyed dictionaries (e.g. bookmark ids
     *   `Bm_…`) case-stable across the round trip.
     * @returns {object} - A new object with camelCase keys.
     */
    function toCamelCase(obj, opts) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            return obj; // Return primitives and arrays as-is
        }
        const preserveKey = opts && opts.preserveKey;
        const camelCased = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const camelKey = (preserveKey && preserveKey(key))
                    ? key
                    : key.charAt(0).toLowerCase() + key.slice(1);
                camelCased[camelKey] = toCamelCase(obj[key], opts); // Recursive for nested objects
            }
        }
        return camelCased;
    }
    JE.toPascalCase = toPascalCase;
    JE.toCamelCase = toCamelCase;
    /**
     * Converts object keys from camelCase to PascalCase (recursively).
     * @param {object} obj - The object to convert.
     * @param {{preserveKey?: (key: string) => boolean}} [opts] - When
     *   opts.preserveKey(key) is true the key is copied verbatim (not
     *   PascalCased) — the save-side mirror of toCamelCase so ID-keyed
     *   dictionaries (bookmark ids `Bm_…`) stay case-stable on disk.
     * @returns {object} - A new object with PascalCase keys.
     */
    function toPascalCase(obj, opts) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            return obj; // Return primitives and arrays as-is
        }
        const preserveKey = opts && opts.preserveKey;
        const pascalCased = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const pascalKey = (preserveKey && preserveKey(key))
                    ? key
                    : key.charAt(0).toUpperCase() + key.slice(1);
                pascalCased[pascalKey] = toPascalCase(obj[key], opts); // Recursive for nested objects
            }
        }
        return pascalCased;
    }

    /**
     * Injects Druidblack metadata icons CSS.
     * PERF: no remote assets — served from the local asset cache (the server
     * rewrites the CSS's internal icon urls to local copies too). The original
     * CDN URL is only used when the admin disabled the asset cache. Called
     * after loadConfig(), so JE.pluginConfig is populated here.
     * @param {boolean} enabled
     */
    function injectMetadataIcons(enabled) {
        const existing = document.getElementById('metadataIconsCss');
        if (enabled && !existing) {
            const link = document.createElement('link');
            link.id = 'metadataIconsCss';
            link.rel = 'stylesheet';
            link.href = JE.pluginConfig?.AssetCacheEnabled !== false
                ? ApiClient.getUrl('/JellyfinElevate/assets/metadata-icons/public-icon.css')
                : 'https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/public-icon.css';
            document.head.appendChild(link);
        } else if (!enabled && existing) {
            existing.remove();
        }
    }

    /**
     * Single source of truth for the admin-aware genre-tag resolution:
     * the user's own toggle wins when set, otherwise the admin default. Both
     * the boot font preload and the merged-settings init gate must agree, so
     * the resolution lives here instead of being re-derived inline.
     * @param {object} userSettings - Raw JE.userConfig.settings.
     * @returns {boolean}
     */
    function resolveGenreTagsEnabled(userSettings) {
        return (userSettings.genreTagsEnabled !== undefined && userSettings.genreTagsEnabled !== null)
            ? !!userSettings.genreTagsEnabled
            : !!JE.pluginConfig?.GenreTagsEnabled;
    }

    /**
     * PERF(R1): warm the Material Symbols icon fonts during boot, before the
     * bundle initializes any feature that renders icon glyphs. Without this
     * the woff2s only start downloading when the first injected icon paints,
     * so already-rendered icon text reflows when the font swaps in — the
     * residual micro-shift the jank benchmark attributes to
     * span.material-symbols-* nodes. The shared Rounded face (media-info
     * chips, people tags, reviews, calendar) gets a <link rel=preload> that
     * warms the HTTP cache for the @font-face the bundle registers later; the
     * Outlined face (genre tags) is a stylesheet — injected here under the
     * same element id genretags.ts checks, so its later injection no-ops —
     * whose font is force-loaded via document.fonts once the CSS lands.
     * PERF(R6): skipped when the admin disabled the local asset cache;
     * features then resolve their registered CDN twins themselves and we do
     * not add early third-party fetches.
     * Called after user settings land (Stage 2) so the genre-tag gate can
     * respect the user's own toggle, not just the admin default.
     */
    function preloadIconFonts() {
        if (JE.pluginConfig?.AssetCacheEnabled === false) return;
        try {
            if (!document.getElementById('je-mat-sym-rounded-preload')) {
                const preload = document.createElement('link');
                preload.id = 'je-mat-sym-rounded-preload';
                preload.rel = 'preload';
                preload.as = 'font';
                preload.type = 'font/woff2';
                // Font preloads must be anonymous-CORS to match the request
                // mode of CSS @font-face fetches, or the browser re-fetches.
                preload.crossOrigin = 'anonymous';
                preload.href = ApiClient.getUrl('/JellyfinElevate/assets/fonts/material-symbols-rounded.woff2');
                document.head.appendChild(preload);
            }

            const userSettings = JE.userConfig?.settings || {};
            const genreTagsOn = resolveGenreTagsEnabled(userSettings);
            if (genreTagsOn && !document.getElementById('mat-sym')) {
                const link = document.createElement('link');
                link.id = 'mat-sym'; // same id genretags.ts checks before injecting
                link.rel = 'stylesheet';
                link.href = ApiClient.getUrl('/JellyfinElevate/assets/fonts/material-symbols-outlined.css');
                link.onload = () => {
                    try {
                        if (document.fonts && typeof document.fonts.load === 'function') {
                            void document.fonts.load("24px 'Material Symbols Outlined'");
                        }
                    } catch (e) { /* non-fatal: glyphs load on first paint as before */ }
                };
                document.head.appendChild(link);
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Elevate: Failed to preload icon fonts', e);
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
        const scriptEl = document.querySelector('script[plugin="Jellyfin Elevate"]');
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
            script.src = ApiClient.getUrl(`/JellyfinElevate/dist/translations.js?v=${getScriptVersion()}`);
            script.onload = () => resolve();
            script.onerror = (e) => {
                console.error('🪼 Jellyfin Elevate: Failed to load translations module', e);
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
        console.warn('🪼 Jellyfin Elevate: Translations module not loaded, falling back to empty translations');
        return {};
    }

     /**
     * Fetches plugin configuration and version from the server.
     * @returns {Promise<[object, string]>} A promise that resolves with config and version.
     */
     function loadPluginData() {
        const configPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinElevate/public-config'),
            dataType: 'json'
        }).catch((e) => {
            console.error("🪼 Jellyfin Elevate: Failed to fetch public config", e);
            return {}; // Return empty object on error
        });

        const versionPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinElevate/version'),
            dataType: 'text'
        }).catch((e) => {
             console.error("🪼 Jellyfin Elevate: Failed to fetch version", e);
            return 'unknown'; // Return placeholder on error
        });

        return Promise.all([configPromise, versionPromise]);
    }

    /**
     * Fetches sensitive configuration from the authenticated endpoint.
     * Returns the config object (instead of merging it here) so the fetch can
     * run in parallel with the public-config fetch — the caller merges it into
     * JE.pluginConfig once that object exists.
     * @returns {Promise<object|null>} The private config, or null on failure.
     */
    async function loadPrivateConfig() {
        try {
            return await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinElevate/private-config'),
                dataType: 'json'
            });
        } catch (error) {
            console.warn('🪼 Jellyfin Elevate: Could not load private configuration. Some features may be limited.', error);
            return null; // Don't merge anything if it fails
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
            script.src = ApiClient.getUrl(`/JellyfinElevate/dist/je.bundle.js?v=${getScriptVersion()}`);
            script.onload = () => resolve(true);
            script.onerror = (e) => {
                console.error(
                    '🪼 Jellyfin Elevate: FATAL — the client bundle (/JellyfinElevate/dist/je.bundle.js) ' +
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
        splashScript.src = ApiClient.getUrl('/JellyfinElevate/dist/splashscreen.js?v=' + getScriptVersion());
        splashScript.onload = () => {
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen(); // Initialize if available
            }
        };
         splashScript.onerror = () => console.error('🪼 Jellyfin Elevate: Failed to load splash screen script.');
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

    // Jellyfin 12 stores the client layout choice in the unprefixed localStorage
    // key `layout` (appSettings.js — SETTING_KEY = 'layout'). On the shipped 12.0.0
    // build the modern React/MUI layout is the value 'experimental' and the classic
    // legacy layout is 'desktop' (LayoutMode = {auto, desktop, experimental, mobile,
    // tv}); an unset key means the app falls back to appHost.getDefaultLayout()
    // (Modern on browsers). jellyfin-web reads this once at module init to choose the
    // route tree, so a change only takes effect on reload. See docs/v12-platform.md §1.
    var LAYOUT_STORAGE_KEY = 'layout';
    var LAYOUT_EXPERIMENTAL = 'experimental';
    var LAYOUT_LEGACY = 'desktop';
    var LAYOUT_ENFORCED_SESSION_KEY = 'je_layout_enforced';

    /**
     * Whether a stored `layout` value results in the MODERN layout being painted.
     *
     * Jellyfin's own browser default is modern, so an unset or 'auto' choice already
     * paints modern. Only the known legacy modes paint the legacy app — the shipped
     * 12.0.0 values ('desktop', 'mobile', 'tv') plus master's renamed
     * '*-legacy' dialect. Anything ELSE (including a garbage/unknown value) counts
     * as modern-painting: getSavedLayout() rejects unknown values and the app falls
     * back to its modern default, so an unknown value never paints legacy.
     *
     * Detection tolerates BOTH Jellyfin-12 layout-value dialects (docs/v12-platform.md
     * §1). The VALUES WRITTEN by enforcement below target the shipped 12.0.0 build
     * ('experimental'/'desktop'); on a build using the master dialect an unknown
     * written value is simply rejected by getSavedLayout() and the app keeps its
     * modern default — so ForceExperimental still lands on modern there, while
     * ForceLegacy silently degrades to modern (no diagnostic).
     * @param {string|null|undefined} stored
     * @returns {boolean}
     */
    function layoutRendersModern(stored) {
        if (!stored) return true;
        return stored !== LAYOUT_LEGACY
            && stored !== 'mobile'
            && stored !== 'tv'
            && stored !== 'desktop-legacy'
            && stored !== 'mobile-legacy';
    }

    /**
     * Pure decision for the LayoutEnforcement admin setting.
     *
     * Returns what (if anything) the stored `layout` value should become and whether
     * a one-shot reload is needed to make it take effect this load. A reload is only
     * ever needed when the device is CURRENTLY painting the other layout — a device
     * that already paints the target (including a fresh device on Jellyfin's modern
     * default) is never reloaded; at most its stored value is made explicit.
     *
     * TV exception: a stored 'tv' layout is NEVER steered by either Force mode. A
     * device deliberately in 10-foot TV mode must not be pulled onto the mouse/touch
     * UI — jellyfin-web itself scopes the modern default to non-TV browsers.
     *
     * Kept pure and side-effect free so it can be unit-tested
     * (see plugin-loader.test.ts).
     *
     * @param {string|undefined|null} mode  The LayoutEnforcement config value.
     * @param {string|null} stored          The current localStorage['layout'] value.
     * @returns {{ changed: boolean, value?: string, reload?: boolean }}
     */
    function resolveLayoutEnforcement(mode, stored) {
        // TV mode is exempt from Force steering in both directions.
        if (stored === 'tv' && (mode === 'ForceExperimental' || mode === 'ForceLegacy')) {
            return { changed: false };
        }

        switch (mode) {
            case 'ForceExperimental':
                // A device on a (non-TV) legacy mode must reload into the modern app.
                // A device already painting modern (unset/'auto'/'experimental'/
                // unknown) is left as-is, but we persist 'experimental' so the choice
                // is explicit — no reload.
                if (!layoutRendersModern(stored)) {
                    return { changed: true, value: LAYOUT_EXPERIMENTAL, reload: true };
                }
                return stored === LAYOUT_EXPERIMENTAL
                    ? { changed: false }
                    : { changed: true, value: LAYOUT_EXPERIMENTAL, reload: false };
            case 'ForceLegacy':
                // Only flip a device that would paint the modern layout — onto the
                // DESKTOP legacy layout specifically (not form-factor aware). A device
                // already on a legacy mode keeps its chosen legacy sub-layout.
                return layoutRendersModern(stored)
                    ? { changed: true, value: LAYOUT_LEGACY, reload: true }
                    : { changed: false };
            case 'DefaultExperimental':
                // Apply ONLY when the device has never made an explicit choice — any
                // stored value (even an unknown one) counts as an explicit choice and
                // is left alone. An unset device already paints the modern layout by
                // default, so this just persists that choice — no reload needed.
                return stored
                    ? { changed: false }
                    : { changed: true, value: LAYOUT_EXPERIMENTAL, reload: false };
            default:
                // 'None' or any unknown value: never touch the user's layout.
                return { changed: false };
        }
    }

    /**
     * Apply the LayoutEnforcement setting as early as possible during boot.
     *
     * Runs from the early public-config fetch below (pre-auth capable — the login
     * screen is subject to enforcement too). Because jellyfin-web has already picked
     * its layout by the time any plugin code runs (its bundles are deferred in
     * <head>; our loader is deferred at end of <body>), a Force override cannot be
     * applied in-place and instead does one guarded reload.
     *
     * Loop guard (Force must still win after a later manual switch): before a reload
     * we record the target we are reloading toward in sessionStorage. On the next
     * load, if the stored layout has CONVERGED to the target we clear the marker, so
     * a fresh divergence (e.g. the user manually switches back via Jellyfin's Display
     * UI) is allowed exactly one more reload. Only when we would reload toward a
     * target we ALREADY reloaded toward and the value still has not stuck do we bail
     * — that is the genuine loop signature (a write that never persists), and only
     * that case is suppressed.
     *
     * @param {object|null} config The public-config payload.
     * @returns {boolean} true if a reload was triggered (caller should stop).
     */
    function applyLayoutEnforcement(config) {
        try {
            const mode = config && config.LayoutEnforcement;
            if (!mode || mode === 'None') return false;

            let stored = null;
            try {
                stored = localStorage.getItem(LAYOUT_STORAGE_KEY);
            } catch (e) {
                return false; // storage unavailable — nothing we can safely do
            }

            const decision = resolveLayoutEnforcement(mode, stored);
            if (!decision.changed) {
                // Converged (or nothing to do): clear the loop marker so a future
                // divergence can be re-enforced with one reload.
                try {
                    sessionStorage.removeItem(LAYOUT_ENFORCED_SESSION_KEY);
                } catch (e) { /* ignore */ }
                return false;
            }

            try {
                localStorage.setItem(LAYOUT_STORAGE_KEY, decision.value);
                // Read-back guard: some environments accept setItem but do not
                // actually persist (ephemeral/in-memory/quota-broken storage). If
                // the write did not stick, reloading would land right back here —
                // an infinite reload loop in the storage's own failing domain
                // (sessionStorage would fail identically, so the session guard
                // below could not catch it). Bail without reloading instead.
                if (localStorage.getItem(LAYOUT_STORAGE_KEY) !== decision.value) {
                    return false;
                }
            } catch (e) {
                return false; // cannot persist — do not reload into an unchanged state
            }

            if (!decision.reload) {
                // Persisted the target without a reload (device already paints it):
                // we are at the target, so clear any stale loop marker.
                try {
                    sessionStorage.removeItem(LAYOUT_ENFORCED_SESSION_KEY);
                } catch (e) { /* ignore */ }
                return false;
            }

            // Loop guard: bail only if we ALREADY reloaded toward this exact target
            // this session and the value still has not stuck (a write that never
            // persists) — otherwise a genuine new divergence gets its one reload.
            try {
                if (sessionStorage.getItem(LAYOUT_ENFORCED_SESSION_KEY) === decision.value) {
                    return false;
                }
                sessionStorage.setItem(LAYOUT_ENFORCED_SESSION_KEY, decision.value);
            } catch (e) {
                return false; // no sessionStorage → skip reload rather than risk a loop
            }

            window.location.reload();
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Loads the login image script early (checks config first).
     * Also injects a maintenance banner when maintenance mode is active, and applies
     * the LayoutEnforcement setting (this is the earliest config-driven boot hook and
     * runs pre-auth, so it is where layout steering belongs).
     */
    function loadLoginImageEarly() {
        if (typeof ApiClient === 'undefined') {
            setTimeout(loadLoginImageEarly, 50);
            return;
        }

        // Fetch the public config to check if login image / maintenance banner is needed
        ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinElevate/public-config'),
            dataType: 'json'
        }).then((config) => {
            // Steer the client layout first: if this triggers a reload, skip the rest.
            if (applyLayoutEnforcement(config)) {
                return;
            }

            // Show maintenance banner for all users (admins can dismiss it mentally)
            if (config?.MaintenanceModeEnabled === true) {
                injectMaintenanceBanner(config.MaintenanceModeMessage);
            }

            // Only load login image if enabled (default to false)
            if (config?.EnableLoginImage === true) {
                const loginImageScript = document.createElement('script');
                loginImageScript.src = ApiClient.getUrl('/JellyfinElevate/dist/login-image.js?v=' + getScriptVersion());
                loginImageScript.onerror = () => console.error('🪼 Jellyfin Elevate: Failed to load login image script.');
                document.head.appendChild(loginImageScript);
            }
        }).catch(() => {
            console.warn('🪼 Jellyfin Elevate: Could not fetch config for login image, skipping.');
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

    let readyRetryCount = 0;
    // Cap the ApiClient-readiness poll so a login page left open unauthenticated
    // does not busy-loop (and re-parse jellyfin_credentials) forever. ~10*50ms +
    // 590*250ms ≈ 2.5 min — generous enough for a real user typing credentials;
    // on login Jellyfin full-reloads, discarding the loop, so this only bites the
    // never-authenticated idle case.
    const MAX_READY_RETRIES = 600;

    /**
     * Delay before the next ApiClient-readiness poll.
     * PERF: snappy boot — poll fast (50ms) for the first ~half second while
     * ApiClient typically appears, then back off to 250ms instead of a flat
     * 300ms that used to add up to ~300ms of dead time to every boot.
     * @returns {number} Milliseconds to wait before retrying initialize().
     */
    function nextReadyPollDelay() {
        readyRetryCount++;
        return readyRetryCount <= 10 ? 50 : 250;
    }

    /**
     * Main initialization function.
     */
    async function initialize() {
        // Check for server ID mismatch - stop retrying if credentials are stale
        if (hasServerIdMismatch()) {
            mismatchRetryCount++;
            if (mismatchRetryCount >= MAX_MISMATCH_RETRIES) {
                console.warn('🪼 Jellyfin Elevate: Server ID mismatch detected - stopping to allow re-authentication');
                JE?.hideSplashScreen?.();
                return;
            }
            setTimeout(initialize, 300);
            return;
        }

        // Normal retry logic (no mismatch)
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId?.()) {
            if (readyRetryCount >= MAX_READY_RETRIES) {
                console.warn('🪼 Jellyfin Elevate: ApiClient not ready after max retries - stopping poll');
                JE?.hideSplashScreen?.();
                return;
            }
            setTimeout(initialize, nextReadyPollDelay());
            return;
        }

        // Reset mismatch counter on success
        mismatchRetryCount = 0;

        try {
            // PERF: single parallel fetch wave. Every boot request that only
            // needs auth/userId starts immediately instead of one-per-await —
            // the old chain was four network round-trips deep (public config →
            // private config → /Plugins → 5 user-settings files) even though
            // none of those responses feed the next request.
            const userId = ApiClient.getCurrentUserId();

            // Prefetch full user object once (needed for admin check in arr-links etc.)
            // Fire-and-forget alongside the fetch wave; result available as JE.currentUser
            ApiClient.getCurrentUser().then(u => { JE.currentUser = u; }).catch(() => {});

            const pluginsListPromise = ApiClient.ajax({
                type: 'GET', url: ApiClient.getUrl('/Plugins'), dataType: 'json'
            }).catch(e => {
                console.warn('🪼 Jellyfin Elevate: Could not verify installed plugins:', e);
                return null;
            });

            const fetchPromises = [
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinElevate/user-settings/${userId}/settings.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'settings', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'settings', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinElevate/user-settings/${userId}/shortcuts.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'shortcuts', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'shortcuts', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinElevate/user-settings/${userId}/bookmark.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'bookmark', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'bookmark', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinElevate/user-settings/${userId}/elsewhere.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'elsewhere', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'elsewhere', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinElevate/user-settings/${userId}/hidden-content.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'hiddenContent', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'hiddenContent', status: 'rejected', reason: e }))
            ];
            // Use allSettled to get results even if some fetches fail
            const userSettingsPromise = Promise.allSettled(fetchPromises);

            // Stage 1: Load base configs and translations
            await loadTranslationsModule();
            const [[config, version], translations, privateConfig] = await Promise.all([
                loadPluginData(),
                loadTranslations(), // Load translations first
                loadPrivateConfig()
            ]);

            JE.pluginConfig = config && typeof config === 'object' ? config : {};
            JE.pluginVersion = version || 'unknown';
            JE.translations = translations || {};
            JE.t = window.JellyfinElevate.t; // Ensure the real function is assigned
            // Merge the sensitive keys into the main config object
            if (privateConfig && typeof privateConfig === 'object') {
                Object.assign(JE.pluginConfig, privateConfig);
            }

            // PERF(R7): warm the server tag-cache fetch NOW — its only gates are
            // auth/userId and the TagCacheServerMode flag, which public config
            // (this stage) just delivered. Cold-boot first tags used to wait for
            // bundle download + full feature init before the tag pipeline even
            // STARTED this request; handing the in-flight promise to
            // src/enhanced/tag-pipeline.ts (which falls back to its own fetch
            // when absent) takes the whole bundle-boot serialization out of the
            // first-tag latency. Resolves null on failure so the pipeline's
            // fallback path handles errors exactly as before.
            if (JE.pluginConfig?.TagCacheServerMode) {
                JE._tagCachePrefetch = ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinElevate/tag-cache/${userId}`),
                    dataType: 'json'
                }).catch(() => null);
            }

            // Clear stale UseCustomTabs / UsePluginPages config flags when those
            // plugins are not installed.  Settings persist after uninstall, which
            // causes sidebar injection to be skipped even though the delivery
            // plugin is no longer present.
            const installedPlugins = await pluginsListPromise;
            if (Array.isArray(installedPlugins)) {
                const hasCustomTabs = installedPlugins.some(p => p.Name === 'Custom Tabs');
                const hasPluginPages = installedPlugins.some(p => p.Name === 'Plugin Pages');
                // Cache for the bundle side (src/core/delivery-flags.ts) so the live-config
                // hot-reload can re-apply this same sanitization; the inline zeroing below
                // stays because it runs before the bundle is guaranteed loaded.
                JE._deliveryPluginsInstalled = { customTabs: hasCustomTabs, pluginPages: hasPluginPages };
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
            } else if (installedPlugins !== null) {
                console.warn('🪼 Jellyfin Elevate: Could not verify installed plugins: unexpected /Plugins response');
            }

            // Check if server has triggered a translation cache clear
            const serverTranslationClearTs = JE.pluginConfig.ClearTranslationCacheTimestamp || 0;
            const localTranslationClearTs = parseInt(localStorage.getItem('JE_translation_clear_ts') || '0', 10);
            if (serverTranslationClearTs > localTranslationClearTs) {
                console.log(`🪼 Jellyfin Elevate: Server-triggered translation cache clear (${new Date(serverTranslationClearTs).toISOString()})`);
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('JE_translation_') || key.startsWith('JE_translation_ts_'))) {
                        localStorage.removeItem(key);
                    }
                }
                localStorage.setItem('JE_translation_clear_ts', serverTranslationClearTs.toString());
                // Reload translations with fresh data
                JE.translations = await loadTranslations() || {};
                JE.t = window.JellyfinElevate.t;
            }

            // Inject metadata icons CSS if enabled
            try {
                injectMetadataIcons(!!JE.pluginConfig?.MetadataIconsEnabled);
            } catch (e) {
                console.warn('🪼 Jellyfin Elevate: Failed to inject Metadata icons CSS', e);
            }

            // Stage 2: Collect the user-specific settings started in the
            // parallel fetch wave above.
            const results = await userSettingsPromise;

            JE.userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } };
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    const data = result.value;
                    if (data.status === 'fulfilled' && data.value && typeof data.value === 'object') {
                        // *** CONVERT PASCALCASE TO CAMELCASE ***
                        if (data.name === 'bookmark') {
                            // Preserve the bookmark ID dictionary keys (`Bm_…`) so
                            // the server-generated id case is not mangled to `bm_…`.
                            JE.userConfig[data.name] = toCamelCase(data.value, { preserveKey: (k) => /^bm_/i.test(k) });
                        } else if (data.name === 'settings' || data.name === 'hiddenContent') {
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


            // Warm the icon fonts while the bundle is still downloading, so
            // glyphs are ready before the first injected icon paints (see
            // preloadIconFonts for the PERF(R1)/PERF(R6) reasoning).
            preloadIconFonts();

            // Initialize splash screen
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen();
            }

            // Stage 3: Load the client bundle (every component, one script).
            //
            // The entire feature tree — core layer (navigation detection,
            // lifecycle registry, shared body observer, fetch layer, base UI
            // primitives) plus every feature module — lives in the TypeScript
            // tree (entry src/main.ts) and ships as a single bundle built by
            // scripts/build-bundle.js. Import edges in src/ define execution
            // order; there is no longer a runtime or build-time component list.
            //
            // One bundle for every mode. Production serves it immutable behind a
            // versioned URL; DevMode serves the same route with no-store + a fresh
            // cache-buster per load (getScriptVersion() returns Date.now() in dev)
            // and the linked sourcemap keeps stack traces on real source files.
            const bundleLoaded = await loadBundle();
            if (!bundleLoaded) {
                if (typeof JE.hideSplashScreen === 'function') JE.hideSplashScreen();
                return;
            }
            console.log('🪼 Jellyfin Elevate: All component scripts loaded.');

            // Stage 4: Initialize core settings/shortcuts using potentially defined functions
            if (typeof JE.loadSettings === 'function' && typeof JE.initializeShortcuts === 'function') {
                JE.currentSettings = JE.loadSettings(); // This happens AFTER config.js is loaded
                JE.initializeShortcuts();
            } else {
                 console.error("🪼 Jellyfin Elevate: FATAL - config.js functions not defined after script loading.");
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
                console.log('🪼 Jellyfin Elevate: Theme system initialized.');
            }

            // Register unified cache save on page unload
            window.addEventListener('beforeunload', () => {
                JE._cacheManager.forceSave();
            });

            // Stage 6: Initialize feature modules
            if (typeof JE.initializeElevateScript === 'function') JE.initializeElevateScript();
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

            console.log('🪼 Jellyfin Elevate: All components initialized successfully.');

            // Programmatic boot-complete marker: every component script has executed
            // and every enabled initializeX() has run. Automation (E2E) waits on this
            // instead of racing individual JE.* properties that appear mid-boot.
            JE.initialized = true;

            // Final Stage: Hide splash screen
            if (typeof JE.hideSplashScreen === 'function') {
                JE.hideSplashScreen();
            }

        } catch (error) {
            console.error('🪼 Jellyfin Elevate: CRITICAL INITIALIZATION FAILURE:', error);
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
