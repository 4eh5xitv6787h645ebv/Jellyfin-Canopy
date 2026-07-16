// src/seerr/ui/cards.ts
// Seerr search-result card construction.
import { JC } from '../../globals';
// PERF(R6): no remote assets — Seerr icon + poster placeholder served from the
// local asset cache (the placeholder is embedded in the plugin DLL).
import { assetUrl } from '../../core/asset-urls';

/* eslint-disable @typescript-eslint/no-explicit-any -- legacy Seerr payload + DOM shapes; typed incrementally */


import { ui, internal } from './internal';
const MediaStatus = JC.seerrStatus!.MEDIA;
const icons = internal.icons; // requires ui/icons.ts to be loaded first
const escapeHtml = JC.escapeHtml;
const cardTimers = new Set<ReturnType<typeof setTimeout>>();
const outsideOverviewCleanups = new Set<() => void>();

/**
 * Creates an individual Seerr result card.
 * @param {Object} item - Search result item from Seerr API.
 * @param {boolean} isSeerrActive - If the server is reachable.
 * @param {boolean} seerrUserFound - If the current user is linked.
 * @returns {HTMLElement} - Card element.
 */
function createSeerrCard(item: any, isSeerrActive: any, seerrUserFound: any) {
    const identity = JC.identity.capture();
    const isCurrent = () => !!identity && JC.identity.isCurrent(identity);
    const year = item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || 'N/A';
    // validate posterPath before interpolating into a CSS
    // url() context. Anything other than a leading-slash relative path
    // (TMDB always returns this shape, e.g. "/abc.jpg") is rejected so a
    // hostile poster path can't break out of the url() literal.
    const isSafePosterPath = (p: any) => typeof p === 'string'
        && /^\/[A-Za-z0-9_\-\.]+\.(jpg|jpeg|png|webp|avif)$/i.test(p);
    const posterUrl = isSafePosterPath(item.posterPath)
        ? `https://image.tmdb.org/t/p/w400${item.posterPath}`
        : assetUrl('seerr/poster-fallback.svg');
    const rating = item.voteAverage ? item.voteAverage.toFixed(1) : 'N/A';
    // Escape API-sourced values before interpolation into search card HTML
    const titleText = escapeHtml(item.title || item.name);
    // Resolve Seerr URL based on mappings or fallback to base URL
    const base = JC.seerrAPI?.resolveSeerrBaseUrl() || '';
    const seerrUrl = base ? `${base}/${item.mediaType}/${item.id}` : null;
    const useMoreInfoModal = !!(JC.pluginConfig && JC.pluginConfig.SeerrUseMoreInfoModal);

    const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId || item.mediaInfo?.jellyfinMediaId4k || null;
    // For TV shows, derive the card-level availability from the season analysis so that
    // a stale Seerr jellyfinMediaId on a show where no seasons are confirmed present
    // does not produce a false "in library" green link.
    // Only AVAILABLE (all seasons present) or PARTIALLY_AVAILABLE (some present) justify the link.
    let cardEffectiveStatus;
    if (item.mediaType === 'tv' && item.mediaInfo?.seasons?.length) {
        const sa = internal.analyzeSeasonStatuses(item.mediaInfo.seasons);
        cardEffectiveStatus = sa ? sa.overallStatus : JC.seerrStatus!.effectiveMediaStatus(item.mediaInfo?.status, jellyfinMediaId);
    } else {
        cardEffectiveStatus = JC.seerrStatus!.effectiveMediaStatus(item.mediaInfo?.status, jellyfinMediaId);
    }
    const isAvailable = Boolean(jellyfinMediaId)
        && (cardEffectiveStatus === MediaStatus.AVAILABLE || cardEffectiveStatus === MediaStatus.PARTIALLY_AVAILABLE);
    const jellyfinHref = isAvailable ? `#!/details?id=${escapeHtml(jellyfinMediaId)}` : null;
    // True when the card should navigate directly to an external Seerr URL instead of
    // showing the hover overview — used to decide poster touch behaviour below.
    const navigatesExternally = !useMoreInfoModal && !jellyfinMediaId && !!seerrUrl && item.mediaType !== 'collection';
    // is="emby-linkbutton" routes external URLs through the system browser on iOS/Android.
    const titleLinkIsAttribute = 'is="emby-linkbutton"';
    const titleHrefAttribute = jellyfinHref
        ? `href="${jellyfinHref}"`
        : (useMoreInfoModal
            ? 'href="#"'
            : (seerrUrl
                ? `href="${escapeHtml(seerrUrl)}" target="_blank" rel="noopener noreferrer"`
                : 'href="#"'));

    const card = document.createElement('div');
    card.className = `card overflowPortraitCard card-hoverable card-withuserdata seerr-card${isAvailable ? ' seerr-card-in-library' : ''}`;
    card.dataset.jcIdentityOwned = 'true';
    JC.identity.own(card, identity);
    card.innerHTML = `
        <div class="cardBox cardBox-bottompadded">
            <div class="cardScalable">
                <div class="cardPadder cardPadder-overflowPortrait"></div>
                <div class="cardImageContainer coveredImage cardContent seerr-poster-image" style="background-image: url('${posterUrl}');">
                    <div class="seerr-status-badge"></div>
                    <div class="seerr-elsewhere-icons"></div>
                    <div class="cardIndicators"></div>
                </div>
                <div class="cardOverlayContainer" data-action="link"></div>
            </div>
            <div class="cardText cardTextCentered cardText-first">
                <a ${titleLinkIsAttribute}
                   ${titleHrefAttribute}
                   class="seerr-more-info-link"
                   data-tmdb-id="${escapeHtml(item.id)}"
                   data-media-type="${escapeHtml(item.mediaType)}"
                   title="${jellyfinHref ? titleText : (useMoreInfoModal ? titleText : (seerrUrl ? (JC.t!('seerr_card_view_on_seerr') || 'View on Seerr') : titleText))}"><bdi>${titleText}</bdi></a>
            </div>
            <div class="cardText cardTextCentered cardText-secondary seerr-meta">
                <img src="${assetUrl('icons/seerr.svg')}" class="seerr-icon-on-card" alt="Seerr"/>
                <bdi>${escapeHtml(year)}</bdi>
                <div class="seerr-rating">${icons.star}<span>${rating}</span></div>
            </div>
        </div>`;

    // Set the status badge icon based on the item's status
    internal.setStatusBadge(card, item);

    // Disable default Jellyfin card click behavior so we fully control taps/clicks
    const overlayContainer = card.querySelector<HTMLElement>('.cardOverlayContainer');
    if (overlayContainer) {
        overlayContainer.removeAttribute('data-action');
        overlayContainer.style.pointerEvents = 'none';
    }

    const imageContainer = card.querySelector<HTMLElement>('.cardImageContainer');
    const cardScalable = card.querySelector('.cardScalable');

    if (imageContainer && cardScalable) {
        imageContainer.classList.remove('itemAction');

        let overview: HTMLElement | null = null;
        let button: HTMLButtonElement | null = null;

        // Create the overview element
        const createOverview = () => {
            if (!isCurrent()) return;
            overview = document.createElement('div');
            overview.className = 'seerr-overview';
            overview.style.cursor = 'pointer';
            // When modal is disabled and item isn't in the library, wrap the description
            // text in a real <a is="emby-linkbutton"> so the user's tap opens outside the app.
            const contentHtml = navigatesExternally
                ? `<a is="emby-linkbutton" href="${escapeHtml(seerrUrl)}" target="_blank" rel="noopener noreferrer" class="content seerr-overview-link" style="text-decoration:none;color:inherit;">${escapeHtml((item.overview || JC.t!('seerr_card_no_info')).slice(0, 500))}</a>`
                : `<div class="content">${escapeHtml((item.overview || JC.t!('seerr_card_no_info')).slice(0, 500))}</div>`;
            overview.innerHTML = `
                ${contentHtml}
                <button type="button" class="seerr-request-button" data-tmdb-id="${escapeHtml(item.id)}" data-media-type="${escapeHtml(item.mediaType)}"></button>
            `;

            cardScalable.appendChild(overview);
            button = overview.querySelector<HTMLButtonElement>('.seerr-request-button');
            if (!button) return;
            JC.identity.own(button, identity);
            internal.configureRequestButton(button, item, isSeerrActive, seerrUserFound);

            // Click handler on overview to open modal
            overview.addEventListener('click', (event: MouseEvent) => {
                if (!isCurrent()) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                const target = event.target instanceof Element ? event.target : null;
                if (target?.closest('.seerr-request-button')) {
                    return;
                }
                if (target?.closest('.seerr-overview-link')) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();

                if (item.mediaType === 'collection') {
                    ui.showCollectionRequestModal(item.id, item.name || item.title, item);
                } else if (useMoreInfoModal && JC.seerrMoreInfo) {
                    const tmdbId = parseInt(item.id);
                    const mediaType = item.mediaType;
                    if (tmdbId && mediaType) {
                        JC.seerrMoreInfo.open(tmdbId, mediaType);
                    }
                }
            });
        };

        // Remove the overview element
        const removeOverview = () => {
            if (overview && overview.parentNode) {
                overview.parentNode.removeChild(overview);
                overview = null;
                button = null;
            }
            document.removeEventListener('click', handleOutsideClick);
            outsideOverviewCleanups.delete(removeOverview);
        };

        // Helper to close overview if clicked outside
        const handleOutsideClick = (evt: any) => {
            if (!isCurrent()) {
                removeOverview();
                return;
            }
            if (!card.contains(evt.target)) {
                removeOverview();
            }
        };

        // Desktop: hover to show/hide overview
        cardScalable.addEventListener('mouseenter', () => {
            if (!isCurrent()) return;
            if (!overview) {
                createOverview();
            }
        });
        cardScalable.addEventListener('mouseleave', () => {
            removeOverview();
        });

        // Mobile/Touch: touchstart to show overview, second tap (click) on overview opens modal
        imageContainer.style.cursor = 'pointer';

        // Use touchstart for mobile to create overview (prevents touchend from immediately opening modal)
        imageContainer.addEventListener('touchstart', (e: any) => {
            if (!isCurrent()) return;
            if (e.target.closest('.seerr-overview') || e.target.closest('.seerr-request-button')) {
                return;
            }

            if (!overview) {
                e.preventDefault();
                createOverview();
                const timer = setTimeout(() => {
                    cardTimers.delete(timer);
                    if (isCurrent()) {
                        document.addEventListener('click', handleOutsideClick);
                        outsideOverviewCleanups.add(removeOverview);
                    }
                }, 0);
                cardTimers.add(timer);
            }
        }, { passive: false });

        // Desktop: use click event
        imageContainer.addEventListener('click', (e: any) => {
            if (!isCurrent()) return;
            // Skip if touch device (touchstart already handled it)
            if (e.type === 'click' && 'ontouchstart' in window) {
                return;
            }

            if (e.target.closest('.seerr-overview')) {
                return;
            }

            if (!overview) {
                e.preventDefault();
                e.stopPropagation();
                createOverview();
                const timer = setTimeout(() => {
                    cardTimers.delete(timer);
                    if (isCurrent()) {
                        document.addEventListener('click', handleOutsideClick);
                        outsideOverviewCleanups.add(removeOverview);
                    }
                }, 0);
                cardTimers.add(timer);
            }
        });

        imageContainer.setAttribute('tabindex', '0');
        imageContainer.addEventListener('keydown', (event: KeyboardEvent) => {
            if (!isCurrent()) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (!overview) {
                    createOverview();
                } else {
                    removeOverview();
                }
            }
        });

    }
    internal.addMediaTypeBadge(card, item);
    // If movie belongs to a collection, show a collection badge that opens the modal
    internal.addCollectionMembershipBadge(card, item);

    // Add click handler for the poster image - opens modal
    const posterImage = card.querySelector<HTMLElement>('.seerr-poster-image');
    if (posterImage && useMoreInfoModal && JC.seerrMoreInfo) {
        posterImage.style.cursor = 'pointer';
        posterImage.addEventListener('click', (event: MouseEvent) => {
            if (!isCurrent()) return;
            event.preventDefault();
            event.stopPropagation();
            const tmdbId = parseInt(item.id);
            const mediaType = item.mediaType;
            if (tmdbId && mediaType) {
                JC.seerrMoreInfo.open(tmdbId, mediaType);
            }
        });
    }

    // Add click handler for the title link
    const moreInfoLink = card.querySelector<HTMLElement>('.seerr-more-info-link');
    if (moreInfoLink) {
        moreInfoLink.addEventListener('click', (event: MouseEvent) => {
            if (!isCurrent()) {
                event.preventDefault();
                return;
            }
            // Check if this is a library item (href already set to jellyfin item)
            const href = moreInfoLink.getAttribute('href');
            const isLibraryLink = href && href.startsWith('#!/details?id=');
            const isExternalSeerrLink = href && /^https?:\/\//i.test(href);

            if (isLibraryLink) {
                // Allow default behavior for library links
                return;
            }

            // If collection, open collection modal
            if (item.mediaType === 'collection') {
                event.preventDefault();
                event.stopPropagation();
                ui.showCollectionRequestModal(item.id, item.name || item.title, item);
                return;
            }

            // If using modal, prevent default and open modal
            if (useMoreInfoModal && JC.seerrMoreInfo) {
                event.preventDefault();
                event.stopPropagation();
                const tmdbId = parseInt(moreInfoLink.dataset.tmdbId || "");
                const mediaType = moreInfoLink.dataset.mediaType;
                if (tmdbId && mediaType) {
                    JC.seerrMoreInfo.open(tmdbId, mediaType);
                }
                return;
            }

            // For external Seerr links the <a> has is="emby-linkbutton" — let default run.
            const isPlainLeftClick = event.button === 0
                && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
            if (isExternalSeerrLink && isPlainLeftClick) {
                return;
            }
        }, true);
    }

    if (JC.pluginConfig.ShowElsewhereOnSeerr && JC.pluginConfig.TmdbEnabled && item.mediaType !== 'collection') {
        internal.fetchProviderIcons(card.querySelector('.seerr-elsewhere-icons'), item.id, item.mediaType);
    }

    // Add hide button for hidden content feature
    if (JC.hiddenContent && JC.hiddenContent.getSettings().enabled && JC.hiddenContent.getSettings().showHideButtons !== false && JC.hiddenContent.getSettings().showButtonSeerr !== false) {
        const cardBox = card.querySelector<HTMLElement>('.cardBox');
        if (cardBox) {
            const hideBtn = document.createElement('button');
            const hiddenLabel = JC.t!('hidden_content_already_hidden') !== 'hidden_content_already_hidden' ? JC.t!('hidden_content_already_hidden') : 'Hidden';
            const unhideLabel = JC.t!('hidden_content_unhide') !== 'hidden_content_unhide' ? JC.t!('hidden_content_unhide') : 'Unhide';
            const hideLabel = JC.t!('hidden_content_hide_button') !== 'hidden_content_hide_button' ? JC.t!('hidden_content_hide_button') : 'Hide';
            const mediaCandidate = {
                jellyfinMediaId: jellyfinMediaId || '',
                tmdbId: item.id,
                mediaType: item.mediaType,
            };

            /**
             * Replaces the hide button's content with a material icon.
             * @param {string} iconName - Material icon name (e.g. 'visibility', 'visibility_off').
             */
            function renderHideIcon(iconName: any) {
                hideBtn.replaceChildren();
                const icon = document.createElement('span');
                icon.className = 'material-icons';
                icon.setAttribute('aria-hidden', 'true');
                icon.textContent = iconName || 'visibility';
                hideBtn.appendChild(icon);
            }

            /**
             * Switches the hide button to "already hidden" state with unhide-on-click behaviour.
             */
            function setHiddenState() {
                hideBtn.className = 'jc-hide-btn jc-already-hidden';
                hideBtn.title = hiddenLabel;
                renderHideIcon('visibility_off');
                hideBtn.onmouseenter = () => {
                    hideBtn.title = unhideLabel;
                };
                hideBtn.onmouseleave = () => {
                    hideBtn.title = hiddenLabel;
                };
                hideBtn.onclick = (e: any) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isCurrent()) return;
                    const unhideKey = JC.hiddenContent?.getHiddenStorageKey(mediaCandidate);
                    if (unhideKey) JC.hiddenContent?.unhideItem(unhideKey);
                    if (JC.hiddenContent?.isHiddenMedia(mediaCandidate)) setHiddenState();
                    else setHideState();
                };
            }

            /**
             * Switches the hide button to the default "hide" state with confirm-and-hide-on-click behaviour.
             */
            function setHideState() {
                hideBtn.className = 'jc-hide-btn';
                hideBtn.title = hideLabel;
                renderHideIcon('visibility');
                hideBtn.onmouseenter = null;
                hideBtn.onmouseleave = null;
                hideBtn.onclick = (e: any) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isCurrent()) return;
                    // The hide button is only added when hidden-content is enabled,
                    // so JC.hiddenContent is present here; optional-chain to satisfy
                    // the type without changing behavior.
                    JC.hiddenContent?.confirmAndHide({
                        itemId: jellyfinMediaId || '',
                        name: titleText,
                        type: item.mediaType === 'tv' ? 'Series' : 'Movie',
                        tmdbId: item.id,
                        posterPath: item.posterPath || ''
                    }, () => {
                        card.style.display = 'none';
                    });
                };
            }

            if (JC.hiddenContent.isHiddenMedia(mediaCandidate)) {
                setHiddenState();
            } else {
                setHideState();
            }
            cardBox.style.position = 'relative';
            cardBox.appendChild(hideBtn);
        }
    }

    return card;
}
ui.createSeerrCard = createSeerrCard;

internal.createSeerrCard = createSeerrCard;

export function resetSeerrCards(): void {
    for (const timer of cardTimers) clearTimeout(timer);
    cardTimers.clear();
    for (const cleanup of [...outsideOverviewCleanups]) cleanup();
    outsideOverviewCleanups.clear();
    document.querySelectorAll('.seerr-card[data-jc-identity-owned="true"]').forEach((card) => card.remove());
}

let uninstallIdentityReset: (() => void) | null = null;

export function installSeerrCards(): () => void {
    uninstallIdentityReset ??= JC.identity.registerReset('seerr-cards', resetSeerrCards);
    let installed = true;
    return () => {
        if (!installed) return;
        installed = false;
        uninstallIdentityReset?.();
        uninstallIdentityReset = null;
        resetSeerrCards();
    };
}


installSeerrCards();
