// src/enhanced/settings-panel/settings.ts
//
// Settings-tab wiring: feature toggles, quality-tag categories, subtitle
// styling/position controls, tag position selectors and subtitle presets.
// Split from ui.js (code motion; bodies verbatim).
// (Converted from js/enhanced/ui-panel-settings.js — bodies semantically identical.)

import { JC } from '../../globals';
import { escapeHtml, toast } from '../../core/ui-kit';
import { canonicalizeAudioLanguagePreference } from '../../tags/audio-track-selection';
import {
    applySubtitlePreviewStyle,
    clampSubtitleHorizontal,
    clampSubtitleVertical,
    resolveSubtitleStyle,
} from '../subtitle-style-contract';
import {
    RATING_TAG_ITEM_TYPES,
    RATING_TAG_SCOPE_SCHEMA_VERSION,
    RATING_TAG_SURFACES,
    type RatingTagScopePolicy,
} from '../../tags/rating-tag-scope';
import { showReleaseNotesNotification } from './release-notes';
import type { PanelContext } from './panel';
import {
    AdminTargetPersistenceError,
    createSelfPanelEditorContext,
    type PanelEditorContext,
} from './editor-context';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

let legacyReconcileInFlight: Promise<void> | null = null;

async function reconcileAfterFailure(ctx: PanelContext, editor: PanelEditorContext): Promise<void> {
    if (typeof ctx.reconcileAfterSaveFailure === 'function') {
        await ctx.reconcileAfterSaveFailure();
        return;
    }
    if (legacyReconcileInFlight) {
        await legacyReconcileInFlight;
        return;
    }
    const panel = document.getElementById('jellyfin-canopy-panel');
    if (!panel || typeof JC.showEnhancedPanel !== 'function') return;
    legacyReconcileInFlight = (async () => {
        try {
            await JC.showEnhancedPanel!();
            if (!editor.isCurrent()) return;
            await JC.showEnhancedPanel!();
        } finally {
            legacyReconcileInFlight = null;
        }
    })();
    await legacyReconcileInFlight;
}

/** Persist through the editor that owns this panel; target failures rebuild only target-local UI. */
function persistEditorSettings(
    ctx: PanelContext,
    editor: PanelEditorContext,
    shouldDeferFailureReconciliation: () => boolean = () => false,
): Promise<boolean> {
    let request: ReturnType<PanelEditorContext['saveSettings']>;
    try {
        request = editor.saveSettings();
    } catch (error) {
        request = Promise.reject(error);
    }
    return Promise.resolve(request).then(
        () => true,
        async (error: unknown) => {
            const classified = error instanceof AdminTargetPersistenceError ? error : null;
            if (classified?.kind === 'cancelled' || !editor.isCurrent()) {
                if (editor.appliesToActor && JC.identity.isCurrent(editor.actor)) {
                    reapplyAcknowledgedSideEffects();
                }
                return false;
            }
            if (editor.mode === 'admin-target') {
                const key = classified?.kind === 'authorization'
                    ? 'panel_admin_target_unauthorized'
                    : classified?.kind === 'conflict'
                        ? 'panel_admin_target_conflict_error'
                        : 'panel_admin_target_save_error';
                toast(JC.t!(key), undefined, 'error');
            }
            if (!shouldDeferFailureReconciliation()) {
                await reconcileAfterFailure(ctx, editor);
            }
            if (editor.appliesToActor && JC.identity.isCurrent(editor.actor)) {
                reapplyAcknowledgedSideEffects();
            }
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
    const editor = ctx.editor || createSelfPanelEditorContext(identityContext || JC.identity.capture()!);
    const settings = editor.settings as Record<string, any>;
    const appliesToActor = editor.appliesToActor;
    let audioLanguageIntent = 0;
    let acknowledgedAudioGeneration = 0;
    let acknowledgedAudioLanguage = settings.preferredAudioLanguage as string | null | undefined;
    type AudioGeneration = {
        id: number;
        value: string | null;
        inFlight: number;
        succeeded: boolean;
    };
    let pendingAudioGeneration: AudioGeneration | null = null;
    let ratingScopeIntent = 0;
    let acknowledgedRatingScopeGeneration = 0;
    let acknowledgedRatingScope: unknown = settings.ratingTagScopeOverrides;
    type RatingScopeGeneration = {
        id: number;
        value: RatingTagScopePolicy;
        inFlight: number;
        succeeded: boolean;
    };
    let pendingRatingScopeGeneration: RatingScopeGeneration | null = null;
    const publishAcknowledgedAudioLanguage = (showSavedToast: boolean): void => {
        const liveSettings = appliesToActor && JC.identity.isCurrent(editor.actor) && JC.currentSettings
            ? JC.currentSettings as Record<string, any>
            : settings;
        const changed = liveSettings.preferredAudioLanguage !== acknowledgedAudioLanguage;
        liveSettings.preferredAudioLanguage = acknowledgedAudioLanguage;
        if (liveSettings !== settings) settings.preferredAudioLanguage = acknowledgedAudioLanguage;
        if ((showSavedToast || changed) && liveSettings.qualityTagsEnabled
            && typeof (JC as any).reinitializeQualityTags === 'function') {
            (JC as any).reinitializeQualityTags();
        }
        if (showSavedToast) toast(JC.t!('panel_settings_ui_preferred_audio_language_saved'));
    };
    const settleAudioCarrier = (generation: AudioGeneration, saved: boolean): void => {
        generation.inFlight = Math.max(0, generation.inFlight - 1);
        if (!editor.isCurrent() || !JC.identity.isCurrent(editor.actor)) return;
        if (saved) {
            generation.succeeded = true;
            if (generation.id >= acknowledgedAudioGeneration) {
                acknowledgedAudioGeneration = generation.id;
                acknowledgedAudioLanguage = generation.value;
            }
            if (pendingAudioGeneration === generation) {
                pendingAudioGeneration = null;
                publishAcknowledgedAudioLanguage(true);
            }
            return;
        }
        if (!generation.succeeded && generation.inFlight === 0
            && pendingAudioGeneration === generation) {
            pendingAudioGeneration = null;
            publishAcknowledgedAudioLanguage(false);
        }
    };
    const publishAcknowledgedRatingScope = (showSavedToast: boolean): void => {
        const liveSettings = appliesToActor && JC.identity.isCurrent(editor.actor) && JC.currentSettings
            ? JC.currentSettings as Record<string, any>
            : settings;
        const changed = liveSettings.ratingTagScopeOverrides !== acknowledgedRatingScope;
        liveSettings.ratingTagScopeOverrides = acknowledgedRatingScope;
        if (liveSettings !== settings) settings.ratingTagScopeOverrides = acknowledgedRatingScope;
        if ((changed || showSavedToast) && liveSettings.ratingTagsEnabled
            && typeof (JC as any).reinitializeRatingTags === 'function') {
            (JC as any).reinitializeRatingTags();
        }
        if (showSavedToast) toast(JC.t!('panel_settings_rating_scope_saved'));
    };
    const settleRatingScopeCarrier = (generation: RatingScopeGeneration, saved: boolean): void => {
        generation.inFlight = Math.max(0, generation.inFlight - 1);
        if (!editor.isCurrent() || !JC.identity.isCurrent(editor.actor)) return;
        if (saved) {
            generation.succeeded = true;
            if (generation.id >= acknowledgedRatingScopeGeneration) {
                acknowledgedRatingScopeGeneration = generation.id;
                acknowledgedRatingScope = generation.value;
            }
            if (pendingRatingScopeGeneration === generation) {
                pendingRatingScopeGeneration = null;
                publishAcknowledgedRatingScope(true);
            }
            return;
        }
        if (!generation.succeeded && generation.inFlight === 0
            && pendingRatingScopeGeneration === generation) {
            pendingRatingScopeGeneration = null;
            publishAcknowledgedRatingScope(false);
        }
    };
    const persistSettings = (): Promise<boolean> => {
        const audioGeneration = pendingAudioGeneration;
        const ratingGeneration = pendingRatingScopeGeneration;
        if (!appliesToActor || (!audioGeneration && !ratingGeneration)) {
            return persistEditorSettings(ctx, editor);
        }
        // All settings saves serialize the whole self-owned object. Overlay the
        // pending audio intent for every synchronous capture so an unrelated
        // setting edit cannot persist the renderer's older acknowledged value.
        if (audioGeneration) settings.preferredAudioLanguage = audioGeneration.value;
        if (ratingGeneration) settings.ratingTagScopeOverrides = ratingGeneration.value;
        let request: Promise<boolean>;
        try {
            request = persistEditorSettings(
                ctx,
                editor,
                () => (audioGeneration !== null && pendingAudioGeneration !== null
                        && (pendingAudioGeneration !== audioGeneration || audioGeneration.inFlight > 1))
                    || (ratingGeneration !== null && pendingRatingScopeGeneration !== null
                        && (pendingRatingScopeGeneration !== ratingGeneration || ratingGeneration.inFlight > 1)),
            );
        } finally {
            if (audioGeneration) settings.preferredAudioLanguage = acknowledgedAudioLanguage;
            if (ratingGeneration) settings.ratingTagScopeOverrides = acknowledgedRatingScope;
        }
        if (audioGeneration) {
            audioGeneration.inFlight++;
            void request.then((saved) => settleAudioCarrier(audioGeneration, saved));
        }
        if (ratingGeneration) {
            ratingGeneration.inFlight++;
            void request.then((saved) => settleRatingScopeCarrier(ratingGeneration, saved));
        }
        return request;
    };

    const ratingScopeContainer = document.getElementById('ratingTagScopeOverrides');
    ratingScopeContainer?.addEventListener('change', (event) => {
        const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-rating-scope-kind][data-rating-scope-value]');
        if (!input || input.disabled) return;
        input.dataset.userDenied = input.checked ? 'false' : 'true';
        const deniedItemTypes = new Set<string>();
        const deniedSurfaces = new Set<string>();
        ratingScopeContainer.querySelectorAll<HTMLInputElement>('[data-rating-scope-kind][data-rating-scope-value]')
            .forEach((candidate) => {
                if (candidate.dataset.userDenied !== 'true') return;
                const value = candidate.dataset.ratingScopeValue;
                if (!value) return;
                if (candidate.dataset.ratingScopeKind === 'itemType') deniedItemTypes.add(value);
                else deniedSurfaces.add(value);
            });
        const value: RatingTagScopePolicy = Object.freeze({
            version: RATING_TAG_SCOPE_SCHEMA_VERSION,
            disabledItemTypes: Object.freeze(RATING_TAG_ITEM_TYPES.filter((entry) => deniedItemTypes.has(entry))),
            disabledSurfaces: Object.freeze(RATING_TAG_SURFACES.filter((entry) => deniedSurfaces.has(entry))),
        });
        if (!appliesToActor) {
            settings.ratingTagScopeOverrides = value;
            void persistSettings();
            resetAutoCloseTimer();
            return;
        }
        const generation: RatingScopeGeneration = {
            id: ++ratingScopeIntent,
            value,
            inFlight: 0,
            succeeded: false,
        };
        pendingRatingScopeGeneration = generation;
        void persistSettings();
        resetAutoCloseTimer();
    });

    const addSettingToggleListener = (id: string, settingKey: string, featureKey: string, requiresRefresh = false) => {
        document.getElementById(id)!.addEventListener('change', (e) => {
            settings[settingKey] = (e.target as HTMLInputElement).checked;
            const save = persistSettings();
            let toastMessage = createToast!(featureKey, (e.target as HTMLInputElement).checked);

            // Runtime/page side effects belong only to the acting user's own
            // editor. Target edits remain server-side until that user loads them.
            if (appliesToActor && id === 'qualityTagsToggle') {
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
            } else if (appliesToActor && id === 'genreTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    if (typeof (JC as any).initializeGenreTags === 'function') {
                        (JC as any).initializeGenreTags();
                    }
                } else {
                    document.querySelectorAll('.genre-overlay-container').forEach(el => el.remove());
                }
                requiresRefresh = false;
            } else if (appliesToActor && id === 'languageTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    if (typeof (JC as any).initializeLanguageTags === 'function') {
                        (JC as any).initializeLanguageTags();
                    }
                } else {
                    document.querySelectorAll('.language-overlay-container').forEach(el => el.remove());
                }
                requiresRefresh = false;
            } else if (appliesToActor && id === 'ratingTagsToggle') {
                if ((e.target as HTMLInputElement).checked) {
                    if (typeof (JC as any).initializeRatingTags === 'function') {
                        (JC as any).initializeRatingTags();
                    }
                } else {
                    document.querySelectorAll('.rating-overlay-container').forEach(el => el.remove());
                }
                requiresRefresh = false;
            } else if (appliesToActor && id === 'peopleTagsToggle') {
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
                if (editor.mode === 'admin-target') {
                    toastMessage += `<br>${escapeHtml(
                        JC.t!('panel_admin_target_refresh_notice'),
                    )}`;
                } else {
                    toastMessage += ".<br> Refresh page to apply.";
                }
            }
            void save.then(async saved => {
                if (!saved) return;
                if (appliesToActor && id === 'animeFillerWarningsToggle' && identityContext) {
                    await JC.core.clientRuntime?.reconcileUserSettings(identityContext);
                }
                toast(toastMessage);
            });
            if (appliesToActor && id === 'randomButtonToggle') (JC as any).addRandomButton();
            if (appliesToActor && id === 'hideFavoritesTabToggle') (JC as any).applyHideFavoritesTab?.();
            if (appliesToActor && id === 'showWatchProgressToggle' && !(e.target as HTMLInputElement).checked) document.querySelectorAll('.mediaInfoItem-watchProgress').forEach(el => el.remove());
            if (appliesToActor && id === 'showFileSizesToggle' && !(e.target as HTMLInputElement).checked) document.querySelectorAll('.mediaInfoItem-fileSize').forEach(el => el.remove());
            if (appliesToActor && id === 'showFileSourceToggle' && !(e.target as HTMLInputElement).checked) document.querySelectorAll('.mediaInfoItem-fileSource').forEach(el => el.remove());
            if (appliesToActor && id === 'showAudioLanguagesToggle' && !(e.target as HTMLInputElement).checked) document.querySelectorAll('.mediaInfoItem-audioLanguage').forEach(el => el.remove());
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
                    settings.watchProgressMode = (e.target as HTMLSelectElement).value;
                    void persistSettings();
                    resetAutoCloseTimer();
                });
            }
            if (fmtSel) {
                fmtSel.addEventListener('change', (e) => {
                    settings.watchProgressTimeFormat = (e.target as HTMLSelectElement).value;
                    void persistSettings();
                    resetAutoCloseTimer();
                });
            }
    addSettingToggleListener('showFileSizesToggle', 'showFileSizes', 'feature_file_size_display');
    addSettingToggleListener('showFileSourceToggle', 'showFileSource', 'panel_settings_ui_file_source');
    addSettingToggleListener('showAudioLanguagesToggle', 'showAudioLanguages', 'feature_audio_language_display');
    addSettingToggleListener('removeContinueWatchingToggle', 'removeContinueWatchingEnabled', 'feature_remove_continue_watching');
    addSettingToggleListener('hideFavoritesTabToggle', 'hideFavoritesTab', 'feature_hide_favorites_tab');
    if (document.getElementById('animeFillerWarningsToggle')) {
        addSettingToggleListener('animeFillerWarningsToggle', 'animeFillerWarningsEnabled', 'feature_anime_filler_warnings');
    }
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

    const audioLanguageMode = document.getElementById('preferredAudioLanguageMode') as HTMLSelectElement | null;
    const audioLanguageInput = document.getElementById('preferredAudioLanguageInput') as HTMLInputElement | null;
    const updateAudioLanguageInput = (): void => {
        if (!audioLanguageMode || !audioLanguageInput) return;
        const custom = audioLanguageMode.value === 'custom';
        audioLanguageInput.disabled = !custom;
        audioLanguageInput.closest<HTMLElement>('.jc-preferred-audio-custom')!.style.display = custom ? 'block' : 'none';
    };
    const commitAudioLanguagePreference = (): void => {
        if (!audioLanguageMode || !audioLanguageInput) return;
        let next: string | null;
        if (audioLanguageMode.value === 'inherit') {
            next = null;
        } else if (audioLanguageMode.value === 'automatic') {
            next = '';
        } else {
            const canonical = canonicalizeAudioLanguagePreference(audioLanguageInput.value);
            if (canonical === null || canonical === '') {
                audioLanguageInput.setCustomValidity(JC.t!('panel_settings_ui_preferred_audio_language_invalid'));
                audioLanguageInput.reportValidity();
                return;
            }
            next = canonical;
            audioLanguageInput.value = canonical;
        }
        audioLanguageInput.setCustomValidity('');
        const intent = ++audioLanguageIntent;
        const generation: AudioGeneration = {
            id: intent,
            value: next,
            inFlight: 0,
            succeeded: false,
        };
        pendingAudioGeneration = generation;
        let save: Promise<boolean>;
        if (appliesToActor) {
            save = persistSettings();
        } else {
            settings.preferredAudioLanguage = next;
            save = persistSettings();
        }
        void save.then((saved) => {
            if (!editor.isCurrent()) return;
            if (appliesToActor && !JC.identity.isCurrent(editor.actor)) return;
            if (!appliesToActor && saved && intent === audioLanguageIntent) {
                toast(JC.t!('panel_settings_ui_preferred_audio_language_saved'));
            }
        });
        resetAutoCloseTimer();
    };
    audioLanguageMode?.addEventListener('change', () => {
        updateAudioLanguageInput();
        if (audioLanguageMode.value !== 'custom') commitAudioLanguagePreference();
    });
    audioLanguageInput?.addEventListener('change', commitAudioLanguagePreference);
    updateAudioLanguageInput();

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
            settings[settingKey] = target.checked;
            void persistSettings();
            if (appliesToActor && typeof (JC as any).reinitializeQualityTags === 'function' && settings.qualityTagsEnabled) {
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
                if (orderKey) settings[orderKey] = idx + 1;
            });
            void persistSettings();

            refreshQualityCatArrowStates(qualitySubGroup);
            if (appliesToActor && typeof (JC as any).reinitializeQualityTags === 'function' && settings.qualityTagsEnabled) {
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
        // Jellyfin owns document-level digit shortcuts too. Returning early in
        // Canopy's dispatcher is insufficient: contain editing keys at the
        // control so the host player cannot interpret them as percentage seeks.
        pauseScreenDelayInput.addEventListener('keydown', (event) => event.stopPropagation());
        pauseScreenDelayInput.addEventListener('change', () => {
            const val = Math.max(1, Math.min(60, parseInt(pauseScreenDelayInput.value, 10) || 5));
            pauseScreenDelayInput.value = String(val);
            settings.pauseScreenDelaySeconds = val;
            if (appliesToActor && editor.isCurrent() && JC.identity.isCurrent(editor.actor)) {
                JC._pauseScreenInstance?.setDelaySeconds(val);
            }
            // The central settings queue reconciles the live pause runtime
            // after the final whole-object carrier is acknowledged or rolled back.
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
            if (appliesToActor) {
                document.body.classList.toggle('jc-tags-hide-on-hover', hideOnHoverCheckbox.checked);
            }
        });
    }
    addSettingToggleListener('disableCustomSubtitleStyles', 'disableCustomSubtitleStyles', 'feature_disable_custom_subtitle_styles', true);
    addSettingToggleListener('longPress2xEnabled', 'longPress2xEnabled', 'feature_long_press_2x_speed');

    // Inline custom subtitle color pickers
    const customTextColorPicker = document.getElementById('customSubtitleTextColorPicker') as HTMLInputElement | null;
    const customTextAlpha = document.getElementById('customSubtitleTextAlpha') as HTMLInputElement | null;
    const customBgColorPicker = document.getElementById('customSubtitleBgColorPicker') as HTMLInputElement | null;
    const customBgAlpha = document.getElementById('customSubtitleBgAlpha') as HTMLInputElement | null;
    const posGrid = document.getElementById('subtitlePositionGrid');
    const posPreview = document.getElementById('subtitlePositionPreview');
    const posResetBtn = document.getElementById('subtitlePositionReset');

    const syncPositionPreview = () => {
        if (!editor.isCurrent() || !posPreview?.isConnected) return;
        applySubtitlePreviewStyle(posPreview, settings);
    };
    syncPositionPreview();

    const updateCustomSubtitleColors = () => {
        if (!editor.isCurrent()) return;
        const textColor = customTextColorPicker!.value + parseInt(customTextAlpha!.value).toString(16).padStart(2, '0').toUpperCase();
        const bgColor = customBgColorPicker!.value + parseInt(customBgAlpha!.value).toString(16).padStart(2, '0').toUpperCase();

        settings.customSubtitleTextColor = textColor;
        settings.customSubtitleBgColor = bgColor;
        settings.usingCustomColors = true;

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
        syncPositionPreview();

        void persistSettings();
        if (appliesToActor) (JC as any).applySavedStylesWhenReady();
        resetAutoCloseTimer();
    };

    if (customTextColorPicker) customTextColorPicker.addEventListener('input', updateCustomSubtitleColors);
    if (customTextAlpha) customTextAlpha.addEventListener('input', updateCustomSubtitleColors);
    if (customBgColorPicker) customBgColorPicker.addEventListener('input', updateCustomSubtitleColors);
    if (customBgAlpha) customBgAlpha.addEventListener('input', updateCustomSubtitleColors);

    // --- Subtitle position drag grid ---
    if (posGrid) {
        const updatePosition = (xPct: number, yPct: number) => {
            if (!editor.isCurrent()) return;
            settings.subtitleHorizontalPosition = Math.round(clampSubtitleHorizontal(xPct));
            settings.subtitleVerticalPosition = Math.round(clampSubtitleVertical(yPct));
            syncPositionPreview();
            if (appliesToActor && typeof (JC as any).applySubtitlePosition === 'function') (JC as any).applySubtitlePosition();
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
            if (!editor.isCurrent()) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            dragging = true;
            e.preventDefault();
        });

        const handlePositionMouseMove = (e: MouseEvent) => {
            if (!editor.isCurrent()) return;
            if (!dragging) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            resetAutoCloseTimer();
        };

        const handlePositionMouseUp = () => {
            if (!editor.isCurrent()) return;
            if (!dragging) return;
            dragging = false;
            void persistSettings();
        };

        posGrid.addEventListener('touchstart', (e) => {
            if (!editor.isCurrent()) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            dragging = true;
            e.preventDefault();
        }, { passive: false });

        const handlePositionTouchMove = (e: TouchEvent) => {
            if (!editor.isCurrent()) return;
            if (!dragging) return;
            const { x, y } = getPctFromEvent(e);
            updatePosition(x, y);
            resetAutoCloseTimer();
        };

        const handlePositionTouchEnd = () => {
            if (!editor.isCurrent()) return;
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
            settings.subtitleHorizontalPosition = 50;
            settings.subtitleVerticalPosition = 85;
            syncPositionPreview();
            if (appliesToActor && typeof (JC as any).applySubtitlePosition === 'function') (JC as any).applySubtitlePosition();
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
    const editor = ctx.editor || createSelfPanelEditorContext(ctx.identityContext || JC.identity.capture()!);
    const settings = editor.settings as Record<string, any>;
    const appliesToActor = editor.appliesToActor;
    const persistSettings = () => persistEditorSettings(ctx, editor);
    const subtitlePositionPreview = document.getElementById('subtitlePositionPreview');
    const syncPositionPreview = () => {
        if (!editor.isCurrent() || !subtitlePositionPreview?.isConnected) return;
        applySubtitlePreviewStyle(subtitlePositionPreview, settings);
    };
    syncPositionPreview();

    const wireRandomType = (id: string, otherId: string, settingKey: string, label: string) => {
        document.getElementById(id)!.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            if (!target.checked && !(document.getElementById(otherId) as HTMLInputElement).checked) {
                target.checked = true;
                toast(JC.t!('toast_at_least_one_item_type'));
                return;
            }
            settings[settingKey] = target.checked;
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
            const currentPos = settings[settingKey] || 'top-left';
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
            settings[settingKey] = newPos;
            const save = persistSettings();
            updateHighlight();

            // Reinitialize tags dynamically based on which position changed
            if (appliesToActor && settingKey === 'qualityTagsPosition' && settings.qualityTagsEnabled) {
                if (typeof (JC as any).reinitializeQualityTags === 'function') {
                    (JC as any).reinitializeQualityTags();
                }
            } else if (appliesToActor && settingKey === 'genreTagsPosition' && settings.genreTagsEnabled) {
                if (typeof (JC as any).reinitializeGenreTags === 'function') {
                    (JC as any).reinitializeGenreTags();
                }
            } else if (appliesToActor && settingKey === 'languageTagsPosition' && settings.languageTagsEnabled) {
                if (typeof (JC as any).reinitializeLanguageTags === 'function') {
                    (JC as any).reinitializeLanguageTags();
                }
            } else if (appliesToActor && settingKey === 'ratingTagsPosition' && settings.ratingTagsEnabled) {
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
            if (!editor.isCurrent()) return;
            const presetBox = (e.target as HTMLElement).closest<HTMLElement>(`.${type}-preset`);
            if (!presetBox) return;

            const presetIndex = parseInt(presetBox.dataset.presetIndex!, 10);
            const selectedPreset = presets[presetIndex];

            if (selectedPreset) {
                let successMessage = '';
                if (type === 'style') {
                    settings.selectedStylePresetIndex = presetIndex;
                    settings.usingCustomColors = false;
                    settings.customSubtitleTextColor = selectedPreset.textColor;
                    settings.customSubtitleBgColor = selectedPreset.bgColor;

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
                    syncPositionPreview();

                    const resolved = resolveSubtitleStyle(settings);
                    if (appliesToActor) (JC as any).applySubtitleStyles(
                        resolved.textColor,
                        resolved.backgroundColor,
                        resolved.fontSizeVw,
                        resolved.fontFamily,
                        resolved.textShadow,
                    );
                    successMessage = JC.t!('toast_subtitle_style', { style: escapeHtml(selectedPreset.name) });
                } else if (type === 'font-size') {
                    settings.selectedFontSizePresetIndex = presetIndex;
                    const resolved = resolveSubtitleStyle(settings);
                    if (appliesToActor) (JC as any).applySubtitleStyles(
                        resolved.textColor,
                        resolved.backgroundColor,
                        resolved.fontSizeVw,
                        resolved.fontFamily,
                        resolved.textShadow,
                    );
                    syncPositionPreview();
                    successMessage = JC.t!('toast_subtitle_size', { size: escapeHtml(selectedPreset.name) });
                } else if (type === 'font-family') {
                    settings.selectedFontFamilyPresetIndex = presetIndex;
                    const resolved = resolveSubtitleStyle(settings);
                    if (appliesToActor) (JC as any).applySubtitleStyles(
                        resolved.textColor,
                        resolved.backgroundColor,
                        resolved.fontSizeVw,
                        resolved.fontFamily,
                        resolved.textShadow,
                    );
                    syncPositionPreview();
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
            currentIndex = settings.selectedStylePresetIndex ?? 0;
            // Only highlight if not using custom colors
            if (!settings.usingCustomColors) {
                const activeBox = container.querySelector<HTMLElement>(`[data-preset-index="${currentIndex}"]`);
                if (activeBox) {
                    activeBox.style.border = `2px solid ${primaryAccentColor}`;
                }
            }
        } else if (type === 'font-size') {
            currentIndex = settings.selectedFontSizePresetIndex ?? 2;
            const activeBox = container.querySelector<HTMLElement>(`[data-preset-index="${currentIndex}"]`);
            if (activeBox) {
                activeBox.style.border = `2px solid ${primaryAccentColor}`;
            }
        } else if (type === 'font-family') {
            currentIndex = settings.selectedFontFamilyPresetIndex ?? 0;
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
