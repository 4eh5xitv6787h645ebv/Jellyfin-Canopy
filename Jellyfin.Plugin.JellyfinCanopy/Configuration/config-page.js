/* Jellyfin Canopy — admin config page engine (Verdant ground-up rewrite).
   One classic served script; sections in dependency order:
   core → nav/search → dashboards → connections/arr → widgets →
   binder/save/load → view-mode/wizard → init. Contract anchors
   (buildConfigFromForm/saveArrInstances/loadConfig, binder key scan, theme
   detector ordering, pinned arr parse functions) live in their owning
   sections and are verified by the Configuration test suite. */
(() => {

/* SECTION: core — owns: pluginId/page/form, escapeHtml, jcIsHttpUrl,
   theme detector, dirty-state owner. wires: wireDirtyState. depends: none. */

const pluginId = '9ffa12bc-f4b5-406c-ab1d-d575acbeea7b';
const page = document.querySelector('#JellyfinCanopyPage');
const form = document.querySelector('#JellyfinCanopyForm');

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* Absolute http(s) URL with no credentials, query, or fragment — the shared
   shape every hand-validated external URL field accepts. The unusual
   indentation is a contract: config-page-http-url.test.ts regex-extracts
   `function jcIsHttpUrl(value)` up to its 8-space-indented closing brace and
   runs the slice against the shared URL-safety matrix. */
        function jcIsHttpUrl(value) {
            try {
                const parsed = new URL(String(value));
                return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
                    && !parsed.username && !parsed.password
                    && !parsed.search && !parsed.hash;
            } catch (e) {
                return false;
            }
        }

/* ---------------------------------------------------------------------------
   Theme detector. Jellyfin themes hard-swap theme.css with no CSS-variable
   contract, so classify light/dark here and tag the page root for the
   stylesheet's paired palettes. Fail-open: dark. The substring ordering in
   this function (data-theme read → explicit 'light' trust → var candidates
   sampling) is a test contract.
   --------------------------------------------------------------------------- */
function _jeDetectTheme() {
    if (!page) return;
    try {
        const declaredTheme = (document.documentElement.getAttribute('data-theme') || '').toLowerCase();
        if (declaredTheme === 'light') {
            page.classList.add('jc-light-theme');
            page.classList.remove('jc-dark-theme');
            return;
        }
        const knownDark = ['dark', 'appletv', 'blueradiance', 'purplehaze', 'wmc'];
        if (knownDark.indexOf(declaredTheme) !== -1) {
            page.classList.remove('jc-light-theme');
            page.classList.add('jc-dark-theme');
            return;
        }
        var candidates = [
            document.documentElement,
            document.body,
            document.querySelector('.backgroundContainer'),
            document.querySelector('.mainAnimatedPage'),
        ];
        let match = null;
        let lastBg = '';
        for (const el of candidates) {
            if (!el) continue;
            const bg = getComputedStyle(el).backgroundColor || '';
            lastBg = bg;
            const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
            if (m && (m[4] === undefined || +m[4] >= 0.5)) { match = m; break; }
        }
        if (!match) {
            console.warn('[JC] theme detector: document background is unparseable (' + lastBg + '); defaulting to dark');
            page.classList.remove('jc-light-theme');
            page.classList.add('jc-dark-theme');
            return;
        }
        const sum = (+match[1]) + (+match[2]) + (+match[3]);
        const isLight = sum > 450;
        page.classList.toggle('jc-light-theme', isLight);
        page.classList.toggle('jc-dark-theme', !isLight);
    } catch (e) {
        console.warn('[JC] theme detection failed, defaulting to dark:', e);
        try {
            page.classList.remove('jc-light-theme');
            page.classList.add('jc-dark-theme');
        } catch (e2) { /* detached page — nothing to tag */ }
    }
}

/* ---------------------------------------------------------------------------
   Dirty-state owner. One revision counter; the dock's jc-dirty class is the
   only UI consequence. The revision snapshot lets saveConfig avoid clearing
   the dirty state over edits that landed while a save was in flight.
   --------------------------------------------------------------------------- */
let jcDirtyRevision = 0;
function jcMarkConfigDirty() {
    jcDirtyRevision++;
    const dock = document.querySelector('.jc-save-dock');
    if (dock) dock.classList.add('jc-dirty');
}
function jcDirtyRevisionNow() {
    return jcDirtyRevision;
}
function jcClearDirtyIfUnchanged(revision) {
    if (jcDirtyRevision !== revision) return;
    const dock = document.querySelector('.jc-save-dock');
    if (dock) dock.classList.remove('jc-dirty');
}
function wireDirtyState() {
    if (!form) return;
    form.addEventListener('input', jcMarkConfigDirty, true);
    form.addEventListener('change', jcMarkConfigDirty, true);
}

/* SECTION: nav-search — owns: GROUPS, activateTab, jcSyncGroupForTab, LEGACY_TAB_MAP,
   tabs/tabContents static NodeLists, all search state. wires: wireNavShell, wireSearch.
   depends: form, page (core). Integrator: call wireNavShell() before loadConfig()
   (it performs the sessionStorage tab restore), wireSearch() any time after markup exists.
   Top-level `let` declarations below are inert state slots (no side effects); all DOM
   work happens inside the wire functions per the conventions. */

// ---------------------------------------------------------------------------
// Static NodeLists — cached once (spec: old code captured these at parse time,
// before the section-strip relocation; relocation moves the same nodes, so the
// references stay valid; tabs/sections are never added dynamically).
// ---------------------------------------------------------------------------
let tabs = null;
let tabContents = null;

function captureStaticNodeLists() {
    if (!tabs) {
        tabs = document.querySelectorAll('.jellyfin-tab-button');
    }
    if (!tabContents) {
        tabContents = document.querySelectorAll('.jellyfin-tab-content');
    }
}

// ---------------------------------------------------------------------------
// Group shell
// ---------------------------------------------------------------------------
const GROUPS = {
    'command-center': { title: 'Command Center', purpose: 'Service health, feature status and quick actions at a glance.' },
    'experience': { title: 'Experience', purpose: 'How Jellyfin looks, plays and handles for every user.' },
    'pages': { title: 'Pages', purpose: 'Calendar, Requests, Bookmarks, Hidden Content and the administrator Maintainerr page.' },
    'discovery': { title: 'Discovery & Community', purpose: 'Trending, reviews, release dates and streaming availability.' },
    'connections': { title: 'Connections & Automation', purpose: 'Seerr, Maintainerr, Sonarr, Radarr, Bazarr and their sync rules.' },
    'governance': { title: 'Governance', purpose: 'Spoiler policy, user defaults, permissions and maintenance.' },
    'system': { title: 'System', purpose: 'Assets, diagnostics, developer settings and documentation.' }
};

// Assigned by wireGroupShell; stays null when the group shell markup is absent.
// Callers must guard (activateTab does).
let jcSyncGroupForTab = null;

function wireGroupShell() {
    captureStaticNodeLists();
    const railBtns = document.querySelectorAll('#JellyfinCanopyPage .jc-group-btn');
    const strip = document.querySelector('#jcSectionStrip');
    const store = document.querySelector('#JellyfinCanopyPage .jc-section-strip-store');
    const titleEl = document.querySelector('#jcPageTitle');
    const purposeEl = document.querySelector('#jcPagePurpose');
    if (!railBtns.length || !strip || !store) {
        return; // whole group shell no-ops; jcSyncGroupForTab stays null
    }

    // Mockup-faithful rail: relocate each section button out of the hidden
    // store into the rail, directly under its group label (same nodes, order
    // preserved), then drop the store. The header strip element stays in the
    // DOM (pinned hook) but receives nothing and renders empty.
    const railGroupSections = {};
    railBtns.forEach(function (groupBtn) {
        const holder = document.createElement('div');
        holder.className = 'jc-rail-sections';
        holder.dataset.groupSections = groupBtn.dataset.group;
        groupBtn.insertAdjacentElement('afterend', holder);
        railGroupSections[groupBtn.dataset.group] = holder;
    });
    store.querySelectorAll('.jellyfin-tab-button').forEach(function (b) {
        const holder = railGroupSections[b.dataset.group];
        (holder || strip).appendChild(b);
        b.classList.add('jc-in-rail');
    });
    store.remove();

    function setGroup(groupId, activateFirst) {
        const meta = GROUPS[groupId];
        if (!meta) {
            return;
        }
        railBtns.forEach(function (b) {
            b.classList.toggle('active', b.dataset.group === groupId);
        });
        let first = null;
        let firstVisible = null;
        let members = 0;
        tabs.forEach(function (b) {
            const inGroup = b.dataset.group === groupId;
            b.classList.toggle('jc-in-group', inGroup);
            if (inGroup) {
                members++;
                if (!first) {
                    first = b;
                }
                // During search, zero-match sections are display:none — a group
                // click must land on the first MATCHING one.
                if (!firstVisible && b.style.display !== 'none') {
                    firstVisible = b;
                }
            }
        });
        strip.classList.toggle('jc-strip-single', members < 2);
        /* The serif header title belongs to the ACTIVE SECTION (activateTab
           owns it); the group contributes the purpose lede. */
        if (purposeEl) {
            purposeEl.textContent = meta.purpose;
        }
        if (activateFirst) {
            const target = firstVisible || first;
            if (target) {
                /* Direct activation, NOT target.click(): on mobile the rail
                   lives in the drawer, and the click pipeline's drawer-closer
                   would slam it shut before the admin picks a section. */
                jcActivateSection(target.dataset.tab);
            }
        }
    }

    railBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
            setGroup(btn.dataset.group, true);
        });
    });

    jcSyncGroupForTab = function (tabId) {
        const btn = strip.querySelector('.jellyfin-tab-button[data-tab="' + tabId + '"]');
        if (btn && btn.dataset.group) {
            setGroup(btn.dataset.group, false);
        }
    };

    // Initial sync: reflect the HTML-marked active tab (Overview) in rail,
    // strip membership and header so the strip renders before any activation.
    const activeBtn = strip.querySelector('.jellyfin-tab-button.active');
    if (activeBtn && activeBtn.dataset.group) {
        setGroup(activeBtn.dataset.group, false);
    }
}

// ---------------------------------------------------------------------------
// Tab activation with per-tab scroll memory + docs lazy iframe
// ---------------------------------------------------------------------------
const DOCS_URL = 'https://4eh5xitv6787h645ebv.github.io/Jellyfin-Canopy/';
const _jeTabScroll = {}; // tabId -> scrollY
let _jePrevTabId = null;

function _jeGetScrollTop() {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function _jeSetScrollTop(y) {
    try {
        window.scrollTo({ top: y, behavior: 'instant' });
    } catch (e) {
        window.scrollTo(0, y); // old Safari
    }
}

function activateTab(tabId) {
    captureStaticNodeLists();
    if (_jePrevTabId && _jePrevTabId !== tabId) {
        _jeTabScroll[_jePrevTabId] = _jeGetScrollTop();
    }
    tabs.forEach(function (t) {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });
    const activeSectionBtn = document.querySelector('.jellyfin-tab-button[data-tab="' + tabId + '"]');
    const headerTitle = document.querySelector('#jcPageTitle');
    if (activeSectionBtn && headerTitle && activeSectionBtn.dataset.jcLabel) {
        headerTitle.textContent = activeSectionBtn.dataset.jcLabel;
    }
    if (jcSyncGroupForTab) {
        jcSyncGroupForTab(tabId);
    }
    tabContents.forEach(function (content) {
        content.classList.toggle('active', content.id === tabId);
    });
    // Restore scroll after the layout pass. LOAD-BEARING: the service-status
    // card deep-link (dashboards section) uses a *double* rAF so it runs after
    // this restore. If this changes, that handler must change too.
    const saved = _jeTabScroll[tabId];
    requestAnimationFrame(function () {
        _jeSetScrollTop(saved || 0);
    });
    _jePrevTabId = tabId;

    if (tabId === 'docs') {
        try {
            const f = document.querySelector('#docsFrame');
            const src = f ? f.getAttribute('src') : null;
            if (f && (!src || src === 'about:blank')) {
                // First activation only: never reset afterwards, so revisits
                // keep iframe scroll position and in-page nav state.
                let loaded = false;
                f.addEventListener('load', function () {
                    loaded = true;
                }, { once: true });
                setTimeout(function () {
                    if (loaded) {
                        return;
                    }
                    const fallback = document.createElement('div');
                    fallback.className = 'jc-docs-fallback';
                    fallback.style.padding = '24px';
                    fallback.style.textAlign = 'center';
                    fallback.style.color = '#ccc';
                    fallback.style.fontSize = '0.95em';
                    fallback.appendChild(document.createTextNode('Couldn\'t load the embedded documentation. Open it in a new tab instead: '));
                    const link = document.createElement('a');
                    link.href = DOCS_URL;
                    link.target = '_blank';
                    link.rel = 'noopener';
                    link.style.color = 'var(--jc-accent)';
                    link.textContent = DOCS_URL;
                    fallback.appendChild(link);
                    if (f.parentNode) {
                        f.parentNode.replaceChild(fallback, f);
                    }
                }, 8000);
                f.src = DOCS_URL;
            }
        } catch (e) {
            console.warn('[JC] docs iframe lazy-load failed:', e);
        }
    }
}

// ---------------------------------------------------------------------------
// Tab button clicks + sessionStorage persistence / restore
// ---------------------------------------------------------------------------
const LEGACY_TAB_MAP = { 'enhanced': 'display', 'seerr': 'seerr', 'arr-links': 'arr' };

function jcActivateSection(tabId) {
    if (isSearchMode) {
        const target = document.querySelector('#' + tabId + ' > fieldset:not(.jc-search-hidden)');
        clearTimeout(searchDebounce);
        if (searchInput) {
            searchInput.value = '';
        }
        exitSearchMode();
        activateTab(tabId);
        if (target) {
            setTimeout(function () {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 60);
        }
    } else {
        activateTab(tabId);
    }
    try {
        sessionStorage.setItem('jellyfinCanopyActiveTab', tabId);
    } catch (e) {
        // sessionStorage unavailable — skip persistence
    }
}

function wireTabButtons() {
    captureStaticNodeLists();
    tabs.forEach(function (btn) {
        btn.addEventListener('click', function () {
            jcActivateSection(btn.dataset.tab);
        });
    });
}

function restoreSavedTab() {
    try {
        let savedTab = sessionStorage.getItem('jellyfinCanopyActiveTab');
        if (savedTab && LEGACY_TAB_MAP[savedTab]) {
            savedTab = LEGACY_TAB_MAP[savedTab];
            sessionStorage.setItem('jellyfinCanopyActiveTab', savedTab);
        }
        if (savedTab && document.getElementById(savedTab)) {
            activateTab(savedTab);
        } else if (savedTab !== null) {
            console.info('[JC] discarding unknown saved tab: ' + savedTab);
            sessionStorage.removeItem('jellyfinCanopyActiveTab');
        }
        // No saved tab -> leave the HTML-marked active tab (Overview) alone.
    } catch (e) {
        // sessionStorage unavailable — skip restore
    }
}

// ---------------------------------------------------------------------------
// Mobile section drawer
// ---------------------------------------------------------------------------
function wireSectionDrawer() {
    captureStaticNodeLists();
    const shell = document.querySelector('#JellyfinCanopyPage .jc-shell');
    const toggle = document.querySelector('#jcNavToggle');
    const scrim = document.querySelector('#jcNavScrim');
    const sidebar = shell ? shell.querySelector('.jc-sidebar') : null;
    const main = shell ? shell.querySelector('.jc-main') : null;
    if (!shell || !toggle || !scrim || !sidebar || !main) {
        return; // drawer no-ops gracefully
    }

    const drawerMedia = window.matchMedia('(max-width: 900px)');
    let isOpen = false;

    function setOpen(open) {
        const wasOpen = isOpen;
        isOpen = open;
        shell.classList.toggle('jc-nav-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (drawerMedia.matches) {
            // Off-canvas focus ownership: the covered main column must not be
            // focusable while the drawer overlays it; the closed sidebar must
            // not be tabbable behind the viewport edge.
            main.inert = open;
            sidebar.inert = !open;
            if (open) {
                const focusTarget = sidebar.querySelector('#settingsSearchInput, .jc-group-btn');
                if (focusTarget) {
                    focusTarget.focus();
                }
            } else if (wasOpen) {
                toggle.focus();
            }
        }
    }

    function syncLayoutMode() {
        if (drawerMedia.matches) {
            sidebar.inert = !isOpen;
            main.inert = isOpen;
        } else {
            sidebar.inert = false;
            main.inert = false;
            shell.classList.remove('jc-nav-open');
            toggle.setAttribute('aria-expanded', 'false');
            isOpen = false;
        }
    }

    toggle.addEventListener('click', function () {
        setOpen(!isOpen);
    });
    scrim.addEventListener('click', function () {
        setOpen(false);
    });
    tabs.forEach(function (btn) {
        btn.addEventListener('click', function () {
            setOpen(false);
        });
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOpen) {
            setOpen(false);
        }
    });
    if (typeof drawerMedia.addEventListener === 'function') {
        drawerMedia.addEventListener('change', syncLayoutMode);
    } else if (typeof drawerMedia.addListener === 'function') {
        drawerMedia.addListener(syncLayoutMode);
    }
    syncLayoutMode();
}

// ---------------------------------------------------------------------------
// Tab-bar drag-to-scroll
// ---------------------------------------------------------------------------
function wireTabBarDrag() {
    const bar = document.querySelector('.jc-tab-bar');
    if (!bar) {
        return;
    }
    let isDown = false;
    let dragged = false;
    let startX = 0;
    let startScroll = 0;

    bar.addEventListener('mousedown', function (e) {
        if (e.button !== 0) {
            return; // left button only
        }
        isDown = true;
        dragged = false;
        startX = e.pageX;
        startScroll = bar.scrollLeft;
    });
    bar.addEventListener('mousemove', function (e) {
        if (!isDown) {
            return;
        }
        const dx = e.pageX - startX;
        if (!dragged) {
            if (Math.abs(dx) < 5) {
                return; // below drag threshold — keep it a plain click
            }
            dragged = true;
            bar.classList.add('jc-dragging');
        }
        bar.scrollLeft = startScroll - dx;
        e.preventDefault();
    });
    function endDrag() {
        // Keep `dragged` set so the synthesized click after drag-end is suppressed.
        isDown = false;
        bar.classList.remove('jc-dragging');
    }
    bar.addEventListener('mouseup', endDrag);
    bar.addEventListener('mouseleave', endDrag);
    bar.addEventListener('click', function (e) {
        if (dragged) {
            e.preventDefault();
            e.stopPropagation();
            dragged = false;
        }
    }, true);
}

function wireNavShell() {
    captureStaticNodeLists();
    wireTabBarDrag();
    wireSectionDrawer();
    wireGroupShell();
    wireTabButtons();
    restoreSavedTab();
}

// ---------------------------------------------------------------------------
// Settings search
// ---------------------------------------------------------------------------
const SKIP_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SCRIPT', 'STYLE']);
const savedDetailsStates = new Map(); // details element -> open state
let isSearchMode = false;
let currentMatchIdx = -1;
let allMatches = [];
let searchDebounce = null;
let searchInput = null;
let searchClear = null;
let searchCount = null;
let _jeDisplayCache = null; // WeakMap: parent element -> is flex/grid (reset per search pass)

function getSearchableText(element) {
    let text = element.textContent.toLowerCase();
    element.querySelectorAll('[id], [name], [data-text], [data-icon]').forEach(function (el) {
        if (el.id) {
            text += ' ' + el.id.toLowerCase();
        }
        const name = el.getAttribute('name');
        if (name) {
            text += ' ' + name.toLowerCase();
        }
        if (el.dataset.text) {
            text += ' ' + el.dataset.text.toLowerCase();
        }
        if (el.dataset.icon) {
            text += ' ' + el.dataset.icon.toLowerCase();
        }
    });
    return text;
}

function _jeTabButtonLabel(btn) {
    // Clone and strip icons so ligature names ("dashboard") don't leak into the label.
    const clone = btn.cloneNode(true);
    clone.querySelectorAll('i.material-icons, img').forEach(function (n) {
        n.remove();
    });
    return (clone.textContent || '').trim();
}

function _jeParentIsFlexOrGrid(parent) {
    if (!_jeDisplayCache) {
        _jeDisplayCache = new WeakMap();
    }
    if (_jeDisplayCache.has(parent)) {
        return _jeDisplayCache.get(parent);
    }
    const result = /(flex|grid)$/.test(getComputedStyle(parent).display);
    _jeDisplayCache.set(parent, result);
    return result;
}

function highlightTextIn(root, query) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
            const parent = node.parentElement;
            if (!parent) {
                return NodeFilter.FILTER_REJECT;
            }
            if (SKIP_TAGS.has(parent.tagName)) {
                return NodeFilter.FILTER_REJECT;
            }
            // Never highlight dependency-hint chrome, an existing mark, or
            // Essentials/wizard content.
            if (parent.closest('.jc-search-match, .jc-search-tab-label, .dep-hint-text, .dep-required-icon, .jc-dep-banner, [class*="parent-hint-"], #jcWizard, #jcEssentials')) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const textNodes = [];
    while (walker.nextNode()) {
        if (walker.currentNode.nodeValue.toLowerCase().includes(query)) {
            textNodes.push(walker.currentNode);
        }
    }

    textNodes.forEach(function (node) {
        const text = node.nodeValue;
        const lower = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let pos = 0;
        let idx = lower.indexOf(query);
        while (idx !== -1) {
            if (idx > pos) {
                frag.appendChild(document.createTextNode(text.slice(pos, idx)));
            }
            const mark = document.createElement('mark');
            mark.className = 'jc-search-match';
            mark.textContent = text.slice(idx, idx + query.length);
            frag.appendChild(mark);
            pos = idx + query.length;
            idx = lower.indexOf(query, pos);
        }
        if (pos < text.length) {
            frag.appendChild(document.createTextNode(text.slice(pos)));
        }
        const parent = node.parentNode;
        if (!parent) {
            return;
        }
        // Flex/grid protection (checks ordered cheap-first): if the fragment has
        // multiple pieces and the parent lays out flex/grid, wrap them so the
        // parent still sees one child (otherwise justify-content scatters the
        // pieces, e.g. "Auto Sea…son Requests").
        if (frag.childNodes.length > 1 && _jeParentIsFlexOrGrid(parent)) {
            const wrap = document.createElement('span');
            wrap.className = 'jc-search-wrap';
            wrap.appendChild(frag);
            parent.replaceChild(wrap, node);
        } else {
            parent.replaceChild(frag, node);
        }
    });
}

function clearHighlights() {
    document.querySelectorAll('.jc-search-match').forEach(function (mark) {
        const parent = mark.parentNode;
        if (!parent) {
            return;
        }
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
    });
    document.querySelectorAll('.jc-search-wrap').forEach(function (wrap) {
        const parent = wrap.parentNode;
        if (!parent) {
            return;
        }
        while (wrap.firstChild) {
            parent.insertBefore(wrap.firstChild, wrap);
        }
        wrap.remove();
        parent.normalize();
    });
    allMatches = [];
    currentMatchIdx = -1;
}

function enterSearchMode() {
    if (isSearchMode) {
        return;
    }
    isSearchMode = true;
    form.classList.add('jc-search-mode');
    form.querySelectorAll('details').forEach(function (d) {
        savedDetailsStates.set(d, d.open);
    });
    tabContents.forEach(function (tc) {
        const label = document.createElement('div');
        label.className = 'jc-search-tab-label';
        const navBtn = document.querySelector('.jellyfin-tab-button[data-tab="' + tc.id + '"]');
        label.textContent = (navBtn && _jeTabButtonLabel(navBtn)) || tc.id;
        tc.prepend(label);
    });
}

function exitSearchMode() {
    isSearchMode = false;
    form.classList.remove('jc-search-mode');
    tabContents.forEach(function (tc) {
        tc.classList.remove('jc-tab-name-match');
    });
    clearHighlights();
    document.querySelectorAll('.jc-search-tab-label').forEach(function (n) {
        n.remove();
    });
    tabs.forEach(function (t) {
        t.style.display = '';
        t.classList.remove('jc-search-reveal');
    });
    document.querySelectorAll('#JellyfinCanopyPage .jc-group-btn').forEach(function (gb) {
        gb.style.display = '';
    });
    document.querySelectorAll('.jc-nav-count').forEach(function (n) {
        n.remove();
    });
    // LOAD-BEARING inline-style reset: performSearch's inline 'block'/'none'
    // would otherwise beat `.jellyfin-tab-content.active { display: grid }`,
    // collapsing matched tabs to single-column or keeping unmatched tabs hidden
    // after their next activation. Outside search mode the `.active` class
    // alone owns visibility.
    tabContents.forEach(function (tc) {
        tc.style.display = '';
    });
    document.querySelectorAll('.jc-search-hidden').forEach(function (n) {
        n.classList.remove('jc-search-hidden');
    });
    savedDetailsStates.forEach(function (open, d) {
        d.open = open;
    });
    savedDetailsStates.clear();

    // Re-activate the persisted tab (fall back to overview when
    // missing/unknown/storage-throws).
    let savedTab = 'overview';
    try {
        const stored = sessionStorage.getItem('jellyfinCanopyActiveTab');
        if (stored) {
            savedTab = LEGACY_TAB_MAP[stored] || stored;
        }
    } catch (e) {
        // sessionStorage unavailable — fall back to overview
    }
    if (!document.getElementById(savedTab)) {
        savedTab = 'overview';
    }
    activateTab(savedTab);

    if (searchCount) {
        searchCount.style.display = 'none';
    }
    if (searchClear) {
        searchClear.style.display = 'none';
    }
}

function performSearch(query) {
    query = String(query || '').toLowerCase().trim();
    if (!query) {
        if (isSearchMode) {
            exitSearchMode();
        }
        return;
    }
    // 2-character minimum: 1-char queries match thousands of text nodes.
    if (query.length < 2) {
        if (isSearchMode) {
            exitSearchMode();
        }
        if (searchCount) {
            searchCount.textContent = 'Type 2+ characters to search';
            searchCount.style.display = 'block';
        }
        if (searchClear) {
            searchClear.style.display = 'block';
        }
        return;
    }

    if (!isSearchMode) {
        enterSearchMode();
    }
    clearHighlights();
    _jeDisplayCache = new WeakMap();

    let sectionCount = 0;
    const groupMatchCounts = {};

    tabContents.forEach(function (tc) {
        let tabHasMatch = false;
        tc.querySelectorAll(':scope > fieldset').forEach(function (fs) {
            // Index skips Essentials/wizard content by contract.
            if (fs.closest('#jcWizard, #jcEssentials')) {
                return;
            }
            if (!getSearchableText(fs).includes(query)) {
                fs.classList.add('jc-search-hidden');
                return;
            }
            fs.classList.remove('jc-search-hidden');
            tabHasMatch = true;
            sectionCount++;
            fs.querySelectorAll('details').forEach(function (d) {
                if (getSearchableText(d).includes(query)) {
                    d.classList.remove('jc-search-hidden');
                    d.open = true;
                } else {
                    d.classList.add('jc-search-hidden');
                }
            });
            highlightTextIn(fs, query);
        });

        tc.style.display = tabHasMatch ? 'block' : 'none';

        const navBtn = document.querySelector('.jellyfin-tab-button[data-tab="' + tc.id + '"]');
        let nameMatch = false;
        if (navBtn) {
            navBtn.style.display = tabHasMatch ? '' : 'none';
            navBtn.classList.toggle('jc-search-reveal', tabHasMatch);
            let badge = navBtn.querySelector('.jc-nav-count');
            if (tabHasMatch) {
                const count = tc.querySelectorAll(':scope > fieldset:not(.jc-search-hidden)').length;
                if (!badge) {
                    const h3 = navBtn.querySelector('h3');
                    if (h3) {
                        badge = document.createElement('span');
                        badge.className = 'jc-nav-count';
                        h3.appendChild(badge);
                    }
                }
                if (badge) {
                    badge.textContent = String(count);
                }
                const g = navBtn.dataset.group;
                if (g) {
                    groupMatchCounts[g] = (groupMatchCounts[g] || 0) + count;
                }
            } else if (badge) {
                badge.remove();
            }
            // Tab-name ranking: name-matched tabs sort first via CSS order: -1.
            nameMatch = tabHasMatch && _jeTabButtonLabel(navBtn).toLowerCase().includes(query);
        }
        tc.classList.toggle('jc-tab-name-match', nameMatch);
    });

    document.querySelectorAll('#JellyfinCanopyPage .jc-group-btn').forEach(function (gb) {
        const count = groupMatchCounts[gb.dataset.group] || 0;
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

    if (searchCount) {
        if (allMatches.length > 0) {
            searchCount.textContent = '0 of ' + allMatches.length;
        } else if (sectionCount > 0) {
            searchCount.textContent = sectionCount + ' section' + (sectionCount !== 1 ? 's' : '') + ' found';
        } else {
            searchCount.textContent = 'No results';
        }
        searchCount.style.display = 'block';
    }
    if (searchClear) {
        searchClear.style.display = 'block';
    }
}

function goToMatch(index) {
    if (!allMatches.length) {
        return;
    }
    if (currentMatchIdx >= 0 && allMatches[currentMatchIdx]) {
        allMatches[currentMatchIdx].classList.remove('jc-search-match-active');
    }
    if (index >= allMatches.length) {
        index = 0;
    }
    if (index < 0) {
        index = allMatches.length - 1;
    }
    currentMatchIdx = index;
    const match = allMatches[index];
    match.classList.add('jc-search-match-active');
    match.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (searchCount) {
        searchCount.textContent = (index + 1) + ' of ' + allMatches.length;
    }
}

function wireSearch() {
    captureStaticNodeLists();
    searchInput = document.querySelector('#settingsSearchInput');
    searchClear = document.querySelector('#settingsSearchClear');
    searchCount = document.querySelector('#settingsSearchCount');
    // Guard: the search container may be absent/hidden (jc-essentials-mode);
    // the rest of the page must keep working without it.
    if (!searchInput || !searchClear || !searchCount) {
        return;
    }

    searchInput.addEventListener('input', function () {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(function () {
            performSearch(searchInput.value);
        }, 150);
    });

    searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            // Kill any pending stale query so it can't re-enter search mode after exit.
            clearTimeout(searchDebounce);
            searchInput.value = '';
            performSearch('');
            searchInput.blur();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (allMatches.length) {
                goToMatch(currentMatchIdx + (e.shiftKey ? -1 : 1));
            }
        }
    });

    searchClear.addEventListener('click', function () {
        clearTimeout(searchDebounce);
        searchInput.value = '';
        performSearch('');
        searchInput.focus();
    });
}

/* SECTION: dashboards — owns: renderServiceStatusDashboard, renderFeaturesDashboard,
   renderOptionalPluginsDashboard, checkInstalledPlugins, setProbeWarning,
   checklistRowState, readFieldValue, readFieldChecked, resetAllUserSettings,
   updateClearTagCachesQuickBtnVisibility, plugin-detection flags
   (hasFileTransformation, hasIntroSkipper, hasInPlayerEpisodePreview, hasKefinTweaks),
   _jeDisabledPlugins, _jeProbeWarnings, OPTIONAL_PLUGINS, retest-all state.
   wires: wireDashboards.
   depends: pluginId, escapeHtml, _jeSuppressTestAlerts, clearConnectionTestCache,
   getPersistedTestResult, _jeNormalizeArrUrl, updateAllDependencies (core);
   jcNormalizeMaintainerrBaseUrl, jcFingerprintConnectionValue,
   cancelActiveMaintainerrTest (connections section); buildConfigFromForm (binder
   section); ApiClient, Dashboard (host).
   NOTE: renderChecklist()/updateStatusDashboard() aliases are removed per the
   approved dead-code list — all call sites use renderServiceStatusDashboard(). */

const RETEST_ALL_MIN_COOLDOWN_MS = 4000;
const RETEST_ALL_MAX_WAIT_MS = 25000;

const SERVICE_STATE_PRIORITY = { error: 0, warn: 1, pending: 2, ok: 3, off: 4 };
const SERVICE_STATUS_GLYPHS = {
    ok: 'check_circle',
    warn: 'warning',
    error: 'error',
    pending: 'hourglass_empty'
};

const OPTIONAL_PLUGINS = [
    {
        key: 'fileTransformation',
        name: 'File Transformation',
        icon: 'transform',
        url: 'https://github.com/IAmParadox27/jellyfin-plugin-file-transformation',
        purpose: 'Required by Custom Tabs, Plugin Pages, and other plugins that modify the web client.'
    },
    {
        key: 'introSkipper',
        name: 'Intro Skipper',
        icon: 'skip_next',
        url: 'https://github.com/intro-skipper/intro-skipper',
        purpose: 'Source of timestamps for Auto-skip Intro / Auto-skip Outro.'
    },
    {
        key: 'inPlayerEpisodePreview',
        name: 'In-Player Episode Preview',
        icon: 'movie_filter',
        url: 'https://github.com/Namo2/InPlayerEpisodePreview',
        purpose: 'Enables the in-player Episode Preview keyboard shortcut.'
    },
    {
        key: 'kefinTweaks',
        name: 'KefinTweaks',
        icon: 'bookmark_border',
        url: 'https://github.com/ranaldsgift/KefinTweaks',
        purpose: 'Renders the Watchlist UI in Jellyfin. Required to view watchlisted items from the Seerr Watchlist features. Installs as a web-mod (not a normal plugin), detected via its injected scripts.'
    }
];

// Plugin-detection flags. Tri-state: true = installed AND Active, false = missing
// or not Active, null = probe not run / failed. Read by the features dashboard,
// the optional-plugins dashboard, and core dependency gating.
let hasFileTransformation = null;
let hasIntroSkipper = null;
let hasInPlayerEpisodePreview = null;
let hasKefinTweaks = null;
let _jeDisabledPlugins = {};
const _jeProbeWarnings = {};

const _jeStatusDashboardWarnedSelectors = new Set();

let _jeRetestLastRun = 0;
let _jeRetestPollTimer = null;
let _jeRetestHardStopTimer = null;

function readFieldValue(sel) {
    const el = document.querySelector(sel);
    if (!el) {
        if (!_jeStatusDashboardWarnedSelectors.has(sel)) {
            _jeStatusDashboardWarnedSelectors.add(sel);
            console.warn('[JC] status dashboard: selector "' + sel + '" not found');
        }
        return '';
    }
    return String(el.value || '').trim();
}

function readFieldChecked(sel) {
    const el = document.querySelector(sel);
    if (!el) {
        if (!_jeStatusDashboardWarnedSelectors.has(sel)) {
            _jeStatusDashboardWarnedSelectors.add(sel);
            console.warn('[JC] status dashboard: selector "' + sel + '" not found');
        }
        return false;
    }
    return !!el.checked;
}

function readArrCardField(card, sel) {
    const el = card.querySelector(sel);
    return el ? String(el.value || '').trim() : '';
}

// Maps a persisted connection-test result (connections section cache) onto a
// checklist row. No cached result (or binding mismatch, handled inside
// getPersistedTestResult) → pending with the caller's default detail.
/* checklistRowState is owned by the connections section. */

// Cached test results use 'amber' for soft failures; the dashboard vocabulary is
// ok/warn/error/pending/off.
function mapChecklistState(state) {
    return state === 'amber' ? 'warn' : state;
}

/* Contract alias: the connection-test cache refreshes dashboards through this
   name (the maintainerr drift-guard harness stubs it). */
function renderChecklist() {
    renderServiceStatusDashboard();
}

function renderServiceStatusDashboard() {
    const root = document.querySelector('#jc-service-dashboard');
    if (!root) {
        return;
    }
    root.textContent = '';

    const cards = [];

    // 1. TMDB — always present, presence-based only. Quirk preserved: cached
    // 'tmdb' test results are deliberately ignored by this card.
    const tmdbKey = readFieldValue('#TMDB_API_KEY');
    cards.push({
        id: 'tmdb',
        name: 'TMDB',
        tab: 'elsewhere',
        icon: 'vpn_key',
        state: tmdbKey ? 'ok' : 'off',
        detail: tmdbKey ? 'API key set' : 'No API key',
        scrollTo: '#TMDB_API_KEY'
    });

    // 2. Seerr — only when relevant.
    const seerrEnabled = readFieldChecked('#seerrEnabled');
    const seerrUrlsRaw = readFieldValue('#seerrUrls');
    const seerrUrlCount = seerrUrlsRaw
        .split('\n')
        .map(function (line) { return line.trim(); })
        .filter(Boolean)
        .length;
    const seerrKey = readFieldValue('#SeerrApiKey');
    if (seerrEnabled && seerrUrlCount > 0 && seerrKey) {
        const row = checklistRowState('seerr', 'Configured — not yet verified');
        cards.push({
            id: 'seerr',
            name: 'Seerr',
            tab: 'seerr',
            icon: 'bolt',
            state: mapChecklistState(row.state),
            detail: row.detail + (seerrUrlCount > 1 ? ' · ' + seerrUrlCount + ' URLs' : '')
        });
    } else if (seerrEnabled) {
        cards.push({
            id: 'seerr',
            name: 'Seerr',
            tab: 'seerr',
            icon: 'bolt',
            state: 'warn',
            detail: (seerrUrlCount === 0 && !seerrKey) ? 'Enabled but URL and API key missing'
                : (seerrUrlCount === 0 ? 'URL missing' : 'API key missing')
        });
    } else if (seerrUrlsRaw || seerrKey) {
        cards.push({
            id: 'seerr',
            name: 'Seerr',
            tab: 'seerr',
            icon: 'bolt',
            state: 'off',
            detail: 'Configured but integration disabled'
        });
    }

    // 3. Maintainerr — URL-only by design (Maintainerr 3.18 has no API auth).
    const maintainerrEnabled = readFieldChecked('#maintainerrEnabled');
    const maintainerrRaw = readFieldValue('#maintainerrUrl');
    const normalizedMaintainerrUrl = jcNormalizeMaintainerrBaseUrl(maintainerrRaw);
    if (maintainerrEnabled && normalizedMaintainerrUrl) {
        const row = checklistRowState(
            'maintainerr',
            'Configured — not yet verified',
            jcFingerprintConnectionValue(normalizedMaintainerrUrl)
        );
        cards.push({
            id: 'maintainerr',
            name: 'Maintainerr',
            tab: 'maintainerr',
            icon: 'cleaning_services',
            state: mapChecklistState(row.state),
            detail: row.detail,
            scrollTo: '#maintainerrUrl'
        });
    } else if (maintainerrEnabled) {
        cards.push({
            id: 'maintainerr',
            name: 'Maintainerr',
            tab: 'maintainerr',
            icon: 'cleaning_services',
            state: 'warn',
            detail: maintainerrRaw ? 'Enabled but URL is invalid' : 'Enabled but URL missing'
        });
    } else if (maintainerrRaw) {
        cards.push({
            id: 'maintainerr',
            name: 'Maintainerr',
            tab: 'maintainerr',
            icon: 'cleaning_services',
            state: 'off',
            detail: 'Configured but integration disabled'
        });
    }

    // 4. Sonarr / Radarr — one card per instance card.
    [
        { type: 'sonarr', listSel: '#sonarrInstancesList', defaultName: 'Sonarr', icon: 'tv' },
        { type: 'radarr', listSel: '#radarrInstancesList', defaultName: 'Radarr', icon: 'movie' }
    ].forEach(function (svc) {
        document.querySelectorAll(svc.listSel + ' .arr-instance-card').forEach(function (card) {
            const url = readArrCardField(card, '.arr-instance-url');
            const apiKey = readArrCardField(card, '.arr-instance-apikey');
            if (!url && !apiKey) {
                return;
            }
            const nameInput = card.querySelector('.arr-instance-name');
            const name = (nameInput && String(nameInput.value || '').trim()) || svc.defaultName;
            const cacheKey = svc.type + ':' + _jeNormalizeArrUrl(url);
            const enabledCb = card.querySelector('.arr-instance-enabled');
            let state;
            let detail;
            if (enabledCb && !enabledCb.checked) {
                // Overrides any cached test state — a stale green/red on a
                // disabled instance is misleading.
                state = 'off';
                detail = 'Disabled';
            } else if (!url) {
                state = 'warn';
                detail = 'URL missing';
            } else if (!apiKey) {
                state = 'warn';
                detail = 'API key missing';
            } else {
                const row = checklistRowState(cacheKey, 'Configured — not yet verified');
                state = mapChecklistState(row.state);
                detail = row.detail;
            }
            cards.push({
                id: cacheKey,
                name: name,
                tab: 'arr',
                icon: svc.icon,
                state: state,
                detail: detail
            });
        });
    });

    // 5. Bazarr — no test endpoint.
    const bazarrUrl = readFieldValue('#bazarrUrl');
    const bazarrMappings = readFieldValue('#bazarrUrlMappings');
    if (bazarrUrl || bazarrMappings) {
        cards.push({
            id: 'bazarr',
            name: 'Bazarr',
            tab: 'arr',
            icon: 'subtitles',
            state: bazarrUrl ? 'ok' : 'warn',
            detail: bazarrUrl ? 'URL configured' : 'Only URL mappings set'
        });
    }

    if (!cards.length) {
        const empty = document.createElement('div');
        empty.className = 'jc-checklist-empty';
        empty.textContent = 'Configure TMDB, Seerr, Maintainerr, or an *arr instance to see its status here.';
        root.appendChild(empty);
        return;
    }

    cards.sort(function (a, b) {
        const pa = SERVICE_STATE_PRIORITY[a.state] !== undefined ? SERVICE_STATE_PRIORITY[a.state] : 99;
        const pb = SERVICE_STATE_PRIORITY[b.state] !== undefined ? SERVICE_STATE_PRIORITY[b.state] : 99;
        return pa - pb;
    });

    cards.forEach(function (card) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'jc-service-card jc-state-' + card.state;
        btn.dataset.target = card.tab;
        btn.dataset.statusId = card.id;

        const icon = document.createElement('i');
        icon.className = 'material-icons jc-service-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = card.state === 'off'
            ? (card.icon || 'radio_button_unchecked')
            : (SERVICE_STATUS_GLYPHS[card.state] || card.icon || 'radio_button_unchecked');

        const body = document.createElement('div');
        body.className = 'jc-service-body';
        const nameEl = document.createElement('div');
        nameEl.className = 'jc-service-name';
        nameEl.textContent = card.name;
        const detailEl = document.createElement('div');
        detailEl.className = 'jc-service-detail';
        detailEl.textContent = card.detail;
        body.appendChild(nameEl);
        body.appendChild(detailEl);

        btn.appendChild(icon);
        btn.appendChild(body);

        btn.addEventListener('click', function () {
            const tabBtn = document.querySelector('.jellyfin-tab-button[data-tab="' + card.tab + '"]');
            if (tabBtn) {
                tabBtn.click();
            }
            if (card.scrollTo) {
                // Double rAF: deliberately lands one frame after activateTab's
                // single-rAF scroll restore so the deep link wins deterministically.
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        const target = document.querySelector(card.scrollTo);
                        if (!target) {
                            console.warn('[JC] service-status deep-link target not found:', card.scrollTo);
                            return;
                        }
                        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    });
                });
            }
        });

        root.appendChild(btn);
    });
}

function renderFeaturesDashboard() {
    const root = document.querySelector('#jc-features-dashboard');
    if (!root) {
        return;
    }
    root.textContent = '';

    function bool(id) {
        const el = document.querySelector('#' + id);
        return !!(el && el.checked);
    }

    function val(id) {
        const el = document.querySelector('#' + id);
        return el ? String(el.value || '').trim() : '';
    }

    // Any instance card with url+key. Enabled-ness deliberately NOT checked here
    // (unlike hasAnyArrService).
    function anyArrConfigured() {
        const arrCards = document.querySelectorAll('#sonarrInstancesList .arr-instance-card, #radarrInstancesList .arr-instance-card');
        return Array.prototype.some.call(arrCards, function (card) {
            return !!(readArrCardField(card, '.arr-instance-url') && readArrCardField(card, '.arr-instance-apikey'));
        });
    }

    // Note: deliberately does NOT require the enable toggle.
    function seerrConfigured() {
        return !!(val('seerrUrls') && val('SeerrApiKey'));
    }

    function feat(name, enabled, tab, detail, warn) {
        if (!enabled) {
            return { name: name, tab: tab, state: 'off', detail: 'Disabled' };
        }
        return { name: name, tab: tab, state: warn ? 'warn' : 'on', detail: detail };
    }

    const arrConfigured = anyArrConfigured();
    const seerrReady = seerrConfigured();
    const tmdbMissing = !val('TMDB_API_KEY');
    const introSkipperMissing = hasIntroSkipper !== true;
    const kefinTweaksMissing = hasKefinTweaks !== true;
    const tagCount = [
        'qualityTagsEnabled',
        'genreTagsEnabled',
        'languageTagsEnabled',
        'ratingTagsEnabled',
        'peopleTagsEnabled'
    ].filter(bool).length;

    const rows = [
        feat('Remove from Continue Watching', bool('removeContinueWatchingEnabled'), 'display', 'Enabled', false),
        feat('Hide Favorites Tab', bool('hideFavoritesTab'), 'display', 'Enabled', false),
        feat('Media Tags', tagCount > 0, 'display', tagCount + ' tag type(s) enabled', false),
        feat('Random Button', bool('randomButtonEnabled'), 'display', 'Enabled', false),
        feat('Custom Pause Screen', bool('pauseScreenEnabled'), 'playback', 'Enabled', false),
        feat('Long press for 2x speed', bool('longPress2xEnabled'), 'playback', 'Enabled (touch devices)', false),
        feat('Auto-skip Intro/Outro', bool('autoSkipIntro') || bool('autoSkipOutro'), 'playback',
            introSkipperMissing ? 'Enabled but Intro Skipper plugin is missing' : 'Enabled', introSkipperMissing),
        feat('Tab-switch actions', bool('autoPauseEnabled') || bool('autoResumeEnabled') || bool('autoPipEnabled'), 'playback',
            'Auto-pause / resume / PiP', false),
        feat('Bookmarks', bool('bookmarksEnabled'), 'pages', 'Enabled', false),
        feat('Hidden Content', bool('hiddenContentEnabled'), 'pages', 'Enabled', false),
        feat('Requests Page', bool('downloadsPageEnabled'), 'pages',
            (!seerrReady && !arrConfigured) ? 'Enabled but neither Seerr nor *arr is configured' : 'Enabled',
            !seerrReady && !arrConfigured),
        feat('Calendar Page', bool('calendarPageEnabled'), 'pages',
            !arrConfigured ? 'Enabled but no *arr instance is configured' : 'Enabled', !arrConfigured),
        feat('Custom splash / branding', bool('enableCustomSplashScreen'), 'extras', 'Enabled', false),
        feat('Elsewhere (streaming providers)', bool('elsewhereEnabled'), 'elsewhere',
            tmdbMissing ? 'Enabled but TMDB API key is missing' : 'Enabled', tmdbMissing),
        feat('Seerr integration', bool('seerrEnabled'), 'seerr',
            !seerrReady ? 'Enabled but Seerr URL or API key missing' : 'Enabled', !seerrReady),
        feat('Watchlist sync', bool('addRequestedMediaToWatchlist') || bool('syncSeerrWatchlist'), 'seerr',
            kefinTweaksMissing ? 'Enabled but KefinTweaks plugin not installed (watchlist UI won\'t render)' : 'Enabled',
            kefinTweaksMissing),
        feat('*arr detail-page links', bool('arrLinksEnabled'), 'arr',
            !arrConfigured ? 'Enabled but no *arr instance is configured' : 'Enabled', !arrConfigured),
        feat('*arr tags sync', bool('arrTagsSyncEnabled'), 'arr',
            !arrConfigured ? 'Enabled but no *arr instance is configured' : 'Enabled', !arrConfigured)
    ];

    const FEATURE_STATE_PRIORITY = { warn: 0, on: 1, off: 2 };
    rows.sort(function (a, b) {
        const pa = FEATURE_STATE_PRIORITY[a.state] !== undefined ? FEATURE_STATE_PRIORITY[a.state] : 99;
        const pb = FEATURE_STATE_PRIORITY[b.state] !== undefined ? FEATURE_STATE_PRIORITY[b.state] : 99;
        return pa - pb;
    });

    if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'jc-checklist-empty';
        empty.textContent = 'No features configured yet.';
        root.appendChild(empty);
        return;
    }

    const FEATURE_GLYPHS = { on: 'check_circle', warn: 'warning', off: 'radio_button_unchecked' };
    rows.forEach(function (row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'jc-feature-row jc-state-' + row.state;
        btn.dataset.target = row.tab;

        const icon = document.createElement('i');
        icon.className = 'material-icons jc-feature-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = FEATURE_GLYPHS[row.state] || 'radio_button_unchecked';

        const body = document.createElement('div');
        body.className = 'jc-feature-body';
        const nameEl = document.createElement('div');
        nameEl.className = 'jc-feature-name';
        nameEl.textContent = row.name;
        const detailEl = document.createElement('div');
        detailEl.className = 'jc-feature-detail';
        detailEl.textContent = row.detail;
        body.appendChild(nameEl);
        body.appendChild(detailEl);

        btn.appendChild(icon);
        btn.appendChild(body);

        btn.addEventListener('click', function () {
            const tabBtn = document.querySelector('.jellyfin-tab-button[data-tab="' + row.tab + '"]');
            if (tabBtn) {
                tabBtn.click();
            }
        });

        root.appendChild(btn);
    });
}

function optionalPluginFlag(key) {
    switch (key) {
        case 'fileTransformation': return hasFileTransformation;
        case 'introSkipper': return hasIntroSkipper;
        case 'inPlayerEpisodePreview': return hasInPlayerEpisodePreview;
        case 'kefinTweaks': return hasKefinTweaks;
        default: return null;
    }
}

function renderOptionalPluginsDashboard() {
    const root = document.querySelector('#jc-optional-plugins');
    if (!root) {
        return;
    }
    root.textContent = '';

    const OPTIONAL_PLUGIN_GLYPHS = {
        installed: 'check_circle',
        warn: 'warning',
        unknown: 'help_outline',
        missing: 'radio_button_unchecked'
    };

    OPTIONAL_PLUGINS.forEach(function (plugin) {
        const flag = optionalPluginFlag(plugin.key);
        let state;
        let statusText;
        if (flag === true) {
            state = 'installed';
            statusText = 'Installed';
        } else if (flag === false && _jeDisabledPlugins[plugin.key]) {
            // Copy is known to be imprecise for Restart/Superseded; the raw
            // status is available in _jeDisabledPlugins.
            state = 'warn';
            statusText = 'Installed but disabled in Dashboard > Plugins';
        } else if (flag === false) {
            state = 'missing';
            statusText = 'Not installed';
        } else {
            state = 'unknown';
            statusText = 'Checking…';
        }

        const card = document.createElement('div');
        card.className = 'jc-optional-plugin-card jc-state-' + state;

        const icon = document.createElement('i');
        icon.className = 'material-icons jc-optional-plugin-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = OPTIONAL_PLUGIN_GLYPHS[state];

        const body = document.createElement('div');
        body.className = 'jc-optional-plugin-body';
        const nameEl = document.createElement('div');
        nameEl.className = 'jc-optional-plugin-name';
        nameEl.textContent = plugin.name;
        const statusEl = document.createElement('div');
        statusEl.className = 'jc-optional-plugin-status';
        statusEl.textContent = statusText;
        const purposeEl = document.createElement('div');
        purposeEl.className = 'jc-optional-plugin-purpose';
        purposeEl.textContent = plugin.purpose;
        body.appendChild(nameEl);
        body.appendChild(statusEl);
        body.appendChild(purposeEl);

        card.appendChild(icon);
        card.appendChild(body);

        if (plugin.url) {
            const link = document.createElement('a');
            link.className = 'jc-optional-plugin-link';
            link.href = plugin.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = 'Open ' + plugin.name + ' on GitHub';
            link.setAttribute('aria-label', 'Open ' + plugin.name + ' on GitHub');
            const linkIcon = document.createElement('i');
            linkIcon.className = 'material-icons';
            linkIcon.setAttribute('aria-hidden', 'true');
            linkIcon.textContent = 'open_in_new';
            link.appendChild(linkIcon);
            card.appendChild(link);
        }

        root.appendChild(card);
    });
}

function checkInstalledPlugins() {
    return ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl('/Plugins'),
        dataType: 'json'
    }).then(function (plugins) {
        setProbeWarning('plugins', null);
        _jeDisabledPlugins = {};
        const list = Array.isArray(plugins) ? plugins : [];
        const KNOWN_INACTIVE_STATUSES = ['Disabled', 'Restart', 'NotSupported', 'Malfunctioned', 'Superseded'];

        function probe(key, names) {
            const lowered = names.map(function (n) { return n.toLowerCase(); });
            const match = list.find(function (p) {
                return p && typeof p.Name === 'string' && lowered.indexOf(p.Name.toLowerCase()) !== -1;
            });
            if (!match) {
                return false;
            }
            const active = match.Status === 'Active';
            if (!active) {
                _jeDisabledPlugins[key] = match.Status || 'Status unknown';
                if (KNOWN_INACTIVE_STATUSES.indexOf(match.Status) === -1) {
                    console.warn('[JC] plugin ' + match.Name + ' has unexpected Status value: ' + match.Status);
                }
            }
            return active;
        }

        hasFileTransformation = probe('fileTransformation', ['File Transformation']);
        hasIntroSkipper = probe('introSkipper', ['Intro Skipper', 'SkipIntro']);
        hasInPlayerEpisodePreview = probe('inPlayerEpisodePreview',
            ['In Player Episode Preview', 'In-Player Episode Preview', 'InPlayerEpisodePreview']);

        // KefinTweaks is a web-mod, not a /Plugins entry: runtime detection.
        try {
            hasKefinTweaks = !!(window.KefinTweaksConfig || document.querySelector('script[src*="KefinTweaks"]'));
        } catch (e) {
            console.warn('[JC] KefinTweaks detection threw; treating as absent:', e);
            hasKefinTweaks = false;
        }

        document.body.classList.toggle('jc-has-introskipper', hasIntroSkipper === true);
        document.body.classList.toggle('jc-has-inplayerepisodepreview', hasInPlayerEpisodePreview === true);
        document.body.classList.toggle('jc-has-kefintweaks', hasKefinTweaks === true);

        updateAllDependencies();
        renderOptionalPluginsDashboard();
        renderFeaturesDashboard();
    }).catch(function (e) {
        console.warn('[JC] plugin detection failed; resetting detection state to avoid stale UI:', e);
        hasFileTransformation = null;
        hasIntroSkipper = null;
        hasInPlayerEpisodePreview = null;
        hasKefinTweaks = null;
        document.body.classList.remove('jc-has-introskipper');
        document.body.classList.remove('jc-has-inplayerepisodepreview');
        document.body.classList.remove('jc-has-kefintweaks');
        setProbeWarning('plugins', 'Couldn\'t reach the Jellyfin /Plugins endpoint to verify which integrations are installed (auth expiry, network, or server issue). Dependency hints and "plugin detected" badges are now hidden until you retry.');
        try {
            updateAllDependencies();
        } catch (e2) {
            console.warn('[JC] updateAllDependencies failed after plugin probe error:', e2);
        }
        try {
            renderServiceStatusDashboard();
        } catch (e3) {
            console.warn('[JC] status dashboard refresh failed after plugin probe error:', e3);
        }
        renderOptionalPluginsDashboard();
        renderFeaturesDashboard();
    });
}

function setProbeWarning(source, msg) {
    if (msg) {
        _jeProbeWarnings[source] = msg;
    } else {
        delete _jeProbeWarnings[source];
    }
    const banner = document.querySelector('#jc-probe-warning');
    const msgEl = document.querySelector('#jc-probe-warning-msg');
    if (!banner || !msgEl) {
        return;
    }
    const messages = Object.keys(_jeProbeWarnings).map(function (k) { return _jeProbeWarnings[k]; });
    if (!messages.length) {
        banner.style.display = 'none';
        msgEl.textContent = '';
        return;
    }
    msgEl.textContent = ' — ' + messages.join(' / ');
    banner.style.display = '';
}


async function resetAllUserSettings() {
    if (!confirm('Are you sure?\n\nThis will save the current configuration and overwrite every per-user default for ALL users on this server.')) {
        return;
    }
    Dashboard.showLoadingMsg();
    try {
        const config = await buildConfigFromForm();
        // Save first so the server applies the CURRENT form.
        await ApiClient.updatePluginConfiguration(pluginId, config);
        await ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl('/JellyfinCanopy/reset-all-users-settings'),
            dataType: 'json'
        });
        Dashboard.hideLoadingMsg();
        Dashboard.alert({
            title: 'Success',
            message: 'Configuration saved and applied to all users successfully!\n\nSettings will take effect after users refresh their browsers.'
        });
    } catch (e) {
        Dashboard.hideLoadingMsg();
        console.error('Failed to save and apply settings:', e);
        Dashboard.alert({
            title: 'Error',
            message: 'Failed to save and apply settings to all users. Check server logs for details.'
        });
    }
}

function clearTagCaches() {
    if (!confirm('Clear all client caches?\n\nThis will force all clients to clear their quality and genre tag caches on next page load.')) {
        return;
    }
    // Full config round-trip: uses server state, does NOT include unsaved form edits.
    ApiClient.getPluginConfiguration(pluginId).then(function (config) {
        config.ClearLocalStorageTimestamp = Date.now();
        return ApiClient.updatePluginConfiguration(pluginId, config);
    }).then(function () {
        Dashboard.alert({
            title: 'Success',
            message: 'Cache clear signal sent. All clients will clear their caches on next page load.'
        });
    }).catch(function (e) {
        console.warn('[JC] failed to set cache clear timestamp:', e);
        Dashboard.alert({
            title: 'Error',
            message: 'Failed to set cache clear timestamp. Check server logs for details.'
        });
    });
}

// The quick action is only relevant when the server-side tag cache is off.
function updateClearTagCachesQuickBtnVisibility() {
    const quickBtn = document.querySelector('#clearTagCachesQuickBtn');
    if (!quickBtn) {
        return;
    }
    const serverModeCb = document.querySelector('#tagCacheServerMode');
    quickBtn.hidden = !!(serverModeCb && serverModeCb.checked);
}

function wireDashboards() {
    const retryBtn = document.querySelector('#jc-probe-retry-btn');
    if (retryBtn && !retryBtn.dataset.jcWired) {
        retryBtn.dataset.jcWired = 'true';
        retryBtn.addEventListener('click', function () {
            setProbeWarning('plugins', null);
            checkInstalledPlugins();
        });
    }

    const retestAllConnectionsBtn = document.querySelector('#retestAllConnectionsBtn');
    if (retestAllConnectionsBtn && !retestAllConnectionsBtn.dataset.jcWired) {
        retestAllConnectionsBtn.dataset.jcWired = 'true';
        retestAllConnectionsBtn.addEventListener('click', function (e) {
            e.preventDefault();
            runRetestAllConnections();
        });
    }

    const resetBtn = document.querySelector('#resetAllUserSettingsBtn');
    if (resetBtn && !resetBtn.dataset.jcWired) {
        resetBtn.dataset.jcWired = 'true';
        resetBtn.addEventListener('click', function (e) {
            e.preventDefault();
            resetAllUserSettings();
        });
    }

    const clearTagsBtn = document.querySelector('#clearTagsCacheBtn');
    if (clearTagsBtn && !clearTagsBtn.dataset.jcWired) {
        clearTagsBtn.dataset.jcWired = 'true';
        clearTagsBtn.addEventListener('click', function (e) {
            e.preventDefault();
            clearTagCaches();
        });
    }

    const quickClearBtn = document.querySelector('#clearTagCachesQuickBtn');
    if (quickClearBtn && !quickClearBtn.dataset.jcWired) {
        quickClearBtn.dataset.jcWired = 'true';
        quickClearBtn.addEventListener('click', function (e) {
            e.preventDefault();
            const canonical = document.querySelector('#clearTagsCacheBtn');
            if (canonical) {
                canonical.click();
            }
        });
    }

    const serverModeCb = document.querySelector('#tagCacheServerMode');
    if (serverModeCb && !serverModeCb.dataset.jcQuickVisWired) {
        serverModeCb.dataset.jcQuickVisWired = 'true';
        serverModeCb.addEventListener('change', updateClearTagCachesQuickBtnVisibility);
    }
    updateClearTagCachesQuickBtnVisibility();
}

function runRetestAllConnections() {
    const btn = document.querySelector('#retestAllConnectionsBtn');
    const now = Date.now();
    const remainingMs = _jeRetestLastRun + RETEST_ALL_MIN_COOLDOWN_MS - now;
    if (remainingMs > 0) {
        // Guardrail against double-clicks, not a security boundary.
        Dashboard.alert({
            title: 'Please wait',
            message: 'Re-test is rate-limited. Try again in ' + Math.ceil(remainingMs / 1000) + ' s.'
        });
        return;
    }

    cancelActiveMaintainerrTest(true);
    clearConnectionTestCache();

    _jeSuppressTestAlerts = true;
    _jeRetestLastRun = now;
    const titleEl = btn ? btn.querySelector('.jc-quick-action-title') : null;
    const originalTitle = titleEl ? titleEl.textContent : '';
    if (btn) {
        btn.disabled = true;
    }
    if (titleEl) {
        titleEl.textContent = 'Retesting…';
    }

    let tested = 0;

    // TMDB: one click is enough — the key is shared between both testTmdbBtn instances.
    const tmdbBtn = document.querySelector('.testTmdbBtn');
    if (tmdbBtn && !tmdbBtn.disabled) {
        tmdbBtn.click();
        tested++;
    }

    // Seerr: skipping the incomplete case avoids a noisy "missing info" alert.
    const seerrTestBtn = document.querySelector('#testSeerrBtn');
    if (readFieldChecked('#seerrEnabled')
        && readFieldValue('#seerrUrls')
        && readFieldValue('#SeerrApiKey')
        && seerrTestBtn && !seerrTestBtn.disabled) {
        seerrTestBtn.click();
        tested++;
    }

    const testMaintainerrBtn = document.querySelector('#testMaintainerrBtn');
    if (readFieldChecked('#maintainerrEnabled')
        && jcNormalizeMaintainerrBaseUrl(readFieldValue('#maintainerrUrl'))
        && testMaintainerrBtn && !testMaintainerrBtn.disabled) {
        testMaintainerrBtn.click();
        tested++;
    }

    document.querySelectorAll('.arr-instance-test').forEach(function (testBtn) {
        if (testBtn.disabled) {
            return;
        }
        const card = testBtn.closest('.arr-instance-card');
        if (!card) {
            return;
        }
        if (readArrCardField(card, '.arr-instance-url') && readArrCardField(card, '.arr-instance-apikey')) {
            testBtn.click();
            tested++;
        }
    });

    // Always re-render so the user sees feedback (rows flipped to pending).
    renderServiceStatusDashboard();

    if (tested === 0) {
        _jeSuppressTestAlerts = false;
        if (btn) {
            btn.disabled = false;
        }
        if (titleEl) {
            titleEl.textContent = originalTitle;
        }
        _jeRetestLastRun = 0;
        Dashboard.alert({
            title: 'Nothing to re-test',
            message: 'Enable and configure at least one service (TMDB, Seerr, Maintainerr, Sonarr, or Radarr) before running a re-test.'
        });
        return;
    }

    const startedAt = Date.now();
    let released = false;

    function release() {
        if (released) {
            return;
        }
        released = true;
        if (_jeRetestPollTimer) {
            clearInterval(_jeRetestPollTimer);
            _jeRetestPollTimer = null;
        }
        if (_jeRetestHardStopTimer) {
            clearTimeout(_jeRetestHardStopTimer);
            _jeRetestHardStopTimer = null;
        }
        _jeSuppressTestAlerts = false;
        if (btn) {
            btn.disabled = false;
        }
        if (titleEl) {
            titleEl.textContent = originalTitle;
        }
        renderServiceStatusDashboard();
    }

    // The per-service test handlers aren't promises, so poll the '.status-check'
    // indicator class every test adds on start and removes on resolve. The
    // cooldown floor also covers the first-tick race before indicators swap to 'sync'.
    _jeRetestPollTimer = setInterval(function () {
        const inFlight = document.querySelectorAll('.status-check').length;
        const elapsed = Date.now() - startedAt;
        if (inFlight === 0 && elapsed >= RETEST_ALL_MIN_COOLDOWN_MS) {
            release();
        } else if (elapsed >= RETEST_ALL_MAX_WAIT_MS) {
            console.warn('[JC] retest-all: giving up on ' + inFlight + ' in-flight test(s) after ' + elapsed + 'ms');
            release();
        }
    }, 300);
    // Extra hard stop in case setInterval is throttled (backgrounded tab).
    _jeRetestHardStopTimer = setTimeout(release, RETEST_ALL_MAX_WAIT_MS + 500);
}

        /* SECTION: connections-arr — owns: connection-test cache + persistence (beginConnectionTest,
         * setConnectionTestResult, getConnectionTestResult, getPersistedTestResult, invalidatePersistedTest,
         * clearConnectionTestCache, checklistRowState, formatLastTested, jcFingerprintConnectionValue,
         * _jeNormalizeArrUrl, CONNECTION_TEST_CACHE_TTL_MS, _jeConnectionTestCache, _jeCacheGeneration,
         * _testToken, _jeSuppressTestAlerts, jcTestAlert, _wireInvalidate); per-service testers
         * (testSeerrConnection, testTmdbConnection, testMaintainerrConnection + jcSetMaintainerrTestStatus /
         * cancelActiveMaintainerrTest / jcIsCurrentMaintainerrTest / jcParseMaintainerrTestStatus /
         * jcNormalizeMaintainerrBaseUrl / jcIsSafeMaintainerrPathSegment, testInstanceConnection,
         * connectionErrorMessage); mapping validation (validateMappingSet, jcRunMappingValidation,
         * _jeValidateInstanceMappings, validateMaintainerrMappingSet, jcValidateMaintainerrMappings,
         * renderMappingValidationResult); Seerr scan trigger (triggerSeerrScanNow, cancelActiveSeerrScan,
         * jcParseSeerrIdentityDomains, jcNormalizeSeerrIdentityDomain, jcDispatchSeerrScanDomains,
         * jcSummarizeSeerrScanDispatch); arr instance cards (normalizeArrInstanceId, createArrInstanceId,
         * createInstanceCard, tryParseInstanceList, insertCorruptBanner, _arrParseOK, loadArrInstances,
         * renderArrInstances, collectInstancesFromDom, jcIsHttpUrl, buildArrInstanceWarnings +
         * buildArrIncompleteWarning / buildArrRenamedWarning / buildArrDroppedExternalWarning).
         * wires: wireConnections, wireArrInstances.
         * depends: page, escapeHtml, jcMarkConfigDirty, updateAllDependencies, renderChecklist (dashboards),
         * renderServiceStatusDashboard (dashboards), Dashboard, ApiClient.
         * Does NOT define saveArrInstances — core owns it; it consumes collectInstancesFromDom and
         * buildArrInstanceWarnings from here. Mutable module state uses `let` (initializers are
         * side-effect free); _jeSuppressTestAlerts is assigned by the Re-test-all batch (dashboards). */

        // ---------------------------------------------------------------------------
        // A. Connection-test cache (shared by every tester on this page)
        // ---------------------------------------------------------------------------

        const CONNECTION_TEST_CACHE_TTL_MS = 5 * 60 * 1000;
        const _jeConnectionTestCache = new Map();
        let _jeCacheGeneration = 0;
        let _testToken = 0;
        let _jeSuppressTestAlerts = false;

        function beginConnectionTest() {
            return _jeCacheGeneration;
        }

        function jcTestAlert(opts) {
            if (_jeSuppressTestAlerts) {
                return;
            }
            try {
                Dashboard.alert(opts);
            } catch (e) {
                console.warn('[JC] Dashboard.alert threw:', e);
            }
        }

        function setConnectionTestResult(key, status, detail, token, binding) {
            // A token minted before a cache clear must not overwrite a fresher result.
            if (token !== undefined && token !== _jeCacheGeneration) {
                return;
            }
            const at = Date.now();
            _jeConnectionTestCache.set(key, {
                status: status,
                detail: detail || '',
                binding: binding || '',
                at: at
            });
            try {
                localStorage.setItem('jc_conn_test_' + key, JSON.stringify({
                    status: status,
                    detail: detail || '',
                    binding: binding || undefined,
                    at: at
                }));
            } catch (e) {
                // Best-effort persistence only.
            }
            try {
                renderChecklist();
            } catch (e) {
                console.warn('[JC] renderChecklist threw after setConnectionTestResult:', e);
            }
        }

        function getConnectionTestResult(key, binding) {
            const entry = _jeConnectionTestCache.get(key);
            if (!entry) {
                return null;
            }
            if (binding && entry.binding !== binding) {
                _jeConnectionTestCache.delete(key);
                return null;
            }
            if (Date.now() - entry.at > CONNECTION_TEST_CACHE_TTL_MS) {
                _jeConnectionTestCache.delete(key);
                return null;
            }
            return entry;
        }

        function getPersistedTestResult(key, binding) {
            // Deliberately no TTL: persisted entries outlive reloads to show "Last tested <date>".
            const storageKey = 'jc_conn_test_' + key;
            try {
                const raw = localStorage.getItem(storageKey);
                if (!raw) {
                    return null;
                }
                const rec = JSON.parse(raw);
                if (!rec || typeof rec.at !== 'number' || typeof rec.status !== 'string') {
                    localStorage.removeItem(storageKey);
                    return null;
                }
                if (binding && rec.binding !== binding) {
                    localStorage.removeItem(storageKey);
                    return null;
                }
                return rec;
            } catch (e) {
                try {
                    localStorage.removeItem(storageKey);
                } catch (removeError) {
                    // Storage unavailable; nothing to heal.
                }
                return null;
            }
        }

        function formatLastTested(ts) {
            const date = new Date(ts);
            const now = new Date();
            const sameDay = date.getFullYear() === now.getFullYear()
                && date.getMonth() === now.getMonth()
                && date.getDate() === now.getDate();
            if (sameDay) {
                return 'Last tested ' + date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            }
            return 'Last tested ' + date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
        }

        function checklistRowState(cacheKey, fallbackDetail, binding) {
            const fresh = getConnectionTestResult(cacheKey, binding);
            if (fresh) {
                return { state: fresh.status, detail: fresh.detail };
            }
            const persisted = getPersistedTestResult(cacheKey, binding);
            if (persisted) {
                return { state: persisted.status, detail: formatLastTested(persisted.at) };
            }
            return { state: 'pending', detail: fallbackDetail };
        }

        function clearConnectionTestCache() {
            _jeConnectionTestCache.clear();
            _jeCacheGeneration++;
            try {
                const staleKeys = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.indexOf('jc_conn_test_') === 0) {
                        staleKeys.push(k);
                    }
                }
                staleKeys.forEach(function (k) {
                    localStorage.removeItem(k);
                });
            } catch (e) {
                // Storage unavailable; in-memory cache is already cleared.
            }
            try {
                renderChecklist();
            } catch (e) {
                console.warn('[JC] renderChecklist threw:', e);
            }
        }

        function invalidatePersistedTest(key) {
            try {
                localStorage.removeItem('jc_conn_test_' + key);
            } catch (e) {
                // Storage unavailable.
            }
            _jeConnectionTestCache.delete(key);
            try {
                renderChecklist();
            } catch (e) {
                console.warn('[JC] renderChecklist threw:', e);
            }
        }

        function _wireInvalidate(sel, key) {
            const el = document.querySelector(sel);
            if (!el) {
                return;
            }
            // Invalidate on commit (change), not per keystroke — per-keystroke rebuilds caused
            // visible lag — and only when the value actually changed since the last commit.
            let lastCommitted = null;
            el.addEventListener('focus', function () {
                if (lastCommitted === null) {
                    lastCommitted = el.value;
                }
            });
            el.addEventListener('change', function () {
                if (lastCommitted !== null && el.value === lastCommitted) {
                    return;
                }
                lastCommitted = el.value;
                invalidatePersistedTest(key);
            });
        }

        function jcFingerprintConnectionValue(value) {
            // Comparison-only binding so internal URLs are never persisted verbatim.
            // Identity fence, not a security primitive.
            const str = String(value || '');
            let hashA = 0x811c9dc5;
            let hashB = 0x9e3779b9;
            for (let i = 0; i < str.length; i++) {
                const c = str.charCodeAt(i);
                hashA = Math.imul(hashA ^ c, 0x01000193);
                hashB = Math.imul(hashB ^ c, 0x5f356495);
            }
            return 'v1:' + str.length.toString(36) + ':'
                + (hashA >>> 0).toString(16).padStart(8, '0')
                + (hashB >>> 0).toString(16).padStart(8, '0');
        }

        function _jeNormalizeArrUrl(url) {
            return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
        }

        // ---------------------------------------------------------------------------
        // B1. Seerr connection test (multi-URL loop) + TMDB test
        // ---------------------------------------------------------------------------

        async function testSeerrConnection() {
            const urlsInput = document.querySelector('#seerrUrls');
            const keyInput = document.querySelector('#SeerrApiKey');
            const urls = ((urlsInput && urlsInput.value) || '')
                .split('\n')
                .map(function (u) { return u.trim(); })
                .filter(Boolean);
            const apiKey = ((keyInput && keyInput.value) || '').trim();
            if (!urls.length || !apiKey) {
                // Deliberately not suppressible — a misconfigured batch run should still surface this.
                Dashboard.alert({
                    title: 'Missing Information',
                    message: 'Please provide at least one Seerr URL and an API key to test the connection.'
                });
                return;
            }
            const token = beginConnectionTest();
            const btn = document.querySelector('#testSeerrBtn');
            const indicator = document.querySelector('#seerrStatusIndicator');
            if (btn) {
                btn.disabled = true;
            }
            if (indicator) {
                indicator.textContent = 'sync';
                indicator.classList.add('status-check');
                indicator.style.color = 'var(--jc-accent)';
            }
            let validated = false;
            let lastError = '';
            for (const url of urls) {
                try {
                    const res = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl('/JellyfinCanopy/seerr/validate', { url: url }),
                        dataType: 'json',
                        headers: { 'X-Arr-ApiKey': apiKey }
                    });
                    if (res && res.ok) {
                        validated = true;
                        break;
                    }
                } catch (e) {
                    console.error('Seerr validation failed for ' + url + ':', e);
                    if (e && typeof e.json === 'function') {
                        try {
                            e.responseJSON = await e.clone().json();
                        } catch (parseError) {
                            // Body was not JSON; fall through to status-based messaging.
                        }
                    }
                    lastError = connectionErrorMessage(e, 'Seerr', url);
                }
            }
            if (btn) {
                btn.disabled = false;
            }
            if (indicator) {
                indicator.classList.remove('status-check');
            }
            if (validated) {
                if (indicator) {
                    indicator.textContent = 'check_circle';
                    indicator.style.color = 'var(--jc-success)';
                }
                try {
                    setConnectionTestResult('seerr', 'ok', 'Connected', token);
                } catch (e) {
                    console.warn('[JC] Failed to cache Seerr test result:', e);
                }
                jcTestAlert({ title: 'Success', message: 'Successfully connected to Seerr!' });
            } else {
                if (indicator) {
                    indicator.textContent = 'error';
                    indicator.style.color = 'var(--jc-danger)';
                }
                try {
                    setConnectionTestResult('seerr', 'error', lastError.length < 80 ? lastError : 'Connection failed', token);
                } catch (e) {
                    console.warn('[JC] Failed to cache Seerr test result:', e);
                }
                jcTestAlert({
                    title: 'Connection Failed',
                    message: lastError || 'Could not connect to any provided URL.'
                });
            }
        }


        // ---------------------------------------------------------------------------
        // B2. Maintainerr connection test
        // ---------------------------------------------------------------------------

        var JC_MAINTAINERR_MAX_URL_LENGTH = 2048;
        var JC_MAINTAINERR_MAX_MAPPINGS_LENGTH = 65536;
        var JC_MAINTAINERR_MAX_MAPPING_ROWS = 32;


        let maintainerrTestGeneration = 0;
        let activeMaintainerrTestController = null;

        function jcSetMaintainerrTestStatus(icon, text, color, busy) {
            const indicator = document.querySelector('#maintainerrStatusIndicator');
            const statusText = document.querySelector('#maintainerrStatusText');
            const btn = document.querySelector('#testMaintainerrBtn');
            if (indicator) {
                indicator.textContent = icon;
                indicator.style.color = color;
                indicator.classList.toggle('status-check', !!busy);
            }
            if (statusText) {
                statusText.textContent = text;
            }
            if (btn) {
                btn.setAttribute('aria-busy', busy ? 'true' : 'false');
            }
        }

        function cancelActiveMaintainerrTest(resetUi) {
            maintainerrTestGeneration++;
            if (activeMaintainerrTestController) {
                try {
                    activeMaintainerrTestController.abort();
                } catch (e) {
                    // Already aborted or unsupported; nothing to do.
                }
                activeMaintainerrTestController = null;
            }
            if (resetUi === true) {
                const btn = document.querySelector('#testMaintainerrBtn');
                if (btn) {
                    btn.disabled = false;
                }
                jcSetMaintainerrTestStatus('', '', '', false);
            }
        }

        function jcIsCurrentMaintainerrTest(generation, url, controller) {
            // Checked after every await: a stale test must not touch UI or the cache.
            if (generation !== maintainerrTestGeneration) {
                return false;
            }
            if (!controller || controller !== activeMaintainerrTestController) {
                return false;
            }
            if (controller.signal.aborted) {
                return false;
            }
            const input = document.querySelector('#maintainerrUrl');
            return jcNormalizeMaintainerrBaseUrl((input && input.value) || '') === url;
        }

        function jcIsSafeMaintainerrPathSegment(segment) {
            let current = segment;
            for (let depth = 0; depth <= 4; depth++) {
                if (current === '.' || current === '..') {
                    return false;
                }
                if (/[\u0000-\u001f\u007f-\u009f]/.test(current)) {
                    return false;
                }
                if (current.indexOf('/') !== -1 || current.indexOf('\\') !== -1) {
                    return false;
                }
                if (current.indexOf('%') === -1) {
                    return true;
                }
                if (depth === 4) {
                    // Never reached a %-free fixpoint within 4 decode levels.
                    return false;
                }
                try {
                    current = decodeURIComponent(current);
                } catch (e) {
                    return false;
                }
            }
            return false;
        }

        function jcNormalizeMaintainerrBaseUrl(value) {
            // Mirror of server ServiceUrlResolver.TryNormalizeHttpBaseUrl. Returns '' when invalid.
            if (typeof value !== 'string') {
                return '';
            }
            const trimmed = value.trim();
            if (!trimmed || trimmed.length > JC_MAINTAINERR_MAX_URL_LENGTH) {
                return '';
            }
            if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
                return '';
            }
            if (trimmed.indexOf('\\') !== -1) {
                return '';
            }
            if (/^\/\//.test(trimmed)) {
                return '';
            }
            let parsed;
            try {
                parsed = new URL(trimmed);
            } catch (e) {
                return '';
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return '';
            }
            if (!parsed.hostname) {
                return '';
            }
            if (parsed.username || parsed.password || parsed.search || parsed.hash) {
                return '';
            }
            // URL canonicalizes dot segments, so traversal must be checked against the raw
            // text after the authority.
            const schemeEnd = trimmed.indexOf('//') + 2;
            const authorityEnd = trimmed.indexOf('/', schemeEnd);
            if (authorityEnd !== -1) {
                const rawSegments = trimmed.slice(authorityEnd + 1).split('/');
                for (const segment of rawSegments) {
                    if (!jcIsSafeMaintainerrPathSegment(segment)) {
                        return '';
                    }
                }
            }
            const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
            const normalized = parsed.protocol + '//' + parsed.host + (path ? '/' + path : '');
            if (normalized.length > JC_MAINTAINERR_MAX_URL_LENGTH) {
                return '';
            }
            return normalized;
        }

        function jcParseMaintainerrTestStatus(result) {
            // Strict shape validation: returns null unless every invariant holds.
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
                return null;
            }
            const boolFields = ['ok', 'ready', 'jellyfinMode', 'capable', 'identityMatch'];
            for (const field of boolFields) {
                if (typeof result[field] !== 'boolean') {
                    return null;
                }
            }
            if (typeof result.version !== 'string'
                || !result.version.trim()
                || result.version.length > 80
                || /[\u0000-\u001f\u007f-\u009f]/.test(result.version)) {
                return null;
            }
            if (result.ok !== (result.capable && result.identityMatch)) {
                return null;
            }
            if (result.capable && !(result.ready && result.jellyfinMode)) {
                return null;
            }
            if (result.identityMatch) {
                if (result.identityWarning !== undefined) {
                    return null;
                }
            } else if (result.identityWarning !== 'identity_unknown' && result.identityWarning !== 'identity_mismatch') {
                return null;
            }
            const caps = result.capabilities;
            if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
                return null;
            }
            const capKeys = ['collections', 'collectionContent', 'itemStatus', 'rules', 'storageMetrics', 'overlays'];
            if (Object.keys(caps).length !== capKeys.length) {
                return null;
            }
            for (const capKey of capKeys) {
                const expected = capKey === 'itemStatus'
                    ? (result.capable && result.identityMatch)
                    : result.capable;
                if (caps[capKey] !== expected) {
                    return null;
                }
            }
            if (result.capable) {
                if (result.error !== undefined) {
                    return null;
                }
            } else if (!result.ready) {
                if (result.error !== 'not_ready') {
                    return null;
                }
            } else if (!result.jellyfinMode) {
                if (result.error !== 'not_ready' && result.error !== 'wrong_service') {
                    return null;
                }
            } else if (result.error !== 'not_ready' && result.error !== 'unsupported') {
                return null;
            }
            return result;
        }

        async function testMaintainerrConnection() {
            const MAINTAINERR_TEST_ERROR_MESSAGES = {
                invalid_configuration: 'The Maintainerr URL is invalid',
                not_ready: 'Maintainerr is reachable but not ready',
                not_jellyfin: 'Maintainerr is not configured for Jellyfin',
                unsupported: 'Maintainerr does not expose the required read-only capabilities',
                blocked_target: 'The destination is blocked by Canopy network policy',
                timeout: 'The connection timed out',
                canceled: 'The connection test was canceled',
                redirect: 'Maintainerr returned a redirect',
                wrong_service: 'The destination is not Maintainerr 3.18',
                malformed_body: 'Maintainerr returned an invalid response',
                malformed_response: 'Maintainerr returned an invalid response',
                response_too_large: 'Maintainerr returned an oversized response',
                too_large: 'Maintainerr returned too many records',
                throttled: 'Maintainerr requests are temporarily limited',
                identity_mismatch: 'Maintainerr is connected to a different Jellyfin server',
                configuration_changed: 'The Maintainerr configuration changed during the test',
                upstream_error: 'Maintainerr could not complete the read-only test',
                disabled: 'The Maintainerr integration is disabled',
                unavailable: 'Maintainerr is temporarily unavailable'
            };
            cancelActiveMaintainerrTest(true);
            const input = document.querySelector('#maintainerrUrl');
            const normalizedMaintainerrUrl = jcNormalizeMaintainerrBaseUrl((input && input.value) || '');
            const url = normalizedMaintainerrUrl;
            if (!url) {
                jcSetMaintainerrTestStatus('error', 'Failed', 'var(--jc-danger)', false);
                Dashboard.alert({
                    title: 'Missing or invalid URL',
                    message: 'Provide an HTTP(S) Maintainerr base URL of at most 2048 characters without credentials, query, fragment, or path traversal.'
                });
                return;
            }
            const generation = maintainerrTestGeneration;
            const controller = new AbortController();
            activeMaintainerrTestController = controller;
            const testToken = beginConnectionTest();
            const cacheBinding = jcFingerprintConnectionValue(url);
            const btn = document.querySelector('#testMaintainerrBtn');
            if (btn) {
                btn.disabled = true;
            }
            jcSetMaintainerrTestStatus('sync', 'Testing\u2026', 'var(--jc-accent)', true);
            try {
                const result = await ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('/JellyfinCanopy/maintainerr/test'),
                    data: JSON.stringify({ url: url }),
                    contentType: 'application/json',
                    dataType: 'json',
                    signal: controller.signal
                });
                if (!jcIsCurrentMaintainerrTest(generation, url, controller)) {
                    return;
                }
                const status = jcParseMaintainerrTestStatus(result);
                if (!status) {
                    const malformed = new Error('Maintainerr returned a malformed test response');
                    malformed.responseJSON = { error: 'malformed_response' };
                    throw malformed;
                }
                let identityState = 'unknown';
                if (status.identityMatch) {
                    identityState = 'matched';
                } else if (status.identityWarning === 'identity_mismatch') {
                    identityState = 'mismatch';
                } else if (status.identityWarning === 'identity_unknown') {
                    identityState = 'unknown';
                }
                const version = status.version.slice(0, 32);
                if (!status.ready || !status.jellyfinMode || !status.capable) {
                    const notCapable = new Error('Maintainerr is not ready for read-only access');
                    notCapable.responseJSON = { error: status.error };
                    throw notCapable;
                }
                if (!jcIsCurrentMaintainerrTest(generation, url, controller)) {
                    return;
                }
                const warning = identityState !== 'matched';
                let detail = version ? 'Maintainerr ' + version : 'Connected';
                if (identityState === 'mismatch') {
                    detail += ' · different Jellyfin server';
                } else if (identityState === 'unknown') {
                    detail += ' · Jellyfin identity not confirmed';
                }
                try {
                    setConnectionTestResult('maintainerr', warning ? 'amber' : 'ok', detail, testToken, cacheBinding);
                } catch (e) {
                    console.warn('[JC] Failed to cache Maintainerr test result:', e);
                }
                jcSetMaintainerrTestStatus(
                    warning ? 'warning' : 'check_circle',
                    warning ? 'Connected with warning' : 'Connected',
                    warning ? 'var(--jc-warning)' : 'var(--jc-success)',
                    false
                );
                let message;
                if (identityState === 'mismatch') {
                    message = 'Maintainerr is reachable but is connected to a different Jellyfin server. Per-item status will remain disabled until the identities match.';
                } else if (identityState === 'unknown') {
                    message = 'Maintainerr is reachable, but its Jellyfin server identity could not be confirmed. Per-item status will remain disabled until identity can be verified.';
                } else {
                    message = 'Successfully connected to Maintainerr ' + version + '.';
                }
                // The success dialog's dismiss button renders as "Got It" (Dashboard.alert
                // default) — e2e asserts that exact accessible name.
                jcTestAlert({ title: warning ? 'Connected with warning' : 'Success', message: message });
            } catch (e) {
                if (!jcIsCurrentMaintainerrTest(generation, url, controller)) {
                    return;
                }
                let code = '';
                if (e && e.responseJSON && typeof e.responseJSON.error === 'string') {
                    code = e.responseJSON.error;
                } else if (e && typeof e.json === 'function') {
                    try {
                        const body = await e.clone().json();
                        if (body && typeof body.error === 'string') {
                            code = body.error;
                        }
                    } catch (parseError) {
                        // Body was not JSON; keep the fallback message.
                    }
                }
                if (!jcIsCurrentMaintainerrTest(generation, url, controller)) {
                    return;
                }
                code = String(code).slice(0, 48);
                const detail = MAINTAINERR_TEST_ERROR_MESSAGES[code] || 'Connection could not be verified';
                try {
                    setConnectionTestResult('maintainerr', 'error', detail, testToken, cacheBinding);
                } catch (cacheError) {
                    console.warn('[JC] Failed to cache Maintainerr test result:', cacheError);
                }
                jcSetMaintainerrTestStatus('error', 'Failed', 'var(--jc-danger)', false);
                jcTestAlert({
                    title: 'Connection failed',
                    message: detail + '. Confirm the server-only URL, network access, and Maintainerr 3.18 configuration.'
                });
            } finally {
                if (jcIsCurrentMaintainerrTest(generation, url, controller)) {
                    activeMaintainerrTestController = null;
                    if (btn) {
                        btn.disabled = false;
                        btn.setAttribute('aria-busy', 'false');
                    }
                    const indicator = document.querySelector('#maintainerrStatusIndicator');
                    if (indicator) {
                        indicator.classList.remove('status-check');
                    }
                }
            }
        }

        async function testTmdbConnection(event) {
            const input = document.querySelector('#TMDB_API_KEY');
            const apiKey = ((input && input.value) || '').trim();
            if (!apiKey) {
                Dashboard.alert({
                    title: 'Missing Information',
                    message: 'Please provide a TMDB API key to test the connection.'
                });
                return;
            }
            _testToken = beginConnectionTest();
            // Multiple copies of the test button exist across tabs; resolve the indicator
            // sitting next to the clicked button, falling back to the Elsewhere-tab one.
            const button = event && event.target ? event.target.closest('button') : null;
            let indicator = button && button.parentElement
                ? button.parentElement.querySelector('.material-icons')
                : null;
            if (!indicator) {
                indicator = document.querySelector('#tmdbStatusIndicator');
            }
            const buttons = document.querySelectorAll('.testTmdbBtn');
            buttons.forEach(function (b) { b.disabled = true; });
            if (indicator) {
                indicator.textContent = 'sync';
                indicator.classList.add('status-check');
                indicator.style.color = 'var(--jc-accent)';
            }
            try {
                await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/JellyfinCanopy/tmdb/validate', { apiKey: apiKey })
                });
                if (indicator) {
                    indicator.textContent = 'check_circle';
                    indicator.style.color = 'var(--jc-success)';
                }
                try {
                    setConnectionTestResult('tmdb', 'ok', 'API key valid', _testToken);
                } catch (e) {
                    console.warn('[JC] Failed to cache TMDB test result:', e);
                }
                jcTestAlert({ title: 'Success', message: 'Successfully connected to TMDB!' });
            } catch (e) {
                console.error('TMDB validation failed:', e);
                const status = e && e.status;
                let message;
                let cacheDetail;
                if (status === 401) {
                    message = 'The API key is invalid. Check that you copied it correctly.';
                    cacheDetail = 'API key rejected';
                } else if (status === 500 || !status) {
                    message = 'Could not reach TMDB servers. Check your network connection.';
                    cacheDetail = 'Unreachable';
                } else {
                    message = 'Connection failed (error ' + status + '). Check the key and your network.';
                    cacheDetail = 'Error ' + status;
                }
                try {
                    setConnectionTestResult('tmdb', 'error', cacheDetail, _testToken);
                } catch (cacheError) {
                    console.warn('[JC] Failed to cache TMDB test result:', cacheError);
                }
                if (indicator) {
                    indicator.textContent = 'error';
                    indicator.style.color = 'var(--jc-danger)';
                }
                jcTestAlert({ title: 'Connection Failed', message: message });
            } finally {
                buttons.forEach(function (b) { b.disabled = false; });
                if (indicator) {
                    indicator.classList.remove('status-check');
                }
            }
        }

        // ---------------------------------------------------------------------------
        // B3. Sonarr/Radarr per-card connection test + shared error messaging
        // ---------------------------------------------------------------------------

        function connectionErrorMessage(error, serviceName, url) {
            let body = null;
            if (error && error.responseJSON) {
                body = error.responseJSON;
            } else {
                let text = error && error.responseText;
                if (!text && error && error.response && typeof error.response.text === 'string') {
                    text = error.response.text;
                }
                if (typeof text === 'string' && text.trim().indexOf('{') === 0) {
                    try {
                        body = JSON.parse(text);
                    } catch (e) {
                        body = null;
                    }
                }
            }
            if (body && body.code && body.message) {
                const prefix = body.cfRay ? '[' + serviceName + ' cf-ray=' + body.cfRay + '] ' : '';
                return prefix + body.message;
            }
            const status = error && error.status;
            switch (status) {
                case 502:
                    return 'Could not reach ' + url + '. Check the URL is correct and ' + serviceName + ' is running.';
                case 504:
                    return 'Connection timed out. The server may be unreachable.';
                case 401:
                    return 'The API key was rejected. Check the key is correct.';
                case 403:
                    return 'Permission denied. Check the API key has the correct permissions, or that CSRF protection is not enabled in ' + serviceName + '.';
                case 400:
                    return 'Missing URL or API key.';
                case 404:
                    return 'The URL responded but did not look like a valid ' + serviceName + ' instance (HTTP 404 on /api/v1/user). It may be a reverse-proxy auth challenge.';
                default:
                    return 'Connection to ' + serviceName + ' failed (error ' + (status || 'unknown') + ').';
            }
        }

        async function testInstanceConnection(card) {
            const type = card.dataset.type;
            const defaultName = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            const urlInput = card.querySelector('.arr-instance-url');
            const keyInput = card.querySelector('.arr-instance-apikey');
            const nameInput = card.querySelector('.arr-instance-name');
            const url = ((urlInput && urlInput.value) || '').trim();
            const apiKey = ((keyInput && keyInput.value) || '').trim();
            const name = ((nameInput && nameInput.value) || '').trim() || defaultName;
            const btn = card.querySelector('.arr-instance-test');
            const indicator = card.querySelector('.arr-instance-status');
            if (!url || !apiKey) {
                Dashboard.alert({
                    title: 'Missing Information',
                    message: 'Please provide both a URL and API key to test the connection.'
                });
                return;
            }
            const token = beginConnectionTest();
            if (btn) {
                btn.disabled = true;
            }
            if (indicator) {
                indicator.textContent = 'sync';
                // classList, never className = — the arr-instance-status identifier class must survive.
                indicator.classList.add('status-check');
                indicator.style.color = 'var(--jc-accent)';
            }
            const cacheKey = type + ':' + _jeNormalizeArrUrl(url);
            try {
                await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/JellyfinCanopy/arr/validate/' + type, { url: url }),
                    dataType: 'json',
                    headers: { 'X-Arr-ApiKey': apiKey }
                });
                if (indicator) {
                    indicator.textContent = 'check_circle';
                    indicator.style.color = 'var(--jc-success)';
                }
                try {
                    setConnectionTestResult(cacheKey, 'ok', 'Connected', token);
                } catch (e) {
                    console.warn('[JC] Failed to cache instance test result:', e);
                }
                jcTestAlert({ title: 'Success', message: 'Successfully connected to ' + name + '!' });
            } catch (e) {
                const msg = connectionErrorMessage(e, name, url);
                const status = e && e.status;
                let cacheDetail;
                if (status === 401) {
                    cacheDetail = 'API key rejected';
                } else if (status === 500 || !status) {
                    cacheDetail = 'Unreachable';
                } else {
                    cacheDetail = 'Error ' + (status || '?');
                }
                try {
                    setConnectionTestResult(cacheKey, 'error', cacheDetail, token);
                } catch (cacheError) {
                    console.warn('[JC] Failed to cache instance test result:', cacheError);
                }
                jcTestAlert({ title: 'Connection Failed', message: msg });
                if (indicator) {
                    indicator.textContent = 'error';
                    indicator.style.color = 'var(--jc-danger)';
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                }
                if (indicator) {
                    indicator.classList.remove('status-check');
                }
                updateAllDependencies();
            }
        }

        // ---------------------------------------------------------------------------
        // B4. URL-mapping validation (syntax-only; probing broke behind auth proxies)
        // ---------------------------------------------------------------------------

        function jcValidateMaintainerrMappings(value) {
            // Bounded shared parser (Validate button + Save). Issues carry row numbers and
            // reasons only — never URL values.
            const issues = [];
            let validCount = 0;
            let invalidCount = 0;
            if (value.length > JC_MAINTAINERR_MAX_MAPPINGS_LENGTH) {
                return {
                    value: '',
                    validCount: 0,
                    invalidCount: 1,
                    issues: ['Maintainerr mappings exceed the 64 KiB limit.']
                };
            }
            const kept = [];
            const seenSources = Object.create(null);
            let nonEmptyRows = 0;
            let droppedRows = false;
            value.split(/\r\n?|\n/).forEach(function (line, idx) {
                if (!line.trim()) {
                    return;
                }
                nonEmptyRows++;
                if (nonEmptyRows > JC_MAINTAINERR_MAX_MAPPING_ROWS) {
                    droppedRows = true;
                    invalidCount++;
                    return;
                }
                const label = 'Maintainerr line ' + (idx + 1);
                const parts = line.split('|');
                if (parts.length !== 2) {
                    invalidCount++;
                    issues.push(label + ': use exactly one pipe between two URLs.');
                    return;
                }
                const source = jcNormalizeMaintainerrBaseUrl(parts[0]);
                const target = jcNormalizeMaintainerrBaseUrl(parts[1]);
                if (!source || !target) {
                    invalidCount++;
                    issues.push(label + ': both sides must be bounded HTTP(S) base URLs without credentials, query, fragment, or traversal.');
                    return;
                }
                if (source.toLowerCase() === target.toLowerCase()) {
                    invalidCount++;
                    issues.push(label + ': the Jellyfin and Maintainerr URLs must be different.');
                    return;
                }
                const sourceKey = source.toLowerCase();
                if (seenSources[sourceKey]) {
                    invalidCount++;
                    issues.push(label + ': the Jellyfin source URL is duplicated.');
                    return;
                }
                seenSources[sourceKey] = true;
                kept.push(source + '|' + target);
                validCount++;
            });
            if (droppedRows) {
                issues.push('Maintainerr mappings are limited to 32 nonempty rows; extra rows were dropped.');
            }
            const joined = kept.join('\n');
            if (joined.length > JC_MAINTAINERR_MAX_MAPPINGS_LENGTH) {
                return {
                    value: '',
                    validCount: 0,
                    invalidCount: invalidCount + validCount,
                    issues: issues.concat(['Normalized Maintainerr mappings exceed the 64 KiB limit.'])
                };
            }
            return { value: joined, validCount: validCount, invalidCount: invalidCount, issues: issues };
        }

        function renderMappingValidationResult(resultDiv, issues, goodCount) {
            if (!resultDiv) {
                return;
            }
            resultDiv.style.display = 'block';
            resultDiv.style.padding = '0.6em 0.8em';
            resultDiv.style.borderRadius = '4px';
            resultDiv.style.marginTop = '0.5em';
            if (!issues.length) {
                resultDiv.style.background = 'rgba(40, 167, 69, 0.15)';
                resultDiv.style.border = '1px solid var(--jc-success)';
                resultDiv.innerHTML = '<span class="material-icons" style="vertical-align: middle; color: var(--jc-success);">check_circle</span> '
                    + goodCount + ' mapping(s) verified.';
                return;
            }
            resultDiv.style.background = 'rgba(220, 53, 69, 0.15)';
            resultDiv.style.border = '1px solid var(--jc-danger)';
            let html = issues.map(function (issue) {
                return '<div>' + escapeHtml(issue) + '</div>';
            }).join('');
            if (goodCount > 0) {
                html += '<div>' + goodCount + ' other mapping(s) verified.</div>';
            }
            resultDiv.innerHTML = html;
        }

        async function validateMappingSet(mappingDefs, btnId, resultDivId) {
            const btn = document.querySelector('#' + btnId);
            const resultDiv = document.querySelector('#' + resultDivId);
            function setBtnLabel(text) {
                if (!btn) {
                    return;
                }
                const span = btn.querySelector('span');
                if (span) {
                    span.textContent = text;
                } else {
                    btn.textContent = text;
                }
            }
            setBtnLabel('Validating...');
            if (btn) {
                btn.disabled = true;
            }
            try {
                const issues = [];
                const pairs = [];
                // Phase 1: format check per line.
                mappingDefs.forEach(function (def) {
                    const el = document.querySelector('#' + def.id);
                    const lines = ((el && el.value) || '').split('\n');
                    lines.forEach(function (line, i) {
                        const trimmed = line.trim();
                        if (!trimmed) {
                            return;
                        }
                        const label = def.service + ' line ' + (i + 1);
                        const parts = trimmed.split('|');
                        if (parts.length !== 2) {
                            issues.push(label + ': Invalid format. Use jellyfin_url|' + def.service.toLowerCase() + '_url separated by a pipe (|).');
                            return;
                        }
                        const left = parts[0].trim();
                        const right = parts[1].trim();
                        if (!left || !right) {
                            issues.push(label + ': Both sides of the pipe must have a URL.');
                            return;
                        }
                        if (!/^https?:\/\//i.test(left)) {
                            issues.push(label + ': Left side (' + left + ') should start with http:// or https://.');
                            return;
                        }
                        if (!/^https?:\/\//i.test(right)) {
                            issues.push(label + ': Right side (' + right + ') should start with http:// or https://.');
                            return;
                        }
                        pairs.push({ label: label, left: left, right: right, service: def.service });
                    });
                });
                if (issues.length) {
                    renderMappingValidationResult(resultDiv, issues, 0);
                    return;
                }
                if (!pairs.length) {
                    if (resultDiv) {
                        resultDiv.style.display = 'none';
                    }
                    return;
                }
                // Phase 2: URL sanity per pair.
                let good = 0;
                pairs.forEach(function (pair) {
                    let leftUrl = null;
                    let rightUrl = null;
                    try {
                        leftUrl = new URL(pair.left);
                    } catch (e) {
                        leftUrl = null;
                    }
                    if (!leftUrl || !leftUrl.host) {
                        issues.push(pair.label + ': Left side (' + pair.left + ') is not a valid URL.');
                        return;
                    }
                    try {
                        rightUrl = new URL(pair.right);
                    } catch (e) {
                        rightUrl = null;
                    }
                    if (!rightUrl || !rightUrl.host) {
                        issues.push(pair.label + ': Right side (' + pair.right + ') is not a valid URL.');
                        return;
                    }
                    const leftNorm = pair.left.replace(/\/+$/, '').toLowerCase();
                    const rightNorm = pair.right.replace(/\/+$/, '').toLowerCase();
                    if (leftNorm === rightNorm) {
                        issues.push(pair.label + ': Both sides are the same URL. Left should be Jellyfin, right should be ' + pair.service + '.');
                        return;
                    }
                    good++;
                });
                renderMappingValidationResult(resultDiv, issues, good);
            } finally {
                setBtnLabel('Validate Mappings');
                if (btn) {
                    btn.disabled = false;
                }
            }
        }

        function jcRunMappingValidation(mappingDefs, btnId, resultDivId) {
            return validateMappingSet(mappingDefs, btnId, resultDivId).catch(function (e) {
                console.warn('[JC] Mapping validation crashed:', e);
                const btn = document.querySelector('#' + btnId);
                if (btn) {
                    btn.disabled = false;
                    const span = btn.querySelector('span');
                    if (span) {
                        span.textContent = 'Validate Mappings';
                    } else {
                        btn.textContent = 'Validate Mappings';
                    }
                }
                try {
                    Dashboard.alert({
                        title: 'Validation error',
                        message: 'Mapping validation crashed unexpectedly — check the browser console for details.'
                    });
                } catch (alertError) {
                    window.alert('Mapping validation crashed unexpectedly — check the browser console for details.');
                }
            });
        }

        function _jeValidateInstanceMappings(type, btnId, resultDivId, displayName) {
            document.querySelectorAll('textarea[data-arr-validate-temp-' + type + '="true"]').forEach(function (orphan) {
                orphan.remove();
            });
            const defs = [];
            const temps = [];
            document.querySelectorAll('#' + type + 'InstancesList .arr-instance-card').forEach(function (card, idx) {
                const mappingsEl = card.querySelector('.arr-instance-urlmappings');
                const value = (mappingsEl && mappingsEl.value) || '';
                if (!value.trim()) {
                    return;
                }
                const nameInput = card.querySelector('.arr-instance-name');
                const name = ((nameInput && nameInput.value) || '').trim() || (displayName + ' ' + (idx + 1));
                const temp = document.createElement('textarea');
                temp.id = 'arr-validate-' + type + '-' + idx;
                temp.value = value;
                temp.hidden = true;
                temp.setAttribute('data-arr-validate-temp-' + type, 'true');
                document.body.appendChild(temp);
                temps.push(temp);
                defs.push({ id: temp.id, service: name });
            });
            if (!defs.length) {
                Dashboard.alert({
                    title: 'No Mappings',
                    message: 'No URL mappings configured for ' + displayName + '. Expand an instance card and fill in the URL Mappings field to validate.'
                });
                return;
            }
            jcRunMappingValidation(defs, btnId, resultDivId).finally(function () {
                temps.forEach(function (temp) {
                    temp.remove();
                });
            });
        }

        function validateMaintainerrMappingSet(textareaId, btn, resultDivId) {
            // Synchronous; uses the strict bounded parser, which never echoes URL values.
            const input = document.querySelector('#' + textareaId);
            const resultDiv = document.querySelector('#' + resultDivId);
            if (!input || !resultDiv) {
                return;
            }
            const result = jcValidateMaintainerrMappings(input.value);
            renderMappingValidationResult(resultDiv, result.issues, result.validCount);
        }

        // ---------------------------------------------------------------------------
        // B5. Seerr recently-added scan trigger
        // ---------------------------------------------------------------------------

        let activeSeerrScanController = null;

        /* jc-seerr-scan-helpers:start */
        function jcNormalizeSeerrIdentityDomain(value) {
            // Mirror of server SeerrUrlIdentity.ParseConfigured normalization. Pure:
            // only the URL global and its argument (contract-tested by extraction).
            const trimmed = String(value || '').trim().replace(/\/+$/, '');
            if (!trimmed) {
                return '';
            }
            if (!/^https?:\/\//i.test(trimmed)) {
                return trimmed;
            }
            let parsed;
            try {
                parsed = new URL(trimmed);
            } catch (e) {
                return trimmed;
            }
            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
                || !parsed.hostname
                || parsed.username
                || parsed.password
                || parsed.search
                || parsed.hash) {
                return trimmed;
            }
            // URL canonicalizes scheme/host case and drops default ports. Strip one
            // DNS absolute-name trailing dot, but never repair '..' or a root-only
            // host into a different authority.
            let host = parsed.hostname;
            if (host.length > 1 && host.charAt(host.length - 1) === '.' && host.charAt(host.length - 2) !== '.') {
                host = host.slice(0, -1);
            }
            const port = parsed.port ? ':' + parsed.port : '';
            const path = parsed.pathname.replace(/\/+$/, '');
            return parsed.protocol + '//' + host + port + path;
        }

        function jcParseSeerrIdentityDomains(raw) {
            const seen = Object.create(null);
            const domains = [];
            String(raw || '').split(/[\r\n,]+/).forEach(function (part) {
                const domain = jcNormalizeSeerrIdentityDomain(part);
                if (!domain || seen[domain]) {
                    return;
                }
                seen[domain] = true;
                domains.push(domain);
            });
            return domains;
        }

        async function jcDispatchSeerrScanDomains(rawInput, sender, signal) {
            // Parses + dedupes the raw multi-URL input, hands the WHOLE batch to the
            // injected sender exactly once, and maps the authoritative response rows
            // back onto the requested domains by normalized-domain equality. Pure of
            // DOM/network: the sender owns transport (and cancellation side effects).
            const domains = jcParseSeerrIdentityDomains(rawInput);
            const results = domains.map(function (domain) {
                return { domain: domain, ok: false, error: '' };
            });
            let response = null;
            try {
                response = await sender(domains);
            } catch (e) {
                response = { ok: false, message: String((e && e.message) || e || '') };
            }
            const topOk = !!(response && response.ok);
            const topMessage = response && response.message ? String(response.message) : '';
            const rows = response && Array.isArray(response.results) ? response.results : [];
            results.forEach(function (entry) {
                const row = rows.find(function (r) {
                    return r && jcNormalizeSeerrIdentityDomain(r.url || r.domain || '') === entry.domain;
                });
                if (row) {
                    entry.ok = !!row.ok;
                    entry.error = row.ok ? '' : (row.message ? String(row.message) : '');
                } else {
                    entry.ok = topOk;
                    entry.error = topOk ? '' : topMessage;
                }
            });
            return {
                domains: domains,
                results: results,
                cancelled: !!(signal && signal.aborted)
            };
        }

        function jcSummarizeSeerrScanDispatch(result) {
            const rows = (result && result.results) || [];
            const total = rows.length;
            let succeeded = 0;
            rows.forEach(function (entry) {
                if (entry.ok) {
                    succeeded++;
                }
            });
            const failed = total - succeeded;
            const outcome = failed === 0 ? 'success' : (succeeded > 0 ? 'partial' : 'failure');
            return { outcome: outcome, total: total, succeeded: succeeded, failed: failed };
        }
        /* jc-seerr-scan-helpers:end */

        function cancelActiveSeerrScan() {
            if (activeSeerrScanController) {
                try {
                    activeSeerrScanController.abort();
                } catch (e) {
                    // Already aborted; nothing to do.
                }
                activeSeerrScanController = null;
            }
        }

        async function triggerSeerrScanNow() {
            const urlsInput = document.querySelector('#seerrUrls');
            const keyInput = document.querySelector('#SeerrApiKey');
            const rawUrls = (urlsInput && urlsInput.value) || '';
            const domains = jcParseSeerrIdentityDomains(rawUrls);
            const apiKey = ((keyInput && keyInput.value) || '').trim();
            if (!domains.length || !apiKey) {
                Dashboard.alert({
                    title: 'Missing Information',
                    message: 'Please provide at least one Seerr URL and an API key in the Setup section above.'
                });
                return;
            }
            cancelActiveSeerrScan();
            const controller = new AbortController();
            activeSeerrScanController = controller;
            const btn = document.querySelector('#triggerSeerrScanNowBtn');
            const statusEl = document.querySelector('#triggerSeerrScanNowStatus');
            if (btn) {
                btn.disabled = true;
            }
            if (statusEl) {
                statusEl.textContent = 'sync';
                statusEl.className = 'material-icons status-check';
                statusEl.style.color = 'var(--jc-accent)';
            }
            try {
                const dispatch = await jcDispatchSeerrScanDomains(rawUrls, function (batch) {
                    return ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl('/JellyfinCanopy/seerr/trigger-recently-added-scan', { urls: batch.join('\n') }),
                        dataType: 'json',
                        headers: { 'X-Arr-ApiKey': apiKey },
                        signal: controller.signal
                    }).catch(function (e) {
                        if (controller.signal.aborted) {
                            return { ok: false, message: '' };
                        }
                        return { ok: false, message: connectionErrorMessage(e, 'Seerr', batch[0] || '') };
                    });
                }, controller.signal);
                if (dispatch.cancelled) {
                    return;
                }
                dispatch.results.forEach(function (entry) {
                    if (!entry.ok) {
                        console.error('Seerr scan trigger failed for ' + entry.domain + ':', entry.error || 'Upstream rejected the trigger');
                    }
                });
                const summary = jcSummarizeSeerrScanDispatch(dispatch);
                if (summary.outcome === 'success') {
                    if (statusEl) {
                        statusEl.textContent = 'check_circle';
                        statusEl.style.color = 'var(--jc-success)';
                    }
                    jcTestAlert({
                        title: 'Scans Triggered',
                        message: 'Triggered "Jellyfin Recently Added Scan" for all ' + summary.total
                            + ' Seerr identity domain' + (summary.total === 1 ? '' : 's') + '.'
                    });
                } else if (summary.outcome === 'partial') {
                    if (statusEl) {
                        statusEl.textContent = 'warning';
                        statusEl.style.color = 'var(--jc-warning)';
                    }
                    jcTestAlert({
                        title: 'Scans Partially Triggered',
                        message: 'Triggered ' + summary.succeeded + ' of ' + summary.total
                            + ' Seerr identity domains; ' + summary.failed
                            + ' failed. Each URL was attempted once. Check the browser console and server log for failure details.'
                    });
                } else {
                    if (statusEl) {
                        statusEl.textContent = 'error';
                        statusEl.style.color = 'var(--jc-danger)';
                    }
                    jcTestAlert({
                        title: 'Trigger Failed',
                        message: 'None of the ' + summary.total + ' Seerr identity domain'
                            + (summary.total === 1 ? '' : 's')
                            + ' accepted the scan trigger. Check the browser console and server log for failure details.'
                    });
                }
            } finally {
                if (activeSeerrScanController === controller) {
                    activeSeerrScanController = null;
                }
                if (btn) {
                    btn.disabled = false;
                }
                if (statusEl) {
                    statusEl.classList.remove('status-check');
                    if (controller.signal.aborted) {
                        statusEl.textContent = '';
                    }
                }
            }
        }

        // ---------------------------------------------------------------------------
        // C. Sonarr/Radarr multi-instance cards
        // ---------------------------------------------------------------------------

        let _arrParseOK = { sonarr: true, radarr: true };

        function normalizeArrInstanceId(value) {
            // Instance ids are opaque 128-bit hex tokens. Never derive one in the browser
            // from URL/API-key material — credentials must not become client-visible identity.
            const id = String(value || '').toLowerCase();
            return /^[0-9a-f]{32}$/.test(id) ? id : '';
        }

        function createArrInstanceId() {
            try {
                const bytes = new Uint8Array(16);
                window.crypto.getRandomValues(bytes);
                let id = '';
                for (let i = 0; i < bytes.length; i++) {
                    id += bytes[i].toString(16).padStart(2, '0');
                }
                return id;
            } catch (e) {
                // Safe: the server save hook fills blanks.
                return '';
            }
        }

        function tryParseInstanceList(raw, type, container) {
            // Runs in a bare context in tests: reference only _arrParseOK, console and
            // insertCorruptBanner here. Never log the raw payload or key material.
            if (!raw) {
                return [];
            }
            try {
                const parsed = JSON.parse(raw);
                if (!Array.isArray(parsed)) {
                    throw new Error('Instances value is not an array');
                }
                return parsed;
            } catch (e) {
                _arrParseOK[type] = false;
                const errorClass = e instanceof SyntaxError ? 'SyntaxError' : 'InvalidShape';
                console.error('[JC Config] Failed to parse ' + type + 'Instances (' + errorClass + ') — refusing to overwrite on save.');
                insertCorruptBanner(container, type);
                return [];
            }
        }

        function insertCorruptBanner(container, type) {
            const label = type === 'sonarr' ? 'Sonarr' : 'Radarr';
            const banner = document.createElement('div');
            banner.className = 'arr-corrupt-banner';
            banner.setAttribute('data-arr-corrupt', type);
            banner.style.cssText = 'padding: 0.8em 1em; margin-bottom: 1em; border: 1px solid var(--jc-danger); background: color-mix(in srgb, var(--jc-danger) 15%, transparent); border-radius: 4px;';
            const title = document.createElement('strong');
            title.textContent = '⚠ Stored ' + label + ' instance configuration is corrupted.';
            banner.appendChild(title);
            const detail = document.createElement('div');
            detail.textContent = 'The saved JSON could not be parsed. Saving this page will NOT overwrite the stored value or the legacy '
                + label + ' URL/API key — so existing configuration is preserved. To recover: either fix the stored JSON directly in '
                + 'Jellyfin\'s plugin config, or click the button below to reset this list (destroys the unreadable value).';
            banner.appendChild(detail);
            const resetBtn = document.createElement('button');
            resetBtn.setAttribute('is', 'emby-button');
            resetBtn.type = 'button';
            resetBtn.className = 'raised emby-button';
            const resetSpan = document.createElement('span');
            resetSpan.textContent = 'Reset ' + label + ' instances (clears stored value)';
            resetBtn.appendChild(resetSpan);
            resetBtn.addEventListener('click', function (e) {
                e.preventDefault();
                Dashboard.confirm(
                    'Reset the corrupt ' + label + ' instance configuration? The stored JSON is unreadable so any instances it contained cannot be recovered. You will need to add them again. The reset takes effect when you click Save.',
                    'Reset Instances',
                    function (confirmed) {
                        if (!confirmed) {
                            return;
                        }
                        _arrParseOK[type] = true;
                        banner.remove();
                    }
                );
            });
            banner.appendChild(resetBtn);
            if (container && container.appendChild) {
                container.appendChild(banner);
            }
        }

        function createInstanceCard(type, instance, startOpen) {
            const isSonarr = type === 'sonarr';
            const defaultName = isSonarr ? 'Sonarr' : 'Radarr';
            const namePlaceholder = isSonarr ? 'e.g., TV Shows, Anime' : 'e.g., Movies, 4K Movies';
            const defaultPort = isSonarr ? '8989' : '7878';
            const urlPlaceholder = 'e.g., http://192.168.1.100:' + defaultPort;

            const card = document.createElement('details');
            card.className = 'arr-instance-card';
            card.dataset.type = type;
            // A blank URL identifies a genuinely-new card and gets a fresh random id;
            // legacy populated rows stay blank so the server applies its deterministic migration.
            card.dataset.instanceId = normalizeArrInstanceId(instance.InstanceId)
                || (String(instance.Url || '').trim() === '' ? createArrInstanceId() : '');
            if (startOpen) {
                card.open = true;
            }

            const initialName = String(instance.Name || '').trim() || defaultName;
            const initiallyEnabled = instance.Enabled !== false;

            // --- Summary row: [enabled checkbox][name][(disabled) chip][url] ---
            const summary = document.createElement('summary');
            summary.className = 'arr-instance-summary';

            // Plain checkbox on purpose — is="emby-checkbox" needs a label wrapper that
            // breaks the summary flex row.
            const enabledCheckbox = document.createElement('input');
            enabledCheckbox.type = 'checkbox';
            enabledCheckbox.className = 'arr-instance-enabled';
            enabledCheckbox.checked = initiallyEnabled;
            enabledCheckbox.setAttribute('aria-label', 'Enable ' + initialName + ' instance');
            enabledCheckbox.title = 'Uncheck to skip this instance in all fan-out paths (links, calendar, queue, tag sync) without deleting its URL/API key';
            ['click', 'mousedown', 'keydown'].forEach(function (evt) {
                enabledCheckbox.addEventListener(evt, function (e) {
                    e.stopPropagation();
                });
            });

            const summaryName = document.createElement('span');
            summaryName.className = 'arr-instance-summary-name';
            summaryName.textContent = instance.Name || defaultName;

            const disabledChip = document.createElement('span');
            disabledChip.className = 'arr-instance-summary-disabled';
            disabledChip.textContent = '(disabled)';
            disabledChip.style.cssText = 'color: var(--jc-warning); font-size: 0.85em; margin-right: 0.5em;';
            disabledChip.style.display = initiallyEnabled ? 'none' : 'inline';

            const summaryUrl = document.createElement('span');
            summaryUrl.className = 'arr-instance-summary-url';
            summaryUrl.textContent = instance.Url || '';

            summary.appendChild(enabledCheckbox);
            summary.appendChild(summaryName);
            summary.appendChild(disabledChip);
            summary.appendChild(summaryUrl);
            card.appendChild(summary);

            // --- Body ---
            const body = document.createElement('div');
            body.className = 'arr-instance-card-body';
            body.innerHTML =
                '<div class="arr-instance-header" style="display: flex; gap: 0.5em; align-items: center;">'
                + '<input is="emby-input" type="text" class="arr-instance-name" style="flex: 1;" placeholder="' + escapeHtml(namePlaceholder) + '" value="' + escapeHtml(instance.Name || '') + '" />'
                + '<button is="emby-button" type="button" class="raised arr-instance-remove" title="Remove instance"><span>Remove</span></button>'
                + '</div>'
                + '<div class="inputContainer">'
                + '<label class="inputLabel inputLabelUnfocused">URL (internal)</label>'
                + '<input is="emby-input" type="text" class="arr-instance-url" placeholder="' + escapeHtml(urlPlaceholder) + '" value="' + escapeHtml(instance.Url || '') + '" />'
                + '<div class="fieldDescription">The Jellyfin server uses this URL to talk to ' + defaultName + ' directly. If your public URL sits behind an auth proxy (Authentik, Authelia, Cloudflare Access, etc.), put the INTERNAL address here (e.g. http://' + type + ':' + defaultPort + ' or http://192.168.x.y:' + defaultPort + ') and set the External URL below for user-facing links.</div>'
                + '</div>'
                + '<div class="inputContainer">'
                + '<label class="inputLabel inputLabelUnfocused">External URL (optional)</label>'
                + '<input is="emby-input" type="text" class="arr-instance-externalurl" placeholder="e.g., https://' + type + '.example.com" value="' + escapeHtml(instance.ExternalUrl || '') + '" />'
                + '<div class="fieldDescription">Public URL a user&#39;s browser opens for links to this instance. Leave blank to reuse the internal URL above. URL Mappings below still take priority when a mapping matches.</div>'
                + '</div>'
                + '<div class="inputContainer">'
                + '<label class="inputLabel inputLabelUnfocused">API Key</label>'
                + '<div style="display: flex; align-items: center; gap: 0.5em;">'
                + '<input is="emby-input" type="text" class="arr-instance-apikey" autocomplete="off" placeholder="API key (find in Settings &gt; General &gt; Security)" style="flex: 1;" value="' + escapeHtml(instance.ApiKey || '') + '" />'
                + '<span class="material-icons arr-instance-status" style="transition: color 0.3s ease;" aria-hidden="true"></span>'
                + '<button is="emby-button" type="button" class="raised arr-instance-test"><span>Test</span></button>'
                + '</div>'
                + '<div class="fieldDescription">Find this in ' + defaultName + ' under Settings &gt; General &gt; Security &gt; API Key</div>'
                + '</div>'
                + '<div class="inputContainer">'
                + '<label class="inputLabel inputLabelUnfocused">URL Mappings (optional)</label>'
                + '<textarea class="emby-textarea emby-input arr-instance-urlmappings" rows="3" placeholder="jellyfin_url|arr_url (one per line)">' + escapeHtml(instance.UrlMappings || '') + '</textarea>'
                + '<div class="fieldDescription">Map Jellyfin access URLs to this instance&#39;s URL. Format: jellyfin_url|arr_url (one per line). Useful for reverse-proxy setups.</div>'
                + '</div>';
            card.appendChild(body);

            // --- Behaviors ---
            const nameInput = body.querySelector('.arr-instance-name');
            const urlInput = body.querySelector('.arr-instance-url');
            const removeBtn = body.querySelector('.arr-instance-remove');
            const testBtn = body.querySelector('.arr-instance-test');

            nameInput.addEventListener('input', function () {
                const name = nameInput.value.trim() || defaultName;
                summaryName.textContent = name;
                enabledCheckbox.setAttribute('aria-label', 'Enable ' + name + ' instance');
            });
            urlInput.addEventListener('input', function () {
                summaryUrl.textContent = urlInput.value.trim();
            });

            function setBodyDisabled(disabled) {
                // Hard-disable every control so edits can't silently persist while disabled.
                body.querySelectorAll('input, textarea, button, select').forEach(function (el) {
                    if (disabled) {
                        el.setAttribute('disabled', '');
                    } else {
                        el.removeAttribute('disabled');
                    }
                });
            }

            enabledCheckbox.addEventListener('change', function () {
                // Backend remains the authority — this is UI feedback until Save.
                const enabled = enabledCheckbox.checked;
                disabledChip.style.display = enabled ? 'none' : 'inline';
                card.classList.toggle('arr-instance-disabled', !enabled);
                setBodyDisabled(!enabled);
                try {
                    renderServiceStatusDashboard();
                } catch (e) {
                    console.warn('[JC] renderServiceStatusDashboard threw from arr-instance enable-toggle:', e);
                }
            });
            setBodyDisabled(!initiallyEnabled);
            if (!initiallyEnabled) {
                card.classList.add('arr-instance-disabled');
            }

            removeBtn.addEventListener('click', function (e) {
                e.preventDefault();
                const name = nameInput.value.trim() || defaultName;
                Dashboard.confirm(
                    'Remove "' + name + '" from the instance list? The change takes effect when you click Save. If you leave the page without saving, the instance is kept.\n\nTip: If you just want to stop using it temporarily, uncheck Enabled instead — that preserves the URL and API key.',
                    'Remove Instance',
                    function (confirmed) {
                        if (!confirmed) {
                            return;
                        }
                        card.remove();
                        jcMarkConfigDirty();
                        updateAllDependencies();
                    }
                );
            });

            testBtn.addEventListener('click', function (e) {
                e.preventDefault();
                testInstanceConnection(card);
            });

            return card;
        }

        function loadArrInstances(config) {
            _arrParseOK.sonarr = true;
            _arrParseOK.radarr = true;
            ['sonarr', 'radarr'].forEach(function (type) {
                const container = document.querySelector('#' + type + 'InstancesList');
                if (!container) {
                    return;
                }
                container.textContent = '';
                const typeName = type === 'sonarr' ? 'Sonarr' : 'Radarr';
                let instances = tryParseInstanceList(config[typeName + 'Instances'], type, container);
                // Legacy migration: only when the parse succeeded AND there are zero instances
                // AND both legacy fields are present. Skipped on parse failure — legacy fields
                // may be stale/already migrated.
                if (_arrParseOK[type] && instances.length === 0) {
                    const legacyUrl = config[typeName + 'Url'];
                    const legacyKey = config[typeName + 'ApiKey'];
                    if (legacyUrl && legacyKey) {
                        instances = [{
                            Name: typeName,
                            Url: legacyUrl,
                            ExternalUrl: config[typeName + 'ExternalUrl'] || '',
                            ApiKey: legacyKey,
                            UrlMappings: config[typeName + 'UrlMappings'] || ''
                        }];
                    }
                }
                instances.forEach(function (inst) {
                    container.appendChild(createInstanceCard(type, inst || {}, false));
                });
            });
        }

        function renderArrInstances(config) {
            loadArrInstances(config);
        }

        /* jcIsHttpUrl is owned by the core section. */

        function collectInstancesFromDom(selector, defaultName) {
            const instances = [];
            const incomplete = [];
            const renamed = [];
            const droppedExternal = [];
            const seen = Object.create(null);
            document.querySelectorAll(selector).forEach(function (card) {
                const urlInput = card.querySelector('.arr-instance-url');
                const keyInput = card.querySelector('.arr-instance-apikey');
                const nameInput = card.querySelector('.arr-instance-name');
                const url = ((urlInput && urlInput.value) || '').trim();
                const apiKey = ((keyInput && keyInput.value) || '').trim();
                const rawName = ((nameInput && nameInput.value) || '').trim() || defaultName;
                if (url && !apiKey) {
                    // Would otherwise be silently dropped — surface it as a save warning.
                    incomplete.push(rawName);
                    return;
                }
                if (!url || !apiKey) {
                    // Neither, or only an API key → dropped silently.
                    return;
                }
                // Duplicate-name disambiguation: Name is the ONLY runtime targeting key
                // (arr links, calendar, tag sync, action-sheet grab/monitor).
                let name = rawName;
                const nameKey = rawName.toLowerCase();
                const priorCount = seen[nameKey] || 0;
                if (priorCount > 0) {
                    name = rawName + ' (' + (priorCount + 1) + ')';
                    seen[nameKey] = priorCount + 1;
                    const suffixedKey = name.toLowerCase();
                    seen[suffixedKey] = (seen[suffixedKey] || 0) + 1;
                    renamed.push(rawName + '” → “' + name);
                } else {
                    seen[nameKey] = 1;
                }
                const externalInput = card.querySelector('.arr-instance-externalurl');
                const rawExternal = ((externalInput && externalInput.value) || '').trim();
                let externalUrl = '';
                if (rawExternal) {
                    if (jcIsHttpUrl(rawExternal)) {
                        externalUrl = rawExternal;
                    } else {
                        droppedExternal.push(name + ': ' + rawExternal);
                    }
                }
                const mappingsEl = card.querySelector('.arr-instance-urlmappings');
                const enabledCheckbox = card.querySelector('.arr-instance-enabled');
                instances.push({
                    InstanceId: normalizeArrInstanceId(card.dataset.instanceId),
                    Name: name,
                    Url: url,
                    ExternalUrl: externalUrl,
                    ApiKey: apiKey,
                    UrlMappings: (mappingsEl && mappingsEl.value) || '',
                    // Missing checkbox = enabled (defensive against DOM surgery).
                    Enabled: enabledCheckbox ? enabledCheckbox.checked : true
                });
            });
            return {
                instances: instances,
                incomplete: incomplete,
                renamed: renamed,
                droppedExternal: droppedExternal
            };
        }

        // Warning-string builders for the save path (core's saveArrInstances consumes these;
        // the caller alerts each with title '⚠ Incomplete *arr instance').
        function buildArrIncompleteWarning(typeName, name) {
            return typeName + ' instance "' + name + '" has a URL but no API key — it was not saved.';
        }

        function buildArrRenamedWarning(typeName, renamedFragment) {
            // renamedFragment already contains the 'old” → “new' interior; this template
            // supplies the surrounding curly quotes.
            return 'Renamed duplicate ' + typeName + ' instance “' + renamedFragment + '” so actions target the right instance.';
        }

        function buildArrDroppedExternalWarning(typeName, dropped) {
            return 'Dropped invalid ' + typeName + ' External URL (must be an http(s) URL without credentials or query/fragment) — ' + dropped;
        }

        function buildArrInstanceWarnings(typeName, collected) {
            const warnings = [];
            collected.incomplete.forEach(function (name) {
                warnings.push(buildArrIncompleteWarning(typeName, name));
            });
            collected.renamed.forEach(function (renamedFragment) {
                warnings.push(buildArrRenamedWarning(typeName, renamedFragment));
            });
            collected.droppedExternal.forEach(function (dropped) {
                warnings.push(buildArrDroppedExternalWarning(typeName, dropped));
            });
            return warnings;
        }

        // ---------------------------------------------------------------------------
        // Wiring (called once by the integrator's init sequence — the old per-pageshow
        // rewiring accumulated duplicate listeners; wiring once is the approved fix)
        // ---------------------------------------------------------------------------

        function wireConnections() {
            const testSeerrBtn = document.querySelector('#testSeerrBtn');
            if (testSeerrBtn) {
                testSeerrBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    testSeerrConnection();
                });
            }

            const testMaintainerrBtn = document.querySelector('#testMaintainerrBtn');
            if (testMaintainerrBtn) {
                testMaintainerrBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    testMaintainerrConnection();
                });
            }

            // Multiple TMDB test buttons exist across tabs; each resolves its own indicator.
            // After the test settles, refresh TMDB-gated toggles.
            document.querySelectorAll('.testTmdbBtn').forEach(function (btn) {
                btn.addEventListener('click', function (e) {
                    e.preventDefault();
                    Promise.resolve(testTmdbConnection(e)).then(function () {
                        updateAllDependencies();
                    });
                });
            });

            // TMDB key mirror sync: #TMDB_API_KEY (Elsewhere tab) and #seerr_TMDB_API_KEY
            // (Seerr tab) back a single config value; on save the Seerr-tab field wins.
            const tmdbMain = document.querySelector('#TMDB_API_KEY');
            const tmdbSeerr = document.querySelector('#seerr_TMDB_API_KEY');
            if (tmdbMain && tmdbSeerr) {
                tmdbMain.addEventListener('input', function () {
                    tmdbSeerr.value = tmdbMain.value;
                });
                tmdbSeerr.addEventListener('input', function () {
                    tmdbMain.value = tmdbSeerr.value;
                });
            }

            // Persisted-result invalidation on committed edits of the tested inputs.
            _wireInvalidate('#TMDB_API_KEY', 'tmdb');
            _wireInvalidate('#seerr_TMDB_API_KEY', 'tmdb');
            _wireInvalidate('#seerrUrls', 'seerr');
            _wireInvalidate('#SeerrApiKey', 'seerr');
            _wireInvalidate('#maintainerrUrl',  'maintainerr');

            // Typing in the Maintainerr URL aborts an in-flight test and resets its UI.
            const maintainerrUrlInput = document.querySelector('#maintainerrUrl');
            if (maintainerrUrlInput) {
                maintainerrUrlInput.addEventListener('input', function () {
                    cancelActiveMaintainerrTest(true);
                });
            }

            // Mapping validation buttons.
            const validateSonarrBtn = document.querySelector('#validateSonarrMappingsBtn');
            if (validateSonarrBtn) {
                validateSonarrBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    _jeValidateInstanceMappings('sonarr', 'validateSonarrMappingsBtn', 'sonarrMappingsValidationResult', 'Sonarr');
                });
            }
            const validateRadarrBtn = document.querySelector('#validateRadarrMappingsBtn');
            if (validateRadarrBtn) {
                validateRadarrBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    _jeValidateInstanceMappings('radarr', 'validateRadarrMappingsBtn', 'radarrMappingsValidationResult', 'Radarr');
                });
            }
            const validateBazarrBtn = document.querySelector('#validateBazarrMappingsBtn');
            if (validateBazarrBtn) {
                validateBazarrBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    const bazarrMappings = document.querySelector('#bazarrUrlMappings');
                    if (!bazarrMappings || !bazarrMappings.value.trim()) {
                        Dashboard.alert({
                            title: 'No Mappings',
                            message: 'No Bazarr URL mappings configured. Fill in the Bazarr URL Mappings field above to validate.'
                        });
                        return;
                    }
                    jcRunMappingValidation([{ id: 'bazarrUrlMappings', service: 'Bazarr' }], 'validateBazarrMappingsBtn', 'bazarrMappingsValidationResult');
                });
            }
            const validateSeerrBtn = document.querySelector('#validateSeerrMappingsBtn');
            if (validateSeerrBtn) {
                validateSeerrBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    jcRunMappingValidation([{ id: 'seerrUrlMappings', service: 'Seerr' }], 'validateSeerrMappingsBtn', 'seerrMappingsValidationResult');
                });
            }
            const validateMaintainerrBtn = document.querySelector('#validateMaintainerrMappingsBtn');
            if (validateMaintainerrBtn) {
                validateMaintainerrBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    const maintainerrMappings = document.querySelector('#maintainerrUrlMappings');
                    if (!maintainerrMappings || !maintainerrMappings.value.trim()) {
                        Dashboard.alert({
                            title: 'No Mappings',
                            message: 'No Maintainerr URL mappings are configured.'
                        });
                        return;
                    }
                    validateMaintainerrMappingSet('maintainerrUrlMappings', validateMaintainerrBtn, 'maintainerrMappingsValidationResult');
                });
            }

            const triggerSeerrScanBtn = document.querySelector('#triggerSeerrScanNowBtn');
            if (triggerSeerrScanBtn) {
                triggerSeerrScanBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    triggerSeerrScanNow();
                });
            }

        }

        /* Page-lifecycle cancellation (both event names exist across Jellyfin
           builds). Wired via init isolation like every other subsystem; the
           dedented addEventListener lines keep the drift-guard's pinned
           12-space handler-body shape. */
        function wireConnectionLifecycle() {
            if (!page) return;
        page.addEventListener('pagehide', function() {
            cancelActiveMaintainerrTest(true);
            cancelActiveSeerrScan();
        });
        page.addEventListener('viewhide', function() {
            cancelActiveMaintainerrTest(true);
            cancelActiveSeerrScan();
        });
        }

        function wireArrInstances() {
            [['#addSonarrInstance', 'sonarr'], ['#addRadarrInstance', 'radarr']].forEach(function (pair) {
                const btn = document.querySelector(pair[0]);
                if (!btn) {
                    return;
                }
                btn.addEventListener('click', function (e) {
                    e.preventDefault();
                    const container = document.querySelector('#' + pair[1] + 'InstancesList');
                    if (!container) {
                        return;
                    }
                    // Open card; fresh random InstanceId since Url is blank. Adding does not
                    // itself mark dirty — typing into the new card does, via the form listener.
                    container.appendChild(createInstanceCard(pair[1], { Name: '', Url: '', ExternalUrl: '', ApiKey: '', UrlMappings: '' }, true));
                    updateAllDependencies();
                });
            });
        }

/* SECTION: widgets — owns: descriptions toggle (jc-settings-descriptions-visible), dependency gating
   (SECTION_DEPS/INDIVIDUAL_DEPS/PARENT_DEPS, applyGatedHelp, updateAllDependencies, debouncedUpdateDeps,
   requests requirements banner, collapsible info banners + syncAllBannerParents,
   updateClientTagCacheControlsVisibility), shortcuts editor (defaultShortcuts, shortcutOverrides,
   collectShortcuts), maintenance-mode users UI, branding uploads, permission audit, timing previews,
   order rows (_qualityCatRenderOK/_pagesOrderRenderOK, renderQualityCatOrderAdmin/renderPagesOrderAdmin),
   blocked users + syncBlockedUsersToHiddenInput + Seerr user import, language options, client refresh,
   sticky header, custom plugin links tester, copy buttons, auto-movie request selects.
   wires: wireWidgets() (call once at init; NOT on pageshow). Core additionally calls, from loadConfig:
   renderShortcuts(config), renderOrderRows(config), loadMaintenanceUsers(), loadBlockedUsersList(ids),
   populateAutoMovieRequestSelects(config), updateAllDependencies(); and once at init:
   loadLanguageOptions(). refreshBrandingPreviews() available for re-refresh. Save path reads
   _qualityCatRenderOK/_pagesOrderRenderOK and calls collectShortcuts() + syncBlockedUsersToHiddenInput().
   NOTE: applyGatedHelp and updateAllDependencies are listed in the shared-core assume-list but are
   OWNED and defined here.
   depends: form, jcMarkConfigDirty (core); saveConfig (binder); jcNormalizeMaintainerrBaseUrl
   (connections); hasIntroSkipper, renderServiceStatusDashboard, renderOptionalPluginsDashboard,
   renderFeaturesDashboard, updateClearTagCachesQuickBtnVisibility (dashboards); ApiClient, Dashboard.
   Owned mutable state (top-level lets, literal initializers only): shortcutOverrides,
   _qualityCatRenderOK, _pagesOrderRenderOK, _blockedUsersLoaded, _jeGatedHelpState, _jcBannerGroups,
   _activePanelPreviewCleanup, _depsDebounceTimer, _autoMovieServerListenerAdded,
   _brandingStatusTimers, _shortcutErrorTimer, _shortcutShakeEl. */

/* ------------------------------------------------------------------ */
/* 1. Descriptions toggle                                              */
/* ------------------------------------------------------------------ */

const DESC_PREF_KEY = 'jc-settings-descriptions-visible';

function applyDescriptionVisibility(show) {
    try {
        document.body.classList.toggle('jc-hide-descriptions', !show);
    } catch (e) {
        console.warn('[JC] descriptions body-class toggle failed', e);
    }
    const btn = document.querySelector('#toggleDescriptionsBtn');
    if (!btn) return;
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    btn.classList.toggle('jc-desc-toggle-off', !show);
    const state = btn.querySelector('.jc-desc-toggle-state');
    if (state) state.textContent = show ? 'On' : 'Off';
}

function wireDescriptionsToggle() {
    let stored = null;
    try {
        stored = localStorage.getItem(DESC_PREF_KEY);
    } catch (e) {
        // storage unavailable — default visible
    }
    applyDescriptionVisibility(stored !== 'false');
    const btn = document.querySelector('#toggleDescriptionsBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const showNow = !document.body.classList.contains('jc-hide-descriptions');
        const next = !showNow;
        applyDescriptionVisibility(next);
        try {
            localStorage.setItem(DESC_PREF_KEY, next ? 'true' : 'false');
        } catch (e) {
            // storage failure tolerated — UI still toggles
        }
    });
}

/* ------------------------------------------------------------------ */
/* 2. Dependency system                                                */
/* ------------------------------------------------------------------ */

function hasTmdbKey() {
    const a = document.querySelector('#TMDB_API_KEY');
    const b = document.querySelector('#seerr_TMDB_API_KEY');
    return !!((a && a.value.trim()) || (b && b.value.trim()));
}

function hasAtLeastOneValidSeerrUrl(value) {
    return String(value || '').split('\n').map(l => l.trim()).filter(Boolean).some(line => {
        try {
            const u = new URL(line);
            return u.protocol === 'http:' || u.protocol === 'https:';
        } catch (e) {
            return false;
        }
    });
}

function hasSeerrConfigured() {
    const enabled = document.querySelector('#seerrEnabled');
    const urls = document.querySelector('#seerrUrls');
    const key = document.querySelector('#SeerrApiKey');
    return !!(enabled && enabled.checked
        && urls && hasAtLeastOneValidSeerrUrl(urls.value)
        && key && key.value.trim());
}

function hasMaintainerrConfigured() {
    const enabled = document.querySelector('#maintainerrEnabled');
    const url = document.querySelector('#maintainerrUrl');
    return !!(enabled && enabled.checked && url && jcNormalizeMaintainerrBaseUrl(url.value));
}

function hasAnyArrService() {
    return Array.from(document.querySelectorAll('.arr-instance-card')).some(card => {
        const enabledCb = card.querySelector('.arr-instance-enabled');
        const enabled = enabledCb ? enabledCb.checked : true; // missing checkbox counts enabled
        const url = card.querySelector('.arr-instance-url');
        const key = card.querySelector('.arr-instance-apikey');
        return enabled && url && url.value.trim() && key && key.value.trim();
    });
}

/* Dep tags: comma-separated data-dep-disabled — an element is only released
   when its LAST tag is removed, so overlapping gates compose. */

function jcDepTags(el) {
    return (el.dataset.depDisabled || '').split(',').filter(Boolean);
}

function addDepTag(el, tag) {
    const tags = jcDepTags(el);
    if (!tags.includes(tag)) tags.push(tag);
    el.dataset.depDisabled = tags.join(',');
}

function removeDepTag(el, tag) {
    const tags = jcDepTags(el).filter(t => t !== tag);
    if (tags.length) {
        el.dataset.depDisabled = tags.join(',');
        return false;
    }
    delete el.dataset.depDisabled;
    return true;
}

const SECTION_DEPS = [
    {
        tab: '#seerr',
        check: hasSeerrConfigured,
        bannerId: 'dep-banner-seerr',
        title: 'Enable "Seerr integration" to configure',
        hint: 'Provide a Seerr URL and API key in the Setup section above, then enable the integration.'
    },
    {
        tab: '#maintainerr',
        check: hasMaintainerrConfigured,
        bannerId: 'dep-banner-maintainerr',
        title: 'Enable Maintainerr to configure',
        hint: 'Provide the server-only Maintainerr URL above, then enable the integration.'
    },
    {
        tab: '#arr',
        check: hasAnyArrService,
        bannerId: 'dep-banner-arr',
        title: 'Enable a *arr service to configure',
        hint: 'Add a URL and API key for Sonarr or Radarr above to enable these features.'
    }
];

function createDepBanner(id, dep) {
    const banner = document.createElement('div');
    banner.className = 'jc-dep-banner';
    banner.id = id;
    const icon = document.createElement('i');
    icon.className = 'material-icons jc-dep-banner-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'link_off';
    const text = document.createElement('div');
    text.className = 'jc-dep-banner-text';
    const strong = document.createElement('strong');
    strong.textContent = dep.title;
    text.appendChild(strong);
    text.appendChild(document.createElement('br'));
    const hint = document.createElement('span');
    hint.className = 'jc-dep-banner-hint';
    hint.textContent = dep.hint;
    text.appendChild(hint);
    banner.appendChild(icon);
    banner.appendChild(text);
    return banner;
}

function updateSectionDep(dep) {
    const tabEl = document.querySelector(dep.tab);
    if (!tabEl) return;
    const met = dep.check();
    const allFieldsets = Array.from(tabEl.querySelectorAll(':scope > fieldset'));
    // Setup fieldsets stay editable so an admin can add a connection.
    const targets = allFieldsets.filter(fs => !fs.hasAttribute('data-dep-setup'));
    const tag = dep.bannerId;
    targets.forEach(fs => {
        const bannerId = dep.bannerId + '-' + allFieldsets.indexOf(fs);
        let banner = document.getElementById(bannerId);
        if (!met) {
            if (!banner) {
                banner = createDepBanner(bannerId, dep);
                const legend = fs.querySelector('legend');
                if (legend) {
                    legend.parentNode.insertBefore(banner, legend.nextSibling);
                } else {
                    fs.prepend(banner);
                }
            }
            banner.classList.remove('jc-hidden');
            fs.querySelectorAll('input, select, textarea, button').forEach(el => {
                if (banner.contains(el)) return;
                el.disabled = true;
                addDepTag(el, tag);
            });
            fs.querySelectorAll('label, .inputLabel, .selectLabel').forEach(el => {
                el.style.opacity = '.5';
                el.style.cursor = 'not-allowed';
                addDepTag(el, tag);
            });
            fs.querySelectorAll('.fieldDescription').forEach(el => {
                el.style.opacity = '.5';
                addDepTag(el, tag);
            });
        } else {
            if (banner) banner.classList.add('jc-hidden');
            fs.querySelectorAll('[data-dep-disabled]').forEach(el => {
                if (removeDepTag(el, tag)) {
                    if (el.tagName !== 'LABEL' && el.tagName !== 'DIV') el.disabled = false;
                    el.style.opacity = '';
                    el.style.cursor = '';
                }
            });
        }
    });
}

const INDIVIDUAL_DEPS = [
    { id: 'elsewhereEnabled', check: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
    { id: 'showReviews', check: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
    { id: 'showElsewhereOnSeerr', check: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
    { id: 'autoMovieRequestEnabled', check: hasTmdbKey, hint: 'Add a TMDB API Key to enable', icon: 'key' },
    // Tri-state fail-open: unknown/null plugin probe does NOT disable the toggles.
    { id: 'autoSkipIntro', check: function () { return hasIntroSkipper !== false; }, hint: 'Install Intro Skipper plugin to enable', icon: 'extension' },
    { id: 'autoSkipOutro', check: function () { return hasIntroSkipper !== false; }, hint: 'Install Intro Skipper plugin to enable', icon: 'extension' }
];

function updateIndividualDep(dep) {
    const cb = document.getElementById(dep.id);
    if (!cb) return;
    const label = cb.closest('label');
    const tag = 'ind-' + dep.id;
    if (!dep.check()) {
        cb.disabled = true;
        addDepTag(cb, tag);
        if (label) {
            label.style.opacity = '.5';
            label.style.cursor = 'not-allowed';
            label.title = dep.hint;
            addDepTag(label, tag);
            const span = label.querySelector('span');
            if (span) {
                if (!span.querySelector('.dep-required-icon')) {
                    const icon = document.createElement('i');
                    icon.className = 'material-icons dep-required-icon';
                    icon.textContent = dep.icon;
                    icon.title = dep.hint;
                    icon.style.fontSize = '16px';
                    icon.style.color = 'var(--jc-warning)';
                    span.appendChild(icon);
                }
                if (!span.querySelector('.dep-hint-text')) {
                    const hintEl = document.createElement('span');
                    hintEl.className = 'dep-hint-text';
                    hintEl.textContent = dep.hint;
                    span.appendChild(hintEl);
                }
            }
        }
    } else {
        if (removeDepTag(cb, tag)) cb.disabled = false;
        if (label) {
            if (removeDepTag(label, tag)) {
                label.style.opacity = '';
                label.style.cursor = '';
                label.removeAttribute('title');
            }
            const span = label.querySelector('span');
            if (span) {
                const icon = span.querySelector('.dep-required-icon');
                if (icon) icon.remove();
                const hintEl = span.querySelector('.dep-hint-text');
                if (hintEl) hintEl.remove();
            }
        }
    }
}

const PARENT_DEPS = [
    // Deliberately ONLY the branding fields: provider/region inputs are shared with
    // features that render independently of Elsewhere.
    { parent: 'elsewhereEnabled', label: 'Enable Elsewhere', children: ['ElsewhereCustomBrandingText', 'ElsewhereCustomBrandingImageUrl'] },
    { parent: 'showReviews', label: 'Show Reviews', children: ['reviewsExpandedByDefault'] },
    { parent: 'showUserReviews', label: 'Enable User Reviews', children: ['hideReviewsFromHiddenUsers', 'hideReviewsFromDisabledUsers', 'showUserRatingDash', 'showUserRatingOnPosters'] },
    { parent: 'randomButtonEnabled', label: 'Enable Random Button', children: ['randomUnwatchedOnly', 'randomIncludeMovies', 'randomIncludeShows'] },
    { parent: 'showWatchProgress', label: 'Show watch progress', children: ['watchProgressDefaultMode', 'watchProgressTimeFormat'] },
    { parent: 'qualityTagsEnabled', label: 'Enable Quality Tags', noHint: true, children: ['qualityTagsPosition', 'showResolutionTag', 'showSourceTag', 'showDynamicRangeTag', 'showSpecialFormatTag', 'showVideoCodecTag', 'showAudioInfoTag'] },
    { parent: 'genreTagsEnabled', label: 'Enable Genre Tags', noHint: true, children: ['genreTagsPosition'] },
    { parent: 'languageTagsEnabled', label: 'Enable Language Tags', noHint: true, children: ['languageTagsPosition'] },
    { parent: 'ratingTagsEnabled', label: 'Enable Rating Tags', noHint: true, children: ['ratingTagsPosition'] },
    { parent: 'useIcons', label: 'Use Icons', children: ['iconStyle'] },
    { parent: 'letterboxdEnabled', label: 'Enable Letterboxd', children: ['showLetterboxdLinkAsText'] },
    { parent: 'enableCustomSplashScreen', label: 'Enable Custom Splash Screen', children: ['splashScreenImageUrl'] },
    { parent: 'seerrShowSearchResults', label: 'Show Seerr Results in Search', children: ['showCollectionsInSearch'] },
    { parent: 'seerrShowReportButton', label: 'Show Report Issue button', children: ['seerrShowIssueIndicator'] },
    { parent: 'downloadsPageEnabled', label: 'Enable Requests Page', children: ['showDownloadsInRequests', 'downloadsPageShowIssues', 'downloadsPagePollingEnabled', 'downloadsAllowActiveForRegularUsers', 'downloadsAllowProcessingForRegularUsers', 'downloadsAllowWarningsForRegularUsers', 'downloadsAllowHistoryForRegularUsers', 'downloadsAllowProvenanceForRegularUsers', 'downloadsDetailedLifecycleForRegularUsers', 'downloadsHistoryWindowDays', 'requestsAllowSeerrStatusAndHistoryForRegularUsers'] },
    // Overlap with downloadsPageEnabled composes via tags.
    { parent: 'showDownloadsInRequests', label: 'Show Downloads in Requests Page', children: ['downloadsFilterByUserRequests', 'downloadsAllowActiveForRegularUsers', 'downloadsAllowProcessingForRegularUsers', 'downloadsAllowWarningsForRegularUsers', 'downloadsAllowHistoryForRegularUsers', 'downloadsAllowProvenanceForRegularUsers', 'downloadsDetailedLifecycleForRegularUsers', 'downloadsHistoryWindowDays'] },
    { parent: 'downloadsPagePollingEnabled', label: 'Enable Auto-Refresh', children: ['downloadsPollIntervalSeconds'] },
    { parent: 'arrLinksEnabled', label: 'Enable *arr Links', children: ['showArrLinksAsText', 'arrLinksShowStatusSingle'] },
    { parent: 'arrTagsSyncEnabled', label: 'Enable *arr Tags Sync', children: ['arrTagsPrefix', 'arrTagsClearOldTags', 'arrTagsShowAsLinks', 'arrTagsSyncFilter'] },
    { parent: 'arrTagsShowAsLinks', label: 'Show synced tags as links', children: ['arrTagsLinksFilter', 'arrTagsLinksHideFilter'] },
    { parent: 'calendarPageEnabled', label: 'Enable Calendar Page', children: ['calendarFirstDayOfWeek', 'calendarTimeFormat', 'calendarHighlightFavorites', 'calendarHighlightWatchedSeries', 'calendarFilterByLibraryAccess', 'calendarShowOnlyRequested', 'calendarForceOnlyRequested'] },
    { parent: 'autoMovieRequestEnabled', label: 'Enable Automatic Movie Requests', children: ['autoMovieRequestTriggerOnStart', 'autoMovieRequestTriggerOnMinutesWatched', 'autoMovieRequestMinutesWatched', 'autoMovieRequestCheckReleaseDate', 'autoMovieRequestQualityMode', 'autoMovieRequestFallbackOn4k'] },
    { parent: 'autoSeasonRequestEnabled', label: 'Enable Automatic Season Requests', children: ['autoSeasonRequestRequireAllWatched', 'autoSeasonRequestThresholdValue'] },
    { parent: 'preventWatchlistReAddition', label: 'Prevent re-adding removed items', children: ['watchlistMemoryRetentionDays'] },
    { parent: 'triggerSeerrScanOnItemAdded', label: 'Trigger Seerr scan on item added', children: ['seerrScanDebounceSeconds'] },
    // Empty-children entries exist so the parent still participates in change wiring.
    { parent: 'bookmarksEnabled', label: 'Enable Bookmarks', children: [] },
    { parent: 'hiddenContentEnabled', label: 'Enable Hidden Content', children: [] }
];

function updateParentDep(dep) {
    const parent = document.getElementById(dep.parent);
    if (!parent) return;
    const tag = 'parent-' + dep.parent;
    const on = parent.checked;
    dep.children.forEach(childId => {
        const child = document.getElementById(childId);
        if (!child) return;
        const container = child.closest('.checkboxContainer, .inputContainer, .selectContainer') || child.closest('label');
        if (!on) {
            child.disabled = true;
            addDepTag(child, tag);
            if (container) {
                container.style.opacity = '.5';
                container.style.cursor = 'not-allowed';
                addDepTag(container, tag);
                if (!dep.noHint && !container.querySelector('.parent-hint-' + dep.parent)) {
                    const hint = document.createElement('div');
                    hint.className = 'dep-hint-text parent-hint-' + dep.parent;
                    hint.textContent = 'Enable "' + dep.label + '" to configure';
                    container.appendChild(hint);
                }
            }
        } else {
            if (removeDepTag(child, tag)) child.disabled = false;
            if (container) {
                if (removeDepTag(container, tag)) {
                    container.style.opacity = '';
                    container.style.cursor = '';
                }
                const hint = container.querySelector('.parent-hint-' + dep.parent);
                if (hint) hint.remove();
            }
        }
    });
}

function updateRequestsRequirementsBanner() {
    const line = document.querySelector('#requestsPageRequirementsLine');
    if (!line) return;
    const list = document.querySelector('#requestsPageRequirementsList');
    // The page is useful with EITHER source: downloads <- any enabled *arr; requests/issues <- Seerr.
    const met = hasAnyArrService() || hasSeerrConfigured();
    if (met) {
        line.style.display = 'none';
    } else {
        const target = list || line;
        target.textContent = 'Configure Seerr (for requests) and/or Sonarr or Radarr (for downloads) — URL and API key each.';
        line.style.display = '';
    }
}

function updateClientTagCacheControlsVisibility() {
    const serverMode = document.querySelector('#tagCacheServerMode');
    if (!serverMode) return;
    const serverOn = serverMode.checked;
    const fallbackContainer = document.querySelector('#tagsLocalStorageFallbackContainer');
    const fallbackDesc = document.querySelector('[data-desc-for="enableTagsLocalStorageFallback"]');
    const clientControls = document.querySelector('#clientTagCacheControls');
    if (fallbackContainer) fallbackContainer.style.display = serverOn ? 'none' : '';
    if (fallbackDesc) fallbackDesc.style.display = serverOn ? 'none' : '';
    if (clientControls) clientControls.style.display = serverOn ? 'none' : '';
    if (!serverOn) {
        const fallbackCb = document.querySelector('#enableTagsLocalStorageFallback');
        if (fallbackCb) fallbackCb.checked = true;
    }
    if (typeof updateClearTagCachesQuickBtnVisibility === 'function') {
        try {
            updateClearTagCachesQuickBtnVisibility();
        } catch (e) {
            console.warn('[JC] quick-action visibility sync failed', e);
        }
    }
}

function updateAllDependencies() {
    SECTION_DEPS.forEach(dep => {
        try { updateSectionDep(dep); } catch (e) { console.warn('[JC] section dep update failed', e); }
    });
    INDIVIDUAL_DEPS.forEach(dep => {
        try { updateIndividualDep(dep); } catch (e) { console.warn('[JC] individual dep update failed', e); }
    });
    PARENT_DEPS.forEach(dep => {
        try { updateParentDep(dep); } catch (e) { console.warn('[JC] parent dep update failed', e); }
    });
    try { updateRequestsRequirementsBanner(); } catch (e) { console.warn('[JC] requests requirements banner update failed', e); }
    updateClientTagCacheControlsVisibility();
    // Unified dashboard renderer called ONCE (both legacy alias names would rebuild the grid twice).
    try { renderServiceStatusDashboard(); } catch (e) { console.warn('[JC] service status dashboard render failed', e); }
    try { renderOptionalPluginsDashboard(); } catch (e) { console.warn('[JC] optional plugins dashboard render failed', e); }
    try { renderFeaturesDashboard(); } catch (e) { console.warn('[JC] features dashboard render failed', e); }
    // Needed because loadConfig's programmatic `.checked =` fires no change event.
    try { syncAllBannerParents(); } catch (e) { console.warn('[JC] banner parent sync failed', e); }
    // false = never auto-expand from a bulk sync.
    try { applyGatedHelp(false); } catch (e) { console.warn('[JC] gated help refresh failed', e); }
}

let _depsDebounceTimer = null;

function debouncedUpdateDeps() {
    if (_depsDebounceTimer) clearTimeout(_depsDebounceTimer);
    _depsDebounceTimer = setTimeout(() => {
        _depsDebounceTimer = null;
        updateAllDependencies();
    }, 150);
}

function wireReactiveDeps() {
    // Unguarded selectors — elements required by the markup contract.
    ['#TMDB_API_KEY', '#seerr_TMDB_API_KEY', '#seerrUrls', '#SeerrApiKey', '#maintainerrUrl'].forEach(sel => {
        document.querySelector(sel).addEventListener('input', debouncedUpdateDeps);
    });
    ['#seerrEnabled', '#maintainerrEnabled', '#tagCacheServerMode'].forEach(sel => {
        document.querySelector(sel).addEventListener('change', () => updateAllDependencies());
    });
    const seen = {};
    PARENT_DEPS.forEach(dep => {
        if (seen[dep.parent]) return;
        seen[dep.parent] = true;
        const parent = document.getElementById(dep.parent);
        if (parent) parent.addEventListener('change', () => updateAllDependencies());
    });
}

function wireRequestsBannerReactive() {
    if (!form) {
        console.error('[JC] #JellyfinCanopyForm missing — reactive dep updates disabled');
        return;
    }
    const refresh = () => {
        try {
            updateRequestsRequirementsBanner();
            debouncedUpdateDeps();
        } catch (err) {
            console.error('[JC] dep refresh failed', err);
        }
    };
    // Deliberately no parallel `change` listener: checkboxes fire both -> double-run.
    form.addEventListener('input', evt => {
        const t = evt.target;
        if (!t || !t.classList) return;
        if (t.id === 'seerrUrls' || t.id === 'SeerrApiKey'
            || t.classList.contains('arr-instance-url')
            || t.classList.contains('arr-instance-apikey')
            || t.classList.contains('arr-instance-enabled')) {
            refresh();
        }
    });
    // Instance add/remove fires no input event — observe the lists (persistent by design).
    ['#sonarrInstancesList', '#radarrInstancesList'].forEach(sel => {
        const list = document.querySelector(sel);
        if (!list) return;
        new MutationObserver(refresh).observe(list, { childList: true, subtree: true });
    });
}

/* Gated help: data-gated-by="<checkboxId>[,<id2>...]" elements are hidden
   unless ALL listed parents are checked. */

let _jeGatedHelpState = {};

function jcGatedHelpParentIds() {
    const ids = {};
    document.querySelectorAll('[data-gated-by]').forEach(el => {
        (el.dataset.gatedBy || '').split(',').map(s => s.trim()).filter(Boolean).forEach(id => {
            ids[id] = true;
        });
    });
    return Object.keys(ids);
}

function applyGatedHelp(autoExpandOnRise) {
    const rose = {};
    jcGatedHelpParentIds().forEach(id => {
        const cb = document.getElementById(id);
        const checked = !!(cb && cb.checked);
        if (autoExpandOnRise && _jeGatedHelpState[id] === false && checked) rose[id] = true;
        _jeGatedHelpState[id] = checked;
    });
    document.querySelectorAll('[data-gated-by]').forEach(el => {
        const ids = (el.dataset.gatedBy || '').split(',').map(s => s.trim()).filter(Boolean);
        const visible = ids.every(id => _jeGatedHelpState[id] === true);
        el.hidden = !visible;
        if (visible && autoExpandOnRise && el.tagName === 'DETAILS' && ids.some(id => rose[id])) {
            el.open = true;
        }
    });
}

function wireGatedHelp() {
    jcGatedHelpParentIds().forEach(id => {
        const cb = document.getElementById(id);
        if (!cb) {
            console.warn('[JC] gated-help: parent checkbox #' + id + ' not found — help will stay hidden');
            return;
        }
        // Prime with current checked value: prevents a phantom "rise" on first
        // interaction after loadConfig set state programmatically.
        _jeGatedHelpState[id] = cb.checked;
        cb.addEventListener('change', () => applyGatedHelp(true));
    });
    applyGatedHelp(false);
}

/* Collapsible info banners */

let _jcBannerGroups = [];

function findNearestBannerDescWrapper(banner) {
    const inAncestor = banner.closest('.jc-setting-description[data-desc-for]');
    if (inAncestor) return inAncestor;
    let sib = banner.previousElementSibling;
    while (sib) {
        if (sib.matches && sib.matches('.jc-setting-description[data-desc-for]')) return sib;
        const inner = sib.querySelector && sib.querySelector('.jc-setting-description[data-desc-for]');
        if (inner) return inner;
        sib = sib.previousElementSibling;
    }
    return null;
}

function syncBannerGroupParent(group) {
    if (!group.gate) return;
    const off = !group.gate.checked;
    group.banners.forEach(b => {
        b.classList.toggle('jc-banner-parent-off', off);
        if (off) b.classList.remove('jc-banner-open');
    });
    if (group.trigger) {
        group.trigger.classList.toggle('jc-banner-parent-off', off);
        if (off) group.trigger.setAttribute('aria-expanded', 'false');
    }
}

function syncAllBannerParents() {
    _jcBannerGroups.forEach(syncBannerGroupParent);
}

function wireCollapsibleBanners() {
    const banners = Array.from(document.querySelectorAll('.jc-info-banner-inline, .jc-info-banner-inline-center'));
    const groups = new Map();
    banners.forEach((banner, idx) => {
        banner.classList.add('jc-banner-managed');
        if (!banner.id) {
            banner.id = 'jc-banner-' + idx + '-' + Math.random().toString(36).slice(2, 8);
        }
        let anchor = null;
        let descWrapper = null;
        const explicit = banner.dataset.bannerAnchor;
        if (explicit === 'legend') {
            const fs = banner.closest('fieldset');
            anchor = fs ? fs.querySelector('legend.sectionTitle') : null;
        } else if (explicit && explicit.charAt(0) === '#') {
            anchor = document.querySelector(explicit);
        } else {
            descWrapper = findNearestBannerDescWrapper(banner);
            if (descWrapper) {
                const ref = document.getElementById(descWrapper.dataset.descFor);
                // Container anchor: trigger attaches as a sibling of the label so
                // clicks don't forward to the checkbox.
                anchor = ref ? ref.closest('.checkboxContainer, .inputContainer') : null;
            }
            if (!anchor) {
                const fs = banner.closest('fieldset');
                anchor = fs ? fs.querySelector('legend.sectionTitle') : null;
            }
        }
        if (!anchor) {
            // The banner would silently vanish in descriptions-off mode otherwise.
            console.warn('[JC] banner has no anchor — collapse trigger will not be wired:', banner);
            return;
        }
        let group = groups.get(anchor);
        if (!group) {
            group = { anchor: anchor, banners: [], gate: null, trigger: null };
            groups.set(anchor, group);
        }
        group.banners.push(banner);
        if (!group.gate && banner.dataset.bannerNoGate !== 'true' && descWrapper) {
            const ref = document.getElementById(descWrapper.dataset.descFor);
            if (ref && ref.type === 'checkbox') group.gate = ref;
        }
    });
    groups.forEach(group => {
        if (group.anchor.dataset.jcBannerWired) return;
        group.anchor.dataset.jcBannerWired = 'true';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'jc-banner-trigger';
        trigger.setAttribute('aria-expanded', 'false');
        const label = group.banners.length > 1
            ? 'Show ' + group.banners.length + ' info panels'
            : 'Show info';
        trigger.setAttribute('aria-label', label);
        trigger.title = label;
        const icon = document.createElement('i');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'info';
        trigger.appendChild(icon);
        group.anchor.appendChild(trigger);
        group.trigger = trigger;
        trigger.addEventListener('click', evt => {
            evt.preventDefault();
            if (group.gate && !group.gate.checked) return;
            const open = !group.banners.some(b => b.classList.contains('jc-banner-open'));
            group.banners.forEach(b => b.classList.toggle('jc-banner-open', open));
            trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        if (group.gate) {
            group.gate.addEventListener('change', () => syncBannerGroupParent(group));
        }
        syncBannerGroupParent(group);
        _jcBannerGroups.push(group);
    });
    // Click outside any trigger/banner closes all open banners.
    document.addEventListener('click', evt => {
        const t = evt.target;
        if (t && t.closest && (t.closest('.jc-banner-trigger') || t.closest('.jc-banner-managed'))) return;
        document.querySelectorAll('.jc-banner-managed.jc-banner-open').forEach(b => b.classList.remove('jc-banner-open'));
        _jcBannerGroups.forEach(g => {
            if (g.trigger) g.trigger.setAttribute('aria-expanded', 'false');
        });
    });
}

/* ------------------------------------------------------------------ */
/* 3. Shortcut overrides editor                                        */
/* ------------------------------------------------------------------ */

const defaultShortcuts = [
    { Name: 'OpenSearch', Key: '/', Label: 'Open Search', Category: 'Global' },
    { Name: 'GoToHome', Key: 'Shift+H', Label: 'Go to Home', Category: 'Global' },
    { Name: 'GoToDashboard', Key: 'D', Label: 'Go to Dashboard', Category: 'Global' },
    { Name: 'QuickConnect', Key: 'Q', Label: 'Quick Connect', Category: 'Global' },
    { Name: 'PlayRandomItem', Key: 'R', Label: 'Play Random Item', Category: 'Global' },
    { Name: 'CycleAspectRatio', Key: 'A', Label: 'Cycle Aspect Ratio', Category: 'Player' },
    { Name: 'ShowPlaybackInfo', Key: 'I', Label: 'Show Playback Info', Category: 'Player' },
    { Name: 'SubtitleMenu', Key: 'S', Label: 'Subtitle Menu', Category: 'Player' },
    { Name: 'CycleSubtitleTracks', Key: 'C', Label: 'Cycle Subtitle Tracks', Category: 'Player' },
    { Name: 'CycleAudioTracks', Key: 'V', Label: 'Cycle Audio Tracks', Category: 'Player' },
    { Name: 'IncreasePlaybackSpeed', Key: '+', Label: 'Increase Playback Speed', Category: 'Player' },
    { Name: 'DecreasePlaybackSpeed', Key: '-', Label: 'Decrease Playback Speed', Category: 'Player' },
    { Name: 'ResetPlaybackSpeed', Key: 'R', Label: 'Reset Playback Speed', Category: 'Player' },
    { Name: 'BookmarkCurrentTime', Key: 'B', Label: 'Bookmark Current Time', Category: 'Player' },
    { Name: 'OpenEpisodePreview', Key: 'P', Label: 'Open Episode Preview', Category: 'Player' },
    { Name: 'SkipIntroOutro', Key: 'O', Label: 'Skip Intro/Outro', Category: 'Player' },
    { Name: 'FrameStepBack', Key: ',', Label: 'Step Back One Frame', Category: 'Player' },
    { Name: 'FrameStepForward', Key: '.', Label: 'Step Forward One Frame', Category: 'Player' },
    { Name: 'JumpToLastPosition', Key: 'Z', Label: 'Jump to Last Position', Category: 'Player' }
];

let shortcutOverrides = [];
let _shortcutErrorTimer = null;
let _shortcutShakeEl = null;

function renderShortcuts(config) {
    const savedShortcuts = (config && config.Shortcuts && config.Shortcuts.length > 0)
        ? config.Shortcuts
        : defaultShortcuts;
    shortcutOverrides = savedShortcuts
        .filter(saved => {
            const def = defaultShortcuts.find(d => d.Name === saved.Name);
            return !def || saved.Key !== def.Key;
        })
        .map(s => ({ Name: s.Name, Key: s.Key, Label: s.Label, Category: s.Category }));
    renderOverrides();
    populateAddShortcutDropdown();
}

function renderOverrides() {
    const container = document.querySelector('#shortcut-list-container');
    if (!container) return;
    if (!shortcutOverrides.length) {
        container.innerHTML = '<p class="fieldDescription">No overrides configured. All shortcuts are using default values.</p>';
        return;
    }
    container.textContent = '';
    shortcutOverrides.forEach((override, index) => {
        const row = document.createElement('div');
        row.className = 'jc-shortcut-override-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'jc-shortcut-override-label';
        labelEl.textContent = override.Label;
        const keyInput = document.createElement('input');
        keyInput.setAttribute('is', 'emby-input');
        keyInput.type = 'text';
        keyInput.className = 'emby-input';
        keyInput.value = override.Key;
        keyInput.addEventListener('input', () => {
            let v = keyInput.value;
            if (/^[a-z]$/.test(v)) {
                v = v.toUpperCase();
                keyInput.value = v;
            }
            shortcutOverrides[index].Key = v;
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.setAttribute('is', 'emby-button');
        removeBtn.className = 'raised button-cancel';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
            shortcutOverrides.splice(index, 1);
            jcMarkConfigDirty();
            renderOverrides();
            populateAddShortcutDropdown();
        });
        row.appendChild(labelEl);
        row.appendChild(keyInput);
        row.appendChild(removeBtn);
        container.appendChild(row);
    });
}

function populateAddShortcutDropdown() {
    const select = document.querySelector('#add-shortcut-select');
    if (!select) return;
    select.textContent = '';
    const remaining = defaultShortcuts.filter(def => !shortcutOverrides.some(o => o.Name === def.Name));
    remaining.forEach(def => {
        const opt = document.createElement('option');
        opt.value = def.Name;
        opt.textContent = def.Label;
        select.appendChild(opt);
    });
    const none = remaining.length === 0;
    const addBtn = document.querySelector('#add-shortcut-btn');
    const keyInput = document.querySelector('#add-shortcut-key');
    if (addBtn) addBtn.disabled = none;
    if (keyInput) keyInput.disabled = none;
}

function showValidationError(elementToShake, message) {
    const comment = document.querySelector('#shortcut-error-comment');
    if (_shortcutShakeEl) _shortcutShakeEl.classList.remove('shake');
    if (comment) {
        comment.textContent = message;
        comment.style.display = 'block';
    }
    if (elementToShake) elementToShake.classList.add('shake');
    _shortcutShakeEl = elementToShake || null;
    if (_shortcutErrorTimer) clearTimeout(_shortcutErrorTimer);
    _shortcutErrorTimer = setTimeout(() => {
        _shortcutErrorTimer = null;
        if (comment) {
            comment.textContent = '';
            comment.style.display = 'none';
        }
        if (_shortcutShakeEl) {
            _shortcutShakeEl.classList.remove('shake');
            _shortcutShakeEl = null;
        }
    }, 8000);
}

function wireShortcutsEditor() {
    const addBtn = document.querySelector('#add-shortcut-btn');
    const keyInput = document.querySelector('#add-shortcut-key');
    const select = document.querySelector('#add-shortcut-select');
    if (!addBtn || !keyInput || !select) return;
    keyInput.addEventListener('input', () => {
        const v = keyInput.value;
        if (/^[a-z]$/.test(v)) keyInput.value = v.toUpperCase();
    });
    addBtn.addEventListener('click', () => {
        const name = select.value;
        const key = (keyInput.value || '').trim();
        if (!name || !key) {
            showValidationError(addBtn, 'Please enter a key to use as an override.');
            return;
        }
        const existingOverride = shortcutOverrides.find(o => o.Key === key);
        if (existingOverride) {
            showValidationError(keyInput, "The key '" + key + "' is already assigned to '" + existingOverride.Label + "' as an override.");
            return;
        }
        const conflictingDefault = defaultShortcuts.find(d => d.Key === key && d.Name !== name);
        if (conflictingDefault) {
            showValidationError(keyInput, "The key '" + key + "' is already used by '" + conflictingDefault.Label + "'.");
            return;
        }
        const def = defaultShortcuts.find(d => d.Name === name);
        if (!def) return;
        shortcutOverrides.push({ Name: def.Name, Key: key, Label: def.Label, Category: def.Category });
        renderOverrides();
        populateAddShortcutDropdown();
        keyInput.value = '';
        // Parity quirk: no explicit jcMarkConfigDirty() here — typing into the
        // key input already marked dirty via the form capture listeners.
    });
}

function collectShortcuts() {
    const finalShortcuts = defaultShortcuts.map(def => ({
        Name: def.Name, Key: def.Key, Label: def.Label, Category: def.Category
    }));
    shortcutOverrides.forEach(override => {
        const idx = finalShortcuts.findIndex(s => s.Name === override.Name);
        if (idx !== -1) {
            finalShortcuts[idx] = {
                Name: override.Name, Key: override.Key, Label: override.Label, Category: override.Category
            };
        }
        // Unmatched overrides are dropped.
    });
    return finalShortcuts;
}

/* ------------------------------------------------------------------ */
/* 4. Maintenance-mode users                                           */
/* ------------------------------------------------------------------ */

function loadMaintenanceUsers() {
    const inner = document.querySelector('#jc-mm-users-inner');
    if (!inner) return Promise.resolve();
    return ApiClient.getJSON(ApiClient.getUrl('/JellyfinCanopy/MaintenanceMode/Users')).then(users => {
        inner.textContent = '';
        if (!users || !users.length) {
            inner.textContent = 'No non-admin users found.';
            return;
        }
        let preselect = [];
        const listEl = document.querySelector('#jc-mm-user-list');
        try {
            preselect = JSON.parse((listEl && listEl.dataset.preselect) || '[]');
        } catch (e) {
            preselect = [];
        }
        if (!Array.isArray(preselect)) preselect = [];
        const selectAll = preselect.length === 0;
        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
        grid.style.gap = '4px';
        users.forEach(user => {
            const id = user.id || user.Id || '';
            const name = user.username || user.Username || '';
            const label = document.createElement('label');
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.gap = '6px';
            label.style.cursor = 'pointer';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'jc-mm-user-cb';
            cb.value = id;
            cb.checked = selectAll || preselect.indexOf(id) !== -1;
            const avatar = document.createElement('span');
            avatar.style.width = '26px';
            avatar.style.height = '26px';
            avatar.style.borderRadius = '50%';
            avatar.style.overflow = 'hidden';
            avatar.style.display = 'inline-flex';
            avatar.style.alignItems = 'center';
            avatar.style.justifyContent = 'center';
            avatar.style.flexShrink = '0';
            const img = document.createElement('img');
            img.src = ApiClient.getUrl('/Users/' + id + '/Images/Primary', { width: 26 });
            img.alt = '';
            img.width = 26;
            img.height = 26;
            img.addEventListener('error', () => {
                avatar.textContent = (name || '?').charAt(0).toUpperCase();
            });
            avatar.appendChild(img);
            const nameSpan = document.createElement('span');
            nameSpan.textContent = name;
            label.appendChild(cb);
            label.appendChild(avatar);
            label.appendChild(nameSpan);
            grid.appendChild(label);
        });
        inner.appendChild(grid);
    }).catch(e => {
        console.warn('[JC] failed to load maintenance-mode users', e);
        inner.textContent = 'Failed to load users.';
    });
}

function setupMaintenanceModeControls() {
    document.querySelectorAll('input[name="maintenanceModeUsers"]').forEach(radio => {
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            const listEl = document.querySelector('#jc-mm-user-list');
            if (!listEl) return;
            if (radio.value === 'select') {
                listEl.style.display = '';
                loadMaintenanceUsers();
            } else {
                listEl.style.display = 'none';
            }
        });
    });
    const selectAllBtn = document.querySelector('#jc-mm-select-all');
    const deselectAllBtn = document.querySelector('#jc-mm-deselect-all');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            document.querySelectorAll('.jc-mm-user-cb').forEach(cb => { cb.checked = true; });
        });
    }
    if (deselectAllBtn) {
        deselectAllBtn.addEventListener('click', () => {
            document.querySelectorAll('.jc-mm-user-cb').forEach(cb => { cb.checked = false; });
        });
    }
}

/* ------------------------------------------------------------------ */
/* 5. Branding uploads                                                 */
/* ------------------------------------------------------------------ */

const BRANDING_SLOTS = [
    { key: 'iconTransparent', fileName: 'icon-transparent.png' },
    { key: 'favicon', fileName: 'favicon.ico' },
    { key: 'bannerLight', fileName: 'banner-light.png' },
    { key: 'bannerDark', fileName: 'banner-dark.png' },
    { key: 'touchicon', fileName: 'apple-touch-icon.png' }
];

let _brandingStatusTimers = {};

function brandingAuthHeaders() {
    const token = (ApiClient.accessToken && ApiClient.accessToken()) || '';
    return {
        // Both headers: Authorization for JF12, X-MediaBrowser-Token for 10.11 back-compat.
        'Authorization': 'MediaBrowser Token="' + token + '"',
        'X-MediaBrowser-Token': token
    };
}

function setBrandingStatus(slot, text, color) {
    const statusDiv = document.getElementById(slot.key + 'Status');
    if (!statusDiv) return;
    statusDiv.textContent = text;
    statusDiv.style.color = color || '';
}

function scheduleBrandingStatusClear(slot, ms) {
    if (_brandingStatusTimers[slot.key]) clearTimeout(_brandingStatusTimers[slot.key]);
    _brandingStatusTimers[slot.key] = setTimeout(() => {
        delete _brandingStatusTimers[slot.key];
        setBrandingStatus(slot, '');
    }, ms);
}

function uploadBrandingImage(slot, file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
        setBrandingStatus(slot, '✗ Only image files allowed', 'var(--jc-danger)');
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        setBrandingStatus(slot, '✗ File too large (max 10MB)', 'var(--jc-danger)');
        return;
    }
    // Local preview immediately.
    const preview = document.getElementById(slot.key + 'Preview');
    const placeholder = document.getElementById(slot.key + 'Placeholder');
    const dimensions = document.getElementById(slot.key + 'Dimensions');
    try {
        const localUrl = URL.createObjectURL(file);
        if (preview) {
            preview.src = localUrl;
            preview.style.display = '';
        }
        if (placeholder) placeholder.style.display = 'none';
        const probe = new Image();
        probe.onload = () => {
            if (dimensions) {
                dimensions.textContent = probe.naturalWidth + ' × ' + probe.naturalHeight + 'px';
                dimensions.style.display = '';
            }
            URL.revokeObjectURL(localUrl);
        };
        probe.onerror = () => URL.revokeObjectURL(localUrl);
        probe.src = localUrl;
    } catch (e) {
        console.warn('[JC] branding local preview failed', e);
    }
    setBrandingStatus(slot, 'Uploading...', 'var(--jc-warning)');
    const formData = new FormData();
    formData.append('file', file, slot.fileName); // renamed to the slot fileName
    formData.append('fileName', slot.fileName);
    fetch(ApiClient.getUrl('/JellyfinCanopy/UploadBrandingImage'), {
        method: 'POST',
        headers: brandingAuthHeaders(),
        body: formData
    }).then(response => {
        if (response.ok) {
            setBrandingStatus(slot, '✓ Uploaded', 'var(--jc-success)');
            refreshBrandingPreview(slot);
            scheduleBrandingStatusClear(slot, 3000);
            return;
        }
        return response.text().catch(() => '').then(text => {
            setBrandingStatus(slot, '✗ ' + (text || 'Upload failed'), 'var(--jc-danger)');
        });
    }).catch(e => {
        setBrandingStatus(slot, '✗ ' + ((e && e.message) || 'Upload error'), 'var(--jc-danger)');
    });
}

function refreshBrandingPreview(slot) {
    const preview = document.getElementById(slot.key + 'Preview');
    const placeholder = document.getElementById(slot.key + 'Placeholder');
    const deleteBtn = document.getElementById(slot.key + 'Delete');
    const dimensions = document.getElementById(slot.key + 'Dimensions');
    const showMissing = () => {
        if (preview) preview.style.display = 'none';
        if (placeholder) placeholder.style.display = '';
        if (deleteBtn) deleteBtn.style.display = 'none';
        if (dimensions) dimensions.style.display = 'none';
    };
    return fetch(ApiClient.getUrl('/JellyfinCanopy/BrandingImage?fileName=' + encodeURIComponent(slot.fileName) + '&t=' + Date.now()), {
        headers: brandingAuthHeaders()
    }).then(response => {
        if (!response.ok) {
            showMissing();
            return;
        }
        return response.blob().then(blob => {
            const url = URL.createObjectURL(blob);
            if (preview) {
                preview.onload = () => {
                    if (dimensions) {
                        dimensions.textContent = preview.naturalWidth + ' × ' + preview.naturalHeight + 'px';
                        dimensions.style.display = '';
                    }
                };
                preview.src = url;
                preview.style.display = '';
            }
            if (placeholder) placeholder.style.display = 'none';
            if (deleteBtn) deleteBtn.style.display = 'inline-block';
        });
    }).catch(() => showMissing());
}

function refreshBrandingPreviews() {
    BRANDING_SLOTS.forEach(slot => {
        try {
            refreshBrandingPreview(slot);
        } catch (e) {
            console.warn('[JC] branding preview refresh failed', e);
        }
    });
}

function deleteBrandingImage(slot) {
    setBrandingStatus(slot, 'Deleting...', 'var(--jc-warning)');
    const formData = new FormData();
    formData.append('fileName', slot.fileName);
    fetch(ApiClient.getUrl('/JellyfinCanopy/DeleteBrandingImage'), {
        method: 'POST',
        headers: brandingAuthHeaders(),
        body: formData
    }).then(response => {
        if (response.ok) {
            setBrandingStatus(slot, '✓ Deleted', 'var(--jc-success)');
            const dimensions = document.getElementById(slot.key + 'Dimensions');
            if (dimensions) dimensions.style.display = 'none';
            refreshBrandingPreview(slot);
            scheduleBrandingStatusClear(slot, 2000);
            return;
        }
        return response.text().catch(() => '').then(text => {
            setBrandingStatus(slot, '✗ ' + (text || 'Delete failed'), 'var(--jc-danger)');
        });
    }).catch(e => {
        setBrandingStatus(slot, '✗ ' + ((e && e.message) || 'Delete error'), 'var(--jc-danger)');
    });
}

function setupBrandingUploads() {
    BRANDING_SLOTS.forEach(slot => {
        const input = document.getElementById(slot.key + 'Input');
        const dropZone = document.getElementById(slot.key + 'DropZone');
        const statusDiv = document.getElementById(slot.key + 'Status');
        if (!input || !dropZone || !statusDiv) return; // skip slot if markup missing
        input.addEventListener('change', () => {
            if (input.files && input.files[0]) uploadBrandingImage(slot, input.files[0]);
        });
        const restoreDropZone = () => {
            dropZone.style.borderColor = 'color-mix(in srgb, var(--jc-accent) 50%, transparent)';
            dropZone.style.background = 'rgba(255,255,255,0.05)';
        };
        dropZone.addEventListener('dragover', evt => {
            evt.preventDefault();
            dropZone.style.borderColor = 'var(--jc-accent)';
            dropZone.style.background = 'color-mix(in srgb, var(--jc-accent) 10%, transparent)';
        });
        dropZone.addEventListener('dragleave', restoreDropZone);
        dropZone.addEventListener('drop', evt => {
            evt.preventDefault();
            restoreDropZone();
            const file = evt.dataTransfer && evt.dataTransfer.files && evt.dataTransfer.files[0];
            if (file) uploadBrandingImage(slot, file);
        });
        const deleteBtn = document.getElementById(slot.key + 'Delete');
        if (deleteBtn) deleteBtn.addEventListener('click', () => deleteBrandingImage(slot));
        refreshBrandingPreview(slot);
    });
}

/* ------------------------------------------------------------------ */
/* 6. Permission audit                                                 */
/* ------------------------------------------------------------------ */

function renderPermissionAudit(container, users) {
    container.textContent = '';
    const withIssues = users.filter(u => u.linked && u.issues && u.issues.length > 0);
    const ok = users.filter(u => u.linked && (!u.issues || u.issues.length === 0));
    const unlinked = users.filter(u => !u.linked);
    const allClean = withIssues.length === 0 && unlinked.length === 0;

    const summary = document.createElement('div');
    summary.className = 'jc-audit-summary';
    const title = document.createElement('div');
    title.className = 'jc-audit-summary-title';
    summary.appendChild(title);
    if (allClean) {
        title.textContent = '✅ All ' + ok.length + ' linked user(s) have the required permissions.';
    } else {
        title.textContent = 'Audit complete — review the users below.';
        const chips = document.createElement('div');
        chips.className = 'jc-audit-summary-chips';
        const addChip = (kind, icon, text) => {
            const chip = document.createElement('span');
            chip.className = 'jc-audit-chip jc-audit-chip-' + kind;
            const i = document.createElement('i');
            i.className = 'material-icons';
            i.setAttribute('aria-hidden', 'true');
            i.textContent = icon;
            chip.appendChild(i);
            chip.appendChild(document.createTextNode(text));
            chips.appendChild(chip);
        };
        if (withIssues.length) addChip('warn', 'warning', withIssues.length + ' with gaps');
        if (unlinked.length) addChip('unlinked', 'link_off', unlinked.length + ' not linked');
        if (ok.length) addChip('ok', 'check_circle', ok.length + ' OK');
        summary.appendChild(chips);
    }
    container.appendChild(summary);
    if (allClean) return;

    const cards = document.createElement('div');
    cards.className = 'jc-audit-cards';
    const addCard = (user, kind) => {
        const card = document.createElement('div');
        card.className = 'jc-audit-card ' + (kind === 'warn' ? 'jc-audit-card-warn' : 'jc-audit-card-unlinked');
        const header = document.createElement('div');
        header.className = 'jc-audit-card-header';
        const icon = document.createElement('i');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = kind === 'warn' ? 'person' : 'person_off';
        header.appendChild(icon);
        const name = document.createElement('span');
        name.className = 'jc-audit-card-name';
        name.textContent = user.jellyfinUsername || '';
        header.appendChild(name);
        const chip = document.createElement('span');
        chip.className = 'jc-audit-chip jc-audit-chip-' + (kind === 'warn' ? 'warn' : 'unlinked');
        chip.textContent = kind === 'warn' ? 'Permissions Missing' : 'Not linked';
        header.appendChild(chip);
        card.appendChild(header);
        if (user.issues && user.issues.length) {
            const ul = document.createElement('ul');
            ul.className = 'jc-audit-card-issues';
            user.issues.forEach(issue => {
                const li = document.createElement('li');
                li.textContent = issue;
                ul.appendChild(li);
            });
            card.appendChild(ul);
        }
        cards.appendChild(card);
    };
    withIssues.forEach(u => addCard(u, 'warn'));
    unlinked.forEach(u => addCard(u, 'unlinked'));
    container.appendChild(cards);

    if (ok.length) {
        const details = document.createElement('details');
        details.className = 'jc-audit-ok-section';
        const summaryEl = document.createElement('summary');
        summaryEl.textContent = 'Show ' + ok.length + ' user(s) with no issues';
        details.appendChild(summaryEl);
        const ul = document.createElement('ul');
        ul.className = 'jc-audit-ok-names';
        ok.forEach(u => {
            const li = document.createElement('li');
            li.textContent = u.jellyfinUsername || '';
            ul.appendChild(li);
        });
        details.appendChild(ul);
        container.appendChild(details);
    }
}

function wirePermissionAudit() {
    const btn = document.querySelector('#btnPermissionAudit');
    const result = document.querySelector('#permissionAuditResult');
    if (!btn || !result) return;
    // Resilient label setter (span or bare button text).
    const setLabel = text => {
        const span = btn.querySelector('span');
        if (span) span.textContent = text;
        else btn.textContent = text;
    };
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        setLabel('Running…');
        try {
            const users = await ApiClient.getJSON(ApiClient.getUrl('/JellyfinCanopy/seerr/permission-audit'));
            renderPermissionAudit(result, Array.isArray(users) ? users : []);
        } catch (err) {
            console.error('[JC] Permission ', err);
            result.textContent = '';
            const errDiv = document.createElement('div');
            errDiv.className = 'jc-audit-error';
            // createElement + textContent: server messages can't inject HTML.
            errDiv.textContent = 'Audit failed: ' + ((err && err.message) || 'Check server logs.');
            result.appendChild(errDiv);
        } finally {
            btn.disabled = false;
            setLabel('Run Audit');
        }
    });
}

/* ------------------------------------------------------------------ */
/* 7. Timing previews                                                  */
/* ------------------------------------------------------------------ */

let _activePanelPreviewCleanup = null;

function jcReadPreviewMs(input, fallback) {
    const v = parseInt(input && input.value, 10);
    if (!isFinite(v) || v < 200) return fallback;
    return Math.min(v, 120000);
}

function jcFmtSeconds(ms) {
    return (ms / 1000).toFixed(1) + 's';
}

function wireTimingPreviews() {
    const panelBtn = document.querySelector('#jcTestShortcutsPanel');
    const toastBtn = document.querySelector('#jcTestToast');

    if (panelBtn && !panelBtn.dataset.jcWired) {
        panelBtn.dataset.jcWired = 'true';
        panelBtn.addEventListener('click', () => {
            // A re-click fully disposes the previous preview (no leaked timers/listeners).
            if (_activePanelPreviewCleanup) _activePanelPreviewCleanup();
            const ms = jcReadPreviewMs(document.querySelector('#HelpPanelAutocloseDelay'), 15000);
            const overlay = document.createElement('div');
            overlay.className = 'jc-preview-panel-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'jc-preview-panel-title');
            const card = document.createElement('div');
            card.className = 'jc-preview-panel-card';
            const title = document.createElement('div');
            title.id = 'jc-preview-panel-title';
            title.className = 'jc-preview-panel-title';
            // Static markup only — the single sanctioned innerHTML use in this feature.
            title.innerHTML = '<i class="material-icons" aria-hidden="true">keyboard</i> Shortcuts Panel preview';
            const body = document.createElement('div');
            body.className = 'jc-preview-panel-body';
            const kbd = document.createElement('kbd');
            kbd.textContent = '?';
            const countdown = document.createElement('span');
            countdown.textContent = jcFmtSeconds(ms);
            body.appendChild(document.createTextNode('This is how long the real shortcuts/settings panel (opened with the '));
            body.appendChild(kbd);
            body.appendChild(document.createTextNode(' key in the main Jellyfin UI) will stay open without interaction. Auto-closes in '));
            body.appendChild(countdown);
            body.appendChild(document.createTextNode('.'));
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.setAttribute('is', 'emby-button');
            closeBtn.className = 'raised';
            closeBtn.textContent = 'Close now';
            card.appendChild(title);
            card.appendChild(body);
            card.appendChild(closeBtn);
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            try {
                closeBtn.focus();
            } catch (e) {
                // focus best-effort
            }
            const startedAt = Date.now();
            let interval = null;
            let timeout = null;
            let done = false;
            const onKeydown = evt => {
                if (evt.key === 'Escape') {
                    evt.stopPropagation();
                    cleanup();
                }
            };
            function cleanup() {
                if (done) return;
                done = true;
                if (interval) clearInterval(interval);
                if (timeout) clearTimeout(timeout);
                document.removeEventListener('keydown', onKeydown);
                overlay.remove();
                if (_activePanelPreviewCleanup === cleanup) _activePanelPreviewCleanup = null;
            }
            _activePanelPreviewCleanup = cleanup;
            interval = setInterval(() => {
                const remaining = Math.max(0, ms - (Date.now() - startedAt));
                countdown.textContent = jcFmtSeconds(remaining);
            }, 100);
            timeout = setTimeout(cleanup, ms);
            document.addEventListener('keydown', onKeydown);
            overlay.addEventListener('click', evt => {
                if (evt.target === overlay) cleanup();
            });
            closeBtn.addEventListener('click', cleanup);
        });
    }

    if (toastBtn && !toastBtn.dataset.jcWired) {
        toastBtn.dataset.jcWired = 'true';
        toastBtn.addEventListener('click', () => {
            document.querySelectorAll('.jc-preview-toast').forEach(prev => {
                if (prev._jeShowTimer) clearTimeout(prev._jeShowTimer);
                if (prev._jeHideTimer) clearTimeout(prev._jeHideTimer);
                if (prev._jeRemoveTimer) clearTimeout(prev._jeRemoveTimer);
                prev.remove();
            });
            const ms = jcReadPreviewMs(document.querySelector('#ToastDuration'), 3000);
            const toast = document.createElement('div');
            toast.className = 'jc-preview-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            toast.textContent = 'Example toast — disappears in ' + jcFmtSeconds(ms);
            document.body.appendChild(toast);
            // Mirrors real JC.toast timing.
            toast._jeShowTimer = setTimeout(() => toast.classList.add('jc-shown'), 10);
            toast._jeHideTimer = setTimeout(() => toast.classList.remove('jc-shown'), ms);
            toast._jeRemoveTimer = setTimeout(() => toast.remove(), ms + 350);
        });
    }
}

/* ------------------------------------------------------------------ */
/* 8. Order rows (quality categories + pages order)                    */
/* ------------------------------------------------------------------ */

let _qualityCatRenderOK = false;
let _pagesOrderRenderOK = false;

function refreshArrowRows(containerSel, rowClass, upClass, downClass) {
    const container = document.querySelector(containerSel);
    if (!container) return;
    const rows = Array.from(container.querySelectorAll('.' + rowClass));
    const setDisabled = (btn, disabled) => {
        if (!btn) return;
        btn.disabled = disabled;
        btn.style.opacity = disabled ? '.4' : '';
        btn.style.cursor = disabled ? 'not-allowed' : '';
    };
    rows.forEach((row, idx) => {
        setDisabled(row.querySelector('.' + upClass), idx === 0);
        setDisabled(row.querySelector('.' + downClass), idx === rows.length - 1);
    });
}

function refreshQualityCatAdminArrows() {
    refreshArrowRows('#qualityCategoriesAdmin', 'jc-quality-cat-admin-row', 'jc-cat-up', 'jc-cat-down');
}

function refreshPagesOrderAdminArrows() {
    refreshArrowRows('#pagesOrderAdmin', 'jc-pages-order-row', 'jc-page-up', 'jc-page-down');
}

function renderQualityCatOrderAdmin(config) {
    _qualityCatRenderOK = false;
    try {
        const container = document.querySelector('#qualityCategoriesAdmin');
        if (!container) return; // flag stays false -> save path skips *Order writes
        const rows = Array.from(container.querySelectorAll('.jc-quality-cat-admin-row'));
        const orderOf = row => {
            const saved = parseInt(config ? config[row.dataset.orderKey] : NaN, 10);
            return isFinite(saved) ? saved : parseInt(row.dataset.defaultOrder, 10);
        };
        rows.sort((a, b) => {
            const diff = orderOf(a) - orderOf(b);
            if (diff !== 0) return diff;
            return parseInt(a.dataset.defaultOrder, 10) - parseInt(b.dataset.defaultOrder, 10);
        });
        rows.forEach(row => container.appendChild(row));
        refreshQualityCatAdminArrows();
        _qualityCatRenderOK = true;
    } catch (err) {
        console.error('Jellyfin Canopy: renderQualityCatOrderAdmin failed; will skip *Order save', err);
    }
}

function renderPagesOrderAdmin(config) {
    _pagesOrderRenderOK = false;
    try {
        const container = document.querySelector('#pagesOrderAdmin');
        if (!container) return; // flag stays false -> save path skips PagesOrder write
        const rows = Array.from(container.querySelectorAll('.jc-pages-order-row'));
        const csv = String((config && config.PagesOrder) || '');
        const pos = {};
        csv.split(',').map(s => s.trim()).filter(Boolean).forEach((id, idx) => {
            if (!(id in pos)) pos[id] = idx; // unknown CSV ids simply never match a row
        });
        const domIndex = new Map();
        rows.forEach((row, idx) => domIndex.set(row, idx));
        const sorted = rows.slice().sort((a, b) => {
            const ai = (a.dataset.pageId in pos) ? pos[a.dataset.pageId] : Infinity;
            const bi = (b.dataset.pageId in pos) ? pos[b.dataset.pageId] : Infinity;
            if (ai !== bi) return ai - bi;
            return domIndex.get(a) - domIndex.get(b); // ids missing from CSV keep default DOM order, last
        });
        sorted.forEach(row => container.appendChild(row));
        refreshPagesOrderAdminArrows();
        _pagesOrderRenderOK = true;
    } catch (err) {
        console.error('Jellyfin Canopy: renderPagesOrderAdmin failed; will skip PagesOrder save', err);
    }
}

function renderOrderRows(config) {
    renderQualityCatOrderAdmin(config);
    renderPagesOrderAdmin(config);
}

function wireReorderList(containerSel, rowClass, upClass, downClass, refresh) {
    // Document-level delegated handler, registered once; survives SPA navigation.
    document.addEventListener('click', evt => {
        const target = evt.target;
        if (!target || !target.closest) return;
        const btn = target.closest(containerSel + ' .' + upClass + ', ' + containerSel + ' .' + downClass);
        if (!btn || btn.disabled) return;
        const row = btn.closest('.' + rowClass);
        if (!row || !row.parentNode) return;
        if (btn.classList.contains(upClass)) {
            const prev = row.previousElementSibling;
            if (prev && prev.classList.contains(rowClass)) row.parentNode.insertBefore(row, prev);
        } else {
            const next = row.nextElementSibling;
            if (next && next.classList.contains(rowClass)) row.parentNode.insertBefore(next, row);
        }
        refresh();
        jcMarkConfigDirty();
    });
}

function wireOrderRowArrows() {
    wireReorderList('#qualityCategoriesAdmin', 'jc-quality-cat-admin-row', 'jc-cat-up', 'jc-cat-down', refreshQualityCatAdminArrows);
    wireReorderList('#pagesOrderAdmin', 'jc-pages-order-row', 'jc-page-up', 'jc-page-down', refreshPagesOrderAdminArrows);
}

/* ------------------------------------------------------------------ */
/* 9. Blocked users & Seerr user import                                */
/* ------------------------------------------------------------------ */

let _blockedUsersLoaded = false;

function jcNormalizeUserId(id) {
    return String(id || '').replace(/-/g, '').toLowerCase();
}

function updateBlockedUsersCount() {
    const badge = document.querySelector('#blockedUsersCount');
    if (!badge) return;
    const n = document.querySelectorAll('.blockedUserCheckbox:checked').length;
    badge.textContent = n > 0 ? '(' + n + ' blocked)' : '(none)';
}

function updateBlockedUsersScrollHint() {
    const container = document.querySelector('#blockedUsersContainer');
    const hint = document.querySelector('#blockedUsersScrollHint');
    if (!container || !hint) return;
    const overflows = container.scrollHeight > container.clientHeight + 4;
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    hint.style.display = (overflows && !atBottom) ? '' : 'none';
}

function loadBlockedUsersList(blockedIdsString) {
    const container = document.querySelector('#blockedUsersContainer');
    if (!container) return Promise.resolve();
    _blockedUsersLoaded = false;
    const blocked = new Set(String(blockedIdsString || '')
        .split(/[,\r\n]+/)
        .map(jcNormalizeUserId)
        .filter(Boolean));
    return ApiClient.getUsers().then(users => {
        container.textContent = '';
        users.slice()
            .sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || '')))
            .forEach(user => {
                const normalized = jcNormalizeUserId(user.Id);
                const label = document.createElement('label');
                label.className = 'emby-checkbox-label';
                const cb = document.createElement('input');
                cb.setAttribute('is', 'emby-checkbox');
                cb.type = 'checkbox';
                cb.className = 'blockedUserCheckbox';
                cb.dataset.userid = normalized;
                cb.checked = blocked.has(normalized);
                cb.addEventListener('change', updateBlockedUsersCount);
                const span = document.createElement('span');
                span.className = 'checkboxLabel';
                span.textContent = user.Name || '';
                label.appendChild(cb);
                label.appendChild(span);
                container.appendChild(label);
            });
        _blockedUsersLoaded = true;
        updateBlockedUsersCount();
        requestAnimationFrame(updateBlockedUsersScrollHint);
        if (!container.dataset.jcScrollWired) {
            container.dataset.jcScrollWired = 'true';
            container.addEventListener('scroll', updateBlockedUsersScrollHint);
        }
    }).catch(e => {
        console.warn('[JC] failed to load users for blocklist', e);
        container.textContent = 'Could not load users.';
        _blockedUsersLoaded = false;
    });
}

function syncBlockedUsersToHiddenInput() {
    if (!_blockedUsersLoaded) {
        // Never wipe the stored blocklist when the list never rendered.
        console.warn('Jellyfin Canopy: skipping blocklist sync — user list failed to load. Existing config preserved.');
        return;
    }
    const hidden = document.querySelector('#seerrImportBlockedUsers');
    if (!hidden) return;
    hidden.value = Array.from(document.querySelectorAll('.blockedUserCheckbox:checked'))
        .map(cb => cb.dataset.userid)
        .filter(Boolean)
        .join(',');
}

function wireImportSeerrUsers() {
    const btn = document.querySelector('#btnImportSeerrUsers');
    if (!btn) return;
    const result = document.querySelector('#importUsersResult');
    const setLabel = text => {
        const span = btn.querySelector('span');
        if (span) span.textContent = text;
        else btn.textContent = text;
    };
    const renderErrorList = errors => {
        const ul = document.createElement('ul');
        ul.style.color = 'var(--jc-danger)';
        errors.forEach(msg => {
            const li = document.createElement('li');
            li.textContent = String(msg);
            ul.appendChild(li);
        });
        return ul;
    };
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        setLabel('Saving config...');
        try {
            // Server must see the current blocklist before importing.
            // saveConfig never rejects; it reports failure via its return value.
            const preImportSaved = await saveConfig(new Event('submit'));
            if (preImportSaved === false) {
                if (result) {
                    result.textContent = 'Could not save config. Import was not attempted.';
                    result.style.color = 'var(--jc-danger)';
                }
                return;
            }
            setLabel('Importing...');
            const response = await ApiClient.fetch({
                // NOTE: missing leading slash preserved verbatim (contract endpoint #22).
                url: ApiClient.getUrl('JellyfinCanopy/seerr/import-users'),
                type: 'POST',
                dataType: 'json'
            });
            let payload = response;
            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch (e) {
                    payload = {};
                }
            }
            if (payload && payload.data && typeof payload.data === 'object') payload = payload.data;
            const imported = (payload && payload.usersImported != null) ? payload.usersImported : 0;
            const total = (payload && payload.totalUsers != null) ? payload.totalUsers : 0;
            const errors = (payload && Array.isArray(payload.errors)) ? payload.errors : [];
            if (result) {
                result.textContent = '';
                result.style.color = '';
                const line = document.createElement('div');
                line.textContent = 'Imported ' + imported + ' new user(s) out of ' + total + ' total.';
                line.style.color = errors.length ? 'var(--jc-warning)' : 'var(--jc-success)';
                result.appendChild(line);
                if (errors.length) result.appendChild(renderErrorList(errors));
            }
        } catch (e) {
            console.warn('[JC] Seerr user import failed', e);
            if (result) {
                result.textContent = '';
                result.style.color = '';
                const line = document.createElement('div');
                line.textContent = 'Import failed. Check Seerr configuration and API key permissions.';
                line.style.color = 'var(--jc-danger)';
                result.appendChild(line);
                const errs = (e && e.responseJSON && Array.isArray(e.responseJSON.errors)) ? e.responseJSON.errors : [];
                if (errs.length) result.appendChild(renderErrorList(errs));
            }
        } finally {
            btn.disabled = false;
            setLabel('Import Users Now');
        }
    });
}

/* ------------------------------------------------------------------ */
/* 10. Language options                                                */
/* ------------------------------------------------------------------ */

function loadLanguageOptions() {
    const select = document.querySelector('#DefaultLanguage');
    if (!select) return Promise.resolve();
    const CUSTOM_DISPLAY_NAMES = {
        'pr': 'Pirate',
        'en-GB': 'English (United Kingdom)',
        'en-US': 'English (United States)',
        'zh-CN': 'Chinese (Simplified)',
        'zh-HK': 'Chinese (Hong Kong)',
        'pt-BR': 'Portuguese (Brazil)'
    };
    return Promise.all([
        ApiClient.getJSON(ApiClient.getUrl('/JellyfinCanopy/locales')),
        ApiClient.getJSON(ApiClient.getUrl('/Localization/Cultures'))
    ]).then(results => {
        const locales = results[0];
        const cultures = results[1];
        const codes = (Array.isArray(locales) ? locales : [])
            .map(l => (typeof l === 'string' ? l : (l && (l.code || l.Code)) || ''))
            .filter(Boolean);
        const codeSet = new Set(codes);
        const cultureByTwoLetter = {};
        (Array.isArray(cultures) ? cultures : []).forEach(c => {
            if (c && c.TwoLetterISOLanguageName && !cultureByTwoLetter[c.TwoLetterISOLanguageName]) {
                cultureByTwoLetter[c.TwoLetterISOLanguageName] = c.DisplayName;
            }
        });
        const displayName = code => {
            if (CUSTOM_DISPLAY_NAMES[code]) return CUSTOM_DISPLAY_NAMES[code];
            const direct = cultureByTwoLetter[code];
            if (direct) return direct;
            const dash = code.indexOf('-');
            if (dash > 0) {
                const base = code.slice(0, dash);
                const region = code.slice(dash + 1);
                const baseName = CUSTOM_DISPLAY_NAMES[base] || cultureByTwoLetter[base];
                // Regional format only when the base code is itself a shipped locale.
                if (baseName && codeSet.has(base)) return baseName + ' (' + region + ')';
            }
            return code;
        };
        // Generic 'en' stays the fallback catalog; regional variants are selectable.
        codes.filter(code => code !== 'en')
            .map(code => ({ code: code, name: displayName(code) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(entry => {
                const opt = document.createElement('option');
                opt.value = entry.code;
                opt.textContent = entry.name;
                select.appendChild(opt);
            });
    }).catch(err => {
        // Select keeps whatever static options the HTML has.
        console.warn('Jellyfin Canopy: Failed to load language options:', err);
    });
}

/* ------------------------------------------------------------------ */
/* 11. Smart client refresh                                            */
/* ------------------------------------------------------------------ */

function wireClientRefresh() {
    const btn = document.querySelector('#forceClientRefreshBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const ok = confirm('Refresh all open Canopy clients?\n\nClients will reload at their next safe point. Active or paused playback is never interrupted.');
        if (!ok) return;
        const status = document.querySelector('#forceClientRefreshStatus');
        btn.disabled = true;
        if (status) status.textContent = 'Sending refresh signal…';
        try {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl('/JellyfinCanopy/client-refresh'),
                dataType: 'json'
            });
            if (status) status.textContent = 'Refresh signal sent. Visible clients will react within their configured check interval; background clients will react when reopened.';
        } catch (e) {
            console.error('[JC] client refresh signal failed', e);
            if (status) status.textContent = 'Could not send the refresh signal. Check the server logs and try again.';
        } finally {
            btn.disabled = false;
        }
    });
}

/* ------------------------------------------------------------------ */
/* 12. Sticky header scroll shadow                                     */
/* ------------------------------------------------------------------ */

function wireStickyHeader() {
    const header = document.querySelector('.jc-sticky-header');
    if (!header) return;
    // The actual scroller is ambiguous (page wrapper, body, window) — collect ALL
    // ancestors with computed overflow-y auto|scroll as candidates plus window.
    const candidates = [];
    let node = header.parentElement;
    while (node) {
        try {
            const overflowY = getComputedStyle(node).overflowY;
            if (overflowY === 'auto' || overflowY === 'scroll') candidates.push(node);
        } catch (e) {
            // unstylable node — skip
        }
        node = node.parentElement;
    }
    if (!candidates.length) {
        console.warn('[JC] sticky-header: no overflow:auto|scroll ancestors found; relying on window scroll only.');
    }
    let ticking = false;
    const readScroll = () => {
        try {
            let max = window.scrollY || document.documentElement.scrollTop || 0;
            candidates.forEach(el => {
                // Detached nodes freeze at their last value — skip them.
                if (!el.isConnected) return;
                if (el.scrollTop > max) max = el.scrollTop;
            });
            header.classList.toggle('jc-is-scrolled', max > 4);
        } catch (e) {
            console.warn('[JC] sticky-header read failed:', e);
        } finally {
            // Reset in finally so a throwing read can't wedge the rAF pipeline.
            ticking = false;
        }
    };
    const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(readScroll);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    candidates.forEach(el => el.addEventListener('scroll', onScroll, { passive: true }));
    onScroll(); // initial read at wire time
}

/* ------------------------------------------------------------------ */
/* 13. Auto-movie custom quality pickers                               */
/* ------------------------------------------------------------------ */

let _autoMovieServerListenerAdded = false;

function resetSelectWithMessage(select, value, message) {
    if (!select) return;
    select.textContent = '';
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = message;
    select.appendChild(opt);
    select.value = value;
}

function loadAutoMovieRadarrServers(savedConfig) {
    const serverSelect = document.querySelector('#autoMovieRequestServer');
    if (!serverSelect) return Promise.resolve();
    resetSelectWithMessage(serverSelect, '-1', 'Loading...');
    return ApiClient.getJSON(ApiClient.getUrl('/JellyfinCanopy/seerr/radarr')).then(servers => {
        resetSelectWithMessage(serverSelect, '-1', 'Select Server...');
        (Array.isArray(servers) ? servers : []).forEach(server => {
            if (!server || !isFinite(parseInt(server.id, 10))) return; // numeric ids only
            const opt = document.createElement('option');
            opt.value = String(server.id);
            opt.textContent = server.name || ('Server ' + server.id);
            serverSelect.appendChild(opt);
        });
        if (savedConfig && typeof savedConfig.AutoMovieRequestCustomServerId === 'number'
            && savedConfig.AutoMovieRequestCustomServerId >= 0) {
            serverSelect.value = String(savedConfig.AutoMovieRequestCustomServerId);
            loadAutoMovieServerDetails(savedConfig.AutoMovieRequestCustomServerId, savedConfig);
        }
        if (!_autoMovieServerListenerAdded) {
            _autoMovieServerListenerAdded = true;
            serverSelect.addEventListener('change', () => {
                const id = parseInt(serverSelect.value, 10);
                if (!isNaN(id) && id >= 0) {
                    loadAutoMovieServerDetails(id);
                } else {
                    resetSelectWithMessage(document.querySelector('#autoMovieRequestProfile'), '0', 'Select a server first...');
                    resetSelectWithMessage(document.querySelector('#autoMovieRequestRootFolder'), '', 'Select a server first...');
                }
            });
        }
    }).catch(err => {
        resetSelectWithMessage(serverSelect, '-1', 'Failed to load servers');
        console.warn('[Auto-Movie-Request] Failed to load Radarr servers:', err);
    });
}

function loadAutoMovieServerDetails(serverId, savedConfig) {
    const profileSelect = document.querySelector('#autoMovieRequestProfile');
    const folderSelect = document.querySelector('#autoMovieRequestRootFolder');
    resetSelectWithMessage(profileSelect, '0', 'Loading...');
    resetSelectWithMessage(folderSelect, '', 'Loading...');
    return ApiClient.getJSON(ApiClient.getUrl('/JellyfinCanopy/seerr/radarr/' + serverId)).then(details => {
        resetSelectWithMessage(profileSelect, '0', 'Select Profile...');
        ((details && details.profiles) || []).forEach(p => {
            const opt = document.createElement('option');
            opt.value = String(p.id);
            opt.textContent = p.name || String(p.id);
            if (profileSelect) profileSelect.appendChild(opt);
        });
        resetSelectWithMessage(folderSelect, '', 'Select Folder...');
        ((details && details.rootFolders) || []).forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.path || '';
            opt.textContent = f.path || '';
            if (folderSelect) folderSelect.appendChild(opt);
        });
        if (savedConfig) {
            if (typeof savedConfig.AutoMovieRequestCustomProfileId === 'number'
                && savedConfig.AutoMovieRequestCustomProfileId > 0 && profileSelect) {
                profileSelect.value = String(savedConfig.AutoMovieRequestCustomProfileId);
            }
            if (savedConfig.AutoMovieRequestCustomRootFolder && folderSelect) {
                folderSelect.value = savedConfig.AutoMovieRequestCustomRootFolder;
            }
        }
    }).catch(err => {
        resetSelectWithMessage(profileSelect, '0', 'Failed to load');
        resetSelectWithMessage(folderSelect, '', 'Failed to load');
        console.warn('[Auto-Movie-Request] Failed to load Radarr server details:', err);
    });
}

function initAutoMovieQualityMode() {
    const modeSelect = document.querySelector('#autoMovieRequestQualityMode');
    const customSettings = document.querySelector('#autoMovieRequestCustomSettings');
    if (!modeSelect || !customSettings) return;
    modeSelect.addEventListener('change', () => {
        const custom = modeSelect.value === 'custom';
        customSettings.style.display = custom ? 'block' : 'none';
        if (custom) loadAutoMovieRadarrServers();
    });
}

function populateAutoMovieRequestSelects(config) {
    const customSettings = document.querySelector('#autoMovieRequestCustomSettings');
    const custom = ((config && config.AutoMovieRequestQualityMode) || 'default') === 'custom';
    if (customSettings) customSettings.style.display = custom ? 'block' : 'none';
    if (custom) loadAutoMovieRadarrServers(config);
}

/* ------------------------------------------------------------------ */
/* 14. Custom plugin links tester                                      */
/* ------------------------------------------------------------------ */

function wireCustomPluginLinksTester() {
    const btn = document.querySelector('#testCustomPluginLinksBtn');
    const textarea = document.querySelector('#customPluginLinks');
    if (!btn || !textarea) return;
    btn.addEventListener('click', () => {
        const raw = (textarea.value || '').trim();
        if (!raw) {
            Dashboard.alert({ title: 'No Links', message: 'Please add some custom plugin links first.' });
            return;
        }
        const validLinks = [];
        const invalidLines = [];
        raw.split('\n').forEach((line, idx) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const parts = trimmed.split('|').map(p => p.trim());
            if (parts.length >= 2 && parts[0] && parts[1]) {
                validLinks.push({ name: parts[0], icon: parts[1] });
            } else {
                invalidLines.push('Line ' + (idx + 1) + ': "' + trimmed + '"');
            }
        });
        if (invalidLines.length) {
            Dashboard.alert({
                title: 'Invalid Format',
                message: invalidLines.join('\n') + '\n\nPlease use the format: Configuration Page Name | icon_name'
            });
        }
        if (!validLinks.length) {
            Dashboard.alert({ title: 'No Valid Links', message: 'No valid links found.' });
            return;
        }
        // Silently no-ops when the client runtime isn't present.
        if (window.JellyfinCanopy && window.JellyfinCanopy.customPlugins) {
            window.testCustomPluginLinks = validLinks;
            window.JellyfinCanopy.customPlugins.refresh();
        }
    });
}

/* ------------------------------------------------------------------ */
/* 15. Copy-to-clipboard buttons                                       */
/* ------------------------------------------------------------------ */

function jcFallbackCopy(text, onSuccess) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        if (ok) onSuccess();
        else alert('Failed to copy to clipboard');
    } catch (e) {
        alert('Failed to copy to clipboard');
    }
}

function wireCopyButtons() {
    document.querySelectorAll('.jc-copy-html-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const text = btn.dataset.copyText || '';
            const showCopied = () => {
                const label = btn.querySelector('.copy-btn-text');
                if (label) label.textContent = 'Copied!';
                btn.style.color = 'var(--jc-success)';
                if (btn._jcCopyTimer) clearTimeout(btn._jcCopyTimer);
                btn._jcCopyTimer = setTimeout(() => {
                    btn._jcCopyTimer = null;
                    if (label) label.textContent = 'Copy';
                    btn.style.color = '';
                }, 2000);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(showCopied).catch(() => jcFallbackCopy(text, showCopied));
            } else {
                jcFallbackCopy(text, showCopied);
            }
        });
    });
}

/* ------------------------------------------------------------------ */
/* wireWidgets — single entry point, called ONCE by the integrator     */
/* ------------------------------------------------------------------ */

function wireWidgets() {
    const wire = (name, fn) => {
        try {
            fn();
        } catch (e) {
            console.warn('[JC] wireWidgets: ' + name + ' failed', e);
        }
    };
    wire('descriptions-toggle', wireDescriptionsToggle);
    wire('shortcuts-editor', wireShortcutsEditor);
    wire('order-row-arrows', wireOrderRowArrows);
    wire('branding-uploads', setupBrandingUploads);
    wire('maintenance-mode-controls', setupMaintenanceModeControls);
    wire('client-refresh', wireClientRefresh);
    wire('auto-movie-quality-mode', initAutoMovieQualityMode);
    wire('requests-banner-reactive', wireRequestsBannerReactive);
    wire('sticky-header', wireStickyHeader);
    wire('gated-help', wireGatedHelp);
    wire('reactive-deps', wireReactiveDeps);
    wire('import-seerr-users', wireImportSeerrUsers);
    wire('permission-audit', wirePermissionAudit);
    wire('timing-previews', wireTimingPreviews);
    wire('collapsible-banners', wireCollapsibleBanners);
    wire('custom-plugin-links-tester', wireCustomPluginLinksTester);
    wire('copy-buttons', wireCopyButtons);
}

/* SECTION: binder + save/load pipeline — owns: configBoundFields,
   applyConfigToBoundFields, CONFIG_FIELD_OVERRIDES, readBoundFieldsIntoConfig,
   buildConfigFromForm, saveArrInstances, loadConfig, saveConfig,
   wireCoreBindings, _jeSaveInFlight, _jcWizardShown.
   depends: collectShortcuts/renderShortcuts/renderOrderRows/
   loadMaintenanceUsers/populateAutoMovieRequestSelects/loadBlockedUsersList/
   syncBlockedUsersToHiddenInput/_qualityCatRenderOK/_pagesOrderRenderOK
   (widgets), collectInstancesFromDom/renderArrInstances/_arrParseOK +
   jcNormalizeMaintainerrBaseUrl/jcValidateMaintainerrMappings (connections),
   checkInstalledPlugins/renderServiceStatusDashboard/renderFeaturesDashboard
   (dashboards), updateAllDependencies/updateRequestsRequirementsBanner
   (widgets), jcSyncEssentialsMirrors/jcOpenWizard (view-mode section). */

function configBoundFields() {
    return Array.from(document.querySelectorAll('[data-config-key]'));
}

/* Per-field load/save clamps. The exact fallback and clamp semantics are a
   payload contract; keep numbers and NaN behavior identical. */
const CONFIG_FIELD_OVERRIDES = {
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
        load: function (el, v) {
            el.value = (v !== undefined && v !== null) ? v : 30;
        },
        save: function (el) {
            const pollInterval = parseInt(el.value, 10);
            return pollInterval >= 30 ? pollInterval : 30;
        }
    },
    DownloadsHistoryWindowDays: {
        load: function (el, v) {
            var value = parseInt(v, 10);
            el.value = isNaN(value) ? 7 : Math.min(30, Math.max(1, value));
        },
        save: function (el) {
            var value = parseInt(el.value, 10);
            return isNaN(value) ? 7 : Math.min(30, Math.max(1, value));
        }
    },
    ClientRefreshPollSeconds: {
        load: function (el, v) {
            el.value = (v !== undefined && v !== null) ? v : 30;
        },
        save: function (el) {
            const value = parseInt(el.value, 10);
            return isNaN(value) ? 30 : Math.min(3600, Math.max(5, value));
        }
    },
    ClientRefreshIdleSeconds: {
        load: function (el, v) {
            el.value = (v !== undefined && v !== null) ? v : 5;
        },
        save: function (el) {
            const value = parseInt(el.value, 10);
            return isNaN(value) ? 5 : Math.min(300, Math.max(0, value));
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

/* ---------------------------------------------------------------------------
   Form → config assembly. Re-fetch-then-overlay: start from the server's
   current state so unknown keys survive, then overlay the form.
   --------------------------------------------------------------------------- */
async function buildConfigFromForm() {
    const config = await ApiClient.getPluginConfiguration(pluginId);

    config.Shortcuts = collectShortcuts();
    readBoundFieldsIntoConfig(config);

    const mmAccounts = !!(document.querySelector('#mmAction_accounts') || {}).checked;
    const mmRemote = !!(document.querySelector('#mmAction_remote') || {}).checked;
    config.MaintenanceModeAction = (mmAccounts && mmRemote) ? 'both'
                                 : mmRemote                 ? 'disable_remote'
                                 :                            'disable_accounts';
    const mmUsersMode = (document.querySelector('input[name="maintenanceModeUsers"]:checked') || {}).value || 'all';
    if (mmUsersMode === 'all') {
        config.MaintenanceModeAffectedUsers = 'all';
    } else {
        const checked = Array.from(document.querySelectorAll('.jc-mm-user-cb:checked')).map(cb => cb.value);
        config.MaintenanceModeAffectedUsers = JSON.stringify(checked);
    }

    if (_qualityCatRenderOK) {
        const adminCatRows = document.querySelectorAll('#qualityCategoriesAdmin .jc-quality-cat-admin-row');
        adminCatRows.forEach((row, idx) => {
            const orderKey = row.dataset.orderKey;
            if (orderKey) config[orderKey] = idx + 1;
        });
    }
    if (_pagesOrderRenderOK) {
        var pageOrderRows = document.querySelectorAll('#pagesOrderAdmin .jc-pages-order-row');
        config.PagesOrder = Array.from(pageOrderRows).map(function (r) { return r.dataset.pageId; }).filter(Boolean).join(',');
    }

    config.EnableTagsLocalStorageFallback = config.TagCacheServerMode
        ? document.querySelector('#enableTagsLocalStorageFallback').checked
        : true;

    (function validateSeerrUrls() {
        const lines = (document.querySelector('#seerrUrls').value || '')
            .split('\n').map(u => u.trim()).filter(Boolean);
        const valid = [];
        const invalid = [];
        lines.forEach(function (line) {
            try {
                const parsed = new URL(line);
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') { valid.push(line); return; }
            } catch (e) { /* fall through to invalid */ }
            invalid.push(line);
        });
        if (invalid.length) {
            console.warn('Jellyfin Canopy: dropping invalid Seerr URL(s) on save (must start with http:// or https://):', invalid);
            Dashboard.alert({
                title: 'Invalid Seerr URL(s)',
                message: 'These lines were dropped because they do not start with http:// or https://:\n\n' + invalid.join('\n'),
            });
        }
        config.SeerrUrls = valid.join('\n');
    })();

    (function validateSeerrExternalUrl() {
        const raw = (document.querySelector('#seerrExternalUrl').value || '').trim();
        if (raw && !jcIsHttpUrl(raw)) {
            console.warn('Jellyfin Canopy: dropping invalid Seerr External URL on save:', raw);
            Dashboard.alert({
                title: 'Invalid Seerr External URL',
                message: 'The browser URL must be an absolute http(s) URL without credentials, query, or fragment. It was cleared.',
            });
            config.SeerrExternalUrl = '';
        } else {
            config.SeerrExternalUrl = raw;
        }
    })();

    config.SeerrApiKey = (document.querySelector('#SeerrApiKey').value || '').replace(/\s/g, '');
    config.SeerrUrlMappings = (document.querySelector('#seerrUrlMappings').value || '')
        .split('\n').map(u => u.trim()).filter(Boolean).join('\n');

    (function validateMaintainerrConfig() {
        const problems = [];
        const internalRaw = String(config.MaintainerrUrl || '').trim();
        const internalNorm = jcNormalizeMaintainerrBaseUrl(internalRaw);
        if (internalRaw && !internalNorm) problems.push('the internal URL');
        config.MaintainerrUrl = internalNorm;
        const externalRaw = String(config.MaintainerrExternalUrl || '').trim();
        const externalNorm = jcNormalizeMaintainerrBaseUrl(externalRaw);
        if (externalRaw && !externalNorm) problems.push('the browser URL');
        config.MaintainerrExternalUrl = externalNorm;
        var mappingResult = jcValidateMaintainerrMappings(String(config.MaintainerrUrlMappings || ''));
        config.MaintainerrUrlMappings = mappingResult.value;
        if (mappingResult.issues && mappingResult.issues.length) {
            problems.push(mappingResult.issues.length + ' mapping validation issue(s)');
        }
        if (problems.length) {
            Dashboard.alert({
                title: 'Invalid Maintainerr URL configuration',
                message: 'Dropped ' + problems.join(', ') + '. Maintainerr URLs are limited to 2048 characters and must be HTTP(S) bases without credentials, query, fragment, or traversal. Mappings are limited to 64 KiB and 32 nonempty rows.',
            });
        }
    })();

    (function validateBazarrExternalUrl() {
        const raw = String(config.BazarrExternalUrl || '').trim();
        if (raw && !jcIsHttpUrl(raw)) {
            console.warn('Jellyfin Canopy: dropping invalid Bazarr External URL on save:', raw);
            Dashboard.alert({
                title: 'Invalid Bazarr External URL',
                message: 'The browser URL must be an absolute http(s) URL without credentials, query, or fragment. It was cleared.',
            });
            config.BazarrExternalUrl = '';
        } else {
            config.BazarrExternalUrl = raw;
        }
    })();

    config.TMDB_API_KEY = document.querySelector('#seerr_TMDB_API_KEY').value;

    const onStart = document.querySelector('#autoMovieRequestTriggerOnStart').checked;
    const onMinutes = document.querySelector('#autoMovieRequestTriggerOnMinutesWatched').checked;
    if (onStart && onMinutes)      config.AutoMovieRequestTriggerType = 'Both';
    else if (onStart)              config.AutoMovieRequestTriggerType = 'OnStart';
    else if (onMinutes)            config.AutoMovieRequestTriggerType = 'OnMinutesWatched';
    else                           config.AutoMovieRequestTriggerType = 'OnMinutesWatched';

    var serverVal = parseInt(document.querySelector('#autoMovieRequestServer').value);
    config.AutoMovieRequestCustomServerId = (!isNaN(serverVal) && serverVal >= 0) ? serverVal : -1;
    var profileVal = parseInt(document.querySelector('#autoMovieRequestProfile').value);
    config.AutoMovieRequestCustomProfileId = (!isNaN(profileVal) && profileVal > 0) ? profileVal : 0;
    config.AutoMovieRequestCustomRootFolder = document.querySelector('#autoMovieRequestRootFolder').value || '';

    syncBlockedUsersToHiddenInput();
    config.SeerrImportBlockedUsers = document.querySelector('#seerrImportBlockedUsers').value || '';

    var arrIncompleteWarnings = saveArrInstances(config);
    arrIncompleteWarnings.forEach(function (msg) {
        Dashboard.alert({ title: '⚠ Incomplete *arr instance', message: msg });
    });

    if (config.MetadataIconsEnabled) {
        config.ShowLetterboxdLinkAsText = false;
        config.ShowArrLinksAsText = false;
    }

    return config;
}

/* Writes the instance JSON plus the legacy first-instance mirror fields, but
   only when the load-time parse succeeded (never clobber over a corrupt
   read). Returns human-readable warning strings. */
function saveArrInstances(config) {
    const warnings = [];
    [['sonarr', 'Sonarr'], ['radarr', 'Radarr']].forEach(function (pair) {
        const type = pair[0];
        const typeName = pair[1];
        if (!_arrParseOK[type]) return;
        const collected = collectInstancesFromDom('#' + type + 'InstancesList .arr-instance-card', typeName);
        buildArrInstanceWarnings(typeName, collected).forEach(function (w) { warnings.push(w); });
        const instances = collected.instances;
        if (type === 'sonarr') {
            config.SonarrInstances = JSON.stringify(instances);
            if (instances.length > 0) {
                config.SonarrUrl = instances[0].Url;
                config.SonarrExternalUrl = instances[0].ExternalUrl || '';
                config.SonarrApiKey = instances[0].ApiKey;
                config.SonarrUrlMappings = instances[0].UrlMappings;
            } else {
                config.SonarrUrl = '';
                config.SonarrExternalUrl = '';
                config.SonarrApiKey = '';
                config.SonarrUrlMappings = '';
            }
        } else {
            config.RadarrInstances = JSON.stringify(instances);
            if (instances.length > 0) {
                config.RadarrUrl = instances[0].Url;
                config.RadarrExternalUrl = instances[0].ExternalUrl || '';
                config.RadarrApiKey = instances[0].ApiKey;
                config.RadarrUrlMappings = instances[0].UrlMappings;
            } else {
                config.RadarrUrl = '';
                config.RadarrExternalUrl = '';
                config.RadarrApiKey = '';
                config.RadarrUrlMappings = '';
            }
        }
    });
    return warnings;
}

/* ---------------------------------------------------------------------------
   Hydration. Runs on every pageshow; listener wiring lives in
   wireCoreBindings (once), keeping this a pure hydration pass.
   --------------------------------------------------------------------------- */
let _jcWizardShown = false;

function loadConfig() {
    Dashboard.showLoadingMsg();
    checkInstalledPlugins();
    ApiClient.getPluginConfiguration(pluginId).then(function (config) {
        renderShortcuts(config);
        applyConfigToBoundFields(config);

        const savedAction = config.MaintenanceModeAction || 'disable_accounts';
        const mmAccounts = document.querySelector('#mmAction_accounts');
        const mmRemote = document.querySelector('#mmAction_remote');
        if (mmAccounts) mmAccounts.checked = (savedAction === 'disable_accounts' || savedAction === 'both');
        if (mmRemote) mmRemote.checked = (savedAction === 'disable_remote' || savedAction === 'both');

        const savedUsers = config.MaintenanceModeAffectedUsers || 'all';
        const mmUserList = document.querySelector('#jc-mm-user-list');
        const mmAllRadio = document.querySelector('#mmUsers_all');
        const mmSelectRadio = document.querySelector('#mmUsers_select');
        if (savedUsers === 'all') {
            if (mmAllRadio) mmAllRadio.checked = true;
            if (mmUserList) mmUserList.style.display = 'none';
        } else {
            if (mmSelectRadio) mmSelectRadio.checked = true;
            if (mmUserList) {
                mmUserList.style.display = '';
                mmUserList.dataset.preselect = savedUsers;
            }
        }
        loadMaintenanceUsers();

        const tmdbKey = config.TMDB_API_KEY;
        const tmdbMain = document.querySelector('#TMDB_API_KEY');
        const tmdbSeerr = document.querySelector('#seerr_TMDB_API_KEY');
        if (tmdbMain) tmdbMain.value = tmdbKey;
        if (tmdbSeerr) tmdbSeerr.value = tmdbKey;

        renderOrderRows(config);

        const tagsFallback = document.querySelector('#enableTagsLocalStorageFallback');
        if (tagsFallback) tagsFallback.checked = config.EnableTagsLocalStorageFallback === true;

        document.querySelector('#seerrUrls').value = config.SeerrUrls;
        document.querySelector('#seerrExternalUrl').value = config.SeerrExternalUrl || '';
        document.querySelector('#SeerrApiKey').value = config.SeerrApiKey;
        document.querySelector('#seerrUrlMappings').value = config.SeerrUrlMappings || '';

        const triggerType = config.AutoMovieRequestTriggerType || 'OnMinutesWatched';
        document.querySelector('#autoMovieRequestTriggerOnStart').checked =
            (triggerType === 'OnStart' || triggerType === 'Both');
        document.querySelector('#autoMovieRequestTriggerOnMinutesWatched').checked =
            (triggerType === 'OnMinutesWatched' || triggerType === 'Both');
        populateAutoMovieRequestSelects(config);

        document.querySelector('#seerrImportBlockedUsers').value = config.SeerrImportBlockedUsers || '';
        loadBlockedUsersList(config.SeerrImportBlockedUsers || '');

        renderArrInstances(config);

        if (config.MetadataIconsEnabled) {
            const letterboxd = document.querySelector('#showLetterboxdLinkAsText');
            const arrText = document.querySelector('#showArrLinksAsText');
            if (letterboxd) letterboxd.checked = false;
            if (arrText) arrText.checked = false;
        }

        const streamsContainer = document.querySelector('#activeStreamsAllUsersContainer');
        if (streamsContainer) streamsContainer.style.display = config.ActiveStreamsEnabled ? '' : 'none';
        jcSyncWatchlistRetentionVisibility();

        jcSyncEssentialsMirrors();
        jcRenderEssentialsServices();
        renderServiceStatusDashboard();
        renderFeaturesDashboard();
        updateAllDependencies();
        updateRequestsRequirementsBanner();

        if (config.WizardCompleted !== true && !jcWizardLocallyDone() && !_jcWizardShown) {
            _jcWizardShown = true;
            jcOpenWizard();
        }

        Dashboard.hideLoadingMsg();
    }).catch(function (e) {
        /* Fail visibly: the old page left the loading overlay up forever. */
        console.error('[JC] loadConfig failed:', e);
        try { Dashboard.hideLoadingMsg(); } catch (e2) { /* detached */ }
        try {
            Dashboard.alert({
                title: 'Jellyfin Canopy',
                message: 'Could not load the plugin configuration. Check the server logs, then reload this page.',
            });
        } catch (e3) { console.warn('[JC] load-failure alert failed:', e3); }
    });
}

function jcSyncWatchlistRetentionVisibility() {
    const prevent = document.querySelector('#preventWatchlistReAddition');
    const retention = document.querySelector('#watchlistMemoryRetentionDays');
    if (!prevent || !retention) return;
    const container = retention.closest('.inputContainer');
    if (container) container.style.display = prevent.checked ? '' : 'none';
}

/* Cross-field listeners that the old engine re-registered on every pageshow;
   wired exactly once here. */
function wireCoreBindings() {
    const tmdbMain = document.querySelector('#TMDB_API_KEY');
    const tmdbSeerr = document.querySelector('#seerr_TMDB_API_KEY');
    if (tmdbMain && tmdbSeerr) {
        tmdbMain.addEventListener('input', function () { tmdbSeerr.value = tmdbMain.value; });
        tmdbSeerr.addEventListener('input', function () { tmdbMain.value = tmdbSeerr.value; });
    }
    const streamsToggle = document.querySelector('#activeStreamsEnabled');
    const streamsContainer = document.querySelector('#activeStreamsAllUsersContainer');
    if (streamsToggle && streamsContainer) {
        streamsToggle.addEventListener('change', function () {
            streamsContainer.style.display = streamsToggle.checked ? '' : 'none';
        });
    }
    const prevent = document.querySelector('#preventWatchlistReAddition');
    if (prevent) prevent.addEventListener('change', jcSyncWatchlistRetentionVisibility);
}

/* ---------------------------------------------------------------------------
   Save. Single owner; serialized by the in-flight latch.
   --------------------------------------------------------------------------- */
let _jeSaveInFlight = false;

async function saveConfig(e) {
    e.preventDefault();
    if (_jeSaveInFlight) return false;
    _jeSaveInFlight = true;
    Dashboard.showLoadingMsg();
    const saveButtons = document.querySelectorAll('.jc-save-dock-btn');
    saveButtons.forEach(function (btn) { btn.disabled = true; });
    try {
        const config = await buildConfigFromForm();
        const dirtyRevisionAtSnapshot = jcDirtyRevisionNow();
        const result = await ApiClient.updatePluginConfiguration(pluginId, config);
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
                        affectedUserIds: affectedIds,
                    }),
                });
                const mmMsg = config.MaintenanceModeNotificationMessage
                    || config.MaintenanceModeMessage
                    || 'Server maintenance is starting. Please finish up and try again later.';
                try {
                    await ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl('/JellyfinCanopy/MaintenanceMode/Broadcast'),
                        contentType: 'application/json',
                        data: JSON.stringify({ header: 'Server Maintenance', text: mmMsg, timeoutMs: 30000 }),
                    });
                } catch (bErr) {
                    console.warn('[JC] Maintenance broadcast failed (no active sessions?):', bErr);
                }
            } else {
                await ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('/JellyfinCanopy/MaintenanceMode/Disable'),
                });
            }
        } catch (mmErr) {
            console.warn('[JC] Maintenance mode apply failed:', mmErr);
        }
        Dashboard.processPluginConfigurationUpdateResult(result);
        jcClearDirtyIfUnchanged(dirtyRevisionAtSnapshot);
        return true;
    } catch (saveErr) {
        Dashboard.hideLoadingMsg();
        console.error('[JC] saveConfig failed:', saveErr);
        try {
            Dashboard.alert({
                title: 'Save failed',
                message: 'Could not save Jellyfin Canopy settings. Check the browser console and server logs, then try again.',
            });
        } catch (alertErr) {
            console.warn('[JC] save-failure alert failed:', alertErr);
        }
    } finally {
        _jeSaveInFlight = false;
        saveButtons.forEach(function (btn) { btn.disabled = false; });
    }
    return false;
}

/* SECTION: view mode (Essentials/Advanced) + first-run wizard — owns:
   jcApplyViewMode, jcSyncEssentialsMirrors, jcOpenWizard, wireViewMode,
   wireWizard. depends: activateTab/jcSyncGroupForTab (nav), exitSearchMode
   (search, optional), saveConfig (binder), testers' canonical buttons +
   status indicators, renderArrInstances/arr add buttons, jcDirty owner. */

const VIEW_MODE_KEY = 'jc-settings-view-mode';
/* Browser fallback for wizard completion while the server-side flag is
   parked: without it the modal would reopen on every visit. The server
   flag, once present, dominates (checked in loadConfig). */
const WIZARD_DONE_KEY = 'jc-wizard-completed';

function jcWizardLocallyDone() {
    try { return localStorage.getItem(WIZARD_DONE_KEY) === 'true'; } catch (e) { return false; }
}

/* The six Essentials/wizard mirrors and their canonical bound controls.
   AutoSkip drives intro+outro together (reads intro). */
const JC_MIRROR_MAP = [
    { ess: 'jcEssWatchProgress', wiz: 'jcWizWatchProgress', canonical: ['showWatchProgress'] },
    { ess: 'jcEssQualityTags',   wiz: 'jcWizQualityTags',   canonical: ['qualityTagsEnabled'] },
    { ess: 'jcEssDiscovery',     wiz: 'jcWizDiscovery',     canonical: ['discoveryEnabled'] },
    { ess: 'jcEssElsewhere',     wiz: 'jcWizElsewhere',     canonical: ['elsewhereEnabled'] },
    { ess: 'jcEssAutoSkip',      wiz: 'jcWizAutoSkip',      canonical: ['autoSkipIntro', 'autoSkipOutro'] },
    { ess: 'jcEssSpoiler',       wiz: 'jcWizSpoiler',       canonical: ['spoilerBlurEnabled'] },
];

function jcCanonicalChecked(ids) {
    const el = document.getElementById(ids[0]);
    return !!(el && el.checked);
}

function jcSetCanonical(ids, checked) {
    ids.forEach(function (id) {
        const el = document.getElementById(id);
        /* Disabled canonicals are dependency-gated (missing TMDB key, absent
           Intro Skipper, ...): mirrors must not write through the gate. */
        if (!el || el.disabled || el.checked === checked) return;
        el.checked = checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

/* Pull canonical values into every mirror (called after each hydration). */
function jcSyncEssentialsMirrors() {
    JC_MIRROR_MAP.forEach(function (m) {
        const first = document.getElementById(m.canonical[0]);
        const value = jcCanonicalChecked(m.canonical);
        [m.ess, m.wiz].forEach(function (id) {
            const mirror = document.getElementById(id);
            if (!mirror) return;
            mirror.checked = value;
            mirror.disabled = !!(first && first.disabled);
        });
    });
}

function jcApplyViewMode(mode) {
    const essentials = mode === 'essentials';
    try { document.body.classList.toggle('jc-essentials-mode', essentials); } catch (e) { /* detached */ }
    const essPanel = document.querySelector('#jcEssentials');
    if (essPanel) essPanel.hidden = !essentials;
    const btnEss = document.querySelector('#jcModeEssentials');
    const btnAdv = document.querySelector('#jcModeAdvanced');
    if (btnEss) btnEss.setAttribute('aria-selected', essentials ? 'true' : 'false');
    if (btnAdv) btnAdv.setAttribute('aria-selected', essentials ? 'false' : 'true');
    const title = document.querySelector('#jcPageTitle');
    const purpose = document.querySelector('#jcPagePurpose');
    if (essentials) {
        if (typeof exitSearchMode === 'function') {
            try { exitSearchMode(); } catch (e) { /* search not active */ }
        }
        if (title) title.textContent = 'The essentials';
        if (purpose) purpose.textContent = 'The six settings that shape Canopy for everyone. Advanced is one click away.';
        jcSyncEssentialsMirrors();
        jcRenderEssentialsServices();
    } else {
        /* Restore the active group's header through the nav owner. */
        let activeTab = 'overview';
        try {
            const activeBtn = document.querySelector('.jellyfin-tab-button.active');
            if (activeBtn && activeBtn.dataset.tab) activeTab = activeBtn.dataset.tab;
        } catch (e) { /* default */ }
        if (typeof jcSyncGroupForTab === 'function' && jcSyncGroupForTab) jcSyncGroupForTab(activeTab);
    }
}

function jcRenderEssentialsServices() {
    const list = document.querySelector('#jcEssSvcList');
    if (!list) return;
    list.textContent = '';
    const services = [
        { key: 'seerr', name: 'Seerr', enabledId: 'seerrEnabled' },
        { key: 'maintainerr', name: 'Maintainerr', enabledId: 'maintainerrEnabled' },
    ];
    services.forEach(function (svc) {
        const enabled = jcCanonicalChecked([svc.enabledId]);
        let binding;
        if (svc.key === 'maintainerr') {
            const urlInput = document.querySelector('#maintainerrUrl');
            binding = jcFingerprintConnectionValue(
                jcNormalizeMaintainerrBaseUrl((urlInput && urlInput.value) || ''));
        }
        const cached = enabled ? getPersistedTestResult(svc.key, binding) : null;
        const item = document.createElement('span');
        item.className = 'jc-ess-svc-item';
        const dot = document.createElement('span');
        dot.className = 'jc-wiz-dot' + (cached && cached.status === 'ok' ? ' jc-ok' : '');
        const name = document.createElement('b');
        name.textContent = svc.name;
        const state = document.createElement('span');
        state.textContent = !enabled ? 'not set up'
            : cached && cached.status === 'ok' ? 'connected'
            : cached ? 'check connection'
            : 'not tested yet';
        item.appendChild(dot);
        item.appendChild(name);
        item.appendChild(state);
        list.appendChild(item);
    });
    const arrCount = document.querySelectorAll('.arr-instance-card').length;
    const arrItem = document.createElement('span');
    arrItem.className = 'jc-ess-svc-item';
    const arrDot = document.createElement('span');
    arrDot.className = 'jc-wiz-dot' + (arrCount > 0 ? ' jc-ok' : '');
    const arrName = document.createElement('b');
    arrName.textContent = 'Sonarr & Radarr';
    const arrState = document.createElement('span');
    arrState.textContent = arrCount > 0 ? arrCount + ' instance(s)' : 'not set up';
    arrItem.appendChild(arrDot);
    arrItem.appendChild(arrName);
    arrItem.appendChild(arrState);
    list.appendChild(arrItem);
}

function wireViewMode() {
    const modeSwitch = document.querySelector('.jc-mode-switch');
    if (!modeSwitch) return;
    modeSwitch.hidden = false;
    let stored = 'advanced';
    try {
        if (localStorage.getItem(VIEW_MODE_KEY) === 'essentials') stored = 'essentials';
    } catch (e) { /* private mode — default advanced */ }
    jcApplyViewMode(stored);
    function pick(mode) {
        jcApplyViewMode(mode);
        try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch (e) { /* preference won't persist */ }
    }
    const btnEss = document.querySelector('#jcModeEssentials');
    const btnAdv = document.querySelector('#jcModeAdvanced');
    if (btnEss) btnEss.addEventListener('click', function () { pick('essentials'); });
    if (btnAdv) btnAdv.addEventListener('click', function () { pick('advanced'); });
    const goAdvanced = document.querySelector('#jcEssGoAdvanced');
    if (goAdvanced) goAdvanced.addEventListener('click', function () { pick('advanced'); });
    const manage = document.querySelector('#jcEssManageConnections');
    if (manage) {
        manage.addEventListener('click', function () {
            pick('advanced');
            if (typeof activateTab === 'function') activateTab('seerr');
        });
    }
    JC_MIRROR_MAP.forEach(function (m) {
        const mirror = document.getElementById(m.ess);
        if (mirror) {
            mirror.addEventListener('change', function () { jcSetCanonical(m.canonical, mirror.checked); });
        }
        m.canonical.forEach(function (id) {
            const canonical = document.getElementById(id);
            if (canonical) {
                canonical.addEventListener('change', function () {
                    const ess = document.getElementById(m.ess);
                    const wiz = document.getElementById(m.wiz);
                    const value = jcCanonicalChecked(m.canonical);
                    if (ess) ess.checked = value;
                    if (wiz) wiz.checked = value;
                });
            }
        });
    });
}

/* ---------------------------------------------------------------------------
   Wizard. Never blocks settings: skip/Escape/scrim all mark the flag and
   close. Recommended path leaves defaults untouched and lands on the
   (optional) connections step. Connection tests reuse the canonical testers
   by proxy-click; results are read from the canonical indicators with a
   bounded, self-disconnecting observer.
   --------------------------------------------------------------------------- */
let _jcWizardChoseRecommended = false;
let _jcWizardPrevFocus = null;

function jcWizGo(step) {
    const panes = document.querySelectorAll('#jcWizard .jc-wiz-pane');
    panes.forEach(function (pane) { pane.hidden = pane.dataset.wpane !== String(step); });
    const nodes = document.querySelectorAll('#jcWizard .jc-wiz-stepnode');
    nodes.forEach(function (node) {
        const n = parseInt(node.dataset.wstep, 10);
        node.classList.toggle('jc-now', n === step);
        node.classList.toggle('jc-done', n < step);
    });
    const back = document.querySelector('#jcWizConnBack');
    if (back) back.dataset.wgo = _jcWizardChoseRecommended ? '1' : '2';
    if (step === 4) jcWizRenderSummary();
    const pane = document.querySelector('#jcWizard .jc-wiz-pane[data-wpane="' + step + '"]');
    if (pane) {
        const first = pane.querySelector('button, input');
        if (first) first.focus();
    }
}

function jcWizRenderSummary() {
    const summary = document.querySelector('#jcWizSummary');
    if (!summary) return;
    summary.textContent = '';
    function line(ok, label, rest) {
        const row = document.createElement('div');
        row.className = 'jc-wiz-sumline';
        const dot = document.createElement('span');
        dot.className = 'jc-wiz-dot' + (ok ? ' jc-ok' : '');
        row.appendChild(dot);
        const text = document.createElement('span');
        if (label) {
            const strong = document.createElement('b');
            strong.textContent = label;
            text.appendChild(strong);
            text.appendChild(document.createTextNode(' '));
        }
        text.appendChild(document.createTextNode(rest));
        row.appendChild(text);
        summary.appendChild(row);
    }
    const connected = [];
    [['jcWizSeerrState', 'Seerr'], ['jcWizMaintState', 'Maintainerr'],
     ['jcWizSonarrState', 'Sonarr'], ['jcWizRadarrState', 'Radarr']].forEach(function (pair) {
        const el = document.getElementById(pair[0]);
        if (el && el.classList.contains('jc-ok')) connected.push(pair[1]);
    });
    line(true, 'Experience:', _jcWizardChoseRecommended
        ? 'recommended Canopy defaults'
        : 'your choices from step 2');
    line(connected.length > 0, 'Connections:', connected.length
        ? connected.join(', ') + ' connected'
        : 'none yet — add anytime under Connections');
    line(true, '', 'Users get these as defaults and can personalise their own view from their profile.');
}

function jcWizObserveIndicator(indicator, stateEl, doneText) {
    if (!indicator || !stateEl) return;
    const observer = new MutationObserver(function () {
        const text = (indicator.textContent || '').trim();
        if (text === 'check_circle') {
            stateEl.classList.add('jc-ok');
            stateEl.textContent = '';
            const dot = document.createElement('span');
            dot.className = 'jc-wiz-dot jc-ok';
            stateEl.appendChild(dot);
            stateEl.appendChild(document.createTextNode(doneText));
            observer.disconnect();
        } else if (text === 'error') {
            stateEl.classList.remove('jc-ok');
            stateEl.textContent = 'Connection failed — check the URL and key';
            observer.disconnect();
        }
    });
    observer.observe(indicator, { childList: true, characterData: true, subtree: true });
    /* Bounded: give up quietly after 30s so no observer outlives its test. */
    setTimeout(function () { observer.disconnect(); }, 30000);
}

function jcWizVal(id) {
    const el = document.getElementById(id);
    return ((el && el.value) || '').trim();
}

function jcWizSetInput(el, value) {
    if (!el || el.value === value) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function jcWizEnable(id) {
    const el = document.getElementById(id);
    if (el && !el.checked && !el.disabled) {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

/* Commit wizard connection fields into the canonical controls,
   NON-destructively: Seerr URLs merge into the multi-URL list, and an arr
   card is only reused when it is still blank. Called by each Test button and
   by Finish/Skip-to-done, so typed credentials are never silently dropped. */
function jcWizCommitSeerr() {
    const url = jcWizVal('jcWizSeerrUrl');
    const key = jcWizVal('jcWizSeerrKey');
    if (!url && !key) return false;
    const urls = document.querySelector('#seerrUrls');
    if (url && urls) {
        const lines = (urls.value || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        if (lines.indexOf(url) === -1) {
            lines.push(url);
            jcWizSetInput(urls, lines.join('\n'));
        }
    }
    if (key) jcWizSetInput(document.querySelector('#SeerrApiKey'), key);
    if (url) jcWizEnable('seerrEnabled');
    return true;
}

function jcWizCommitMaintainerr() {
    const url = jcWizVal('jcWizMaintUrl');
    if (!url) return false;
    jcWizSetInput(document.querySelector('#maintainerrUrl'), url);
    jcWizEnable('maintainerrEnabled');
    return true;
}

function jcWizCommitArr(type) {
    const url = jcWizVal(type === 'sonarr' ? 'jcWizSonarrUrl' : 'jcWizRadarrUrl');
    const key = jcWizVal(type === 'sonarr' ? 'jcWizSonarrKey' : 'jcWizRadarrKey');
    if (!url || !key) return null;
    const list = document.querySelector(type === 'sonarr' ? '#sonarrInstancesList' : '#radarrInstancesList');
    if (!list) return null;
    /* Reuse a card only while it is still blank; existing instances are
       never overwritten by a wizard relaunch. */
    let card = null;
    list.querySelectorAll('.arr-instance-card').forEach(function (candidate) {
        if (card) return;
        const u = candidate.querySelector('.arr-instance-url');
        const k = candidate.querySelector('.arr-instance-apikey');
        if (u && k && !u.value.trim() && !k.value.trim()) card = candidate;
    });
    if (!card) {
        const addBtn = document.querySelector(type === 'sonarr' ? '#addSonarrInstance' : '#addRadarrInstance');
        if (addBtn) addBtn.click();
        const cards = list.querySelectorAll('.arr-instance-card');
        card = cards[cards.length - 1] || null;
    }
    if (!card) return null;
    jcWizSetInput(card.querySelector('.arr-instance-url'), url);
    jcWizSetInput(card.querySelector('.arr-instance-apikey'), key);
    return card;
}

function jcWizCommitConnections() {
    jcWizCommitSeerr();
    jcWizCommitMaintainerr();
    jcWizCommitArr('sonarr');
    jcWizCommitArr('radarr');
}

function jcWizTestSeerr() {
    if (!jcWizVal('jcWizSeerrUrl')) return;
    jcWizCommitSeerr();
    const btn = document.querySelector('#testSeerrBtn');
    if (btn) btn.click();
    jcWizObserveIndicator(document.querySelector('#seerrStatusIndicator'),
        document.getElementById('jcWizSeerrState'), 'Connected');
}

function jcWizTestMaintainerr() {
    if (!jcWizVal('jcWizMaintUrl')) return;
    jcWizCommitMaintainerr();
    const btn = document.querySelector('#testMaintainerrBtn');
    if (btn) btn.click();
    jcWizObserveIndicator(document.querySelector('#maintainerrStatusIndicator'),
        document.getElementById('jcWizMaintState'), 'Connected');
}

function jcWizTestArr(type) {
    const stateEl = document.getElementById(type === 'sonarr' ? 'jcWizSonarrState' : 'jcWizRadarrState');
    const card = jcWizCommitArr(type);
    if (!card) {
        if (stateEl && (jcWizVal(type === 'sonarr' ? 'jcWizSonarrUrl' : 'jcWizRadarrUrl')
            || jcWizVal(type === 'sonarr' ? 'jcWizSonarrKey' : 'jcWizRadarrKey'))) {
            stateEl.textContent = 'Enter both a URL and an API key first';
        }
        return;
    }
    const testBtn = card.querySelector('.arr-instance-test');
    if (testBtn) testBtn.click();
    jcWizObserveIndicator(card.querySelector('.arr-instance-status'), stateEl, 'Connected');
}

async function jcWizPersistCompleted() {
    /* Browser fallback first (works even while the server flag is parked). */
    try { localStorage.setItem(WIZARD_DONE_KEY, 'true'); } catch (e) { /* private mode */ }
    try {
        const config = await ApiClient.getPluginConfiguration(pluginId);
        config.WizardCompleted = true;
        await ApiClient.updatePluginConfiguration(pluginId, config);
    } catch (e) {
        /* Fail open: the wizard closes regardless; the local key still
           prevents it reopening in this browser. */
        console.warn('[JC] could not persist wizard completion:', e);
    }
}

function jcWizSetShellInert(inert) {
    [document.querySelector('.jc-main'), document.querySelector('#jcSidebar')].forEach(function (el) {
        if (el) el.inert = inert;
    });
}

function jcCloseWizard() {
    const wizard = document.querySelector('#jcWizard');
    if (wizard) wizard.hidden = true;
    jcWizSetShellInert(false);
    if (_jcWizardPrevFocus && typeof _jcWizardPrevFocus.focus === 'function') {
        try { _jcWizardPrevFocus.focus(); } catch (e) { /* gone */ }
    }
    _jcWizardPrevFocus = null;
}

/* Skip paths: close and mark complete. No form save happens here, so the
   completion round-trip races nothing. */
function jcSkipWizard() {
    jcCloseWizard();
    jcWizPersistCompleted();
}

function jcOpenWizard() {
    const wizard = document.querySelector('#jcWizard');
    if (!wizard) return;
    _jcWizardChoseRecommended = false;
    _jcWizardPrevFocus = document.activeElement;
    jcSyncEssentialsMirrors();
    const eyebrow = document.querySelector('#jcWizConnEyebrow');
    if (eyebrow) eyebrow.textContent = 'Step 3 of 4 · Optional';
    const lede = document.querySelector('#jcWizConnLede');
    if (lede) lede.textContent = 'Canopy works fine without these. Connect what you run — or skip, and add them anytime under Connections.';
    wizard.hidden = false;
    jcWizSetShellInert(true);
    jcWizGo(1);
}

function wireWizard() {
    const wizard = document.querySelector('#jcWizard');
    if (!wizard) return;

    wizard.addEventListener('click', function (event) {
        const go = event.target.closest('[data-wgo]');
        if (go) {
            const step = parseInt(go.dataset.wgo, 10);
            if (step === 1) _jcWizardChoseRecommended = false;
            /* Entering Done commits any typed connection fields (idempotent
               merge), so a later Escape cannot silently drop them. */
            if (step === 4) jcWizCommitConnections();
            jcWizGo(step);
            return;
        }
        const conn = event.target.closest('[data-wconn]');
        if (conn) {
            const formEl = document.getElementById('jcWizForm-' + conn.dataset.wconn);
            if (formEl) formEl.classList.toggle('jc-open');
            return;
        }
        const test = event.target.closest('[data-wtest]');
        if (test) {
            const kind = test.dataset.wtest;
            if (kind === 'seerr') jcWizTestSeerr();
            else if (kind === 'maint') jcWizTestMaintainerr();
            else jcWizTestArr(kind);
            return;
        }
        if (event.target === wizard) {
            /* Scrim click = skip: never trap the admin. */
            jcSkipWizard();
        }
    });
    wizard.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') jcSkipWizard();
    });

    const recommended = document.querySelector('#jcWizRecommended');
    if (recommended) {
        recommended.addEventListener('click', function () {
            _jcWizardChoseRecommended = true;
            const eyebrow = document.querySelector('#jcWizConnEyebrow');
            if (eyebrow) eyebrow.textContent = 'Recommended settings applied · Optional';
            const lede = document.querySelector('#jcWizConnLede');
            if (lede) lede.textContent = 'The recommended experience is set. Last step: connect the services you run — each one is optional, and you can skip all of this and add them later.';
            jcWizGo(3);
        });
    }
    const choose = document.querySelector('#jcWizChoose');
    if (choose) {
        choose.addEventListener('click', function () {
            _jcWizardChoseRecommended = false;
            jcWizGo(2);
        });
    }
    const skip = document.querySelector('#jcWizSkip');
    if (skip) skip.addEventListener('click', function () { jcSkipWizard(); });

    /* Experience mirrors write through to the canonical controls. */
    JC_MIRROR_MAP.forEach(function (m) {
        const mirror = document.getElementById(m.wiz);
        if (mirror) {
            mirror.addEventListener('change', function () { jcSetCanonical(m.canonical, mirror.checked); });
        }
    });

    async function finishTo(mode) {
        jcWizCommitConnections();
        jcCloseWizard();
        const dock = document.querySelector('.jc-save-dock');
        if (dock && dock.classList.contains('jc-dirty')) {
            /* One canonical write: await the form save, THEN write the
               completion flag from the post-save server state. Two
               concurrent read-modify-writes would race and one could
               silently roll the other back. */
            await saveConfig(new Event('submit'));
        }
        await jcWizPersistCompleted();
        const modeBtn = document.querySelector(mode === 'essentials' ? '#jcModeEssentials' : '#jcModeAdvanced');
        if (modeBtn) modeBtn.click();
    }
    const openEss = document.querySelector('#jcWizOpenEssentials');
    if (openEss) openEss.addEventListener('click', function () { finishTo('essentials'); });
    const openAdv = document.querySelector('#jcWizOpenAdvanced');
    if (openAdv) openAdv.addEventListener('click', function () { finishTo('advanced'); });

    const relaunch = document.querySelector('#jcRunWizardBtn');
    if (relaunch) relaunch.addEventListener('click', function () { jcOpenWizard(); });
}

/* SECTION: init — the single ordered wiring pass. Each subsystem is isolated
   so one broken wire cannot abort the rest of the page (the old engine died
   wholesale on the first missing element). Order contracts: nav shell before
   the session-restored tab activation inside it; widgets (dependency tables,
   TMDB wrap) before connections' delegated TMDB click; hydration listeners
   registered last. */
function jcWire(name, fn) {
    try {
        fn();
    } catch (e) {
        console.error('[JC] wiring failed for ' + name + ':', e);
    }
}

_jeDetectTheme();
window.addEventListener('load', _jeDetectTheme);
setTimeout(_jeDetectTheme, 600);

jcWire('nav-shell', wireNavShell);
jcWire('dirty-state', wireDirtyState);
jcWire('search', wireSearch);
jcWire('widgets', wireWidgets);
jcWire('connections', wireConnections);
jcWire('connection-lifecycle', wireConnectionLifecycle);
jcWire('arr-instances', wireArrInstances);
jcWire('dashboards', wireDashboards);
jcWire('core-bindings', wireCoreBindings);
jcWire('view-mode', wireViewMode);
jcWire('wizard', wireWizard);

if (page) page.addEventListener('pageshow', loadConfig);
if (form) form.addEventListener('submit', saveConfig);
})();
