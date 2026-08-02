// src/enhanced/bookmarks/library-modals.ts
//
// Bookmarks Library View — offset-adjustment and duplicate-merge modals.
// Split from bookmarks-library.js (code motion; bodies verbatim).
// (Converted from js/enhanced/bookmarks-library-modals.js — bodies semantically identical.)

import { JC } from '../../globals';
import { currentPageOwner } from '../pages/fallback-host';
import { escapeHtml, toast } from '../../core/ui-kit';
import { formatTimestamp, renderActiveBookmarks } from './library-render';
import type { IdentityContext } from '../../types/jc';
import { normalizeBookmarkMediaType } from './media-types';
import { bookmarkIdentityLabel } from './bookmark-identity';
import {
  createBookmarkModalControlId,
  installBookmarkModalA11y,
  releaseBookmarkModalA11y
} from './modal-a11y';

/* eslint-disable @typescript-eslint/no-explicit-any */

const modalTimers = new Set<number>();
export const BOOKMARK_DUPLICATE_GROUP_PAGE_SIZE = 10;
export const BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE = 10;
export const BOOKMARK_DUPLICATE_TIMESTAMP_PREVIEW_SIZE = 10;
export const BOOKMARK_OFFSET_PREVIEW_SIZE = 50;
export const BOOKMARK_DUPLICATE_SCAN_MAX_BOOKMARKS = 1000;

function scheduleModalTask(context: IdentityContext, callback: () => void, delay: number): void {
  const timer = window.setTimeout(() => {
    modalTimers.delete(timer);
    if (JC.identity.isCurrent(context)) callback();
  }, delay);
  modalTimers.add(timer);
}

function ownModal(modal: HTMLElement): void {
  modal.dataset.jcIdentityOwned = 'true';
  modal.dataset.jcBookmarkLibraryModal = 'true';
}

function closeModal(modal: HTMLElement): void {
  releaseBookmarkModalA11y(modal);
  if (!modal.isConnected || modal.dataset.jcClosing === 'true') return;
  modal.dataset.jcClosing = 'true';
  modal.style.opacity = '0';
  const timer = window.setTimeout(() => {
    modalTimers.delete(timer);
    modal.remove();
  }, 200);
  modalTimers.add(timer);
}

export function resetBookmarksLibraryModals(): void {
  for (const timer of modalTimers) window.clearTimeout(timer);
  modalTimers.clear();
  document.querySelectorAll('[data-jc-bookmark-library-modal="true"]').forEach((modal) => {
    releaseBookmarkModalA11y(modal as HTMLElement);
    modal.remove();
  });
}

/**
 * Show modal to adjust time offset for synced bookmarks
 */
export function showOffsetAdjustmentModal(
  group: any,
  context: IdentityContext | null = JC.identity.capture()
): void {
  if (!context || !JC.identity.isCurrent(context)) return;
  const syncedBookmarks = group.bookmarks.filter((bm: any) => bm.syncedFrom);
  if (syncedBookmarks.length === 0) {
    toast(JC.t!('bookmark_no_synced'), 2000);
    return;
  }
  const previewBookmarks = syncedBookmarks.slice(0, BOOKMARK_OFFSET_PREVIEW_SIZE);
  const previewRemainder = syncedBookmarks.length - previewBookmarks.length;
  const offsetInputId = createBookmarkModalControlId('offset');

  const modal = document.createElement('div');
  modal.className = 'jc-bm-library-modal-overlay';
  ownModal(modal);
  modal.innerHTML = `
    <div class="jc-bm-library-modal-container" style="max-width: 550px;">
      <button type="button" class="jc-bm-library-modal-close" aria-label="Close bookmark offset dialog">×</button>
      <div class="jc-bm-library-modal-content">
        <div class="jc-bookmarks-modal-header">
          <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #2196f3; flex-shrink: 0;">schedule</span>
          <div style="flex: 1;">
            <h2 class="jc-modal-title">${JC.t!('bookmark_adjust_offset')}</h2>
            <p class="jc-modal-subtitle">${JC.t!('bookmark_synced_count').replace('{count}', syncedBookmarks.length)} ${JC.t!('bookmark_for_item').replace('{name}', escapeHtml(group.details.name))}</p>
          </div>
        </div>

        <div class="jc-modal-info-box">
          <div class="jc-modal-info-title"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">info</span> ${JC.t!('bookmark_synced_info_title')}</div>
          <div class="jc-modal-info-text">${JC.t!('bookmark_synced_info_body')}</div>
        </div>

        <div style="margin-bottom: 24px;">
          <label for="${offsetInputId}" class="jc-modal-label"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">schedule</span> ${JC.t!('bookmark_offset_label')}</label>
          <input type="number" id="${offsetInputId}" value="0" step="0.1" placeholder="0" class="jc-modal-input">
          <div class="jc-modal-help-text">${JC.t!('bookmark_offset_help')}</div>
        </div>

        <div class="jc-modal-list-container">
          <div class="jc-modal-list-title">${JC.t!('bookmark_offset_affected')}</div>
          ${previewBookmarks.map((bm: any) => `
            <div class="jc-modal-list-item">
              <div class="jc-modal-list-item-title">${escapeHtml(bm.label || JC.t!('bookmark_unlabeled'))}</div>
              <div class="jc-modal-list-item-meta">${formatTimestamp(bm.timestamp)} • ${JC.t!('bookmark_from').replace('{source}', escapeHtml(bm.syncedFrom))}</div>
            </div>
          `).join('')}
          ${previewRemainder > 0 ? `<div class="jc-modal-list-item jc-offset-preview-remainder">+${previewRemainder}</div>` : ''}
        </div>
      </div>

      <div class="jc-bookmark-modal-actions">
        <button type="button" class="jc-bookmark-btn-cancel">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
          <span>Cancel</span>
        </button>
        <button type="button" class="btnApplyOffset jc-modal-btn-primary">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">check</span>
          <span>${JC.t!('bookmark_apply_offset')}</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeDialog = () => closeModal(modal);
  // Body-level modal: the page's dispose bag closes it on drain.
  currentPageOwner('bookmarks')?.handle.track(closeDialog);

  modal.querySelector('.jc-bm-library-modal-close')?.addEventListener('click', closeDialog);
  modal.querySelector('.jc-bookmark-btn-cancel')?.addEventListener('click', closeDialog);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });
  installBookmarkModalA11y(modal, {
    title: modal.querySelector<HTMLElement>('.jc-modal-title')!,
    description: modal.querySelector<HTMLElement>('.jc-modal-subtitle'),
    initialFocus: modal.querySelector<HTMLInputElement>(`#${offsetInputId}`),
    onEscape: closeDialog
  });

  // Apply offset button handler
  modal.querySelector('.btnApplyOffset')?.addEventListener('click', () => { void (async () => {
    if (!JC.identity.isCurrent(context)) return;
    const offset = parseFloat(modal.querySelector<HTMLInputElement>(`#${offsetInputId}`)!.value) || 0;

    const btn = modal.querySelector<HTMLButtonElement>('.btnApplyOffset')!;
    btn.disabled = true;
    btn.querySelector('span:last-child')!.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';

    try {
      const updatedCount = await JC.bookmarks!.adjustOffsets(syncedBookmarks, offset);
      if (!JC.identity.isCurrent(context)) return;
      const safeUpdatedCount = Number(updatedCount) || 0;

      if (safeUpdatedCount > 0) {
        const message = offset === 0
          ? JC.t!('bookmark_offset_cleared').replace('{count}', String(safeUpdatedCount))
          : JC.t!('bookmark_offset_applied').replace('{count}', String(safeUpdatedCount)).replace('{offset}', `${offset > 0 ? '+' : ''}${offset}s`);
        toast(message, 3000);
        closeDialog();

        // Refresh the adopted host (the awaited updates already resolved — no
        // blind setTimeout needed).
        renderActiveBookmarks(context);
      } else {
        toast(JC.t!('bookmark_update_failed'), 3000, 'error');
        btn.disabled = false;
        btn.querySelector('span:last-child')!.textContent = JC.t!('bookmark_apply_offset');
      }
    } catch (e) {
      if (!JC.identity.isCurrent(context)) return;
      console.error('Failed to apply offset:', e);
      toast(JC.t!('bookmark_offset_failed'), 3000, 'error');
      btn.disabled = false;
      btn.querySelector('span:last-child')!.textContent = JC.t!('bookmark_apply_offset');
    }
  })(); });

  // Fade in
  scheduleModalTask(context, () => { if (modal.isConnected) modal.style.opacity = '1'; }, 10);
}

/**
 * Find duplicate bookmarks: distinct Jellyfin item IDs that carry the same
 * logical content identity (media type plus provider IDs within their named
 * namespaces). Each item ID contributes exactly one canonical candidate, so a
 * record carrying both a TMDB and a TVDB ID yields one relationship — never
 * one group per provider key. Output order (groups, versions, and records) is
 * a stable item-ID/bookmark-ID sort: store insertion order carries no meaning
 * and no primary is designated — the merge target is an explicit selection
 * made later in the modal.
 */
export function findDuplicateBookmarks(bookmarks: Record<string, any>): any[] {
  const identityText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
  const identityInteger = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
    return null;
  };
  const comparableType = (identity: any): string => {
    const type = identityText(identity.itemType).toLowerCase();
    if (identity.identityVersion === 1 && type) return type;
    return normalizeBookmarkMediaType(identity.mediaType) === 'movie' ? 'movie' : '';
  };
  const describe = (identity: any): {
    type: string;
    tokens: string[];
    constraints: Array<[string, string]>;
  } | null => {
    const type = comparableType(identity);
    if (!type) return null;
    const constraints: Array<[string, string]> = [];
    const tokens: string[] = [];
    const addText = (field: string, value: unknown, tokenPrefix?: string): string => {
      const normalized = identityText(value);
      if (normalized) {
        constraints.push([field, normalized]);
        if (tokenPrefix) tokens.push(`${type}:${tokenPrefix}:${normalized}`);
      }
      return normalized;
    };
    addText('tmdbId', identity.tmdbId, 'tmdb');
    addText('tvdbId', identity.tvdbId, 'tvdb');
    if (type === 'episode' || type === 'season') {
      const seriesTmdb = addText('seriesTmdbId', identity.seriesTmdbId);
      const seriesTvdb = addText('seriesTvdbId', identity.seriesTvdbId);
      const season = identityInteger(identity.seasonNumber);
      if (season !== null) constraints.push(['seasonNumber', String(season)]);
      if (type === 'episode') {
        const start = identityInteger(identity.episodeNumber);
        const explicitEnd = identityInteger(identity.episodeEndNumber);
        if (start !== null) constraints.push(['episodeNumber', String(start)]);
        if (explicitEnd !== null) constraints.push(['episodeEndNumber', String(explicitEnd)]);
        const end = explicitEnd ?? start;
        if (season !== null && start !== null && end !== null) {
          if (seriesTmdb) tokens.push(`${type}:series-tmdb:${seriesTmdb}:${season}:${start}:${end}`);
          if (seriesTvdb) tokens.push(`${type}:series-tvdb:${seriesTvdb}:${season}:${start}:${end}`);
        }
      } else if (season !== null) {
        if (seriesTmdb) tokens.push(`${type}:series-tmdb:${seriesTmdb}:${season}`);
        if (seriesTvdb) tokens.push(`${type}:series-tvdb:${seriesTvdb}:${season}`);
      }
    }
    constraints.sort(([left], [right]) => left.localeCompare(right));
    const uniqueTokens = [...new Set(tokens)].sort();
    return uniqueTokens.length > 0 ? { type, tokens: uniqueTokens, constraints } : null;
  };
  const compatible = (
    descriptor: NonNullable<ReturnType<typeof describe>>,
    group: {
      type: string;
      constraints: Map<string, string>;
      memberTokenSets: string[][];
    }
  ): boolean => descriptor.type === group.type
    && descriptor.constraints.every(([field, value]) => {
      const fixed = group.constraints.get(field);
      return fixed === undefined || fixed === value;
    })
    && group.memberTokenSets.every(member => member.some(token => descriptor.tokens.includes(token)));
  const identitySignature = (identity: any): string => JSON.stringify([
    identity.identityVersion ?? 0, String(identity.itemType ?? '').trim().toLowerCase(),
    String(identity.tmdbId ?? '').trim(), String(identity.tvdbId ?? '').trim(),
    String(identity.seriesTmdbId ?? '').trim(), String(identity.seriesTvdbId ?? '').trim(),
    normalizeBookmarkMediaType(identity.mediaType), identity.seasonNumber ?? null,
    identity.episodeNumber ?? null, identity.episodeEndNumber ?? null
  ]);
  const versions = new Map<string, any[]>();
  for (const [id, bookmark] of Object.entries<any>(bookmarks)) {
    if (!bookmark || typeof bookmark !== 'object' || !bookmark.itemId) continue;
    const current = versions.get(bookmark.itemId) || [];
    current.push({ id, ...bookmark });
    versions.set(bookmark.itemId, current);
  }

  const candidates = [...versions.entries()]
    .sort(([leftItemId], [rightItemId]) => leftItemId.localeCompare(rightItemId))
    .flatMap(([itemId, records]) => {
      const identityFields = (record: any): unknown[] => [
        record.identityVersion ?? 0, record.itemType ?? '', record.mediaType ?? '',
        record.tmdbId ?? '', record.tvdbId ?? '', record.seriesTmdbId ?? '', record.seriesTvdbId ?? '',
        record.seasonNumber ?? '', record.episodeNumber ?? '', record.episodeEndNumber ?? ''
      ];
      const ranked = [...records].sort((left, right) => {
        const leftFields = identityFields(left);
        const rightFields = identityFields(right);
        const isPresent = (value: unknown): boolean => value !== null && value !== undefined
          && (typeof value !== 'string' || value.trim() !== '');
        const completeness = rightFields.filter(isPresent).length - leftFields.filter(isPresent).length;
        return completeness || JSON.stringify(leftFields).localeCompare(JSON.stringify(rightFields));
      });
      const identity = ranked[0];
      // Collapse rows with the same identity before the pairwise ambiguity
      // check. This keeps 1,000 timestamps for one version linear while still
      // comparing every distinct identity combination and failing closed when
      // an adversarial store would exceed the explicit responsiveness budget.
      const recordIdentityClasses = new Map<string, any>();
      for (const record of records) {
        const rawVersion = record.identityVersion === undefined ? '__missing__' : record.identityVersion;
        const signature = JSON.stringify([rawVersion, identitySignature(record)]);
        if (!recordIdentityClasses.has(signature)) recordIdentityClasses.set(signature, record);
      }
      const distinctRecordIdentities = [...recordIdentityClasses.values()];
      const descriptors = distinctRecordIdentities.map(describe);
      const firstDescriptor = descriptors[0];
      const consistencyGroup = firstDescriptor ? {
        type: firstDescriptor.type,
        constraints: new Map(firstDescriptor.constraints),
        memberTokenSets: [firstDescriptor.tokens]
      } : null;
      const consistent = !!consistencyGroup && descriptors.every((descriptor, index) => {
        if (!descriptor
          || distinctRecordIdentities[index].identityVersion !== distinctRecordIdentities[0].identityVersion
          || !compatible(descriptor, consistencyGroup)) return false;
        for (const [field, value] of descriptor.constraints) consistencyGroup.constraints.set(field, value);
        if (!consistencyGroup.memberTokenSets.some(tokens => tokens.join('\0') === descriptor.tokens.join('\0'))) {
          consistencyGroup.memberTokenSets.push(descriptor.tokens);
        }
        return true;
      });
      // Multiple timestamps for one Jellyfin item should carry the same logical
      // identity. Mixed legacy/v1 or conflicting metadata is retained visibly,
      // but cannot nominate a merge identity based on insertion order.
      const orderedRecords = [...records].sort((left, right) => String(left.id).localeCompare(String(right.id)));
      const descriptor = describe(identity);
      return consistent && descriptor ? [{ itemId, records: orderedRecords, identity, descriptor }] : [];
    });
  type Candidate = (typeof candidates)[number];
  const groups: Array<{
    members: Candidate[];
    type: string;
    constraints: Map<string, string>;
    memberTokenSets: string[][];
  }> = [];
  // Provider tokens nominate only groups that share actual identity evidence.
  // Compatibility is then checked directly against the group's at-most-seven
  // fixed fields. This avoids materializing every constraint subset (up to 128
  // routes per token for a rich episode) while preserving fail-closed conflict
  // and non-transitive bridge handling.
  const routes = new Map<string, Set<number>>();
  const register = (groupId: number): void => {
    const group = groups[groupId];
    const tokens = [...new Set(group.memberTokenSets.flat())];
    for (const token of tokens) {
      const key = `${group.type}\0${token}`;
      const groupIds = routes.get(key) || new Set<number>();
      groupIds.add(groupId);
      routes.set(key, groupIds);
    }
  };
  for (const candidate of candidates) {
    const possible = new Set<number>();
    for (const token of candidate.descriptor.tokens) {
      const groupIds = routes.get(`${candidate.descriptor.type}\0${token}`);
      if (groupIds) for (const groupId of groupIds) possible.add(groupId);
    }
    // Discard fixed-field conflicts before the more detailed member-token
    // check. Popular provider ids therefore remain bounded by the compact
    // seven-field descriptors instead of allocating route projections.
    for (const groupId of possible) {
      if (candidate.descriptor.constraints.some(([field, value]) => {
        const fixed = groups[groupId].constraints.get(field);
        return fixed !== undefined && fixed !== value;
      })) possible.delete(groupId);
    }
    const groupId = [...possible].sort((left, right) => left - right)
      .find(id => compatible(candidate.descriptor, groups[id]));
    if (groupId === undefined) {
      groups.push({
        members: [candidate],
        type: candidate.descriptor.type,
        constraints: new Map(candidate.descriptor.constraints),
        memberTokenSets: [candidate.descriptor.tokens]
      });
      register(groups.length - 1);
      continue;
    }
    const group = groups[groupId];
    group.members.push(candidate);
    for (const [field, value] of candidate.descriptor.constraints) group.constraints.set(field, value);
    if (!group.memberTokenSets.some(tokens => tokens.join('\0') === candidate.descriptor.tokens.join('\0'))) {
      group.memberTokenSets.push(candidate.descriptor.tokens);
    }
    register(groupId);
  }

  const duplicateGroups: any[] = [];
  for (const group of groups) {
    const memberCandidates = group.members;
    if (memberCandidates.length < 2) continue;
    const itemGroups = Object.fromEntries(memberCandidates.map(member => [
      member.itemId,
      member.records
    ]));
    const canonicalIdentities = Object.fromEntries(memberCandidates.map(member => [
      member.itemId,
      member.identity
    ]));
    duplicateGroups.push({
      providerKey: bookmarkIdentityLabel(memberCandidates[0].identity),
      itemGroups,
      canonicalIdentities,
      totalBookmarks: Object.values<any>(itemGroups).flat().length,
      name: memberCandidates[0].identity.name || 'Unknown'
    });
  }

  return duplicateGroups;
}

/** Carry the exact identity selected during duplicate detection into execution. */
export function duplicateMergeTarget(duplicate: any, primaryItemId: string): Record<string, any> | null {
  const identity = duplicate?.canonicalIdentities?.[primaryItemId];
  if (!identity || typeof identity !== 'object') return null;
  return {
    ...identity,
    itemId: primaryItemId,
    mediaType: normalizeBookmarkMediaType(identity.mediaType),
    name: identity.name || 'Unknown'
  };
}

/** Enrich every source timestamp with its detection-time canonical identity. */
export function duplicateMergeSources(duplicate: any, sourceItemIds: string[]): any[] {
  const identityFields = [
    'identityVersion', 'itemType', 'tmdbId', 'tvdbId', 'seriesTmdbId',
    'seriesTvdbId', 'mediaType', 'seasonNumber', 'episodeNumber', 'episodeEndNumber'
  ];
  return sourceItemIds.flatMap(itemId => {
    const canonical = duplicate?.canonicalIdentities?.[itemId];
    if (!canonical || typeof canonical !== 'object') return [];
    const identity = Object.fromEntries(identityFields.map(field => [field, canonical[field]]));
    return (duplicate.itemGroups?.[itemId] || []).map((bookmark: any) => ({
      ...bookmark,
      ...identity,
      itemId
    }));
  });
}

/**
 * Show modal to sync duplicate bookmarks
 */
export function showDuplicatesSyncModal(
  bookmarks: Record<string, any>,
  context: IdentityContext | null = JC.identity.capture()
): void {
  if (!context || !JC.identity.isCurrent(context)) return;
  if (Object.keys(bookmarks).length > BOOKMARK_DUPLICATE_SCAN_MAX_BOOKMARKS) {
    console.warn(`Duplicate scan refused an over-limit legacy store (${Object.keys(bookmarks).length})`);
    toast(JC.t!('bookmark_merge_failed'), 3000, 'error');
    return;
  }
  let duplicates: any[];
  try {
    duplicates = findDuplicateBookmarks(bookmarks);
  } catch (error) {
    console.warn('Duplicate scan stopped at its comparison budget', error);
    toast(JC.t!('bookmark_merge_failed'), 3000, 'error');
    return;
  }

  if (duplicates.length === 0) {
    toast(JC.t!('bookmark_no_duplicates'), 3000);
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'jc-bm-library-modal-overlay';
  ownModal(modal);
  modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
  modal.innerHTML = `
    <div class="jc-bm-library-modal-container" style="max-width: 700px; background: #181818; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 8px 32px rgba(0,0,0,0.8); max-height: 85vh; overflow-y: auto;">
      <button type="button" class="jc-bm-library-modal-close" aria-label="Close duplicate bookmarks dialog" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
      <div class="jc-bm-library-modal-content">
        <div class="jc-bookmarks-modal-header" style="display: flex; gap: 16px; align-items: flex-start; margin-bottom: 24px;">
          <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #ff9800; flex-shrink: 0;">merge</span>
          <div style="flex: 1;">
            <h2 class="jc-modal-title" style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #fff;">${JC.t!('bookmark_duplicate_title')}</h2>
            <p class="jc-modal-subtitle" style="margin: 0; font-size: 13px; color: #aaa;">${JC.t!('bookmark_duplicate_subtitle').replace('{count}', String(duplicates.length))}</p>
          </div>
        </div>
        <div class="jc-duplicate-groups-page" style="margin-top: 20px;"></div>
        <div class="jc-duplicate-group-pagination" style="display:flex;align-items:center;justify-content:center;gap:12px;">
          <button type="button" class="jc-btn jc-duplicate-groups-prev" aria-label="${escapeHtml(JC.t!('calendar_prev'))}"><span class="material-icons" aria-hidden="true">chevron_left</span></button>
          <span class="jc-duplicate-groups-status" aria-live="polite"></span>
          <button type="button" class="jc-btn jc-duplicate-groups-next" aria-label="${escapeHtml(JC.t!('calendar_next'))}"><span class="material-icons" aria-hidden="true">chevron_right</span></button>
        </div>
      </div>
      <div class="jc-bookmark-modal-actions">
        <button type="button" class="jc-bookmark-btn-cancel">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
          <span>Close</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeDialog = () => closeModal(modal);
  // Body-level modal: the page's dispose bag closes it on drain.
  currentPageOwner('bookmarks')?.handle.track(closeDialog);

  modal.querySelector('.jc-bm-library-modal-close')?.addEventListener('click', closeDialog);
  modal.querySelector('.jc-bookmark-btn-cancel')?.addEventListener('click', closeDialog);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });
  let groupPage = 0;
  const versionPages = new Map<number, number>();
  const selectedTargets = new Map<number, string>();
  let mergePending = false;
  const groupsContainer = modal.querySelector<HTMLElement>('.jc-duplicate-groups-page')!;
  const previousGroups = modal.querySelector<HTMLButtonElement>('.jc-duplicate-groups-prev')!;
  const nextGroups = modal.querySelector<HTMLButtonElement>('.jc-duplicate-groups-next')!;
  const groupsStatus = modal.querySelector<HTMLElement>('.jc-duplicate-groups-status')!;
  const groupPageCount = Math.ceil(duplicates.length / BOOKMARK_DUPLICATE_GROUP_PAGE_SIZE);

  const renderDuplicateModalPage = (): void => {
    if (!JC.identity.isCurrent(context) || mergePending) return;
    const groupStart = groupPage * BOOKMARK_DUPLICATE_GROUP_PAGE_SIZE;
    const visibleGroups = duplicates.slice(groupStart, groupStart + BOOKMARK_DUPLICATE_GROUP_PAGE_SIZE);
    groupsContainer.innerHTML = visibleGroups.map((dup, localIndex) => {
      const dupIndex = groupStart + localIndex;
      const itemIds = Object.keys(dup.itemGroups);
      const versionPageCount = Math.ceil(itemIds.length / BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE);
      const versionPage = Math.min(versionPages.get(dupIndex) || 0, versionPageCount - 1);
      versionPages.set(dupIndex, versionPage);
      const versionStart = versionPage * BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE;
      const selected = selectedTargets.get(dupIndex) || '';
      const versions = itemIds.slice(versionStart, versionStart + BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE)
        .map(itemId => {
          const bms = dup.itemGroups[itemId] as any[];
          const isTarget = selected === itemId;
          const role = !selected
            ? JC.t!('bookmark_version_neutral')
            : isTarget ? JC.t!('bookmark_primary_version') : JC.t!('bookmark_old_version');
          const timestamps = bms.slice(0, BOOKMARK_DUPLICATE_TIMESTAMP_PREVIEW_SIZE)
            .map(bookmark => formatTimestamp(bookmark.timestamp));
          if (bms.length > timestamps.length) timestamps.push(`+${bms.length - timestamps.length}`);
          return `
            <div class="jc-merge-version" data-dup-index="${dupIndex}" data-version-item-id="${escapeHtml(itemId)}" style="background:rgba(255,255,255,.02);border-left:3px solid ${!selected ? 'rgba(255,255,255,.25)' : isTarget ? '#4caf50' : '#ff9800'};padding:8px 12px;margin-bottom:8px;border-radius:4px;">
              <div class="jc-merge-version-role" style="font-size:11px;color:${!selected ? '#aaa' : isTarget ? '#4caf50' : '#ff9800'};font-weight:600;margin-bottom:4px;">${role}</div>
              <div style="font-size:12px;color:#ccc;margin-bottom:6px;">${JC.t!('bookmark_item_id')}: <code>${escapeHtml(itemId.substring(0, 16))}...</code></div>
              <div style="font-size:12px;color:#aaa;margin-bottom:8px;">${JC.t!('bookmark_bookmark_count').replace('{count}', String(bms.length))} ${escapeHtml(timestamps.join(', '))}</div>
              <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#ccc;margin-bottom:8px;cursor:pointer;">
                <input type="radio" class="jc-merge-target-choice" name="jc-merge-target-${dupIndex}" value="${escapeHtml(itemId)}" data-dup-index="${dupIndex}" ${isTarget ? 'checked' : ''}>
                <span>${JC.t!('bookmark_select_target')}</span>
              </label>
              <button type="button" class="jc-btn" data-offset-item-id="${escapeHtml(itemId)}" data-dup-index="${dupIndex}"><span class="material-icons" aria-hidden="true">schedule</span><span>${JC.t!('bookmark_adjust_offset')}</span></button>
            </div>`;
        }).join('');
      return `
        <div class="jc-duplicate-group" data-dup-index="${dupIndex}" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:16px;margin-bottom:16px;">
          <div style="font-weight:600;margin-bottom:12px;color:#ff9800;">${escapeHtml(dup.name)}</div>
          <div style="font-size:12px;color:#888;margin-bottom:12px;">${JC.t!('bookmark_split_versions').replace('{count}', String(Number(dup.totalBookmarks) || 0)).replace('{versions}', String(itemIds.length))}</div>
          ${versions}
          <div class="jc-duplicate-version-pagination" style="display:flex;align-items:center;gap:8px;">
            <button type="button" class="jc-btn jc-duplicate-versions-prev" aria-label="${escapeHtml(JC.t!('calendar_prev'))}" data-dup-index="${dupIndex}" ${versionPage === 0 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">chevron_left</span></button>
            <span class="jc-duplicate-versions-status" aria-live="polite">${versionStart + 1}-${Math.min(versionStart + BOOKMARK_DUPLICATE_VERSION_PAGE_SIZE, itemIds.length)} / ${itemIds.length}</span>
            <button type="button" class="jc-btn jc-duplicate-versions-next" aria-label="${escapeHtml(JC.t!('calendar_next'))}" data-dup-index="${dupIndex}" ${versionPage >= versionPageCount - 1 ? 'disabled' : ''}><span class="material-icons" aria-hidden="true">chevron_right</span></button>
          </div>
          <button type="button" class="jc-btn jc-merge-execute" data-dup-index="${dupIndex}" ${selected ? '' : 'disabled'}><span class="material-icons" aria-hidden="true">merge</span><span>${JC.t!('bookmark_merge_primary')}</span></button>
        </div>`;
    }).join('');

    previousGroups.disabled = groupPage === 0;
    nextGroups.disabled = groupPage >= groupPageCount - 1;
    groupsStatus.textContent = `${groupStart + 1}-${Math.min(groupStart + BOOKMARK_DUPLICATE_GROUP_PAGE_SIZE, duplicates.length)} / ${duplicates.length}`;

    groupsContainer.querySelectorAll<HTMLInputElement>('.jc-merge-target-choice').forEach(radio => {
      radio.addEventListener('change', () => {
        if (!JC.identity.isCurrent(context)) return;
        selectedTargets.set(Number(radio.dataset.dupIndex), radio.value);
        renderDuplicateModalPage();
        [...groupsContainer.querySelectorAll<HTMLInputElement>('.jc-merge-target-choice')]
          .find(candidate => candidate.value === radio.value)?.focus();
      });
    });
    groupsContainer.querySelectorAll<HTMLButtonElement>('.jc-duplicate-versions-prev, .jc-duplicate-versions-next').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.dupIndex);
        const delta = button.classList.contains('jc-duplicate-versions-next') ? 1 : -1;
        const focusClass = delta > 0 ? 'jc-duplicate-versions-next' : 'jc-duplicate-versions-prev';
        versionPages.set(index, Math.max(0, (versionPages.get(index) || 0) + delta));
        renderDuplicateModalPage();
        groupsContainer.querySelector<HTMLButtonElement>(
          `.jc-duplicate-group[data-dup-index="${index}"] .${focusClass}`
        )?.focus();
      });
    });
    groupsContainer.querySelectorAll<HTMLButtonElement>('[data-offset-item-id]').forEach(button => {
      button.addEventListener('click', () => {
        if (!JC.identity.isCurrent(context)) return;
        const dup = duplicates[Number(button.dataset.dupIndex)];
        const bookmarksForItem = dup?.itemGroups?.[button.dataset.offsetItemId!];
        if (!bookmarksForItem) return;
        closeDialog();
        showOffsetAdjustmentModal({ bookmarks: bookmarksForItem, details: { name: dup.name } }, context);
      });
    });
    groupsContainer.querySelectorAll<HTMLButtonElement>('.jc-merge-execute').forEach(button => {
      button.addEventListener('click', () => { void (async () => {
        if (!JC.identity.isCurrent(context) || mergePending) return;
        const dupIndex = Number(button.dataset.dupIndex);
        const dup = duplicates[dupIndex];
        const itemIds = Object.keys(dup.itemGroups);
        const targetItemId = selectedTargets.get(dupIndex) || '';
        if (!targetItemId || !itemIds.includes(targetItemId)) return;
        const sourceBookmarks = duplicateMergeSources(dup, itemIds.filter(id => id !== targetItemId));
        const removeOldIds = sourceBookmarks.map((bookmark: any) => String(bookmark.id));
        if (!confirm(JC.t!('bookmark_merge_confirm').replace('{count}', String(sourceBookmarks.length)))) return;
        if (!JC.identity.isCurrent(context)) return;
        mergePending = true;
        modal.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(control => { control.disabled = true; });
        button.querySelector('span:last-child')!.innerHTML = '<span class="material-icons" style="animation:spin 1s linear infinite;">refresh</span>';
        try {
          const targetDetails = duplicateMergeTarget(dup, targetItemId);
          if (!targetDetails) throw new Error('Duplicate group has no canonical selected target');
          const synced = await JC.bookmarks!.syncBookmarks(sourceBookmarks, targetDetails, 0, removeOldIds);
          if (!JC.identity.isCurrent(context)) return;
          toast(JC.t!('bookmark_merge_success').replace('{count}', String(synced.length)), 3000);
          closeDialog();
          renderActiveBookmarks(context);
        } catch (error) {
          if (!JC.identity.isCurrent(context)) return;
          console.error('Merge failed:', error);
          toast(JC.t!('bookmark_merge_failed'), 3000, 'error');
          mergePending = false;
          renderDuplicateModalPage();
        }
      })(); });
    });
  };

  previousGroups.addEventListener('click', () => {
    if (mergePending || groupPage === 0) return;
    groupPage--;
    renderDuplicateModalPage();
  });
  nextGroups.addEventListener('click', () => {
    if (mergePending || groupPage >= groupPageCount - 1) return;
    groupPage++;
    renderDuplicateModalPage();
  });
  renderDuplicateModalPage();
  installBookmarkModalA11y(modal, {
    title: modal.querySelector<HTMLElement>('.jc-modal-title')!,
    description: modal.querySelector<HTMLElement>('.jc-modal-subtitle'),
    initialFocus: modal.querySelector<HTMLInputElement>('.jc-merge-target-choice')
      ?? modal.querySelector<HTMLButtonElement>('.jc-bookmark-btn-cancel'),
    onEscape: closeDialog
  });

  scheduleModalTask(context, () => { if (modal.isConnected) modal.style.opacity = '1'; }, 10);
}
