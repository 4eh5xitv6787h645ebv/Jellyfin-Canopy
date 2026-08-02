import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../../globals';

vi.mock('./library-replacements', () => ({ findAndOfferReplacement: vi.fn() }));
vi.mock('./library-modals', () => ({
  showOffsetAdjustmentModal: vi.fn(),
  showDuplicatesSyncModal: vi.fn(),
}));

import { renderBookmarkItems } from './library-items';
import {
  renderBookmarksLibrary,
  resetBookmarksLibraryRender,
  startBookmarksLibraryRender,
} from './library-render';

/* eslint-disable @typescript-eslint/no-explicit-any */

function bookmarkGroups(count: number): Record<string, any> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const itemId = `item-${index.toString().padStart(4, '0')}`;
    return [itemId, {
      type: 'movie',
      details: { itemId, name: `Movie ${index}` },
      bookmarks: [{
        id: `bookmark-${index.toString().padStart(4, '0')}`,
        itemId,
        mediaType: 'movie',
        name: `Movie ${index}`,
        timestamp: index,
      }],
    }];
  }));
}

function bookmarkStore(count: number): Record<string, any> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const itemId = `item-${index.toString().padStart(4, '0')}`;
    return [`bookmark-${index.toString().padStart(4, '0')}`, {
      itemId,
      mediaType: 'movie',
      name: `Movie ${index}`,
      timestamp: index,
    }];
  }));
}

describe('bookmark library scale bounds', () => {
  const coverageRun = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_JC_V8_COVERAGE === '1';
  const renderBudgetMs = coverageRun ? 10_000 : 500;
  type PluginCall = (
    path: string,
    options?: { body?: any; signal?: AbortSignal }
  ) => Promise<any>;
  let plugin: ReturnType<typeof vi.fn<PluginCall>>;
  let store: Record<string, any>;

  beforeEach(() => {
    resetBookmarksLibraryRender();
    document.body.innerHTML = '';
    JC.identity.transition('scale-server', 'scale-user', 'bookmark-scale-test');
    JC.t = (key: string) => key === 'bookmark_count' ? '{count} bookmarks' : key;
    store = {};
    JC.userConfig = { bookmark: { revision: 0, bookmarks: {} } };
    JC.bookmarks = {
      delete: vi.fn().mockResolvedValue(true),
      update: vi.fn().mockResolvedValue(true),
      cleanupOrphaned: vi.fn().mockResolvedValue({ deleted: 0, retainedUncertain: 0, errors: 0 }),
      syncBookmarks: vi.fn().mockResolvedValue([]),
      adjustOffsets: vi.fn().mockResolvedValue(0),
      deleteAll: vi.fn().mockResolvedValue(0),
    } as any;
    plugin = vi.fn<PluginCall>((path: string, options?: { body?: any; signal?: AbortSignal }) => {
      if (path.includes('/page?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        const start = Number(query.get('startIndex'));
        const limit = Number(query.get('limit'));
        const entries = Object.entries(store).slice(start, start + limit);
        return Promise.resolve({
          Revision: 0,
          Total: Object.keys(store).length,
          AllTotal: Object.keys(store).length,
          Movie: Object.keys(store).length,
          Tv: 0,
          Other: 0,
          StartIndex: start,
          Limit: limit,
          HasMore: start + entries.length < Object.keys(store).length,
          Bookmarks: Object.fromEntries(entries)
        });
      }
      if (path.endsWith('/items/resolve')) {
        const itemIds = options?.body?.itemIds as string[];
        return Promise.resolve({ Items: itemIds.map(itemId => ({ ItemId: itemId, Status: 'exists', Id: itemId, Type: 'Movie', Name: itemId })) });
      }
      throw new Error(`unexpected plugin request: ${path}`);
    });
    JC.core.api = { plugin } as any;
    (globalThis as any).ApiClient = {
      getImageUrl: () => '',
      _deviceId: 'scale-device',
      deviceId: () => 'scale-device',
    };
    (window as any).ApiClient = (globalThis as any).ApiClient;
  });

  it('resolves a visible page in one hard-capped client request', async () => {
    const container = document.createElement('div');
    await renderBookmarkItems(container, bookmarkGroups(30), 'movie');

    expect(plugin).toHaveBeenCalledTimes(1);
    expect(plugin.mock.calls[0][0]).toContain('/items/resolve');
    expect(plugin.mock.calls[0]?.[1]?.body?.itemIds).toHaveLength(30);
  });

  it('cancels the one in-flight page-resolution request on lifecycle reset', async () => {
    store = bookmarkStore(30);
    const normal = plugin.getMockImplementation() as (
      path: string,
      options?: { body?: any; signal?: AbortSignal }
    ) => Promise<any>;
    plugin.mockImplementation((path: string, options?: { body?: any; signal?: AbortSignal }) => {
      if (!path.endsWith('/items/resolve')) return normal(path, options);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const rendering = renderBookmarksLibrary(container);
    await vi.waitFor(() => expect(plugin.mock.calls.filter(([path]) => String(path).endsWith('/items/resolve'))).toHaveLength(1));
    resetBookmarksLibraryRender();
    await rendering;

    expect(container.querySelectorAll('.jc-bookmark-row')).toHaveLength(0);
  });

  it('quietly retires interaction-owned pagination and tab renders', async () => {
    store = bookmarkStore(1000);
    const normal = plugin.getMockImplementation() as (
      path: string,
      options?: { body?: any; signal?: AbortSignal }
    ) => Promise<any>;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    for (const selector of ['.jc-bookmark-page-next', '.jc-tab[data-tab="tv"]']) {
      resetBookmarksLibraryRender();
      plugin.mockImplementation(normal);
      const container = document.createElement('div');
      document.body.replaceChildren(container);
      await renderBookmarksLibrary(container);

      let heldSignal: AbortSignal | undefined;
      plugin.mockImplementation((path: string, options?: { body?: any; signal?: AbortSignal }) => {
        if (!path.includes('/page?')) return normal(path, options);
        heldSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          heldSignal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Request was aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      });

      container.querySelector<HTMLButtonElement>(selector)!.click();
      await vi.waitFor(() => expect(heldSignal).toBeDefined());
      resetBookmarksLibraryRender();
      await vi.waitFor(() => expect(heldSignal?.aborted).toBe(true));
      await Promise.resolve();
    }

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports a genuine fire-and-forget render failure', async () => {
    const failure = new Error('bookmark page transport failed');
    plugin.mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);

    startBookmarksLibraryRender(container);

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
      '🪼 Jellyfin Canopy: Bookmarks Library: Render failed:',
      failure
    ));
  });

  it('renders fifty rows with three requests and stays responsive at the supported maximum', async () => {
    store = bookmarkStore(1000);
    const container = document.createElement('div');
    document.body.appendChild(container);

    const started = (globalThis as any).process.cpuUsage();
    await renderBookmarksLibrary(container);
    const usage = (globalThis as any).process.cpuUsage(started);
    const firstRenderMs = (usage.user + usage.system) / 1000;

    expect(container.querySelectorAll('.jc-bookmark-row')).toHaveLength(50);
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(2000);
    expect(plugin).toHaveBeenCalledTimes(2);
    expect(firstRenderMs).toBeLessThan(renderBudgetMs);
    expect(container.querySelector('.jc-bookmark-page-next')).not.toBeNull();
    expect(container.textContent).toContain('1-50 / 1000');

    container.querySelector<HTMLButtonElement>('.jc-bookmark-page-next')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('51-100 / 1000'));
    await vi.waitFor(() => expect(container.querySelectorAll('.jc-bookmark-row')).toHaveLength(50));
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(2000);
    expect(plugin).toHaveBeenCalledTimes(4);
  }, 30_000);
});
