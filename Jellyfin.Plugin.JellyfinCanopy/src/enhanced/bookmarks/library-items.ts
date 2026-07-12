// src/enhanced/bookmarks/library-items.ts
//
// Bookmarks Library View — per-item card rendering + bookmark playback.
// Split from bookmarks-library.js (code motion; bodies verbatim).
// (Converted from js/enhanced/bookmarks-library-items.js — bodies semantically identical.)

import { JC } from '../../globals';
import { escapeHtml, toast } from '../../core/ui-kit';
import { getItemCached } from '../helpers';
import { formatTimestamp, parseTimestampInput, renderBookmarksLibrary } from './library-render';
import { findAndOfferReplacement } from './library-replacements';
import { showOffsetAdjustmentModal } from './library-modals';

/* eslint-disable @typescript-eslint/no-explicit-any */

const logPrefix = '🪼 Jellyfin Canopy: Bookmarks Library:';

/**
 * Render bookmark items with posters
 */
export async function renderBookmarkItems(container: HTMLElement, groupedByItem: Record<string, any>, currentTab: string): Promise<void> {
  container.innerHTML = '';
  const apiClient: any = window.ApiClient || (window as any).ConnectionManager?.currentApiClient();
  if (!apiClient) {
    container.innerHTML = '<p>API client not available</p>';
    return;
  }

  const userId = apiClient.getCurrentUserId();
  const itemPromises: Promise<any>[] = [];

  // Fetch all items
  for (const [key, group] of Object.entries<any>(groupedByItem)) {
    const itemId = group.details.itemId;
    if (itemId) {
      itemPromises.push(
        getItemCached(itemId, { userId })
          .then((item: any) => ({ key, group, item, orphaned: false }))
          .catch((err: unknown) => {
            console.warn(`Failed to fetch item ${itemId}:`, err);
            return { key, group, item: null, orphaned: true };
          })
      );
    } else {
      itemPromises.push(Promise.resolve({ key, group, item: null, orphaned: true }));
    }
  }

  const results = await Promise.all(itemPromises);

  // Apply tab filter
  const filtered = results.filter(({ group }) => {
    if (currentTab === 'tv') return group.type === 'tv';
    if (currentTab === 'movie') return group.type === 'movie';
    return true;
  });

  if (filtered.length === 0) {
    const emptyTitle = currentTab === 'tv' ? JC.t!('bookmark_empty_tv') : JC.t!('bookmark_empty_movie');
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
    const headerHtml = `
      <div class="jc-bookmark-item-header">
        ${posterUrl ? `
          <img src="${escapeHtml(posterUrl)}"
               class="jc-bookmark-item-poster"
               data-item-id="${escapeHtml(group.details.itemId)}">
        ` : `
          <div class="jc-bookmark-item-placeholder"><span class="material-icons" style="font-size: 48px; opacity: 0.3;">image_not_supported</span></div>
        `}
        <div class="jc-bookmark-item-info">
          <a href="/web/#/details?id=${escapeHtml(group.details.itemId || '')}" class="jc-bookmark-item-title">${titleDisplay}</a>
          <div class="jc-bookmark-item-meta">
            ${JC.t!('bookmark_count').replace('{count}', group.bookmarks.length)}
            ${orphaned ? ` • <span style="color: #ff9800;">${JC.t!('bookmark_orphaned')}</span>` : ''}
          </div>
        </div>
        ${orphaned && group.details.tmdbId ? `
          <button class="btnFindReplacement jc-btn-find-replacement" data-group-key="${escapeHtml(key)}" title="${JC.t!('bookmark_find_replacement')}">
            <span class="material-icons" aria-hidden="true">find_replace</span>
          </button>
        ` : ''}
        ${!orphaned && group.bookmarks.some((bm: any) => bm.syncedFrom) ? `
          <button class="btnAdjustOffset jc-offset-icon" data-group-key="${escapeHtml(key)}" title="${JC.t!('bookmark_adjust_offset')}">
            <span class="material-icons" aria-hidden="true">schedule</span>
          </button>
        ` : ''}
      </div>
      <div class="jc-bookmarks-list bookmarks-list-${key}"></div>
    `;

    itemCard.innerHTML = headerHtml;
    container.appendChild(itemCard);

    // Add Find Replacement handler
    const findBtn = itemCard.querySelector<HTMLButtonElement>('.btnFindReplacement');
    if (findBtn) {
      findBtn.addEventListener('click', () => { void (async () => {
        await findAndOfferReplacement(group, findBtn);
      })(); });
    }

    // Add Offset Adjustment handler
    const offsetBtn = itemCard.querySelector<HTMLElement>('.btnAdjustOffset');
    if (offsetBtn) {
      offsetBtn.addEventListener('click', () => {
        showOffsetAdjustmentModal(group);
      });
    }

    // Add poster click handler
    const poster = itemCard.querySelector<HTMLElement>('.jc-bookmark-item-poster');
    if (poster) {
      poster.addEventListener('click', () => {
        const itemId = poster.dataset.itemId;
        if (itemId) {
          (window.Emby?.Page as { show?: (path: string) => void } | undefined)?.show?.(`/details?id=${itemId}`);
        }
      });
    }

    // Render bookmarks for this item
    const bookmarksList = itemCard.querySelector<HTMLElement>(`.bookmarks-list-${key}`);
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
          <div class="jc-bm-time" data-item-id="${escapeHtml(bm.itemId)}" data-time="${Number(bm.timestamp) || 0}">
            <span>${bm.progress ? `${Number(bm.progress) || 0}% • ` : ''}${formatTimestamp(bm.timestamp)}</span>
          </div>
        `;

        const actions = document.createElement('div');
        actions.className = 'jc-bookmark-actions';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btnDeleteBookmark jc-btn jc-btn-delete';
        deleteBtn.innerHTML = '<span class="material-icons" aria-hidden="true">delete</span>';
        deleteBtn.dataset.bookmarkId = bm.id;

        // Only add play and edit buttons if not orphaned
        if (!orphaned) {
          const playBtn = document.createElement('button');
          playBtn.className = 'btnPlayBookmark jc-btn';
          playBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
          playBtn.dataset.itemId = bm.itemId;
          playBtn.dataset.time = bm.timestamp;

          const editBtn = document.createElement('button');
          editBtn.className = 'btnEditBookmark jc-btn';
          editBtn.innerHTML = '<span class="material-icons" aria-hidden="true">edit</span>';

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

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'jc-input jc-input-label';
        labelInput.value = bm.label || '';
        labelInput.placeholder = JC.t!('bookmark_label_placeholder');
        labelInput.maxLength = 100;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'jc-btn-action';
        saveBtn.innerHTML = '<span class="material-icons" aria-hidden="true">save</span>';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'jc-btn-action jc-btn-cancel';
        cancelBtn.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';

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
            const itemId = playBtn.dataset.itemId!;
            const time = parseFloat(playBtn.dataset.time!);
            await playItemAtTime(itemId, time);
          })(); });
        }

        // Edit button handler (only if not orphaned)
        const editBtn = actions.querySelector<HTMLButtonElement>('.btnEditBookmark');
        if (editBtn) {
          editBtn.addEventListener('click', () => {
            editRow.classList.toggle('show');
            if (editRow.classList.contains('show')) {
              timeInput.focus();
            }
          });
        }

        cancelBtn.addEventListener('click', () => {
          editRow.classList.remove('show');
          timeInput.value = formatTimestamp(bm.timestamp);
          labelInput.value = bm.label || '';
        });

        saveBtn.addEventListener('click', () => { void (async () => {
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
            if (ok) {
              toast(JC.t!('toast_bookmark_updated'), 2000);
              const bookmarksSection = document.querySelector<HTMLElement>('.sections.bookmarks');
              if (bookmarksSection) {
                void renderBookmarksLibrary(bookmarksSection);
              }
            } else {
              toast(JC.t!('toast_bookmark_save_failed'), 3000);
            }
          } catch (err) {
            console.error('Bookmark update failed', err);
            toast(JC.t!('toast_bookmark_save_failed'), 3000);
          } finally {
            saveBtn.disabled = false;
            if (editBtn) editBtn.disabled = false;
          }
        })(); });

        // Delete button handler
        deleteBtn.addEventListener('click', () => { void (async () => {
          const bookmarkId = deleteBtn.dataset.bookmarkId!;
          await JC.bookmarks!.delete(bookmarkId);
          toast(JC.t!('toast_bookmark_deleted'), 2000);

          // Re-render
          const bookmarksSection = document.querySelector<HTMLElement>('.sections.bookmarks');
          if (bookmarksSection) {
            void renderBookmarksLibrary(bookmarksSection);
          }
        })(); });

        // Timestamp click-to-play
        const ts = info.querySelector<HTMLElement>('.jc-bm-time');
        ts?.addEventListener('click', () => { void (async () => {
          const t = parseFloat(ts.dataset.time!);
          await playItemAtTime(ts.dataset.itemId!, t);
        })(); });
      });
    }
  }
}

/**
 * Play item at specific time
 */
async function playItemAtTime(itemId: string, startTime: number): Promise<void> {
  try {
    console.log(`${logPrefix} Attempting playback: itemId=${itemId}, startTime=${startTime}`);

    // Get the API client
    const apiClient: any = window.ApiClient || (window as any).ConnectionManager?.currentApiClient();
    if (!apiClient) {
      console.warn(`${logPrefix} API client not available`);
      toast(JC.t!('toast_api_client_unavailable'), 3000);
      return;
    }

    // Get device ID to find our session
    const deviceId = apiClient._deviceId || apiClient.deviceId();
    console.log(`${logPrefix} Device ID: ${deviceId}`);

    // Query sessions to find our current session
    const sessionsUrl = apiClient.getUrl('Sessions');
    const sessions = await apiClient.ajax({
      type: 'GET',
      url: sessionsUrl,
      dataType: 'json'
    });

    console.log(`${logPrefix} Available sessions:`, sessions);

    // Find our session by device ID
    const currentSession = sessions.find((s: any) => s.DeviceId === deviceId);

    if (!currentSession) {
      console.warn(`${logPrefix} Could not find current session`);
      toast(JC.t!('toast_session_not_found'), 3000);
      return;
    }

    const sessionId = currentSession.Id;
    console.log(`${logPrefix} Found session ID: ${sessionId}`);

    // Use Jellyfin Sessions API to start playback with query parameters
    const startTicks = Math.floor(startTime * 10000000);
    const url = `Sessions/${sessionId}/Playing?playCommand=PlayNow&itemIds=${itemId}&startPositionTicks=${startTicks}`;

    console.log(`${logPrefix} Sending playback request:`, url);

    await apiClient.ajax({
      type: 'POST',
      url: apiClient.getUrl(url)
    });

    console.log(`${logPrefix} Playback started successfully`);
    toast(JC.t!('toast_playing'), 2000);

    // Wait for navigation to complete, then trigger bookmark marker update
    setTimeout(() => {
      if ((window.JC as any)?.isVideoPage?.() && typeof window.JC?.bookmarks?.updateMarkers === 'function') {
        console.log(`${logPrefix} Triggering bookmark marker update after playback start`);
        void window.JC.bookmarks.updateMarkers();
      }
    }, 1500);

  } catch (e) {
    console.error(`${logPrefix} Failed to play item:`, e);
    toast(JC.t!('toast_playback_failed').replace('{error}', JC.escapeHtml((e as any).message || 'Unknown error')), 3000);
  }
}
