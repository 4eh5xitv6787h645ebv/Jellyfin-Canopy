// src/enhanced/bookmarks/library-items.ts
//
// Bookmarks Library View — per-item card rendering + bookmark playback.
// Split from bookmarks-library.js (code motion; bodies verbatim).
// (Converted from js/enhanced/bookmarks-library-items.js — bodies semantically identical.)

import { JC } from '../../globals';
import { routeHref, routePath } from '../../core/navigation';
import { escapeHtml, toast } from '../../core/ui-kit';
import { formatTimestamp, parseTimestampInput, renderActiveBookmarks } from './library-render';
import { findAndOfferReplacement } from './library-replacements';
import { showOffsetAdjustmentModal } from './library-modals';
import type { IdentityContext } from '../../types/jc';
import type { BookmarkMediaType } from './media-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const logPrefix = '🪼 Jellyfin Canopy: Bookmarks Library:';
export const BOOKMARK_LIBRARY_DETAIL_CONCURRENCY = 1;
export const BOOKMARK_LIBRARY_RESOLUTION_BATCH_SIZE = 50;

const playbackTimers = new Set<number>();

export function resetBookmarksLibraryPlayback(): void {
  for (const timer of playbackTimers) window.clearTimeout(timer);
  playbackTimers.clear();
}

/**
 * Render bookmark items with posters
 */
export async function renderBookmarkItems(
  container: HTMLElement,
  groupedByItem: Record<string, any>,
  currentTab: BookmarkMediaType,
  context: IdentityContext | null = JC.identity.capture(),
  signal?: AbortSignal
): Promise<void> {
  if (!context || !JC.identity.isCurrent(context) || signal?.aborted) return;
  container.innerHTML = '';
  const apiClient: any = window.ApiClient || (window as any).ConnectionManager?.currentApiClient();
  if (!apiClient) {
    container.innerHTML = '<p>API client not available</p>';
    return;
  }

  // Filter before transport. One plugin request resolves the complete visible
  // page; the server hard-caps the batch and distinguishes authoritative 404s
  // from visibility and transient failures.
  const selected = Object.entries<any>(groupedByItem)
    .filter(([, group]) => group.type === currentTab);
  if (selected.length > BOOKMARK_LIBRARY_RESOLUTION_BATCH_SIZE) {
    throw new Error(`Bookmark library page exceeds the ${BOOKMARK_LIBRARY_RESOLUTION_BATCH_SIZE}-item resolution cap`);
  }
  const requestedIds = selected
    .map(([, group]) => group.details.itemId)
    .filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0);
  const plugin = JC.core.api?.plugin?.bind(JC.core.api);
  if (typeof plugin !== 'function') throw new Error('Bookmark item resolution transport is unavailable');
  const response = requestedIds.length > 0
    ? await plugin(`/user-settings/${encodeURIComponent(context.userId)}/bookmark.json/items/resolve`, {
      method: 'POST',
      body: { itemIds: requestedIds },
      signal,
      skipRetry: true
    }) as Record<string, unknown>
    : { Items: [] };
  if (signal?.aborted || !JC.identity.isCurrent(context)) return;
  const rawItems = response.Items ?? response.items;
  if (!Array.isArray(rawItems) || rawItems.length !== requestedIds.length) {
    throw new Error('Bookmark item resolution returned an invalid bounded result');
  }
  const resolutions = new Map<string, Record<string, unknown>>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const rawItemId = record.ItemId ?? record.itemId;
    const itemId = typeof rawItemId === 'string' ? rawItemId : '';
    if (itemId) resolutions.set(itemId, record);
  }
  const filtered = selected.map(([key, group]) => {
    const itemId = group.details.itemId;
    if (!itemId) return { key, group, item: null, orphaned: false };
    const resolution = resolutions.get(itemId);
    const rawStatus = resolution?.Status ?? resolution?.status;
    const status = typeof rawStatus === 'string' ? rawStatus : 'transient';
    if (status === 'exists' && resolution) {
      return {
        key,
        group,
        orphaned: false,
        item: {
          Id: resolution.Id ?? resolution.id,
          Type: resolution.Type ?? resolution.type,
          Name: resolution.Name ?? resolution.name,
          SeriesName: resolution.SeriesName ?? resolution.seriesName,
          ParentIndexNumber: resolution.ParentIndexNumber ?? resolution.parentIndexNumber,
          IndexNumber: resolution.IndexNumber ?? resolution.indexNumber,
          ImageTags: { Primary: undefined }
        }
      };
    }
    if (status !== 'notFound') {
      console.warn(`Item ${itemId} batch resolution returned ${status}; keeping it out of destructive orphan state`);
    }
    return { key, group, item: null, orphaned: status === 'notFound' };
  });

  if (filtered.length === 0) {
    const emptyTitle = currentTab === 'tv'
      ? JC.t!('bookmark_empty_tv')
      : currentTab === 'movie'
        ? JC.t!('bookmark_empty_movie')
        : JC.t!('bookmark_none');
    const emptyHint = JC.t!('bookmark_empty_hint');
    container.innerHTML = `
      <div class="jc-bookmarks-empty">
        <div class="jc-bookmarks-empty-icon material-icons" aria-hidden="true">bookmark_border</div>
        <div class="jc-bookmarks-empty-title">${emptyTitle}</div>
        <div class="jc-bookmarks-empty-hint">${emptyHint}</div>
      </div>`;
    return;
  }

  // Render each item
  for (const { key, group, item, orphaned } of filtered) {
    const itemCard = document.createElement('div');
    itemCard.className = 'jc-bookmark-item';
    if (orphaned) {
      itemCard.classList.add('jc-bookmark-item-orphaned');
    }

    const posterUrl = item ? apiClient.getImageUrl(item.Id, {
      type: 'Primary',
      maxWidth: 260,
      tag: item.ImageTags?.Primary
    }) : '';

    // Build header content
    let titleDisplay = escapeHtml(group.details.name || 'Unknown Item');
    // For TV episodes, show series name and episode number/name
    if (group.type === 'tv' && item && item.Type === 'Episode' && item.SeriesName) {
      titleDisplay = `${escapeHtml(item.SeriesName)}<br><small class="jc-episode-title">S${escapeHtml(item.ParentIndexNumber || '?')}:E${escapeHtml(item.IndexNumber || '?')} ${item.Name ? escapeHtml(item.Name) : ''}</small>`;
    }

    // Create the card header HTML
    const detailsHref = routeHref('details', { id: group.details.itemId || '' });
    const detailsLabel = escapeHtml(group.details.name || 'Unknown Item');
    const headerHtml = `
      <div class="jc-bookmark-item-header">
        ${posterUrl ? `
          <a href="${escapeHtml(detailsHref)}"
             class="jc-bookmark-item-poster-link"
             data-item-id="${escapeHtml(group.details.itemId)}"
             aria-label="${detailsLabel}">
            <img src="${escapeHtml(posterUrl)}"
                 alt=""
                 class="jc-bookmark-item-poster">
          </a>
        ` : `
          <div class="jc-bookmark-item-placeholder"><span class="material-icons" style="font-size: 48px; opacity: 0.3;">image_not_supported</span></div>
        `}
        <div class="jc-bookmark-item-info">
          <a href="${escapeHtml(detailsHref)}" class="jc-bookmark-item-title">${titleDisplay}</a>
          <div class="jc-bookmark-item-meta">
            ${JC.t!('bookmark_count').replace('{count}', group.bookmarks.length)}
            ${orphaned ? ` • <span style="color: #ff9800;">${JC.t!('bookmark_orphaned')}</span>` : ''}
          </div>
        </div>
        ${orphaned && group.details.tmdbId ? `
          <button type="button" class="btnFindReplacement jc-btn-find-replacement" data-group-key="${escapeHtml(key)}" title="${escapeHtml(JC.t!('bookmark_find_replacement'))}" aria-label="${escapeHtml(JC.t!('bookmark_find_replacement'))}">
            <span class="material-icons" aria-hidden="true">find_replace</span>
          </button>
        ` : ''}
        ${!orphaned && group.bookmarks.some((bm: any) => bm.syncedFrom) ? `
          <button type="button" class="btnAdjustOffset jc-offset-icon" data-group-key="${escapeHtml(key)}" title="${escapeHtml(JC.t!('bookmark_adjust_offset'))}" aria-label="${escapeHtml(JC.t!('bookmark_adjust_offset'))}">
            <span class="material-icons" aria-hidden="true">schedule</span>
          </button>
        ` : ''}
      </div>
      <div class="jc-bookmarks-list"></div>
    `;

    itemCard.innerHTML = headerHtml;
    container.appendChild(itemCard);

    // Add Find Replacement handler
    const findBtn = itemCard.querySelector<HTMLButtonElement>('.btnFindReplacement');
    if (findBtn) {
      findBtn.addEventListener('click', () => { void (async () => {
        if (!JC.identity.isCurrent(context)) return;
        await findAndOfferReplacement(group, findBtn, context);
      })(); });
    }

    // Add Offset Adjustment handler
    const offsetBtn = itemCard.querySelector<HTMLElement>('.btnAdjustOffset');
    if (offsetBtn) {
      offsetBtn.addEventListener('click', () => {
        if (!JC.identity.isCurrent(context)) return;
        showOffsetAdjustmentModal(group, context);
      });
    }

    // Add poster click handler
    const poster = itemCard.querySelector<HTMLAnchorElement>('.jc-bookmark-item-poster-link');
    if (poster) {
      poster.addEventListener('click', (event) => {
        if (!JC.identity.isCurrent(context)) return;
        event.preventDefault();
        const itemId = poster.dataset.itemId;
        if (itemId) {
          (window.Emby?.Page as { show?: (path: string) => void } | undefined)
            ?.show?.(routePath('details', { id: itemId }));
        }
      });
    }

    // Render bookmarks for this item
    const bookmarksList = itemCard.querySelector<HTMLElement>('.jc-bookmarks-list');
    if (bookmarksList) {
      group.bookmarks.forEach((bm: any) => {
        const bmEl = document.createElement('div');
        bmEl.className = 'jc-bookmark-row';

        const row = document.createElement('div');
        row.className = 'jc-bookmark-main';

        const bar = document.createElement('div');
        bar.className = 'jc-bookmark-bar';

        const info = document.createElement('div');
        info.className = 'jc-bookmark-info';
        info.innerHTML = `
          ${bm.label ? `<div class="jc-bookmark-label">${escapeHtml(bm.label)}</div>` : ''}
          <button type="button" class="jc-bm-time" data-item-id="${escapeHtml(bm.itemId)}" data-time="${Number(bm.timestamp) || 0}" aria-label="${escapeHtml(`${JC.t!('bookmark_jump')}: ${formatTimestamp(bm.timestamp)}`)}">
            <span>${bm.progress ? `${Number(bm.progress) || 0}% • ` : ''}${formatTimestamp(bm.timestamp)}</span>
          </button>
        `;

        const actions = document.createElement('div');
        actions.className = 'jc-bookmark-actions';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btnDeleteBookmark jc-btn jc-btn-delete';
        deleteBtn.innerHTML = '<span class="material-icons" aria-hidden="true">delete</span>';
        deleteBtn.dataset.bookmarkId = bm.id;
        deleteBtn.setAttribute('aria-label', JC.t!('bookmark_delete_confirm'));

        // Only add play and edit buttons if not orphaned
        if (!orphaned) {
          const playBtn = document.createElement('button');
          playBtn.type = 'button';
          playBtn.className = 'btnPlayBookmark jc-btn';
          playBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
          playBtn.dataset.itemId = bm.itemId;
          playBtn.dataset.time = bm.timestamp;
          playBtn.setAttribute('aria-label', `${JC.t!('bookmark_jump')}: ${formatTimestamp(bm.timestamp)}`);

          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'btnEditBookmark jc-btn';
          editBtn.innerHTML = '<span class="material-icons" aria-hidden="true">edit</span>';
          editBtn.setAttribute('aria-label', JC.t!('bookmark_edit_title'));

          actions.appendChild(playBtn);
          actions.appendChild(editBtn);
        }

        actions.appendChild(deleteBtn);

        row.appendChild(bar);
        row.appendChild(info);
        row.appendChild(actions);

        const editRow = document.createElement('div');
        editRow.className = 'jc-btn-edit-row';

        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.className = 'jc-input';
        timeInput.value = formatTimestamp(bm.timestamp);
        timeInput.placeholder = JC.t!('bookmark_time_placeholder');
        timeInput.setAttribute('aria-label', JC.t!('bookmark_time_label'));

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'jc-input jc-input-label';
        labelInput.value = bm.label || '';
        labelInput.placeholder = JC.t!('bookmark_label_placeholder');
        labelInput.maxLength = 100;
        labelInput.setAttribute('aria-label', JC.t!('bookmark_label_label'));

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'jc-btn-action';
        saveBtn.innerHTML = '<span class="material-icons" aria-hidden="true">save</span>';
        saveBtn.setAttribute('aria-label', JC.t!('bookmark_save'));

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'jc-btn-action jc-btn-cancel';
        cancelBtn.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';
        cancelBtn.setAttribute('aria-label', 'Cancel bookmark edit');

        editRow.appendChild(timeInput);
        editRow.appendChild(labelInput);
        editRow.appendChild(saveBtn);
        editRow.appendChild(cancelBtn);

        bmEl.appendChild(row);
        bmEl.appendChild(editRow);
        bookmarksList.appendChild(bmEl);

        // Play button handler (only if not orphaned)
        const playBtn = actions.querySelector<HTMLElement>('.btnPlayBookmark');
        if (playBtn) {
          playBtn.addEventListener('click', () => { void (async () => {
            if (!JC.identity.isCurrent(context)) return;
            const itemId = playBtn.dataset.itemId!;
            const time = parseFloat(playBtn.dataset.time!);
            await playItemAtTime(itemId, time, context);
          })(); });
        }

        // Edit button handler (only if not orphaned)
        const editBtn = actions.querySelector<HTMLButtonElement>('.btnEditBookmark');
        if (editBtn) {
          editBtn.addEventListener('click', () => {
            if (!JC.identity.isCurrent(context)) return;
            editRow.classList.toggle('show');
            if (editRow.classList.contains('show')) {
              timeInput.focus();
            }
          });
        }

        cancelBtn.addEventListener('click', () => {
          if (!JC.identity.isCurrent(context)) return;
          editRow.classList.remove('show');
          timeInput.value = formatTimestamp(bm.timestamp);
          labelInput.value = bm.label || '';
        });

        saveBtn.addEventListener('click', () => { void (async () => {
          if (!JC.identity.isCurrent(context)) return;
          const parsedTime = parseTimestampInput(timeInput.value);
          if (parsedTime === null) {
            toast(JC.t!('bookmark_time_format_hint'), 3000);
            return;
          }

          saveBtn.disabled = true;
          if (editBtn) editBtn.disabled = true;
          try {
            const ok = await JC.bookmarks!.update(bm.id, {
              timestamp: parsedTime,
              label: labelInput.value.trim()
            });
            if (!JC.identity.isCurrent(context)) return;
            if (ok) {
              toast(JC.t!('toast_bookmark_updated'), 2000);
              renderActiveBookmarks(context);
            } else {
              toast(JC.t!('toast_bookmark_save_failed'), 3000, 'error');
            }
          } catch (err) {
            if (!JC.identity.isCurrent(context)) return;
            console.error('Bookmark update failed', err);
            toast(JC.t!('toast_bookmark_save_failed'), 3000, 'error');
          } finally {
            if (JC.identity.isCurrent(context)) {
              saveBtn.disabled = false;
              if (editBtn) editBtn.disabled = false;
            }
          }
        })(); });

        // Delete button handler
        deleteBtn.addEventListener('click', () => { void (async () => {
          if (!JC.identity.isCurrent(context)) return;
          const bookmarkId = deleteBtn.dataset.bookmarkId!;
          try {
            await JC.bookmarks!.delete(bookmarkId);
            if (!JC.identity.isCurrent(context)) return;
            toast(JC.t!('toast_bookmark_deleted'), 2000);

            // Re-render into the adopted host (the delete already emitted
            // 'jc-bookmarks-updated'; this coalesces with that refresh).
            renderActiveBookmarks(context);
          } catch (error) {
            if (!JC.identity.isCurrent(context)) return;
            console.error('Bookmark delete failed', error);
            toast(JC.t!('bookmark_delete_failed'), 3000, 'error');
          }
        })(); });

        // Timestamp click-to-play
        const ts = info.querySelector<HTMLElement>('.jc-bm-time');
        ts?.addEventListener('click', () => { void (async () => {
          if (!JC.identity.isCurrent(context)) return;
          const t = parseFloat(ts.dataset.time!);
          await playItemAtTime(ts.dataset.itemId!, t, context);
        })(); });
      });
    }
  }
}

/**
 * Play item at specific time
 */
async function playItemAtTime(
  itemId: string,
  startTime: number,
  context: IdentityContext | null = JC.identity.capture()
): Promise<void> {
  if (!context || !JC.identity.isCurrent(context)) return;
  try {
    console.log(`${logPrefix} Attempting playback: itemId=${itemId}, startTime=${startTime}`);

    // Get the API client
    const apiClient: any = window.ApiClient || (window as any).ConnectionManager?.currentApiClient();
    if (!apiClient) {
      console.warn(`${logPrefix} API client not available`);
      toast(JC.t!('toast_api_client_unavailable'), 3000, 'error');
      return;
    }

    // Get device ID to find our session
    const deviceId = apiClient._deviceId || apiClient.deviceId();
    console.log(`${logPrefix} Device ID: ${deviceId}`);

    // Query sessions to find our current session
    const sessions = await JC.core.api!.jf('/Sessions', {
      skipCache: true
    });
    if (!JC.identity.isCurrent(context)) return;

    console.log(`${logPrefix} Available sessions:`, sessions);

    // Find our session by device ID
    const currentSession = Array.isArray(sessions)
      ? sessions.find((s: any) => s.DeviceId === deviceId)
      : null;

    if (!currentSession) {
      console.warn(`${logPrefix} Could not find current session`);
      toast(JC.t!('toast_session_not_found'), 3000, 'error');
      return;
    }

    const sessionId = currentSession.Id;
    console.log(`${logPrefix} Found session ID: ${sessionId}`);

    // Use Jellyfin Sessions API to start playback with query parameters
    const startTicks = Math.floor(startTime * 10000000);
    const url = `Sessions/${sessionId}/Playing?playCommand=PlayNow&itemIds=${itemId}&startPositionTicks=${startTicks}`;

    console.log(`${logPrefix} Sending playback request:`, url);

    if (!JC.identity.isCurrent(context)) return;
    await JC.core.api!.jf(`/${url}`, {
      method: 'POST',
      skipRetry: true
    });
    if (!JC.identity.isCurrent(context)) return;

    console.log(`${logPrefix} Playback started successfully`);
    toast(JC.t!('toast_playing'), 2000);

    // Wait for navigation to complete, then trigger bookmark marker update
    const timer = window.setTimeout(() => {
      playbackTimers.delete(timer);
      if (!JC.identity.isCurrent(context)) return;
      if ((window.JC as any)?.isVideoPage?.() && typeof window.JC?.bookmarks?.updateMarkers === 'function') {
        console.log(`${logPrefix} Triggering bookmark marker update after playback start`);
        void window.JC.bookmarks.updateMarkers();
      }
    }, 1500);
    playbackTimers.add(timer);

  } catch (e) {
    if (!JC.identity.isCurrent(context)) return;
    console.error(`${logPrefix} Failed to play item:`, e);
    toast(JC.t!('toast_playback_failed').replace('{error}', JC.escapeHtml((e as any).message || 'Unknown error')), 3000, 'error');
  }
}
