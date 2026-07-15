// src/enhanced/bookmarks/library-modals.ts
//
// Bookmarks Library View — offset-adjustment and duplicate-merge modals.
// Split from bookmarks-library.js (code motion; bodies verbatim).
// (Converted from js/enhanced/bookmarks-library-modals.js — bodies semantically identical.)

import { JC } from '../../globals';
import { currentPageHandle } from '../pages/fallback-host';
import { escapeHtml, toast } from '../../core/ui-kit';
import { formatTimestamp, renderActiveBookmarks } from './library-render';
import type { IdentityContext } from '../../types/jc';
import { normalizeBookmarkMediaType } from './media-types';
import { bookmarkIdentityLabel, compareBookmarkIdentity } from './bookmark-identity';

/* eslint-disable @typescript-eslint/no-explicit-any */

const modalTimers = new Set<number>();

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
  if (!modal.isConnected) return;
  modal.style.opacity = '0';
  const timer = window.setTimeout(() => {
    modalTimers.delete(timer);
    modal.remove();
  }, 200);
  modalTimers.add(timer);
}

JC.identity.registerReset('bookmarks-library-modals', () => {
  for (const timer of modalTimers) window.clearTimeout(timer);
  modalTimers.clear();
  document.querySelectorAll('[data-jc-bookmark-library-modal="true"]').forEach((modal) => modal.remove());
});

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

  const modal = document.createElement('div');
  modal.className = 'jc-bm-library-modal-overlay';
  ownModal(modal);
  modal.innerHTML = `
    <div class="jc-bm-library-modal-container" style="max-width: 550px;">
      <button class="jc-bm-library-modal-close">×</button>
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
          <label for="offset-adjustment-input" class="jc-modal-label"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">schedule</span> ${JC.t!('bookmark_offset_label')}</label>
          <input type="number" id="offset-adjustment-input" value="0" step="0.1" placeholder="0" class="jc-modal-input">
          <div class="jc-modal-help-text">${JC.t!('bookmark_offset_help')}</div>
        </div>

        <div class="jc-modal-list-container">
          <div class="jc-modal-list-title">${JC.t!('bookmark_offset_affected')}</div>
          ${syncedBookmarks.map((bm: any) => `
            <div class="jc-modal-list-item">
              <div class="jc-modal-list-item-title">${escapeHtml(bm.label || JC.t!('bookmark_unlabeled'))}</div>
              <div class="jc-modal-list-item-meta">${formatTimestamp(bm.timestamp)} • ${JC.t!('bookmark_from').replace('{source}', escapeHtml(bm.syncedFrom))}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="jc-bookmark-modal-actions">
        <button class="jc-bookmark-btn-cancel">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
          <span>Cancel</span>
        </button>
        <button class="btnApplyOffset jc-modal-btn-primary">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">check</span>
          <span>${JC.t!('bookmark_apply_offset')}</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeDialog = () => closeModal(modal);
  // Body-level modal: the page's dispose bag closes it on drain.
  currentPageHandle()?.track(closeDialog);

  modal.querySelector('.jc-bm-library-modal-close')?.addEventListener('click', closeDialog);
  modal.querySelector('.jc-bookmark-btn-cancel')?.addEventListener('click', closeDialog);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });

  // Apply offset button handler
  modal.querySelector('.btnApplyOffset')?.addEventListener('click', () => { void (async () => {
    if (!JC.identity.isCurrent(context)) return;
    const offset = parseFloat(modal.querySelector<HTMLInputElement>('#offset-adjustment-input')!.value) || 0;

    const btn = modal.querySelector<HTMLButtonElement>('.btnApplyOffset')!;
    btn.disabled = true;
    btn.querySelector('span:last-child')!.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';

    try {
      let updatedCount = 0;

      // Update each synced bookmark
      for (const bm of syncedBookmarks) {
        if (!JC.identity.isCurrent(context)) return;
        const newTimestamp = Math.max(0, bm.timestamp + offset);
        const ok = await JC.bookmarks!.update(bm.id, {
          timestamp: newTimestamp,
          syncedFrom: '' // Clear syncedFrom to remove the icon
        });
        if (!JC.identity.isCurrent(context)) return;
        if (ok) updatedCount++;
      }

      if (updatedCount > 0) {
        const message = offset === 0
          ? JC.t!('bookmark_offset_cleared').replace('{count}', String(updatedCount))
          : JC.t!('bookmark_offset_applied').replace('{count}', String(updatedCount)).replace('{offset}', `${offset > 0 ? '+' : ''}${offset}s`);
        toast(message, 3000);
        closeDialog();

        // Refresh the adopted host (the awaited updates already resolved — no
        // blind setTimeout needed).
        renderActiveBookmarks(context);
      } else {
        toast(JC.t!('bookmark_update_failed'), 3000);
        btn.disabled = false;
        btn.querySelector('span:last-child')!.textContent = JC.t!('bookmark_apply_offset');
      }
    } catch (e) {
      if (!JC.identity.isCurrent(context)) return;
      console.error('Failed to apply offset:', e);
      toast(JC.t!('bookmark_offset_failed'), 3000);
      btn.disabled = false;
      btn.querySelector('span:last-child')!.textContent = JC.t!('bookmark_apply_offset');
    }
  })(); });

  // Fade in
  scheduleModalTask(context, () => { if (modal.isConnected) modal.style.opacity = '1'; }, 10);
}

/**
 * Find duplicate bookmarks (same TMDB/TVDB but different item IDs)
 */
export function findDuplicateBookmarks(bookmarks: Record<string, any>): any[] {
  const duplicateGroups: any[] = [];
  const versions = new Map<string, any[]>();
  for (const [id, bookmark] of Object.entries<any>(bookmarks)) {
    if (!bookmark || typeof bookmark !== 'object' || !bookmark.itemId) continue;
    const current = versions.get(bookmark.itemId) || [];
    current.push({ id, ...bookmark });
    versions.set(bookmark.itemId, current);
  }

  const candidates = [...versions.entries()].flatMap(([itemId, records]) => {
    const identityFields = (record: any): unknown[] => [
      record.identityVersion ?? 0, record.itemType ?? '', record.mediaType ?? '',
      record.tmdbId ?? '', record.tvdbId ?? '', record.seriesTmdbId ?? '', record.seriesTvdbId ?? '',
      record.seasonNumber ?? '', record.episodeNumber ?? '', record.episodeEndNumber ?? ''
    ];
    const ranked = [...records].sort((left, right) => {
      const leftFields = identityFields(left);
      const rightFields = identityFields(right);
      const completeness = rightFields.filter(Boolean).length - leftFields.filter(Boolean).length;
      return completeness || JSON.stringify(leftFields).localeCompare(JSON.stringify(rightFields));
    });
    const identity = ranked[0];
    const consistent = records.every((left, leftIndex) => records.every((right, rightIndex) =>
      leftIndex === rightIndex || (
        left.identityVersion === right.identityVersion
        && compareBookmarkIdentity(
          { ...left, itemId: `__identity-left-${leftIndex}__` },
          { ...right, itemId: `__identity-right-${rightIndex}__` }
        ) === 'logical'
      )));
    // Multiple timestamps for one Jellyfin item should carry the same logical
    // identity. Mixed legacy/v1 or conflicting metadata is retained visibly,
    // but cannot nominate a merge identity based on insertion order.
    return consistent ? [{ itemId, records, identity }] : [];
  });
  const assigned = new Set<number>();
  for (let index = 0; index < candidates.length; index++) {
    if (assigned.has(index)) continue;
    const members = [index];
    for (let candidate = index + 1; candidate < candidates.length; candidate++) {
      if (assigned.has(candidate)) continue;
      // Requiring a match against every member avoids a transitive merge when
      // partially populated provider metadata forms an ambiguous bridge.
      if (members.every(member => compareBookmarkIdentity(
        candidates[member].identity,
        candidates[candidate].identity
      ) === 'logical')) {
        members.push(candidate);
      }
    }
    if (members.length < 2) continue;
    members.forEach(member => assigned.add(member));
    const itemGroups = Object.fromEntries(members.map(member => [
      candidates[member].itemId,
      candidates[member].records
    ]));
    duplicateGroups.push({
      providerKey: bookmarkIdentityLabel(candidates[index].identity),
      itemGroups,
      totalBookmarks: Object.values<any>(itemGroups).flat().length,
      name: candidates[index].identity.name || 'Unknown'
    });
  }

  return duplicateGroups;
}

/**
 * Show modal to sync duplicate bookmarks
 */
export function showDuplicatesSyncModal(
  bookmarks: Record<string, any>,
  context: IdentityContext | null = JC.identity.capture()
): void {
  if (!context || !JC.identity.isCurrent(context)) return;
  const duplicates = findDuplicateBookmarks(bookmarks);

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
      <button class="jc-bm-library-modal-close" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
      <div class="jc-bm-library-modal-content">
        <div class="jc-bookmarks-modal-header" style="display: flex; gap: 16px; align-items: flex-start; margin-bottom: 24px;">
          <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #ff9800; flex-shrink: 0;">merge</span>
          <div style="flex: 1;">
            <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #fff;">${JC.t!('bookmark_duplicate_title')}</h2>
            <p style="margin: 0; font-size: 13px; color: #aaa;">${JC.t!('bookmark_duplicate_subtitle').replace('{count}', String(duplicates.length))}</p>
          </div>
        </div>
        <div style="margin-top: 20px;">
          ${duplicates.map((dup, idx) => {
            const itemIds = Object.keys(dup.itemGroups);
            return `
              <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                <div style="font-weight: 600; margin-bottom: 12px; color: #ff9800;">${escapeHtml(dup.name)}</div>
                <div style="font-size: 12px; color: #888; margin-bottom: 12px;">
                  ${JC.t!('bookmark_split_versions')
                    .replace('{count}', dup.totalBookmarks)
                    .replace('{versions}', String(itemIds.length))}
                </div>
                ${itemIds.map((itemId, versionIdx) => {
                  const bms = dup.itemGroups[itemId];
                  return `
                    <div style="background: rgba(255,255,255,0.02); border-left: 3px solid ${versionIdx === 0 ? '#4caf50' : '#ff9800'}; padding: 8px 12px; margin-bottom: 8px; border-radius: 4px;">
                      <div style="font-size: 11px; color: ${versionIdx === 0 ? '#4caf50' : '#ff9800'}; font-weight: 600; margin-bottom: 4px;">
                        ${versionIdx === 0 ? JC.t!('bookmark_primary_version') : JC.t!('bookmark_old_version')}
                      </div>
                      <div style="font-size: 12px; color: #ccc; margin-bottom: 6px;">
                        ${JC.t!('bookmark_item_id')}: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-size: 11px;">${escapeHtml(itemId.substring(0, 16))}...</code>
                      </div>
                      <div style="font-size: 12px; color: #aaa; margin-bottom: 8px;">
                        ${JC.t!('bookmark_bookmark_count').replace('{count}', bms.length)} ${bms.map((b: any) => formatTimestamp(b.timestamp)).join(', ')}
                      </div>
                      <button class="jc-btn" data-sync-from="${versionIdx}" data-dup-index="${idx}" style="background: rgba(33, 150, 243, 0.15); border-color: #2196f3; color: #2196f3; font-size: 11px;">
                        <span class="material-icons" aria-hidden="true" style="font-size: 14px;">schedule</span>
                        <span>${JC.t!('bookmark_adjust_offset')}</span>
                      </button>
                    </div>
                  `;
                }).join('')}
                <button class="jc-btn" data-dup-index="${idx}" style="margin-top: 8px; background: rgba(255, 152, 0, 0.15); border-color: #ff9800; color: #ff9800;">
                  <span class="material-icons" aria-hidden="true" style="font-size: 16px;">merge</span>
                  <span>${JC.t!('bookmark_merge_primary')}</span>
                </button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      <div class="jc-bookmark-modal-actions">
        <button class="jc-bookmark-btn-cancel">
          <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
          <span>Close</span>
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeDialog = () => closeModal(modal);
  // Body-level modal: the page's dispose bag closes it on drain.
  currentPageHandle()?.track(closeDialog);

  modal.querySelector('.jc-bm-library-modal-close')?.addEventListener('click', closeDialog);
  modal.querySelector('.jc-bookmark-btn-cancel')?.addEventListener('click', closeDialog);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });

  // Adjust Offset button handlers
  modal.querySelectorAll<HTMLElement>('[data-sync-from]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!JC.identity.isCurrent(context)) return;
      const dupIndex = parseInt(btn.dataset.dupIndex!);
      const versionIndex = parseInt(btn.dataset.syncFrom!);
      const dup = duplicates[dupIndex];
      const itemIds = Object.keys(dup.itemGroups);
      const targetItemId = itemIds[versionIndex];
      const bookmarksForItem = dup.itemGroups[targetItemId];

      closeDialog();

      // Show offset adjustment modal for these bookmarks
      const groupObj = {
        bookmarks: bookmarksForItem,
        details: { name: dup.name }
      };
      showOffsetAdjustmentModal(groupObj, context);
    });
  });

  // Merge button handlers
  modal.querySelectorAll<HTMLButtonElement>('button.jc-btn:not([data-sync-from])').forEach(btn => {
    if (!btn.dataset.dupIndex) return;

    btn.addEventListener('click', () => { void (async () => {
      if (!JC.identity.isCurrent(context)) return;
      const dupIndex = parseInt(btn.dataset.dupIndex!);
      const dup = duplicates[dupIndex];
      const itemIds = Object.keys(dup.itemGroups);

      if (itemIds.length < 2) return;

      const primaryItemId = itemIds[0]; // First one is primary
      const oldItemIds = itemIds.slice(1);

      const primaryBookmarks = dup.itemGroups[primaryItemId];
      const oldBookmarks = oldItemIds.flatMap(id => dup.itemGroups[id]);

      if (!confirm(JC.t!('bookmark_merge_confirm').replace('{count}', String(oldBookmarks.length)))) {
        return;
      }
      if (!JC.identity.isCurrent(context)) return;

      btn.disabled = true;
      btn.querySelector('span:last-child')!.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';

      try {
        // Get primary item details from first primary bookmark
        const primaryDetails = {
          ...primaryBookmarks[0],
          itemId: primaryItemId,
          mediaType: normalizeBookmarkMediaType(primaryBookmarks[0].mediaType),
          name: primaryBookmarks[0].name
        };

        // Sync old bookmarks to primary
        const synced = await JC.bookmarks!.syncBookmarks(oldBookmarks, primaryDetails, 0);
        if (!JC.identity.isCurrent(context)) return;
        toast(JC.t!('bookmark_merge_success').replace('{count}', String(synced.length)), 3000);

        closeDialog();

        // Refresh the adopted host (syncBookmarks already resolved — no blind
        // setTimeout needed).
        renderActiveBookmarks(context);
      } catch (e) {
        if (!JC.identity.isCurrent(context)) return;
        console.error('Merge failed:', e);
        toast(JC.t!('bookmark_merge_failed'), 3000);
        btn.disabled = false;
        btn.querySelector('span:last-child')!.textContent = JC.t!('bookmark_merge_primary');
      }
    })(); });
  });

  scheduleModalTask(context, () => { if (modal.isConnected) modal.style.opacity = '1'; }, 10);
}
