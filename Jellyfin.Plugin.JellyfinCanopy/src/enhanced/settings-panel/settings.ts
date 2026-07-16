// src/enhanced/settings-panel/settings.ts
//
// Settings-tab wiring: feature toggles, quality-tag categories, subtitle
// styling/position controls, tag position selectors and subtitle presets.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-settings.js — bodies semantically identical.)

import { JC } from '../../globals';
import { escapeHtml, toast } from '../../core/ui-kit';
import { showReleaseNotesNotification } from './release-notes';
import type { PanelContext } from './panel';

/* eslint-disable @typescript-eslint/no-explicit-any */

let reconcileInFlight: Promise<void> | null = null;

function reapplyAcknowledgedSideEffects(): void {
    for (const name of [
        'reinitializeQualityTags',
        'reinitializeGenreTags',
        'reinitializeLanguageTags',
        'reinitializeRatingTags',
        'initializePeopleTags',
        'addRandomButton',
        'applyHideFavoritesTab',
        'applySavedStylesWhenReady',
        'applySubtitlePosition',
    ]) {
        const callback = (JC as any)[name];
        if (typeof callback === 'function') callback();
    }
}

/** Rebuild the open panel from the rolled-back snapshot and undo optimistic page effects. */
function reconcileSettingsPanelAfterFailure(): Promise<void> {
    if (reconcileInFlight) return reconcileInFlight;
    const context = JC.identity.capture();
    const panel = document.getElementById('jellyfin-canopy-panel');
    if (!context || !panel || typeof JC.showEnhancedPanel !== 'function') return Promise.resolve();

    reconcileInFlight = (async () => {
        try {
            // showEnhancedPanel is a toggle. The first call refreshes and closes
            // the stale optimistic controls; the second builds them again from
            // the authoritative snapshot restored by the persistence queue.
            await JC.showEnhancedPanel!();
            if (!JC.identity.isCurrent(context)) return;
            await JC.showEnhancedPanel!();
            if (!JC.identity.isCurrent(context)) return;
        } finally {
            reconcileInFlight = null;
        }
    })();
    return reconcileInFlight;
}

function persistSettings(): Promise<boolean> {
    const context = JC.identity.capture();
    return Promise.resolve(JC.saveUserSettings!('settings.json', JC.currentSettings)).then(
        () => true,
        async () => {
            await reconcileSettingsPanelAfterFailure();
            // Persistence restores JC.currentSettings before rejecting. Reapply
            // optimistic page effects even when the user already closed the
            // panel, because panel rebuilding is optional UI reconciliation.
            // A stale panel save must not mutate the next active identity's UI.
            if (!context || JC.identity.isCurrent(context)) reapplyAcknowledgedSideEffects();
            return false;
        }
    );
}

/**
 * Wires the feature toggles, quality-tag category controls and subtitle
 * styling/position controls of the Settings tab.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireSettingsListeners(ctx: PanelContext): void {
    const { createToast, resetAutoCloseTimer, identityContext, registerCleanup } = ctx;

    const addSettingToggleListener = (id: string, settingKey: string, featureKey: string, requiresRefresh = false) => {
        document.getElementById(id)!.addEventListener('change', (e) => {
            (JC.currentSettings as any)[settingKey] = (e.target as HTMLInputElement).checked;
            const save = persistSettings();
            let toastMessage = createToast!(featureKey, (e.target as HTMLInputElement).checked);

            // Handle tag features with dynamic re-initialization
            if (id === 'qualityTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    // Initialize for the first time if enabling
                    if (typeof (JC as any).initializeQualityTags === 'function') {
                        (JC as any).initializeQualityTags();
                    }
                } else {
                    // Remove all tags if disabling
                    document.querySelectorAll('.quality-overlay-container').forEach(el => el.remove());
                }
                requiresRefresh = false; // No longer needs refresh
            } else if (id === 'genreTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    if (typeof (JC as any).initializeGenreTags === 'function') {
                        (JC as any).initializeGenreTags();
                    }
                } else {
                    document.querySelectorAll('.genre-overlay-container').forEach(el => el.remove());
                }
                requiresRefresh = false;
            } else if (id === 'languageTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    if (typeof (JC as any).initializeLanguageTags === 'function') {
                        (JC as any).initializeLanguageTags();
                    }
                } else {
                    document.querySelectorAll('.language-overlay-container').forEach(el => el.remove());
                }
                requiresRefresh = false;
            } else if (id === 'ratingTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    if (typeof (JC as any).initializeRatingTags === 'function') {
                        (JC as any).initializeRatingTags();
                    }
                } else {
                    document.querySelectorAll('.rating-overlay-container').forEach(el => el.remove());
                }
                requiresRefresh = false;
            } else if (id === 'peopleTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    if (typeof (JC as any).initializePeopleTags === 'function') {
                        (JC as any).initializePeopleTags();
                    }
                } else {
                    document.querySelectorAll('.jc-people-place-banner').forEach(el => el.remove());
                    document.querySelectorAll('.jc-people-age-container').forEach(el => el.remove());
                    document.querySelectorAll('.jc-deceased-poster').forEach(el => el.classList.remove('jc-deceased-poster'));
                }
                requiresRefresh = false;
            }

            if (requiresRefresh) {
                toastMessage += ".<br> Refresh page to apply.";
            }
            void save.then(saved => { if (saved) toast(toastMessage); });
            if (id === 'randomButtonToggle') (JC as any).addRandomButton();
            if (id === 'hideFavoritesTabToggle') (JC as any).applyHideFavoritesTab?.();
            if (id === 'showWatchProgressToggle' && !(e.target as HTMLInputElement).checked) document.querySelectorAll('.mediaInfoItem-watchProgress').forEach(el => el.remove());
            if (id === 'showFileSizesToggle' && !(e.target as HTMLInputElement).checked) document.querySelectorAll('.mediaInfoItem-fileSize').forEach(el => el.remove());
            if (id === 'showAudioLanguagesToggle' && !(e.target as HTMLInputElement).checked) document.querySelectorAll('.mediaInfoItem-audioLanguage').forEach(el => el.remove());
            resetAutoCloseTimer();
        });
    };

    addSettingToggleListener('autoPauseToggle', 'autoPauseEnabled', 'feature_auto_pause');
    addSettingToggleListener('autoResumeToggle', 'autoResumeEnabled', 'feature_auto_resume');
    addSettingToggleListener('autoPipToggle', 'autoPipEnabled', 'feature_auto_pip');
    addSettingToggleListener('autoSkipIntroToggle', 'autoSkipIntro', 'feature_auto_skip_intro');
    addSettingToggleListener('autoSkipOutroToggle', 'autoSkipOutro', 'feature_auto_skip_outro');
    addSettingToggleListener('randomButtonToggle', 'randomButtonEnabled', 'feature_random_button');
    addSettingToggleListener('randomUnwatchedOnly', 'randomUnwatchedOnly', 'feature_unwatched_only');
    addSettingToggleListener('showWatchProgressToggle', 'showWatchProgress', 'feature_watch_progress_display');
            // Watch progress selects
            const modeSel = document.getElementById('watchProgressModeSelect');
            const fmtSel = document.getElementById('watchProgressTimeFormatSelect');
            if (modeSel) {
                modeSel.addEventListener('change', (e) => {
                    (JC.currentSettings as any).watchProgressMode = (e.target as HTMLSelectElement).value;
                    void persistSettings();
                    resetAutoCloseTimer();
                });
            }
            if (fmtSel) {
                fmtSel.addEventListener('change', (e) => {
                    (JC.currentSettings as any).watchProgressTimeFormat = (e.target as HTMLSelectElement).value;
                    void persistSettings();
                    resetAutoCloseTimer();
                });
            }
    addSettingToggleListener('showFileSizesToggle', 'showFileSizes', 'feature_file_size_display');
    addSettingToggleListener('showAudioLanguagesToggle', 'showAudioLanguages', 'feature_audio_language_display');
    addSettingToggleListener('removeContinueWatchingToggle', 'removeContinueWatchingEnabled', 'feature_remove_continue_watching');
    addSettingToggleListener('hideFavoritesTabToggle', 'hideFavoritesTab', 'feature_hide_favorites_tab');
    addSettingToggleListener('qualityTagsToggle', 'qualityTagsEnabled', 'feature_quality_tags', true);
    // Show or hide the nested category section when the master quality-tags toggle changes
    const qualityMasterToggle = document.getElementById('qualityTagsToggle') as HTMLInputElement | null;
    const qualitySubWrap = document.getElementById('qualityTagsSubWrap');
    const qualitySubGroup = document.getElementById('qualityTagsSubToggles');
    const qualitySubExpander = document.getElementById('qualityTagsSubToggleExpander');
    if (qualityMasterToggle && qualitySubWrap) {
        qualityMasterToggle.addEventListener('change', () => {
            qualitySubWrap.style.display = qualityMasterToggle.checked ? 'block' : 'none';
            // Collapse the category list when the feature is turned off so it
            // returns collapsed the next time the user enables it
            if (!qualityMasterToggle.checked && qualitySubGroup && qualitySubExpander) {
                qualitySubGroup.style.display = 'none';
                qualitySubExpander.setAttribute('aria-expanded', 'false');
            }
        });
    }
    // Expand or collapse the 6 category rows when the user clicks the chevron.
    // The chevron rotation is driven by CSS via the aria-expanded attribute.
    if (qualitySubExpander && qualitySubGroup) {
        qualitySubExpander.addEventListener('click', () => {
            const expanded = qualitySubExpander.getAttribute('aria-expanded') === 'true';
            qualitySubExpander.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            qualitySubGroup.style.display = expanded ? 'none' : 'block';
        });
    }
    // Wire the per-category sub-toggle controls via event delegation
    if (qualitySubGroup) {
        // Persist sub-toggle state and re-render existing cards with the new filter
        qualitySubGroup.addEventListener('change', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
            const row = target.closest<HTMLElement>('.jc-quality-cat-row');
            if (!row) return;
            const settingKey = row.dataset.catKey;
            if (!settingKey) return;
            (JC.currentSettings as any)[settingKey] = target.checked;
            void persistSettings();
            if (typeof (JC as any).reinitializeQualityTags === 'function' && JC.currentSettings!.qualityTagsEnabled) {
                (JC as any).reinitializeQualityTags();
            }
            resetAutoCloseTimer();
        });
        // Handle ↑/↓ stack reorder buttons
        qualitySubGroup.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.jc-cat-up, .jc-cat-down');
            if (!btn || btn.disabled) return;
            const row = btn.closest<HTMLElement>('.jc-quality-cat-row');
            if (!row) return;
            const isUp = btn.classList.contains('jc-cat-up');
            const sibling = isUp ? row.previousElementSibling : row.nextElementSibling;
            if (!sibling || !sibling.classList.contains('jc-quality-cat-row')) return;

            // Move the row in the DOM so the user sees the change immediately
            if (isUp) {
                sibling.parentNode!.insertBefore(row, sibling);
            } else {
                sibling.parentNode!.insertBefore(sibling, row);
            }

            // Normalize order values to 1..N from visual position so any
            // pre-existing duplicates (e.g. admin set two rows to the same
            // value via XML) self-heal on the next user reorder.
            const allRows = qualitySubGroup.querySelectorAll<HTMLElement>('.jc-quality-cat-row');
            allRows.forEach((r, idx) => {
                const orderKey = r.dataset.orderKey;
                if (orderKey) (JC.currentSettings as any)[orderKey] = idx + 1;
            });
            void persistSettings();

            refreshQualityCatArrowStates(qualitySubGroup);
            if (typeof (JC as any).reinitializeQualityTags === 'function' && JC.currentSettings!.qualityTagsEnabled) {
                (JC as any).reinitializeQualityTags();
            }
            resetAutoCloseTimer();
        });
    }

    /**
     * Updates ↑/↓ button enabled state to reflect each row's position in the list
     * @param {HTMLElement} group - The container holding the category rows
     */
    function refreshQualityCatArrowStates(group: HTMLElement) {
        const rows = group.querySelectorAll('.jc-quality-cat-row');
        rows.forEach((row, idx) => {
            const upBtn = row.querySelector<HTMLButtonElement>('.jc-cat-up');
            const downBtn = row.querySelector<HTMLButtonElement>('.jc-cat-down');
            const isFirst = idx === 0;
            const isLast = idx === rows.length - 1;
            if (upBtn) {
                upBtn.disabled = isFirst;
                upBtn.style.cursor = isFirst ? 'not-allowed' : 'pointer';
                upBtn.style.opacity = isFirst ? '0.4' : '1';
            }
            if (downBtn) {
                downBtn.disabled = isLast;
                downBtn.style.cursor = isLast ? 'not-allowed' : 'pointer';
                downBtn.style.opacity = isLast ? '0.4' : '1';
            }
        });
    }
    addSettingToggleListener('genreTagsToggle', 'genreTagsEnabled', 'feature_genre_tags', true);
    addSettingToggleListener('pauseScreenToggle', 'pauseScreenEnabled', 'feature_custom_pause_screen', true);

    const pauseScreenDelayInput = document.getElementById('pauseScreenDelayInput') as HTMLInputElement | null;
    if (pauseScreenDelayInput) {
        pauseScreenDelayInput.addEventListener('change', () => {
            const val = Math.max(1, Math.min(60, parseInt(pauseScreenDelayInput.value, 10) || 5));
            pauseScreenDelayInput.value = String(val);
            (JC.currentSettings as any).pauseScreenDelaySeconds = val;
            void persistSettings();
        });
    }
    addSettingToggleListener('languageTagsToggle', 'languageTagsEnabled', 'feature_language_tags', true);
    addSettingToggleListener('ratingTagsToggle', 'ratingTagsEnabled', 'feature_rating_tags', true);
    addSettingToggleListener('peopleTagsToggle', 'peopleTagsEnabled', 'feature_people_tags', true);
    addSettingToggleListener('tagsHideOnHoverToggle', 'tagsHideOnHover', 'feature_tags_hide_on_hover', false);
    // Live-toggle the body class so hover fade CSS applies immediately (no refresh needed)
    const hideOnHoverCheckbox = document.getElementById('tagsHideOnHoverToggle') as HTMLInputElement | null;
    if (hideOnHoverCheckbox) {
        hideOnHoverCheckbox.addEventListener('change', () => {
            document.body.classList.toggle('jc-tags-hide-on-hover', hideOnHoverCheckbox.checked);
        });
    }
    addSettingToggleListener('disableCustomSubtitleStyles', 'disableCustomSubtitleStyles', 'feature_disable_custom_subtitle_styles', true);
    addSettingToggleListener('longPress2xEnabled', 'longPress2xEnabled', 'feature_long_press_2x_speed');

    // Inline custom subtitle color pickers
    const customTextColorPicker = document.getElementById('customSubtitleTextColorPicker') as HTMLInputElement | null;
    const customTextAlpha = document.getElementById('customSubtitleTextAlpha') as HTMLInputElement | null;
    const customBgColorPicker = document.getElementById('customSubtitleBgColorPicker') as HTMLInputElement | null;
    const customBgAlpha = document.getElementById('customSubtitleBgAlpha') as HTMLInputElement | null;

    const updateCustomSubtitleColors = () => {
        const textColor = customTextColorPicker!.value + parseInt(customTextAlpha!.value).toString(16).padStart(2, '0').toUpperCase();
        const bgColor = customBgColorPicker!.value + parseInt(customBgAlpha!.value).toString(16).padStart(2, '0').toUpperCase();

        (JC.currentSettings as any).customSubtitleTextColor = textColor;
        (JC.currentSettings as any).customSubtitleBgColor = bgColor;
        (JC.currentSettings as any).usingCustomColors = true;

        // Remove border from all style presets
        const styleContainer = document.getElementById('subtitle-style-presets-container');
        if (styleContainer) {
            styleContainer.querySelectorAll<HTMLElement>('.preset-box').forEach(box => {
                box.style.border = '2px solid transparent';
            });
        }

        // Update live preview
        const preview = document.getElementById('subtitleColorPreview');
        if (preview) {
            preview.style.color = textColor;
            preview.style.backgroundColor = bgColor;
        }

        void persistSettings();
        (JC as any).applySavedStylesWhenReady();
        resetAutoCloseTimer();
    };

    if (customTextColorPicker) customTextColorPicker.addEventListener('input', updateCustomSubtitleColors);
    if (customTextAlpha) customTextAlpha.addEventListener('input', updateCustomSubtitleColors);
    if (customBgColorPicker) customBgColorPicker.addEventListener('input', updateCustomSubtitleColors);
    if (customBgAlpha) customBgAlpha.addEventListener('input', updateCustomSubtitleColors);

    // --- Subtitle position drag grid ---
    const posGrid = document.getElementById('subtitlePositionGrid');
    const posPreview = document.getElementById('subtitlePositionPreview');
    const posResetBtn = document.getElementById('subtitlePositionReset');

    if (posGrid) {
        const updatePosition = (xPct: number, yPct: number) => {
            if (!JC.identity.isCurrent(identityContext)) return;
            xPct = Math.max(2, Math.min(98, xPct));
            yPct = Math.max(2, Math.min(98, yPct));
            if (posPreview) {
                posPreview.style.left = `${xPct}%`;
                posPreview.style.top = `${yPct}%`;
            }
            (JC.currentSettings as any).subtitleHorizontalPosition = Math.round(xPct);
            (JC.currentSettings as any).subtitleVerticalPosition = Math.round(yPct);
            if (typeof (JC as any).applySubtitlePosition === 'function') (JC as any).applySubtitlePosition();
        };

        const getPctFromEvent = (e: any) => {
            const rect = posGrid.getBoundingClientRect();
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            return {
                x: ((clientX - rect.left) / rect.width) * 100,
                y: ((clientY - rect.top) / rect.height) * 100
            };
        };

        let dragging = false;

        posGrid.addEventListener('mousedown', (e) => {
            if (!JC.identity.isCurrent(identityContext)) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            dragging = true;
            e.preventDefault();
        });

        const handlePositionMouseMove = (e: MouseEvent) => {
            if (!JC.identity.isCurrent(identityContext)) return;
            if (!dragging) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            resetAutoCloseTimer();
        };

        const handlePositionMouseUp = () => {
            if (!JC.identity.isCurrent(identityContext)) return;
            if (!dragging) return;
            dragging = false;
            void persistSettings();
        };

        posGrid.addEventListener('touchstart', (e) => {
            if (!JC.identity.isCurrent(identityContext)) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            dragging = true;
            e.preventDefault();
        }, { passive: false });

        const handlePositionTouchMove = (e: TouchEvent) => {
            if (!JC.identity.isCurrent(identityContext)) return;
            if (!dragging) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            resetAutoCloseTimer();
        };

        const handlePositionTouchEnd = () => {
            if (!JC.identity.isCurrent(identityContext)) return;
            if (!dragging) return;
            dragging = false;
            void persistSettings();
        };

        document.addEventListener('mousemove', handlePositionMouseMove);
        document.addEventListener('mouseup', handlePositionMouseUp);
        document.addEventListener('touchmove', handlePositionTouchMove, { passive: true });
        document.addEventListener('touchend', handlePositionTouchEnd);
        registerCleanup(() => {
            dragging = false;
            document.removeEventListener('mousemove', handlePositionMouseMove);
            document.removeEventListener('mouseup', handlePositionMouseUp);
            document.removeEventListener('touchmove', handlePositionTouchMove);
            document.removeEventListener('touchend', handlePositionTouchEnd);
        });
    }

    if (posResetBtn) {
        posResetBtn.addEventListener('click', () => {
            (JC.currentSettings as any).subtitleHorizontalPosition = 50;
            (JC.currentSettings as any).subtitleVerticalPosition = 85;
            if (posPreview) { posPreview.style.left = '50%'; posPreview.style.top = '85%'; }
            if (typeof (JC as any).applySubtitlePosition === 'function') (JC as any).applySubtitlePosition();
            void persistSettings();
            resetAutoCloseTimer();
        });
    }
}

/**
 * Wires the remaining panel controls: random-button item types, the
 * release-notes button, tag position selectors and subtitle preset grids.
 * @param {object} ctx Shared panel context assembled in settings-panel/panel.ts.
 */
export function wireMiscSettingsControls(ctx: PanelContext): void {
    const { help, primaryAccentColor, resetAutoCloseTimer } = ctx;

    const wireRandomType = (id: string, otherId: string, settingKey: string, label: string) => {
        document.getElementById(id)!.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            if (!target.checked && !(document.getElementById(otherId) as HTMLInputElement).checked) {
                target.checked = true;
                toast(JC.t!('toast_at_least_one_item_type'));
                return;
            }
            (JC.currentSettings as any)[settingKey] = target.checked;
            const successMessage = JC.t!('toast_random_selection_status', {
                item_type: label,
                status: target.checked ? JC.t!('selection_included') : JC.t!('selection_excluded')
            });
            void persistSettings().then(saved => { if (saved) toast(successMessage); });
            resetAutoCloseTimer();
        });
    };
    wireRandomType('randomIncludeMovies', 'randomIncludeShows', 'randomIncludeMovies', 'Movies');
    wireRandomType('randomIncludeShows', 'randomIncludeMovies', 'randomIncludeShows', 'Shows');

    document.getElementById('releaseNotesBtn')!.addEventListener('click', () => { void (async () => { await showReleaseNotesNotification(); resetAutoCloseTimer(); })(); });

    // --- Position Selectors ---
    const positionSelectors = help.querySelectorAll<HTMLElement>('.position-selector');
    positionSelectors.forEach(selector => {
        const settingKey = selector.dataset.setting!;
        const cells = selector.querySelectorAll<HTMLElement>('[data-pos]');

        // Highlight current position
        const updateHighlight = () => {
            const currentPos = (JC.currentSettings as any)[settingKey] || 'top-left';
            cells.forEach(cell => {
                if (cell.dataset.pos === currentPos) {
                    cell.style.background = primaryAccentColor;
                } else {
                    cell.style.background = 'rgba(255,255,255,0.1)';
                }
            });
        };
        updateHighlight();

        // Click handler
        selector.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]');
            if (!cell) return;

            const newPos = cell.dataset.pos;
            (JC.currentSettings as any)[settingKey] = newPos;
            const save = persistSettings();
            updateHighlight();

            // Reinitialize tags dynamically based on which position changed
            if (settingKey === 'qualityTagsPosition' && JC.currentSettings!.qualityTagsEnabled) {
                if (typeof (JC as any).reinitializeQualityTags === 'function') {
                    (JC as any).reinitializeQualityTags();
                }
            } else if (settingKey === 'genreTagsPosition' && JC.currentSettings!.genreTagsEnabled) {
                if (typeof (JC as any).reinitializeGenreTags === 'function') {
                    (JC as any).reinitializeGenreTags();
                }
            } else if (settingKey === 'languageTagsPosition' && JC.currentSettings!.languageTagsEnabled) {
                if (typeof (JC as any).reinitializeLanguageTags === 'function') {
                    (JC as any).reinitializeLanguageTags();
                }
            } else if (settingKey === 'ratingTagsPosition' && JC.currentSettings!.ratingTagsEnabled) {
                if (typeof (JC as any).reinitializeRatingTags === 'function') {
                    (JC as any).reinitializeRatingTags();
                }
            }

            void save.then(saved => { if (saved) toast('Position updated!'); });
            resetAutoCloseTimer();
        });
    });

    const setupPresetHandlers = (containerId: string, presets: any[], type: string) => {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.addEventListener('click', (e) => {
            const presetBox = (e.target as HTMLElement).closest<HTMLElement>(`.${type}-preset`);
            if (!presetBox) return;

            const presetIndex = parseInt(presetBox.dataset.presetIndex!, 10);
            const selectedPreset = presets[presetIndex];

            if (selectedPreset) {
                let successMessage = '';
                if (type === 'style') {
                    (JC.currentSettings as any).selectedStylePresetIndex = presetIndex;
                    (JC.currentSettings as any).usingCustomColors = false;
                    (JC.currentSettings as any).customSubtitleTextColor = selectedPreset.textColor;
                    (JC.currentSettings as any).customSubtitleBgColor = selectedPreset.bgColor;

                    // Update UI inputs
                    const textColorPicker = document.getElementById('customSubtitleTextColorPicker') as HTMLInputElement | null;
                    const textAlphaSlider = document.getElementById('customSubtitleTextAlpha') as HTMLInputElement | null;
                    const bgColorPicker = document.getElementById('customSubtitleBgColorPicker') as HTMLInputElement | null;
                    const bgAlphaSlider = document.getElementById('customSubtitleBgAlpha') as HTMLInputElement | null;
                    const preview = document.getElementById('subtitleColorPreview');

                    if (textColorPicker && textAlphaSlider) {
                        textColorPicker.value = selectedPreset.textColor.substring(0, 7);
                        textAlphaSlider.value = String(parseInt(selectedPreset.textColor.substring(7, 9) || 'FF', 16));
                    }
                    if (bgColorPicker && bgAlphaSlider) {
                        bgColorPicker.value = selectedPreset.bgColor.substring(0, 7);
                        bgAlphaSlider.value = String(parseInt(selectedPreset.bgColor.substring(7, 9) || '00', 16));
                    }
                    if (preview) {
                        preview.style.color = selectedPreset.textColor;
                        preview.style.backgroundColor = selectedPreset.bgColor;
                    }

                    const fontSizeIndex = (JC.currentSettings as any).selectedFontSizePresetIndex ?? 2;
                    const fontFamilyIndex = (JC.currentSettings as any).selectedFontFamilyPresetIndex ?? 0;
                    const fontSize = (JC as any).fontSizePresets[fontSizeIndex].size;
                    const fontFamily = (JC as any).fontFamilyPresets[fontFamilyIndex].family;
                    (JC as any).applySubtitleStyles(selectedPreset.textColor, selectedPreset.bgColor, fontSize, fontFamily, selectedPreset.textShadow);
                    successMessage = JC.t!('toast_subtitle_style', { style: escapeHtml(selectedPreset.name) });
                } else if (type === 'font-size') {
                    (JC.currentSettings as any).selectedFontSizePresetIndex = presetIndex;
                    const fontFamilyIndex = (JC.currentSettings as any).selectedFontFamilyPresetIndex ?? 0;
                    const fontFamily = (JC as any).fontFamilyPresets[fontFamilyIndex].family;

                    // Use saved custom colors
                    const textColor = (JC.currentSettings as any).customSubtitleTextColor || '#FFFFFFFF';
                    const bgColor = (JC.currentSettings as any).customSubtitleBgColor || '#00000000';
                    const textShadow = bgColor === 'transparent' || bgColor === '#00000000'
                        ? '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000'
                        : 'none';

                    (JC as any).applySubtitleStyles(textColor, bgColor, selectedPreset.size, fontFamily, textShadow);
                    successMessage = JC.t!('toast_subtitle_size', { size: escapeHtml(selectedPreset.name) });
                } else if (type === 'font-family') {
                    (JC.currentSettings as any).selectedFontFamilyPresetIndex = presetIndex;
                    const fontSizeIndex = (JC.currentSettings as any).selectedFontSizePresetIndex ?? 2;
                    const fontSize = (JC as any).fontSizePresets[fontSizeIndex].size;

                    // Use saved custom colors
                    const textColor = (JC.currentSettings as any).customSubtitleTextColor || '#FFFFFFFF';
                    const bgColor = (JC.currentSettings as any).customSubtitleBgColor || '#00000000';
                    const textShadow = bgColor === 'transparent' || bgColor === '#00000000'
                        ? '0 0 4px #000, 0 0 8px #000, 1px 1px 2px #000'
                        : 'none';

                    (JC as any).applySubtitleStyles(textColor, bgColor, fontSize, selectedPreset.family, textShadow);
                    successMessage = JC.t!('toast_subtitle_font', { font: escapeHtml(selectedPreset.name) });
                }

                void persistSettings().then(saved => {
                    if (saved && successMessage) toast(successMessage);
                });
                container.querySelectorAll<HTMLElement>('.preset-box').forEach(box => {
                    box.style.border = '2px solid transparent';
                });
                presetBox.style.border = `2px solid ${primaryAccentColor}`;
                resetAutoCloseTimer();
            }
        });

        let currentIndex;
        if (type === 'style') {
            currentIndex = (JC.currentSettings as any).selectedStylePresetIndex ?? 0;
            // Only highlight if not using custom colors
            if (!JC.currentSettings!.usingCustomColors) {
                const activeBox = container.querySelector<HTMLElement>(`[data-preset-index="${currentIndex}"]`);
                if (activeBox) {
                    activeBox.style.border = `2px solid ${primaryAccentColor}`;
                }
            }
        } else if (type === 'font-size') {
            currentIndex = (JC.currentSettings as any).selectedFontSizePresetIndex ?? 2;
            const activeBox = container.querySelector<HTMLElement>(`[data-preset-index="${currentIndex}"]`);
            if (activeBox) {
                activeBox.style.border = `2px solid ${primaryAccentColor}`;
            }
        } else if (type === 'font-family') {
            currentIndex = (JC.currentSettings as any).selectedFontFamilyPresetIndex ?? 0;
            const activeBox = container.querySelector<HTMLElement>(`[data-preset-index="${currentIndex}"]`);
            if (activeBox) {
                activeBox.style.border = `2px solid ${primaryAccentColor}`;
            }
        }
    };

    setupPresetHandlers('subtitle-style-presets-container', (JC as any).subtitlePresets, 'style');
    setupPresetHandlers('font-size-presets-container', (JC as any).fontSizePresets, 'font-size');
    setupPresetHandlers('font-family-presets-container', (JC as any).fontFamilyPresets, 'font-family');
}
