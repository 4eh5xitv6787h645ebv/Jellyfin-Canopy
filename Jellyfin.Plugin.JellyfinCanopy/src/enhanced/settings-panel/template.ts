// src/enhanced/settings-panel/template.ts
//
// Settings/help panel HTML template (shortcuts tab, settings sections,
// footer) built from the shared panel context.
// Split from ui.js (code motion; bodies semantically identical.)
// (Converted from js/enhanced/ui-panel-template.js — bodies semantically identical.)

import { JC } from '../../globals';
import { assetUrl } from '../../core/asset-urls';
import {
    canonicalizeShortcut,
    formatShortcut,
    PERCENTAGE_SHORTCUT_NAME,
} from '../shortcut-codec';
import { escapeHtml } from '../../core/ui-kit';
import { cssColorOr } from '../../core/css-safe';
import {
    clampSubtitleHorizontal,
    clampSubtitleVertical,
    resolveSubtitleStyle,
} from '../subtitle-style-contract';
import { GITHUB_REPO } from './release-notes';
import type { PanelContext } from './panel';
import {
    RATING_TAG_ITEM_TYPES,
    RATING_TAG_SURFACES,
    normalizeRatingTagScopePolicy,
} from '../../tags/rating-tag-scope';
import { normalizeLanguageTagFilter } from '../../tags/language-tag-filter';

/* eslint-disable @typescript-eslint/no-explicit-any */

// JC.t returns the raw key on miss; substitute the inline fallback. Mirrors elsewhere/reviews.js.
const _tFallbackWarned = new Set<string>();
function tWithFallback(
    key: string,
    fallback?: string,
    params?: Record<string, unknown>,
): string {
    let result;
    try {
        result = JC.t!(key, params);
    } catch (err) {
        console.warn(`🪼 Jellyfin Canopy: JC.t('${key}') threw, using fallback:`, err);
        result = null;
    }
    if (!result || result === key) {
        if (!_tFallbackWarned.has(key)) {
            _tFallbackWarned.add(key);
            console.warn(`🪼 Jellyfin Canopy: missing translation key '${key}', using inline fallback`);
        }
        return fallback || key;
    }
    return result;
}

interface ShortcutTemplateEntry {
    Name?: string;
    Key?: string;
    Label?: string;
    Category?: string;
}

function languageTagFilterControls(
    settings: Record<string, any>,
    background: string,
    inventory: PanelContext['languageTagInventory'],
): string {
    const raw = settings.languageTagFilter;
    const inherited = raw === null || raw === undefined;
    const normalized = normalizeLanguageTagFilter(raw);
    const languages = normalized && normalized.failClosed !== true ? normalized.languages : [];
    const known = new Set(inventory.languages);
    const ordered = [...languages, ...inventory.languages.filter((language) => !languages.includes(language))];
    return `<div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.12);">
        <label for="languageTagFilterMode" style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">${escapeHtml(tWithFallback('panel_settings_language_filter', 'Visible languages'))}</label>
        <select id="languageTagFilterMode" style="width:100%; padding:8px; background:${background}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px;"><option value="inherit" ${inherited ? 'selected' : ''}>${escapeHtml(tWithFallback('setting_inherit', 'Inherit administrator default'))}</option><option value="custom" ${!inherited ? 'selected' : ''}>${escapeHtml(tWithFallback('panel_settings_language_filter_custom', 'Custom allowlist'))}</option></select>
        <div id="languageTagFilterCustom" style="display:${inherited ? 'none' : 'block'}; margin-top:8px;"><select id="languageTagFilterLanguages" multiple size="${Math.min(8, Math.max(3, ordered.length))}" style="box-sizing:border-box; width:100%; padding:8px; background:${background}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px;" ${ordered.length === 0 ? 'disabled' : ''}>${ordered.map((tag) => `<option value="${escapeHtml(tag)}" data-known="${known.has(tag) ? 'true' : 'false'}" ${languages.includes(tag) ? 'selected' : ''}>${escapeHtml(tag)}</option>`).join('')}</select><div style="display:flex; gap:6px; margin-top:6px;"><button type="button" id="languageTagFilterMoveUp" class="button-flat" aria-label="${escapeHtml(JC.t!('panel_settings_ui_quality_tags_move_up'))}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button><button type="button" id="languageTagFilterMoveDown" class="button-flat" aria-label="${escapeHtml(JC.t!('panel_settings_ui_quality_tags_move_down'))}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button></div><label style="display:flex; gap:8px; align-items:center; margin-top:8px;"><input id="languageTagFilterOriginal" type="checkbox" ${normalized?.includeOriginal === true ? 'checked' : ''}/><span>${escapeHtml(tWithFallback('panel_settings_language_filter_original', 'Include authoritative original language first'))}</span></label><button type="button" id="languageTagFilterReset" class="button-flat" style="margin-top:6px;">${escapeHtml(tWithFallback('button_reset', 'Reset'))}</button></div>
    </div>`;
}

function shortcutRowHtml(
    action: ShortcutTemplateEntry,
    activeShortcuts: Record<string, string>,
    userShortcutNames: ReadonlySet<string>,
    kbdBackground: string,
    primaryAccentColor: string,
): string {
    const name = action.Name || '';
    if (!name) return '';
    const label = tWithFallback(`shortcut_${name}`, action.Label || name);
    const binding = canonicalizeShortcut(activeShortcuts[name]);
    const disabled = binding === '';
    const grouped = name === PERCENTAGE_SHORTCUT_NAME;
    const display = disabled ? JC.t!('status_disabled') : formatShortcut(binding);
    const targetState = disabled ? JC.t!('shortcut_enable') : JC.t!('shortcut_disable');
    const resetLabel = JC.t!('discovery_customize_reset');
    const modified = userShortcutNames.has(name);
    const previewClasses = `shortcut-key${grouped ? ' shortcut-group-key' : ''}${disabled ? ' shortcut-disabled' : ''}`;

    return `
        <div class="jc-shortcut-row" style="display:grid; grid-template-columns:minmax(82px,auto) minmax(0,1fr) auto; align-items:center; gap:8px;">
            <span class="${escapeHtml(previewClasses)}" tabindex="${grouped ? '-1' : '0'}" data-action="${escapeHtml(name)}" data-label="${escapeHtml(label)}" aria-label="${escapeHtml(`${label}: ${display}`)}" style="background:${kbdBackground}; padding:3px 8px; border:1px solid transparent; border-radius:3px; cursor:${grouped ? 'default' : 'pointer'}; transition:all 0.2s; opacity:${disabled ? '0.72' : '1'};">${escapeHtml(display)}</span>
            <div class="jc-shortcut-label" style="display:flex; min-width:0; align-items:center; gap:8px;">
                ${modified ? `<span title="Modified by user" class="modified-indicator" style="color:${primaryAccentColor}; font-size:20px; line-height:1;">•</span>` : ''}
                <span>${escapeHtml(label)}${name === 'OpenEpisodePreview' ? ' <span style="font-size: 11px; opacity: 0.7;" title="Requires InPlayerEpisodePreview plugin from https://github.com/Namo2/InPlayerEpisodePreview/">ⓘ</span>' : ''}</span>
            </div>
            <div class="jc-shortcut-actions" style="display:flex; align-items:center; gap:5px;">
                <button type="button" class="shortcut-state-button" data-action="${escapeHtml(name)}" data-operation="${disabled ? 'enable' : 'disable'}" aria-label="${escapeHtml(`${targetState}: ${label}`)}" ${!grouped && disabled ? 'disabled' : ''} style="font:inherit; font-size:11px; padding:4px 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.07); color:#fff; cursor:pointer;">${escapeHtml(targetState)}</button>
                <button type="button" class="shortcut-reset-button" data-action="${escapeHtml(name)}" aria-label="${escapeHtml(`${resetLabel}: ${label}`)}" ${modified ? '' : 'disabled'} style="font:inherit; font-size:11px; padding:4px 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.18); background:rgba(255,255,255,0.07); color:#fff; cursor:pointer;">${escapeHtml(resetLabel)}</button>
            </div>
        </div>`;
}

/**
 * Builds the panel's inner HTML.
 * @param {object} ctx Shared panel context (theme constants) assembled in settings-panel/panel.ts.
 * @returns {string} HTML string assigned to the panel element's innerHTML.
 */
export function buildPanelHtml(ctx: PanelContext): string {
    const { panelBgColor, headerFooterBg, detailsBackground, primaryAccentColor,
            toggleAccentColor, kbdBackground, presetBoxBackground, githubButtonBg,
            releaseNotesTextColor, logoUrl, brandGradient } = ctx;
    const settings = ctx.editor.settings as Record<string, any>;
    const subtitlePreview = resolveSubtitleStyle(settings);
    const shortcuts = ctx.editor.shortcuts;
    const activeShortcuts = ctx.editor.activeShortcuts;
    const hiddenSettings = ctx.editor.hiddenContentSettings;
    const spoilerPrefs = ctx.editor.spoilerGuardPrefs;
    const targetBanner = ctx.editor.mode === 'admin-target'
        ? `<div class="jc-admin-target-banner" role="status" style="font-size:12px; color:rgba(255,255,255,0.88); padding:5px 9px; border-radius:999px; background:rgba(47,128,255,0.22); border:1px solid rgba(0,212,255,0.34);">${escapeHtml(
            JC.t!(
                'panel_admin_target_banner',
                { name: ctx.editor.targetDisplayName },
            )
        )}</div>`
        : '';

    const generatePresetHTML = (presets: any[], type: string) => {
        const html = presets.map((preset: any, index: number) => {
            let previewStyle = '';
            if (type === 'style') {
                previewStyle = `background-color: ${cssColorOr(preset.bgColor, 'transparent')}; color: ${cssColorOr(preset.textColor, '#ffffff')}; border: 1px solid rgba(255,255,255,0.3); text-shadow: #000000 0px 0px 3px;`;
            } else if (type === 'font-size') {
                previewStyle = `font-size: ${Number(preset.size) || 1}em; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8);`;
            } else if (type === 'font-family') {
                const family = String(preset.family ?? '').trim();
                const safeFamily = /^[A-Za-z0-9 ,_-]{1,128}$/.test(family) ? family : 'inherit';
                previewStyle = `font-family: ${escapeHtml(safeFamily)}; color: #fff; text-shadow: 0 0 4px rgba(0,0,0,0.8); font-size: 1.5em;`;
            }
            return `
                    <div class="preset-box ${type}-preset" data-preset-index="${index}" title="${escapeHtml(preset.name)}" style="display: flex; justify-content: center; align-items: center; padding: 8px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; transition: all 0.2s; background: ${presetBoxBackground}; min-height: 30px;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='${presetBoxBackground}'">
                        <span style="display: inline-block; ${type === 'style' ? `width: 40px; height: 25px; border-radius: 4px; line-height: 25px;` : ''} ${previewStyle} text-align: center; font-weight: bold;">${escapeHtml(preset.previewText)}</span>
                    </div>`;
        }).join('');
        return html;
    };

    const userShortcutNames = new Set<string>();
    const shortcutEntries = (shortcuts as any).Shortcuts;
    if (Array.isArray(shortcutEntries)) {
        for (const shortcut of shortcutEntries) {
            if (typeof shortcut?.Name === 'string') userShortcutNames.add(shortcut.Name);
        }
    }

    return `
            <style>
                /* Adaptive settings view: section nav on the left, one pane at a
                   time on the right; below 760px the nav is the first screen and
                   the pane covers it instantly with a back button. */
                #jellyfin-canopy-panel .jc-panel-body { display: grid; grid-template-columns: 230px minmax(0, 1fr); flex: 1; min-height: 0; background: ${panelBgColor}; }
                #jellyfin-canopy-panel .jc-panel-nav { display: flex; flex-direction: column; gap: 10px; padding: 14px 12px; border-right: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.18); overflow-y: auto; }
                #jellyfin-canopy-panel .jc-panel-nav-items { display: flex; flex-direction: column; gap: 3px; }
                #jellyfin-canopy-panel .jc-panel-search { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.25); color: #fff; font-family: inherit; font-size: 13px; outline: none; }
                #jellyfin-canopy-panel .jc-panel-search:focus { border-color: ${primaryAccentColor}; }
                #jellyfin-canopy-panel .tab-button { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border: none; border-radius: 8px; background: transparent; color: rgba(255,255,255,0.65); font-family: inherit; font-size: 14px; font-weight: 600; text-align: left; cursor: pointer; transition: background-color 0.15s, color 0.15s; }
                #jellyfin-canopy-panel .tab-button:hover { background: rgba(255,255,255,0.06); color: #fff; }
                #jellyfin-canopy-panel .tab-button.active { background: rgba(255,255,255,0.08); color: #fff; }
                #jellyfin-canopy-panel .tab-button.active::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 3px; background: ${brandGradient}; }
                #jellyfin-canopy-panel .jc-panel-main { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 4px 20px 20px 20px; }
                #jellyfin-canopy-panel .jc-pane { display: none; }
                #jellyfin-canopy-panel .jc-pane.active { display: block; }
                #jellyfin-canopy-panel .jc-pane-title { display: flex; align-items: center; gap: 8px; margin: 14px 0 12px 0; font-size: 17px; font-weight: 700; color: #fff; font-family: inherit; }
                #jellyfin-canopy-panel .jc-spoiler-overrides-form { display:grid; grid-template-columns:minmax(110px,0.8fr) minmax(150px,1.2fr) minmax(150px,1.2fr) auto; gap:8px; align-items:end; margin-top:12px; }
                #jellyfin-canopy-panel .jc-spoiler-override-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px; margin-bottom:6px; border:1px solid rgba(255,255,255,0.1); border-radius:5px; }
                #jellyfin-canopy-panel .jc-spoiler-override-row-text { min-width:0; overflow-wrap:anywhere; }
                #jellyfin-canopy-panel .jc-pane-back { display: none; align-items: center; gap: 6px; margin: 12px 0 0 0; padding: 6px 10px; border: none; border-radius: 8px; background: rgba(255,255,255,0.08); color: #fff; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; align-self: flex-start; }
                @media (max-width: 760px) {
                    #jellyfin-canopy-panel { top: 0 !important; left: 0 !important; transform: none !important; width: 100vw !important; max-width: 100vw !important; height: 100dvh !important; max-height: 100dvh !important; border-radius: 0 !important; border: none !important; box-sizing: border-box !important; }
                    #jellyfin-canopy-panel .jc-panel-body { display: block; position: relative; overflow: hidden; }
                    #jellyfin-canopy-panel .jc-panel-nav { position: absolute; inset: 0; border-right: none; z-index: 1; }
                    /* The closed pane is parked off-screen by the transform alone —
                       deliberately untransitioned so opening a section swaps the
                       layer instantly instead of sliding it in. */
                    #jellyfin-canopy-panel .jc-panel-main { position: absolute; inset: 0; z-index: 2; background: rgb(24, 24, 24); transform: translateX(102%); }
                    #jellyfin-canopy-panel .jc-panel-body.jc-pane-open .jc-panel-main { transform: translateX(0); }
                    #jellyfin-canopy-panel .jc-panel-body.jc-pane-open .jc-pane-back { display: inline-flex; }
                    #jellyfin-canopy-panel .jc-spoiler-overrides-form { grid-template-columns:1fr; }
                }
                @keyframes shake { 10%, 90% { transform: translateX(-1px); } 20%, 80% { transform: translateX(2px); } 30%, 50%, 70% { transform: translateX(-4px); } 40%, 60% { transform: translateX(4px); } }
                .shake-error { animation: shake 0.5s ease-in-out; }
            </style>
            <div class="jc-panel-header" style="padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg}; display: flex; align-items: baseline; gap: 10px; cursor: grab;">
                <div style="font-size: 20px; font-weight: 700;"><img src="${escapeHtml(assetUrl('branding/canopy-mark.svg'))}" alt="" width="24" height="21" style="vertical-align: -3px; margin-right: 8px;"><span style="background: ${brandGradient}; -webkit-background-clip: text; -webkit-text-fill-color: transparent;">${escapeHtml(tWithFallback('panel_title', 'Canopy User Settings'))}</span></div>
                <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHtml(JC.t!('panel_version', { version: JC.pluginVersion }))}</div>
                ${targetBanner}
            </div>
            <div class="jc-panel-body">
                <nav class="jc-panel-nav" aria-label="${escapeHtml(JC.t!('panel_settings_tab'))}">
                    <input id="jcPanelSearch" class="jc-panel-search" type="text" placeholder="${escapeHtml(JC.t!('panel_search_placeholder'))}" />
                    <div class="jc-panel-nav-items"></div>
                </nav>
                <div class="jc-panel-main">
                <button id="jcPanelBack" class="jc-pane-back" type="button"><span class="material-icons" style="font-size:16px;" aria-hidden="true">arrow_back</span>${escapeHtml(JC.t!('panel_back'))}</button>
                 ${!JC.pluginConfig.DisableAllShortcuts ? `
                 <div id="shortcuts-content" class="tab-content jc-pane" data-pane="shortcuts" data-pane-label="${escapeHtml(JC.t!('panel_shortcuts_tab'))}" style="padding-top: 4px; padding-bottom: 20px;">
                 <div class="shortcuts-container" style="display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 24px;">
                        <div style="flex: 1; min-width: 400px;">
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">${JC.t!('panel_shortcuts_global')}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${((JC.pluginConfig.Shortcuts as ShortcutTemplateEntry[]) || [])
                                    .filter((s, index, self) => s.Category === 'Global' && index === self.findIndex(t => t.Name === s.Name))
                                    .map(action => shortcutRowHtml(action, activeShortcuts, userShortcutNames, kbdBackground, primaryAccentColor))
                                    .join('')}
                            </div>
                        </div>
                        <div style="flex: 1; min-width: 400px;">
                            <h3 style="margin: 0 0 12px 0; font-size: 18px; color: ${primaryAccentColor}; font-family: inherit;">${JC.t!('panel_shortcuts_player')}</h3>
                            <div style="display: grid; gap: 8px; font-size: 14px;">
                                ${['CycleAspectRatio', 'ShowPlaybackInfo', 'SubtitleMenu', 'CycleSubtitleTracks', 'CycleAudioTracks', 'IncreasePlaybackSpeed', 'DecreasePlaybackSpeed', 'ResetPlaybackSpeed', 'BookmarkCurrentTime', 'OpenEpisodePreview', 'SkipIntroOutro', 'FrameStepBack', 'FrameStepForward', 'JumpToLastPosition', PERCENTAGE_SHORTCUT_NAME]
                                    .map(action => {
                                        const entry = ((JC.pluginConfig.Shortcuts as ShortcutTemplateEntry[]) || [])
                                            .find(shortcut => shortcut.Name === action)
                                            || { Name: action, Label: action, Category: 'Player' };
                                        return shortcutRowHtml(entry, activeShortcuts, userShortcutNames, kbdBackground, primaryAccentColor);
                                    }).join('')}
                            </div>
                        </div>
                    </div>
                    <div style="text-align: center; font-size: 11px; color: rgba(255,255,255,0.6);">
                    ${JC.t!('panel_shortcuts_footer')}
                    </div>
                </div>` : ''}
                <div id="settings-content" style="display: contents;">
                    <section class="jc-pane" data-pane="playback">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.PLAYBACK)} ${JC.t!('panel_settings_playback')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPauseToggle" ${settings.autoPauseEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_auto_pause')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_auto_pause_desc')}</div></div>
                                </label>
                            </div>
                           <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoResumeToggle" ${settings.autoResumeEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_auto_resume')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_auto_resume_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoPipToggle" ${settings.autoPipEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_auto_pip')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_auto_pip_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="longPress2xEnabled" ${settings.longPress2xEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_long_press_2x_speed')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_long_press_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="doubleTapSeekEnabled" ${settings.doubleTapSeekEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_double_tap_seek')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_double_tap_seek_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="pauseScreenToggle" ${settings.pauseScreenEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_custom_pause_screen')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_custom_pause_screen_desc')}</div></div>
                                </label>
                                <div class="jc-pause-delay-row" style="margin-top:10px; display:flex; align-items:center; gap:8px; padding-left:30px;">
                                    <label for="pauseScreenDelayInput" style="font-size:12px; color:rgba(255,255,255,0.7); white-space:nowrap;">${JC.t!('panel_settings_pause_screen_delay_label')}</label>
                                    <input type="number" id="pauseScreenDelayInput" min="1" max="60" value="${Number(settings.pauseScreenDelaySeconds ?? 5) || 5}" style="width:60px; padding:4px 6px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:#fff; font-size:12px; text-align:center;">
                                </div>
                            </div>
                        </div>
                    </section>
                    <section class="jc-pane" data-pane="auto-skip">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.SKIP)} ${JC.t!('panel_settings_auto_skip')}</h3>
                        <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-left: 18px; margin-bottom: 10px;">${JC.t!('panel_settings_auto_skip_depends')}</div>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipIntroToggle" ${settings.autoSkipIntro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_auto_skip_intro')}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="autoSkipOutroToggle" ${settings.autoSkipOutro ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_auto_skip_outro')}</div></div>
                                </label>
                            </div>
                        </div>
                    </section>
                    <section class="jc-pane" data-pane="subtitles">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.SUBTITLES)} ${JC.t!('panel_settings_subtitles')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="disableCustomSubtitleStyles" ${settings.disableCustomSubtitleStyles ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_disable_custom_styles')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_disable_custom_styles_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JC.t!('panel_settings_subtitles_style')}</div><div id="subtitle-style-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML((JC as any).subtitlePresets, 'style')}</div></div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${primaryAccentColor};">
                                <div style="font-weight: 600; margin-bottom: 12px;">${JC.icon!(JC.IconName!.PAINT)}</div>
                                <div class="jc-subtitle-color-layout" style="display: flex; gap: 12px;">
                                    <div class="jc-subtitle-color-controls" style="flex: 1; display: flex; flex-direction: column; gap: 12px;">
                                        <div>
                                            <div style="font-size: 13px; margin-bottom: 6px; color: rgba(255,255,255,0.8);">Text</div>
                                            <div class="jc-subtitle-color-control-row" style="display: flex; gap: 8px; align-items: center;">
                                                <input type="color" id="customSubtitleTextColorPicker" value="${escapeHtml(settings.customSubtitleTextColor?.substring(0, 7) || '#FFFFFF')}" style="width: 50px; height: 36px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; background: transparent;">
                                                <input type="range" id="customSubtitleTextAlpha" min="0" max="255" value="${parseInt(settings.customSubtitleTextColor?.substring(7, 9) || 'FF', 16)}" style="flex: 1; accent-color: ${primaryAccentColor};">
                                            </div>
                                        </div>
                                        <div>
                                            <div style="font-size: 13px; margin-bottom: 6px; color: rgba(255,255,255,0.8);">Background</div>
                                            <div class="jc-subtitle-color-control-row" style="display: flex; gap: 8px; align-items: center;">
                                                <input type="color" id="customSubtitleBgColorPicker" value="${escapeHtml(settings.customSubtitleBgColor?.substring(0, 7) || '#000000')}" style="width: 50px; height: 36px; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; background: transparent;">
                                                <input type="range" id="customSubtitleBgAlpha" min="0" max="255" value="${parseInt(settings.customSubtitleBgColor?.substring(7, 9) || '00', 16)}" style="flex: 1; accent-color: ${primaryAccentColor};">
                                            </div>
                                        </div>
                                    </div>
                                    <div id="subtitleColorPreview" style="display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; border-radius: 6px; background: rgba(0,0,0,0.3); color: ${cssColorOr(settings.customSubtitleTextColor, '#FFFFFFFF')}; background-color: ${cssColorOr(settings.customSubtitleBgColor, '#00000000')}; padding: 12px 20px; flex: 0.5; align-self: center;">AaBbCcDd</div>
                                </div>
                            </div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JC.t!('panel_settings_subtitles_size')}</div><div id="font-size-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML((JC as any).fontSizePresets, 'font-size')}</div></div>
                            <div style="margin-bottom: 16px;"><div style="font-weight: 600; margin-bottom: 8px;">${JC.t!('panel_settings_subtitles_font')}</div><div id="font-family-presets-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 8px;">${generatePresetHTML((JC as any).fontFamilyPresets, 'font-family')}</div></div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <span style="font-weight: 600;">${JC.t!('panel_settings_subtitles_position')}</span>
                                    <button id="subtitlePositionReset" style="font-family:inherit; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.7); padding:3px 8px; border-radius:4px; font-size:11px; cursor:pointer; display:flex; align-items:center;"><span class="material-icons" style="font-size:16px;">restart_alt</span></button>
                                </div>
                                <div id="subtitlePositionGrid" style="position:relative; width:min(60vw,280px); height:min(34vw,158px); background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.15); border-radius:6px; cursor:crosshair; user-select:none; overflow:hidden; margin: 0 auto;">
                                    <!-- Crosshair guides -->
                                    <div style="position:absolute;inset:0;pointer-events:none;">
                                        <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.08);transform:translateX(-50%);"></div>
                                        <div style="position:absolute;top:50%;left:0;right:0;height:1px;background:rgba(255,255,255,0.08);transform:translateY(-50%);"></div>
                                    </div>
                                    <!-- Subtitle preview text -->
                                    <div id="subtitlePositionPreview" style="position:absolute; transform:translate(-50%,-100%); pointer-events:none; white-space:nowrap; font-size:${Number(subtitlePreview.previewFontSizePx) || 8}px; font-family:${escapeHtml(subtitlePreview.fontFamily)}; font-weight:600; color:${escapeHtml(subtitlePreview.textColor)}; background-color:${escapeHtml(subtitlePreview.backgroundColor)}; padding:${subtitlePreview.visibleBackground ? '0.08em 0.2em' : '0'}; border-radius:${subtitlePreview.visibleBackground ? '0.15em' : '0'}; text-shadow:${escapeHtml(subtitlePreview.textShadow)}; left:${clampSubtitleHorizontal(settings.subtitleHorizontalPosition)}%; top:${clampSubtitleVertical(settings.subtitleVerticalPosition)}%;">AaBbCcDd</div>
                                </div>
                                <div style="margin-top:6px; font-size:11px; color:rgba(255,255,255,0.4); text-align:center;">${JC.t!('panel_settings_subtitles_position_note') || 'Requires Jellyfin subtitle style set to <b>Custom</b> in Subtitle settings'}</div>
                            </div>
                        </div>
                    </section>
                    <section class="jc-pane" data-pane="random-button">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.RANDOM)} ${JC.t!('panel_settings_random_button')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomButtonToggle" ${settings.randomButtonEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">${JC.t!('panel_settings_random_button_enable')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_random_button_enable_desc')}</div></div></label>
                                <br>
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;"><input type="checkbox" id="randomUnwatchedOnly" ${settings.randomUnwatchedOnly ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><div><div style="font-weight:500;">${JC.t!('panel_settings_random_button_unwatched')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_random_button_unwatched_desc')}</div></div></label>
                            </div>
                            <div style="font-weight:500; margin-bottom:8px;">${JC.t!('panel_settings_random_button_types')}</div>
                            <div style="display:flex; gap:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeMovies" ${settings.randomIncludeMovies ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>${JC.t!('panel_settings_random_button_movies')}</span></label>
                                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" id="randomIncludeShows" ${settings.randomIncludeShows ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;"><span>${JC.t!('panel_settings_random_button_shows')}</span></label>
                            </div>
                        </div>
                    </section>
                    <section class="jc-pane" data-pane="ui">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.UI)} ${JC.t!('panel_settings_ui')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showWatchProgressToggle" ${settings.showWatchProgress ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_watch_progress')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_watch_progress_desc')}</div></div>
                                </label>
                                <div style="display:flex; gap:12px; margin-top:10px;">
                                    <div style="flex:1;">
                                        <select id="watchProgressModeSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                                            <option value="percentage" ${settings.watchProgressMode === 'percentage' ? 'selected' : ''}>Percentage</option>
                                            <option value="time" ${settings.watchProgressMode === 'time' ? 'selected' : ''}>Time Watched</option>
                                            <option value="remaining" ${settings.watchProgressMode === 'remaining' ? 'selected' : ''}>Time Remaining</option>
                                        </select>
                                    </div>
                                    <div style="flex:1;">
                                        <select id="watchProgressTimeFormatSelect" style="width:100%; background:${detailsBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; padding:6px;">
                                            <option value="hours" ${settings.watchProgressTimeFormat === 'hours' ? 'selected' : ''}>h:m</option>
                                            <option value="full" ${settings.watchProgressTimeFormat === 'full' ? 'selected' : ''}>y:mo:d:h:m</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showFileSizesToggle" ${settings.showFileSizes ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_file_sizes')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_file_sizes_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showFileSourceToggle" ${settings.showFileSource ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_file_source')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_file_source_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="showAudioLanguagesToggle" ${settings.showAudioLanguages ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_audio_languages')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_audio_languages_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="qualityTagsToggle" ${settings.qualityTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_quality_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_quality_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="qualityTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                                <div id="qualityTagsSubWrap" class="jc-quality-cat-wrap" style="display: ${settings.qualityTagsEnabled ? 'block' : 'none'};">
                                    <button type="button" id="qualityTagsSubToggleExpander" class="jc-quality-cat-expander" aria-expanded="false">
                                        <span class="material-icons jc-cat-chevron" aria-hidden="true">chevron_right</span>
                                        <span>${JC.t!('panel_settings_ui_quality_tags_categories_label')}</span>
                                    </button>
                                </div>
                                ${(() => {
                                    const raw = settings.preferredAudioLanguage;
                                    const mode = raw === null || raw === undefined
                                        ? 'inherit'
                                        : String(raw).trim() === '' ? 'automatic' : 'custom';
                                    const value = mode === 'custom' ? String(raw) : '';
                                    return `
                                        <div style="margin-top:12px;">
                                            <label for="preferredAudioLanguageMode" style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">${escapeHtml(JC.t!('panel_settings_ui_preferred_audio_language'))}</label>
                                            <select id="preferredAudioLanguageMode" style="width:100%; padding:10px; background:${presetBoxBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; font-family:inherit;">
                                                <option value="inherit" ${mode === 'inherit' ? 'selected' : ''}>${escapeHtml(JC.t!('panel_settings_ui_preferred_audio_language_inherit'))}</option>
                                                <option value="automatic" ${mode === 'automatic' ? 'selected' : ''}>${escapeHtml(JC.t!('panel_settings_ui_preferred_audio_language_automatic'))}</option>
                                                <option value="custom" ${mode === 'custom' ? 'selected' : ''}>${escapeHtml(JC.t!('panel_settings_ui_preferred_audio_language_custom'))}</option>
                                            </select>
                                            <div class="jc-preferred-audio-custom" style="margin-top:8px; display:${mode === 'custom' ? 'block' : 'none'};">
                                                <input id="preferredAudioLanguageInput" type="text" maxlength="255" inputmode="text" value="${escapeHtml(value)}" placeholder="en-US" aria-label="${escapeHtml(JC.t!('panel_settings_ui_preferred_audio_language_custom'))}" style="box-sizing:border-box; width:100%; padding:10px; background:${presetBoxBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:6px; font-family:inherit;" />
                                            </div>
                                            <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:6px;">${escapeHtml(JC.t!('panel_settings_ui_preferred_audio_language_desc'))}</div>
                                        </div>`;
                                })()}
                                <div id="qualityTagsSubToggles" class="jc-quality-cat-list" style="display: none;">
                                    ${(() => {
                                        const cats = [
                                            { id: 'showResolutionTagToggle',    settingKey: 'showResolutionTag',    pluginKey: 'ShowResolutionTag',    orderKey: 'resolutionTagOrder',    orderPluginKey: 'ResolutionTagOrder',    defaultOrder: 1, labelKey: 'panel_settings_ui_quality_tags_resolution' },
                                            { id: 'showSourceTagToggle',        settingKey: 'showSourceTag',        pluginKey: 'ShowSourceTag',        orderKey: 'sourceTagOrder',        orderPluginKey: 'SourceTagOrder',        defaultOrder: 2, labelKey: 'panel_settings_ui_quality_tags_source' },
                                            { id: 'showDynamicRangeTagToggle',  settingKey: 'showDynamicRangeTag',  pluginKey: 'ShowDynamicRangeTag',  orderKey: 'dynamicRangeTagOrder',  orderPluginKey: 'DynamicRangeTagOrder',  defaultOrder: 3, labelKey: 'panel_settings_ui_quality_tags_dynamic_range' },
                                            { id: 'showSpecialFormatTagToggle', settingKey: 'showSpecialFormatTag', pluginKey: 'ShowSpecialFormatTag', orderKey: 'specialFormatTagOrder', orderPluginKey: 'SpecialFormatTagOrder', defaultOrder: 4, labelKey: 'panel_settings_ui_quality_tags_special_format' },
                                            { id: 'showVideoCodecTagToggle',    settingKey: 'showVideoCodecTag',    pluginKey: 'ShowVideoCodecTag',    orderKey: 'videoCodecTagOrder',    orderPluginKey: 'VideoCodecTagOrder',    defaultOrder: 5, labelKey: 'panel_settings_ui_quality_tags_video_codec' },
                                            { id: 'showAudioInfoTagToggle',     settingKey: 'showAudioInfoTag',     pluginKey: 'ShowAudioInfoTag',     orderKey: 'audioInfoTagOrder',     orderPluginKey: 'AudioInfoTagOrder',     defaultOrder: 6, labelKey: 'panel_settings_ui_quality_tags_audio_info' },
                                        ];
                                        // Resolve to the effective enable/order (user override → admin default → hardcoded)
                                        // so the panel reflects what's actually rendering, even when the user has
                                        // never customized and inherits the admin value.
                                        const effEnable = (c: any) => {
                                            const u = settings[c.settingKey];
                                            if (typeof u === 'boolean') return u;
                                            const a = JC.pluginConfig?.[c.pluginKey];
                                            return typeof a === 'boolean' ? a : true;
                                        };
                                        const effOrder = (c: any) => {
                                            const u = settings[c.orderKey];
                                            if (Number.isFinite(u)) return u;
                                            const a = JC.pluginConfig?.[c.orderPluginKey];
                                            return Number.isFinite(a) ? a : c.defaultOrder;
                                        };
                                        const sorted = cats.slice().sort((a, b) => {
                                            const ao = effOrder(a);
                                            const bo = effOrder(b);
                                            if (ao !== bo) return ao - bo;
                                            return a.defaultOrder - b.defaultOrder;
                                        });
                                        return sorted.map((c, idx) => {
                                            const checked = effEnable(c) ? 'checked' : '';
                                            const upDisabled = idx === 0 ? 'disabled' : '';
                                            const downDisabled = idx === sorted.length - 1 ? 'disabled' : '';
                                            return `
                                                <div class="jc-quality-cat-row" data-cat-key="${c.settingKey}" data-order-key="${c.orderKey}" data-default-order="${c.defaultOrder}">
                                                    <label class="jc-quality-cat-label-wrap">
                                                        <input type="checkbox" id="${c.id}" ${checked} style="accent-color:${toggleAccentColor};">
                                                        <span class="jc-quality-cat-label">${JC.t!(c.labelKey)}</span>
                                                    </label>
                                                    <button type="button" class="jc-cat-btn jc-cat-up" ${upDisabled} aria-label="${JC.t!('panel_settings_ui_quality_tags_move_up')}"><span class="material-icons" aria-hidden="true">arrow_upward</span></button>
                                                    <button type="button" class="jc-cat-btn jc-cat-down" ${downDisabled} aria-label="${JC.t!('panel_settings_ui_quality_tags_move_down')}"><span class="material-icons" aria-hidden="true">arrow_downward</span></button>
                                                </div>
                                            `;
                                        }).join('');
                                    })()}
                                </div>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="genreTagsToggle" ${settings.genreTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_genre_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_genre_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="genreTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                    <div style="display: flex; align-items: center; gap: 12px;">
                                        <input type="checkbox" id="languageTagsToggle" ${settings.languageTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_language_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_language_tags_desc')}</div></div>
                                    </div>
                                    <div class="position-selector" data-setting="languageTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                        <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                        <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                    </div>
                                </label>
                                ${languageTagFilterControls(settings, presetBoxBackground, ctx.languageTagInventory)}
                            </div>
                                <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer;">
                                        <div style="display: flex; align-items: center; gap: 12px;">
                                            <input type="checkbox" id="ratingTagsToggle" ${settings.ratingTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                            <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_rating_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_rating_tags_desc')}</div></div>
                                        </div>
                                        <div class="position-selector" data-setting="ratingTagsPosition" style="display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; width:32px; height:32px; border:1px solid rgba(255,255,255,0.3); border-radius:4px; padding:3px; cursor:pointer; flex-shrink:0;" title="Click to change position">
                                            <div data-pos="top-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="top-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="bottom-left" style="border-radius:2px; transition:background 0.2s;"></div>
                                            <div data-pos="bottom-right" style="border-radius:2px; transition:background 0.2s;"></div>
                                        </div>
                                    </label>
                                    ${(() => {
                                        const admin = normalizeRatingTagScopePolicy(JC.pluginConfig.RatingTagScopePolicy);
                                        const user = normalizeRatingTagScopePolicy(settings.ratingTagScopeOverrides);
                                        const itemLabels: Record<string, string> = {
                                            Movie: tWithFallback('seerr_card_badge_movie', 'Movie'),
                                            Episode: tWithFallback('seerr_report_issue_episode', 'Episode'),
                                            Series: tWithFallback('seerr_card_badge_series', 'Series'),
                                            Season: tWithFallback('seerr_report_issue_season', 'Season'),
                                            BoxSet: tWithFallback('seerr_card_badge_collection', 'Collection'),
                                        };
                                        const surfaceLabels: Record<string, string> = {
                                            NextUp: tWithFallback('remove_surface_next_up', 'Next Up'),
                                            ContinueWatching: tWithFallback('remove_surface_continue_watching', 'Continue Watching'),
                                            HomeOther: tWithFallback('panel_settings_rating_scope_home_other', 'Other Home rows'),
                                            Other: tWithFallback('panel_settings_rating_scope_other', 'All other poster surfaces'),
                                        };
                                        const renderToggle = (kind: 'itemType' | 'surface', value: string, label: string): string => {
                                            const adminList = new Set<string>(kind === 'itemType'
                                                ? admin?.disabledItemTypes || []
                                                : admin?.disabledSurfaces || []);
                                            const userList = new Set<string>(kind === 'itemType'
                                                ? user?.disabledItemTypes || []
                                                : user?.disabledSurfaces || []);
                                            const adminDenied = !admin || adminList.has(value);
                                            const userDenied = !user || userList.has(value);
                                            return `<label style="display:flex; align-items:center; gap:8px; min-width:150px; cursor:${adminDenied ? 'not-allowed' : 'pointer'}; opacity:${adminDenied ? '0.55' : '1'};">
                                                <input type="checkbox" data-rating-scope-kind="${kind}" data-rating-scope-value="${value}" data-user-denied="${userDenied ? 'true' : 'false'}" ${!adminDenied && !userDenied ? 'checked' : ''} ${adminDenied ? 'disabled' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor};">
                                                <span>${escapeHtml(label)}</span>
                                            </label>`;
                                        };
                                        return `<div id="ratingTagScopeOverrides" style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.12);">
                                            <div style="font-size:13px; font-weight:600; margin-bottom:4px;">${escapeHtml(tWithFallback('panel_settings_rating_scope_title', 'Show rating tags on'))}</div>
                                            <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-bottom:8px;">${escapeHtml(tWithFallback('panel_settings_rating_scope_desc', 'Your choices can hide additional ratings. Scopes disabled by your administrator stay unavailable.'))}</div>
                                            <div style="font-size:12px; font-weight:600; margin-bottom:5px;">${escapeHtml(tWithFallback('panel_settings_rating_scope_types', 'Item types'))}</div>
                                            <div style="display:flex; flex-wrap:wrap; gap:7px 14px;">${RATING_TAG_ITEM_TYPES.map(value => renderToggle('itemType', value, itemLabels[value])).join('')}</div>
                                            <div style="font-size:12px; font-weight:600; margin:9px 0 5px;">${escapeHtml(tWithFallback('panel_settings_rating_scope_surfaces', 'Named surfaces'))}</div>
                                            <div style="display:flex; flex-wrap:wrap; gap:7px 14px;">${RATING_TAG_SURFACES.map(value => renderToggle('surface', value, surfaceLabels[value])).join('')}</div>
                                        </div>`;
                                    })()}
                                </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="peopleTagsToggle" ${settings.peopleTagsEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_people_tags')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_people_tags_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="tagsHideOnHoverToggle" ${settings.tagsHideOnHover ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_hide_tags_on_hover')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_hide_tags_on_hover_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="removeContinueWatchingToggle" ${settings.removeContinueWatchingEnabled ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_remove_continue_watching')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_remove_continue_watching_desc')}</div></div>
                                </label>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hideFavoritesTabToggle" ${settings.hideFavoritesTab ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('panel_settings_ui_hide_favorites_tab')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('panel_settings_ui_hide_favorites_tab_desc')}</div></div>
                                </label>
                            </div>
                            ${JC.pluginConfig.AnimeFillerWarningsEnabled === true ? `
                            <div style="margin-top: 16px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="animeFillerWarningsToggle" ${settings.animeFillerWarningsEnabled !== false ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('anime_filler_setting')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('anime_filler_setting_desc')}</div></div>
                                </label>
                            </div>` : ''}
                        </div>
                    </section>
                    ${/* Hidden Content settings — only rendered when the module is initialized (controlled by HiddenContentEnabled config) */ ''}
                    ${hiddenSettings ? `<section class="jc-pane" data-pane="hidden-content">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.EYE)} ${JC.t!('hidden_content_settings_title')}</h3>
                        <div id="hiddenContentSaveStatus" role="status" aria-live="polite" style="min-height:18px; margin:-6px 4px 8px; font-size:11px; color:rgba(255,255,255,0.68);"></div>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenContentEnabledToggle" ${hiddenSettings.enabled !== false ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('hidden_content_toggle_label')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('hidden_content_toggle_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenShowHideButtons" ${hiddenSettings.showHideButtons !== false ? 'checked' : ''} style="width:18px; height:18px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500;">${JC.t!('hidden_content_show_buttons_label')}</div><div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px;">${JC.t!('hidden_content_show_buttons_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="hiddenShowConfirmation" ${hiddenSettings.showHideConfirmation !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_confirm_toggle_label')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_confirm_toggle_desc')}</div></div>
                                </label>
                            </div>
                            <div style="margin-bottom: 12px;">
                                <div style="font-weight:500; font-size:13px; color:rgba(255,255,255,0.7); margin-bottom:8px; padding-left:4px;">${JC.t!('hidden_content_button_section_title')}</div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonSeerr" ${hiddenSettings.showButtonSeerr !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_show_button_seerr')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_show_button_seerr_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonLibrary" ${hiddenSettings.showButtonLibrary ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_show_button_library')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_show_button_library_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonDetails" ${hiddenSettings.showButtonDetails !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_show_button_details')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_show_button_details_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenShowButtonCast" ${hiddenSettings.showButtonCast ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_show_button_cast')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_show_button_cast_desc')}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div id="hiddenContentSurfaceToggles" style="margin-bottom: 12px;">
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterLibrary" ${hiddenSettings.filterLibrary !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_library')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_library_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterDiscovery" ${hiddenSettings.filterDiscovery !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_discovery')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_discovery_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterSearch" ${hiddenSettings.filterSearch !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_search')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_search_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterCalendar" ${hiddenSettings.filterCalendar !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_calendar')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_calendar_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterUpcoming" ${hiddenSettings.filterUpcoming !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_upcoming')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_upcoming_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterRecommendations" ${hiddenSettings.filterRecommendations !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_recommendations')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_recommendations_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterRequests" ${hiddenSettings.filterRequests !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_requests')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_requests_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterNextUp" ${hiddenSettings.filterNextUp !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_nextup')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_nextup_desc')}</div></div>
                                    </label>
                                </div>
                                <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenFilterContinueWatching" ${hiddenSettings.filterContinueWatching !== false ? 'checked' : ''} style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_filter_continue')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_filter_continue_desc')}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div style="margin-bottom: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255, 180, 50, 0.6);">
                                <div style="font-weight:500; font-size:13px; color:rgba(255, 180, 50, 0.9); margin-bottom:8px; padding-left:4px;">${JC.t!('hidden_content_experimental_label')}</div>
                                <div style="padding: 12px; background: rgba(255, 180, 50, 0.05); border-radius: 6px; border-left: 3px solid rgba(255, 180, 50, 0.3);">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="hiddenExperimentalCollections" ${hiddenSettings.experimentalHideCollections ? 'checked' : ''} style="width:16px; height:16px; accent-color:rgba(255, 180, 50, 0.8); cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('hidden_content_experimental_collections')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('hidden_content_experimental_collections_desc')}</div></div>
                                    </label>
                                </div>
                            </div>
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <button id="manageHiddenContentBtn" style="width: 100%; padding: 12px; background: ${toggleAccentColor}; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
                                    ${JC.t!('hidden_content_manage_button')} (${Number(ctx.editor.hiddenContentCount) || 0})
                                </button>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JC.t!('hidden_content_manage_desc')}</div>
                            </div>
                        </div>
                    </section>` : ''}
                    ${/* Spoiler Guard user-side override panel — only rendered when the admin master switch is on. */ ''}
                    ${spoilerPrefs ? (() => {
                        const sbPrefs = spoilerPrefs;
                        // Each row only renders when the admin has the underlying
                        // strip enabled — a user can't opt out of a category the
                        // admin already disabled.
                        const adminOn = {
                            overview: JC.pluginConfig.SpoilerStripOverview !== false,
                            tags: JC.pluginConfig.SpoilerStripTags !== false,
                            chapters: JC.pluginConfig.SpoilerStripChapters !== false,
                            taglines: JC.pluginConfig.SpoilerStripTaglines !== false,
                            ratings: JC.pluginConfig.SpoilerStripRatings !== false,
                            premiereDate: JC.pluginConfig.SpoilerStripPremiereDate !== false,
                            replaceTitle: JC.pluginConfig.SpoilerReplaceTitle !== false,
                            cast: JC.pluginConfig.SpoilerStripCast !== false,
                            reviews: JC.pluginConfig.SpoilerStripReviews !== false,
                        };
                        // Override-checked semantics: a checkbox is "checked" when the
                        // user is following the admin (pref null/undefined OR true).
                        // Unchecking it writes `false` — the user-opted-out signal.
                        const rowChecked = (v: unknown): string => (v === false ? '' : 'checked');
                        // id / prefKey / labelKey / descKey are compile-time string
                        // literals at every call site (class (a)); JC.t is the trusted
                        // producer used raw throughout this template.
                        const row = (id: string, prefKey: string, labelKey: string, descKey: string, gate: boolean): string => gate ? `
                            <div style="margin-bottom: 8px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid rgba(255,255,255,0.15);">
                                <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                    <input type="checkbox" id="${id}" ${rowChecked(sbPrefs[prefKey])} data-pref="${prefKey}" style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                    <div><div style="font-weight:500; font-size:13px;">${JC.t!(labelKey)}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!(descKey)}</div></div>
                                </label>
                            </div>` : '';
                        return `
                        <section class="jc-pane" data-pane="spoiler-guard">
                            <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.MASK)} ${JC.t!('panel_settings_spoiler_guard')}</h3>
                            <div id="spoilerGuardSaveStatus" role="status" aria-live="polite" style="min-height:18px; margin:-6px 4px 8px; font-size:11px; color:rgba(255,255,255,0.68);"></div>
                            <div style="padding: 0 16px 16px 16px;">
                                <div style="font-weight:500; font-size:13px; color:rgba(255,255,255,0.7); margin-bottom:8px; padding-left:4px;">${JC.t!('panel_settings_spoiler_guard_overrides_section')}</div>
                                ${row('sbPrefHideOverview',  'HideEpisodeDescriptions', 'panel_settings_spoiler_guard_override_overview',  'panel_settings_spoiler_guard_override_overview_desc',  adminOn.overview)}
                                ${row('sbPrefReplaceTitle',  'ReplaceEpisodeTitles',    'panel_settings_spoiler_guard_override_titles',    'panel_settings_spoiler_guard_override_titles_desc',    adminOn.replaceTitle)}
                                ${row('sbPrefHideChapters',  'HideChapterNames',        'panel_settings_spoiler_guard_override_chapters',  'panel_settings_spoiler_guard_override_chapters_desc',  adminOn.chapters)}
                                ${row('sbPrefHideCast',      'HideCast',                'panel_settings_spoiler_guard_override_cast',      'panel_settings_spoiler_guard_override_cast_desc',      adminOn.cast)}
                                ${row('sbPrefHideRatings',   'HideRatings',             'panel_settings_spoiler_guard_override_ratings',   'panel_settings_spoiler_guard_override_ratings_desc',   adminOn.ratings)}
                                ${row('sbPrefHideAirDate',   'HideAirDate',             'panel_settings_spoiler_guard_override_air_date',  'panel_settings_spoiler_guard_override_air_date_desc',  adminOn.premiereDate)}
                                ${row('sbPrefHideTaglines',  'HideTaglines',            'panel_settings_spoiler_guard_override_taglines',  'panel_settings_spoiler_guard_override_taglines_desc',  adminOn.taglines)}
                                ${row('sbPrefHideTags',      'HideTags',                'panel_settings_spoiler_guard_override_tags',      'panel_settings_spoiler_guard_override_tags_desc',      adminOn.tags)}
                                ${row('sbPrefHideReviews',   'HideReviews',             'panel_settings_spoiler_guard_override_reviews',   'panel_settings_spoiler_guard_override_reviews_desc',   adminOn.reviews)}
                                ${/* Advanced categories: unchecking is the STRICTER choice (full uniform strip); the row only renders when the admin enabled the mode. */ ''}
                                ${row('sbPrefAdvancedCategories', 'UseAdvancedCategories', 'panel_settings_spoiler_guard_override_advanced', 'panel_settings_spoiler_guard_override_advanced_desc', JC.pluginConfig.SpoilerAdvancedMode === true)}
                                <div style="margin-top: 12px; padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                    <label style="display: flex; align-items: center; gap: 12px; cursor: pointer;">
                                        <input type="checkbox" id="sbPrefSkipDisableConfirm" ${sbPrefs.SkipDisableConfirm ? 'checked' : ''} data-pref="SkipDisableConfirm" style="width:16px; height:16px; accent-color:${toggleAccentColor}; cursor:pointer;">
                                        <div><div style="font-weight:500; font-size:13px;">${JC.t!('panel_settings_spoiler_guard_skip_confirm')}</div><div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:1px;">${JC.t!('panel_settings_spoiler_guard_skip_confirm_desc')}</div></div>
                                    </label>
                                </div>
                                ${ctx.editor.mode === 'admin-target' && ctx.editor.spoilerGuardOverrides ? `
                                <div id="spoilerGuardTargetOverrides" aria-busy="false" style="margin-top:16px; padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor};">
                                    <div style="font-weight:600; font-size:13px;">${JC.t!('panel_settings_spoiler_guard_persistent_title')}</div>
                                    <div style="font-size:11px; color:rgba(255,255,255,0.6); margin:4px 0 12px;">${JC.t!('panel_settings_spoiler_guard_persistent_desc')}</div>
                                    <div id="spoilerGuardOverrideList"></div>
                                    <div id="spoilerGuardOverridePager" style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin:8px 0;"></div>
                                    <form id="spoilerGuardOverrideAddForm" class="jc-spoiler-overrides-form">
                                        <label style="display:flex; flex-direction:column; gap:4px; font-size:11px;">
                                            ${JC.t!('panel_settings_spoiler_guard_persistent_type')}
                                            <select id="spoilerGuardOverrideType" style="min-width:0; padding:8px; background:${presetBoxBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:5px;">
                                                <option value="series">${JC.t!('panel_settings_spoiler_guard_type_series')}</option>
                                                <option value="movie">${JC.t!('panel_settings_spoiler_guard_type_movie')}</option>
                                                <option value="collection">${JC.t!('panel_settings_spoiler_guard_type_collection')}</option>
                                                <option value="pending-tv">${JC.t!('panel_settings_spoiler_guard_type_pending_tv')}</option>
                                                <option value="pending-movie">${JC.t!('panel_settings_spoiler_guard_type_pending_movie')}</option>
                                            </select>
                                        </label>
                                        <label style="display:flex; flex-direction:column; gap:4px; font-size:11px;">
                                            ${JC.t!('panel_settings_spoiler_guard_persistent_id')}
                                            <input id="spoilerGuardOverrideId" autocomplete="off" maxlength="36" required style="min-width:0; padding:8px; background:${presetBoxBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:5px;">
                                        </label>
                                        <label style="display:flex; flex-direction:column; gap:4px; font-size:11px;">
                                            ${JC.t!('panel_settings_spoiler_guard_persistent_name')}
                                            <input id="spoilerGuardOverrideName" autocomplete="off" maxlength="512" required style="min-width:0; padding:8px; background:${presetBoxBackground}; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:5px;">
                                        </label>
                                        <button id="spoilerGuardOverrideAdd" type="submit" style="padding:9px 12px; background:${toggleAccentColor}; color:#fff; border:0; border-radius:5px; cursor:pointer;">${JC.t!('panel_settings_spoiler_guard_persistent_add')}</button>
                                    </form>
                                    <div id="spoilerGuardOverrideStatus" role="status" aria-live="polite" aria-atomic="true" style="min-height:18px; margin-top:8px; font-size:11px; color:rgba(255,255,255,0.68);"></div>
                                </div>` : ''}
                            </div>
                        </section>`;
                    })() : ''}
                    <section class="jc-pane" data-pane="language">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.LANGUAGE)} ${JC.t!('panel_settings_language')}</h3>
                        <div style="padding: 0 16px 16px 16px;">
                            <div style="margin-bottom: 16px;">
                                <div style="font-weight: 600; margin-bottom: 8px;">${JC.t!('panel_settings_language_display')}</div>
                                <select id="displayLanguageSelect" style="width: 100%; padding: 12px; background: ${presetBoxBackground}; color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; font-size: 14px; cursor: pointer; font-family: inherit;">
                                    <option value="" style="background: rgba(30,30,30,1); color: #fff;">Auto</option>
                                    <!-- Languages will be populated dynamically -->
                                </select>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JC.t!('panel_settings_language_display_desc')}</div>
                            </div>
                            ${ctx.editor.mode === 'admin-target' ? `
                            <div style="padding:12px; background:${presetBoxBackground}; border-radius:6px; border-left:3px solid ${toggleAccentColor}; color:rgba(255,255,255,0.72);">
                                ${escapeHtml(JC.t!(
                                    'panel_admin_target_translation_cache_unavailable',
                                ))}
                            </div>` : `
                            <div style="padding: 12px; background: ${presetBoxBackground}; border-radius: 6px; border-left: 3px solid ${toggleAccentColor};">
                                <button id="clearTranslationCacheButton" style="width: 100%; padding: 12px; background: ${toggleAccentColor}; color: white; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
                                    ${JC.t!('panel_settings_language_clear_cache')}
                                </button>
                                <div style="font-size:12px; color:rgba(255,255,255,0.6); margin-top:8px;">${JC.t!('panel_settings_language_clear_cache_desc')}</div>
                            </div>`}
                        </div>
                    </section>
                    <section class="jc-pane" data-pane="about">
                        <h3 class="jc-pane-title">${JC.icon!(JC.IconName!.QUESTION)} ${JC.t!('panel_about_title')}</h3>
                        <div style="padding: 4px 0 16px 0; display: flex; flex-direction: column; gap: 14px;">
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <img src="${escapeHtml(assetUrl('branding/canopy-mark.svg'))}" alt="" width="34" height="29">
                                <div>
                                    <div style="font-weight: 700; font-size: 16px;">Jellyfin Canopy</div>
                                    <div style="font-size: 12px; color: rgba(255,255,255,0.7);">${escapeHtml(JC.t!('panel_version', { version: JC.pluginVersion }))}</div>
                                </div>
                            </div>
                            <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
                                <button id="releaseNotesBtn" style="font-family:inherit; background:${brandGradient}; color:#fff; text-shadow:0 1px 2px rgba(0,6,17,0.35); border:none; padding:8px 14px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; transition:opacity 0.2s; display:flex; align-items:center; gap:6px;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">${JC.t!('panel_footer_release_notes')}</button>
                                <a href="https://github.com/${GITHUB_REPO}/" target="_blank" style="color:${primaryAccentColor}; text-decoration:none; display:flex; align-items:center; gap:6px; font-size:13px; padding:8px 12px; border-radius:8px; background:${githubButtonBg}; transition:background 0.2s;" onmouseover="this.style.background='rgba(102, 179, 255, 0.2)'" onmouseout="this.style.background='${githubButtonBg}'"><svg height="13" viewBox="0 0 24 24" width="13" fill="currentColor"><path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128a10.193 10.193 0 0 1 2.75-.371c.936 0 1.871.123 2.75.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z"></path></svg> ${JC.t!('panel_footer_contribute')}</a>
                            </div>
                            ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" class="footer-logo" alt="Theme Logo" style="height: 40px; align-self: flex-start;">` : ''}
                        </div>
                    </section>
                </div>
                </div>
            </div>
            <div class="panel-footer" style="padding: 10px 20px; border-top: 1px solid rgba(255,255,255,0.1); background: ${headerFooterBg}; display: flex; justify-content: center; align-items: center;">
                <div class="close-helptext" style="font-size:12px; color:rgba(255,255,255,0.5);">${JC.t!('panel_footer_close')}</div>
            </div>
            <button id="closeSettingsPanel" style="position:absolute; top:24px; right:24px; background:rgba(255,255,255,0.1); border:none; color:#fff; font-size:16px; cursor:pointer; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.2)'" onmouseout="this.style.background='rgba(255,255,255,0.1)'">×</button>
        `;
}
