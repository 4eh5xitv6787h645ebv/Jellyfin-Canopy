// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately with placeholders
    window.JellyfinCanopy = {
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
            },
            // Drop an A-owned scheduled flush without unregistering the stable
            // cache callbacks. Identity reset hooks clear/rebind the callbacks'
            // mutable state before B is allowed to render or save.
            cancelPending() {
                if (this.scheduleId !== null) {
                    try {
                        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(this.scheduleId);
                    } catch (_) { /* not an idle-callback id */ }
                    try { clearTimeout(this.scheduleId); } catch (_) { /* harmless */ }
                }
                this.scheduleId = null;
                this.dirty = false;
            }
        },
        /**
         * Escapes HTML special characters to prevent XSS when interpolating into HTML strings.
         * Bootstrap copy only — replaced by the canonical JC.core.ui.escapeHtml
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
            const translations = window.JellyfinCanopy?.translations || {};
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
            // Replace {{icon:name}} tokens with JC.icon() calls
            text = text.replace(/\{\{icon:([a-zA-Z]+)\}\}/g, (match, iconName) => {
                const iconKey = iconName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
                const iconConstant = window.JellyfinCanopy.IconName?.[iconKey];

                // If IconName not loaded yet, keep the placeholder
                if (!iconConstant) {
                    console.debug(`[JC.t] IconName.${iconKey} not available yet, keeping placeholder`);
                    return match;
                }

                const iconResult = window.JellyfinCanopy.icon?.(iconConstant);

                // If icon function returns a pending token, keep original placeholder
                if (iconResult && iconResult.startsWith('{{ICON_PENDING:')) {
                    console.debug(`[JC.t] Icon system not ready, keeping placeholder for ${iconName}`);
                    return match;
                }

                return iconResult || match;
            });

            return text;
        },
        loadSettings: () => { console.warn("🪼 Jellyfin Canopy: loadSettings called before config.js loaded"); return {}; },
        initializeShortcuts: () => { console.warn("🪼 Jellyfin Canopy: initializeShortcuts called before config.js loaded"); },
        saveUserSettings: async (fileName) => { console.warn(`🪼 Jellyfin Canopy: saveUserSettings(${fileName}) called before config.js loaded`); }
    };

    const JC = window.JellyfinCanopy; // Alias for internal use

    /** Classify browser-storage exceptions without depending on DOMException. */
    function classifyStorageFailure(error) {
        const name = String(error?.name || '');
        const code = Number(error?.code);
        return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
            || code === 22 || code === 1014
            ? 'QuotaFailure'
            : 'Unavailable';
    }

    /**
     * Generation-scoped, bounded boot telemetry. Records intentionally omit raw
     * keys and exception messages because storage keys may contain user ids.
     */
    function createBootDiagnostics(limit = 64) {
        const maxEntries = Math.max(1, Math.min(256, Number(limit) || 64));
        let epoch = 0;
        let entries = [];

        function beginEpoch(nextEpoch) {
            const previousEpoch = epoch;
            epoch = Math.max(0, Number(nextEpoch) || 0);
            // Storage can fail before Jellyfin publishes an authenticated
            // identity (layout enforcement and credential probing both run in
            // epoch 0). Carry that bounded/redacted evidence into the first
            // real boot; later identity transitions start a clean generation.
            entries = previousEpoch === 0 && epoch > 0
                ? entries.map((entry) => Object.freeze({ ...entry, epoch }))
                : [];
        }

        function record(entry) {
            const candidate = {
                epoch,
                feature: String(entry?.feature || 'unknown'),
                phase: String(entry?.phase || 'storage'),
                operation: String(entry?.operation || 'unknown'),
                state: String(entry?.state || 'Unavailable'),
                storage: entry?.storage === 'session'
                    ? 'session'
                    : (entry?.storage === 'none' ? 'none' : 'local'),
                key: String(entry?.key || 'owned-key')
            };
            const duplicateIndex = entries.findIndex((existing) =>
                existing.feature === candidate.feature
                && existing.phase === candidate.phase
                && existing.operation === candidate.operation
                && existing.state === candidate.state
                && existing.storage === candidate.storage
                && existing.key === candidate.key);
            if (duplicateIndex >= 0) {
                const existing = entries[duplicateIndex];
                const repeated = Object.freeze({ ...candidate, count: existing.count + 1 });
                entries.splice(duplicateIndex, 1);
                entries.push(repeated);
                return repeated;
            }
            const safe = Object.freeze({ ...candidate, count: 1 });
            entries.push(safe);
            if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
            return safe;
        }

        return Object.freeze({
            beginEpoch,
            record,
            snapshot: () => Object.freeze({
                epoch,
                degraded: entries.length > 0,
                entries: Object.freeze(entries.slice())
            }),
            get size() { return entries.length; },
            get limit() { return maxEntries; }
        });
    }

    /**
     * Safe adapter for one browser Storage owner. Every operation reacquires the
     * object so a throwing `window.localStorage`/`sessionStorage` getter is also
     * contained. JSON corruption quarantines only the exact caller-owned key.
     */
    function createStorageAdapter(storageName, getStorage, diagnostics) {
        const storage = storageName === 'session' ? 'session' : 'local';

        function report(feature, operation, state, key) {
            if (state === 'Valid' || state === 'Missing') return;
            diagnostics?.record?.({ feature, phase: 'storage', operation, state, storage, key });
        }

        function failure(feature, operation, error, key) {
            const state = classifyStorageFailure(error);
            report(feature, operation, state, key);
            return { state, value: null };
        }

        function read(feature, key, keyLabel = 'owned-key') {
            try {
                const value = getStorage().getItem(key);
                return value === null
                    ? { state: 'Missing', value: null }
                    : { state: 'Valid', value };
            } catch (error) {
                return failure(feature, 'read', error, keyLabel);
            }
        }

        function write(feature, key, value, keyLabel = 'owned-key') {
            try {
                getStorage().setItem(key, String(value));
                return { state: 'Valid', value: String(value) };
            } catch (error) {
                return failure(feature, 'write', error, keyLabel);
            }
        }

        function remove(feature, key, keyLabel = 'owned-key') {
            try {
                getStorage().removeItem(key);
                return { state: 'Valid', value: null };
            } catch (error) {
                return failure(feature, 'remove', error, keyLabel);
            }
        }

        function keys(feature, keyLabel = 'owned-prefix-scan') {
            try {
                const target = getStorage();
                const result = [];
                // Snapshot first: removals by callers cannot reorder this scan.
                for (let i = 0; i < target.length; i++) {
                    const key = target.key(i);
                    if (typeof key === 'string') result.push(key);
                }
                return { state: 'Valid', value: result };
            } catch (error) {
                return failure(feature, 'keys', error, keyLabel);
            }
        }

        function quarantine(feature, key, keyLabel = 'owned-key') {
            report(feature, 'parse', 'Corrupt', keyLabel);
            const recovery = remove(feature, key, keyLabel);
            return {
                state: 'Corrupt',
                value: null,
                recovery: recovery.state === 'Valid' ? 'Removed' : recovery.state
            };
        }

        function readJson(feature, key, validate, keyLabel = 'owned-json') {
            const result = read(feature, key, keyLabel);
            if (result.state !== 'Valid') return result;
            try {
                const value = JSON.parse(result.value);
                if (typeof validate === 'function' && !validate(value)) {
                    return quarantine(feature, key, keyLabel);
                }
                return { state: 'Valid', value };
            } catch (_) {
                return quarantine(feature, key, keyLabel);
            }
        }

        function readNumber(feature, key, validate, keyLabel = 'owned-number') {
            const result = read(feature, key, keyLabel);
            if (result.state !== 'Valid') return result;
            if (!/^(?:0|-?[1-9]\d*)$/.test(result.value)) {
                return quarantine(feature, key, keyLabel);
            }
            const value = Number(result.value);
            if (!Number.isSafeInteger(value) || (typeof validate === 'function' && !validate(value))) {
                return quarantine(feature, key, keyLabel);
            }
            return { state: 'Valid', value };
        }

        return Object.freeze({ read, readJson, readNumber, write, remove, quarantine, keys });
    }

    const bootDiagnostics = createBootDiagnostics();
    JC.bootDiagnostics = bootDiagnostics;
    JC.storage = Object.freeze({
        local: createStorageAdapter('local', () => window.localStorage, bootDiagnostics),
        session: createStorageAdapter('session', () => window.sessionStorage, bootDiagnostics)
    });

    /**
     * Create the document-lifetime identity owner. The controller is deliberately
     * defined in this classic loader (rather than only in the later bundle):
     * Jellyfin 12 can replace authentication before the boot module has finished
     * loading, and invalidation must still happen synchronously in that window.
     *
     * @param {(change: {previous: object|null, current: object|null, epoch: number, reason: string}) => void} [finalizeTransition]
     */
    function createIdentitySession(finalizeTransition, diagnostics) {
        let epoch = 0;
        let current = null;
        const owners = new WeakMap();
        const resetHandlers = new Map();
        const activateHandlers = new Map();
        const rawUserIdsByEpoch = new Map();

        const normalize = (value) => String(value ?? '').trim().replace(/-/g, '').toLowerCase();
        const same = (a, b) => !!a && !!b
            && a.epoch === b.epoch
            && a.serverId === b.serverId
            && a.userId === b.userId;

        function capture() {
            return current;
        }

        function isCurrent(context) {
            return same(context, current);
        }

        /**
         * Accept one host identity transition. All registered reset handlers and
         * the loader finalizer run synchronously before this function returns.
         */
        function transition(serverId, userId, reason = 'unknown') {
            const rawUserId = String(userId ?? '').trim();
            const normalizedUserId = normalize(userId);
            const normalizedServerId = normalizedUserId
                ? (normalize(serverId) || 'unknown-server')
                : '';

            if ((!current && !normalizedUserId)
                || (current
                    && current.serverId === normalizedServerId
                    && current.userId === normalizedUserId)) {
                // Keep the first live raw spelling captured for this epoch. A
                // later normalized monitor read must not erase its dashes/case.
                if (current && rawUserId && !rawUserIdsByEpoch.has(current.epoch)) {
                    rawUserIdsByEpoch.set(current.epoch, rawUserId);
                }
                return current;
            }

            const previous = current;
            epoch += 1;
            current = normalizedUserId
                ? Object.freeze({ serverId: normalizedServerId, userId: normalizedUserId, epoch })
                : null;
            if (current) rawUserIdsByEpoch.set(epoch, rawUserId || normalizedUserId);
            // Only the previous/current values are useful to transition cleanup.
            for (const storedEpoch of [...rawUserIdsByEpoch.keys()]) {
                if (storedEpoch !== previous?.epoch && storedEpoch !== current?.epoch) {
                    rawUserIdsByEpoch.delete(storedEpoch);
                }
            }
            const change = Object.freeze({ previous, current, epoch, reason: String(reason || 'unknown') });

            for (const [name, handler] of [...resetHandlers.entries()]) {
                if (epoch !== change.epoch) return current;
                try {
                    handler(change);
                } catch (error) {
                    console.error(`🪼 Jellyfin Canopy: identity reset handler "${name}" failed`, error);
                }
                // A reset handler may synchronously accept a newer host identity.
                // Never continue the older handler snapshot or finalize its stale
                // change after that nested transition has completed.
                if (epoch !== change.epoch) return current;
            }
            if (epoch !== change.epoch) return current;
            try {
                finalizeTransition?.(change);
            } catch (error) {
                console.error('🪼 Jellyfin Canopy: identity transition finalizer failed', error);
            }
            return current;
        }

        function own(value, context = current) {
            if (context && value !== null && (typeof value === 'object' || typeof value === 'function')) {
                owners.set(value, context);
            }
            return value;
        }

        function ownerOf(value) {
            if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
            return owners.get(value) || null;
        }

        function isOwned(value, context = current) {
            const owner = ownerOf(value);
            return !!owner && !!context && same(owner, context);
        }

        function registerReset(name, handler) {
            if (!name || typeof handler !== 'function') return () => {};
            resetHandlers.set(String(name), handler);
            return () => {
                if (resetHandlers.get(String(name)) === handler) resetHandlers.delete(String(name));
            };
        }

        function registerActivate(name, handler) {
            if (!name || typeof handler !== 'function') return () => {};
            const key = String(name);
            const record = { handler, lastEpoch: -1, pendingEpoch: -1, pending: null };
            activateHandlers.set(key, record);
            return () => {
                if (activateHandlers.get(key) === record) activateHandlers.delete(key);
            };
        }

        async function activate(context = current) {
            if (!isCurrent(context)) return;
            const work = [];
            for (const [name, record] of [...activateHandlers.entries()]) {
                if (record.lastEpoch === context.epoch) continue;
                if (record.pendingEpoch === context.epoch && record.pending) {
                    work.push(record.pending);
                    continue;
                }

                const invocation = Promise.resolve()
                    .then(() => record.handler(context))
                    .then(() => {
                        // A late older invocation must not overwrite a newer
                        // epoch that has already activated successfully.
                        if (record.lastEpoch < context.epoch) record.lastEpoch = context.epoch;
                    })
                    .catch((error) => {
                        // A failed participant stays unmarked and therefore
                        // retryable, but it cannot abort its peers or the
                        // legacy activation tier for this current epoch.
                        if (error?.name === 'IdentityChangedError' || error?.name === 'AbortError'
                            || !isCurrent(context)) return;
                        try {
                            if (typeof diagnostics?.recordFeatureFailure === 'function') {
                                diagnostics.recordFeatureFailure(context, name, error);
                            } else {
                                console.error(
                                    `🪼 Jellyfin Canopy: identity activate handler "${name}" failed`,
                                    error
                                );
                            }
                        } catch (reportError) {
                            console.error(
                                `🪼 Jellyfin Canopy: identity activate handler "${name}" failed`,
                                error,
                                reportError
                            );
                        }
                    })
                    .finally(() => {
                        if (record.pending === invocation) {
                            record.pending = null;
                            record.pendingEpoch = -1;
                        }
                    });
                record.pendingEpoch = context.epoch;
                record.pending = invocation;
                work.push(invocation);
            }
            await Promise.all(work);
        }

        function getRawUserId(context = current) {
            if (!context) return '';
            return rawUserIdsByEpoch.get(context.epoch) || context.userId;
        }

        return Object.freeze({
            capture,
            isCurrent,
            transition,
            own,
            ownerOf,
            isOwned,
            registerReset,
            registerActivate,
            activate,
            getEpoch: () => epoch,
            getRawUserId,
            getResetHandlerCount: () => resetHandlers.size,
            getActivateHandlerCount: () => activateHandlers.size,
            // Read-only loader diagnostics. The indirection lets the immutable
            // identity surface be installed before initialization machinery is
            // declared later in this classic script.
            getPendingInitializationCount: () => Number(diagnostics?.getPendingInitializationCount?.() || 0),
            getInitializationControllerCount: () => Number(diagnostics?.getInitializationControllerCount?.() || 0)
        });
    }

    // Assigned after all loader helpers have been declared. Identity transitions
    // can nevertheless call through this slot safely during normal host use.
    let initializationRegistry = null;
    const loaderDiagnostics = {
        getPendingInitializationCount: () => initializationRegistry?.getPendingCount?.() || 0,
        getInitializationControllerCount: () => initializationRegistry?.getControllerCount?.() || 0,
        recordFeatureFailure: (context, name, error) => recordFeatureFailure(context, name, error)
    };

    function emptyUserConfig() {
        return {
            settings: {},
            shortcuts: { Shortcuts: [] },
            bookmark: { bookmarks: {} },
            elsewhere: {},
            hiddenContent: { items: {}, settings: {} }
        };
    }

    /**
     * Last synchronous phase of every identity change. Feature reset handlers
     * run first so they can inspect/tear down their old state; only then are the
     * shared globals replaced with owner-tagged empty state.
     */
    function finalizeIdentityTransition(change) {
        bootDiagnostics.beginEpoch(change.epoch);
        // Abort and logically drain every older loader initialization before any
        // B-owned global is published. Raw host ajax implementations sometimes
        // ignore AbortSignal; the registry cancellation race still settles and
        // evicts their old epoch synchronously.
        initializationRegistry?.cancelExcept?.(change.current?.epoch ?? null, change.epoch);
        // Jellyfin's compatibility language key is user-only. Remove A's live
        // projection synchronously; B republishes it from a server+user scoped
        // Canopy key after its settings file is loaded.
        for (const userId of identityStorageUserIdVariants(change.previous)) {
            JC.storage.local.remove('identity-transition', `${userId}-language`, 'compatibility-language');
        }
        JC._cacheManager?.cancelPending?.();
        JC.initialized = false;
        JC._tagCachePrefetch = null;
        JC.currentUser = null;
        JC.currentSettings = undefined;
        JC.pluginConfig = {};
        JC.translations = {};
        JC.pluginVersion = 'unknown';

        if (JC.state) {
            JC.state.activeShortcuts = {};
            JC.state.removeContext = null;
            if (JC.state.pauseScreenClickTimer != null) {
                clearTimeout(JC.state.pauseScreenClickTimer);
                JC.state.pauseScreenClickTimer = null;
            }
        }

        const nextUserConfig = emptyUserConfig();
        identity.own(nextUserConfig, change.current);
        for (const value of Object.values(nextUserConfig)) identity.own(value, change.current);
        JC.userConfig = nextUserConfig;

        // The image filter consumes this cookie before JavaScript-backed UI can
        // repaint. Rewrite/delete it inside the synchronous transition itself so
        // B's first image request can never carry A's identity hint.
        try {
            const secure = window.location.protocol === 'https:' ? '; Secure' : '';
            if (change.current?.userId) {
                document.cookie = `jc-spoiler-uid=${encodeURIComponent(change.current.userId)}; path=/; SameSite=Lax${secure}`;
            } else {
                document.cookie = `jc-spoiler-uid=; path=/; Max-Age=0; SameSite=Lax${secure}`;
            }
        } catch (_) { /* cookies can be disabled */ }
    }

    const identity = createIdentitySession(finalizeIdentityTransition, loaderDiagnostics);
    JC.identity = identity;
    JC.core.identity = identity;

    /** All compatibility-key spellings associated with one canonical owner. */
    function identityStorageUserIdVariants(context) {
        if (!context?.userId) return [];
        const canonical = String(context.userId);
        const raw = String(identity.getRawUserId?.(context) || canonical).trim();
        const dashed = /^[0-9a-f]{32}$/i.test(canonical)
            ? `${canonical.slice(0, 8)}-${canonical.slice(8, 12)}-${canonical.slice(12, 16)}-${canonical.slice(16, 20)}-${canonical.slice(20)}`
            : '';
        return [...new Set([canonical, raw, dashed].filter(Boolean))];
    }

    /** Resolve the stable server half of the canonical identity. */
    function getClientServerId(client) {
        if (!client) return '';
        try {
            const direct = typeof client.serverId === 'function' ? client.serverId() : client.serverId;
            if (direct) return direct;
        } catch (_) { /* try the server-info forms */ }
        try {
            const info = typeof client.serverInfo === 'function' ? client.serverInfo() : client._serverInfo;
            if (info?.Id || info?.ServerId) return info.Id || info.ServerId;
        } catch (_) { /* fall through to address */ }
        try {
            const address = typeof client.serverAddress === 'function'
                ? client.serverAddress()
                : client.getUrl?.('/');
            if (address) return new URL(address, window.location.href).origin;
        } catch (_) { /* unknown server is still fenced by epoch/user */ }
        return '';
    }

    const AUTH_WRAPPED = '__jcIdentityAuthenticationWrapped';
    let identityMonitorId = null;
    let pendingActivation = null;
    let apiClientPropertyHookInstalled = false;

    /** Preserve the host setter exactly while bracketing it with identity work. */
    function createAuthenticationWrapper(original, before, after, onError) {
        return function(accessKey, userId) {
            const beforeResult = before.call(this, accessKey, userId);
            let result;
            try {
                result = original.apply(this, arguments);
            } catch (error) {
                // Reconcile synchronously while the host still exposes whatever
                // authentication state its failed setter retained. Never replace
                // the host's original exception with a reconciliation failure.
                try { onError?.call(this, beforeResult, error, accessKey, userId); }
                catch (_) { /* preserve the original host throw */ }
                throw error;
            }
            after.call(this, beforeResult, accessKey, userId);
            return result;
        };
    }

    /**
     * Replace a configurable host property with a publication fence while
     * retaining its enumerability, configurability, getter/setter `this` value,
     * and assignment failure behaviour. A configurable writable data property
     * necessarily becomes an accessor, but normal host reads/writes retain the
     * same value semantics. Non-configurable/read-only properties are left
     * untouched so the polling bridge can remain the graceful fallback.
     */
    function installPropertyPublicationFence(target, propertyName, beforePublish, afterPublish) {
        if (!target || !propertyName) return false;
        const descriptor = Object.getOwnPropertyDescriptor(target, propertyName);
        if (!descriptor) {
            // Do not reserve an absent global: jellyfin-web may install it later
            // with a descriptor whose semantics we must preserve. Readiness/monitor
            // retries call this helper again once the real property exists.
            return false;
        }
        if (!descriptor.configurable) return false;

        const isData = Object.prototype.hasOwnProperty.call(descriptor, 'value');
        if (isData && !descriptor.writable) return false;
        if (!isData && typeof descriptor.set !== 'function') return false;

        let currentValue = isData ? descriptor.value : undefined;
        const originalGet = descriptor.get;
        const originalSet = descriptor.set;
        const readCurrent = function(receiver) {
            return isData ? currentValue : originalGet?.call(receiver);
        };
        const runBefore = function(receiver, next, previous) {
            try { return beforePublish?.call(receiver, next, previous); }
            catch (_) { return undefined; }
        };
        const runAfter = function(receiver, next, prepared, error) {
            try { afterPublish?.call(receiver, next, prepared, error); }
            catch (_) { /* a fence must never break the host's assignment */ }
        };

        try {
            Object.defineProperty(target, propertyName, {
                configurable: descriptor.configurable,
                enumerable: descriptor.enumerable,
                get: function() {
                    return readCurrent(this);
                },
                set: function(next) {
                    // Match OrdinarySetWithOwnDescriptor for a writable data
                    // property used with a different Reflect.set receiver.
                    if (isData && this !== target) {
                        if (this !== null && (typeof this === 'object' || typeof this === 'function')) {
                            Object.defineProperty(this, propertyName, {
                                configurable: true,
                                enumerable: descriptor.enumerable,
                                writable: true,
                                value: next
                            });
                        }
                        return;
                    }

                    const previous = readCurrent(this);
                    const prepared = this === target
                        ? runBefore(this, next, previous)
                        : undefined;
                    try {
                        if (isData) currentValue = next;
                        else originalSet.call(this, next);
                    } catch (error) {
                        if (this === target) runAfter(this, previous, prepared, error);
                        throw error;
                    }
                    if (this === target) runAfter(this, readCurrent(this), prepared, null);
                }
            });
            return true;
        } catch (_) {
            return false;
        }
    }

    function scheduleInitializationForClient(client, context) {
        if (!context || !identity.isCurrent(context)) return;
        pendingActivation = { client, context };
        pumpPendingActivation();
    }

    function pumpPendingActivation() {
        const pending = pendingActivation;
        if (!pending || !identity.isCurrent(pending.context)) {
            pendingActivation = null;
            return;
        }
        let liveUserId = '';
        try { liveUserId = pending.client?.getCurrentUserId?.() || ''; } catch (_) { /* wait */ }
        const normalizedLiveUser = String(liveUserId).replace(/-/g, '').toLowerCase();
        const rawLiveServer = String(getClientServerId(pending.client) || '');
        const normalizedLiveServer = rawLiveServer
            ? rawLiveServer.trim().replace(/-/g, '').toLowerCase()
            : 'unknown-server';
        if (window.ApiClient !== pending.client
            || normalizedLiveUser !== pending.context.userId
            || normalizedLiveServer !== pending.context.serverId) return;
        pendingActivation = null;
        void startInitialization(pending.context, pending.client);
    }

    /** Patch the common ApiClient owner once; every server instance shares it. */
    function installAuthenticationHook(client) {
        if (!client) return false;
        let owner = client;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, 'setAuthenticationInfo')) {
            owner = Object.getPrototypeOf(owner);
        }
        const original = owner?.setAuthenticationInfo;
        if (!owner || typeof original !== 'function') return false;
        if (original[AUTH_WRAPPED]) return true;

        const wrapped = createAuthenticationWrapper(
            original,
            function(_accessKey, userId) {
                // Invalidate A before the host mutates its token/user. This
                // closes the B-auth/A-snapshot window, including sync handlers.
                return identity.transition(getClientServerId(this), userId, 'setAuthenticationInfo');
            },
            function(next, _accessKey, userId) {
                if (userId && next) scheduleInitializationForClient(this, next);
                else pendingActivation = null;
            },
            function(_attempted, _error) {
                let liveUserId = '';
                try { liveUserId = this.getCurrentUserId?.() || ''; } catch (_) { /* signed out */ }
                const restored = identity.transition(
                    getClientServerId(this),
                    liveUserId,
                    'setAuthenticationInfo-failed'
                );
                if (liveUserId && restored) scheduleInitializationForClient(this, restored);
                else pendingActivation = null;
            }
        );
        Object.defineProperty(wrapped, AUTH_WRAPPED, { value: true });
        Object.defineProperty(wrapped, '__jcOriginal', { value: original });
        try {
            const descriptor = Object.getOwnPropertyDescriptor(owner, 'setAuthenticationInfo');
            // A mixed accessor+value descriptor is invalid by definition. Only
            // patch a writable/configurable data property directly; accessors use
            // the instance fallback below.
            if (descriptor
                && Object.prototype.hasOwnProperty.call(descriptor, 'value')
                && descriptor.writable !== false) {
                Object.defineProperty(owner, 'setAuthenticationInfo', { ...descriptor, value: wrapped });
                return true;
            }
        } catch (_) {
            // Try the instance fallback below.
        }
        try {
            client.setAuthenticationInfo = wrapped;
            return client.setAuthenticationInfo === wrapped;
        } catch (_) {
            return false;
        }
    }

    function prepareApiClientPublication(client) {
        installAuthenticationHook(client);
        let userId = '';
        try { userId = client?.getCurrentUserId?.() || ''; } catch (_) { /* signed out */ }
        const context = identity.transition(getClientServerId(client), userId, 'ApiClient-replacement');
        return { client, context, userId };
    }

    function completeApiClientPublication(publishedClient, prepared, error) {
        if (error) {
            // An opaque host setter may reject after the pre-publication fence.
            // Reconcile the value it actually retained without swallowing or
            // changing the original exception.
            try { reconcileCurrentIdentity('ApiClient-replacement-failed'); } catch (_) { /* monitor will retry */ }
            return;
        }
        if (!prepared || publishedClient !== prepared.client) {
            // An accessor may canonicalize the assigned value. Its setter was
            // fenced against the candidate; now reconcile the effective value.
            try { reconcileCurrentIdentity('ApiClient-replacement-effective'); } catch (_) { /* monitor will retry */ }
            return;
        }
        if (prepared.context && prepared.userId) {
            scheduleInitializationForClient(publishedClient, prepared.context);
        } else {
            pendingActivation = null;
        }
    }

    function installApiClientReplacementHook() {
        if (apiClientPropertyHookInstalled) return true;
        apiClientPropertyHookInstalled = installPropertyPublicationFence(
            window,
            'ApiClient',
            prepareApiClientPublication,
            completeApiClientPublication
        );
        return apiClientPropertyHookInstalled;
    }

    function reconcileCurrentIdentity(reason = 'monitor') {
        const client = window.ApiClient;
        if (!client) return null;
        installAuthenticationHook(client);
        let userId = '';
        try { userId = client.getCurrentUserId?.() || ''; } catch (_) { /* signed out */ }
        const context = identity.transition(getClientServerId(client), userId, reason);
        if (context && userId) scheduleInitializationForClient(client, context);
        return context;
    }

    function ensureIdentityBridge() {
        // This configurable-property path fences an already-authenticated B
        // synchronously, before the assignment makes B globally observable.
        // The interval below remains for non-configurable globals and foreign
        // replacements that redefine the property descriptor entirely.
        installApiClientReplacementHook();
        const client = window.ApiClient;
        if (client) installAuthenticationHook(client);
        if (identityMonitorId === null) {
            // Belt-and-braces for a future host that gives each server a distinct
            // ApiClient implementation. The setter hook is the synchronous paved
            // road; this single document-lifetime monitor installs on replacements.
            identityMonitorId = window.setInterval(() => {
                try {
                    installApiClientReplacementHook();
                    reconcileCurrentIdentity('identity-monitor');
                    pumpPendingActivation();
                } catch (_) { /* host is between clients */ }
            }, 250);
        }
    }

    /**
     * Shared key-conversion owner for both load and save directions.
     * `opaqueDictionaryPaths` names DTO properties whose CHILD object is a map:
     * map keys are copied byte-for-byte, while each map value resumes ordinary
     * DTO-property conversion. Output collisions throw before the caller can
     * publish or persist the returned value; the input object is never mutated.
     *
     * @param {unknown} obj
     * @param {(key: string) => string} convertKey
     * @param {{preserveKey?: (key: string) => boolean, opaqueDictionaryPaths?: readonly (readonly string[])[]}} [opts]
     * @param {readonly string[]} [path]
     * @returns {unknown}
     */
    function transformObjectKeys(obj, convertKey, opts, path = []) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) {
            return obj.map(value => transformObjectKeys(value, convertKey, opts, path));
        }

        const opaqueHere = !!opts?.opaqueDictionaryPaths?.some(candidate =>
            candidate.length === path.length
            && candidate.every((segment, index) =>
                String(segment).toLowerCase() === String(path[index]).toLowerCase()));
        // Opaque dictionaries must not inherit Object.prototype: otherwise an
        // absent id such as `toString` or `constructor` looks present to a
        // consumer that performs property lookup. DTO objects remain ordinary.
        const converted = opaqueHere ? Object.create(null) : {};
        const sourceByOutput = new Map();
        for (const key of Object.keys(obj)) {
            const outputKey = opaqueHere || opts?.preserveKey?.(key) ? key : convertKey(key);
            if (Object.prototype.hasOwnProperty.call(converted, outputKey)) {
                const location = path.length > 0 ? path.join('.') : '<root>';
                throw new Error(
                    `Case transformation collision at ${location}: `
                    + `'${sourceByOutput.get(outputKey)}' and '${key}' both map to '${outputKey}'`);
            }
            sourceByOutput.set(outputKey, key);
            Object.defineProperty(converted, outputKey, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: transformObjectKeys(obj[key], convertKey, opts, [...path, key])
            });
        }
        return converted;
    }

    /** Converts PascalCase DTO properties to camelCase without mutating input. */
    function toCamelCase(obj, opts) {
        return transformObjectKeys(
            obj,
            key => key.charAt(0).toLowerCase() + key.slice(1),
            opts);
    }

    /** Converts camelCase DTO properties to PascalCase without mutating input. */
    function toPascalCase(obj, opts) {
        return transformObjectKeys(
            obj,
            key => key.charAt(0).toUpperCase() + key.slice(1),
            opts);
    }

    /**
     * Schema audit for user files that cross the classic loader's name bridge.
     * Bookmarks and hidden-content Items are dictionaries keyed by external or
     * generated identity, not DTOs. Settings/elsewhere/shortcuts have no such
     * transformed dictionary boundary in this bridge. Spoiler maps and legacy
     * reviews use typed, dedicated server APIs and never pass through it.
     */
    function userFileCaseOptions(fileName) {
        switch (String(fileName || '').toLowerCase()) {
            case 'bookmark.json':
                return { opaqueDictionaryPaths: [['Bookmarks']] };
            case 'hidden-content.json':
                return { opaqueDictionaryPaths: [['Items']] };
            default:
                return undefined;
        }
    }

    /** One schema-aware primitive used by user-file load and save transforms. */
    function transformUserFileCase(fileName, value, direction) {
        const opts = userFileCaseOptions(fileName);
        if (direction === 'load') return toCamelCase(value, opts);
        if (direction === 'save') return toPascalCase(value, opts);
        throw new Error(`Unsupported user-file case-transform direction '${direction}'`);
    }

    JC.toPascalCase = toPascalCase;
    JC.toCamelCase = toCamelCase;
    JC.transformUserFileCase = transformUserFileCase;

    /**
     * Injects Druidblack metadata icons CSS.
     * PERF: no remote assets — served from the local asset cache (the server
     * rewrites the CSS's internal icon urls to local copies too). The original
     * CDN URL is only used when the admin disabled the asset cache. Called
     * after loadConfig(), so JC.pluginConfig is populated here.
     * @param {boolean} enabled
     */
    function injectMetadataIcons(enabled) {
        const existing = document.getElementById('metadataIconsCss');
        if (enabled && !existing) {
            const link = document.createElement('link');
            link.id = 'metadataIconsCss';
            link.rel = 'stylesheet';
            link.href = JC.pluginConfig?.AssetCacheEnabled !== false
                ? ApiClient.getUrl('/JellyfinCanopy/assets/metadata-icons/public-icon.css')
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
     * @param {object} userSettings - Raw JC.userConfig.settings.
     * @returns {boolean}
     */
    function resolveGenreTagsEnabled(userSettings) {
        return (userSettings.genreTagsEnabled !== undefined && userSettings.genreTagsEnabled !== null)
            ? !!userSettings.genreTagsEnabled
            : !!JC.pluginConfig?.GenreTagsEnabled;
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
        if (JC.pluginConfig?.AssetCacheEnabled === false) return;
        try {
            if (!document.getElementById('jc-mat-sym-rounded-preload')) {
                const preload = document.createElement('link');
                preload.id = 'jc-mat-sym-rounded-preload';
                preload.rel = 'preload';
                preload.as = 'font';
                preload.type = 'font/woff2';
                // Font preloads must be anonymous-CORS to match the request
                // mode of CSS @font-face fetches, or the browser re-fetches.
                preload.crossOrigin = 'anonymous';
                preload.href = ApiClient.getUrl('/JellyfinCanopy/assets/fonts/material-symbols-rounded.woff2');
                document.head.appendChild(preload);
            }

            const userSettings = JC.userConfig?.settings || {};
            const genreTagsOn = resolveGenreTagsEnabled(userSettings);
            if (genreTagsOn && !document.getElementById('mat-sym')) {
                const link = document.createElement('link');
                link.id = 'mat-sym'; // same id genretags.ts checks before injecting
                link.rel = 'stylesheet';
                link.href = ApiClient.getUrl('/JellyfinCanopy/assets/fonts/material-symbols-outlined.css');
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
            console.warn('🪼 Jellyfin Canopy: Failed to preload icon fonts', e);
        }
    }

    /**
     * Returns the plugin version for use as a cache-busting query parameter.
     * Reads synchronously from the injected script tag's version attribute so it
     * is available before the async version fetch resolves. Falls back to
     * JC.pluginVersion when already set (post-init calls), and to Date.now() if
     * neither source is available.
     * @returns {string}
     */
    function getScriptVersion() {
        const scriptEl = document.querySelector('script[plugin="Jellyfin Canopy"]');
        if (scriptEl?.getAttribute('dev') === 'true') return Date.now();
        // Always prefer the script tag's version attribute, it holds the full
        // cacheKey (version + DLL timestamp) baked in at server startup.
        // JC.pluginVersion is just the bare version number from the API and
        // does not include the timestamp component.
        return scriptEl?.getAttribute('version') || JC.pluginVersion || Date.now();
    }

    /**
     * Loads the translation module and exposes JC.loadTranslations.
     * @returns {Promise<void>}
     */
    let translationsModulePromise = null;
    async function loadTranslationsModule(client = ApiClient) {
        if (typeof JC.loadTranslations === 'function') return;
        if (translationsModulePromise) return translationsModulePromise;
        translationsModulePromise = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = client.getUrl(`/JellyfinCanopy/dist/translations.js?v=${getScriptVersion()}`);
            script.onload = () => resolve();
            script.onerror = (e) => {
                console.error('🪼 Jellyfin Canopy: Failed to load translations module', e);
                translationsModulePromise = null;
                resolve();
            };
            document.head.appendChild(script);
        });
        await translationsModulePromise;
    }

    /**
     * Loads the appropriate language file based on the user's settings.
     * Attempts to fetch from GitHub first (with caching), falls back to bundled translations.
     * @returns {Promise<object>} A promise that resolves to the translations object.
     */
    async function loadTranslations() {
        if (typeof JC.loadTranslations === 'function') {
            return JC.loadTranslations();
        }
        console.warn('🪼 Jellyfin Canopy: Translations module not loaded, falling back to empty translations');
        return {};
    }

     /**
     * Fetches plugin configuration and version from the server.
     * @returns {Promise<[object, string]>} A promise that resolves with config and version.
     */
     function loadPluginData(client = ApiClient, scope = null) {
        const configRequest = client.ajax({
            type: 'GET',
            url: client.getUrl('/JellyfinCanopy/public-config'),
            dataType: 'json',
            signal: scope?.signal
        });
        const configPromise = (scope ? scope.race(configRequest) : configRequest).catch((e) => {
            if (scope?.signal?.aborted) return {};
            console.error("🪼 Jellyfin Canopy: Failed to fetch public config", e);
            return {}; // Return empty object on error
        });

        const versionRequest = client.ajax({
            type: 'GET',
            url: client.getUrl('/JellyfinCanopy/version'),
            dataType: 'text',
            signal: scope?.signal
        });
        const versionPromise = (scope ? scope.race(versionRequest) : versionRequest).catch((e) => {
            if (scope?.signal?.aborted) return 'unknown';
             console.error("🪼 Jellyfin Canopy: Failed to fetch version", e);
            return 'unknown'; // Return placeholder on error
        });

        return Promise.all([configPromise, versionPromise]);
    }

    /**
     * Fetches sensitive configuration from the authenticated endpoint.
     * Returns the config object (instead of merging it here) so the fetch can
     * run in parallel with the public-config fetch — the caller merges it into
     * JC.pluginConfig once that object exists.
     * @returns {Promise<object|null>} The private config, or null on failure.
     */
    async function loadPrivateConfig(client = ApiClient, scope = null) {
        try {
            const request = client.ajax({
                type: 'GET',
                url: client.getUrl('/JellyfinCanopy/private-config'),
                dataType: 'json',
                signal: scope?.signal
            });
            return await (scope ? scope.race(request) : request);
        } catch (error) {
            if (scope?.signal?.aborted) return null;
            console.warn('🪼 Jellyfin Canopy: Could not load private configuration. Some features may be limited.', error);
            return null; // Don't merge anything if it fails
        }
    }


    /** Reject traversal, query fragments and ambiguous distribution paths. */
    function isSafeClientDistPath(value) {
        if (typeof value !== 'string' || !value || value.startsWith('/')
            || value.includes('\\') || value.includes('?') || value.includes('#')) return false;
        return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
    }

    /**
     * Validate the manifest fields used by the pre-module trust boundary. The
     * server independently validates the complete embedded inventory; this
     * check prevents a malformed response from becoming an executable URL.
     */
    function validateClientManifest(value) {
        if (!value || typeof value !== 'object' || value.schemaVersion !== 2
            || !/^[a-f0-9]{64}$/.test(String(value.buildId || ''))
            || !value.entries || typeof value.entries !== 'object'
            || Array.isArray(value.entries)
            || !value.files || typeof value.files !== 'object'
            || Array.isArray(value.files)) {
            throw new Error('Invalid Jellyfin Canopy client manifest');
        }
        const boot = value.entries.boot;
        if (!boot || boot.kind !== 'module' || boot.role !== 'boot'
            || !isSafeClientDistPath(boot.path)) {
            throw new Error('Jellyfin Canopy manifest has no valid boot module');
        }
        const bootFile = Object.prototype.hasOwnProperty.call(value.files, boot.path)
            ? value.files[boot.path]
            : null;
        if (!bootFile || bootFile.kind !== 'module-entry'
            || bootFile.contentType !== 'text/javascript; charset=utf-8'
            || !/^[a-f0-9]{64}$/.test(String(bootFile.sha256 || ''))) {
            throw new Error('Jellyfin Canopy boot module is missing from the manifest inventory');
        }
        return value;
    }

    /** Resolve one manifest-owned file through Jellyfin's reverse-proxy base. */
    function clientGenerationUrl(client, manifest, path, attempt) {
        if (!isSafeClientDistPath(path)
            || !Object.prototype.hasOwnProperty.call(manifest?.files || {}, path)) {
            throw new Error(`Unknown Jellyfin Canopy distribution file: ${String(path)}`);
        }
        const retry = Math.min(2, Math.max(0, Number.isSafeInteger(attempt) ? attempt : 0));
        return client.getUrl(`/JellyfinCanopy/dist/${manifest.buildId}/${path}?attempt=${retry}`);
    }

    /** Native ESM import kept behind one named seam for the loader harness. */
    function importClientModule(url) {
        return import(url);
    }

    /**
     * Fetch and import the manifest-owned boot module. A successful module is
     * document-scoped; a rejected flight is evicted so the next identity init
     * can retry. The compatibility monolith is deliberately not a fallback.
     */
    let clientRuntimeLoadPromise = null;
    function loadClientRuntime(client = ApiClient, scope = null) {
        if (!clientRuntimeLoadPromise) {
            const flight = (async () => {
                const request = client.ajax({
                    type: 'GET',
                    url: client.getUrl('/JellyfinCanopy/dist/client-manifest.json'),
                    dataType: 'json',
                    signal: scope?.signal
                });
                const manifest = validateClientManifest(await request);
                let lastError = null;
                for (let attempt = 0; attempt <= 2; attempt++) {
                    try {
                        const bootModule = await importClientModule(
                            clientGenerationUrl(client, manifest, manifest.entries.boot.path, attempt)
                        );
                        if (typeof bootModule?.initializeClientRuntime !== 'function') {
                            throw new Error('Jellyfin Canopy boot module has no runtime initializer');
                        }
                        return bootModule.initializeClientRuntime({
                            manifest,
                            generationUrl: (path, retry) => clientGenerationUrl(client, manifest, path, retry),
                            onError: (featureId, phase, error) => {
                                console.error(
                                    `🪼 Jellyfin Canopy: feature "${String(featureId)}" ${String(phase)} failed`,
                                    error
                                );
                            }
                        });
                    } catch (error) {
                        lastError = error;
                        console.warn(
                            `🪼 Jellyfin Canopy: boot module attempt ${attempt} failed`,
                            error
                        );
                    }
                }
                throw lastError || new Error('Jellyfin Canopy boot module failed to load');
            })();
            clientRuntimeLoadPromise = flight;
            void flight.catch(() => {
                if (clientRuntimeLoadPromise === flight) clientRuntimeLoadPromise = null;
            });
        }
        return scope ? scope.race(clientRuntimeLoadPromise) : clientRuntimeLoadPromise;
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
        splashScript.src = ApiClient.getUrl('/JellyfinCanopy/dist/splashscreen.js?v=' + getScriptVersion());
        splashScript.onload = () => {
            if (typeof JC.initializeSplashScreen === 'function') {
                JC.initializeSplashScreen(); // Initialize if available
            }
        };
         splashScript.onerror = () => console.error('🪼 Jellyfin Canopy: Failed to load splash screen script.');
        document.head.appendChild(splashScript);
    }

    /**
     * Injects a maintenance banner at the top of the page.
     */
    function injectMaintenanceBanner(message) {
        if (document.getElementById('jc-maintenance-banner')) return;
        const text = (message || '').trim() || 'This server is currently undergoing maintenance. Please try again later.';
        const banner = document.createElement('div');
        banner.id = 'jc-maintenance-banner';
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
            const existing = document.getElementById('jc-maintenance-banner-style');
            if (existing) return;
            const style = document.createElement('style');
            style.id = 'jc-maintenance-banner-style';
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
    // route tree, so a change only takes effect on reload. See the layout modes
    // and enforcement section in docs/developers.md.
    var LAYOUT_STORAGE_KEY = 'layout';
    var LAYOUT_EXPERIMENTAL = 'experimental';
    var LAYOUT_LEGACY = 'desktop';
    var LAYOUT_ENFORCED_SESSION_KEY = 'jc_layout_enforced';

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
     * Detection tolerates BOTH Jellyfin-12 layout-value dialects (see the layout
     * modes and enforcement section in docs/developers.md). The VALUES WRITTEN
     * by enforcement below target the shipped 12.0.0 build
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

            const storedResult = JC.storage.local.read('layout-enforcement', LAYOUT_STORAGE_KEY, 'host-layout');
            if (storedResult.state !== 'Valid' && storedResult.state !== 'Missing') return false;
            const stored = storedResult.value;

            const decision = resolveLayoutEnforcement(mode, stored);
            if (!decision.changed) {
                // Converged (or nothing to do): clear the loop marker so a future
                // divergence can be re-enforced with one reload.
                JC.storage.session.remove('layout-enforcement', LAYOUT_ENFORCED_SESSION_KEY, 'reload-guard');
                return false;
            }

            const writeResult = JC.storage.local.write('layout-enforcement', LAYOUT_STORAGE_KEY, decision.value, 'host-layout');
            if (writeResult.state !== 'Valid') return false;
            // Read-back guard: some environments accept setItem but do not
            // actually persist (ephemeral/in-memory/quota-broken storage). If
            // the write did not stick, reloading would land right back here.
            const persisted = JC.storage.local.read('layout-enforcement', LAYOUT_STORAGE_KEY, 'host-layout');
            if (persisted.state !== 'Valid' || persisted.value !== decision.value) return false;

            if (!decision.reload) {
                // Persisted the target without a reload (device already paints it):
                // we are at the target, so clear any stale loop marker.
                JC.storage.session.remove('layout-enforcement', LAYOUT_ENFORCED_SESSION_KEY, 'reload-guard');
                return false;
            }

            // Loop guard: bail only if we ALREADY reloaded toward this exact target
            // this session and the value still has not stuck (a write that never
            // persists) — otherwise a genuine new divergence gets its one reload.
            const guard = JC.storage.session.read('layout-enforcement', LAYOUT_ENFORCED_SESSION_KEY, 'reload-guard');
            if (guard.state !== 'Valid' && guard.state !== 'Missing') return false;
            if (guard.value === decision.value) return false;
            if (JC.storage.session.write('layout-enforcement', LAYOUT_ENFORCED_SESSION_KEY, decision.value, 'reload-guard').state !== 'Valid') return false;

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
            url: ApiClient.getUrl('/JellyfinCanopy/public-config'),
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
                loginImageScript.src = ApiClient.getUrl('/JellyfinCanopy/dist/login-image.js?v=' + getScriptVersion());
                loginImageScript.onerror = () => console.error('🪼 Jellyfin Canopy: Failed to load login image script.');
                document.head.appendChild(loginImageScript);
            }
        }).catch(() => {
            console.warn('🪼 Jellyfin Canopy: Could not fetch config for login image, skipping.');
        });
    }

    /**
     * Checks if there's a server ID mismatch (stale credentials from previous server)
     * @returns {boolean}
     */
    function hasServerIdMismatch() {
        try {
            if (typeof ApiClient === 'undefined') return false;

            const credentials = JC.storage.local.read('server-identity-check', 'jellyfin_credentials', 'host-credentials');
            if (credentials.state !== 'Valid') return false;
            const creds = credentials.value;

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
    // 590*250ms ≈ 2.5 min — generous enough for a real user typing credentials.
    // The identity setter hook remains installed after this readiness poll stops,
    // so a later no-reload login still starts its own epoch initialization.
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
     * Per-epoch loader work registry. `AbortController` gives cooperative host
     * transports a real cancellation signal; the cancellation promise also
     * settles the logical work immediately when an older host ajax ignores it.
     * Old entries are synchronously removed by cancelExcept(), so indefinitely
     * held raw promises cannot grow either diagnostic map across switches.
     */
    function createInitializationRegistry(makeCancellationError = () => new Error('Initialization cancelled')) {
        const workByEpoch = new Map();
        const scopesByEpoch = new Map();
        let cancelledThroughEpoch = 0;
        let latestTransitionEpoch = 0;

        function createScope(epoch) {
            const controller = new AbortController();
            let cancelled = false;
            let cancellationError = null;
            let rejectCancellation;
            const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
            const scope = {
                epoch,
                signal: controller.signal,
                race(promise) {
                    if (cancelled) return Promise.reject(cancellationError);
                    return Promise.race([Promise.resolve(promise), cancellation]);
                },
                cancel() {
                    if (cancelled) return;
                    cancelled = true;
                    cancellationError = makeCancellationError();
                    controller.abort();
                    rejectCancellation(cancellationError);
                }
            };
            return scope;
        }

        function start(epoch, run) {
            if (epoch <= cancelledThroughEpoch) {
                return Promise.reject(makeCancellationError());
            }
            const existing = workByEpoch.get(epoch);
            if (existing) return existing;
            let scope = scopesByEpoch.get(epoch);
            if (!scope) {
                scope = createScope(epoch);
                scopesByEpoch.set(epoch, scope);
            }
            let produced;
            try { produced = run(scope); }
            catch (error) { produced = Promise.reject(error); }
            const work = scope.race(produced).finally(() => {
                if (workByEpoch.get(epoch) === work) workByEpoch.delete(epoch);
            });
            workByEpoch.set(epoch, work);
            return work;
        }

        function cancelExcept(keepEpoch, transitionEpoch = keepEpoch) {
            const transitionNumber = Number(transitionEpoch) || 0;
            // A stale outer transition must not cancel scopes owned by a newer
            // nested transition. Identity epochs are monotonic document-wide.
            if (transitionNumber < latestTransitionEpoch) return;
            latestTransitionEpoch = transitionNumber;
            cancelledThroughEpoch = Math.max(
                cancelledThroughEpoch,
                keepEpoch == null ? transitionNumber : Number(keepEpoch) - 1
            );
            for (const [epoch, scope] of [...scopesByEpoch.entries()]) {
                if (epoch === keepEpoch) continue;
                if (transitionNumber && epoch > transitionNumber) continue;
                scope.cancel();
                scopesByEpoch.delete(epoch);
            }
            // Evict synchronously. Each work promise will also self-check in its
            // finally, so a late A settlement cannot delete a newer entry.
            for (const epoch of [...workByEpoch.keys()]) {
                if (epoch !== keepEpoch && (!transitionNumber || epoch <= transitionNumber)) {
                    workByEpoch.delete(epoch);
                }
            }
        }

        return Object.freeze({
            start,
            cancelExcept,
            getPendingCount: () => workByEpoch.size,
            getControllerCount: () => scopesByEpoch.size
        });
    }

    initializationRegistry = createInitializationRegistry(identityChangedError);
    let initializedEpoch = -1;
    let cacheUnloadInstalled = false;

    function identityChangedError() {
        const error = new Error('Identity changed during Jellyfin Canopy initialization');
        error.name = 'IdentityChangedError';
        return error;
    }

    function requireCurrentIdentity(context) {
        if (!identity.isCurrent(context)) throw identityChangedError();
    }

    function defaultUserFile(name) {
        if (name === 'shortcuts') return { Shortcuts: [] };
        if (name === 'bookmark') return { bookmarks: {} };
        if (name === 'hiddenContent') return { items: {}, settings: {} };
        return {};
    }

    /** Jellyfin host/ajax error shapes seen across web-client versions. */
    function isNotFoundError(error) {
        if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
        const candidates = [
            error.status,
            error.statusCode,
            error.response?.status,
            error.xhr?.status,
            error.target?.status
        ];
        return candidates.some((value) => Number(value) === 404);
    }

    /** Fetch all five owner files once and build a local, unpublished snapshot. */
    async function fetchUserConfig(client, context, scope) {
        const files = [
            ['settings', 'settings.json'],
            ['shortcuts', 'shortcuts.json'],
            ['bookmark', 'bookmark.json'],
            ['elsewhere', 'elsewhere.json'],
            ['hiddenContent', 'hidden-content.json']
        ];
        const results = await Promise.all(files.map(async ([name, file]) => {
            try {
                const request = client.ajax({
                    type: 'GET',
                    url: client.getUrl(`/JellyfinCanopy/user-settings/${encodeURIComponent(context.userId)}/${file}?_=${Date.now()}`),
                    dataType: 'json',
                    signal: scope.signal
                });
                const value = await scope.race(request);
                return { name, value, missing: false };
            } catch (reason) {
                // The bookmark controller represents a genuinely missing file
                // as a valid revision-0 state. A 404 therefore means the
                // versioned endpoint itself was unavailable; never fabricate a
                // mutation-capable empty bookmark snapshot from it.
                if (isNotFoundError(reason) && name !== 'bookmark') return { name, value: null, missing: true };
                // Authentication, transport, server, cancellation, and malformed
                // success failures must abort this initialization. Publishing a
                // fabricated empty owner snapshot would erase real preferences.
                throw reason;
            }
        }));
        requireCurrentIdentity(context);

        const snapshot = emptyUserConfig();
        for (const result of results) {
            const { name, value, missing } = result;
            if (missing) {
                snapshot[name] = defaultUserFile(name);
            } else if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new Error(`Invalid ${name} user-settings response`);
            } else if (name === 'bookmark') {
                const converted = transformUserFileCase('bookmark.json', value, 'load');
                if (!Number.isSafeInteger(converted?.revision) || converted.revision < 0
                    || !converted.bookmarks || typeof converted.bookmarks !== 'object'
                    || Array.isArray(converted.bookmarks)) {
                    throw new Error('Invalid versioned bookmark user-settings response');
                }
                snapshot[name] = converted;
            } else if (name === 'settings' || name === 'hiddenContent') {
                const fileName = name === 'settings' ? 'settings.json' : 'hidden-content.json';
                snapshot[name] = transformUserFileCase(fileName, value, 'load');
            } else {
                snapshot[name] = value;
            }
        }
        return snapshot;
    }

    function publishIdentitySnapshot(context, snapshot) {
        requireCurrentIdentity(context);
        const userConfig = identity.own(snapshot.userConfig, context);
        for (const value of Object.values(userConfig)) identity.own(value, context);

        JC.pluginConfig = identity.own(snapshot.pluginConfig, context);
        JC.pluginVersion = snapshot.version || 'unknown';
        JC.translations = identity.own(snapshot.translations || {}, context);
        JC.currentUser = snapshot.currentUser ? identity.own(snapshot.currentUser, context) : null;
        JC.userConfig = userConfig;
        JC.t = window.JellyfinCanopy.t;
    }

    function installCacheUnloadOnce() {
        if (cacheUnloadInstalled) return;
        cacheUnloadInstalled = true;
        window.addEventListener('beforeunload', () => {
            if (identity.capture()) JC._cacheManager?.forceSave?.();
        });
    }

    function recordFeatureFailure(context, name, error) {
        // A late rejection from an old generation belongs to teardown, not the
        // current boot's diagnostics. Identity cancellation is expected too.
        if (error?.name === 'IdentityChangedError' || error?.name === 'AbortError'
            || !identity.isCurrent(context)) return;
        bootDiagnostics.record({
            feature: name,
            phase: 'feature-initialization',
            operation: 'initialize',
            state: 'FeatureFailure',
            storage: 'none',
            key: 'none'
        });
        console.error(`🪼 Jellyfin Canopy: feature "${name}" initialized in degraded mode`, error);
    }

    /** Contain one feature owner without downgrading identity/auth/config failures. */
    function activateFeature(context, name, enabled, initializer) {
        if (!enabled || typeof initializer !== 'function') return;
        requireCurrentIdentity(context);
        try {
            // Preserve the historical root-namespace receiver for feature
            // methods that consult `this`; nested owners use explicit wrappers.
            const produced = initializer.call(JC);
            if (produced && typeof produced.then === 'function') {
                Promise.resolve(produced).catch((error) => {
                    recordFeatureFailure(context, name, error);
                });
            }
        } catch (error) {
            if (error?.name === 'IdentityChangedError' || !identity.isCurrent(context)) throw error;
            recordFeatureFailure(context, name, error);
        }
        requireCurrentIdentity(context);
    }

    /** Stage-6 activation. Old-epoch teardown always ran before these gates. */
    function activateFeatures(context) {
        activateFeature(context, 'canopy', typeof JC.initializeCanopyScript === 'function', JC.initializeCanopyScript);
    }

    async function runInitialization(context, client, scope) {
        try {
            requireCurrentIdentity(context);

            // Start every independent owner read in one wave. Nothing is
            // published until all values belong to this still-current epoch.
            const userConfigPromise = fetchUserConfig(client, context, scope);
            // A failed owner read is not equivalent to an absent owner. Let the
            // initialization fail so the monitor retries without publishing a
            // partial B snapshot.
            const currentUserPromise = scope.race(client.getCurrentUser());
            const pluginDataPromise = loadPluginData(client, scope);
            const privateConfigPromise = loadPrivateConfig(client, scope);

            await scope.race(loadTranslationsModule(client));
            requireCurrentIdentity(context);
            const translationsPromise = scope.race(loadTranslations());

            const [userConfig, currentUser, pluginData, privateConfig, translations] = await Promise.all([
                userConfigPromise,
                currentUserPromise,
                pluginDataPromise,
                privateConfigPromise,
                translationsPromise
            ]);
            requireCurrentIdentity(context);

            const [publicConfig, version] = pluginData;
            const pluginConfig = publicConfig && typeof publicConfig === 'object'
                ? { ...publicConfig }
                : {};
            if (privateConfig && typeof privateConfig === 'object') Object.assign(pluginConfig, privateConfig);

            let nextTranslations = translations || {};
            const serverTranslationClearTs = pluginConfig.ClearTranslationCacheTimestamp || 0;
            const translationClear = JC.storage.local.readNumber(
                'translations',
                'JC_translation_clear_ts',
                (value) => value >= 0,
                'clear-timestamp'
            );
            const localTranslationClearTs = translationClear.state === 'Valid' ? translationClear.value : 0;
            if (serverTranslationClearTs > localTranslationClearTs) {
                const storedKeys = JC.storage.local.keys('translations', 'translation-cache-prefix');
                for (const key of storedKeys.value || []) {
                    if (key && (key.startsWith('JC_translation_') || key.startsWith('JC_translation_ts_'))) {
                        JC.storage.local.remove('translations', key, 'translation-cache-entry');
                    }
                }
                JC.storage.local.write('translations', 'JC_translation_clear_ts', serverTranslationClearTs.toString(), 'clear-timestamp');
                nextTranslations = await scope.race(loadTranslations()) || {};
                requireCurrentIdentity(context);
            }

            publishIdentitySnapshot(context, {
                pluginConfig,
                version,
                translations: nextTranslations,
                currentUser,
                userConfig
            });

            if (pluginConfig.TagCacheServerMode) {
                const tagCacheRequest = client.ajax({
                    type: 'GET',
                    url: client.getUrl(`/JellyfinCanopy/tag-cache/${encodeURIComponent(context.userId)}`),
                    dataType: 'json',
                    signal: scope.signal
                });
                JC._tagCachePrefetch = scope.race(tagCacheRequest)
                    .then((value) => identity.isCurrent(context) ? value : null)
                    .catch(() => null);
            }

            try { injectMetadataIcons(!!pluginConfig.MetadataIconsEnabled); }
            catch (error) { console.warn('🪼 Jellyfin Canopy: Failed to inject Metadata icons CSS', error); }
            preloadIconFonts();
            JC.initializeSplashScreen?.();

            // The boot graph executes once per document. Later identities reuse
            // its stable runtime while publishing a fresh config generation.
            const clientRuntime = await scope.race(loadClientRuntime(client, scope));
            requireCurrentIdentity(context);

            if (typeof JC.loadSettings !== 'function' || typeof JC.initializeShortcuts !== 'function') {
                throw new Error('config functions not defined after client boot');
            }
            JC.currentSettings = identity.own(JC.loadSettings(), context);
            JC.initializeShortcuts();

            const capturedRawUserId = String(identity.getRawUserId?.(context) || context.userId).trim();
            const normalizedRawUserId = capturedRawUserId.replace(/-/g, '').toLowerCase();
            const compatibilityUserId = normalizedRawUserId === context.userId
                ? capturedRawUserId
                : context.userId;
            const languageKey = `${compatibilityUserId}-language`;
            const scopedLanguageKey = `jc-display-language:${context.serverId}:${context.userId}`;
            const desiredLanguage = String(JC.currentSettings?.displayLanguage || '').trim();
            const parts = desiredLanguage.split('-');
            const normalizedLanguage = !desiredLanguage
                ? ''
                : (parts.length === 1
                    ? parts[0].toLowerCase()
                    : (parts.length === 2 ? `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}` : desiredLanguage));
            JC.storage.local.write('display-language', scopedLanguageKey, normalizedLanguage, 'scoped-language');
            JC.storage.local.write('display-language', languageKey, normalizedLanguage, 'compatibility-language');

            if (typeof JC.themer?.init === 'function') JC.themer.init();
            installCacheUnloadOnce();

            // Boot participants that self-wire (live socket, identity caches)
            // activate once per epoch before the legacy Stage-6 feature calls.
            await identity.activate(context);
            requireCurrentIdentity(context);
            if (!clientRuntime || typeof clientRuntime.configurationPublished !== 'function') {
                throw new Error('client runtime handle is invalid after boot');
            }
            await clientRuntime.configurationPublished(context);
            requireCurrentIdentity(context);
            activateFeatures(context);
            requireCurrentIdentity(context);

            initializedEpoch = context.epoch;
            JC.initialized = true;
            document.dispatchEvent(new CustomEvent('jc:identityactivated', { detail: context }));
            JC.hideSplashScreen?.();
            const diagnostics = bootDiagnostics.snapshot();
            if (diagnostics.degraded) {
                console.warn('🪼 Jellyfin Canopy: initialization completed with degraded feature/storage state', diagnostics);
            }
            console.log(`🪼 Jellyfin Canopy: identity epoch ${context.epoch} initialization completed.`);
        } catch (error) {
            if (error?.name === 'IdentityChangedError') return;
            if (identity.isCurrent(context)) {
                console.error('🪼 Jellyfin Canopy: CRITICAL INITIALIZATION FAILURE:', error);
                JC.hideSplashScreen?.();
            }
        }
    }

    function startInitialization(context, client) {
        if (!context || !identity.isCurrent(context)) return Promise.resolve();
        if (initializedEpoch === context.epoch && JC.initialized) return Promise.resolve();
        return initializationRegistry.start(
            context.epoch,
            (scope) => runInitialization(context, client, scope)
        ).catch((error) => {
            // Cancellation is the expected completion path for an old epoch.
            if (error?.name === 'IdentityChangedError' || error?.name === 'AbortError') return;
            if (identity.isCurrent(context)) {
                console.error('🪼 Jellyfin Canopy: initialization registry failure', error);
            }
        });
    }

    /** Initial readiness path; subsequent sign-ins enter through the host hook. */
    async function initialize() {
        ensureIdentityBridge();
        if (hasServerIdMismatch()) {
            mismatchRetryCount++;
            if (mismatchRetryCount >= MAX_MISMATCH_RETRIES) {
                console.warn('🪼 Jellyfin Canopy: Server ID mismatch detected - waiting for a valid host identity');
                JC.hideSplashScreen?.();
                return;
            }
            setTimeout(initialize, 300);
            return;
        }

        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId?.()) {
            identity.transition('', null, 'initialize-signed-out');
            if (readyRetryCount >= MAX_READY_RETRIES) {
                console.warn('🪼 Jellyfin Canopy: ApiClient not ready after max retries - identity hook remains active');
                JC.hideSplashScreen?.();
                return;
            }
            setTimeout(initialize, nextReadyPollDelay());
            return;
        }

        mismatchRetryCount = 0;
        readyRetryCount = 0;
        const client = ApiClient;
        const context = identity.transition(
            getClientServerId(client),
            client.getCurrentUserId(),
            'initialization'
        );
        await startInitialization(context, client);
    }

    // Load splash screen immediately (before main initialization)
    loadSplashScreenEarly();

    // Load login image immediately (before main initialization)
    loadLoginImageEarly();

    // Then start main initialization
    initialize();

})();
