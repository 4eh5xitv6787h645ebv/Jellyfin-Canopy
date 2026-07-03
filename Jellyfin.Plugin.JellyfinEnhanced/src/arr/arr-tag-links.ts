// src/arr/arr-tag-links.ts (formerly js/arr/arr-tag-links.js)
// Renders "JE Arr Tag: ..." library tags as link buttons on the item detail
// page. Public surface (frozen): JE.initializeArrTagLinksScript (called by
// js/plugin.js Stage 6).

import { createObserver } from '../core/dom-observer';
import { register as registerLifecycle } from '../core/lifecycle';
import { onNavigate } from '../core/navigation';
import { JE } from './arr-globals';

// eslint-disable-next-line @typescript-eslint/require-await -- frozen contract: initializer has always been async (plugin.js Stage 6 may rely on the Promise)
JE.initializeArrTagLinksScript = async function () {
    const logPrefix = '🪼 Jellyfin Enhanced: Arr Tag Links:';

    if (!JE?.pluginConfig?.ArrTagsShowAsLinks) {
        console.log(`${logPrefix} Tag links display disabled in plugin settings.`);
        return;
    }

    console.log(`${logPrefix} Initializing...`);

    let isAddingLinks = false;
    const processedItems = new Set<string>(); // Track items that have been processed
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    function slugifyTagName(name: string): string {
        try {
            return name
                .toString()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .trim()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9-_]/g, '-')
                .replace(/--+/g, '-')
                .replace(/^-+|-+$/g, '');
        } catch {
            return name;
        }
    }

    async function addTagLinks(itemId: string, externalLinksContainer: Element): Promise<void> {
        if (isAddingLinks) {
            return;
        }

        // Check if we've already processed this item (with or without tags)
        if (processedItems.has(itemId)) {
            return;
        }

        // Check if already rendered for this itemId
        const existing = externalLinksContainer.querySelector<HTMLElement>('.arr-tag-link');
        if (existing && existing.dataset.itemId === itemId) {
            processedItems.add(itemId);
            return;
        }

        // Remove old links if switching items
        externalLinksContainer.querySelectorAll('.arr-tag-link').forEach(link => {
            if (link.previousSibling && link.previousSibling.nodeType === Node.TEXT_NODE) {
                link.previousSibling.remove();
            }
            link.remove();
        });

        isAddingLinks = true;
        try {
            const item = (JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(itemId)
                : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId)) as { Tags?: string[] } | null;

            if (!item?.Tags || item.Tags.length === 0) {
                // Mark as processed even if no tags - don't keep checking
                processedItems.add(itemId);
                return;
            }

            const tagPrefix = JE.pluginConfig.ArrTagsPrefix || 'JE Arr Tag: ';
            const tagsFilter = JE.pluginConfig.ArrTagsLinksFilter || '';
            const tagsHideFilter = JE.pluginConfig.ArrTagsLinksHideFilter || '';

            const allowedTags = tagsFilter
                .split('\n')
                .map(t => t.trim())
                .filter(t => t.length > 0)
                .map(t => `${tagPrefix}${t}`);

            const hiddenTags = tagsHideFilter
                .split('\n')
                .map(t => t.trim())
                .filter(t => t.length > 0)
                .map(t => `${tagPrefix}${t}`);

            let relevantTags = item.Tags.filter(tag =>
                tag.startsWith(tagPrefix)
            );

            if (hiddenTags.length > 0) {
                relevantTags = relevantTags.filter(tag =>
                    !hiddenTags.some(hidden =>
                        tag.toLowerCase() === hidden.toLowerCase()
                    )
                );
            }

            if (allowedTags.length > 0) {
                relevantTags = relevantTags.filter(tag =>
                    allowedTags.some(allowed =>
                        tag.toLowerCase() === allowed.toLowerCase()
                    )
                );
            }

            if (relevantTags.length === 0) {
                // Mark as processed even if no relevant tags - don't keep checking
                processedItems.add(itemId);
                return;
            }

            const serverId = (ApiClient.serverId as () => string)();

            relevantTags.forEach(tag => {
                externalLinksContainer.appendChild(document.createTextNode(' '));

                const tagName = tag.slice(tagPrefix.length).trim();
                const slug = slugifyTagName(tagName);

                const link = document.createElement('a');
                link.setAttribute('is', 'emby-linkbutton');
                link.className = 'button-link emby-button arr-tag-link';
                link.href = `#!/list.html?type=tag&tag=${encodeURIComponent(tag)}&serverId=${serverId}`;
                link.title = `View all items with tag: ${tag}`;

                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const url = `list.html?type=tag&tag=${encodeURIComponent(tag)}&serverId=${serverId}`;
                    const dashboard = (window as { Dashboard?: { navigate?: (url: string) => void } }).Dashboard;
                    if (dashboard && typeof dashboard.navigate === 'function') {
                        dashboard.navigate(url);
                    } else {
                        window.location.hash = `!/${url}`;
                    }
                });

                link.dataset.itemId = itemId;
                link.dataset.id = slug;
                link.dataset.tag = tag;
                link.dataset.tagName = tagName;
                link.dataset.tagPrefix = tagPrefix;

                const icon = document.createElement('span');
                icon.className = 'arr-tag-link-icon';
                icon.setAttribute('aria-hidden', 'true');
                icon.innerHTML = JE.icon?.(JE.IconName?.TAG ?? '') ?? '';
                icon.style.marginRight = '5px';

                const text = document.createElement('span');
                text.className = 'arr-tag-link-text';
                text.dataset.id = slug;
                text.dataset.tag = tag;
                text.dataset.tagName = tagName;
                text.dataset.tagPrefix = tagPrefix;
                text.textContent = tag;

                link.appendChild(icon);
                link.appendChild(text);

                externalLinksContainer.appendChild(link);
            });

            // Mark item as processed after successfully adding links
            processedItems.add(itemId);

        } catch (err) {
            console.error(`${logPrefix} Error adding tag links:`, err);
        } finally {
            isAddingLinks = false;
        }
    }

    function checkAndAddLinks(): void {
        const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
        if (visiblePage) {
            const externalLinksContainer = visiblePage.querySelector('.itemExternalLinks');
            if (externalLinksContainer) {
                try {
                    const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                    if (itemId) {
                        void addTagLinks(itemId, externalLinksContainer);
                    }
                } catch {
                    // Ignore URL parsing errors
                }
            }
        }
    }

    createObserver('arr-tag-links', () => {
        if (!JE?.pluginConfig?.ArrTagsShowAsLinks) {
            return;
        }

        // Debounce to avoid excessive processing on rapid DOM changes
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(checkAndAddLinks, 100);
    }, document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
    });

    // Also check immediately on navigation — the shared deduplicated
    // pipeline covers hashchange, popstate and pushState transitions the
    // old raw hashchange listener missed. Lifecycle-tracked for teardown.
    const lifecycle = registerLifecycle('arr-tag-links');
    lifecycle.track(onNavigate(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkAndAddLinks, 200);
    }));

    // Run once immediately in case were already on an item detail page
    setTimeout(checkAndAddLinks, 500);

    console.log(`${logPrefix} Initialized successfully`);
};
