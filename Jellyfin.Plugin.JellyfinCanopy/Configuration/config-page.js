        (() => {
            const pluginId = '9ffa12bc-f4b5-406c-ab1d-d575acbeea7b';

            /* jc-config-page-lifecycle:start */
            // Install-once page lifecycle (BI-CLIENT-106 / #167). The dashboard
            // re-fetches configPage.html and re-executes this whole script on
            // EVERY visit, and Jellyfin's legacy view cache can keep several
            // config views in the DOM at once — a cached one restored on Back is
            // NOT re-scripted. So the window/document/MediaQueryList listeners,
            // MutationObservers and delegated click handlers installed below must
            // never MULTIPLY across visits: before the fix N visits left N handler
            // sets and one click on a category Down arrow moved the row N places.
            //
            // We deliberately NEVER tear anything down. A teardown-on-revisit was
            // the previous approach and is unfixable here: tearing down a still-
            // cached view's handlers strands that view when Jellyfin later restores
            // it from cache without re-running this script (it would come back with
            // inert tabs / save controls). Instead:
            //   * per-VIEW element listeners (buttons/inputs inside the resolved
            //     page) are attached with addListener — every visit renders a fresh
            //     view, so re-wiring its own fresh elements is correct, not a leak,
            //     and a restored cached view keeps the listeners we never removed;
            //   * every GLOBAL registration (window/document/matchMedia listener,
            //     persistent-ancestor listener, MutationObserver, injected timer)
            //     goes through a window-scoped SINGLE-SLOT install (own / ownNode /
            //     ownObserver / ownTimer) that removes the previous visit's copy
            //     before installing this visit's, so at most ONE is ever live and
            //     it always holds the freshest closure.
            //
            // This is the install-once / single-ownership shape from the enhanced
            // client's lifecycle helpers, re-expressed inline: this file is a
            // separately served classic script outside the TypeScript bundle and
            // config-page correctness must not depend on bundle load timing.
            function jcCreateConfigPageLifecycle(pageEl, win) {
                function registry() {
                    if (!win) return null;
                    return win.__jcConfigGlobalInstalls ||
                        (win.__jcConfigGlobalInstalls = { listeners: {}, observers: {}, timers: {}, nodes: null });
                }
                var reg = registry();
                var owner = {
                    // Constant sentinel. The per-element dataset.jcWired guards use
                    // it to wire an element AT MOST ONCE: a fresh view's elements
                    // never carry it (so they wire once), and a re-run against the
                    // very same element is skipped. No per-visit token is needed
                    // because we never tear down and rebind.
                    id: 'jc-config-wired',
                    page: pageEl,
                    // Retained as an always-true flag so the existing defensive
                    // `if (!lifecycle.active) return` continuation guards remain
                    // valid no-ops; nothing ever retires an owner now.
                    active: true,
                    tracked: [],
                    track: function (resource) { owner.tracked.push(resource); return resource; },
                    untrack: function (resource) {
                        owner.tracked = owner.tracked.filter(function (r) { return r !== resource; });
                    },
                    // Per-view element listener: just attach. The element is GC'd
                    // with its view; a cached view restored on Back keeps it.
                    addListener: function (el, type, fn, opts) {
                        if (!el) return;
                        el.addEventListener(type, fn, opts);
                    },
                    // Single global-listener slot keyed by `key`: remove the prior
                    // visit's listener for this key (if any), then install this
                    // visit's. Net: exactly one live listener per key, freshest
                    // closure. Used for window / document / MediaQueryList targets.
                    own: function (key, target, type, fn, opts) {
                        if (!target) return;
                        if (reg) {
                            var prev = reg.listeners[key];
                            if (prev) { try { prev.target.removeEventListener(prev.type, prev.fn, prev.opts); } catch (e) { /* target gone */ } }
                            reg.listeners[key] = { target: target, type: type, fn: fn, opts: opts };
                        }
                        target.addEventListener(type, fn, opts);
                    },
                    // Single listener slot per (persistent node, type). The sticky
                    // header listens on PERSISTENT dashboard-chrome ancestors that
                    // survive across visits, so a raw attach would stack across
                    // visits. A WeakMap keyed by the node replaces the prior copy.
                    ownNode: function (node, type, fn, opts) {
                        if (!node) return;
                        if (reg) {
                            if (!reg.nodes) reg.nodes = new WeakMap();
                            var byType = reg.nodes.get(node);
                            if (!byType) { byType = {}; reg.nodes.set(node, byType); }
                            var prev = byType[type];
                            if (prev) { try { node.removeEventListener(type, prev.fn, prev.opts); } catch (e) { /* node gone */ } }
                            byType[type] = { fn: fn, opts: opts };
                        }
                        node.addEventListener(type, fn, opts);
                    },
                    // Single MutationObserver slot keyed by `key`: disconnect the
                    // prior visit's observer, connect this visit's.
                    ownObserver: function (key, node, options, cb) {
                        if (!node) return null;
                        var obs = new MutationObserver(cb);
                        if (reg) {
                            var prev = reg.observers[key];
                            if (prev) { try { prev.disconnect(); } catch (e) { /* already gone */ } }
                            reg.observers[key] = obs;
                        }
                        obs.observe(node, options);
                        return obs;
                    },
                    // Single timer slot keyed by `key`: clear the prior visit's
                    // pending timer before storing this visit's handle.
                    ownTimer: function (key, id) {
                        if (reg) {
                            var prev = reg.timers[key];
                            if (prev !== undefined) { try { clearTimeout(prev); } catch (e) { /* already fired */ } }
                            reg.timers[key] = id;
                        }
                        return id;
                    }
                };
                return owner;
            }

            function jcAcquireConfigPageLifecycle(win, pageEl) {
                var current = win.__jcConfigPageLifecycle;
                // Duplicate execution against the SAME live view (e.g. the loader
                // ran twice against one cached view): keep the existing wiring,
                // install nothing.
                if (current && current.page === pageEl && pageEl && pageEl.isConnected !== false) {
                    return null;
                }
                // A fresh view (or the first run): create a new owner. We do NOT
                // tear down `current` — its view may be cached and later restored
                // by Jellyfin without re-running this script, and its GLOBAL
                // registrations are already single-slotted, so nothing multiplies.
                var owner = jcCreateConfigPageLifecycle(pageEl, win);
                win.__jcConfigPageLifecycle = owner;
                return owner;
            }

            // Resolve THIS script's own config-page view (BI-CLIENT-106 / #167).
            // Jellyfin 12 keeps several routed views cached in the DOM at once,
            // so more than one element can carry id="JellyfinCanopyPage" (a
            // hidden stale copy plus the fresh visible one). A bare
            // document.querySelector('#JellyfinCanopyPage') returns the FIRST in
            // document order — frequently the earlier hidden copy — which would
            // equal the previous visit's owner.page and make the sentinel treat
            // the fresh page as a duplicate load and abort ALL wiring, leaving
            // the visible page dead. This IIFE is served as an external script
            // the bootstrap appended INTO its own view, so climb from the
            // executing script element to the view that owns it; fall back to a
            // query when the script anchor is unavailable (e.g. tests, or a
            // detached temporary <script>). The fallback prefers the LAST match,
            // not the first: JF12 keeps stale cached views EARLIER in document
            // order and appends the freshly-injected visible view LAST, so
            // querySelector's first match is frequently the stale hidden copy —
            // exactly the trap this resolver exists to avoid (#167 findings 1/4).
            function jcResolveOwnConfigPage(doc, scriptEl, selector) {
                try {
                    if (scriptEl && typeof scriptEl.closest === 'function') {
                        var owned = scriptEl.closest(selector);
                        if (owned) return owned;
                    }
                } catch (e) { /* detached/foreign node — fall through to query */ }
                var matches = doc.querySelectorAll(selector);
                return matches.length ? matches[matches.length - 1] : null;
            }
            /* jc-config-page-lifecycle:end */

            const page = jcResolveOwnConfigPage(document, document.currentScript, '#JellyfinCanopyPage');
            // Scope the form to the resolved view so a stale cached view's form
            // is never wired in place of the live one.
            const form = page ? page.querySelector('#JellyfinCanopyForm') : document.querySelector('#JellyfinCanopyForm');

            // Page-scoped element lookups (BI-CLIENT-106 / #167). Jellyfin 12 can
            // keep a stale HIDDEN #JellyfinCanopyPage cached in the DOM alongside
            // this freshly-injected VISIBLE one, so bare
            // document.getElementById/querySelector — which return the FIRST match
            // in document order — resolve controls inside the stale copy. That
            // silently loads/saves the wrong form (e.g. a rotated Seerr API key
            // read back from the hidden view) and wires listeners onto invisible
            // controls. Route every IN-PAGE lookup through the resolved `page` so
            // load/save/wiring always target THIS view. `page` is the config
            // page's own root (id="JellyfinCanopyPage" wraps the whole form), so
            // every config id/class is a descendant. The few genuinely GLOBAL
            // lookups (theme host containers, foreign-plugin <script> probes,
            // body-level preview overlays/toasts) keep using `document` directly.
            // A lone `#id` selector is descendant-scoped and correct in real
            // browsers, but engines that resolve `#id` through a document-wide id
            // map (and would therefore return a match OUTSIDE `page`) exist; the
            // equivalent [id="…"] is always matched within the element subtree,
            // so a stale duplicate view earlier in the document can never win.
            function jcScopeSelector(sel) { return typeof sel === 'string' ? sel.replace(/^#([A-Za-z][\w-]*)$/, '[id="$1"]') : sel; }
            function jcById(id) { return page ? page.querySelector('[id="' + id + '"]') : document.getElementById(id); }
            function jcSel(sel) { return page ? page.querySelector(jcScopeSelector(sel)) : document.querySelector(sel); }
            function jcSelAll(sel) { return page ? page.querySelectorAll(jcScopeSelector(sel)) : document.querySelectorAll(sel); }

            var jcPageLifecycle = jcAcquireConfigPageLifecycle(window, page);
            if (!jcPageLifecycle) return;

            // Theme detector: Jellyfin's themes hard-swap theme.css (no CSS
            // variable contract). Jellyfin 12 does expose the selected theme
            // through <html data-theme>, so trust its explicit Light identity
            // first. Theme CSS can leave <html> transparent while painting the
            // page/body light; color sampling alone then misclassifies the real
            // Light theme as dark. Unknown/custom themes still fall back to the
            // first opaque host background we can sample. Threshold 450 bins
            // the shipped dark/light palettes correctly.
            // We also re-run on `load` in case the theme sheet hadn't applied
            // by the time our initial check ran, and once more after ~600 ms
            // to catch late Jellyfin theme swaps during dashboard navigation.
            function _jeDetectTheme() {
                if (!page) return;
                // Wrap the read in try/catch — during SPA detach getComputedStyle
                // can throw InvalidAccessError. If anything goes wrong we fall
                // back to dark (matches the plugin's previous default) so the
                // rest of the IIFE's listener wiring isn't aborted by a throw
                // from this purely cosmetic detector.
                try {
                    var declaredTheme = (document.documentElement.getAttribute('data-theme') || '').toLowerCase();
                    if (declaredTheme === 'light') {
                        page.classList.add('jc-light-theme');
                        page.classList.remove('jc-dark-theme');
                        return;
                    }

                    var knownDarkThemes = ['dark', 'appletv', 'blueradiance', 'purplehaze', 'wmc'];
                    if (knownDarkThemes.indexOf(declaredTheme) !== -1) {
                        page.classList.remove('jc-light-theme');
                        page.classList.add('jc-dark-theme');
                        return;
                    }

                    var candidates = [
                        document.documentElement,
                        document.body,
                        document.querySelector('.backgroundContainer'),
                        document.querySelector('.mainAnimatedPage')
                    ];
                    var bg = '';
                    var m = null;
                    for (var i = 0; i < candidates.length; i++) {
                        if (!candidates[i]) continue;
                        bg = getComputedStyle(candidates[i]).backgroundColor;
                        m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
                        if (m && (m[4] === undefined || +m[4] >= 0.5)) break;
                        m = null;
                    }
                    if (!m) {
                        // Named colors (`black`), `transparent`, or `initial`: can't
                        // tell light vs. dark reliably. Log once so a future broken
                        // theme is diagnosable rather than silently dark.
                        console.warn('[JC] theme detector: document background is unparseable (' + bg + '); defaulting to dark');
                        page.classList.remove('jc-light-theme');
                        page.classList.add('jc-dark-theme');
                        return;
                    }
                    var sum = (+m[1]) + (+m[2]) + (+m[3]);
                    var isLight = sum > 450;
                    page.classList.toggle('jc-light-theme', isLight);
                    page.classList.toggle('jc-dark-theme',  !isLight);
                } catch (e) {
                    console.warn('[JC] theme detection failed, defaulting to dark:', e);
                    page.classList.remove('jc-light-theme');
                    page.classList.add('jc-dark-theme');
                }
            }
            _jeDetectTheme();
            // Single-slot global installs (#167): a fresh visit replaces the prior
            // visit's window 'load' handler and pending re-check timer instead of
            // stacking another copy.
            jcPageLifecycle.own('themeLoad', window, 'load', _jeDetectTheme);
            jcPageLifecycle.ownTimer('themeTimer', setTimeout(_jeDetectTheme, 600));
            const resetAllUserSettingsBtn = jcSel('#resetAllUserSettingsBtn');
            const clearTagsCacheBtn = jcSel('#clearTagsCacheBtn');

            const shortcutListContainer = jcById('shortcut-list-container');
            const addShortcutSelect = jcById('add-shortcut-select');
            const addShortcutKeyInput = jcById('add-shortcut-key');
            const addShortcutBtn = jcById('add-shortcut-btn');
            const shortcutErrorComment = jcById('shortcut-error-comment');

            const testSeerrBtn = jcById('testSeerrBtn');
            const seerrStatusIndicator = jcById('seerrStatusIndicator');

            const tmdbStatusIndicator = jcById('tmdbStatusIndicator');

            let shortcutOverrides = [];

            const tabs = jcSelAll('.jellyfin-tab-button');
            const tabContents = jcSelAll('.jellyfin-tab-content');

            // Drag-to-scroll on the tab bar so mouse users can pan the tab strip
            // the same way touch users do on mobile (the overflow-x auto strip
            // has no visible scrollbar). Threshold at 5 px before we consider it
            // a drag, so a normal click through to a tab still registers.
            (function wireTabBarDrag() {
                const bar = jcSel('.jc-tab-bar');
                if (!bar) return;
                let isDown = false;
                let startX = 0;
                let startScroll = 0;
                let dragged = false;

                jcPageLifecycle.addListener(bar, 'mousedown', (e) => {
                    if (e.button !== 0) return;
                    isDown = true;
                    dragged = false;
                    startX = e.pageX;
                    startScroll = bar.scrollLeft;
                });
                jcPageLifecycle.addListener(bar, 'mousemove', (e) => {
                    if (!isDown) return;
                    const dx = e.pageX - startX;
                    if (!dragged && Math.abs(dx) > 5) {
                        dragged = true;
                        bar.classList.add('jc-dragging');
                    }
                    if (dragged) {
                        bar.scrollLeft = startScroll - dx;
                        e.preventDefault();
                    }
                });
                const end = () => {
                    if (!isDown) return;
                    isDown = false;
                    // Keep `dragged` set briefly so the synthesized click that
                    // follows a drag-end can be suppressed by the capture-phase
                    // click listener below. Cleared on next mousedown.
                    bar.classList.remove('jc-dragging');
                };
                jcPageLifecycle.addListener(bar, 'mouseup', end);
                jcPageLifecycle.addListener(bar, 'mouseleave', end);

                // Capture-phase click listener cancels the click that mouseup
                // would otherwise fire on the tab button at the cursor's final
                // position — prevents accidental tab activation at drag-end.
                jcPageLifecycle.addListener(bar, 'click', (e) => {
                    if (dragged) {
                        e.preventDefault();
                        e.stopPropagation();
                        dragged = false;
                    }
                }, true);
            })();

            // Mobile section drawer: the sidebar slides in off-canvas below
            // 900px. The toggle/scrim only exist in the new shell layout, so
            // everything here no-ops gracefully if the markup changes.
            (function wireSectionDrawer() {
                const shell = jcSel('.jc-shell');
                const toggle = jcById('jcNavToggle');
                const scrim = jcById('jcNavScrim');
                const sidebar = shell?.querySelector('.jc-sidebar');
                const main = shell?.querySelector('.jc-main');
                if (!shell || !toggle || !scrim || !sidebar || !main) return;
                const drawerMedia = window.matchMedia('(max-width: 900px)');
                const setOpen = (open) => {
                    const wasOpen = shell.classList.contains('jc-nav-open');
                    shell.classList.toggle('jc-nav-open', open);
                    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                    // Off-canvas focus ownership (drawer mode only): while the
                    // drawer overlays the page, the covered main column must not
                    // hold focus or be reachable; while it is closed off-canvas,
                    // the sidebar must not be tabbable behind the viewport edge.
                    if (drawerMedia.matches) {
                        main.inert = open;
                        sidebar.inert = !open;
                        if (open) {
                            sidebar.querySelector('#settingsSearchInput, .jc-group-btn')?.focus();
                        } else if (wasOpen) {
                            toggle.focus();
                        }
                    }
                };
                const syncLayoutMode = () => {
                    if (drawerMedia.matches) {
                        sidebar.inert = !shell.classList.contains('jc-nav-open');
                        main.inert = shell.classList.contains('jc-nav-open');
                    } else {
                        // Desktop rail: both columns are visible and interactive.
                        sidebar.inert = false;
                        main.inert = false;
                        shell.classList.remove('jc-nav-open');
                        toggle.setAttribute('aria-expanded', 'false');
                    }
                };
                // The MediaQueryList and the document keydown outlive the page:
                // single-slotted (#167) so a fresh visit replaces the prior
                // visit's handler instead of stacking one that fires against
                // stale DOM.
                jcPageLifecycle.own('drawerMedia', drawerMedia, 'change', syncLayoutMode);
                syncLayoutMode();
                jcPageLifecycle.addListener(toggle, 'click', () => setOpen(!shell.classList.contains('jc-nav-open')));
                jcPageLifecycle.addListener(scrim, 'click', () => setOpen(false));
                // Selecting a section (or focusing search results) dismisses the drawer.
                tabs.forEach((t) => jcPageLifecycle.addListener(t, 'click', () => setOpen(false)));
                jcPageLifecycle.own('drawerEsc', document, 'keydown', (e) => {
                    if (e.key === 'Escape' && shell.classList.contains('jc-nav-open')) setOpen(false);
                });
            })();

            // Grouped shell (handoff IA): the rail chooses a product area; its
            // member sections render as a segmented control in the page header.
            let jcSyncGroupForTab = null;
            (function wireGroupShell() {
                const GROUPS = {
                    'command-center': { title: 'Command Center', purpose: 'Service health, feature status and quick actions at a glance.' },
                    'experience':     { title: 'Experience', purpose: 'How Jellyfin looks, plays and handles for every user.' },
                    'pages':          { title: 'Pages', purpose: 'The Calendar, Requests, Bookmarks and Hidden Content pages.' },
                    'discovery':      { title: 'Discovery & Community', purpose: 'Trending, reviews, release dates and streaming availability.' },
                    'connections':    { title: 'Connections & Automation', purpose: 'Seerr, Sonarr, Radarr, Bazarr and their sync rules.' },
                    'governance':     { title: 'Governance', purpose: 'Spoiler policy, user defaults, permissions and maintenance.' },
                    'system':         { title: 'System', purpose: 'Assets, diagnostics, developer settings and documentation.' },
                };
                const railBtns = Array.from(jcSelAll('.jc-group-btn'));
                const strip = jcById('jcSectionStrip');
                const store = jcSel('.jc-section-strip-store');
                const titleEl = jcById('jcPageTitle');
                const purposeEl = jcById('jcPagePurpose');
                if (!railBtns.length || !strip || !store) return;
                // Relocate the section buttons from the hidden store into the strip.
                Array.from(store.querySelectorAll('.jellyfin-tab-button')).forEach(b => strip.appendChild(b));
                store.remove();

                const setGroup = (groupId, activateFirst) => {
                    const meta = GROUPS[groupId];
                    if (!meta) return;
                    railBtns.forEach(b => b.classList.toggle('active', b.dataset.group === groupId));
                    let first = null;
                    let firstVisible = null;
                    let members = 0;
                    strip.querySelectorAll('.jellyfin-tab-button').forEach(b => {
                        const mine = b.dataset.group === groupId;
                        b.classList.toggle('jc-in-group', mine);
                        if (mine) {
                            members++;
                            if (!first) first = b;
                            // During search zero-match sections are display:none —
                            // a group click must land on the first MATCHING one.
                            if (!firstVisible && b.style.display !== 'none') firstVisible = b;
                        }
                    });
                    strip.classList.toggle('jc-strip-single', members < 2);
                    if (titleEl) titleEl.textContent = meta.title;
                    if (purposeEl) purposeEl.textContent = meta.purpose;
                    if (activateFirst) {
                        const target = firstVisible || first;
                        if (target) target.click();
                    }
                };
                railBtns.forEach(b => jcPageLifecycle.addListener(b, 'click', () => setGroup(b.dataset.group, true)));
                jcSyncGroupForTab = (tabId) => {
                    const btn = strip.querySelector('.jellyfin-tab-button[data-tab="' + tabId + '"]');
                    if (btn && btn.dataset.group) setGroup(btn.dataset.group, false);
                };
            })();

            // Dirty-state owner: every configuration mutation — native input
            // events AND programmatic ones (shortcut removal, instance removal,
            // category reorder) — funnels through jcMarkConfigDirty, which also
            // bumps a revision. saveConfig captures the revision at snapshot
            // time and clears the flag only when no further mutation landed
            // while the save was in flight.
            let jcDirtyRevision = 0;
            function jcMarkConfigDirty() {
                jcDirtyRevision++;
                jcSel('.jc-save-dock')?.classList.add('jc-dirty');
            }
            function jcDirtyRevisionNow() { return jcDirtyRevision; }
            function jcClearDirtyIfUnchanged(revision) {
                if (jcDirtyRevision === revision) {
                    jcSel('.jc-save-dock')?.classList.remove('jc-dirty');
                }
            }
            (function wireDirtyState() {
                if (!form) return;
                jcPageLifecycle.addListener(form, 'input', jcMarkConfigDirty, true);
                jcPageLifecycle.addListener(form, 'change', jcMarkConfigDirty, true);
            })();

            // Docs iframe URL — kept in JS rather than hardcoded in the
            // <iframe src> attribute so we can lazy-load on first Docs
            // activation (saves the GitHub Pages fetch for admins who
            // never open this tab).
            const DOCS_URL = 'https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/';

            // Per-tab scroll memory. When the admin switches tabs we save the
            // current scrollY under the outgoing tab's id, and when they come
            // back to a tab we restore whatever they were reading. Defaults to
            // scroll-to-top on first visit to a tab so the Overview / long
            // sections always start at the tab's own header.
            const _jeTabScroll = Object.create(null);
            let _jePrevTabId = null;
            function _jeGetScrollTop() {
                return window.scrollY
                    || document.documentElement.scrollTop
                    || document.body.scrollTop
                    || 0;
            }
            function _jeSetScrollTop(y) {
                try { window.scrollTo({ top: y, behavior: 'instant' }); }
                catch (e) {
                    // Old Safari missing behavior:'instant' or iframe contexts.
                    window.scrollTo(0, y);
                }
            }

            function activateTab(tabId) {
                if (_jePrevTabId && _jePrevTabId !== tabId) {
                    _jeTabScroll[_jePrevTabId] = _jeGetScrollTop();
                }
                tabs.forEach(t => {
                    t.classList.toggle('active', t.dataset.tab === tabId);
                });
                // Keep the group rail + header in step with the active section
                // regardless of which path activated it (click, restore, search).
                if (typeof jcSyncGroupForTab === 'function') jcSyncGroupForTab(tabId);
                tabContents.forEach(content => {
                    const isActive = content.id === tabId;
                    content.classList.toggle('active', isActive);
                });
                // Restore (or reset) the scroll position after the new tab's
                // content is in the DOM. rAF waits for the layout pass so the
                // saved scrollY actually addresses the right document height.
                // NOTE: load-bearing for the service-status card deep-link at
                // renderServiceStatusDashboard (scrollTo handler uses a
                // double-rAF to run after this restore). If this rAF goes
                // away or gains an extra frame, update that handler to match.
                const saved = _jeTabScroll[tabId];
                requestAnimationFrame(() => _jeSetScrollTop(saved || 0));
                _jePrevTabId = tabId;
                // Lazy-load the Docs iframe the first time the user opens
                // the Docs tab. Using `about:blank` as the initial src
                // prevents the GitHub Pages fetch for admins who never
                // click into it. We set the real src once and never
                // reset it, so subsequent tab switches re-reveal the
                // already-loaded page (keeps the admin's scroll position
                // and any in-page nav state).
                if (tabId === 'docs') {
                    try {
                        var f = jcById('docsFrame');
                        if (f && (!f.src || f.src === 'about:blank' || /about:blank/.test(f.src))) {
                            // Set up a load-timeout fallback before assigning src so
                            // a silently-blank iframe (DNS/CSP/X-Frame-Options/CDN
                            // outage) becomes a visible "couldn't load — open in
                            // new tab" message instead of an empty gray box.
                            var loaded = false;
                            f.addEventListener('load', function onLoad() {
                                loaded = true;
                                f.removeEventListener('load', onLoad);
                            });
                            setTimeout(function() {
                                if (loaded) return;
                                var parent = f.parentNode;
                                if (!parent) return;
                                var fb = document.createElement('div');
                                fb.className = 'jc-docs-fallback';
                                fb.style.cssText = 'padding: 24px; text-align: center; color: #ccc; font-size: 0.95em;';
                                var msg = document.createElement('div');
                                msg.textContent = "Couldn't load the embedded documentation. Open it in a new tab instead:";
                                msg.style.marginBottom = '12px';
                                var link = document.createElement('a');
                                link.href = DOCS_URL;
                                link.target = '_blank';
                                link.rel = 'noopener';
                                link.textContent = DOCS_URL;
                                link.style.color = 'var(--primary-accent-color, #00a4dc)';
                                fb.appendChild(msg);
                                fb.appendChild(link);
                                parent.replaceChild(fb, f);
                            }, 8000);
                            f.src = DOCS_URL;
                        }
                    } catch (e) {
                        console.warn('[JC] docs iframe lazy-load failed:', e);
                    }
                }
            }

            tabs.forEach(tab => {
                jcPageLifecycle.addListener(tab, 'click', () => {
                    const tabId = tab.dataset.tab;
                    if (isSearchMode) {
                        // Jump from search results into the section: leave search
                        // mode, open the section, and scroll to its first match.
                        const target = jcSel('#' + tabId + ' > fieldset:not(.jc-search-hidden)');
                        clearTimeout(searchDebounce);
                        searchInput.value = '';
                        exitSearchMode();
                        activateTab(tabId);
                        if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
                    } else {
                        activateTab(tabId);
                    }
                    // Store active tab in sessionStorage to persist across refreshes
                    try {
                        sessionStorage.setItem('jellyfinCanopyActiveTab', tabId);
                    } catch (e) {
                        // Ignore if sessionStorage is not available
                    }
                });
            });

            // Map legacy tab IDs (pre-redesign) to the closest new tab, so users with
            // a saved sessionStorage value from the old layout don't land on a missing tab.
            const LEGACY_TAB_MAP = {
                'enhanced': 'display',
                'seerr': 'seerr',
                'arr-links': 'arr'
            };

            // Restore tab from sessionStorage on page load
            try {
                let savedTab = sessionStorage.getItem('jellyfinCanopyActiveTab');
                if (savedTab && LEGACY_TAB_MAP[savedTab]) {
                    savedTab = LEGACY_TAB_MAP[savedTab];
                    sessionStorage.setItem('jellyfinCanopyActiveTab', savedTab);
                }
                if (savedTab && jcById(savedTab)) {
                    activateTab(savedTab);
                } else if (savedTab) {
                    // Saved tab doesn't match any current tab and isn't a legacy key —
                    // probably a tab that was later renamed or a stray value. Clear it
                    // so the user stops silently getting ignored on every page load.
                    console.info('[JC] discarding unknown saved tab: ' + savedTab);
                    sessionStorage.removeItem('jellyfinCanopyActiveTab');
                }
            } catch (e) {
                // sessionStorage unavailable (private mode / quota / security) — skip restore.
            }

            // === Setting-description visibility toggle ===
            // Some admins want the full explanatory text under every setting;
            // others (who know the plugin) want a compact page. Persist the
            // preference in localStorage, default visible, expose a header
            // button to flip state. Visibility is driven by CSS on the body
            // class — toggling is instant and costs nothing per render.
            const descToggleBtn = jcById('toggleDescriptionsBtn');
            const DESC_PREF_KEY = 'jc-settings-descriptions-visible';
            function applyDescriptionVisibility(show) {
                try { document.body.classList.toggle('jc-hide-descriptions', !show); } catch (e) {}
                if (descToggleBtn) {
                    descToggleBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
                    descToggleBtn.classList.toggle('jc-desc-toggle-off', !show);
                    const state = descToggleBtn.querySelector('.jc-desc-toggle-state');
                    if (state) state.textContent = show ? 'On' : 'Off';
                }
            }
            (function initDescriptionVisibility() {
                let show = true;
                try {
                    const stored = localStorage.getItem(DESC_PREF_KEY);
                    if (stored === 'false') show = false;
                } catch (e) { /* private mode / quota — default visible */ }
                applyDescriptionVisibility(show);
            })();
            if (descToggleBtn) {
                jcPageLifecycle.addListener(descToggleBtn, 'click', function() {
                    const currentlyShown = !document.body.classList.contains('jc-hide-descriptions');
                    const nextShown = !currentlyShown;
                    applyDescriptionVisibility(nextShown);
                    try { localStorage.setItem(DESC_PREF_KEY, nextShown ? 'true' : 'false'); }
                    catch (e) { /* private mode / quota — preference won't persist, UI still toggles */ }
                });
            }

            // === Settings Search ===
            const searchInput = jcById('settingsSearchInput');
            const searchClear = jcById('settingsSearchClear');
            const searchCount = jcById('settingsSearchCount');

            const tabButtonsContainer = tabs[0] ? tabs[0].parentElement : null;
            let isSearchMode = false;
            const savedDetailsStates = new Map();
            const SKIP_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE']);
            let currentMatchIdx = -1;
            let allMatches = [];

            let searchDebounce;
            jcPageLifecycle.addListener(searchInput, 'input', () => {
                clearTimeout(searchDebounce);
                searchDebounce = setTimeout(() => performSearch(searchInput.value), 150);
            });

            jcPageLifecycle.addListener(searchInput, 'keydown', (e) => {
                if (e.key === 'Escape') {
                    clearTimeout(searchDebounce);  // kill the debounce so a stale non-empty query can't re-enter search mode after we exit
                    searchInput.value = '';
                    performSearch('');
                    searchInput.blur();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (allMatches.length > 0) {
                        goToMatch(currentMatchIdx + (e.shiftKey ? -1 : 1));
                    }
                }
            });

            jcPageLifecycle.addListener(searchClear, 'click', () => {
                clearTimeout(searchDebounce);  // kill the debounce — see Escape handler
                searchInput.value = '';
                performSearch('');
                searchInput.focus();
            });



            /**
             * Collects searchable text from an element, including IDs, names, and data attributes.
             * @param {HTMLElement} element - The DOM element to extract text from
             * @returns {string} Lowercase concatenation of text content and attribute values
             */
            function getSearchableText(element) {
                var text = element.textContent.toLowerCase();
                element.querySelectorAll('[id], [name], [data-text], [data-icon]').forEach(function(el) {
                    if (el.id) text += ' ' + el.id.toLowerCase();
                    if (el.name) text += ' ' + el.name.toLowerCase();
                    if (el.dataset.text) text += ' ' + el.dataset.text.toLowerCase();
                    if (el.dataset.icon) text += ' ' + el.dataset.icon.toLowerCase();
                });
                return text;
            }

            /**
             * Removes all search highlight marks and restores original text nodes.
             */
            function clearHighlights() {
                form.querySelectorAll('.jc-search-match').forEach(mark => {
                    const parent = mark.parentNode;
                    parent.replaceChild(document.createTextNode(mark.textContent), mark);
                    parent.normalize();
                });
                // Unwrap the flex/grid protection spans added by
                // highlightTextIn. After the marks above were unwrapped,
                // the wrapper contains only text nodes — move them up to
                // the parent and drop the wrapper, so normalize() can
                // merge back into a single text node identical to before
                // the search.
                form.querySelectorAll('.jc-search-wrap').forEach(wrap => {
                    const parent = wrap.parentNode;
                    while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
                    parent.removeChild(wrap);
                    parent.normalize();
                });
                allMatches = [];
                currentMatchIdx = -1;
            }

            /**
             * Walks text nodes in an element and wraps query matches in highlight mark elements.
             * @param {HTMLElement} element - The container to search within
             * @param {string} query - Lowercase search term to highlight
             */
            function highlightTextIn(element, query) {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
                    acceptNode: function(node) {
                        if (SKIP_TAGS.has(node.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
                        if (node.parentElement.closest('.jc-search-match, .jc-search-tab-label, .dep-hint-text, .dep-required-icon, .jc-dep-banner, [class*="parent-hint-"]'))
                            return NodeFilter.FILTER_REJECT;
                        return NodeFilter.FILTER_ACCEPT;
                    }
                });
                var textNodes = [];
                while (walker.nextNode()) textNodes.push(walker.currentNode);

                // Per-parent display cache. getComputedStyle forces style
                // recomputation and — called naively once per text node during
                // a big search — caused the settings search to feel
                // extremely laggy on every keystroke. Most matches in a
                // fieldset share a parent (e.g., all text nodes inside one
                // .fieldDescription), so a WeakMap keyed on the parent
                // element cuts the call count to one per distinct parent.
                var parentDisplayCache = new WeakMap();
                function isFlexOrGridParent(parent) {
                    if (parentDisplayCache.has(parent)) return parentDisplayCache.get(parent);
                    var d = getComputedStyle(parent).display;
                    var flex = /(flex|grid)$/.test(d);
                    parentDisplayCache.set(parent, flex);
                    return flex;
                }

                textNodes.forEach(function(node) {
                    var text = node.textContent;
                    var lower = text.toLowerCase();
                    if (!lower.includes(query)) return;

                    var frag = document.createDocumentFragment();
                    var last = 0;
                    var idx;
                    while ((idx = lower.indexOf(query, last)) !== -1) {
                        if (idx > last) frag.appendChild(document.createTextNode(text.substring(last, idx)));
                        var mark = document.createElement('mark');
                        mark.className = 'jc-search-match';
                        mark.textContent = text.substring(idx, idx + query.length);
                        frag.appendChild(mark);
                        last = idx + query.length;
                    }
                    if (last < text.length) frag.appendChild(document.createTextNode(text.substring(last)));

                    // If the text node lives directly inside a flex/grid
                    // container, splitting it into mark + remainder nodes
                    // creates multiple flex/grid items. Those items then
                    // get repositioned by justify-content / align-items on
                    // the parent — e.g. a <summary> with space-between
                    // would spread the <mark> to the start and the
                    // trailing text to the end, splitting "Auto Season
                    // Requests" into "Auto Sea" . "son Requests" on a
                    // search for "auto sea". Wrap in an inline span so
                    // the parent still sees a single child.
                    //
                    // Order the checks cheap-first: childNodes.length is
                    // an O(1) lookup with no style side-effects, while
                    // isFlexOrGridParent triggers getComputedStyle on a
                    // cache miss. If the fragment has only one child
                    // (the whole text matched exactly), no splitting
                    // happens and we can skip the style check entirely.
                    var parent = node.parentNode;
                    if (frag.childNodes.length > 1 && isFlexOrGridParent(parent)) {
                        var wrapper = document.createElement('span');
                        wrapper.className = 'jc-search-wrap';
                        wrapper.appendChild(frag);
                        parent.replaceChild(wrapper, node);
                    } else {
                        parent.replaceChild(frag, node);
                    }
                });
            }

            /**
             * Navigates to a specific search match by index and scrolls it into view.
             * @param {number} index - Zero-based index of the match to navigate to
             */
            function goToMatch(index) {
                if (allMatches.length === 0) return;
                if (currentMatchIdx >= 0 && currentMatchIdx < allMatches.length) {
                    allMatches[currentMatchIdx].classList.remove('jc-search-match-active');
                }
                if (index >= allMatches.length) index = 0;
                if (index < 0) index = allMatches.length - 1;
                currentMatchIdx = index;
                allMatches[currentMatchIdx].classList.add('jc-search-match-active');
                allMatches[currentMatchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
                searchCount.textContent = (currentMatchIdx + 1) + ' of ' + allMatches.length;
            }

            /**
             * Enters search mode: saves detail open/closed states, hides tab buttons, and adds tab labels.
             */
            function enterSearchMode() {
                if (isSearchMode) return;
                isSearchMode = true;
                form.classList.add('jc-search-mode');
                form.querySelectorAll('details').forEach(d => {
                    savedDetailsStates.set(d, d.open);
                });
                tabContents.forEach(tc => {
                    const btn = jcSel('.jellyfin-tab-button[data-tab="' + tc.id + '"]');
                    // btn.textContent would include Material Icons font
                    // ligature names ("dashboard", "view_list", …) which
                    // render as glyphs but read as raw strings in
                    // textContent. That leaked into tab headers like
                    // "dashboardOverview" / "view_listPages". Clone the
                    // button, strip out the icon elements, then read.
                    let label = tc.id;
                    if (btn) {
                        const clone = btn.cloneNode(true);
                        clone.querySelectorAll('i.material-icons, img').forEach(el => el.remove());
                        label = clone.textContent.trim() || tc.id;
                    }
                    const labelEl = document.createElement('div');
                    labelEl.className = 'jc-search-tab-label';
                    labelEl.textContent = label;
                    tc.insertBefore(labelEl, tc.firstChild);
                });
            }

            /**
             * Exits search mode: restores tab visibility, detail states, and clears highlights.
             */
            function exitSearchMode() {
                isSearchMode = false;
                form.classList.remove('jc-search-mode');
                form.querySelectorAll('.jc-tab-name-match').forEach(tc => tc.classList.remove('jc-tab-name-match'));
                clearHighlights();
                form.querySelectorAll('.jc-search-tab-label').forEach(el => el.remove());
                jcSelAll('.jellyfin-tab-button').forEach(btn => { btn.style.display = ''; btn.classList.remove('jc-search-reveal'); });
                jcSelAll('.jc-group-btn').forEach(btn => { btn.style.display = ''; });
                jcSelAll('.jc-nav-count').forEach(el => el.remove());
                // Clear inline display from every tab content. performSearch sets
                // `style.display = 'block'|'none'` per tab; without this reset the
                // inline value wins over `.jellyfin-tab-content.active { display: grid }`,
                // collapsing matched tabs to single-column or hiding tabs that had no
                // match the next time the user clicks them. The .active class alone
                // owns visibility outside of search mode.
                form.querySelectorAll('.jellyfin-tab-content').forEach(tc => { tc.style.display = ''; });
                form.querySelectorAll('.jc-search-hidden').forEach(el => el.classList.remove('jc-search-hidden'));
                form.querySelectorAll('details').forEach(d => {
                    if (savedDetailsStates.has(d)) d.open = savedDetailsStates.get(d);
                });
                savedDetailsStates.clear();
                let savedTab = 'overview';
                try {
                    savedTab = sessionStorage.getItem('jellyfinCanopyActiveTab') || 'overview';
                    if (LEGACY_TAB_MAP[savedTab]) savedTab = LEGACY_TAB_MAP[savedTab];
                    if (!jcById(savedTab)) savedTab = 'overview';
                } catch (e) {
                    // Ignore if sessionStorage is not available
                }
                activateTab(savedTab);
                searchCount.style.display = 'none';
                searchClear.style.display = 'none';
            }

            /**
             * Filters visible sections by query, highlights matches, and updates the match counter.
             * @param {string} query - The search term entered by the user
             */
            function performSearch(query) {
                query = query.toLowerCase().trim();

                if (!query) {
                    if (isSearchMode) exitSearchMode();
                    return;
                }

                // 1-character queries like "a" or "e" match ~2000–4000 text
                // nodes across the entire settings page, each triggering a
                // DOM mutation. That costs 3–6 s and feels like the page
                // froze. A 2-char minimum keeps the search responsive and
                // still lets short feature names (e.g. "ui", "tv", "4k")
                // through. If the user is mid-edit (backspaced a longer
                // query down to 1 char), exit search mode and clear stale
                // highlights, then surface a hint via the counter so the
                // search UI doesn't look broken.
                if (query.length < 2) {
                    if (isSearchMode) exitSearchMode();
                    searchCount.textContent = 'Type 2+ characters to search';
                    searchCount.style.display = 'block';
                    searchClear.style.display = 'block';
                    return;
                }

                if (!isSearchMode) enterSearchMode();

                clearHighlights();
                let sectionCount = 0;
                const groupMatchCounts = new Map();

                tabContents.forEach(tabContent => {
                    let tabHasMatch = false;
                    const fieldsets = tabContent.querySelectorAll(':scope > fieldset');

                    fieldsets.forEach(fieldset => {
                        const fullText = getSearchableText(fieldset);

                        if (!fullText.includes(query)) {
                            fieldset.classList.add('jc-search-hidden');
                            return;
                        }

                        fieldset.classList.remove('jc-search-hidden');
                        tabHasMatch = true;
                        sectionCount++;

                        const detailsEls = fieldset.querySelectorAll('details');
                        detailsEls.forEach(detail => {
                            if (getSearchableText(detail).includes(query)) {
                                detail.classList.remove('jc-search-hidden');
                                detail.open = true;
                            } else {
                                detail.classList.add('jc-search-hidden');
                            }
                        });

                        highlightTextIn(fieldset, query);
                    });

                    tabContent.style.display = tabHasMatch ? 'block' : 'none';

                    // The shell nav stays usable during search: matching sections
                    // get a count badge (and stay clickable to jump), zero-match
                    // sections are revealed-off; the rail aggregates per group.
                    const navBtn = jcSel('.jellyfin-tab-button[data-tab="' + tabContent.id + '"]');
                    if (navBtn) {
                        navBtn.style.display = tabHasMatch ? '' : 'none';
                        navBtn.classList.toggle('jc-search-reveal', tabHasMatch);
                        let badge = navBtn.querySelector('.jc-nav-count');
                        if (tabHasMatch) {
                            const count = tabContent.querySelectorAll(':scope > fieldset:not(.jc-search-hidden)').length;
                            if (!badge) {
                                badge = document.createElement('span');
                                badge.className = 'jc-nav-count';
                                navBtn.querySelector('h3')?.appendChild(badge);
                            }
                            badge.textContent = String(count);
                            const group = navBtn.dataset.group;
                            if (group) groupMatchCounts.set(group, (groupMatchCounts.get(group) || 0) + count);
                        } else if (badge) {
                            badge.remove();
                        }
                    }

                    // Rank tab-contents whose tab button's label itself
                    // contains the query above tabs that matched only by
                    // buried content. Searching "elsewhere" now surfaces
                    // the Elsewhere tab first even though other tabs
                    // (Overview service-status, Seerr) reference it too.
                    // The CSS .jc-tab-name-match rule (flex order: -1)
                    // does the actual reordering in the form container.
                    const btn = jcSel('.jellyfin-tab-button[data-tab="' + tabContent.id + '"]');
                    let tabLabel = tabContent.id.toLowerCase();
                    if (btn) {
                        const clone = btn.cloneNode(true);
                        clone.querySelectorAll('i.material-icons, img').forEach(el => el.remove());
                        tabLabel = clone.textContent.trim().toLowerCase();
                    }
                    tabContent.classList.toggle('jc-tab-name-match', tabHasMatch && tabLabel.includes(query));
                });

                // Rail groups: badge aggregate counts, dim zero-match groups.
                jcSelAll('.jc-group-btn').forEach(gb => {
                    const count = groupMatchCounts.get(gb.dataset.group) || 0;
                    gb.style.display = count > 0 ? '' : 'none';
                    let badge = gb.querySelector('.jc-nav-count');
                    if (count > 0) {
                        if (!badge) {
                            badge = document.createElement('span');
                            badge.className = 'jc-nav-count';
                            gb.appendChild(badge);
                        }
                        badge.textContent = String(count);
                    } else if (badge) {
                        badge.remove();
                    }
                });

                allMatches = Array.from(form.querySelectorAll('.jc-search-match'));
                currentMatchIdx = -1;

                if (allMatches.length > 0) {
                    searchCount.textContent = '0 of ' + allMatches.length;
                } else {
                    searchCount.textContent = sectionCount > 0
                        ? sectionCount + ' section' + (sectionCount !== 1 ? 's' : '') + ' found'
                        : 'No results';
                }
                searchCount.style.display = 'block';
                searchClear.style.display = 'block';
            }

        const defaultShortcuts = [
            { Name: "OpenSearch", Key: "/", Label: "Open Search", Category: "Global" },
            { Name: "GoToHome", Key: "Shift+H", Label: "Go to Home", Category: "Global" },
            { Name: "GoToDashboard", Key: "D", Label: "Go to Dashboard", Category: "Global" },
            { Name: "QuickConnect", Key: "Q", Label: "Quick Connect", Category: "Global" },
            { Name: "PlayRandomItem", Key: "R", Label: "Play Random Item", Category: "Global" },
            { Name: "CycleAspectRatio", Key: "A", Label: "Cycle Aspect Ratio", Category: "Player" },
            { Name: "ShowPlaybackInfo", Key: "I", Label: "Show Playback Info", Category: "Player" },
            { Name: "SubtitleMenu", Key: "S", Label: "Subtitle Menu", Category: "Player" },
            { Name: "CycleSubtitleTracks", Key: "C", Label: "Cycle Subtitle Tracks", Category: "Player" },
            { Name: "CycleAudioTracks", Key: "V", Label: "Cycle Audio Tracks", Category: "Player" },
            { Name: "IncreasePlaybackSpeed", Key: "+", Label: "Increase Playback Speed", Category: "Player" },
            { Name: "DecreasePlaybackSpeed", Key: "-", Label: "Decrease Playback Speed", Category: "Player" },
            { Name: "ResetPlaybackSpeed", Key: "R", Label: "Reset Playback Speed", Category: "Player" },
            { Name: "BookmarkCurrentTime", Key: "B", Label: "Bookmark Current Time", Category: "Player" },
            { Name: "OpenEpisodePreview", Key: "P", Label: "Open Episode Preview", Category: "Player" },
            { Name: "SkipIntroOutro", Key: "O", Label: "Skip Intro/Outro", Category: "Player" },
            { Name: "FrameStepBack", Key: ",", Label: "Step Back One Frame", Category: "Player" },
            { Name: "FrameStepForward", Key: ".", Label: "Step Forward One Frame", Category: "Player" },
            { Name: "JumpToLastPosition", Key: "Z", Label: "Jump to Last Position", Category: "Player" }
        ];

        function renderOverrides() {
            shortcutListContainer.innerHTML = '';
            if (shortcutOverrides.length === 0) {
                shortcutListContainer.innerHTML = '<p class="fieldDescription" style="text-align: center;">No overrides configured. All shortcuts are using default values.</p>';
            }
            shortcutOverrides.forEach((shortcut, index) => {
                const row = document.createElement('div');
                row.className = 'inputContainer';
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '1em';

                const label = document.createElement('label');
                label.className = 'inputLabel';
                label.textContent = shortcut.Label;
                label.style.flex = '1';

                const input = document.createElement('input');
                input.setAttribute('is', 'emby-input');
                input.type = 'text';
                input.value = shortcut.Key;
                input.style.flex = '1';
                input.style.textAlign = 'center';
                input.addEventListener('input', (e) => {
                    let value = e.target.value;
                    // Automatically convert single lowercase letters to uppercase ***
                    if (value.match(/^[a-z]$/)) {
                        value = value.toUpperCase();
                        e.target.value = value;
                    }
                    shortcutOverrides[index].Key = value;
                });


                const buttonContainer = document.createElement('div');
                const removeBtn = document.createElement('button');
                removeBtn.setAttribute('is', 'emby-button');
                removeBtn.type = 'button';
                removeBtn.textContent = 'Remove';
                removeBtn.className = 'raised button-cancel';
                removeBtn.style.marginLeft = '1em';
                removeBtn.addEventListener('click', () => {
                    shortcutOverrides.splice(index, 1);
                    jcMarkConfigDirty();
                    renderOverrides();
                    populateAddShortcutDropdown();
                });

                buttonContainer.appendChild(removeBtn);
                row.appendChild(label);
                row.appendChild(input);
                row.appendChild(buttonContainer);
                shortcutListContainer.appendChild(row);
            });
        }

        function populateAddShortcutDropdown() {
            addShortcutSelect.innerHTML = '';
            const overriddenNames = shortcutOverrides.map(s => s.Name);
            const availableShortcuts = defaultShortcuts.filter(s => !overriddenNames.includes(s.Name));

            availableShortcuts.forEach(shortcut => {
                const option = document.createElement('option');
                option.value = shortcut.Name;
                option.textContent = shortcut.Label;
                addShortcutSelect.appendChild(option);
            });
            addShortcutBtn.disabled = availableShortcuts.length === 0;
            addShortcutKeyInput.disabled = availableShortcuts.length === 0;
        }

        function showValidationError(elementToShake, message) {
            shortcutErrorComment.textContent = message;
            shortcutErrorComment.style.display = 'block';
            elementToShake.classList.add('shake');

            setTimeout(() => {
                elementToShake.classList.remove('shake');
                shortcutErrorComment.style.display = 'none';
            }, 8000);
        }

        jcPageLifecycle.addListener(addShortcutBtn, 'click', () => {
            const selectedName = addShortcutSelect.value;
            let newKey = addShortcutKeyInput.value.trim();

            // Automatically convert single lowercase letters to uppercase ***
            if (newKey.match(/^[a-z]$/)) {
                newKey = newKey.toUpperCase();
            }

            // Check 0: See if there is a key being added
            if (!selectedName || !newKey) {
                showValidationError(addShortcutBtn, 'Please enter a key to use as an override.');
                return;
            }

            // Check 1: See if the key is already used in another custom override.
            const overrideConflict = shortcutOverrides.find(s => s.Key.toLowerCase() === newKey.toLowerCase());

            if (overrideConflict) {
                const errorMessage = "The key '" + newKey + "' is already assigned to '" + overrideConflict.Label + "' as an override.";
                showValidationError(addShortcutKeyInput.parentElement, errorMessage);
                return;
            }

            // Check 2: See if the key is used by another default shortcut.
            const defaultConflict = defaultShortcuts.find(s => s.Key.toLowerCase() === newKey.toLowerCase() && s.Name !== selectedName);

            if (defaultConflict) {
                const errorMessage = "The key '" + newKey + "' is already used by '" + defaultConflict.Label + "'.";
                showValidationError(addShortcutKeyInput.parentElement, errorMessage);
                return;
            }

            const defaultConfig = defaultShortcuts.find(s => s.Name === selectedName);
            if (defaultConfig) {
                shortcutOverrides.push({ ...defaultConfig, Key: newKey });
                renderOverrides();
                populateAddShortcutDropdown();
                addShortcutKeyInput.value = '';
            }
        });

        async function testSeerrConnection() {
            const urls = (jcSel('#seerrUrls').value || '').split('\n').map(u => u.trim()).filter(Boolean);
            const apiKey = (jcSel('#SeerrApiKey').value || '').trim();

            if (!urls.length || !apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide at least one Seerr URL and an API key to test the connection.' });
                return;
            }

            const _testToken = (typeof beginConnectionTest === 'function') ? beginConnectionTest() : undefined;
            testSeerrBtn.disabled = true;
            seerrStatusIndicator.textContent = 'sync';
            seerrStatusIndicator.classList.add('status-check');
            seerrStatusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            let validated = false;
            let lastError = '';
            for (const url of urls) {
                try {
                    const validationUrl = ApiClient.getUrl(`/JellyfinCanopy/seerr/validate`, {
                        url: url
                    });

                    const res = await ApiClient.ajax({ type: 'GET', url: validationUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKey } });

                    if (res && res.ok) {
                        validated = true;
                        break;
                    }
                } catch (e) {
                    console.error(`Seerr validation failed for ${url}:`, e);
                    // Jellyfin's ApiClient.ajax rejects with the Response object
                    // (modern fetch), which doesn't expose responseText/responseJSON.
                    // Read the body asynchronously so connectionErrorMessage can
                    // surface the typed code/cfRay/message envelope.
                    if (e && typeof e.json === 'function') {
                        try { e.responseJSON = await e.clone().json(); } catch (_) { /* not JSON */ }
                    }
                    lastError = connectionErrorMessage(e, 'Seerr', url);
                }
            }

            testSeerrBtn.disabled = false;
            seerrStatusIndicator.classList.remove('status-check');

            if (validated) {
                seerrStatusIndicator.textContent = 'check_circle';
                seerrStatusIndicator.style.color = '#52b54b';
                try { setConnectionTestResult('seerr', 'ok', 'Connected', _testToken); } catch (e) { /* cache is best-effort */ }
                jcTestAlert({ title: 'Success', message: 'Successfully connected to Seerr!' });
            } else {
                seerrStatusIndicator.textContent = 'error';
                seerrStatusIndicator.style.color = '#dc3545';
                try { setConnectionTestResult('seerr', 'error', (lastError && lastError.length < 80) ? lastError : 'Connection failed', _testToken); } catch (e) { /* cache is best-effort */ }
                jcTestAlert({ title: 'Connection Failed', message: lastError || 'Could not connect to any provided URL.' });
            }
        }

        async function testTmdbConnection(event) {
            const apiKey = (jcSel('#TMDB_API_KEY').value || '').trim();

            if (!apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide a TMDB API key to test the connection.' });
                return;
            }

            const _testToken = (typeof beginConnectionTest === 'function') ? beginConnectionTest() : undefined;

            // Determine which status indicator to update based on button context
            const button = event.target.closest('button');
            const statusIndicator = button.parentElement.querySelector('.material-icons') || tmdbStatusIndicator;

            // Disable all test buttons during the test
            const allTestButtons = jcSelAll('.testTmdbBtn');
            allTestButtons.forEach(btn => btn.disabled = true);

            statusIndicator.textContent = 'sync';
            statusIndicator.classList.add('status-check');
            statusIndicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            try {
                const validationUrl = ApiClient.getUrl(`/JellyfinCanopy/tmdb/validate`, { apiKey: apiKey });
                await ApiClient.ajax({ type: 'GET', url: validationUrl });

                statusIndicator.textContent = 'check_circle';
                statusIndicator.style.color = '#52b54b';
                try { setConnectionTestResult('tmdb', 'ok', 'API key valid', _testToken); } catch (err) { /* cache is best-effort */ }
                jcTestAlert({ title: 'Success', message: 'Successfully connected to TMDB!' });

            } catch (e) {
                console.error('TMDB validation failed:', e);
                var errorMessage;
                if (e.status === 401) {
                    errorMessage = 'The API key is invalid. Check that you copied it correctly.';
                } else if (e.status === 500 || e.status === 0 || !e.status) {
                    errorMessage = 'Could not reach TMDB servers. Check your network connection.';
                } else {
                    errorMessage = 'Connection failed (error ' + e.status + '). Check the key and your network.';
                }

                statusIndicator.textContent = 'error';
                statusIndicator.style.color = '#dc3545';
                try {
                    var shortDetail = e.status === 401 ? 'API key rejected'
                        : (e.status === 500 || e.status === 0 || !e.status) ? 'Unreachable'
                        : 'Error ' + e.status;
                    setConnectionTestResult('tmdb', 'error', shortDetail, _testToken);
                } catch (err) { /* cache is best-effort */ }
                jcTestAlert({ title: 'Connection Failed', message: errorMessage });
            } finally {
                allTestButtons.forEach(btn => btn.disabled = false);
                if (statusIndicator) {
                    statusIndicator.classList.remove('status-check');
                }
            }
        }

        // Plugin detection state.
        //
        // Each `hasX` is tri-state: `null` (not yet probed or probe failed),
        // `true` (installed AND Status === "Active"), `false` (not installed
        // OR installed but disabled). When the plugin is installed-but-
        // disabled, we additionally record it in `_jeDisabledPlugins` so the
        // Optional Dependencies card can surface "Installed (disabled)"
        // instead of the blunt "Not installed".
        var hasIntroSkipper = null;
        var hasInPlayerEpisodePreview = null;
        var hasFileTransformation = null;
        var hasKefinTweaks = null;
        var _jeDisabledPlugins = {}; // key -> true when installed but Status !== 'Active'

        /**
         * Checks installed optional integration plugins (File Transformation, Intro
         * Skipper, In-Player Episode Preview, KefinTweaks) and updates the Optional
         * Dependencies dashboard. Called during loadConfig() on page load.
         */
        function checkInstalledPlugins() {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Plugins'),
                dataType: 'json'
            }).then(function(plugins) {
                // Lifecycle guard (#167 findings 2/3): this /Plugins probe is
                // started synchronously by loadConfig, but a later dashboard
                // visit may have torn down this owner while the request was in
                // flight. Running the continuation would toggle document.body
                // detection classes, reset this closure's detection flags and
                // write dependency/probe state into the CURRENT visit's globally
                // queried DOM. Bail before touching anything so at most the live
                // visit's own probe owns the page.
                if (!jcPageLifecycle.active) return;
                setProbeWarning('plugins', null);
                // Status-aware plugin lookup. Returns tri-state:
                //   true  → installed AND active
                //   false → either not installed OR disabled
                // When disabled, also records it in _jeDisabledPlugins[key] so
                // the Optional Dependencies card can show "Installed (disabled)".
                _jeDisabledPlugins = {};
                function probe(key, names) {
                    var match = null;
                    var lowered = names.map(function(n) { return n.toLowerCase(); });
                    for (var i = 0; i < plugins.length; i++) {
                        var nm = (plugins[i].Name || '').toLowerCase();
                        if (lowered.indexOf(nm) !== -1) { match = plugins[i]; break; }
                    }
                    if (!match) return false;
                    // Jellyfin returns Status as one of: Active, Disabled, Restart,
                    // NotSupported, Malfunctioned, Superseded. Anything else → log
                    // once and treat as disabled so the dashboard surfaces a warning
                    // rather than silently passing through. Old builds that omit
                    // Status entirely are caught here too — better to see "Installed
                    // but status unknown" than misreport as Active.
                    //
                    // Rendering note: `_jeDisabledPlugins[key]` captures the raw
                    // Status string. The Optional Dependencies dashboard renders
                    // "Installed but disabled in Dashboard > Plugins" for any
                    // non-Active value. That copy is accurate for Disabled but
                    // slightly misleading for Restart ("waiting for server restart")
                    // and Superseded ("replaced by newer version, probably still
                    // usable"). Callers wanting distinct copy per status should
                    // branch on the raw value.
                    var status = match.Status;
                    var active = status === 'Active';
                    if (!active) {
                        _jeDisabledPlugins[key] = status || 'Status unknown';
                        if (status && ['Disabled', 'Restart', 'NotSupported', 'Malfunctioned', 'Superseded'].indexOf(status) === -1) {
                            console.warn('[JC] plugin ' + match.Name + ' has unexpected Status value: ' + JSON.stringify(status));
                        }
                    }
                    return active;
                }
                hasFileTransformation = probe('fileTransformation', ['File Transformation']);
                hasIntroSkipper       = probe('introSkipper',       ['Intro Skipper', 'SkipIntro']);
                hasInPlayerEpisodePreview = probe('inPlayerEpisodePreview', ['In Player Episode Preview', 'In-Player Episode Preview', 'InPlayerEpisodePreview']);

                // KefinTweaks installs as a web-mod (files in /config/KefinTweaks/
                // injected via File Transformation into index.html), NOT as a
                // .NET plugin — so it never appears in /Plugins. Detect it at
                // runtime instead: the injector sets `window.KefinTweaksConfig`
                // and adds script tags whose src contains "KefinTweaks".
                try {
                    hasKefinTweaks = !!(window.KefinTweaksConfig ||
                        document.querySelector('script[src*="KefinTweaks"]'));
                } catch (e) {
                    // Extremely unlikely (the selector is literal and the window
                    // read is same-origin), but a future isolation/CSP quirk could
                    // throw — log so we can distinguish "detection bug" from
                    // "legitimately not installed" in bug reports.
                    console.warn('[JC] KefinTweaks detection threw; treating as absent:', e);
                    hasKefinTweaks = false;
                }

                // Toggle body classes so descriptions hide install-only content
                // (e.g., "Install the Custom Tabs plugin...") and surface a positive
                // "detected" badge when an integration plugin is already present.
                document.body.classList.toggle('jc-has-introskipper',      hasIntroSkipper       === true);
                document.body.classList.toggle('jc-has-inplayerepisodepreview', hasInPlayerEpisodePreview === true);
                document.body.classList.toggle('jc-has-kefintweaks',       hasKefinTweaks        === true);

                // Re-run dependencies now that plugin info is available
                updateAllDependencies();
            }).catch(function(err) {
                // Lifecycle guard (#167 findings 2/3): a late failure from a
                // torn-down visit must not clear a replacement visit's detected
                // body classes or overwrite its dependency state with a false
                // "couldn't reach /Plugins" warning. If this owner was replaced,
                // its probe no longer owns the page — bail before any DOM/state work.
                if (!jcPageLifecycle.active) return;
                // Plugin list request failed (network, auth expiry, server offline, ...).
                // Leave hasIntroSkipper at null so individual deps show
                // "unknown" rather than incorrectly disabling toggles. Still refresh
                // the dashboard so cards don't sit stuck on "Checking..." forever.
                console.warn('[JC] plugin detection failed; resetting detection state to avoid stale UI:', err);
                // Reset detection state so prior-success flags don't contradict
                // the visible "couldn't reach /Plugins" warning. Body classes,
                // module flags, and dep gates all flip back to "unknown" so the
                // UI is internally consistent after a failed retry.
                hasIntroSkipper = null;
                hasInPlayerEpisodePreview = null;
                hasFileTransformation = null;
                hasKefinTweaks = null;
                document.body.classList.remove('jc-has-introskipper', 'jc-has-inplayerepisodepreview', 'jc-has-kefintweaks');
                setProbeWarning('plugins', "Couldn't reach the Jellyfin /Plugins endpoint to verify which integrations are installed (auth expiry, network, or server issue). Dependency hints and \"plugin detected\" badges are now hidden until you retry.");
                try { updateAllDependencies(); } catch (e) {
                    console.warn('[JC] updateAllDependencies threw during plugin-detect fallback:', e);
                }
                try {
                    updateStatusDashboard();
                } catch (e) {
                    console.warn('[JC] updateStatusDashboard threw during plugin-detect fallback:', e);
                }
            });
            // Probe-warning retry — re-runs plugin detection (which also re-runs
            // the Custom Tabs config probe inside its .then). One handler only;
            // checkInstalledPlugins is idempotent.
            var probeRetry = jcById('jc-probe-retry-btn');
            // Guard by the live owner's token (not a boolean): after a
            // teardown→reinstall on the same cached page the old flag would
            // survive and suppress rebinding, leaving onclick pointed at the
            // retired owner whose checkInstalledPlugins continuation no-ops
            // (#167 findings 2/7). A fresh owner reassigns onclick (replace
            // semantics — no stacking).
            if (probeRetry && probeRetry.dataset.jcWired !== jcPageLifecycle.id) {
                probeRetry.dataset.jcWired = jcPageLifecycle.id;
                probeRetry.onclick = function() {
                    setProbeWarning('plugins', null);
                    checkInstalledPlugins();
                };
            }
        }

        // Surfaces a single probe-failure banner above the form. Multiple probes
        // (plugin list, Custom Tabs config schema) can fail independently — the
        // banner aggregates them so the admin sees one actionable message instead
        // of nothing. Pass an empty/null msg to clear the banner for that source.
        var _jeProbeWarnings = Object.create(null);
        function setProbeWarning(source, msg) {
            if (msg) _jeProbeWarnings[source] = msg;
            else delete _jeProbeWarnings[source];
            var banner = jcById('jc-probe-warning');
            var msgEl = jcById('jc-probe-warning-msg');
            if (!banner || !msgEl) return;
            var keys = Object.keys(_jeProbeWarnings);
            if (keys.length === 0) {
                banner.style.display = 'none';
                msgEl.textContent = '';
            } else {
                msgEl.textContent = ' — ' + keys.map(function(k) { return _jeProbeWarnings[k]; }).join(' / ');
                banner.style.display = '';
            }
        }

        // Auto Movie Request - Quality Profile Mode helpers
        function clearSelectOptions(selectEl) {
            while (selectEl.options.length > 0) {
                selectEl.remove(0);
            }
        }

        function addSelectOption(selectEl, value, text) {
            var opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            selectEl.appendChild(opt);
        }

        function resetSelectWithMessage(selectEl, value, message) {
            clearSelectOptions(selectEl);
            addSelectOption(selectEl, value, message);
        }

        function initAutoMovieQualityMode() {
            var qualityModeSelect = jcSel('#autoMovieRequestQualityMode');
            var customSettingsDiv = jcSel('#autoMovieRequestCustomSettings');
            if (!qualityModeSelect || !customSettingsDiv) return;

            jcPageLifecycle.addListener(qualityModeSelect, 'change', function() {
                customSettingsDiv.style.display = (qualityModeSelect.value === 'custom') ? 'block' : 'none';
                if (qualityModeSelect.value === 'custom') {
                    loadAutoMovieRadarrServers();
                }
            });
        }

        var _autoMovieServerListenerAdded = false;
        function loadAutoMovieRadarrServers(savedConfig) {
            var serverSelect = jcSel('#autoMovieRequestServer');
            var profileSelect = jcSel('#autoMovieRequestProfile');
            var folderSelect = jcSel('#autoMovieRequestRootFolder');
            if (!serverSelect) return;

            resetSelectWithMessage(serverSelect, '-1', 'Loading...');

            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinCanopy/seerr/radarr'),
                dataType: 'json'
            }).then(function(servers) {
                resetSelectWithMessage(serverSelect, '-1', 'Select Server...');
                var serverList = Array.isArray(servers) ? servers : [servers];
                serverList.forEach(function(server) {
                    if (server && typeof server.id === 'number') {
                        addSelectOption(serverSelect, server.id, server.name || ('Server ' + server.id));
                    }
                });

                var savedServerId = savedConfig ? savedConfig.AutoMovieRequestCustomServerId : null;
                if (savedServerId !== null && savedServerId !== undefined && savedServerId >= 0) {
                    serverSelect.value = savedServerId;
                    loadAutoMovieServerDetails(savedServerId, savedConfig);
                }
            }).catch(function(err) {
                resetSelectWithMessage(serverSelect, '-1', 'Failed to load servers');
                console.warn('[Auto-Movie-Request] Failed to load Radarr servers:', err);
            });

            if (!_autoMovieServerListenerAdded) {
                _autoMovieServerListenerAdded = true;
                jcPageLifecycle.addListener(serverSelect, 'change', function() {
                    var serverId = parseInt(serverSelect.value);
                    if (!isNaN(serverId) && serverId >= 0) {
                        loadAutoMovieServerDetails(serverId);
                    } else {
                        resetSelectWithMessage(profileSelect, '0', 'Select a server first...');
                        resetSelectWithMessage(folderSelect, '', 'Select a server first...');
                    }
                });
            }
        }

        function loadAutoMovieServerDetails(serverId, savedConfig) {
            var profileSelect = jcSel('#autoMovieRequestProfile');
            var folderSelect = jcSel('#autoMovieRequestRootFolder');
            if (!profileSelect || !folderSelect) return;

            resetSelectWithMessage(profileSelect, '0', 'Loading...');
            resetSelectWithMessage(folderSelect, '', 'Loading...');

            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinCanopy/seerr/radarr/' + serverId),
                dataType: 'json'
            }).then(function(details) {
                resetSelectWithMessage(profileSelect, '0', 'Select Profile...');
                (details.profiles || []).forEach(function(profile) {
                    addSelectOption(profileSelect, profile.id, profile.name || ('Profile ' + profile.id));
                });

                resetSelectWithMessage(folderSelect, '', 'Select Folder...');
                (details.rootFolders || []).forEach(function(folder) {
                    addSelectOption(folderSelect, folder.path, folder.path);
                });

                var savedProfileId = (savedConfig && savedConfig.AutoMovieRequestCustomProfileId) || 0;
                if (savedProfileId > 0) profileSelect.value = savedProfileId;
                var savedRootFolder = (savedConfig && savedConfig.AutoMovieRequestCustomRootFolder) || '';
                if (savedRootFolder) folderSelect.value = savedRootFolder;
            }).catch(function(err) {
                resetSelectWithMessage(profileSelect, '0', 'Failed to load');
                resetSelectWithMessage(folderSelect, '', 'Failed to load');
                console.warn('[Auto-Movie-Request] Failed to load server details:', err);
            });
        }

        // ==================== Multi-Instance Arr Management ====================

        function createEl(tag, attrs, children) {
            var el = document.createElement(tag);
            if (attrs) {
                Object.keys(attrs).forEach(function(k) {
                    if (k === 'textContent') el.textContent = attrs[k];
                    else if (k === 'style') el.setAttribute('style', attrs[k]);
                    else if (k === 'className') el.className = attrs[k];
                    else el.setAttribute(k, attrs[k]);
                });
            }
            if (children) {
                children.forEach(function(c) { if (c) el.appendChild(c); });
            }
            return el;
        }

        function createInstanceCard(type, instance, startOpen) {
            var defaultName = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var namePlaceholder = type === 'sonarr' ? 'e.g., TV Shows, Anime' : 'e.g., Movies, 4K Movies';
            var urlPlaceholder = type === 'sonarr' ? 'e.g., http://192.168.1.100:8989' : 'e.g., http://192.168.1.100:7878';

            // Default Enabled to true when the stored JSON omits the field (backwards compat with
            // configs written before the Enabled flag existed).
            var initiallyEnabled = instance.Enabled !== false;

            // Enabled toggle lives in the summary row so admins can flip it without expanding
            // the card. stopPropagation on pointer events prevents the <details> from toggling
            // open/closed when the user clicks the checkbox itself.
            // Styled via .arr-instance-enabled CSS (see configPage.css). We intentionally
            // do NOT use is="emby-checkbox" — that custom element expects a <label> wrapper
            // with a sibling <span>, which we can't provide inside a <details><summary> row
            // without breaking the flex layout of the name/URL/disabled chip.
            var ariaName = (instance.Name || '').trim() || defaultName;
            var enabledCheckbox = createEl('input', {
                type: 'checkbox',
                className: 'arr-instance-enabled',
                'aria-label': 'Enable ' + ariaName + ' instance',
                title: 'Uncheck to skip this instance in all fan-out paths (links, calendar, queue, tag sync) without deleting its URL/API key'
            });
            if (initiallyEnabled) enabledCheckbox.checked = true;
            ['click', 'mousedown', 'keydown'].forEach(function(evt) {
                enabledCheckbox.addEventListener(evt, function(e) { e.stopPropagation(); });
            });

            // Summary row (visible when collapsed). Order: [▶ disclosure] [☑ enabled] [name] [(disabled)] [url]
            var summaryDisabledSpan = createEl('span', {
                className: 'arr-instance-summary-disabled',
                textContent: '(disabled)',
                style: 'color: #e5a00d; font-size: 0.85em; margin-right: 0.5em; display: ' + (initiallyEnabled ? 'none' : 'inline')
            });
            var summaryNameSpan = createEl('span', { className: 'arr-instance-summary-name', textContent: instance.Name || defaultName });
            var summaryUrlSpan = createEl('span', { className: 'arr-instance-summary-url', textContent: instance.Url || '' });
            var summaryEl = document.createElement('summary');
            summaryEl.appendChild(enabledCheckbox);
            summaryEl.appendChild(summaryNameSpan);
            summaryEl.appendChild(summaryDisabledSpan);
            summaryEl.appendChild(summaryUrlSpan);

            // Body header: [name input (flex:1)] [Remove]. The Enabled toggle used to live here
            // too, which crowded the row and left the name input pinched against it. Moved to
            // the summary above so this row has only the rename + remove affordances.
            var nameInput = createEl('input', { className: 'arr-instance-name emby-input', type: 'text', placeholder: namePlaceholder, value: instance.Name || '', style: 'flex:1' });
            var removeBtn = createEl('button', { className: 'arr-instance-remove', type: 'button', title: 'Remove instance', textContent: 'Remove' });
            var header = createEl('div', { className: 'arr-instance-header' }, [nameInput, removeBtn]);

            var urlLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'URL (internal)' });
            var urlInput = createEl('input', { className: 'arr-instance-url emby-input', type: 'text', placeholder: urlPlaceholder, value: instance.Url || '' });
            var defaultPort = type === 'sonarr' ? '8989' : '7878';
            var urlDesc = createEl('div', { className: 'fieldDescription', textContent: 'The Jellyfin server uses this URL to talk to ' + (type === 'sonarr' ? 'Sonarr' : 'Radarr') + ' directly. If your public URL sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. http://' + type + ':' + defaultPort + ' or http://192.168.x.y:' + defaultPort + ') and set the External URL below for user-facing links.' });
            var urlContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [urlLabel, urlInput, urlDesc]);

            // Optional external/public URL used only for user-clickable links in the browser.
            // Empty = reuse the internal URL above (unchanged behaviour). Never used for
            // server-side fetches.
            var externalLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'External URL (optional)' });
            var externalInput = createEl('input', { className: 'arr-instance-externalurl emby-input', type: 'text', placeholder: 'e.g., https://' + type + '.example.com', value: instance.ExternalUrl || '' });
            var externalDesc = createEl('div', { className: 'fieldDescription', textContent: 'Public URL a user\'s browser opens for links to this instance. Leave blank to reuse the internal URL above. URL Mappings below still take priority when a mapping matches.' });
            var externalContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [externalLabel, externalInput, externalDesc]);

            var apiLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'API Key' });
            var apiInput = createEl('input', { className: 'arr-instance-apikey emby-input', type: 'text', autocomplete: 'off', placeholder: 'API key (find in Settings > General > Security)', value: instance.ApiKey || '' });
            var statusIcon = createEl('span', { className: 'material-icons arr-instance-status', style: 'transition: color 0.3s ease;' });
            var testBtn = createEl('button', { className: 'emby-button raised arr-instance-test', type: 'button' });
            testBtn.appendChild(createEl('span', { textContent: 'Test' }));
            var apiRow = createEl('div', { style: 'display: flex; align-items: center; gap: 1em;' }, [apiInput, statusIcon, testBtn]);
            var apiDesc = createEl('div', { className: 'fieldDescription', textContent: 'Find this in ' + (type === 'sonarr' ? 'Sonarr' : 'Radarr') + ' under Settings > General > Security > API Key' });
            var apiContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [apiLabel, apiRow, apiDesc]);

            // URL Mappings shown inline (no nested <details>) — the whole card already
            // expands behind its own <details>, so doubling up on collapses hides a
            // frequently-edited field one extra click deep.
            var mappingsLabel = createEl('label', { className: 'inputLabel inputLabelUnfocused', textContent: 'URL Mappings (optional)' });
            var mappingsTextarea = createEl('textarea', { className: 'arr-instance-urlmappings emby-textarea emby-input', style: 'display:block; height: 8vh !important; margin-top: 0.25em;', placeholder: 'jellyfin_url|arr_url (one per line)' });
            mappingsTextarea.value = instance.UrlMappings || '';
            var mappingsDesc = createEl('div', { className: 'fieldDescription', textContent: 'Map Jellyfin access URLs to this instance\'s URL. Format: jellyfin_url|arr_url (one per line). Useful for reverse-proxy setups.' });
            var mappingsContainer = createEl('div', { className: 'inputContainer', style: 'margin-top: 0.5em;' }, [mappingsLabel, mappingsTextarea, mappingsDesc]);

            var body = createEl('div', { className: 'arr-instance-card-body' }, [header, urlContainer, externalContainer, apiContainer, mappingsContainer]);

            // The card is a <details> element
            var card = document.createElement('details');
            card.className = 'arr-instance-card';
            if (!initiallyEnabled) card.classList.add('arr-instance-disabled');
            card.dataset.type = type;
            if (startOpen) card.open = true;
            card.appendChild(summaryEl);
            card.appendChild(body);

            // Keep summary text in sync with name/url inputs
            nameInput.addEventListener('input', function() {
                var n = nameInput.value.trim() || defaultName;
                summaryNameSpan.textContent = n;
                enabledCheckbox.setAttribute('aria-label', 'Enable ' + n + ' instance');
            });
            urlInput.addEventListener('input', function() {
                summaryUrlSpan.textContent = urlInput.value.trim();
            });

            // Toggle visual dim state + summary "(disabled)" chip when the Enabled checkbox
            // changes. The backend is the authority — this is UI feedback only until Save.
            // Also re-renders the Overview Service Status card so a disabled instance
            // instantly shows as "Disabled" instead of a stale red/green badge.
            //
            // setBodyDisabled marks every form control inside the card body read-only when
            // the toggle is off so edits can't silently persist — collectInstancesFromDom
            // reads input values directly and respects the Enabled flag on save.
            function setBodyDisabled(disabled) {
                body.querySelectorAll('input, textarea, button, select').forEach(function(el) {
                    if (disabled) {
                        el.setAttribute('disabled', '');
                    } else {
                        el.removeAttribute('disabled');
                    }
                });
            }
            setBodyDisabled(!initiallyEnabled);
            enabledCheckbox.addEventListener('change', function() {
                var en = enabledCheckbox.checked;
                summaryDisabledSpan.style.display = en ? 'none' : 'inline';
                card.classList.toggle('arr-instance-disabled', !en);
                setBodyDisabled(!en);
                try { renderServiceStatusDashboard(); } catch (e) {
                    console.warn('[JC] renderServiceStatusDashboard threw from arr-instance enable-toggle:', e);
                }
            });

            // Confirm before removing
            removeBtn.addEventListener('click', function(e) {
                e.preventDefault();
                var instName = nameInput.value.trim() || defaultName;
                Dashboard.confirm('Remove "' + instName + '" from the instance list? The change takes effect when you click Save. If you leave the page without saving, the instance is kept.\n\nTip: If you just want to stop using it temporarily, uncheck Enabled instead — that preserves the URL and API key.', 'Remove Instance', function(confirmed) {
                    if (confirmed) {
                        card.remove();
                        jcMarkConfigDirty();
                        updateAllDependencies();
                    }
                });
            });

            testBtn.addEventListener('click', function() { testInstanceConnection(card); });
            apiInput.style.flex = '1';
            return card;
        }

        // Tracks whether each instance-list JSON parsed cleanly on load.
        // When false, saveArrInstances refuses to overwrite the stored value and legacy fields
        // to avoid turning a read-side corruption into permanent data loss.
        var _arrParseOK = { sonarr: true, radarr: true };

        function tryParseInstanceList(raw, type, container) {
            if (!raw) { _arrParseOK[type] = true; return []; }
            try {
                var parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) throw new Error(type + 'Instances JSON is not an array');
                _arrParseOK[type] = true;
                return parsed;
            } catch (e) {
                _arrParseOK[type] = false;
                console.error('[JC Config] Failed to parse ' + type + 'Instances — refusing to overwrite on save:', e, raw);
                insertCorruptBanner(container, type);
                return [];
            }
        }

        function insertCorruptBanner(container, type) {
            var label = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            var banner = document.createElement('div');
            banner.className = 'arr-corrupt-banner';
            banner.setAttribute('data-arr-corrupt', type);
            banner.style.cssText = 'padding: 0.8em 1em; margin-bottom: 1em; border: 1px solid #dc3545; background: rgba(220,53,69,0.15); border-radius: 4px;';

            var heading = document.createElement('strong');
            heading.textContent = '⚠ Stored ' + label + ' instance configuration is corrupted.';
            var detail = document.createElement('div');
            detail.style.marginTop = '0.3em';
            detail.textContent = 'The saved JSON could not be parsed. Saving this page will NOT overwrite the stored value or the legacy ' +
                label + ' URL/API key — so existing configuration is preserved. To recover: either fix the stored JSON directly in Jellyfin\'s plugin config, ' +
                'or click the button below to reset this list (destroys the unreadable value).';
            banner.appendChild(heading);
            banner.appendChild(detail);

            var resetBtn = document.createElement('button');
            resetBtn.className = 'emby-button raised';
            resetBtn.style.marginTop = '0.6em';
            resetBtn.type = 'button';
            resetBtn.textContent = 'Reset ' + label + ' instances (clears stored value)';
            resetBtn.addEventListener('click', function() {
                Dashboard.confirm(
                    'Reset the corrupt ' + label + ' instance configuration? The stored JSON is unreadable so any instances it contained cannot be recovered. You will need to add them again. The reset takes effect when you click Save.',
                    'Reset Instances',
                    function(confirmed) {
                        if (!confirmed) return;
                        _arrParseOK[type] = true;
                        banner.remove();
                        // On next Save, the empty array will be written and legacy fields cleared normally.
                    }
                );
            });
            banner.appendChild(resetBtn);

            container.appendChild(banner);
        }

        function loadArrInstances(config) {
            var sonarrList = jcSel('#sonarrInstancesList');
            var radarrList = jcSel('#radarrInstancesList');
            sonarrList.textContent = '';
            radarrList.textContent = '';
            _arrParseOK = { sonarr: true, radarr: true };

            var sonarrInstances = tryParseInstanceList(config.SonarrInstances, 'sonarr', sonarrList);
            var radarrInstances = tryParseInstanceList(config.RadarrInstances, 'radarr', radarrList);

            // Migration: only when parse succeeded AND no instances but legacy fields are populated.
            // Skip migration when parse failed — the legacy fields may be stale or already migrated.
            if (_arrParseOK.sonarr && sonarrInstances.length === 0 && config.SonarrUrl && config.SonarrApiKey) {
                sonarrInstances.push({
                    Name: 'Sonarr',
                    Url: config.SonarrUrl,
                    ExternalUrl: config.SonarrExternalUrl || '',
                    ApiKey: config.SonarrApiKey,
                    UrlMappings: config.SonarrUrlMappings || ''
                });
            }
            if (_arrParseOK.radarr && radarrInstances.length === 0 && config.RadarrUrl && config.RadarrApiKey) {
                radarrInstances.push({
                    Name: 'Radarr',
                    Url: config.RadarrUrl,
                    ExternalUrl: config.RadarrExternalUrl || '',
                    ApiKey: config.RadarrApiKey,
                    UrlMappings: config.RadarrUrlMappings || ''
                });
            }

            sonarrInstances.forEach(function(inst) {
                sonarrList.appendChild(createInstanceCard('sonarr', inst));
            });
            radarrInstances.forEach(function(inst) {
                radarrList.appendChild(createInstanceCard('radarr', inst));
            });
        }

        // Requests Page requirements line — the page draws from two INDEPENDENT
        // data sources and is useful with EITHER one, so the requirement is met
        // as soon as one source is configured:
        //   • Downloads list  ← at least one ENABLED *arr service (Sonarr and/or
        //     Radarr). A movie-only setup with just Radarr, or a TV-only setup
        //     with just Sonarr, is enough — neither is individually mandatory.
        //   • Requests/Issues list ← Seerr (URL + API key).
        // The download section renders with no Seerr, and the requests section
        // renders with no *arr, so forcing all three (the old behaviour) blocked
        // legitimate single-service setups from the page. The surrounding info
        // banner stays visible; only the "Requirements:" sentence toggles. Runs
        // off the live DOM so typing a URL/API key updates immediately without a
        // save-and-reload.
        function updateRequestsRequirementsBanner() {
            var line = jcById('requestsPageRequirementsLine');
            if (!line) return;
            var list = jcById('requestsPageRequirementsList');

            // At least one enabled Sonarr/Radarr instance with URL + API key.
            // Reuses the shared arr check so disabled-only instances don't count
            // as "configured" (they're skipped by every fan-out caller).
            var arrOK = hasAnyArrService();
            // Seerr side uses the same "enabled AND a valid URL + API key" test as
            // the rest of the config page (the #seerr section gate). The requests
            // and issues sections only render when SeerrEnabled is on, so
            // creds typed in while the integration is left disabled must NOT count
            // as a working source — otherwise the banner would report "ready" over
            // an empty page.
            var seerrOK = hasSeerrConfigured();

            if (arrOK || seerrOK) {
                line.style.display = 'none';
                return;
            }

            // Nothing configured yet — point the admin at either data source.
            if (list) {
                list.textContent = 'Configure Seerr (for requests) and/or Sonarr or Radarr (for downloads) — URL and API key each.';
            }
            line.style.display = '';
        }

        // Shared check for optional external/public URL fields: an external URL is only kept
        // when it is an absolute http(s) URL WITHOUT embedded credentials (user:pass@ would be
        // served to every authenticated client) and WITHOUT a query string or fragment (item
        // paths are appended by concatenation, so ?x=1 would corrupt every link). Anything else
        // is dropped so a malformed value never reaches browser link building.
        function jcIsHttpUrl(value) {
            if (!value) return false;
            try {
                var u = new URL(value.trim());
                return (u.protocol === 'http:' || u.protocol === 'https:')
                    && !u.username && !u.password
                    && !u.search && !u.hash;
            } catch (_) {
                return false;
            }
        }

        function collectInstancesFromDom(selector, defaultName) {
            var out = [];
            var incomplete = [];
            var renamed = [];
            var droppedExternal = [];
            // The instance Name is the ONLY per-service key the runtime targets by (arr links,
            // calendar, tag sync and the action-sheet Search/grab/monitor/add all resolve an
            // instance by Name). Two enabled instances with the same Name make those actions
            // ambiguous — worst case a grab/monitor hits the wrong box — so disambiguate on save.
            var seen = Object.create(null);
            jcSelAll(selector).forEach(function(card) {
                var url = card.querySelector('.arr-instance-url').value.trim();
                var apiKey = card.querySelector('.arr-instance-apikey').value.trim();
                if (url && apiKey) {
                    var enabledCb = card.querySelector('.arr-instance-enabled');
                    var rawName = card.querySelector('.arr-instance-name').value.trim() || defaultName;
                    var externalEl = card.querySelector('.arr-instance-externalurl');
                    var externalRaw = externalEl ? externalEl.value.trim() : '';
                    var externalUrl = '';
                    if (externalRaw) {
                        if (jcIsHttpUrl(externalRaw)) {
                            externalUrl = externalRaw;
                        } else {
                            droppedExternal.push((rawName || defaultName) + ': ' + externalRaw);
                        }
                    }
                    var name = rawName;
                    var key = name.toLowerCase();
                    if (seen[key]) {
                        var suffix = seen[key] + 1;
                        seen[key] = suffix;
                        name = rawName + ' (' + suffix + ')';
                        seen[name.toLowerCase()] = 1;
                        renamed.push(rawName + '” → “' + name);
                    } else {
                        seen[key] = 1;
                    }
                    out.push({
                        Name: name,
                        Url: url,
                        ExternalUrl: externalUrl,
                        ApiKey: apiKey,
                        UrlMappings: card.querySelector('.arr-instance-urlmappings').value || '',
                        // Default to true when the checkbox is missing (shouldn't happen, but
                        // guards against DOM surgery from another script).
                        Enabled: enabledCb ? enabledCb.checked : true
                    });
                } else if (url && !apiKey) {
                    // Card has a URL but no API key — it would be silently dropped. Collect the
                    // name so we can warn the admin before the save commits.
                    incomplete.push(card.querySelector('.arr-instance-name').value.trim() || defaultName);
                }
            });
            return { instances: out, incomplete: incomplete, renamed: renamed, droppedExternal: droppedExternal };
        }

        function saveArrInstances(config) {
            // Only overwrite stored state when the load parse succeeded. Otherwise leave the stored
            // JSON AND legacy fields untouched so the admin can recover the original value.
            var incompleteWarnings = [];

            if (_arrParseOK.sonarr) {
                var sonarrResult = collectInstancesFromDom('#sonarrInstancesList .arr-instance-card', 'Sonarr');
                var sonarrInstances = sonarrResult.instances;
                sonarrResult.incomplete.forEach(function(name) {
                    incompleteWarnings.push('Sonarr instance "' + name + '" has a URL but no API key — it was not saved.');
                });
                sonarrResult.renamed.forEach(function(r) {
                    incompleteWarnings.push('Renamed duplicate Sonarr instance “' + r + '” so actions target the right instance.');
                });
                (sonarrResult.droppedExternal || []).forEach(function(d) {
                    incompleteWarnings.push('Dropped invalid Sonarr External URL (must be an http(s) URL without credentials or query/fragment) — ' + d);
                });
                config.SonarrInstances = JSON.stringify(sonarrInstances);
                if (sonarrInstances.length > 0) {
                    config.SonarrUrl = sonarrInstances[0].Url;
                    config.SonarrExternalUrl = sonarrInstances[0].ExternalUrl || '';
                    config.SonarrApiKey = sonarrInstances[0].ApiKey;
                    config.SonarrUrlMappings = sonarrInstances[0].UrlMappings;
                } else {
                    config.SonarrUrl = '';
                    config.SonarrExternalUrl = '';
                    config.SonarrApiKey = '';
                    config.SonarrUrlMappings = '';
                }
            }

            if (_arrParseOK.radarr) {
                var radarrResult = collectInstancesFromDom('#radarrInstancesList .arr-instance-card', 'Radarr');
                var radarrInstances = radarrResult.instances;
                radarrResult.incomplete.forEach(function(name) {
                    incompleteWarnings.push('Radarr instance "' + name + '" has a URL but no API key — it was not saved.');
                });
                radarrResult.renamed.forEach(function(r) {
                    incompleteWarnings.push('Renamed duplicate Radarr instance “' + r + '” so actions target the right instance.');
                });
                (radarrResult.droppedExternal || []).forEach(function(d) {
                    incompleteWarnings.push('Dropped invalid Radarr External URL (must be an http(s) URL without credentials or query/fragment) — ' + d);
                });
                config.RadarrInstances = JSON.stringify(radarrInstances);
                if (radarrInstances.length > 0) {
                    config.RadarrUrl = radarrInstances[0].Url;
                    config.RadarrExternalUrl = radarrInstances[0].ExternalUrl || '';
                    config.RadarrApiKey = radarrInstances[0].ApiKey;
                    config.RadarrUrlMappings = radarrInstances[0].UrlMappings;
                } else {
                    config.RadarrUrl = '';
                    config.RadarrExternalUrl = '';
                    config.RadarrApiKey = '';
                    config.RadarrUrlMappings = '';
                }
            }

            return incompleteWarnings;
        }

        // Bind add-instance buttons
        jcPageLifecycle.addListener(jcSel('#addSonarrInstance'), 'click', function() {
            jcSel('#sonarrInstancesList').appendChild(
                createInstanceCard('sonarr', { Name: '', Url: '', ExternalUrl: '', ApiKey: '', UrlMappings: '' }, true)
            );
            updateAllDependencies();
        });
        jcPageLifecycle.addListener(jcSel('#addRadarrInstance'), 'click', function() {
            jcSel('#radarrInstancesList').appendChild(
                createInstanceCard('radarr', { Name: '', Url: '', ExternalUrl: '', ApiKey: '', UrlMappings: '' }, true)
            );
            updateAllDependencies();
        });

        // ==================== End Multi-Instance Arr Management ====================

        // Tracks whether the most recent `renderQualityCatOrderAdmin` call ran
        // to completion. If false at save time, we skip writing positional
        // *Order values back to config so a render failure can't clobber the
        // user's saved order with default DOM positions.
        var _qualityCatRenderOK = false;

        // Reorders the admin quality-category rows to match the saved *Order values from the plugin config
        function renderQualityCatOrderAdmin(config) {
            _qualityCatRenderOK = false;
            try {
                var container = jcById('qualityCategoriesAdmin');
                if (!container) return;
                var rows = Array.from(container.querySelectorAll('.jc-quality-cat-admin-row'));
                rows.sort(function (a, b) {
                    var aOrder = parseInt(config[a.dataset.orderKey], 10);
                    var bOrder = parseInt(config[b.dataset.orderKey], 10);
                    if (!Number.isFinite(aOrder)) aOrder = parseInt(a.dataset.defaultOrder, 10);
                    if (!Number.isFinite(bOrder)) bOrder = parseInt(b.dataset.defaultOrder, 10);
                    if (aOrder !== bOrder) return aOrder - bOrder;
                    return parseInt(a.dataset.defaultOrder, 10) - parseInt(b.dataset.defaultOrder, 10);
                });
                rows.forEach(function (row) { container.appendChild(row); });
                refreshQualityCatAdminArrows(container);
                _qualityCatRenderOK = true;
            } catch (err) {
                console.error('Jellyfin Canopy: renderQualityCatOrderAdmin failed; will skip *Order save', err);
            }
        }

        // Updates the disabled/opacity styling on the up/down buttons so the
        // top row can't go up and the bottom row can't go down.
        function refreshQualityCatAdminArrows(container) {
            var rows = container.querySelectorAll('.jc-quality-cat-admin-row');
            rows.forEach(function (row, idx) {
                var up = row.querySelector('.jc-cat-up');
                var down = row.querySelector('.jc-cat-down');
                var first = idx === 0;
                var last = idx === rows.length - 1;
                if (up) {
                    up.disabled = first;
                    up.style.opacity = first ? '0.4' : '1';
                    up.style.cursor = first ? 'not-allowed' : 'pointer';
                }
                if (down) {
                    down.disabled = last;
                    down.style.opacity = last ? '0.4' : '1';
                    down.style.cursor = last ? 'not-allowed' : 'pointer';
                }
            });
        }

        /* jc-quality-cat-reorder:start */
        // Wire up/down arrow clicks for the admin quality-category list.
        // Delegated on the document via the page lifecycle, so a fresh
        // dashboard visit replaces (never stacks on) the previous visit's
        // handler — the #167 defect was N retained copies of this delegate
        // each moving the row one position per click.
        function jcWireQualityCatAdminReorder(doc, lifecycle, refreshArrows, markDirty) {
            // Delegated on the document via a single global slot (#167 AC3): a
            // fresh visit REPLACES the previous visit's handler, so one click on a
            // category Down arrow moves the row exactly one position, never N.
            lifecycle.own('qualityCatReorder', doc, 'click', function (e) {
                var btn = e.target.closest && e.target.closest('#qualityCategoriesAdmin .jc-cat-up, #qualityCategoriesAdmin .jc-cat-down');
                if (!btn || btn.disabled) return;
                e.preventDefault();
                var row = btn.closest('.jc-quality-cat-admin-row');
                if (!row) return;
                var parent = row.parentNode;
                if (!parent) return;
                var isUp = btn.classList.contains('jc-cat-up');
                var sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
                if (!sibling || !sibling.classList.contains('jc-quality-cat-admin-row')) return;
                if (isUp) {
                    parent.insertBefore(row, sibling);
                } else {
                    parent.insertBefore(sibling, row);
                }
                refreshArrows(parent);
                markDirty();
            });
        }
        /* jc-quality-cat-reorder:end */
        jcWireQualityCatAdminReorder(document, jcPageLifecycle, refreshQualityCatAdminArrows, jcMarkConfigDirty);

        // Tracks whether the most recent `renderPagesOrderAdmin` call ran to
        // completion. If false at save time, we skip writing PagesOrder back to
        // config so a render failure can't clobber the saved order.
        var _pagesOrderRenderOK = false;

        // Reorders the admin page-order rows to match the saved PagesOrder CSV.
        // Rows whose page id isn't listed in the CSV are appended LAST, preserving
        // their default DOM order. CSV ids that match no row are naturally ignored.
        function renderPagesOrderAdmin(config) {
            _pagesOrderRenderOK = false;
            try {
                var container = jcById('pagesOrderAdmin');
                if (!container) return;
                var rows = Array.from(container.querySelectorAll('.jc-pages-order-row'));
                var defaultIdx = new Map();
                rows.forEach(function (row, i) { defaultIdx.set(row, i); });
                var order = String(config.PagesOrder || '')
                    .split(',')
                    .map(function (s) { return s.trim(); })
                    .filter(Boolean);
                rows.sort(function (a, b) {
                    var aIdx = order.indexOf(a.dataset.pageId);
                    var bIdx = order.indexOf(b.dataset.pageId);
                    // Missing ids sort after present ones; ties (both present or
                    // both missing) keep default DOM order.
                    if (aIdx === -1) aIdx = Number.MAX_SAFE_INTEGER;
                    if (bIdx === -1) bIdx = Number.MAX_SAFE_INTEGER;
                    if (aIdx !== bIdx) return aIdx - bIdx;
                    return defaultIdx.get(a) - defaultIdx.get(b);
                });
                rows.forEach(function (row) { container.appendChild(row); });
                refreshPagesOrderArrows(container);
                _pagesOrderRenderOK = true;
            } catch (err) {
                console.error('Jellyfin Canopy: renderPagesOrderAdmin failed; will skip PagesOrder save', err);
            }
        }

        // Updates the disabled/opacity styling on the page-order up/down buttons so
        // the top row can't go up and the bottom row can't go down.
        function refreshPagesOrderArrows(container) {
            var rows = container.querySelectorAll('.jc-pages-order-row');
            rows.forEach(function (row, idx) {
                var up = row.querySelector('.jc-page-up');
                var down = row.querySelector('.jc-page-down');
                var first = idx === 0;
                var last = idx === rows.length - 1;
                if (up) {
                    up.disabled = first;
                    up.style.opacity = first ? '0.4' : '1';
                    up.style.cursor = first ? 'not-allowed' : 'pointer';
                }
                if (down) {
                    down.disabled = last;
                    down.style.opacity = last ? '0.4' : '1';
                    down.style.cursor = last ? 'not-allowed' : 'pointer';
                }
            });
        }

        // Wire up/down arrow clicks for the admin page-order list.
        // Delegated on the document via a single global slot so a fresh visit
        // replaces (never stacks on) the previous visit's handler (#167).
        (function () {
            jcPageLifecycle.own('pagesOrderReorder', document, 'click', function (e) {
                var btn = e.target.closest && e.target.closest('#pagesOrderAdmin .jc-page-up, #pagesOrderAdmin .jc-page-down');
                if (!btn || btn.disabled) return;
                e.preventDefault();
                var row = btn.closest('.jc-pages-order-row');
                if (!row) return;
                var parent = row.parentNode;
                if (!parent) return;
                var isUp = btn.classList.contains('jc-page-up');
                var sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
                if (!sibling || !sibling.classList.contains('jc-pages-order-row')) return;
                if (isUp) {
                    parent.insertBefore(row, sibling);
                } else {
                    parent.insertBefore(sibling, row);
                }
                refreshPagesOrderArrows(parent);
                jcMarkConfigDirty();
            });
        })();

        // ── Declarative config field binder ────────────────────────────────────────────
        // Simple checkbox/text/number/select fields carry data-config-key="<PascalCaseProp>"
        // in configPage.html and are loaded/saved by one generic pass instead of a
        // hand-written line per field. Type/fallback semantics:
        //   checkbox            -> load !!v; save .checked
        //   + data-config-default="true"
        //                       -> load (v !== false)  (default-on settings)
        //   text/select         -> load  el.value = v; save el.value
        //   + data-config-fallback="F"
        //                       -> load  el.value = v || F; save el.value || F
        //   + data-config-int   -> save parseInt(el.value, 10)  (|| F when a fallback is set)
        // Fields whose old save site clamped or special-cased the value keep those exact
        // semantics via CONFIG_FIELD_OVERRIDES below. Anything more complex (multi-element
        // enums, validated text, list builders, arr instances) stays hand-written in
        // loadConfig/buildConfigFromForm.
        const CONFIG_FIELD_OVERRIDES = {
            // isNaN/min-max clamps preserved verbatim from the old per-field save sites.
            AutoMovieRequestMinutesWatched: {
                save: function (el) {
                    const minutesValue = parseInt(el.value, 10);
                    return isNaN(minutesValue) || minutesValue < 1 ? 20 : Math.min(minutesValue, 180);
                }
            },
            WatchlistMemoryRetentionDays: {
                save: function (el) {
                    const retentionDays = parseInt(el.value);
                    return isNaN(retentionDays) || retentionDays < 1 ? 365 : Math.min(retentionDays, 3650);
                }
            },
            SeerrScanDebounceSeconds: {
                save: function (el) {
                    const seerrScanDebounce = parseInt(el.value);
                    return isNaN(seerrScanDebounce) || seerrScanDebounce < 5 ? 60 : Math.min(seerrScanDebounce, 3600);
                }
            },
            DownloadsPollIntervalSeconds: {
                // Old load site distinguished null/undefined from 0; keep that.
                load: function (el, v) {
                    el.value = (v !== undefined && v !== null) ? v : 30;
                },
                save: function (el) {
                    const pollInterval = parseInt(el.value, 10);
                    return pollInterval >= 30 ? pollInterval : 30;
                }
            },
            PauseScreenDelaySeconds: {
                save: function (el) {
                    const v = parseInt(el.value, 10);
                    return isNaN(v) || v < 1 ? 5 : Math.min(v, 60);
                }
            },
            SpoilerBlurIntensity: {
                save: function (el) {
                    const v = parseInt(el.value, 10);
                    return isNaN(v) || v < 5 ? 40 : Math.min(v, 100);
                }
            },
        };

        function configBoundFields() {
            return Array.from(jcSelAll('[data-config-key]'));
        }

        /** load: config -> DOM for every [data-config-key] field. */
        function applyConfigToBoundFields(config) {
            configBoundFields().forEach(function (el) {
                const key = el.dataset.configKey;
                const override = CONFIG_FIELD_OVERRIDES[key];
                const v = config[key];
                if (override && override.load) {
                    override.load(el, v);
                } else if (el.type === 'checkbox') {
                    el.checked = el.dataset.configDefault === 'true' ? v !== false : !!v;
                } else if ('configFallback' in el.dataset) {
                    el.value = v || el.dataset.configFallback;
                } else {
                    el.value = v;
                }
            });
        }

        /** save: DOM -> config for every [data-config-key] field. */
        function readBoundFieldsIntoConfig(config) {
            configBoundFields().forEach(function (el) {
                const key = el.dataset.configKey;
                const override = CONFIG_FIELD_OVERRIDES[key];
                if (override && override.save) {
                    config[key] = override.save(el);
                } else if (el.type === 'checkbox') {
                    config[key] = el.checked;
                } else if ('configInt' in el.dataset) {
                    const parsed = parseInt(el.value, 10);
                    config[key] = 'configFallback' in el.dataset
                        ? (parsed || parseInt(el.dataset.configFallback, 10))
                        : parsed;
                } else if ('configFallback' in el.dataset) {
                    config[key] = el.value || el.dataset.configFallback;
                } else {
                    config[key] = el.value;
                }
            });
        }

        function loadConfig() {
            Dashboard.showLoadingMsg();
            checkInstalledPlugins();
            ApiClient.getPluginConfiguration(pluginId).then((config) => {
                // Lifecycle guard (#167): this fetch may have been started by a
                // visit the admin has since left. If a later dashboard visit
                // already tore down this owner, running the continuation would
                // overwrite the CURRENT visit's controls, rebuild its instance
                // rows, re-wire element listeners onto its DOM and hide its
                // loading indicator. Bail before touching anything — the live
                // visit owns its own load.
                if (!jcPageLifecycle.active) return;
                const savedShortcuts = (config.Shortcuts && config.Shortcuts.length > 0) ? config.Shortcuts : defaultShortcuts;
                shortcutOverrides = savedShortcuts.filter(saved => {
                    const def = defaultShortcuts.find(d => d.Name === saved.Name);
                    return !def || saved.Key !== def.Key;
                });

                renderOverrides();
                populateAddShortcutDropdown();

                // Simple fields: one generic, type-aware pass over every
                // [data-config-key] element (see applyConfigToBoundFields above).
                // Complex editors and multi-element settings stay hand-written below.
                applyConfigToBoundFields(config);

                // Restore action checkboxes
                const savedAction = config.MaintenanceModeAction || 'disable_accounts';
                jcById('mmAction_accounts').checked = savedAction === 'disable_accounts' || savedAction === 'both';
                jcById('mmAction_remote').checked   = savedAction === 'disable_remote'   || savedAction === 'both';
                // Restore user selection radio + checkboxes
                const savedUsers = config.MaintenanceModeAffectedUsers || 'all';
                if (savedUsers === 'all') {
                    jcSel('#mmUsers_all').checked = true;
                    jcById('jc-mm-user-list').style.display = 'none';
                } else {
                    jcSel('#mmUsers_select').checked = true;
                    jcById('jc-mm-user-list').style.display = '';
                    // Preselected IDs will be applied after the user list loads
                    jcById('jc-mm-user-list').dataset.preselect = savedUsers;
                }
                loadMaintenanceUsers();

                // One config value behind two synced inputs (Elsewhere + Seerr tabs).
                // Initial value only; the bidirectional input listeners are
                // installed ONCE per page owner in jcWireStaticControlListeners
                // (#167 finding 3) — attaching them here re-ran on every
                // pageshow-driven loadConfig and leaked an untracked pair per visit.
                jcSel('#TMDB_API_KEY').value = config.TMDB_API_KEY;
                jcSel('#seerr_TMDB_API_KEY').value = config.TMDB_API_KEY;

                // Restore stack order: rows are visually reordered to match
                // current saved order values (ties broken by default order).
                if (typeof renderQualityCatOrderAdmin === 'function') renderQualityCatOrderAdmin(config);
                if (typeof renderPagesOrderAdmin === 'function') renderPagesOrderAdmin(config);

                // Not bound: the save side is conditional on TagCacheServerMode.
                jcSel('#enableTagsLocalStorageFallback').checked = config.EnableTagsLocalStorageFallback === true;

                // Not bound: these fields are validated/normalized by hand on save.
                jcSel('#seerrUrls').value = config.SeerrUrls;
                jcSel('#seerrExternalUrl').value = config.SeerrExternalUrl || '';
                jcSel('#SeerrApiKey').value = config.SeerrApiKey;
                jcSel('#seerrUrlMappings').value = config.SeerrUrlMappings || '';

                // One enum expanded into two trigger checkboxes.
                const triggerType = config.AutoMovieRequestTriggerType || 'OnMinutesWatched';
                jcSel('#autoMovieRequestTriggerOnStart').checked = (triggerType === 'OnStart' || triggerType === 'Both');
                jcSel('#autoMovieRequestTriggerOnMinutesWatched').checked = (triggerType === 'OnMinutesWatched' || triggerType === 'Both');
                if ((config.AutoMovieRequestQualityMode || 'default') === 'custom') {
                    jcSel('#autoMovieRequestCustomSettings').style.display = 'block';
                    loadAutoMovieRadarrServers(config);
                }

                // Not bound: hidden input kept in sync by the blocked-users list builder.
                jcSel('#seerrImportBlockedUsers').value = config.SeerrImportBlockedUsers || '';
                loadBlockedUsersList(config.SeerrImportBlockedUsers || '');

                // Load multi-instance Sonarr/Radarr
                loadArrInstances(config);

                // Tie icon display settings
                if (config.MetadataIconsEnabled) {
                    // Force icon display where applicable
                    const showLbText = jcSel('#showLetterboxdLinkAsText');
                    const showArrText = jcSel('#showArrLinksAsText');
                    if (showLbText) showLbText.checked = false;
                    if (showArrText) showArrText.checked = false;
                }

                // Initial visibility only; the `change` listeners for these two
                // static controls are installed ONCE per page owner in
                // jcWireStaticControlListeners (#167 finding 3). Attaching them
                // here re-ran on every pageshow-driven loadConfig and stacked an
                // untracked handler per dashboard visit.
                jcById('activeStreamsAllUsersContainer').style.display = config.ActiveStreamsEnabled ? '' : 'none';
                const preventionEnabled = jcSel('#preventWatchlistReAddition').checked;
                const retentionContainer = jcSel('#watchlistMemoryRetentionDays').closest('.inputContainer');
                if (retentionContainer) {
                    retentionContainer.style.display = preventionEnabled ? 'block' : 'none';
                }

                // Update TMDB-dependent settings after config is loaded
                updateAllDependencies();

                // Refresh the Requests Page requirements banner off freshly-
                // rendered instance cards and loaded Seerr fields.
                updateRequestsRequirementsBanner();

                Dashboard.hideLoadingMsg();
            });
        }

        async function buildConfigFromForm() {
            const config = await ApiClient.getPluginConfiguration(pluginId);
            const finalShortcuts = [...defaultShortcuts];
            shortcutOverrides.forEach(override => {
                const index = finalShortcuts.findIndex(s => s.Name === override.Name);
                if (index !== -1) finalShortcuts[index] = override;
            });
            config.Shortcuts = finalShortcuts;

            // Simple fields: one generic, type-aware pass over every
            // [data-config-key] element (see readBoundFieldsIntoConfig above).
            // Everything below preserves the hand-written semantics that do not fit
            // the binder: enums spanning several inputs, validated/normalized text,
            // conditional values and the complex editors.
            readBoundFieldsIntoConfig(config);

            const mmAccounts = jcById('mmAction_accounts').checked;
            const mmRemote   = jcById('mmAction_remote').checked;
            config.MaintenanceModeAction = (mmAccounts && mmRemote) ? 'both'
                                         : mmRemote                 ? 'disable_remote'
                                         :                            'disable_accounts';
            const mmUsersMode = (jcSel('input[name="maintenanceModeUsers"]:checked') || {}).value || 'all';
            if (mmUsersMode === 'all') {
                config.MaintenanceModeAffectedUsers = 'all';
            } else {
                const checked = Array.from(jcSelAll('.jc-mm-user-cb:checked')).map(cb => cb.value);
                config.MaintenanceModeAffectedUsers = JSON.stringify(checked);
            }

            // Persist current visual stack order. Each admin row reads its current
            // DOM position (1-based) into the corresponding *Order config key.
            // Skipped if the load-time render failed — otherwise we'd clobber the
            // user's saved order with default DOM positions.
            if (_qualityCatRenderOK) {
                const adminCatRows = jcSelAll('#qualityCategoriesAdmin .jc-quality-cat-admin-row');
                adminCatRows.forEach((row, idx) => {
                    const orderKey = row.dataset.orderKey;
                    if (orderKey) config[orderKey] = idx + 1;
                });
            }

            // Persist page order from the reorder control (validated: only the known page
            // ids, in current DOM order). Skipped if the load-time render failed.
            if (_pagesOrderRenderOK) {
                var pageOrderRows = jcSelAll('#pagesOrderAdmin .jc-pages-order-row');
                config.PagesOrder = Array.from(pageOrderRows).map(function (r) { return r.dataset.pageId; }).filter(Boolean).join(',');
            }

            config.EnableTagsLocalStorageFallback = config.TagCacheServerMode
                ? jcSel('#enableTagsLocalStorageFallback').checked
                : true;

            // validate scheme on save. Lines that don't parse as
            // http(s) are dropped with a warning so we never persist garbage
            // like "seerr.local" (no scheme) — which downstream string-concats
            // produce malformed URIs and a confusing UriFormatException buried
            // in logs. Empty textarea remains valid (Seerr can be disabled).
            (function () {
                const raw = (jcSel('#seerrUrls').value || '').split('\n').map(u => u.trim()).filter(Boolean);
                const valid = [];
                const invalid = [];
                for (const line of raw) {
                    try {
                        const u = new URL(line);
                        if (u.protocol === 'http:' || u.protocol === 'https:') {
                            valid.push(line);
                        } else {
                            invalid.push(line);
                        }
                    } catch (_) {
                        invalid.push(line);
                    }
                }
                if (invalid.length > 0) {
                    console.warn('Jellyfin Canopy: dropping invalid Seerr URL(s) on save (must start with http:// or https://):', invalid);
                    if (typeof Dashboard !== 'undefined' && Dashboard.alert) {
                        Dashboard.alert({
                            title: 'Invalid Seerr URL(s)',
                            message: 'These lines were dropped because they do not start with http:// or https://:\n\n' + invalid.join('\n')
                        });
                    }
                }
                config.SeerrUrls = valid.join('\n');
            })();
            // Optional Seerr External URL: kept only when a well-formed http(s) URL; blanked with a
            // clear warning otherwise so it never reaches browser link building. Empty = the client
            // falls back to the first internal URL above (unchanged behaviour).
            (function () {
                var raw = (jcSel('#seerrExternalUrl').value || '').trim();
                if (raw && !jcIsHttpUrl(raw)) {
                    console.warn('Jellyfin Canopy: dropping invalid Seerr External URL on save (must be an http(s) URL without credentials or query/fragment):', raw);
                    if (typeof Dashboard !== 'undefined' && Dashboard.alert) {
                        Dashboard.alert({
                            title: 'Invalid Seerr External URL',
                            message: 'The Seerr External URL was dropped: it must be an http:// or https:// URL without embedded credentials, query string or fragment.\n\n' + raw
                        });
                    }
                    config.SeerrExternalUrl = '';
                } else {
                    config.SeerrExternalUrl = raw;
                }
            })();
            config.SeerrApiKey = (jcSel('#SeerrApiKey').value || '').replace(/\s/g, '');
            config.SeerrUrlMappings = (jcSel('#seerrUrlMappings').value || '').split('\n').map(u => u.trim()).filter(Boolean).join('\n');
            // Bazarr External URL rides the generic data-config-key binder, so validate it here after
            // the bound fields are read: blank a malformed value with a clear warning.
            (function () {
                var raw = (config.BazarrExternalUrl || '').trim();
                if (raw && !jcIsHttpUrl(raw)) {
                    console.warn('Jellyfin Canopy: dropping invalid Bazarr External URL on save (must be an http(s) URL without credentials or query/fragment):', raw);
                    if (typeof Dashboard !== 'undefined' && Dashboard.alert) {
                        Dashboard.alert({
                            title: 'Invalid Bazarr External URL',
                            message: 'The Bazarr External URL was dropped: it must be an http:// or https:// URL without embedded credentials, query string or fragment.\n\n' + raw
                        });
                    }
                    config.BazarrExternalUrl = '';
                } else {
                    config.BazarrExternalUrl = raw;
                }
            })();
            // Two synced inputs, one config value; the Seerr-tab field wins (as before).
            config.TMDB_API_KEY = jcSel('#seerr_TMDB_API_KEY').value;

            const onStart = jcSel('#autoMovieRequestTriggerOnStart').checked;
            const onMinutes = jcSel('#autoMovieRequestTriggerOnMinutesWatched').checked;
            if (onStart && onMinutes) {
                config.AutoMovieRequestTriggerType = 'Both';
            } else if (onStart) {
                config.AutoMovieRequestTriggerType = 'OnStart';
            } else if (onMinutes) {
                config.AutoMovieRequestTriggerType = 'OnMinutesWatched';
            } else {
                config.AutoMovieRequestTriggerType = 'OnMinutesWatched'; // Default to minutes watched if nothing selected
            }
            var serverVal = parseInt(jcSel('#autoMovieRequestServer').value);
            config.AutoMovieRequestCustomServerId = (!isNaN(serverVal) && serverVal >= 0) ? serverVal : -1;
            var profileVal = parseInt(jcSel('#autoMovieRequestProfile').value);
            config.AutoMovieRequestCustomProfileId = (!isNaN(profileVal) && profileVal > 0) ? profileVal : 0;
            config.AutoMovieRequestCustomRootFolder = jcSel('#autoMovieRequestRootFolder').value || '';

            syncBlockedUsersToHiddenInput();
            config.SeerrImportBlockedUsers = jcSel('#seerrImportBlockedUsers').value || '';

            // Save multi-instance Sonarr/Radarr
            var arrIncompleteWarnings = saveArrInstances(config);
            if (arrIncompleteWarnings.length > 0) {
                // Surface each incomplete-card warning to the admin before the save completes.
                arrIncompleteWarnings.forEach(function(msg) {
                    Dashboard.alert({ title: '⚠ Incomplete *arr instance', message: msg });
                });
            }

            // If metadata icons are enabled, ensure icons are shown for Letterboxd and *arr links
            if (config.MetadataIconsEnabled) {
                config.ShowLetterboxdLinkAsText = false;
                config.ShowArrLinksAsText = false;
            }


            return config;
        }

        // Re-entrancy guard. `Dashboard.showLoadingMsg()` provides only a visual
        // overlay, not an input block, so two rapid Enter presses or a second
        // click on the save dock can still fire saveConfig in parallel — the
        // second one's `buildConfigFromForm` reads a server state that the
        // first one has already mutated, and Save#1's deferred owned-flag write
        // (step 2) can land after Save#2 and silently revert the admin's
        // between-save form changes. Treat saves as serial.
        var _jeSaveInFlight = false;

        async function saveConfig(e) {
            e.preventDefault();
            if (_jeSaveInFlight) return false;
            _jeSaveInFlight = true;
            Dashboard.showLoadingMsg();
            var saveBtns = jcSelAll('.jc-save-dock-btn');
            saveBtns.forEach(function(b) { b.disabled = true; });

            try {
                const config = await buildConfigFromForm();
                // Everything mutated up to this snapshot is in `config`.
                const dirtyRevisionAtSnapshot = jcDirtyRevisionNow();
                const result = await ApiClient.updatePluginConfiguration(pluginId, config);

                // Apply maintenance mode: enable/disable users to match the toggle
                try {
                    if (config.MaintenanceModeEnabled) {
                        const affectedIds = config.MaintenanceModeAffectedUsers === 'all'
                            ? []
                            : JSON.parse(config.MaintenanceModeAffectedUsers || '[]');
                        await ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('/JellyfinCanopy/MaintenanceMode/Enable'),
                            contentType: 'application/json',
                            data: JSON.stringify({
                                message: config.MaintenanceModeMessage || '',
                                durationMinutes: 0,
                                action: config.MaintenanceModeAction || 'disable_accounts',
                                affectedUserIds: affectedIds
                            })
                        });
                        // Broadcast a native Jellyfin message to all active sessions
                        // (reaches non-web clients like TV apps too — works regardless of Active Streams setting)
                        const mmMsg = (config.MaintenanceModeNotificationMessage || '').trim()
                            || (config.MaintenanceModeMessage || '').trim()
                            || 'Server maintenance is starting. Please finish up and try again later.';
                        try {
                            await ApiClient.ajax({
                                type: 'POST',
                                url: ApiClient.getUrl('/JellyfinCanopy/MaintenanceMode/Broadcast'),
                                contentType: 'application/json',
                                data: JSON.stringify({
                                    header: 'Server Maintenance',
                                    text: mmMsg,
                                    timeoutMs: 30000
                                })
                            });
                        } catch (bcErr) {
                            console.warn('[JC] Maintenance broadcast failed (no active sessions?):', bcErr);
                        }
                    } else {
                        await ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('/JellyfinCanopy/MaintenanceMode/Disable')
                        });
                    }
                } catch (mmErr) {
                    console.warn('[JC] Maintenance mode apply failed:', mmErr);
                }

                Dashboard.processPluginConfigurationUpdateResult(result);
                // Clean only if nothing was edited while the save was in flight.
                jcClearDirtyIfUnchanged(dirtyRevisionAtSnapshot);
            } catch (saveErr) {
                Dashboard.hideLoadingMsg();
                console.error('[JC] saveConfig failed:', saveErr);
                try {
                    Dashboard.alert({
                        title: 'Save failed',
                        message: 'Could not save Jellyfin Canopy settings. Check the browser console and server logs, then try again.'
                    });
                } catch (alertErr) { console.warn('[JC] Dashboard.alert threw:', alertErr); }
            } finally {
                _jeSaveInFlight = false;
                saveBtns.forEach(function(b) { b.disabled = false; });
            }
            return false;
        }

        // Saves current config and applies it to all users
        async function resetAllUserSettings() {
            if (confirm("Are you sure?\n\nThis will save the current configuration and overwrite every per-user default for ALL users on this server.")) {
                Dashboard.showLoadingMsg();
                try {
                    // First, save the current configuration
                    const config = await buildConfigFromForm();
                    await ApiClient.updatePluginConfiguration(pluginId, config);

                    // Then reset all user settings to match the saved config
                    await ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl('/JellyfinCanopy/reset-all-users-settings'),
                        dataType: 'json'
                    });

                    Dashboard.hideLoadingMsg();
                    let msg = 'Configuration saved and applied to all users successfully!\n\nSettings will take effect after users refresh their browsers.';
                    Dashboard.alert({ title: 'Success', message: msg });
                } catch (e) {
                    Dashboard.hideLoadingMsg();
                    console.error('Failed to save and apply settings:', e);
                    Dashboard.alert({
                        title: 'Error',
                        message: 'Failed to save and apply settings to all users. Check server logs for details.'
                    });
                }
            }
        }

        // ── Maintenance mode: user checklist ─────────────────────────────────────

        function loadMaintenanceUsers() {
            ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinCanopy/MaintenanceMode/Users'),
                dataType: 'json'
            }).then(function(users) {
                const inner = jcById('jc-mm-users-inner');
                if (!inner) return;
                inner.innerHTML = '';

                if (!users || users.length === 0) {
                    const msg = document.createElement('div');
                    msg.style.cssText = 'opacity:0.55;font-size:0.875em;';
                    msg.textContent = 'No non-admin users found.';
                    inner.appendChild(msg);
                    return;
                }

                // Collect any pre-selected IDs stored on the container by loadConfig
                const listEl = jcById('jc-mm-user-list');
                let preselect = [];
                try { preselect = JSON.parse(listEl.dataset.preselect || '[]'); } catch (e) {}
                const preselectAll = preselect.length === 0;

                // 3-column grid
                const grid = document.createElement('div');
                grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:0.2em 0.75em;';

                users.forEach(function(u) {
                    // Handle both camelCase and PascalCase from the API
                    const uid  = u.id  || u.Id  || '';
                    const uname = u.username || u.Username || uid;

                    const checked = preselectAll || preselect.indexOf(uid) !== -1;

                    const label = document.createElement('label');
                    label.style.cssText = 'display:flex;align-items:center;gap:0.45em;padding:0.3em 0.2em;cursor:pointer;border-radius:4px;min-width:0;';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.className = 'jc-mm-user-cb';
                    cb.value = uid;
                    cb.checked = checked;
                    cb.style.flexShrink = '0';

                    const avatar = document.createElement('span');
                    avatar.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;' +
                        'width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,0.15);' +
                        'font-size:0.7em;font-weight:700;flex-shrink:0;overflow:hidden;';
                    // Try to load the user's actual Jellyfin profile picture
                    const img = document.createElement('img');
                    img.style.cssText = 'width:26px;height:26px;border-radius:50%;object-fit:cover;display:block;';
                    img.src = ApiClient.getUrl('/Users/' + uid + '/Images/Primary', { width: 26 });
                    img.alt = '';
                    const fallbackLetter = document.createTextNode((uname || '?').charAt(0).toUpperCase());
                    img.onerror = function() {
                        this.style.display = 'none';
                        avatar.appendChild(fallbackLetter);
                    };
                    avatar.appendChild(img);

                    const name = document.createElement('span');
                    name.style.cssText = 'font-size:0.875em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    name.textContent = uname;

                    label.appendChild(cb);
                    label.appendChild(avatar);
                    label.appendChild(name);
                    grid.appendChild(label);
                });

                inner.appendChild(grid);
            }).catch(function() {
                const inner = jcById('jc-mm-users-inner');
                if (!inner) return;
                inner.innerHTML = '';
                const msg = document.createElement('div');
                msg.style.cssText = 'opacity:0.55;font-size:0.875em;';
                msg.textContent = 'Failed to load users.';
                inner.appendChild(msg);
            });
        }

        function setupMaintenanceModeControls() {
            // Show/hide user checklist based on radio selection
            jcSelAll('input[name="maintenanceModeUsers"]').forEach(function(radio) {
                jcPageLifecycle.addListener(radio, 'change', function() {
                    const listEl = jcById('jc-mm-user-list');
                    if (this.value === 'select') {
                        listEl.style.display = '';
                        loadMaintenanceUsers();
                    } else {
                        listEl.style.display = 'none';
                    }
                });
            });

            // Select All / Deselect All buttons
            jcPageLifecycle.addListener(jcById('jc-mm-select-all'), 'click', function() {
                jcSelAll('.jc-mm-user-cb').forEach(function(cb) { cb.checked = true; });
            });
            jcPageLifecycle.addListener(jcById('jc-mm-deselect-all'), 'click', function() {
                jcSelAll('.jc-mm-user-cb').forEach(function(cb) { cb.checked = false; });
            });
        }

        // Setup branding file uploads and previews
        function setupBrandingUploads() {
            const uploadConfigs = [
                { inputId: 'iconTransparentInput', dropZoneId: 'iconTransparentDropZone', statusId: 'iconTransparentStatus', fileName: 'icon-transparent.png', previewId: 'iconTransparentPreview', placeholderId: 'iconTransparentPlaceholder', deleteId: 'iconTransparentDelete', dimensionsId: 'iconTransparentDimensions' },
                { inputId: 'faviconInput', dropZoneId: 'faviconDropZone', statusId: 'faviconStatus', fileName: 'favicon.ico', previewId: 'faviconPreview', placeholderId: 'faviconPlaceholder', deleteId: 'faviconDelete', dimensionsId: 'faviconDimensions' },
                { inputId: 'bannerLightInput', dropZoneId: 'bannerLightDropZone', statusId: 'bannerLightStatus', fileName: 'banner-light.png', previewId: 'bannerLightPreview', placeholderId: 'bannerLightPlaceholder', deleteId: 'bannerLightDelete', dimensionsId: 'bannerLightDimensions' },
                { inputId: 'bannerDarkInput', dropZoneId: 'bannerDarkDropZone', statusId: 'bannerDarkStatus', fileName: 'banner-dark.png', previewId: 'bannerDarkPreview', placeholderId: 'bannerDarkPlaceholder', deleteId: 'bannerDarkDelete', dimensionsId: 'bannerDarkDimensions' },
                { inputId: 'touchiconInput', dropZoneId: 'touchiconDropZone', statusId: 'touchiconStatus', fileName: 'apple-touch-icon.png', previewId: 'touchiconPreview', placeholderId: 'touchiconPlaceholder', deleteId: 'touchiconDelete', dimensionsId: 'touchiconDimensions' }
            ];

            uploadConfigs.forEach(config => {
                const input = jcById(config.inputId);
                const dropZone = jcById(config.dropZoneId);
                const statusDiv = jcById(config.statusId);
                const deleteButton = jcById(config.deleteId);

                if (!input || !dropZone || !statusDiv) return;

                // Handle file selection
                jcPageLifecycle.addListener(input, 'change', (e) => {
                    if (e.target.files.length > 0) {
                        uploadBrandingImage(e.target.files[0], config, statusDiv);
                    }
                });

                // Drag and drop
                jcPageLifecycle.addListener(dropZone, 'dragover', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'var(--primary-accent-color, #00a4dc)';
                    dropZone.style.backgroundColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 10%, transparent)';
                });

                jcPageLifecycle.addListener(dropZone, 'dragleave', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 50%, transparent)';
                    dropZone.style.backgroundColor = 'rgba(255,255,255,0.05)';
                });

                jcPageLifecycle.addListener(dropZone, 'drop', (e) => {
                    e.preventDefault();
                    dropZone.style.borderColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 50%, transparent)';
                    dropZone.style.backgroundColor = 'rgba(255,255,255,0.05)';
                    if (e.dataTransfer.files.length > 0) {
                        uploadBrandingImage(e.dataTransfer.files[0], config, statusDiv);
                    }
                });

                if (deleteButton) {
                    jcPageLifecycle.addListener(deleteButton, 'click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        deleteBrandingImage(config, statusDiv);
                    });
                }

                // Load existing preview if present
                refreshBrandingPreview(config);
            });
        }

        async function uploadBrandingImage(file, config, statusDiv) {
            // Validate that it's an image file
            if (!file.type || !file.type.startsWith('image/')) {
                statusDiv.textContent = '✗ Only image files allowed';
                statusDiv.style.color = '#ff6b6b';
                return;
            }

            const maxFileSize = 10 * 1024 * 1024; // 10MB
            if (file.size > maxFileSize) {
                statusDiv.textContent = `✗ File too large (max ${maxFileSize / (1024 * 1024)}MB)`;
                statusDiv.style.color = '#ff6b6b';
                return;
            }

            // Show image preview and dimensions
            const previewImg = jcById(config.previewId);
            const dimensionsDiv = jcById(config.dimensionsId);
            const placeholder = jcById(config.placeholderId);

            if (previewImg) {
                const objectUrl = URL.createObjectURL(file);
                previewImg.src = objectUrl;
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';

                // Get image dimensions
                previewImg.onload = function() {
                    const img = new Image();
                    img.onload = function() {
                        if (dimensionsDiv) {
                            dimensionsDiv.textContent = `${img.width} × ${img.height}px`;
                            dimensionsDiv.style.display = 'block';
                        }
                        URL.revokeObjectURL(objectUrl);
                    };
                    img.src = objectUrl;
                };
            }

            statusDiv.textContent = 'Uploading...';
            statusDiv.style.color = '#ffa500';

            try {
                const formData = new FormData();
                const renamedFile = new File([file], config.fileName, { type: file.type });
                formData.append('file', renamedFile);
                formData.append('fileName', config.fileName);

                const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
                const response = await fetch(ApiClient.getUrl('/JellyfinCanopy/UploadBrandingImage'), {
                    method: 'POST',
                    body: formData,
                    headers: {
                        // Jellyfin 12 authenticates from the Authorization header; the
                        // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                        'Authorization': 'MediaBrowser Token="' + token + '"',
                        'X-MediaBrowser-Token': token
                    }
                });

                if (response.ok) {
                    statusDiv.textContent = '✓ Uploaded';
                    statusDiv.style.color = '#51cf66';
                    await refreshBrandingPreview(config);
                    setTimeout(() => { statusDiv.textContent = ''; }, 3000);
                } else {
                    const error = await response.text();
                    statusDiv.textContent = `✗ ${error || 'Upload failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (error) {
                console.error('Upload exception:', error);
                statusDiv.textContent = `✗ ${error.message || 'Upload error'}`;
                statusDiv.style.color = '#ff6b6b';
            }
        }

        async function refreshBrandingPreview(config) {
            const previewImg = jcById(config.previewId);
            const placeholder = jcById(config.placeholderId);
            const deleteButton = jcById(config.deleteId);
            const dimensionsDiv = jcById(config.dimensionsId);
            if (!previewImg) return;

            const token = ApiClient.accessToken ? ApiClient.accessToken() : '';
            try {
                const response = await fetch(ApiClient.getUrl('/JellyfinCanopy/BrandingImage', { fileName: config.fileName, t: Date.now() }), {
                    // Jellyfin 12 authenticates from the Authorization header; the
                    // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });

                if (!response.ok) {
                    previewImg.style.display = 'none';
                    if (placeholder) placeholder.style.display = 'block';
                    if (deleteButton) deleteButton.style.display = 'none';
                    if (dimensionsDiv) dimensionsDiv.style.display = 'none';
                    return;
                }

                const blob = await response.blob();
                const objectUrl = URL.createObjectURL(blob);
                previewImg.src = objectUrl;
                previewImg.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
                if (deleteButton) deleteButton.style.display = 'inline-block';

                // Show dimensions for existing images
                if (dimensionsDiv) {
                    previewImg.onload = function() {
                        dimensionsDiv.textContent = previewImg.naturalWidth + ' × ' + previewImg.naturalHeight + 'px';
                        dimensionsDiv.style.display = 'block';
                    };
                }
            } catch (err) {
                previewImg.style.display = 'none';
                if (placeholder) placeholder.style.display = 'block';
                if (deleteButton) deleteButton.style.display = 'none';
                if (dimensionsDiv) dimensionsDiv.style.display = 'none';
            }
        }

        async function deleteBrandingImage(config, statusDiv) {
            statusDiv.textContent = 'Deleting...';
            statusDiv.style.color = '#ffa500';

            const formData = new FormData();
            formData.append('fileName', config.fileName);
            const token = ApiClient.accessToken ? ApiClient.accessToken() : '';

            try {
                const response = await fetch(ApiClient.getUrl('/JellyfinCanopy/DeleteBrandingImage'), {
                    method: 'POST',
                    body: formData,
                    // Jellyfin 12 authenticates from the Authorization header; the
                    // legacy X-MediaBrowser-Token is kept for 10.11 back-compat.
                    headers: { 'Authorization': 'MediaBrowser Token="' + token + '"', 'X-MediaBrowser-Token': token }
                });

                if (response.ok) {
                    statusDiv.textContent = '✓ Deleted';
                    statusDiv.style.color = '#51cf66';

                    // Hide dimensions when image is deleted
                    const dimensionsDiv = jcById(config.dimensionsId);
                    if (dimensionsDiv) dimensionsDiv.style.display = 'none';

                    await refreshBrandingPreview(config);
                    setTimeout(() => { statusDiv.textContent = ''; }, 2000);
                } else {
                    const error = await response.text();
                    statusDiv.textContent = `✗ ${error || 'Delete failed'}`;
                    statusDiv.style.color = '#ff6b6b';
                }
            } catch (err) {
                statusDiv.textContent = `✗ ${err.message || 'Delete error'}`;
                statusDiv.style.color = '#ff6b6b';
            }
        }

        setupBrandingUploads();
        setupMaintenanceModeControls();

        // Populate language options dynamically
        (async () => {
            const defaultLanguageSelect = jcById('DefaultLanguage');
            if (!defaultLanguageSelect) return;

            const CUSTOM_DISPLAY_NAMES = {
                'pr': 'Pirate',
                'en-GB': 'English (United Kingdom)',
                'en-US': 'English (United States)',
                'zh-CN': 'Chinese (Simplified)',
                'zh-HK': 'Chinese (Hong Kong)',
                'pt-BR': 'Portuguese (Brazil)'
            };

            try {
                const [localeCodes, cultures] = await Promise.all([
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinCanopy/locales'), dataType: 'json' }),
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' })
                ]);

                // The server's /locales endpoint is authoritative: locale files ship
                // embedded in the plugin DLL, so no external listing is consulted.

                const cultureMap = {};
                cultures.forEach(c => {
                    cultureMap[c.TwoLetterISOLanguageName.toLowerCase()] = c;
                });

                // The endpoint exposes the complete canonical inventory. Generic
                // English is the fallback catalog, while the two regional English
                // variants remain the selectable UI choices.
                const selectableLocaleCodes = localeCodes.filter(code => code !== 'en');
                const localeSet = new Set(selectableLocaleCodes.map(c => c.toLowerCase()));
                const options = selectableLocaleCodes.map(code => {
                    let displayName = CUSTOM_DISPLAY_NAMES[code]
                        || cultureMap[code.toLowerCase()]?.DisplayName;
                    if (!displayName && code.includes('-')) {
                        const baseName = cultureMap[code.split('-')[0].toLowerCase()]?.DisplayName;
                        displayName = baseName && localeSet.has(code.split('-')[0].toLowerCase())
                            ? `${baseName} (${code.split('-')[1]})`
                            : baseName;
                    }
                    return { code, displayName: displayName || code };
                });

                options.sort((a, b) => a.displayName.localeCompare(b.displayName));
                options.forEach(({ code, displayName }) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = displayName;
                    defaultLanguageSelect.appendChild(option);
                });
            } catch (err) {
                console.warn('Jellyfin Canopy: Failed to load language options:', err);
            }
        })();

        // Page-lifecycle owned (#167 finding 1): pageshow drives loadConfig and
        // submit drives saveConfig. These live on the long-lived page/form, so a
        // teardown→same-page reinstall (jcAcquireConfigPageLifecycle supports
        // reacquiring the same element) would otherwise STACK them — one pageshow
        // then starts two load paths and one submit fires two saveConfig handlers
        // (double configuration writes). Tracking them means teardown removes the
        // prior visit's copies before the fresh set installs, so at most one is
        // ever live (AC5).
        jcPageLifecycle.addListener(page, 'pageshow', loadConfig);
        jcPageLifecycle.addListener(form, 'submit', saveConfig);
        // Page-lifecycle owned (#167 finding 1): this static Overview button
        // lives on the long-lived page, so a teardown→same-page reinstall would
        // otherwise STACK the handler — one click then opens two confirmations
        // and performs two configuration writes + two reset-all-users POSTs.
        jcPageLifecycle.addListener(resetAllUserSettingsBtn, 'click', resetAllUserSettings);

        /* jc-static-control-listeners:start */
        // Static form-control listeners (#167 finding 3). These used to be
        // attached with raw addEventListener INSIDE loadConfig, which the
        // dashboard re-runs on every `pageshow` — so each visit stacked another
        // TMDB-sync input pair plus activeStreams/preventWatchlist change handler,
        // none tracked by the page owner and none reclaimable on teardown. They
        // wire STATIC controls and depend only on live DOM state (not on config),
        // so install them exactly ONCE per page owner here, routed through the
        // owner so a fresh visit's teardown reclaims the prior copy (AC5).
        // loadConfig keeps only the config-driven INITIAL value/visibility.
        function jcWireStaticControlListeners(doc, lifecycle) {
            // `doc` is the resolved own view (or document). Use [id="…"] rather
            // than #id so a stale duplicate view earlier in the document can
            // never be matched instead of THIS view's control (#167 findings 5/9).
            var tmdbKeyField = doc.querySelector('[id="TMDB_API_KEY"]');
            var seerrTmdbKeyField = doc.querySelector('[id="seerr_TMDB_API_KEY"]');
            if (tmdbKeyField && seerrTmdbKeyField) {
                lifecycle.addListener(tmdbKeyField, 'input', function() {
                    seerrTmdbKeyField.value = tmdbKeyField.value;
                });
                lifecycle.addListener(seerrTmdbKeyField, 'input', function() {
                    tmdbKeyField.value = seerrTmdbKeyField.value;
                });
            }
            var activeStreamsEnabled = doc.querySelector('[id="activeStreamsEnabled"]');
            if (activeStreamsEnabled) {
                lifecycle.addListener(activeStreamsEnabled, 'change', function() {
                    var container = doc.querySelector('[id="activeStreamsAllUsersContainer"]');
                    if (container) container.style.display = activeStreamsEnabled.checked ? '' : 'none';
                });
            }
            var preventWatchlist = doc.querySelector('[id="preventWatchlistReAddition"]');
            if (preventWatchlist) {
                lifecycle.addListener(preventWatchlist, 'change', function() {
                    var retentionInput = doc.querySelector('[id="watchlistMemoryRetentionDays"]');
                    var container = retentionInput && retentionInput.closest('.inputContainer');
                    if (container) container.style.display = preventWatchlist.checked ? 'block' : 'none';
                });
            }
        }
        /* jc-static-control-listeners:end */
        jcWireStaticControlListeners(page || document, jcPageLifecycle);

        initAutoMovieQualityMode();

        // Live-update the Requests Page requirements banner AND the dependency
        // gates as the admin types into Seerr fields or adds/edits/removes/
        // toggles *arr instances. Without this, the *arr UI Links / Tags Sync
        // gate banners would stay up until the next form save + reload even
        // though hasAnyArrService() is already true.
        (function wireRequestsBannerReactive() {
            var formEl = jcById('JellyfinCanopyForm');
            if (!formEl) {
                console.error('[JC] #JellyfinCanopyForm missing — reactive dep updates disabled');
                return;
            }
            function relevant(target) {
                if (!target) return false;
                if (target.id === 'seerrUrls' || target.id === 'SeerrApiKey') return true;
                if (!target.classList) return false;
                return target.classList.contains('arr-instance-url')
                    || target.classList.contains('arr-instance-apikey')
                    || target.classList.contains('arr-instance-enabled');
            }
            function refresh() {
                try {
                    updateRequestsRequirementsBanner();
                    debouncedUpdateDeps();
                } catch (err) {
                    // Observer + listener callbacks must never throw — a throw
                    // here would leave gate banners frozen in their last state
                    // and keep firing on every subsequent mutation.
                    console.error('[JC] dep refresh failed', err);
                }
            }
            // `input` covers all relevant cases: per-keystroke for text/api-key
            // fields, and bubbled-from-checkbox for `.arr-instance-enabled`
            // clicks/keyboard toggles. We deliberately skip a parallel `change`
            // listener — native checkboxes fire BOTH events per toggle, which
            // would double-fire refresh() (debouncedUpdateDeps collapses it,
            // but the synchronous updateRequestsRequirementsBanner pass would
            // run twice).
            jcPageLifecycle.addListener(formEl, 'input', function(e) {
                if (relevant(e.target)) refresh();
            });
            // Instance add/remove happens via button clicks that mutate
            // #sonarrInstancesList / #radarrInstancesList. Observe both so the
            // banner updates immediately on remove (no input event fires).
            ['sonarrInstancesList', 'radarrInstancesList'].forEach(function(id) {
                var root = jcById(id);
                if (!root) return;
                // Single-slot observer (#167): a fresh visit disconnects the
                // previous visit's observer for this list before connecting its
                // own, so at most one observer is ever live per list.
                jcPageLifecycle.ownObserver('arrInstances:' + id, root, { childList: true, subtree: true }, refresh);
            });
        })();

        // Apply the blurred background to .jc-sticky-header only when the
        // surrounding scroll container has actually scrolled — at scrollTop=0
        // the header stays transparent so it doesn't cover the Jellyfin top
        // bar / user avatar. We don't know ahead of time which element
        // actually scrolls (Jellyfin's layout has several candidates: the
        // page view wrapper, body, and window — and Jellyfin's `.scrollY`
        // utility class decorates some non-scrolling nodes), so we attach
        // scroll listeners to every reasonable candidate (matching ancestor
        // + window) and read whichever reports a non-zero scroll position.
        // All listeners are page-lifecycle-owned (#167): they persist while
        // Jellyfin keeps this page's DOM alive, and a fresh dashboard visit
        // removes them before installing its own set.
        (function wireStickyHeaderScroll() {
            var header = jcSel('.jc-sticky-header');
            if (!header) return;
            // Collect all overflow-y:auto|scroll ancestors as scroll-candidate
            // nodes. We don't trust scrollHeight>clientHeight at bind time
            // (async content hasn't landed yet); we don't pick just the
            // first match (Jellyfin's .scrollY utility flags decorative
            // containers that don't actually scroll). Listening on all
            // matches plus window means whichever actually scrolls drives
            // the class toggle.
            function findScrollCandidates(el) {
                var nodes = [];
                var node = el && el.parentNode;
                while (node && node !== document.body && node.nodeType === 1) {
                    var oy = getComputedStyle(node).overflowY;
                    if (oy === 'auto' || oy === 'scroll') nodes.push(node);
                    node = node.parentNode;
                }
                return nodes;
            }
            var candidates = findScrollCandidates(header);
            var ticking = false;
            function currentScrollTop() {
                var winTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
                var contTop = 0;
                for (var i = 0; i < candidates.length; i++) {
                    var n = candidates[i];
                    // Skip detached nodes: their scrollTop freezes at the last
                    // value, which would incorrectly pin `.jc-is-scrolled` on
                    // after the live scroller returns to top.
                    if (!n.isConnected) continue;
                    var t = n.scrollTop || 0;
                    if (t > contTop) contTop = t;
                }
                return winTop > contTop ? winTop : contTop;
            }
            function read() {
                try {
                    header.classList.toggle('jc-is-scrolled', currentScrollTop() > 4);
                } catch (e) {
                    console.warn('[JC] sticky-header read failed:', e);
                } finally {
                    // Guarantees the rAF pipeline doesn't wedge on `ticking` if read() throws.
                    ticking = false;
                }
            }
            function onScroll() {
                if (ticking) return;
                ticking = true;
                requestAnimationFrame(read);
            }
            // Always listen on window (document-scrolling layouts) and on each
            // overflow-declared ancestor (mid-tree scrollers). window is a single
            // global slot; the ancestors are PERSISTENT dashboard chrome that
            // survives across visits, so each is a per-node single slot — a fresh
            // visit replaces its prior handler instead of stacking one (#167).
            jcPageLifecycle.own('stickyScrollWindow', window, 'scroll', onScroll, { passive: true });
            if (candidates.length === 0) {
                console.warn('[JC] sticky-header: no overflow:auto|scroll ancestors found; relying on window scroll only.');
            }
            candidates.forEach(function(n) {
                jcPageLifecycle.ownNode(n, 'scroll', onScroll, { passive: true });
            });
            read();
        })();

        // ================================
        // SETTING DEPENDENCY SYSTEM
        // ================================

        /**
         * Checks whether a TMDB API key is configured in either input field.
         * @returns {boolean} True if a non-empty TMDB key exists
         */
        function hasTmdbKey() {
            return jcSel('#TMDB_API_KEY').value.trim().length > 0
                || jcSel('#seerr_TMDB_API_KEY').value.trim().length > 0;
        }

        /**
         * Returns true iff at least one configured Seerr URL parses as an
         * http(s) URL. A non-empty textarea full of garbage like "seerr.local"
         * (no scheme) used to evaluate truthy here, so the dependency banner
         * would hide and Seerr feature toggles would unlock — features that
         * could never actually work.          */
        function hasAtLeastOneValidSeerrUrl(value) {
            if (!value) return false;
            const lines = String(value).split('\n').map(s => s.trim()).filter(Boolean);
            for (const line of lines) {
                try {
                    const u = new URL(line);
                    if (u.protocol === 'http:' || u.protocol === 'https:') {
                        return true;
                    }
                } catch (_) {
                    // not a valid URL — try next line
                }
            }
            return false;
        }

        /**
         * Checks whether Seerr is enabled with both a URL and API key configured.
         * @returns {boolean} True if Seerr is fully configured
         */
        function hasSeerrConfigured() {
            return jcSel('#seerrEnabled').checked
                && hasAtLeastOneValidSeerrUrl(jcSel('#seerrUrls').value)
                && jcSel('#SeerrApiKey').value.trim().length > 0;
        }

        /**
         * Checks whether at least one ENABLED arr service (Sonarr or Radarr) has a URL and API key.
         * Disabled instances are skipped — they're stored config but the fan-out callers
         * (controller endpoints, scheduled tag sync) skip them, so gating dependent
         * features behind a disabled-only set would be misleading.
         * @returns {boolean} True if any enabled arr service is fully configured
         */
        function hasAnyArrService() {
            var cards = jcSelAll('#sonarrInstancesList .arr-instance-card, #radarrInstancesList .arr-instance-card');
            for (var i = 0; i < cards.length; i++) {
                var url = cards[i].querySelector('.arr-instance-url');
                var key = cards[i].querySelector('.arr-instance-apikey');
                var enabled = cards[i].querySelector('.arr-instance-enabled');
                // Treat missing checkbox as enabled (defensive — every card should have one)
                if (enabled && !enabled.checked) continue;
                if (url && url.value.trim() && key && key.value.trim()) return true;
            }
            return false;
        }

        // Setup fieldsets that hold the connection inputs are tagged with
        // `data-dep-setup` directly in the HTML — `updateSectionDep` walks
        // every fieldset and gates only the ones WITHOUT that marker, so
        // admins can always edit Sonarr/Radarr/Bazarr/Seerr setup boxes
        // regardless of what else is configured.
        var SECTION_DEPS = [
            {
                tabSelector: '#seerr',
                checkFn: hasSeerrConfigured,
                bannerIcon: 'link_off',
                bannerTitle: 'Enable "Seerr integration" to configure',
                bannerHint: 'Provide a Seerr URL and API key in the Setup section above, then enable the integration.',
                bannerId: 'dep-banner-seerr'
            },
            {
                tabSelector: '#arr',
                checkFn: hasAnyArrService,
                bannerIcon: 'link_off',
                bannerTitle: 'Enable a *arr service to configure',
                bannerHint: 'Add a URL and API key for Sonarr or Radarr above to enable these features.',
                bannerId: 'dep-banner-arr'
            }
        ];

        var INDIVIDUAL_DEPS = [
            { id: 'elsewhereEnabled',         checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'showReviews',              checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'showElsewhereOnSeerr', checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'autoMovieRequestEnabled',   checkFn: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
            { id: 'autoSkipIntro',                 checkFn: function() { return hasIntroSkipper !== false; }, hint: 'Install Intro Skipper plugin to enable', icon: 'extension' },
            { id: 'autoSkipOutro',                 checkFn: function() { return hasIntroSkipper !== false; }, hint: 'Install Intro Skipper plugin to enable', icon: 'extension' }
        ];

        /**
         * Adds a dependency tag to an element's comma-separated data-dep-disabled attribute.
         * @param {HTMLElement} el - The element to tag
         * @param {string} tag - The dependency tag to add
         */
        function addDepTag(el, tag) {
            var existing = (el.getAttribute('data-dep-disabled') || '').split(',').filter(Boolean);
            if (existing.indexOf(tag) === -1) existing.push(tag);
            el.setAttribute('data-dep-disabled', existing.join(','));
        }

        /**
         * Removes a dependency tag from an element; returns true if all tags are cleared.
         * @param {HTMLElement} el - The element to update
         * @param {string} tag - The dependency tag to remove
         * @returns {boolean} True if no dependency tags remain on the element
         */
        function removeDepTag(el, tag) {
            var existing = (el.getAttribute('data-dep-disabled') || '').split(',').filter(Boolean);
            var filtered = existing.filter(function(t) { return t !== tag; });
            if (filtered.length) {
                el.setAttribute('data-dep-disabled', filtered.join(','));
                return false;
            }
            el.removeAttribute('data-dep-disabled');
            return true;
        }

        /**
         * Creates an orange warning banner DOM element for a missing section dependency.
         * @param {Object} dep - Dependency rule with bannerIcon, bannerTitle, and bannerHint
         * @returns {HTMLElement} The constructed banner element
         */
        function createDepBanner(dep) {
            var banner = document.createElement('div');
            banner.id = dep.bannerId;
            banner.className = 'jc-dep-banner';
            var icon = document.createElement('i');
            icon.className = 'material-icons jc-dep-banner-icon';
            icon.textContent = dep.bannerIcon;
            var textDiv = document.createElement('div');
            textDiv.className = 'jc-dep-banner-text';
            var strong = document.createElement('strong');
            strong.textContent = dep.bannerTitle;
            var br = document.createElement('br');
            var span = document.createElement('span');
            span.className = 'jc-dep-banner-hint';
            span.textContent = dep.bannerHint;
            textDiv.appendChild(strong);
            textDiv.appendChild(br);
            textDiv.appendChild(span);
            banner.appendChild(icon);
            banner.appendChild(textDiv);
            return banner;
        }

        /**
         * Evaluates one section-level dependency rule, showing/hiding banners and disabling inputs.
         * @param {Object} dep - Section dependency rule with checkFn, tabSelector, and banner config
         */
        function updateSectionDep(dep) {
            var isMet = dep.checkFn();
            var tab = jcSel(dep.tabSelector);
            if (!tab) return;
            var fieldsets = tab.querySelectorAll(':scope > fieldset');
            var targets = [];
            for (var i = 0; i < fieldsets.length; i++) {
                // Setup fieldsets (Sonarr/Radarr/Bazarr config, Seerr connection setup)
                // are always editable so admins can add a connection without first
                // having one — they carry `data-dep-setup` directly in the HTML.
                if (fieldsets[i].hasAttribute('data-dep-setup')) continue;
                targets.push(fieldsets[i]);
            }

            targets.forEach(function(fieldset) {
                var bannerId = dep.bannerId + '-' + Array.prototype.indexOf.call(fieldsets, fieldset);
                var banner = jcById(bannerId);
                if (!isMet) {
                    if (!banner) {
                        var b = createDepBanner(dep);
                        b.id = bannerId;
                        var legend = fieldset.querySelector('legend');
                        if (legend) { legend.after(b); } else { fieldset.prepend(b); }
                        banner = b;
                    }
                    banner.classList.remove('jc-hidden');
                    banner.classList.add('jc-dep-banner'); // ensure class present if banner was pre-existing
                    fieldset.querySelectorAll('input, select, textarea, button').forEach(function(el) {
                        if (banner.contains(el)) return;
                        el.disabled = true;
                        addDepTag(el, dep.bannerId);
                    });
                    fieldset.querySelectorAll('label, .inputLabel, .selectLabel').forEach(function(el) {
                        el.style.opacity = '0.5';
                        el.style.cursor = 'not-allowed';
                        addDepTag(el, dep.bannerId);
                    });
                    fieldset.querySelectorAll('.fieldDescription').forEach(function(el) {
                        el.style.opacity = '0.5';
                        addDepTag(el, dep.bannerId);
                    });
                } else {
                    if (banner) banner.classList.add('jc-hidden');
                    fieldset.querySelectorAll('[data-dep-disabled]').forEach(function(el) {
                        var allClear = removeDepTag(el, dep.bannerId);
                        if (allClear) {
                            if (typeof el.disabled !== 'undefined' && el.tagName !== 'LABEL' && el.tagName !== 'DIV') {
                                el.disabled = false;
                            }
                            el.style.opacity = '';
                            el.style.cursor = '';
                        }
                    });
                }
            });
        }

        /**
         * Evaluates one individual setting dependency, disabling checkbox and showing hint when unmet.
         * @param {Object} dep - Individual dependency rule with id, checkFn, hint, and icon
         */
        function updateIndividualDep(dep) {
            var checkbox = jcById(dep.id);
            if (!checkbox) return;
            var label = checkbox.closest('label');
            if (!label) return;
            var isMet = dep.checkFn();
            var tag = 'ind-' + dep.id;

            if (!isMet) {
                checkbox.disabled = true;
                addDepTag(checkbox, tag);
                label.style.opacity = '0.5';
                label.style.cursor = 'not-allowed';
                label.title = dep.hint;
                addDepTag(label, tag);
                var span = label.querySelector('span');
                if (span && !label.querySelector('.dep-required-icon')) {
                    var icon = document.createElement('i');
                    icon.className = 'material-icons dep-required-icon';
                    icon.textContent = dep.icon || 'key';
                    icon.style.cssText = 'font-size: 16px; vertical-align: middle; margin-left: 8px; color: #ff9800;';
                    icon.title = dep.hint;
                    span.appendChild(icon);
                }
                if (span && !label.querySelector('.dep-hint-text')) {
                    var hintEl = document.createElement('span');
                    hintEl.className = 'dep-hint-text';
                    hintEl.textContent = dep.hint;
                    span.appendChild(hintEl);
                }
            } else {
                var allClear = removeDepTag(checkbox, tag);
                if (allClear) checkbox.disabled = false;
                var labelClear = removeDepTag(label, tag);
                if (labelClear) {
                    label.style.opacity = '';
                    label.style.cursor = '';
                    label.title = '';
                }
                var reqIcon = label.querySelector('.dep-required-icon');
                if (reqIcon) reqIcon.remove();
                var hintText = label.querySelector('.dep-hint-text');
                if (hintText) hintText.remove();
            }
        }

        var PARENT_DEPS = [
            // Only the custom-branding fields belong to "Enable Elsewhere" alone —
            // they're consumed solely inside the Elsewhere panel, so they stay
            // children here. Everything else that once hung off this parent is
            // shared with features that render independently of the Elsewhere
            // toggle, so gating it here greyed out live controls (the same trap the
            // "Show TMDB Reviews" fix addressed):
            //   • TMDB Reviews / reviewsExpandedByDefault render off
            //     (ShowReviews && TmdbEnabled) — gated on a TMDB key via the
            //     showReviews INDIVIDUAL/PARENT deps, not on Elsewhere.
            //   • Default Region is read by the TMDB Release Dates chip
            //     (ShowReleaseDates && TmdbEnabled), and Default Region / Default
            //     Providers / Ignore Providers are all read by the Seerr poster
            //     streaming icons (ShowElsewhereOnSeerr && TmdbEnabled).
            // Those provider inputs therefore stay editable with Elsewhere off.
            { parent: 'elsewhereEnabled', label: 'Enable Elsewhere', children: ['ElsewhereCustomBrandingText', 'ElsewhereCustomBrandingImageUrl'] },
            { parent: 'showReviews', label: 'Show Reviews', children: ['reviewsExpandedByDefault'] },
            { parent: 'showUserReviews', label: 'Enable User Reviews', children: ['hideReviewsFromHiddenUsers', 'hideReviewsFromDisabledUsers', 'showUserRatingDash', 'showUserRatingOnPosters'] },
            { parent: 'randomButtonEnabled', label: 'Enable Random Button', children: ['randomUnwatchedOnly', 'randomIncludeMovies', 'randomIncludeShows'] },
            { parent: 'showWatchProgress', label: 'Show watch progress', children: ['watchProgressDefaultMode', 'watchProgressTimeFormat'] },
            { parent: 'qualityTagsEnabled', label: 'Enable Quality Tags', children: ['qualityTagsPosition', 'showResolutionTag', 'showSourceTag', 'showDynamicRangeTag', 'showSpecialFormatTag', 'showVideoCodecTag', 'showAudioInfoTag'], noHint: true },
            { parent: 'genreTagsEnabled', label: 'Enable Genre Tags', children: ['genreTagsPosition'], noHint: true },
            { parent: 'languageTagsEnabled', label: 'Enable Language Tags', children: ['languageTagsPosition'], noHint: true },
            { parent: 'ratingTagsEnabled', label: 'Enable Rating Tags', children: ['ratingTagsPosition'], noHint: true },
            { parent: 'useIcons', label: 'Use Icons', children: ['iconStyle'] },
            { parent: 'letterboxdEnabled', label: 'Enable Letterboxd', children: ['showLetterboxdLinkAsText'] },
            { parent: 'enableCustomSplashScreen', label: 'Enable Custom Splash Screen', children: ['splashScreenImageUrl'] },
            { parent: 'seerrShowSearchResults', label: 'Show Seerr Results in Search', children: ['showCollectionsInSearch'] },
            { parent: 'seerrShowReportButton', label: 'Show Report Issue button', children: ['seerrShowIssueIndicator'] },
            { parent: 'downloadsPageEnabled', label: 'Enable Requests Page', children: ['showDownloadsInRequests', 'downloadsPageShowIssues', 'downloadsPagePollingEnabled'] },
            { parent: 'showDownloadsInRequests', label: 'Show Downloads in Requests Page', children: ['downloadsFilterByUserRequests'] },
            { parent: 'downloadsPagePollingEnabled', label: 'Enable Auto-Refresh', children: ['downloadsPollIntervalSeconds'] },
            { parent: 'arrLinksEnabled', label: 'Enable *arr Links', children: ['showArrLinksAsText', 'arrLinksShowStatusSingle'] },
            { parent: 'arrTagsSyncEnabled', label: 'Enable *arr Tags Sync', children: ['arrTagsPrefix', 'arrTagsClearOldTags', 'arrTagsShowAsLinks', 'arrTagsSyncFilter'] },
            { parent: 'arrTagsShowAsLinks', label: 'Show synced tags as links', children: ['arrTagsLinksFilter', 'arrTagsLinksHideFilter'] },
            { parent: 'calendarPageEnabled', label: 'Enable Calendar Page', children: ['calendarFirstDayOfWeek', 'calendarTimeFormat', 'calendarHighlightFavorites', 'calendarHighlightWatchedSeries', 'calendarFilterByLibraryAccess', 'calendarShowOnlyRequested', 'calendarForceOnlyRequested'] },
            { parent: 'autoMovieRequestEnabled', label: 'Enable Automatic Movie Requests', children: ['autoMovieRequestTriggerOnStart', 'autoMovieRequestTriggerOnMinutesWatched', 'autoMovieRequestMinutesWatched', 'autoMovieRequestCheckReleaseDate', 'autoMovieRequestQualityMode', 'autoMovieRequestFallbackOn4k'] },
            { parent: 'autoSeasonRequestEnabled', label: 'Enable Automatic Season Requests', children: ['autoSeasonRequestRequireAllWatched', 'autoSeasonRequestThresholdValue'] },
            { parent: 'preventWatchlistReAddition', label: 'Prevent re-adding removed items', children: ['watchlistMemoryRetentionDays'] },
            { parent: 'triggerSeerrScanOnItemAdded', label: 'Trigger Seerr scan on item added', children: ['seerrScanDebounceSeconds'] },
            { parent: 'bookmarksEnabled', label: 'Enable Bookmarks', children: [] },
            { parent: 'hiddenContentEnabled', label: 'Enable Hidden Content', children: [] }
        ];

        /**
         * Evaluates one parent-child dependency, disabling children when the parent is unchecked.
         * @param {Object} dep - Parent dependency rule with parent id, label, and children ids
         */
        function updateParentDep(dep) {
            var parent = jcById(dep.parent);
            if (!parent) return;
            var isEnabled = parent.checked;
            var tag = 'parent-' + dep.parent;
            var hintClass = 'parent-hint-' + dep.parent;

            dep.children.forEach(function(childId) {
                var child = jcById(childId);
                if (!child) return;
                var container = child.closest('.checkboxContainer, .inputContainer, .selectContainer')
                             || child.closest('label');

                if (!isEnabled) {
                    child.disabled = true;
                    addDepTag(child, tag);
                    if (container) {
                        container.style.opacity = '0.5';
                        container.style.cursor = 'not-allowed';
                        addDepTag(container, tag);
                        // Add hint unless the dependency opted out (e.g. tag-position
                        // dropdowns, where the disabled styling next to the parent
                        // checkbox already makes the relationship obvious).
                        if (!dep.noHint && !container.querySelector('.' + hintClass)) {
                            var hint = document.createElement('div');
                            hint.className = 'dep-hint-text ' + hintClass;
                            hint.textContent = 'Enable "' + dep.label + '" to configure';
                            container.appendChild(hint);
                        }
                    }
                } else {
                    var allClear = removeDepTag(child, tag);
                    if (allClear) child.disabled = false;
                    if (container) {
                        var cc = removeDepTag(container, tag);
                        if (cc) { container.style.opacity = ''; container.style.cursor = ''; }
                        // Remove hint
                        var hint = container.querySelector('.' + hintClass);
                        if (hint) hint.remove();
                    }
                }
            });
        }

        // ==============================================================
        // Connection-test cache + Integration Health checklist (phase 4).
        // The checklist on Overview is a live health view of every
        // integration the admin has turned on. It renders rows purely
        // from (live config) + (cached test results), so it doesn't
        // hammer external services on every render. TTL keeps results
        // fresh without forcing probes on every click. The "Re-test all"
        // Quick Action clears the cache and re-invokes every test.
        // ==============================================================
        var CONNECTION_TEST_CACHE_TTL_MS = 5 * 60 * 1000;
        var _jeConnectionTestCache = new Map();

        // Generation counter for the cache. Every clear bumps it; any
        // write that was captured (via beginConnectionTest) at a prior
        // generation is dropped. Closes the race where a user clicks a
        // per-service Test button, then clicks Re-test-all, then the
        // original click's async result resolves and writes a stale
        // ok/error over the fresh result. See design review H2.
        var _jeCacheGeneration = 0;

        /**
         * Capture the current cache generation. Tests call this at START
         * and pass the returned token to setConnectionTestResult. A token
         * older than the current generation means the cache was cleared
         * mid-test and this write is stale — it gets dropped.
         */
        function beginConnectionTest() {
            return _jeCacheGeneration;
        }

        // When true, per-service tests skip their own Dashboard.alert
        // success/failure dialog. The Re-test-all Quick Action sets this
        // for the duration of a batch and shows a single aggregate dialog
        // at the end, instead of stacking 8+ modal prompts the admin has
        // to dismiss one by one.
        var _jeSuppressTestAlerts = false;

        /**
         * Dashboard.alert that respects the batch-mode suppression flag.
         * Use inside any per-service test function where a Dashboard.alert
         * is part of the individual-test UX but would spam the admin when
         * the test fires as part of a batch re-test.
         */
        function jcTestAlert(opts) {
            if (_jeSuppressTestAlerts) return;
            try { Dashboard.alert(opts); } catch (e) {
                console.warn('[JC] Dashboard.alert threw:', e);
            }
        }

        /**
         * Write a test result into the cache and refresh the checklist.
         * Safe to call multiple times; last write wins within the same
         * generation. Cache-refresh is guarded against exceptions so a
         * bug in renderChecklist can't cascade and break the actual
         * test flow.
         * @param {string} key  e.g. 'tmdb', 'seerr', 'sonarr:<normalizedUrl>'
         * @param {'ok'|'error'} status
         * @param {string} detail short human message shown in the row
         * @param {number} [token] optional generation token from
         *   beginConnectionTest; stale tokens are silently dropped.
         */
        function setConnectionTestResult(key, status, detail, token) {
            if (token !== undefined && token !== _jeCacheGeneration) {
                // Stale write from a test that was issued before the last
                // cache clear. Drop it so a fresher (in-flight) test's
                // result isn't overwritten by a stale ok/error.
                return;
            }
            var now = Date.now();
            _jeConnectionTestCache.set(key, {
                status: status,
                detail: detail || '',
                at: now
            });
            // Also persist to localStorage so the checklist can show "Last
            // tested <date>" after a page reload, instead of falling back
            // to "Configured — not yet verified" as if nothing was ever
            // checked. Wrapped in try/catch because localStorage is
            // best-effort (private mode, quota, disabled storage, etc.).
            try {
                localStorage.setItem('jc_conn_test_' + key, JSON.stringify({
                    status: status,
                    detail: detail || '',
                    at: now
                }));
            } catch (e) { /* persistence is best-effort */ }
            try { renderChecklist(); } catch (e) {
                console.warn('[JC] renderChecklist threw after setConnectionTestResult:', e);
            }
        }

        /**
         * Read a previously-persisted test result for a connection key.
         * Returns null if no record, malformed JSON, or storage unavailable.
         * Unlike the in-memory cache there is NO TTL — the persisted entry
         * is meant to outlive page reloads so the admin always sees the
         * date of the most recent verification, however long ago it was.
         */
        function getPersistedTestResult(key) {
            var storageKey = 'jc_conn_test_' + key;
            try {
                var raw = localStorage.getItem(storageKey);
                if (!raw) return null;
                var rec = JSON.parse(raw);
                if (!rec || typeof rec.at !== 'number' || typeof rec.status !== 'string') {
                    // Self-heal: drop the bad entry so subsequent renders don't keep
                    // re-parsing it and so the row falls cleanly back to "not tested".
                    try { localStorage.removeItem(storageKey); } catch (e) {}
                    return null;
                }
                return rec;
            } catch (e) {
                // Parse error → treat as corrupt and remove.
                try { localStorage.removeItem(storageKey); } catch (rmErr) {}
                return null;
            }
        }

        /**
         * Format a timestamp for the checklist's "Last tested" line:
         *   - same day  → "Last tested 3:45 PM"
         *   - other day → "Last tested Apr 20, 2026"
         */
        function formatLastTested(ts) {
            var d = new Date(ts);
            var now = new Date();
            if (d.toDateString() === now.toDateString()) {
                return 'Last tested ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            }
            return 'Last tested ' + d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
        }

        /**
         * Build a checklist row from cached / persisted test data.
         *  - Fresh in-memory hit  → row reflects the live status + detail
         *  - Persisted-only hit   → row keeps the last known state but
         *    swaps the detail line for "Last tested <date>"
         *  - No data              → row stays 'pending' with the supplied
         *    fallback text
         */
        function checklistRowState(cacheKey, fallbackDetail) {
            var live = getConnectionTestResult(cacheKey);
            if (live) return { state: live.status, detail: live.detail };
            var persisted = getPersistedTestResult(cacheKey);
            if (persisted) return { state: persisted.status, detail: formatLastTested(persisted.at) };
            return { state: 'pending', detail: fallbackDetail };
        }

        /**
         * Read a test result from the cache. Returns null on miss OR on
         * expiry — callers render the row as "pending" in that case.
         */
        function getConnectionTestResult(key) {
            var entry = _jeConnectionTestCache.get(key);
            if (!entry) return null;
            if (Date.now() - entry.at > CONNECTION_TEST_CACHE_TTL_MS) {
                _jeConnectionTestCache.delete(key);
                return null;
            }
            return entry;
        }

        /**
         * Drop every cached result. Used by the Re-test-all Quick Action
         * so rows immediately show "pending" while tests fire.
         */
        function clearConnectionTestCache() {
            _jeConnectionTestCache.clear();
            _jeCacheGeneration++;
            // Also drop persisted entries; otherwise checklistRowState falls back
            // to the "Last tested <date>" line and rows stay green/red instead of
            // showing pending while the new tests fire.
            try {
                var doomed = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('jc_conn_test_') === 0) doomed.push(k);
                }
                doomed.forEach(function(k) { localStorage.removeItem(k); });
            } catch (e) { /* private mode / quota — best-effort */ }
            try { renderChecklist(); } catch (e) {
                console.warn('[JC] renderChecklist threw after clearConnectionTestCache:', e);
            }
        }

        /**
         * Drop the persisted "Last tested <date>" entry for a given service when
         * the inputs that produced that test result change (new TMDB key, new Seerr
         * URL, etc.) — otherwise the checklist would keep claiming the old key
         * worked. Wired up in the load/change handlers for the relevant inputs.
         */
        function invalidatePersistedTest(key) {
            try { localStorage.removeItem('jc_conn_test_' + key); } catch (e) {}
            // Clear in-memory copy too so the row immediately drops to pending.
            _jeConnectionTestCache.delete(key);
            try { renderChecklist(); } catch (e) {}
        }

        /**
         * Normalize an arr-instance URL into a cache key fragment.
         * Trim, lowercase, strip trailing slashes so minor differences
         * don't fork the cache.
         */
        function _jeNormalizeArrUrl(url) {
            return (url || '').trim().toLowerCase().replace(/\/+$/, '');
        }

        /**
         * Build the Integration Health checklist inside #jc-checklist.
         *
         * Row rules:
         *   - Only render a row when the integration is enabled.
         *   - Row state: 'ok' (green), 'amber' (warn), 'error' (red),
         *     'pending' (grey — enabled + complete config but no cached
         *     test result within TTL).
         *   - Zero rows is a valid outcome — render the empty hint.
         *   - Clicking a row jumps to the target tab.
         *
         * No HTML is injected from runtime data — every row is built with
         * createElement + textContent so untrusted instance names / URLs
         * can never inject markup into the checklist.
         */
        function renderChecklist() {
            // Thin delegator: the Integration Health checklist was merged into
            // Service Status, but multiple callers still reference this name —
            // keep the symbol to avoid breaking them. The original per-row
            // construction (#jc-checklist + .jc-checklist-* classes) was
            // removed along with its DOM host and CSS.
            renderServiceStatusDashboard();
        }

        /**
         * Overview → Optional Dependencies
         * Renders a card per optional plugin with its detected state.
         * Sources the booleans populated by checkInstalledPlugins() —
         * `null` means the /Plugins probe hasn't completed (or failed),
         * rendered as "Checking…" rather than asserting missing.
         */
        var OPTIONAL_PLUGINS = [
            { key: 'fileTransformation', name: 'File Transformation', icon: 'transform',       url: 'https://github.com/IAmParadox27/jellyfin-plugin-file-transformation', purpose: 'Required by Custom Tabs, Plugin Pages, and other plugins that modify the web client.', getFlag: function(){ return hasFileTransformation; } },
            { key: 'introSkipper',       name: 'Intro Skipper',       icon: 'skip_next',       url: 'https://github.com/intro-skipper/intro-skipper',                      purpose: 'Source of timestamps for Auto-skip Intro / Auto-skip Outro.',                        getFlag: function(){ return hasIntroSkipper; } },
            { key: 'inPlayerEpisodePreview', name: 'In-Player Episode Preview', icon: 'movie_filter', url: 'https://github.com/Namo2/InPlayerEpisodePreview',            purpose: 'Enables the in-player Episode Preview keyboard shortcut.',                           getFlag: function(){ return hasInPlayerEpisodePreview; } },
            { key: 'kefinTweaks',        name: 'KefinTweaks',         icon: 'bookmark_border', url: 'https://github.com/ranaldsgift/KefinTweaks',                          purpose: 'Renders the Watchlist UI in Jellyfin. Required to view watchlisted items from the Seerr Watchlist features. Installs as a web-mod (not a normal plugin), detected via its injected scripts.', getFlag: function(){ return hasKefinTweaks; } }
        ];
        function renderOptionalPluginsDashboard() {
            var root = jcById('jc-optional-plugins');
            if (!root) return;
            root.textContent = '';
            OPTIONAL_PLUGINS.forEach(function(dep) {
                var flag = dep.getFlag();
                var state, statusText;
                if (flag === true)       { state = 'installed'; statusText = 'Installed'; }
                else if (flag === false) { state = 'missing';   statusText = 'Not installed'; }
                else                     { state = 'unknown';   statusText = 'Checking…'; }

                // When the plugin is installed-but-disabled (status ≠ Active),
                // flip to an amber "disabled" state so the admin knows to
                // re-enable it rather than wonder why features don't work.
                if (flag === false && _jeDisabledPlugins[dep.key]) {
                    state = 'warn';
                    statusText = 'Installed but disabled in Dashboard > Plugins';
                }

                var card = document.createElement('div');
                card.className = 'jc-optional-plugin-card jc-state-' + state;
                var icon = document.createElement('i');
                icon.className = 'material-icons jc-optional-plugin-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = state === 'installed' ? 'check_circle'
                                 : state === 'warn'      ? 'warning'
                                 : state === 'unknown'   ? 'help_outline'
                                 : 'radio_button_unchecked';
                card.appendChild(icon);
                var body = document.createElement('div');
                body.className = 'jc-optional-plugin-body';
                var name = document.createElement('div');
                name.className = 'jc-optional-plugin-name';
                name.textContent = dep.name;
                body.appendChild(name);
                var status = document.createElement('div');
                status.className = 'jc-optional-plugin-status';
                status.textContent = statusText;
                body.appendChild(status);
                var purpose = document.createElement('div');
                purpose.className = 'jc-optional-plugin-purpose';
                purpose.textContent = dep.purpose;
                body.appendChild(purpose);
                card.appendChild(body);

                // External link icon in the top-right — opens the plugin's
                // home repo in a new tab. noopener/noreferrer both for security
                // and so the opened page can't manipulate this window.
                if (dep.url) {
                    var link = document.createElement('a');
                    link.className = 'jc-optional-plugin-link';
                    link.href = dep.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.title = 'Open ' + dep.name + ' on GitHub';
                    link.setAttribute('aria-label', 'Open ' + dep.name + ' on GitHub');
                    var linkIcon = document.createElement('i');
                    linkIcon.className = 'material-icons';
                    linkIcon.setAttribute('aria-hidden', 'true');
                    linkIcon.textContent = 'open_in_new';
                    link.appendChild(linkIcon);
                    card.appendChild(link);
                }

                root.appendChild(card);
            });
        }

        /**
         * Overview → Features
         * Renders a row per JC feature with one of three states:
         *   - on   (green)   : enabled and all required deps/config present
         *   - warn (amber)   : enabled but missing a dep or required config
         *   - off  (faded)   : disabled
         * Clicking a row jumps to the tab where the feature lives.
         *
         * Rules reference form inputs (live DOM) rather than a snapshot so this
         * updates correctly after every dependency re-evaluation.
         */
        function renderFeaturesDashboard() {
            var root = jcById('jc-features-dashboard');
            if (!root) return;

            function bool(id) {
                var el = jcById(id);
                return !!(el && el.checked);
            }
            function val(id) {
                var el = jcById(id);
                return el ? (el.value || '').trim() : '';
            }
            function anyArrConfigured() {
                var cards = jcSelAll('#sonarrInstancesList .arr-instance-card, #radarrInstancesList .arr-instance-card');
                for (var i = 0; i < cards.length; i++) {
                    var url = cards[i].querySelector('.arr-instance-url');
                    var key = cards[i].querySelector('.arr-instance-apikey');
                    if (url && key && url.value.trim() && key.value.trim()) return true;
                }
                return false;
            }
            function seerrConfigured() {
                return !!val('seerrUrls') && !!val('SeerrApiKey');
            }

            var features = [];
            function feat(name, enabled, tab, detail, warn) {
                if (!enabled) { features.push({ name: name, state: 'off', tab: tab, detail: 'Disabled' }); return; }
                features.push({ name: name, state: warn ? 'warn' : 'on', tab: tab, detail: detail });
            }

            // Display
            feat('Remove from Continue Watching', bool('removeContinueWatchingEnabled'), 'display', 'Enabled');
            feat('Hide Favorites Tab', bool('hideFavoritesTab'), 'display', 'Enabled');
            var tagCount = ['qualityTagsEnabled','genreTagsEnabled','languageTagsEnabled','ratingTagsEnabled','peopleTagsEnabled'].filter(bool).length;
            feat('Media Tags', tagCount > 0, 'display', tagCount + ' tag type(s) enabled');
            feat('Random Button', bool('randomButtonEnabled'), 'display', 'Enabled');

            // Playback
            feat('Custom Pause Screen', bool('pauseScreenEnabled'), 'playback', 'Enabled');
            feat('Long press for 2x speed', bool('longPress2xEnabled'), 'playback', 'Enabled (touch devices)');
            var autoSkip = bool('autoSkipIntro') || bool('autoSkipOutro');
            var autoSkipWarn = autoSkip && hasIntroSkipper !== true;
            feat('Auto-skip Intro/Outro', autoSkip, 'playback',
                autoSkipWarn ? 'Enabled but Intro Skipper plugin is missing' : 'Enabled',
                autoSkipWarn);
            var tabSwitch = bool('autoPauseEnabled') || bool('autoResumeEnabled') || bool('autoPipEnabled');
            feat('Tab-switch actions', tabSwitch, 'playback', 'Auto-pause / resume / PiP');

            // Pages
            feat('Bookmarks', bool('bookmarksEnabled'), 'pages', 'Enabled');
            feat('Hidden Content', bool('hiddenContentEnabled'), 'pages', 'Enabled');
            var reqWarn = bool('downloadsPageEnabled') && !seerrConfigured() && !anyArrConfigured();
            feat('Requests Page', bool('downloadsPageEnabled'), 'pages',
                reqWarn ? 'Enabled but neither Seerr nor *arr is configured' : 'Enabled',
                reqWarn);
            var calWarn = bool('calendarPageEnabled') && !anyArrConfigured();
            feat('Calendar Page', bool('calendarPageEnabled'), 'pages',
                calWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                calWarn);

            // Custom splash screen / branding. Both the splash screen and the
            // branding image uploads (icons/favicon/logos) are handled by Jellyfin
            // Enhanced itself at request time, so no extra plugin is required.
            var splashOn = bool('enableCustomSplashScreen');
            feat('Custom splash / branding', splashOn, 'extras', 'Enabled', false);

            // Extras
            var elsewhereWarn = bool('elsewhereEnabled') && !val('TMDB_API_KEY');
            feat('Elsewhere (streaming providers)', bool('elsewhereEnabled'), 'elsewhere',
                elsewhereWarn ? 'Enabled but TMDB API key is missing' : 'Enabled',
                elsewhereWarn);

            // Seerr
            var seerrWarn = bool('seerrEnabled') && !seerrConfigured();
            feat('Seerr integration', bool('seerrEnabled'), 'seerr',
                seerrWarn ? 'Enabled but Seerr URL or API key missing' : 'Enabled',
                seerrWarn);

            // Watchlist (Seerr tab). Sync and "add requested → watchlist" both
            // need KefinTweaks to actually render the watchlist UI in Jellyfin;
            // the feature writes the data either way, but the user can't see
            // it without KefinTweaks.
            var watchlistAny = bool('addRequestedMediaToWatchlist') || bool('syncSeerrWatchlist');
            var watchlistWarn = watchlistAny && hasKefinTweaks !== true;
            feat('Watchlist sync', watchlistAny, 'seerr',
                watchlistWarn ? 'Enabled but KefinTweaks plugin not installed (watchlist UI won\'t render)' : 'Enabled',
                watchlistWarn);

            // *arr
            var arrLinksWarn = bool('arrLinksEnabled') && !anyArrConfigured();
            feat('*arr detail-page links', bool('arrLinksEnabled'), 'arr',
                arrLinksWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                arrLinksWarn);
            var tagsSyncWarn = bool('arrTagsSyncEnabled') && !anyArrConfigured();
            feat('*arr tags sync', bool('arrTagsSyncEnabled'), 'arr',
                tagsSyncWarn ? 'Enabled but no *arr instance is configured' : 'Enabled',
                tagsSyncWarn);

            // Stable ordering: warnings first, then on, then off
            features.sort(function(a, b) {
                var ord = { warn: 0, on: 1, off: 2 };
                return ord[a.state] - ord[b.state];
            });

            root.textContent = '';
            if (features.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'jc-checklist-empty';
                empty.textContent = 'No features configured yet.';
                root.appendChild(empty);
                return;
            }
            features.forEach(function(f) {
                var row = document.createElement('button');
                row.type = 'button';
                row.className = 'jc-feature-row jc-state-' + f.state;
                row.setAttribute('data-target', f.tab);
                var icon = document.createElement('i');
                icon.className = 'material-icons jc-feature-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = f.state === 'on'   ? 'check_circle'
                                 : f.state === 'warn' ? 'warning'
                                 : 'radio_button_unchecked';
                row.appendChild(icon);
                var body = document.createElement('div');
                body.className = 'jc-feature-body';
                var name = document.createElement('div');
                name.className = 'jc-feature-name';
                name.textContent = f.name;
                body.appendChild(name);
                var detail = document.createElement('div');
                detail.className = 'jc-feature-detail';
                detail.textContent = f.detail;
                body.appendChild(detail);
                row.appendChild(body);
                row.addEventListener('click', function() {
                    var targetTab = f.tab;
                    var tabBtn = jcSel('.jellyfin-tab-button[data-tab="' + targetTab + '"]');
                    if (tabBtn) tabBtn.click();
                });
                root.appendChild(row);
            });
        }

        // ==============================================================
        // Gated help (phase 5). Any setup-instruction block that only
        // applies when a specific toggle is on lives under a
        // [data-gated-by="<checkbox-id>"] attribute. Hidden when the
        // toggle is off; visible when on. Transitions from off→on also
        // auto-open the accordion so the admin doesn't have to hunt
        // for the freshly-revealed help.
        //
        // Declarative tag + generic dispatcher = no per-section wiring.
        // Adding a new gated help block means: drop data-gated-by on
        // the element + add the checkbox id below to GATED_HELP_IDS.
        // ==============================================================

        // Track prior checked state per gated-help parent so we can
        // detect an off→on transition in the change listener and
        // auto-expand the just-revealed accordion.
        var _jeGatedHelpState = Object.create(null);

        /**
         * Syncs visibility of every [data-gated-by] element to its
         * parent checkbox's checked state. If autoExpandOnRise is true
         * AND a parent just went from unchecked to checked, the gated
         * `<details>` is auto-opened.
         */
        function applyGatedHelp(autoExpandOnRise) {
            var gated = jcSelAll('[data-gated-by]');
            gated.forEach(function(el) {
                var parentAttr = el.getAttribute('data-gated-by');
                if (!parentAttr) return;
                // Allow comma-separated IDs: ALL listed parents must be checked
                // for the gated element to show.
                var parentIds = parentAttr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                var allOn = true;
                var anyRise = false;
                parentIds.forEach(function(parentId) {
                    var parent = jcById(parentId);
                    if (!parent) { allOn = false; return; }
                    var thisOn = !!parent.checked;
                    if (!thisOn) allOn = false;
                    var wasOn = _jeGatedHelpState[parentId] === true;
                    if (thisOn && !wasOn) anyRise = true;
                    _jeGatedHelpState[parentId] = thisOn;
                });
                el.hidden = !allOn;
                if (autoExpandOnRise && allOn && anyRise && el.tagName === 'DETAILS') {
                    el.open = true;
                }
            });
        }

        // Wire one change listener per unique parent id referenced by
        // [data-gated-by]. A single bulk dispatch refreshes every gated
        // element regardless of which parent fired.
        //
        // We also prime `_jeGatedHelpState` with each parent's current
        // checked value at wire time. Without priming, the first user
        // click on a gated parent that was already checked (e.g. after a
        // config load flipped the DOM state out of band) would be read
        // as `wasOn === undefined (falsy) → isOn === true`, i.e. a rise,
        // and auto-expand when it shouldn't. Priming closes that hole
        // for the initial render AND for any parent the config loader
        // set programmatically (programmatic `.checked = true` does NOT
        // fire a change event, so the listener wouldn't see it).
        (function wireGatedHelp() {
            var gated = jcSelAll('[data-gated-by]');
            var uniqueParents = Object.create(null);
            gated.forEach(function(el) {
                var attr = el.getAttribute('data-gated-by');
                if (!attr) return;
                attr.split(',').map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(id) {
                    uniqueParents[id] = true;
                });
            });
            Object.keys(uniqueParents).forEach(function(id) {
                var parent = jcById(id);
                if (!parent) {
                    console.warn('[JC] gated-help: parent checkbox #' + id + ' not found — help will stay hidden');
                    return;
                }
                _jeGatedHelpState[id] = !!parent.checked;
                jcPageLifecycle.addListener(parent, 'change', function() {
                    try { applyGatedHelp(true); } catch (e) {
                        console.warn('[JC] applyGatedHelp threw in change handler:', e);
                    }
                });
            });
            // Reflect initial visibility once so the DOM matches the primed
            // state immediately (no flicker when loadConfig eventually
            // triggers updateAllDependencies → applyGatedHelp(false)).
            try { applyGatedHelp(false); } catch (e) {
                console.warn('[JC] applyGatedHelp threw during init:', e);
            }
        })();

        /**
         * Orchestrator: evaluates all section, individual, and parent dependency rules.
         * Each step is isolated so a throw in the status dashboard (which reads a lot
         * of field values) can't cascade and break dependency updates.
         */
        function updateAllDependencies() {
            SECTION_DEPS.forEach(updateSectionDep);
            INDIVIDUAL_DEPS.forEach(updateIndividualDep);
            PARENT_DEPS.forEach(updateParentDep);
            // Keep the Requests Page requirements banner in sync with dep-relevant
            // changes it now reads — notably the Seerr enable toggle (which fires
            // updateAllDependencies) feeding hasSeerrConfigured(). Isolated so
            // a throw here can't break the rest of the dependency pass.
            try { updateRequestsRequirementsBanner(); } catch (e) {
                console.warn('[JC] requirements banner refresh threw:', e);
            }
            updateClientTagCacheControlsVisibility();
            // `updateStatusDashboard` and the legacy `renderChecklist` both
            // now delegate to `renderServiceStatusDashboard`. Calling both
            // here would rebuild the service grid TWICE per dependency tick
            // (~30 times during a TMDB key rotation). One call is enough.
            try {
                renderServiceStatusDashboard();
            } catch (e) {
                console.warn('[JC] renderServiceStatusDashboard threw; dashboard may be stale:', e);
            }
            try {
                renderOptionalPluginsDashboard();
            } catch (e) {
                console.warn('[JC] renderOptionalPluginsDashboard threw:', e);
            }
            try {
                renderFeaturesDashboard();
            } catch (e) {
                console.warn('[JC] renderFeaturesDashboard threw:', e);
            }
            try {
                // Re-sync banner parent gating. loadConfig sets .checked
                // programmatically, which DOESN'T fire the change event our
                // banner listener uses — so we need an explicit refresh here.
                if (typeof syncAllBannerParents === 'function') syncAllBannerParents();
            } catch (e) {
                console.warn('[JC] syncAllBannerParents threw:', e);
            }
            try {
                // Don't auto-expand when triggered by a bulk dep sync —
                // that would fire `open = true` on every tick the parent
                // is checked, which is noisy. Real off→on transitions
                // go through the dedicated change listener above.
                applyGatedHelp(false);
            } catch (e) {
                console.warn('[JC] applyGatedHelp threw; gated help may be stale:', e);
            }
        }

        /**
         * Reads `.value` from a selector, returning '' if the element is missing.
         * Logs once per missing selector so DOM/JS mismatches surface in devtools
         * instead of throwing silently through a querySelector chain.
         * @param {string} sel - CSS selector
         * @returns {string} Trimmed value, or '' if element not found
         */
        var _jeMissingSelectorsWarned = Object.create(null);
        function readFieldValue(sel) {
            var el = jcSel(sel);
            if (!el) {
                if (!_jeMissingSelectorsWarned[sel]) {
                    _jeMissingSelectorsWarned[sel] = true;
                    console.warn('[JC] status dashboard: selector "' + sel + '" not found');
                }
                return '';
            }
            return (el.value || '').trim();
        }

        /**
         * Counts configured arr instance cards for a given type (sonarr|radarr).
         * An instance is "configured" when both URL and API key are non-empty.
         * Returns -1 (not 0) if the instance list container is missing, so callers
         * can distinguish "user configured zero" from "DOM not ready / mismatched."
         * @param {string} type - 'sonarr' or 'radarr'
         * @returns {number} Count of fully-configured instances, or -1 if list missing
         */
        var _jeMissingListWarned = Object.create(null);
        function countArrInstances(type) {
            var listId = type === 'sonarr' ? 'sonarrInstancesList' : 'radarrInstancesList';
            var list = jcById(listId);
            if (!list) {
                if (!_jeMissingListWarned[listId]) {
                    _jeMissingListWarned[listId] = true;
                    console.warn('[JC] status dashboard: #' + listId + ' not found');
                }
                return -1;
            }
            var cards = list.querySelectorAll('.arr-instance-card');
            var count = 0;
            for (var i = 0; i < cards.length; i++) {
                var url = cards[i].querySelector('.arr-instance-url');
                var key = cards[i].querySelector('.arr-instance-apikey');
                if (url && url.value.trim() && key && key.value.trim()) count++;
            }
            return count;
        }

        /**
         * Merged Service Status renderer.
         *
         * Replaces the legacy status-card grid + Integration Health checklist
         * with a single card list that sources:
         *   - config state from the live form (key/URL/API-key presence, *arr
         *     instance counts, Seerr URL list),
         *   - test-result state from the connection-test cache (so a green
         *     "connected" or red "failed" card reflects the latest probe).
         *
         * Card states (drive the left-border accent and icon):
         *   - 'ok'      green    — configured; latest test passed (or no test
         *                           run yet but no negative signal)
         *   - 'warn'    amber    — configured partially (e.g. Seerr URL but no
         *                           API key) OR connection-test returned
         *                           amber (reachable but not healthy)
         *   - 'error'   red      — connection-test returned error
         *   - 'pending' grey dot — enabled + complete config, no cached result
         *   - 'off'     faded    — disabled / no config entered yet
         *
         * Each card is a <button> that jumps to the relevant settings tab.
         */
        function renderServiceStatusDashboard() {
            var root = jcById('jc-service-dashboard');
            if (!root) return;

            var cards = [];
            function pushCard(opts) { cards.push(opts); }

            // TMDB — no dedicated test endpoint; presence-based state only.
            var tmdbKey = readFieldValue('#TMDB_API_KEY');
            pushCard({
                id: 'tmdb',
                name: 'TMDB',
                tab: 'elsewhere',
                scrollTo: '#TMDB_API_KEY',
                state: tmdbKey ? 'ok' : 'off',
                detail: tmdbKey ? 'API key set' : 'No API key',
                icon: 'vpn_key'
            });

            // Seerr
            var seerrEnabled = jcById('seerrEnabled');
            var seerrUrls = readFieldValue('#seerrUrls');
            var seerrKey = readFieldValue('#SeerrApiKey');
            if (seerrEnabled && seerrEnabled.checked) {
                if (seerrUrls && seerrKey) {
                    var r = checklistRowState('seerr', 'Configured — not yet verified');
                    var urlCount = seerrUrls.split(/\r?\n/).filter(function(u) { return u.trim(); }).length;
                    pushCard({
                        id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt',
                        state: r.state === 'amber' ? 'warn' : r.state === 'pending' ? 'pending' : r.state,
                        detail: r.detail + (urlCount > 1 ? ' · ' + urlCount + ' URLs' : '')
                    });
                } else {
                    pushCard({
                        id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt', state: 'warn',
                        detail: !seerrUrls && !seerrKey ? 'Enabled but URL and API key missing'
                            : !seerrUrls ? 'URL missing' : 'API key missing'
                    });
                }
            } else if (seerrUrls || seerrKey) {
                pushCard({
                    id: 'seerr', name: 'Seerr', tab: 'seerr', icon: 'bolt', state: 'off',
                    detail: 'Configured but integration disabled'
                });
            }

            // Sonarr / Radarr — one card per instance, reusing test-cache keys
            ['sonarr', 'radarr'].forEach(function(type) {
                var list = jcById(type + 'InstancesList');
                if (!list) return;
                var arrCards = list.querySelectorAll('.arr-instance-card');
                arrCards.forEach(function(card) {
                    var urlEl = card.querySelector('.arr-instance-url');
                    var keyEl = card.querySelector('.arr-instance-apikey');
                    var nameEl = card.querySelector('.arr-instance-name');
                    if (!urlEl || !keyEl) return;
                    var urlVal = (urlEl.value || '').trim();
                    var keyVal = (keyEl.value || '').trim();
                    if (!urlVal && !keyVal) return;
                    var nameVal = (nameEl && nameEl.value ? nameEl.value.trim() : '')
                                  || (type === 'sonarr' ? 'Sonarr' : 'Radarr');
                    var cacheKey = type + ':' + _jeNormalizeArrUrl(urlVal);
                    var icon = type === 'sonarr' ? 'tv' : 'movie';

                    // Disabled instances (Enabled checkbox unchecked) render as
                    // a grayed-out "Disabled" card regardless of test-cache
                    // state — a stale red/green badge on a disabled entry is
                    // misleading because the instance isn't being used.
                    var enCb = card.querySelector('.arr-instance-enabled');
                    var isDisabled = enCb && !enCb.checked;
                    if (isDisabled) {
                        pushCard({
                            id: cacheKey, name: nameVal, tab: 'arr', icon: icon, state: 'off',
                            detail: 'Disabled'
                        });
                        return;
                    }

                    if (!urlVal || !keyVal) {
                        pushCard({
                            id: cacheKey, name: nameVal, tab: 'arr', icon: icon, state: 'warn',
                            detail: !urlVal ? 'URL missing' : 'API key missing'
                        });
                        return;
                    }
                    var r = checklistRowState(cacheKey, 'Configured — not yet verified');
                    pushCard({
                        id: cacheKey, name: nameVal, tab: 'arr', icon: icon,
                        state: r.state === 'amber' ? 'warn' : r.state === 'pending' ? 'pending' : r.state,
                        detail: r.detail
                    });
                });
            });

            // Bazarr — no test endpoint; URL presence is the best signal
            var bazarrUrl = readFieldValue('#bazarrUrl');
            var bazarrMappings = readFieldValue('#bazarrUrlMappings');
            if (bazarrUrl || bazarrMappings) {
                pushCard({
                    id: 'bazarr', name: 'Bazarr', tab: 'arr', icon: 'subtitles',
                    state: bazarrUrl ? 'ok' : 'warn',
                    detail: bazarrUrl ? 'URL configured' : 'Only URL mappings set'
                });
            }

            root.textContent = '';
            if (cards.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'jc-checklist-empty';
                empty.textContent = 'Configure TMDB, Seerr, or an *arr instance to see its status here.';
                root.appendChild(empty);
                return;
            }

            // Order: warn/error first, then pending, then ok, then off (faded)
            var ord = { error: 0, warn: 1, pending: 2, ok: 3, off: 4 };
            cards.sort(function(a, b) { return (ord[a.state] || 99) - (ord[b.state] || 99); });

            cards.forEach(function(c) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'jc-service-card jc-state-' + c.state;
                btn.setAttribute('data-target', c.tab);
                btn.setAttribute('data-status-id', c.id);
                var iconEl = document.createElement('i');
                iconEl.className = 'material-icons jc-service-icon';
                iconEl.setAttribute('aria-hidden', 'true');
                iconEl.textContent = c.state === 'ok'      ? 'check_circle'
                                   : c.state === 'warn'    ? 'warning'
                                   : c.state === 'error'   ? 'error'
                                   : c.state === 'pending' ? 'hourglass_empty'
                                   : (c.icon || 'radio_button_unchecked');
                btn.appendChild(iconEl);
                var body = document.createElement('div');
                body.className = 'jc-service-body';
                var nameEl = document.createElement('div');
                nameEl.className = 'jc-service-name';
                nameEl.textContent = c.name;
                body.appendChild(nameEl);
                var detail = document.createElement('div');
                detail.className = 'jc-service-detail';
                detail.textContent = c.detail;
                body.appendChild(detail);
                btn.appendChild(body);
                btn.addEventListener('click', function() {
                    var tabBtn = jcSel('.jellyfin-tab-button[data-tab="' + c.tab + '"]');
                    if (tabBtn) tabBtn.click();
                    // Optional deep-link: after the tab activates AND
                    // activateTab's own per-tab scroll-memory rAF has run
                    // (double rAF), scroll the specific field into view.
                    // activateTab schedules a rAF to restore scroll position,
                    // so scheduling our scroll in the frame AFTER that wins
                    // the race deterministically. Cards that don't set
                    // scrollTo land at the tab's scroll-memory position.
                    if (c.scrollTo) {
                        requestAnimationFrame(function() {
                            requestAnimationFrame(function() {
                                var target = jcSel(c.scrollTo);
                                if (target) {
                                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                } else {
                                    console.warn('[JC] service-status deep-link target not found:', c.scrollTo);
                                }
                            });
                        });
                    }
                });
                root.appendChild(btn);
            });
        }

        // Back-compat: older code paths still call these by name. Delegate both
        // to the unified renderer instead of maintaining dead duplicates.
        function updateStatusDashboard() { renderServiceStatusDashboard(); }

        /**
         * Shows clear-client-cache controls only when server-side tag cache is disabled.
         */
        function updateClientTagCacheControlsVisibility() {
            var serverModeCheckbox = jcById('tagCacheServerMode');
            var controls = jcById('clientTagCacheControls');
            var localStorageFallbackContainer = jcById('tagsLocalStorageFallbackContainer');
            var localStorageFallbackCheckbox = jcById('enableTagsLocalStorageFallback');
            if (!serverModeCheckbox || !controls) return;

            if (localStorageFallbackContainer) {
                var hide = serverModeCheckbox.checked ? 'none' : '';
                localStorageFallbackContainer.style.display = hide;
                var localStorageFallbackDesc = jcSel('[data-desc-for="enableTagsLocalStorageFallback"]');
                if (localStorageFallbackDesc) localStorageFallbackDesc.style.display = hide;
            }

            if (!serverModeCheckbox.checked && localStorageFallbackCheckbox) {
                localStorageFallbackCheckbox.checked = true;
            }

            controls.style.display = serverModeCheckbox.checked ? 'none' : '';
            updateClearTagCachesQuickBtnVisibility();
        }

        // Reactive dependency updates (debounced for text inputs, immediate for checkboxes)
        var depDebounce;
        /** Debounced wrapper that delays updateAllDependencies by 150ms. */
        function debouncedUpdateDeps() {
            clearTimeout(depDebounce);
            depDebounce = setTimeout(updateAllDependencies, 150);
        }
        ['#TMDB_API_KEY', '#seerr_TMDB_API_KEY'].forEach(function(sel) {
            jcPageLifecycle.addListener(jcSel(sel), 'input', debouncedUpdateDeps);
        });
        jcPageLifecycle.addListener(jcSel('#seerrEnabled'), 'change', updateAllDependencies);
        jcPageLifecycle.addListener(jcSel('#tagCacheServerMode'), 'change', updateAllDependencies);
        ['#seerrUrls', '#SeerrApiKey'].forEach(function(sel) {
            jcPageLifecycle.addListener(jcSel(sel), 'input', debouncedUpdateDeps);
        });

        // Drop persisted "Last tested <date>" entries when the inputs that produced
        // those tests change — otherwise an admin who rotated their TMDB API key or
        // changed Seerr URLs would keep seeing a green checkmark from the previous
        // credentials. The next test (or page render) re-establishes the row.
        function _wireInvalidate(sel, key) {
            var el = jcSel(sel);
            if (!el) return;
            var lastValue = el.value;
            // Use 'change' (fires on blur/commit) rather than 'input' (fires per
            // keystroke). Input-per-keystroke would invalidate + rebuild the
            // service-status grid 30+ times during a TMDB key rotation, causing
            // visible lag on slower machines. Change-on-commit gets the same
            // correctness outcome without the churn.
            jcPageLifecycle.addListener(el, 'change', function() {
                if (el.value !== lastValue) {
                    invalidatePersistedTest(key);
                    lastValue = el.value;
                }
            });
        }
        _wireInvalidate('#TMDB_API_KEY',         'tmdb');
        _wireInvalidate('#seerr_TMDB_API_KEY', 'tmdb');
        _wireInvalidate('#seerrUrls',       'seerr');
        _wireInvalidate('#SeerrApiKey',     'seerr');

        // Parent checkbox change listeners
        var parentIds = {};
        PARENT_DEPS.forEach(function(dep) { parentIds[dep.parent] = true; });
        Object.keys(parentIds).forEach(function(id) {
            var el = jcById(id);
            if (el) jcPageLifecycle.addListener(el, 'change', updateAllDependencies);
        });

        var originalTestTmdb = testTmdbConnection;
        // Intentional wrap: the click handler is registered later by name, and
        // this extends it to refresh dependency toggles after a TMDB connection test.
        // eslint-disable-next-line no-func-assign
        testTmdbConnection = async function(event) {
            await originalTestTmdb(event);
            updateAllDependencies();
        };

        // === Arr Service Test Buttons ===

        /**
         * Produces a user-friendly error message from a connection test failure.
         * @param {Object} error - The ajax error object with a status property
         * @param {string} serviceName - Display name of the service
         * @param {string} url - The URL that was tested
         * @returns {string} Human-readable error message
         */
        function connectionErrorMessage(error, serviceName, url) {
            // surface backend's typed code/cf-ray so admins
            // see actionable messages (HtmlResponse, Cloudflare5xx, etc.)
            // instead of "API key rejected" for everything.
            // Jellyfin's ApiClient.ajax errors don't expose responseJSON;
            // they expose responseText. Parse it ourselves.
            var body = error && (error.responseJSON || (function () {
                try {
                    var txt = error.responseText || (error.response && error.response.text) || '';
                    if (typeof txt === 'string' && txt.length > 0 && txt.trim().charAt(0) === '{') {
                        return JSON.parse(txt);
                    }
                } catch (_) { /* not JSON, fall through */ }
                return null;
            })());
            if (body && body.code && body.message) {
                var prefix = body.cfRay ? '[' + serviceName + ' cf-ray=' + body.cfRay + '] ' : '';
                return prefix + body.message;
            }
            if (error.status === 502) return 'Could not reach ' + url + '. Check the URL is correct and ' + serviceName + ' is running.';
            if (error.status === 504) return 'Connection timed out. The server may be unreachable.';
            if (error.status === 401) return 'The API key was rejected. Check the key is correct.';
            if (error.status === 403) return 'Permission denied. Check the API key has the correct permissions, or that CSRF protection is not enabled in ' + serviceName + '.';
            if (error.status === 400) return 'Missing URL or API key.';
            if (error.status === 404) return 'The URL responded but did not look like a valid ' + serviceName + ' instance (HTTP 404 on /api/v1/user). It may be a reverse-proxy auth challenge.';
            return 'Connection to ' + serviceName + ' failed (error ' + (error.status || 'unknown') + ').';
        }

        async function testInstanceConnection(card) {
            var type = card.dataset.type;
            var urlVal = (card.querySelector('.arr-instance-url').value || '').trim();
            var apiKeyVal = (card.querySelector('.arr-instance-apikey').value || '').trim();
            var nameVal = card.querySelector('.arr-instance-name').value.trim() || (type === 'sonarr' ? 'Sonarr' : 'Radarr');
            var btn = card.querySelector('.arr-instance-test');
            var indicator = card.querySelector('.arr-instance-status');

            if (!urlVal || !apiKeyVal) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide both a URL and API key to test the connection.' });
                return;
            }

            var _testToken = (typeof beginConnectionTest === 'function') ? beginConnectionTest() : undefined;
            btn.disabled = true;
            indicator.textContent = 'sync';
            // Don't wipe the indicator's class wholesale with `className = ...` —
            // that drops `arr-instance-status`, the identifier used to re-query
            // this element on subsequent Test clicks. classList.add leaves the
            // identifier class intact so repeated tests on the same card work.
            indicator.classList.add('status-check');
            indicator.style.color = 'var(--primary-accent-color, #00a4dc)';

            var arrCacheKey = type + ':' + _jeNormalizeArrUrl(urlVal);
            try {
                var endpoint = type === 'sonarr' ? 'sonarr' : 'radarr';
                var validationUrl = ApiClient.getUrl('/JellyfinCanopy/arr/validate/' + endpoint, { url: urlVal });
                await ApiClient.ajax({ type: 'GET', url: validationUrl, dataType: 'json', headers: { 'X-Arr-ApiKey': apiKeyVal } });

                indicator.textContent = 'check_circle';
                indicator.style.color = '#52b54b';
                indicator.classList.remove('status-check');
                try { setConnectionTestResult(arrCacheKey, 'ok', 'Connected', _testToken); } catch (err) { /* cache is best-effort */ }
                jcTestAlert({ title: 'Success', message: 'Successfully connected to ' + nameVal + '!' });
            } catch (e) {
                indicator.classList.remove('status-check');
                indicator.textContent = 'error';
                indicator.style.color = '#dc3545';

                var msg = connectionErrorMessage(e, nameVal, urlVal);
                try {
                    var shortArrDetail = e && e.status === 401 ? 'API key rejected'
                        : e && (e.status === 500 || e.status === 0 || !e.status) ? 'Unreachable'
                        : 'Error ' + (e && e.status ? e.status : '?');
                    setConnectionTestResult(arrCacheKey, 'error', shortArrDetail, _testToken);
                } catch (err) { /* cache is best-effort */ }
                jcTestAlert({ title: 'Connection Failed', message: msg });
            } finally {
                btn.disabled = false;
            }

            updateAllDependencies();
        }

        // === URL Mapping Validation ===
        /**
         * Appends an issue message div to a validation result container.
         * @param {HTMLElement} container - The container element to append to
         * @param {string} text - The issue message text
         */
        function addIssue(container, text) {
            var div = document.createElement('div');
            div.style.cssText = 'margin-bottom: 0.5em;';
            div.textContent = text;
            container.appendChild(div);
        }

        /**
         * Validates URL mapping entries for syntactic correctness.
         * @param {Array<Object>} mappingDefs - Array of mapping definitions with inputId and expectedService
         * @param {string} btnId - DOM id of the validate button
         * @param {string} resultDivId - DOM id of the results container
         */
        async function validateMappingSet(mappingDefs, btnId, resultDivId) {
            var btn = jcById(btnId);
            var resultDiv = jcById(resultDivId);
            // Update button label safely whether the markup wraps the text
            // in a <span> (legacy emby-button pattern) or has bare text content.
            // The previous implementation assumed a <span> always existed and
            // threw `Cannot set properties of null` when it didn't, which silently
            // killed the rest of validation (button stayed disabled, result div
            // stayed empty, no error surfaced to the admin).
            function setBtnLabel(text) {
                var span = btn.querySelector('span');
                if (span) span.textContent = text;
                else btn.textContent = text;
            }
            btn.disabled = true;
            setBtnLabel('Validating...');
            resultDiv.textContent = '';
            resultDiv.style.display = 'block';
            resultDiv.style.backgroundColor = 'color-mix(in srgb, var(--primary-accent-color, #00a4dc) 10%, transparent)';
            resultDiv.style.borderLeft = '4px solid var(--primary-accent-color, #00a4dc)';
            resultDiv.textContent = 'Testing URLs...';

            // Collect all pairs with basic format validation first
            var pairs = [];
            var formatIssues = [];

            mappingDefs.forEach(function(m) {
                var textarea = jcById(m.id);
                if (!textarea) return;
                textarea.value.split('\n').forEach(function(line, idx) {
                    var trimmed = line.trim();
                    if (!trimmed) return;
                    var lineLabel = m.service + ' line ' + (idx + 1);
                    var parts = trimmed.split('|');
                    if (parts.length !== 2) {
                        formatIssues.push(lineLabel + ': Invalid format. Use jellyfin_url|' + m.service.toLowerCase() + '_url separated by a pipe (|).');
                        return;
                    }
                    var left = parts[0].trim();
                    var right = parts[1].trim();
                    if (!left || !right) {
                        formatIssues.push(lineLabel + ': Both sides of the pipe must have a URL.');
                        return;
                    }
                    if (!left.match(/^https?:\/\//i)) {
                        formatIssues.push(lineLabel + ': Left side (' + left + ') should start with http:// or https://.');
                        return;
                    }
                    if (!right.match(/^https?:\/\//i)) {
                        formatIssues.push(lineLabel + ': Right side (' + right + ') should start with http:// or https://.');
                        return;
                    }
                    pairs.push({ left: left, right: right, service: m.service, label: lineLabel });
                });
            });

            if (formatIssues.length > 0 && pairs.length === 0) {
                resultDiv.textContent = '';
                resultDiv.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
                resultDiv.style.borderLeft = '4px solid #dc3545';
                formatIssues.forEach(function(i) { addIssue(resultDiv, i); });
                btn.disabled = false;
                setBtnLabel('Validate Mappings');
                return;
            }

            if (pairs.length === 0 && formatIssues.length === 0) {
                resultDiv.style.display = 'none';
                btn.disabled = false;
                setBtnLabel('Validate Mappings');
                return;
            }

            // Syntax-only validation: ensure each URL parses as a valid URL
            // and that the two sides of a mapping aren't identical. We used to
            // probe each URL server-side (and fall back to a browser probe) and
            // identify whether the far end was actually Sonarr/Radarr/Jellyfin/…
            // but mappings are only used to rewrite link hrefs, so "is this
            // URL parseable and distinct from its pair" is the only thing that
            // actually needs to hold. Probing breaks for anyone behind an auth
            // proxy (Authentik, Authelia, Cloudflare Access, …) because the
            // backend never reaches the service to identify it.
            var issues = formatIssues.slice();
            var warnings = [];
            var good = 0;

            pairs.forEach(function(p) {
                var leftTrim  = p.left.replace(/\/+$/, '');
                var rightTrim = p.right.replace(/\/+$/, '');

                function urlOk(u) {
                    try { var parsed = new URL(u); return !!parsed.host; }
                    catch (e) { return false; }
                }

                if (!urlOk(p.left)) {
                    issues.push(p.label + ': Left side (' + p.left + ') is not a valid URL.');
                    return;
                }
                if (!urlOk(p.right)) {
                    issues.push(p.label + ': Right side (' + p.right + ') is not a valid URL.');
                    return;
                }
                if (leftTrim.toLowerCase() === rightTrim.toLowerCase()) {
                    issues.push(p.label + ': Both sides are the same URL. Left should be Jellyfin, right should be ' + p.service + '.');
                    return;
                }

                good++;
            });

            // Display results
            resultDiv.textContent = '';
            if (issues.length === 0 && warnings.length === 0) {
                resultDiv.style.backgroundColor = 'rgba(82, 181, 75, 0.15)';
                resultDiv.style.borderLeft = '4px solid #52b54b';
                var icon = document.createElement('i');
                icon.className = 'material-icons';
                icon.style.cssText = 'vertical-align: middle; color: #52b54b; margin-right: 0.5em;';
                icon.textContent = 'check_circle';
                resultDiv.appendChild(icon);
                resultDiv.appendChild(document.createTextNode(good + ' mapping' + (good !== 1 ? 's' : '') + ' verified.'));
            } else {
                if (issues.length > 0) {
                    resultDiv.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
                    resultDiv.style.borderLeft = '4px solid #dc3545';
                    issues.forEach(function(i) { addIssue(resultDiv, i); });
                } else {
                    resultDiv.style.backgroundColor = 'rgba(255, 193, 7, 0.15)';
                    resultDiv.style.borderLeft = '4px solid #ffc107';
                }
                warnings.forEach(function(w) { addIssue(resultDiv, w); });
                if (good > 0) {
                    addIssue(resultDiv, good + ' other mapping' + (good !== 1 ? 's' : '') + ' verified.');
                }
            }

            btn.disabled = false;
            setBtnLabel('Validate Mappings');
        }

        // Per-service mapping validation helpers. Each service's Validate button
        // collects only its own instances' mappings (plus Bazarr's single field),
        // feeds them through validateMappingSet, and cleans up any temp textareas
        // it creates. Split from the old "validate everything" button so results
        // land next to the service being tested.
        function _jeValidateInstanceMappings(type, btnId, resultId, displayName) {
            var mappingDefs = [];
            var createdTempIds = [];
            // Wipe orphan temp textareas from a prior run (lets us also accept
            // those leftover from a previous failed validation with the same
            // prefix).
            jcSelAll('textarea[data-arr-validate-temp-' + type + '="true"]').forEach(function(el) { el.remove(); });

            var listId = type + 'InstancesList';
            jcSelAll('#' + listId + ' .arr-instance-card').forEach(function(card, idx) {
                var name = card.querySelector('.arr-instance-name').value.trim() || (displayName + ' ' + (idx + 1));
                var textarea = card.querySelector('.arr-instance-urlmappings');
                if (textarea && textarea.value.trim()) {
                    var tempId = 'arr-validate-' + type + '-' + idx;
                    var temp = document.createElement('textarea');
                    temp.id = tempId;
                    temp.value = textarea.value;
                    temp.style.display = 'none';
                    temp.setAttribute('data-arr-validate-temp-' + type, 'true');
                    // Append inside the resolved page (#167): validateMappingSet and
                    // cleanup resolve these scratch nodes via page-scoped jcById, so
                    // a body-level temp would be invisible to the lookup — the pair
                    // list would come back empty and the temps would never be
                    // removed. jcSelAll's page-scoped orphan wipe above matches too.
                    (page || document.body).appendChild(temp);
                    createdTempIds.push(tempId);
                    mappingDefs.push({ id: tempId, service: name });
                }
            });

            if (mappingDefs.length === 0) {
                Dashboard.alert({ title: 'No Mappings', message: 'No URL mappings configured for ' + displayName + '. Expand an instance card and fill in the URL Mappings field to validate.' });
                return;
            }
            var cleanup = function() {
                createdTempIds.forEach(function(id) {
                    var el = jcById(id);
                    if (el) el.remove();
                });
            };
            validateMappingSet(mappingDefs, btnId, resultId)
                .finally(cleanup)
                .catch(function(err) {
                    // Without an explicit .catch, a thrown rejection (missing btn
                    // node, pre-await TypeError, failed Promise.all inside the
                    // validator) would leave the Validate button stuck on its
                    // disabled/"Validating..." state and the admin with no visible
                    // signal beyond an Uncaught (in promise) message in devtools.
                    console.error('[JC] mapping validation crashed:', err);
                    var btn = jcById(btnId);
                    if (btn) {
                        btn.disabled = false;
                        var span = btn.querySelector('span');
                        if (span) span.textContent = 'Validate Mappings';
                        else btn.textContent = 'Validate Mappings';
                    }
                    try {
                        Dashboard.alert({ title: 'Validation error', message: 'Mapping validation crashed unexpectedly — check the browser console for details.' });
                    } catch (alertErr) {
                        console.warn('[JC] Dashboard.alert threw during validation-error notify:', alertErr);
                        try { window.alert('Validation error: ' + ((err && err.message) || err)); } catch (_) { /* last-resort notify — if alert() itself throws we've given up */ }
                    }
                });
        }

        var validateSonarrMappingsBtn = jcById('validateSonarrMappingsBtn');
        if (validateSonarrMappingsBtn) {
            jcPageLifecycle.addListener(validateSonarrMappingsBtn, 'click', function() {
                _jeValidateInstanceMappings('sonarr', 'validateSonarrMappingsBtn', 'sonarrMappingsValidationResult', 'Sonarr');
            });
        }
        var validateRadarrMappingsBtn = jcById('validateRadarrMappingsBtn');
        if (validateRadarrMappingsBtn) {
            jcPageLifecycle.addListener(validateRadarrMappingsBtn, 'click', function() {
                _jeValidateInstanceMappings('radarr', 'validateRadarrMappingsBtn', 'radarrMappingsValidationResult', 'Radarr');
            });
        }
        // Safety-net wrapper used by the three mapping-validate buttons.
        // Mirrors the .catch + button-reset handler inside _jeValidateInstanceMappings
        // so Bazarr/Seerr direct callers get the same treatment. Without this,
        // a rejected validateMappingSet() promise would leave the button stuck on
        // "Validating..." with only an Uncaught (in promise) in devtools.
        function _jeRunMappingValidation(mappingDefs, btnId, resultId) {
            validateMappingSet(mappingDefs, btnId, resultId).catch(function(err) {
                console.error('[JC] mapping validation crashed:', err);
                var b = jcById(btnId);
                if (b) {
                    b.disabled = false;
                    var span = b.querySelector('span');
                    if (span) span.textContent = 'Validate Mappings';
                    else b.textContent = 'Validate Mappings';
                }
                try {
                    Dashboard.alert({ title: 'Validation error', message: 'Mapping validation crashed unexpectedly — check the browser console for details.' });
                } catch (alertErr) {
                    console.warn('[JC] Dashboard.alert threw during validation-error notify:', alertErr);
                    try { window.alert('Validation error: ' + ((err && err.message) || err)); } catch (_) { /* last-resort notify — if alert() itself throws we've given up */ }
                }
            });
        }

        var validateBazarrMappingsBtn = jcById('validateBazarrMappingsBtn');
        if (validateBazarrMappingsBtn) {
            jcPageLifecycle.addListener(validateBazarrMappingsBtn, 'click', function() {
                var mappings = jcById('bazarrUrlMappings');
                if (!mappings || !mappings.value.trim()) {
                    Dashboard.alert({ title: 'No Mappings', message: 'No Bazarr URL mappings configured. Fill in the Bazarr URL Mappings field above to validate.' });
                    return;
                }
                _jeRunMappingValidation(
                    [{ id: 'bazarrUrlMappings', service: 'Bazarr' }],
                    'validateBazarrMappingsBtn', 'bazarrMappingsValidationResult'
                );
            });
        }

        var validateSeerrMappingsBtn = jcById('validateSeerrMappingsBtn');
        if (validateSeerrMappingsBtn) {
            jcPageLifecycle.addListener(validateSeerrMappingsBtn, 'click', function() {
                _jeRunMappingValidation(
                    [{ id: 'seerrUrlMappings', service: 'Seerr' }],
                    'validateSeerrMappingsBtn', 'seerrMappingsValidationResult'
                );
            });
        }

        jcPageLifecycle.addListener(clearTagsCacheBtn, 'click', async () => {
            if (confirm("Clear all client caches?\n\nThis will force all clients to clear their quality and genre tag caches on next page load.")) {
                Dashboard.showLoadingMsg();
                try {
                    const config = await ApiClient.getPluginConfiguration(pluginId);
                    config.ClearLocalStorageTimestamp = Date.now();
                    await ApiClient.updatePluginConfiguration(pluginId, config);
                    Dashboard.hideLoadingMsg();
                    Dashboard.alert({
                        title: 'Success',
                        message: 'Cache clear signal sent. All clients will clear their caches on next page load.'
                    });
                } catch (e) {
                    Dashboard.hideLoadingMsg();
                    console.error('Failed to set cache clear timestamp:', e);
                    Dashboard.alert({
                        title: 'Error',
                        message: 'Failed to set cache clear timestamp. Check server logs for details.'
                    });
                }
            }
        });
        jcPageLifecycle.addListener(testSeerrBtn, 'click', testSeerrConnection);

        /* jc-seerr-scan-helpers:start */
        function jcNormalizeSeerrIdentityDomain(value) {
            const trimmed = String(value || '').trim().replace(/\/+$/, '');
            if (!trimmed) return '';

            // WHATWG URL repairs forms such as `http:seerr.example` into an
            // authority URL, while System.Uri deliberately retains that input
            // as invalid/no-host. Require the explicit configuration grammar
            // before parsing so manual and background scans use one identity
            // policy and an unsaved malformed value is never silently retargeted.
            if (!/^https?:\/\//i.test(trimmed)) return trimmed;

            try {
                const parsed = new URL(trimmed);
                if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
                    || !parsed.hostname
                    || parsed.username
                    || parsed.password
                    || parsed.search
                    || parsed.hash) {
                    // Configuration validation owns malformed URL reporting.
                    // Preserve the exact trimmed value here so duplicate invalid
                    // entries are still collapsed without changing their meaning.
                    return trimmed;
                }

                const path = parsed.pathname === '/'
                    ? ''
                    : parsed.pathname.replace(/\/+$/, '');
                // URL canonicalizes the case-insensitive scheme/host and removes
                // default ports; pathname casing remains identity-significant.
                const normalizedHostname = parsed.hostname.endsWith('.') && !parsed.hostname.endsWith('..')
                    ? parsed.hostname.slice(0, -1)
                    : parsed.hostname;
                if (!normalizedHostname) return trimmed;
                return parsed.protocol + '//' + normalizedHostname
                    + (parsed.port ? ':' + parsed.port : '') + path;
            } catch (_) {
                return trimmed;
            }
        }

        function jcParseSeerrIdentityDomains(rawUrls) {
            const seen = new Set();
            const domains = [];

            String(rawUrls || '').split(/[\r\n,]+/).forEach(value => {
                // Match SeerrUrlIdentity.ParseConfigured in the server project.
                const domain = jcNormalizeSeerrIdentityDomain(value);
                if (domain && !seen.has(domain)) {
                    seen.add(domain);
                    domains.push(domain);
                }
            });

            return domains;
        }

        async function jcDispatchSeerrScanDomains(rawUrls, send, signal) {
            const domains = jcParseSeerrIdentityDomains(rawUrls);
            if (signal && signal.aborted) {
                return { domains, results: [], cancelled: true };
            }

            // One server request owns the complete manual batch. This lets the lifecycle state
            // machine atomically drain a pending automatic timer without a later per-domain call
            // duplicating work that the drained batch already covered.
            try {
                const response = await send(domains, signal);
                if (signal && signal.aborted) {
                    return { domains, results: [], cancelled: true };
                }

                const upstream = response && Array.isArray(response.results)
                    ? response.results
                    : [];
                const results = domains.map(domain => {
                    const row = upstream.find(candidate => candidate
                        && jcNormalizeSeerrIdentityDomain(candidate.domain) === domain);
                    if (row) {
                        return {
                            domain,
                            ok: row.ok === true,
                            error: row.message ? String(row.message) : ''
                        };
                    }

                    return {
                        domain,
                        ok: Boolean(response && response.ok === true),
                        error: response && response.message ? String(response.message) : ''
                    };
                });
                return { domains, results, cancelled: false };
            } catch (error) {
                if (signal && signal.aborted) {
                    return { domains, results: [], cancelled: true };
                }
                return {
                    domains,
                    results: domains.map(domain => ({ domain, ok: false, error })),
                    cancelled: false
                };
            }
        }

        function jcSummarizeSeerrScanDispatch(dispatch) {
            const total = dispatch.domains.length;
            const succeeded = dispatch.results.filter(result => result.ok).length;
            const failed = total - succeeded;
            return {
                total,
                succeeded,
                failed,
                outcome: failed === 0 ? 'success' : (succeeded > 0 ? 'partial' : 'failure')
            };
        }
        /* jc-seerr-scan-helpers:end */

        let activeSeerrScanController = null;

        function cancelActiveSeerrScan() {
            if (activeSeerrScanController) {
                activeSeerrScanController.abort();
                activeSeerrScanController = null;
            }
        }

        // Jellyfin dashboard builds have used both lifecycle event names. The
        // dispatch helper also checks the signal between domains, so leaving the
        // page cannot start another POST after the current request settles.
        // Lifecycle owned (#167 finding 1): both cleanup hooks sit on the
        // long-lived page element, so a teardown→same-page reinstall would stack
        // duplicate abort handlers. Track them so teardown reclaims the prior set.
        jcPageLifecycle.addListener(page, 'pagehide', cancelActiveSeerrScan);
        jcPageLifecycle.addListener(page, 'viewhide', cancelActiveSeerrScan);

        async function triggerSeerrScanNow() {
            const rawUrls = jcSel('#seerrUrls').value || '';
            const domains = jcParseSeerrIdentityDomains(rawUrls);
            const apiKey = (jcSel('#SeerrApiKey').value || '').trim();
            const btn = jcSel('#triggerSeerrScanNowBtn');
            const status = jcSel('#triggerSeerrScanNowStatus');

            if (!domains.length || !apiKey) {
                Dashboard.alert({ title: 'Missing Information', message: 'Please provide at least one Seerr URL and an API key in the Setup section above.' });
                return;
            }

            cancelActiveSeerrScan();
            const controller = new AbortController();
            activeSeerrScanController = controller;
            btn.disabled = true;
            status.textContent = 'sync';
            status.className = 'material-icons status-check';
            status.style.color = '#00a4dc';

            try {
                const dispatch = await jcDispatchSeerrScanDomains(rawUrls, async (domains, signal) => {
                    const triggerUrl = ApiClient.getUrl('/JellyfinCanopy/seerr/trigger-recently-added-scan', { urls: domains.join('\n') });
                    return ApiClient.ajax({
                        type: 'POST',
                        url: triggerUrl,
                        dataType: 'json',
                        headers: { 'X-Arr-ApiKey': apiKey },
                        signal
                    });
                }, controller.signal);

                if (dispatch.cancelled || controller.signal.aborted) {
                    return;
                }

                const summary = jcSummarizeSeerrScanDispatch(dispatch);
                const { succeeded, failed, total } = summary;
                dispatch.results.filter(result => !result.ok).forEach(result => {
                    console.error('Seerr scan trigger failed for ' + result.domain + ':', result.error || 'Upstream rejected the trigger');
                });

                if (summary.outcome === 'success') {
                    status.textContent = 'check_circle';
                    status.style.color = '#52b54b';
                    Dashboard.alert({
                        title: 'Scans Triggered',
                        message: `Triggered "Jellyfin Recently Added Scan" for all ${total} Seerr identity domain${total === 1 ? '' : 's'}.`
                    });
                } else if (summary.outcome === 'partial') {
                    status.textContent = 'warning';
                    status.style.color = '#ffb300';
                    Dashboard.alert({
                        title: 'Scans Partially Triggered',
                        message: `Triggered ${succeeded} of ${total} Seerr identity domains; ${failed} failed. Each URL was attempted once. Check the browser console and server log for failure details.`
                    });
                } else {
                    status.textContent = 'error';
                    status.style.color = '#dc3545';
                    Dashboard.alert({
                        title: 'Trigger Failed',
                        message: `None of the ${total} Seerr identity domain${total === 1 ? '' : 's'} accepted the scan trigger. Check the browser console and server log for failure details.`
                    });
                }
            } finally {
                if (activeSeerrScanController === controller) {
                    activeSeerrScanController = null;
                }
                if (!activeSeerrScanController) {
                    btn.disabled = false;
                    status.classList.remove('status-check');
                    if (controller.signal.aborted) {
                        status.textContent = '';
                        status.style.color = '';
                    }
                }
            }
        }

        jcPageLifecycle.addListener(jcSel('#triggerSeerrScanNowBtn'), 'click', triggerSeerrScanNow);

        /**
         * Quick Action: re-test every external-service connection by proxying
         * clicks to the existing per-service test buttons. Preserves the per-
         * button UX (spinners, toasts, status-card updates) without duplicating
         * logic. Does NOT fabricate a cache — Phase 4 layers a real test cache
         * on top.
         *
         * Services invoked:
         *   - TMDB: one `.testTmdbBtn` click (multiple copies exist across tabs
         *     but any one test updates the shared status card)
         *   - Seerr: `#testSeerrBtn` when Seerr is enabled + URL + key set
         *   - Sonarr / Radarr: every `.arr-instance-test` inside the instance
         *     lists that has a URL + API key populated
         *
         * Skipping an unconfigured service is intentional — clicking a test
         * button with empty fields would pop a Dashboard.alert per service,
         * which is noisy for a "one-shot retest" action.
         */
        // Client-side throttle + in-flight lock for the Re-test-all batch.
        // The button is disabled for the full cooldown window so rapid
        // clicks can't fire ~8 parallel external-API tests per click. This
        // is NOT a security boundary — a determined user could still spam
        // via devtools — it's a guardrail against well-intentioned double-
        // clicks and page-reload retries.
        // Minimum time the Re-test-all button stays disabled even if every
        // test finishes instantly. Acts as the rate-limit floor so rapid
        // re-clicks can't fire dozens of external API tests per second.
        var RETEST_ALL_MIN_COOLDOWN_MS = 4 * 1000;
        // Hard upper bound for the polling loop. If a test still hasn't
        // resolved after this long, we force-release anyway so the UI
        // doesn't sit "Retesting…" forever on a hung connection.
        var RETEST_ALL_MAX_WAIT_MS = 25 * 1000;
        var _jeRetestAllCooldownUntil = 0;
        var _jeRetestAllReenableTimer = null;
        var _jeRetestAllPollTimer = null;

        function _setRetestAllButtonLabel(btn, text) {
            if (!btn) return;
            var labelEl = btn.querySelector('.jc-quick-action-title');
            if (labelEl) labelEl.textContent = text;
        }

        var retestAllConnectionsBtn = jcById('retestAllConnectionsBtn');
        if (retestAllConnectionsBtn) {
            var _retestAllOriginalLabel = retestAllConnectionsBtn.querySelector('.jc-quick-action-title');
            _retestAllOriginalLabel = _retestAllOriginalLabel ? _retestAllOriginalLabel.textContent : 'Re-test all service connections';

            // The batch poll interval and hard-stop re-enable timeout below are
            // self-terminating (releaseRetestBatch clears both, and the hard-stop
            // timeout is a backstop), and each visit's handlers/lookups are scoped
            // to its own view, so a mid-flight re-test on a replaced visit winds
            // itself down without touching the live page. (#167.)

            jcPageLifecycle.addListener(retestAllConnectionsBtn, 'click', function() {
                // Throttle: block rapid re-clicks within the cooldown window.
                var now = Date.now();
                if (now < _jeRetestAllCooldownUntil) {
                    var remainSec = Math.ceil((_jeRetestAllCooldownUntil - now) / 1000);
                    try {
                        Dashboard.alert({
                            title: 'Please wait',
                            message: 'Re-test is rate-limited. Try again in ' + remainSec + ' s.'
                        });
                    } catch (e) { /* ignore */ }
                    return;
                }

                // Invalidate the cache up front so every checklist row flips
                // to "pending" immediately; the individual test handlers will
                // repopulate it as they finish.
                try { clearConnectionTestCache(); } catch (e) { /* renderChecklist logs */ }

                // Suppress per-test Dashboard.alert dialogs for the duration
                // of this batch — per-service indicators + the Integration
                // Health rows already communicate results.
                _jeSuppressTestAlerts = true;
                _jeRetestAllCooldownUntil = now + RETEST_ALL_MIN_COOLDOWN_MS;
                retestAllConnectionsBtn.disabled = true;
                _setRetestAllButtonLabel(retestAllConnectionsBtn, 'Retesting…');

                var tested = 0;

                // TMDB — one click is enough; pages share the same backing key
                var tmdbBtn = jcSel('.testTmdbBtn');
                if (tmdbBtn && !tmdbBtn.disabled) { tmdbBtn.click(); tested++; }

                // Seerr — only if enabled with a URL + key (otherwise button
                // would show a "missing info" toast, which is noisy for a
                // batch re-test action).
                var seerrEnabled = jcSel('#seerrEnabled');
                var seerrUrls = jcSel('#seerrUrls');
                var seerrKey = jcSel('#SeerrApiKey');
                if (seerrEnabled && seerrEnabled.checked
                    && seerrUrls && seerrUrls.value.trim()
                    && seerrKey && seerrKey.value.trim()
                    && testSeerrBtn && !testSeerrBtn.disabled) {
                    testSeerrBtn.click();
                    tested++;
                }

                // Sonarr / Radarr — per-instance tests. The per-instance test
                // function itself guards against empty URL/API-key, so we
                // don't need to re-check here; we just skip already-disabled
                // buttons (mid-flight tests).
                var arrBtns = jcSelAll('.arr-instance-test');
                arrBtns.forEach(function(btn) {
                    var card = btn.closest('.arr-instance-card');
                    if (!card) return;
                    var urlEl = card.querySelector('.arr-instance-url');
                    var keyEl = card.querySelector('.arr-instance-apikey');
                    if (!urlEl || !keyEl) return;
                    if (!urlEl.value.trim() || !keyEl.value.trim()) return;
                    if (btn.disabled) return;
                    btn.click();
                    tested++;
                });

                // Always refresh the dashboard dots so the user sees feedback
                // even when no service was re-tested.
                try { updateStatusDashboard(); } catch (e) { /* logged inside */ }

                if (tested === 0) {
                    _jeSuppressTestAlerts = false;
                    retestAllConnectionsBtn.disabled = false;
                    _setRetestAllButtonLabel(retestAllConnectionsBtn, _retestAllOriginalLabel);
                    _jeRetestAllCooldownUntil = 0; // reset cooldown — nothing fired
                    try {
                        Dashboard.alert({
                            title: 'Nothing to re-test',
                            message: 'Enable and configure at least one service (TMDB, Seerr, Sonarr, or Radarr) before running a re-test.'
                        });
                    } catch (e) { /* ignore */ }
                    return;
                }

                // The individual test functions don't return promises
                // (they're event handlers fired via .click()), so we poll
                // the DOM for the "in-flight" signal each test sets on
                // start: the `.status-check` class on its status indicator.
                // When no indicators still carry that class, every test
                // has resolved — release the button immediately. Falls
                // back to a hard max-wait so a hung request doesn't leave
                // the button stuck on "Retesting…".
                clearTimeout(_jeRetestAllReenableTimer);
                clearInterval(_jeRetestAllPollTimer);
                var batchStartedAt = Date.now();
                function releaseRetestBatch() {
                    clearInterval(_jeRetestAllPollTimer);
                    clearTimeout(_jeRetestAllReenableTimer);
                    _jeSuppressTestAlerts = false;
                    retestAllConnectionsBtn.disabled = false;
                    _setRetestAllButtonLabel(retestAllConnectionsBtn, _retestAllOriginalLabel);
                    try { renderChecklist(); } catch (e) { /* logged */ }
                }
                _jeRetestAllPollTimer = setInterval(function() {
                    var elapsed = Date.now() - batchStartedAt;
                    // `.status-check` is applied on test START and removed on
                    // test RESOLVE (success or failure), so it's an accurate
                    // "in-flight" signal for the three test functions.
                    var inFlight = jcSelAll('.status-check').length;
                    // Release when BOTH:
                    //  - no tests still in flight (UI has caught up), and
                    //  - the min-cooldown floor has elapsed (rate limit).
                    // The floor ensures a user who hits retest-all with zero
                    // real tests configured still has the button disabled long
                    // enough to prevent double-run, and covers the first-tick
                    // race where indicators haven't swapped to 'sync' yet.
                    if (inFlight === 0 && elapsed >= RETEST_ALL_MIN_COOLDOWN_MS) {
                        releaseRetestBatch();
                    } else if (elapsed >= RETEST_ALL_MAX_WAIT_MS) {
                        console.warn('[JC] retest-all: giving up on ' + inFlight + ' in-flight test(s) after ' + elapsed + 'ms');
                        releaseRetestBatch();
                    }
                }, 300);
                // Hard-stop safety net in case setInterval is suspended
                // (backgrounded tab, browser throttling, etc.).
                _jeRetestAllReenableTimer = setTimeout(releaseRetestBatch, RETEST_ALL_MAX_WAIT_MS + 500);
            });
        }

        /**
         * Quick Action: proxy the "Clear client tag caches" button from the
         * Display tab. Keeps the canonical clear-flow in one place while
         * giving the action a home on Overview.
         */
        var clearTagCachesQuickBtn = jcById('clearTagCachesQuickBtn');
        if (clearTagCachesQuickBtn && clearTagsCacheBtn) {
            jcPageLifecycle.addListener(clearTagCachesQuickBtn, 'click', function() {
                clearTagsCacheBtn.click();
            });
        }

        /**
         * Syncs the "Clear all client tag caches" quick-action button visibility
         * with the server-mode toggle — it's only relevant when server-side cache
         * is disabled.
         */
        function updateClearTagCachesQuickBtnVisibility() {
            var serverModeCheckbox = jcById('tagCacheServerMode');
            if (!clearTagCachesQuickBtn || !serverModeCheckbox) return;
            clearTagCachesQuickBtn.style.display = serverModeCheckbox.checked ? 'none' : '';
        }

        /**
         * Updates the blocked users count badge in the collapsible summary.
         */
        function updateBlockedUsersCount() {
            const total = jcSelAll('.blockedUserCheckbox:checked').length;
            const countEl = jcById('blockedUsersCount');
            if (countEl) {
                countEl.textContent = total > 0 ? '(' + total + ' blocked)' : '(none)';
            }
        }

        /**
         * Loads all Jellyfin users and renders a checkbox list for the blocklist.
         * Pre-checks users whose IDs appear in the saved blocklist config.
         * @param {string} blockedIdsString - Comma-separated dashless user IDs to pre-select.
         */
        // Tracks whether the most recent loadBlockedUsersList successfully rendered
        // checkboxes. If /Users API fails, syncBlockedUsersToHiddenInput must not
        // run — otherwise it would wipe the entire blocklist on save.
        let _blockedUsersLoaded = false;

        async function loadBlockedUsersList(blockedIdsString) {
            const container = jcById('blockedUsersContainer');
            const blockedSet = new Set(
                (blockedIdsString || '').split(/[,\r\n]+/).map(id => id.trim().replace(/-/g, '').toLowerCase()).filter(Boolean)
            );

            _blockedUsersLoaded = false;
            try {
                const users = await ApiClient.getUsers();
                container.textContent = '';
                users.sort((a, b) => a.Name.localeCompare(b.Name));
                users.forEach(user => {
                    const normalizedId = user.Id.replace(/-/g, '').toLowerCase();
                    const div = document.createElement('div');
                    div.className = 'checkboxContainer';
                    div.style.marginBottom = '0.3em';

                    const label = document.createElement('label');
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.setAttribute('is', 'emby-checkbox');
                    checkbox.className = 'blockedUserCheckbox';
                    checkbox.dataset.userid = normalizedId;
                    checkbox.checked = blockedSet.has(normalizedId);
                    checkbox.addEventListener('change', updateBlockedUsersCount);

                    const span = document.createElement('span');
                    span.textContent = user.Name;

                    label.appendChild(checkbox);
                    label.appendChild(span);
                    div.appendChild(label);
                    container.appendChild(div);
                });
                updateBlockedUsersCount();
                _blockedUsersLoaded = true;

                // Show scroll hint if content overflows, hide it once user scrolls to bottom
                const scrollHint = jcById('blockedUsersScrollHint');
                if (scrollHint) {
                    const updateHint = () => {
                        const atBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 4;
                        scrollHint.style.display = (container.scrollHeight > container.clientHeight && !atBottom) ? 'block' : 'none';
                    };
                    // Check after render
                    requestAnimationFrame(updateHint);
                    // The container is a PERSISTENT in-page element and
                    // loadBlockedUsersList runs on every loadConfig (every
                    // pageshow), so a raw listener stacked one updateHint per
                    // visit and was never reclaimed (#167 finding 4). Route it
                    // through the owner (teardown reclaims it) and guard by the
                    // owner token so repeated loads within one visit don't stack.
                    if (container.dataset.jcScrollWired !== jcPageLifecycle.id) {
                        container.dataset.jcScrollWired = jcPageLifecycle.id;
                        jcPageLifecycle.addListener(container, 'scroll', updateHint);
                    }
                }
            } catch (e) {
                container.textContent = 'Could not load users.';
                console.error('Failed to load users for blocklist:', e);
                _blockedUsersLoaded = false;
            }
        }

        /**
         * Syncs checked blocked-user checkboxes into the hidden input for config save.
         * Skipped if loadBlockedUsersList failed — otherwise we'd wipe the whole
         * blocklist on save.
         */
        function syncBlockedUsersToHiddenInput() {
            if (!_blockedUsersLoaded) {
                console.warn('Jellyfin Canopy: skipping blocklist sync — user list failed to load. Existing config preserved.');
                return;
            }
            const checkboxes = jcSelAll('.blockedUserCheckbox:checked');
            const ids = Array.from(checkboxes).map(cb => cb.dataset.userid);
            jcSel('#seerrImportBlockedUsers').value = ids.join(',');
        }

        jcPageLifecycle.addListener(jcById('btnImportSeerrUsers'), 'click', async () => {
            const btn = jcById('btnImportSeerrUsers');
            const resultDiv = jcById('importUsersResult');
            btn.disabled = true;
            btn.textContent = 'Saving config...';
            resultDiv.style.display = 'none';

            try {
                // Save config first so the server uses the current blocklist
                await saveConfig(new Event('submit'));
            } catch (e) {
                resultDiv.style.display = 'block';
                resultDiv.textContent = 'Could not save config. Import was not attempted.';
                resultDiv.style.color = '#f44336';
                console.error('Config save failed before import:', e);
                btn.disabled = false;
                btn.textContent = 'Import Users Now';
                return;
            }

            try {
                btn.textContent = 'Importing...';
                const response = await ApiClient.fetch({
                    url: ApiClient.getUrl('JellyfinCanopy/seerr/import-users'),
                    type: 'POST',
                    dataType: 'json'
                });

                // Handle different response shapes defensively (object, wrapped object, or JSON string)
                let payload = response;
                if (typeof payload === 'string') {
                    try {
                        payload = JSON.parse(payload);
                    } catch (_) {
                        payload = {};
                    }
                }
                if (payload && payload.data && typeof payload.data === 'object') {
                    payload = payload.data;
                }

                const usersImported = Number(payload && payload.usersImported);
                const totalUsers = Number(payload && payload.totalUsers);
                const importedCount = Number.isFinite(usersImported) ? usersImported : 0;
                const totalCount = Number.isFinite(totalUsers) ? totalUsers : 0;
                const errors = Array.isArray(payload && payload.errors) ? payload.errors : [];

                resultDiv.style.display = 'block';
                // surface backend errors[] so the admin sees WHY
                // partial imports failed (email collision, 401, etc.) instead
                // of a flat "Imported 0 new users" with no diagnosis.
                while (resultDiv.firstChild) resultDiv.removeChild(resultDiv.firstChild);
                const summary = document.createElement('div');
                summary.textContent = 'Imported ' + importedCount + ' new user(s) out of ' + totalCount + ' total.';
                summary.style.color = errors.length > 0 ? '#ff9800' : '#4caf50';
                resultDiv.appendChild(summary);
                if (errors.length > 0) {
                    const list = document.createElement('ul');
                    list.style.marginTop = '6px';
                    list.style.color = '#f44336';
                    list.style.fontSize = '0.9em';
                    for (const err of errors) {
                        const li = document.createElement('li');
                        li.textContent = String(err);
                        list.appendChild(li);
                    }
                    resultDiv.appendChild(list);
                }
            } catch (e) {
                resultDiv.style.display = 'block';
                while (resultDiv.firstChild) resultDiv.removeChild(resultDiv.firstChild);
                const msg = document.createElement('div');
                msg.textContent = 'Import failed. Check Seerr configuration and API key permissions.';
                msg.style.color = '#f44336';
                resultDiv.appendChild(msg);
                // Show response.errors[] when the server returned 502 with structured errors.
                const detailErrors = e && e.responseJSON && Array.isArray(e.responseJSON.errors) ? e.responseJSON.errors : [];
                if (detailErrors.length > 0) {
                    const list = document.createElement('ul');
                    list.style.marginTop = '6px';
                    list.style.color = '#f44336';
                    list.style.fontSize = '0.9em';
                    for (const err of detailErrors) {
                        const li = document.createElement('li');
                        li.textContent = String(err);
                        list.appendChild(li);
                    }
                    resultDiv.appendChild(list);
                }
                console.error('User import failed:', e);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Import Users Now';
            }
        });

        // Permission Audit — admin scans every Jellyfin user for missing Seerr
        // permissions required by the features the admin has currently enabled.
        // GETs /JellyfinCanopy/seerr/permission-audit which returns
        // [{ jellyfinUsername, linked, issues:[...] }]. We render a summary
        // line + a table of users with gaps (warnings/unlinked first, then
        // a collapsed "OK" group). Errors surface inline in the result div
        // and are also logged to console.error so the admin can debug.
        (function wirePermissionAudit() {
            var btn = jcById('btnPermissionAudit');
            if (!btn) return;
            // Resilient label setter (mirrors the validate-mapping fix): some
            // emby-button markup wraps text in a <span>, some places it bare.
            function setBtnLabel(text) {
                var span = btn.querySelector('span');
                if (span) span.textContent = text;
                else btn.textContent = text;
            }
            jcPageLifecycle.addListener(btn, 'click', async function() {
                var resultDiv = jcById('permissionAuditResult');
                btn.disabled = true;
                setBtnLabel('Running…');
                resultDiv.style.display = 'none';
                resultDiv.innerHTML = '';
                try {
                    var data = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/JellyfinCanopy/seerr/permission-audit'),
                        dataType: 'json'
                    });
                    var withIssues = data.filter(function(u) { return u.linked && u.issues && u.issues.length > 0; });
                    var ok         = data.filter(function(u) { return u.linked && (!u.issues || u.issues.length === 0); });
                    var unlinked   = data.filter(function(u) { return !u.linked; });

                    // Summary panel with a title line and chip-based counts
                    var summaryEl = document.createElement('div');
                    summaryEl.className = 'jc-audit-summary';
                    var summaryTitle = document.createElement('div');
                    summaryTitle.className = 'jc-audit-summary-title';
                    if (withIssues.length === 0 && unlinked.length === 0) {
                        summaryTitle.textContent = '✅ All ' + ok.length + ' linked user(s) have the required permissions.';
                        summaryEl.appendChild(summaryTitle);
                    } else {
                        summaryTitle.textContent = 'Audit complete — review the users below.';
                        summaryEl.appendChild(summaryTitle);
                        var chips = document.createElement('div');
                        chips.className = 'jc-audit-summary-chips';
                        function chip(kind, icon, count, label) {
                            if (!count) return;
                            var c = document.createElement('span');
                            c.className = 'jc-audit-chip jc-audit-chip-' + kind;
                            var i = document.createElement('i');
                            i.className = 'material-icons';
                            i.setAttribute('aria-hidden', 'true');
                            i.textContent = icon;
                            c.appendChild(i);
                            c.appendChild(document.createTextNode(count + ' ' + label));
                            chips.appendChild(c);
                        }
                        chip('warn',     'warning',        withIssues.length, withIssues.length === 1 ? 'with gaps' : 'with gaps');
                        chip('unlinked', 'link_off',       unlinked.length,   'not linked');
                        chip('ok',       'check_circle',   ok.length,         'OK');
                        summaryEl.appendChild(chips);
                    }
                    resultDiv.appendChild(summaryEl);

                    // Build one card per user with issues or unlinked status
                    if (withIssues.length > 0 || unlinked.length > 0) {
                        var cards = document.createElement('div');
                        cards.className = 'jc-audit-cards';
                        function buildCard(u) {
                            var card = document.createElement('div');
                            card.className = 'jc-audit-card ' + (u.linked ? 'jc-audit-card-warn' : 'jc-audit-card-unlinked');
                            var header = document.createElement('div');
                            header.className = 'jc-audit-card-header';
                            var userEl = document.createElement('span');
                            userEl.className = 'jc-audit-card-user';
                            var userIcon = document.createElement('i');
                            userIcon.className = 'material-icons';
                            userIcon.setAttribute('aria-hidden', 'true');
                            userIcon.textContent = u.linked ? 'person' : 'person_off';
                            userEl.appendChild(userIcon);
                            userEl.appendChild(document.createTextNode(u.jellyfinUsername));
                            header.appendChild(userEl);
                            var statusChip = document.createElement('span');
                            statusChip.className = 'jc-audit-chip ' + (u.linked ? 'jc-audit-chip-warn' : 'jc-audit-chip-unlinked');
                            var statusIcon = document.createElement('i');
                            statusIcon.className = 'material-icons';
                            statusIcon.setAttribute('aria-hidden', 'true');
                            statusIcon.textContent = u.linked ? 'warning' : 'link_off';
                            statusChip.appendChild(statusIcon);
                            statusChip.appendChild(document.createTextNode(u.linked ? 'Permissions Missing' : 'Not linked'));
                            header.appendChild(statusChip);
                            card.appendChild(header);
                            if (u.issues && u.issues.length > 0) {
                                var ul = document.createElement('ul');
                                ul.className = 'jc-audit-card-issues';
                                u.issues.forEach(function(issue) {
                                    var li = document.createElement('li');
                                    li.textContent = issue;
                                    ul.appendChild(li);
                                });
                                card.appendChild(ul);
                            }
                            return card;
                        }
                        withIssues.forEach(function(u) { cards.appendChild(buildCard(u)); });
                        unlinked.forEach(function(u) { cards.appendChild(buildCard(u)); });
                        resultDiv.appendChild(cards);
                    }

                    // Collapsed list of OK users rendered as name pills so many names
                    // wrap naturally instead of pushing the table layout wide
                    if (ok.length > 0 && (withIssues.length > 0 || unlinked.length > 0)) {
                        var details = document.createElement('details');
                        details.className = 'jc-audit-ok-section';
                        var summary = document.createElement('summary');
                        summary.textContent = 'Show ' + ok.length + ' user(s) with no issues';
                        details.appendChild(summary);
                        var nameList = document.createElement('ul');
                        nameList.className = 'jc-audit-ok-names';
                        ok.forEach(function(u) {
                            var li = document.createElement('li');
                            li.textContent = u.jellyfinUsername;
                            nameList.appendChild(li);
                        });
                        details.appendChild(nameList);
                        resultDiv.appendChild(details);
                    }
                    resultDiv.style.display = 'block';
                } catch (err) {
                    // Build the error node with createElement + textContent so any
                    // server-supplied message can't smuggle HTML into the page.
                    var errEl = document.createElement('div');
                    errEl.className = 'jc-audit-error';
                    errEl.textContent = 'Audit failed: ' + ((err && err.message) || 'Check server logs.');
                    resultDiv.appendChild(errEl);
                    resultDiv.style.display = 'block';
                    console.error('[JC] Permission ', err);
                } finally {
                    btn.disabled = false;
                    setBtnLabel('Run Audit');
                }
            });
        })();

        // Shortcuts Panel & Toast timing previews — lets admins see how long
        // their chosen durations feel without leaving the settings page. Both
        // previews read the CURRENT (unsaved) input value so you can tweak the
        // number, click preview, and immediately see the result.
        //   - Shortcuts panel preview: full-screen overlay with a live countdown
        //     that self-dismisses at the configured delay (Esc / click-outside /
        //     Close-now also dismiss).
        //   - Toast preview: replicates the in-app toast styling at bottom-center
        //     and fades out at the configured duration.
        (function wireTimingPreviews() {
            var panelBtn = jcById('jcTestShortcutsPanel');
            var toastBtn = jcById('jcTestToast');
            var panelInput = jcById('HelpPanelAutocloseDelay');
            var toastInput = jcById('ToastDuration');

            // Clamp to a sane window: at least 200 ms (anything shorter is a flash
            // that the user can't see), at most 120 s (prevents stuck overlays
            // from fat-fingered values). Fallback if the field is blank/invalid.
            function readMs(input, fallback) {
                var raw = parseInt(input && input.value, 10);
                if (!Number.isFinite(raw) || raw < 200) return fallback;
                return Math.min(raw, 120000);
            }

            function fmtSeconds(ms) {
                return (ms / 1000).toFixed(1) + 's';
            }

            // Active-preview cleanup tracking — otherwise repeated clicks leak
            // setIntervals, setTimeouts, and document-level keydown listeners
            // because simply removing the prior overlay's DOM node never calls
            // its enclosing cleanup() closure.
            var _activePanelPreviewCleanup = null;

            if (panelBtn && panelInput && panelBtn.dataset.jcWired !== jcPageLifecycle.id) {
                panelBtn.dataset.jcWired = jcPageLifecycle.id;
                // Owner-routed (#167 findings 2/7): a teardown reclaims this
                // click so a fresh owner rebinds a live handler instead of
                // stacking a second one that tracks cleanup into a dead owner.
                jcPageLifecycle.addListener(panelBtn, 'click', function() {
                    // Dismiss any previous preview FULLY — cleanup clears the
                    // interval/timeout/keydown handler in addition to removing
                    // the DOM node.
                    if (_activePanelPreviewCleanup) _activePanelPreviewCleanup();

                    var ms = readMs(panelInput, 15000);
                    var overlay = document.createElement('div');
                    overlay.className = 'jc-preview-panel-overlay';

                    var card = document.createElement('div');
                    card.className = 'jc-preview-panel-card';

                    var title = document.createElement('div');
                    title.className = 'jc-preview-panel-title';
                    title.innerHTML = '<i class="material-icons" aria-hidden="true">keyboard</i>Shortcuts Panel preview';
                    card.appendChild(title);

                    var body = document.createElement('div');
                    body.className = 'jc-preview-panel-body';
                    var countdown = document.createElement('span');
                    countdown.className = 'jc-preview-panel-countdown';
                    countdown.textContent = fmtSeconds(ms);
                    body.appendChild(document.createTextNode('This is how long the real shortcuts/settings panel (opened with the '));
                    var kbd = document.createElement('kbd');
                    kbd.textContent = '?';
                    body.appendChild(kbd);
                    body.appendChild(document.createTextNode(' key in the main Jellyfin UI) will stay open without interaction. Auto-closes in '));
                    body.appendChild(countdown);
                    body.appendChild(document.createTextNode('.'));
                    card.appendChild(body);

                    var actions = document.createElement('div');
                    actions.className = 'jc-preview-panel-actions';
                    var closeBtn = document.createElement('button');
                    closeBtn.type = 'button';
                    closeBtn.className = 'emby-button raised raised-mini';
                    closeBtn.textContent = 'Close now';
                    actions.appendChild(closeBtn);
                    card.appendChild(actions);

                    // Minimal dialog-style a11y: screen readers announce as dialog,
                    // title serves as accessible name, closeBtn gets initial focus.
                    overlay.setAttribute('role', 'dialog');
                    overlay.setAttribute('aria-modal', 'true');
                    title.id = 'jc-preview-panel-title';
                    overlay.setAttribute('aria-labelledby', 'jc-preview-panel-title');
                    overlay.appendChild(card);
                    document.body.appendChild(overlay);
                    try { closeBtn.focus(); } catch (e) { /* focus may fail in rare host conditions */ }

                    var startTs = Date.now();
                    var isActive = true;
                    var intervalId = setInterval(function() {
                        if (!isActive) return;
                        var remaining = Math.max(0, ms - (Date.now() - startTs));
                        countdown.textContent = fmtSeconds(remaining);
                        if (remaining <= 0) cleanup();
                    }, 100);
                    var timeoutId = setTimeout(cleanup, ms);

                    function cleanup() {
                        if (!isActive) return;
                        isActive = false;
                        clearInterval(intervalId);
                        clearTimeout(timeoutId);
                        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                        document.removeEventListener('keydown', onKey);
                        if (_activePanelPreviewCleanup === cleanup) _activePanelPreviewCleanup = null;
                        // Normal close: stop the page owner from re-running us.
                        jcPageLifecycle.untrack(cleanup);
                    }
                    function onKey(e) {
                        if (e.key === 'Escape') {
                            e.stopPropagation();
                            cleanup();
                        }
                    }
                    closeBtn.addEventListener('click', cleanup);
                    overlay.addEventListener('click', function(e) {
                        if (e.target === overlay) cleanup();
                    });
                    document.addEventListener('keydown', onKey);
                    _activePanelPreviewCleanup = cleanup;
                    // Bookkept on the owner so the open-preview cleanup is
                    // discoverable (untracked on normal close). The overlay is
                    // self-closing (interval + hard timeout), so a page swap does
                    // not strand it.
                    jcPageLifecycle.track(cleanup);
                });
            }

            if (toastBtn && toastInput && toastBtn.dataset.jcWired !== jcPageLifecycle.id) {
                toastBtn.dataset.jcWired = jcPageLifecycle.id;
                // Owner-routed (#167 findings 2/7): teardown reclaims this click
                // so a fresh owner rebinds one live handler instead of stacking.
                jcPageLifecycle.addListener(toastBtn, 'click', function() {
                    // Clear any prior preview toasts AND their still-pending timers
                    // (otherwise rapid-fire clicks leave detached toasts with pending
                    // slide-in/out/remove setTimeouts that would fire against removed
                    // DOM — harmless but wasteful).
                    document.querySelectorAll('.jc-preview-toast').forEach(function(el) {
                        // A lifecycle-owned toast disposes itself (timers + node +
                        // untrack) through its own cleanup; fall back to the raw
                        // teardown for any node without one.
                        if (typeof el._jcCleanup === 'function') { el._jcCleanup(); return; }
                        if (el._jeShowTimer)   clearTimeout(el._jeShowTimer);
                        if (el._jeHideTimer)   clearTimeout(el._jeHideTimer);
                        if (el._jeRemoveTimer) clearTimeout(el._jeRemoveTimer);
                        el.remove();
                    });
                    var ms = readMs(toastInput, 3000);
                    var toast = document.createElement('div');
                    toast.className = 'jc-preview-toast';
                    toast.setAttribute('role', 'status');
                    toast.setAttribute('aria-live', 'polite');
                    toast.textContent = 'Example toast — disappears in ' + fmtSeconds(ms);
                    document.body.appendChild(toast);
                    // Bookkept cleanup (#167): the toast is a body-level node with
                    // up to three pending timers. The disposer is idempotent and
                    // self-scheduled (it fires on the hide/remove timeout), so the
                    // toast tears itself down on its own timeline; untrack once it
                    // finishes.
                    function toastCleanup() {
                        if (toast._jcCleanupDone) return;
                        toast._jcCleanupDone = true;
                        if (toast._jeShowTimer)   clearTimeout(toast._jeShowTimer);
                        if (toast._jeHideTimer)   clearTimeout(toast._jeHideTimer);
                        if (toast._jeRemoveTimer) clearTimeout(toast._jeRemoveTimer);
                        if (toast.parentNode) toast.parentNode.removeChild(toast);
                        jcPageLifecycle.untrack(toastCleanup);
                    }
                    toast._jcCleanup = toastCleanup;
                    jcPageLifecycle.track(toastCleanup);
                    // Mirror real JC.toast(): slide in from the right after a tick,
                    // stay for `ms`, then slide back out by removing the .jc-shown class.
                    toast._jeShowTimer = setTimeout(function() { toast.classList.add('jc-shown'); }, 10);
                    toast._jeHideTimer = setTimeout(function() {
                        toast.classList.remove('jc-shown');
                        toast._jeRemoveTimer = setTimeout(toastCleanup, 350);
                    }, ms);
                });
            }
        })();

        // Collapsible info banners
        //
        // When the "Descriptions" toggle is off, every inline info banner is
        // folded into a small (i) icon next to its anchor (fieldset legend, or
        // the parent container of the checkbox the banner describes). Clicking
        // the icon toggles the banner(s) open in place; clicking outside closes
        // them. Multiple banners sharing an anchor toggle together under a
        // single icon.
        //
        // Anchor detection:
        //  - Banner inside a <div class="jc-setting-description" data-desc-for="id">
        //    → anchor is the nearest .checkboxContainer / .inputContainer that
        //      contains the input with that id. We attach to the container (as a
        //      sibling of the <label>) so clicking the trigger can't forward to
        //      the checkbox via the label's click behavior.
        //  - Otherwise → anchor is the nearest <legend class="sectionTitle">
        //    inside the same <fieldset>.
        //
        // All banners matching are marked .jc-banner-managed; the CSS in
        // configPage.css handles visibility keyed off body.jc-hide-descriptions
        // and the .jc-banner-open toggle.
        // Tracks every wired banner group so we can re-sync the parent-
        // checkbox gating (see below) when loadConfig runs AFTER wiring.
        var _jeBannerGroups = [];

        /**
         * Re-syncs every gated banner group's parent-off state. Called from
         * updateAllDependencies so programmatic `checkbox.checked = x` applied
         * during loadConfig picks up correctly (a direct assignment doesn't
         * fire the 'change' event we listen to otherwise).
         */
        function syncAllBannerParents() {
            _jeBannerGroups.forEach(function(group) {
                if (!group.parentCheckbox) return;
                _jeSyncBannerParent(group);
            });
        }

        function _jeSyncBannerParent(group) {
            var off = !group.parentCheckbox.checked;
            group.banners.forEach(function(b) {
                b.classList.toggle('jc-banner-parent-off', off);
                if (off) b.classList.remove('jc-banner-open');
            });
            group.trigger.classList.toggle('jc-banner-parent-off', off);
            if (off) group.trigger.setAttribute('aria-expanded', 'false');
        }

        (function wireCollapsibleBanners() {
            var banners = jcSelAll('.jc-info-banner-inline, .jc-info-banner-inline-center');
            if (!banners.length) return;

            function findAnchor(banner) {
                // Explicit overrides on the banner itself:
                //   data-banner-anchor="legend"       → force fieldset legend
                //   data-banner-anchor="#elementId"   → force arbitrary element
                // Used for banners that live inside one setting's description
                // wrapper but are semantically about the whole fieldset.
                var override = banner.getAttribute('data-banner-anchor');
                if (override === 'legend') {
                    var fsOverride = banner.closest('fieldset');
                    if (fsOverride) {
                        var legendOverride = fsOverride.querySelector('legend.sectionTitle');
                        if (legendOverride) return legendOverride;
                    }
                } else if (override && override.charAt(0) === '#') {
                    var el = jcSel(override);
                    if (el) return el;
                }

                var descWrapper = banner.closest('.jc-setting-description[data-desc-for]');
                if (descWrapper) {
                    var targetId = descWrapper.getAttribute('data-desc-for');
                    var target = jcById(targetId);
                    if (target) {
                        var container = target.closest('.checkboxContainer, .inputContainer');
                        if (container) return container;
                    }
                }
                var fieldset = banner.closest('fieldset');
                if (fieldset) {
                    var legend = fieldset.querySelector('legend.sectionTitle');
                    if (legend) return legend;
                }
                return null;
            }

            // Find the parent checkbox whose "checked" state gates this banner
            // (auto-detect via nearest .jc-setting-description[data-desc-for="X"]
            // where #X is a checkbox). Explicit opt-out: data-banner-no-gate="true"
            // on the banner disables the gating for that specific banner.
            function findParentCheckbox(banner) {
                if (banner.getAttribute('data-banner-no-gate') === 'true') return null;
                var descWrapper = banner.closest('.jc-setting-description[data-desc-for]');
                if (!descWrapper) return null;
                var targetId = descWrapper.getAttribute('data-desc-for');
                var target = jcById(targetId);
                if (target && target.type === 'checkbox') return target;
                return null;
            }

            // Group banners by anchor; also capture the shared parent checkbox
            // (we assume all banners under one anchor share the same gate —
            // currently true because they live in the same .jc-setting-description).
            var anchorMap = new Map();
            banners.forEach(function(banner, idx) {
                banner.classList.add('jc-banner-managed');
                if (!banner.id) banner.id = 'jc-banner-' + idx + '-' + Math.random().toString(36).slice(2, 8);
                var anchor = findAnchor(banner);
                if (!anchor) {
                    // Future contributors adding a banner outside a fieldset / outside
                    // any .jc-setting-description[data-desc-for] will end up here —
                    // the banner gets `jc-banner-managed` (so CSS hides it when
                    // descriptions-off) but no trigger icon. Without a log, the
                    // banner would just disappear when the admin toggles
                    // descriptions off with no way to get it back.
                    console.warn('[JC] banner has no anchor — collapse trigger will not be wired:', banner.id || banner);
                    return;
                }
                if (!anchorMap.has(anchor)) {
                    anchorMap.set(anchor, { banners: [], parentCheckbox: findParentCheckbox(banner) });
                }
                anchorMap.get(anchor).banners.push(banner);
            });

            anchorMap.forEach(function(data, anchor) {
                if (anchor.dataset.jcBannerWired === '1') return;
                anchor.dataset.jcBannerWired = '1';

                var trigger = document.createElement('button');
                trigger.type = 'button';
                trigger.className = 'jc-banner-trigger';
                trigger.setAttribute('aria-expanded', 'false');
                var labelText = data.banners.length > 1 ? 'Show ' + data.banners.length + ' info panels' : 'Show info';
                trigger.setAttribute('aria-label', labelText);
                trigger.title = labelText;
                var icon = document.createElement('i');
                icon.className = 'material-icons';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = 'info';
                trigger.appendChild(icon);
                anchor.appendChild(trigger);

                var group = { banners: data.banners, trigger: trigger, parentCheckbox: data.parentCheckbox };
                _jeBannerGroups.push(group);

                trigger.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    var nextOpen = trigger.getAttribute('aria-expanded') !== 'true';
                    trigger.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    data.banners.forEach(function(b) {
                        b.classList.toggle('jc-banner-open', nextOpen);
                    });
                });

                // Gate on the parent checkbox: when unchecked, hide banners
                // and surface the trigger icon (same UX as descriptions-off
                // mode). Initial sync runs here; syncAllBannerParents() is
                // also called from updateAllDependencies so loadConfig's
                // programmatic .checked assignments pick up correctly.
                if (data.parentCheckbox) {
                    _jeSyncBannerParent(group);
                    data.parentCheckbox.addEventListener('change', function() {
                        _jeSyncBannerParent(group);
                    });
                }
            });

            // Outside-click closes every open banner. Clicks inside an open
            // banner (e.g. code copy button, links) don't close it.
            // Single global slot so repeated visits keep exactly one (#167).
            jcPageLifecycle.own('bannerOutsideClick', document, 'click', function(e) {
                if (!e.target) return;
                if (e.target.closest('.jc-banner-trigger, .jc-banner-managed')) return;
                jcSelAll('.jc-banner-trigger[aria-expanded="true"]').forEach(function(t) {
                    t.setAttribute('aria-expanded', 'false');
                });
                jcSelAll('.jc-banner-managed.jc-banner-open').forEach(function(b) {
                    b.classList.remove('jc-banner-open');
                });
            });
        })();

        // Custom Plugin Links functionality
        const testCustomPluginLinksBtn = jcById('testCustomPluginLinksBtn');
        const customPluginLinksTextarea = jcById('customPluginLinks');

        if (testCustomPluginLinksBtn) {
            jcPageLifecycle.addListener(testCustomPluginLinksBtn, 'click', async () => {
                const linksText = customPluginLinksTextarea.value.trim();
                if (!linksText) {
                    Dashboard.alert({
                        title: 'No Links',
                        message: 'Please add some custom plugin links first.'
                    });
                    return;
                }

                // Parse and validate the links
                const lines = linksText.split('\n');
                const validLinks = [];
                const invalidLines = [];

                lines.forEach((line, index) => {
                    const trimmedLine = line.trim();
                    if (!trimmedLine) return;

                    const parts = trimmedLine.split('|').map(part => part.trim());
                    if (parts.length >= 2 && parts[0] && parts[1]) {
                        validLinks.push({ name: parts[0], icon: parts[1] });
                    } else {
                        invalidLines.push(`Line ${index + 1}: "${trimmedLine}"`);
                    }
                });

                if (invalidLines.length > 0) {
                    Dashboard.alert({
                        title: 'Invalid Format',
                        message: `The following lines have invalid format:\n\n${invalidLines.join('\n')}\n\nPlease use the format: Configuration Page Name | icon_name`
                    });
                    return;
                }

                if (validLinks.length === 0) {
                    Dashboard.alert({
                        title: 'No Valid Links',
                        message: 'No valid plugin links found. Please check the format.'
                    });
                    return;
                }

                // Test the links by temporarily adding them to the sidebar
                // Trigger the plugin icons script to refresh with test data
                if (window.JellyfinCanopy && window.JellyfinCanopy.customPlugins) {
                    // Temporarily store test data
                    window.testCustomPluginLinks = validLinks;
                    window.JellyfinCanopy.customPlugins.refresh();
                }
            });
        }

        // click handlers to all TMDB test buttons
        jcSelAll('.testTmdbBtn').forEach(btn => {
            jcPageLifecycle.addListener(btn, 'click', testTmdbConnection);
        });

        // Copy button handler for HTML code snippets
        jcSelAll('.jc-copy-html-btn').forEach(function(btn) {
            jcPageLifecycle.addListener(btn, 'click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                const htmlCode = this.getAttribute('data-copy-text');
                const btnText = this.querySelector('.copy-btn-text');

                // Try clipboard API first
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(htmlCode).then(function() {
                        btnText.textContent = 'Copied!';
                        btn.style.color = '#4CAF50';
                        setTimeout(function() {
                            btnText.textContent = 'Copy';
                            btn.style.color = '';
                        }, 2000);
                    }).catch(function(err) {
                        console.error('Clipboard API failed: ', err);
                        fallbackCopy(htmlCode, btn, btnText);
                    });
                } else {
                    // Fallback for older browsers
                    fallbackCopy(htmlCode, btn, btnText);
                }
            });
        });

        // Fallback copy method
        function fallbackCopy(text, btn, btnText) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                btnText.textContent = 'Copied!';
                btn.style.color = '#4CAF50';
                setTimeout(function() {
                    btnText.textContent = 'Copy';
                    btn.style.color = '';
                }, 2000);
            } catch (err) {
                console.error('Fallback copy failed: ', err);
                alert('Failed to copy to clipboard');
            }
            document.body.removeChild(textarea);
        }
    })();
