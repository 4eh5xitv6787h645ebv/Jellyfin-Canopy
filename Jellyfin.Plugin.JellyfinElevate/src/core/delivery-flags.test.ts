// src/core/delivery-flags.test.ts
//
// Unit tests for the delivery-plugin flag sanitizer (INIT-1).
import { afterEach, describe, expect, it } from 'vitest';
import { JE } from '../globals';
import { sanitizeDeliveryPluginFlags, applyDeliveryFlagSanitization } from './delivery-flags';

const CUSTOM_TABS = ['BookmarksUseCustomTabs', 'CalendarUseCustomTabs', 'HiddenContentUseCustomTabs', 'DownloadsUseCustomTabs'];
const PLUGIN_PAGES = ['BookmarksUsePluginPages', 'HiddenContentUsePluginPages', 'DownloadsUsePluginPages', 'CalendarUsePluginPages'];

describe('sanitizeDeliveryPluginFlags', () => {
    it('zeroes only the flags of the uninstalled delivery plugin', () => {
        const cfg: Record<string, unknown> = {};
        for (const flag of [...CUSTOM_TABS, ...PLUGIN_PAGES]) cfg[flag] = true;

        sanitizeDeliveryPluginFlags(cfg, { customTabs: false, pluginPages: true });

        for (const flag of CUSTOM_TABS) expect(cfg[flag]).toBe(false);
        for (const flag of PLUGIN_PAGES) expect(cfg[flag]).toBe(true);
    });

    it('leaves everything alone when both plugins are installed', () => {
        const cfg: Record<string, unknown> = {};
        for (const flag of [...CUSTOM_TABS, ...PLUGIN_PAGES]) cfg[flag] = true;

        sanitizeDeliveryPluginFlags(cfg, { customTabs: true, pluginPages: true });

        for (const flag of [...CUSTOM_TABS, ...PLUGIN_PAGES]) expect(cfg[flag]).toBe(true);
    });

    it('is a no-op on a null/undefined config', () => {
        expect(() => sanitizeDeliveryPluginFlags(null, { customTabs: false, pluginPages: false })).not.toThrow();
        expect(() => sanitizeDeliveryPluginFlags(undefined, { customTabs: false, pluginPages: false })).not.toThrow();
    });
});

describe('applyDeliveryFlagSanitization', () => {
    afterEach(() => {
        delete JE._deliveryPluginsInstalled;
    });

    it('no-ops when the boot-cached installed state is unknown', () => {
        delete JE._deliveryPluginsInstalled;
        (JE.pluginConfig as Record<string, unknown>).BookmarksUseCustomTabs = true;

        applyDeliveryFlagSanitization();

        expect(JE.pluginConfig.BookmarksUseCustomTabs).toBe(true);
    });

    it('re-zeroes flags for an uninstalled plugin using the cached state', () => {
        JE._deliveryPluginsInstalled = { customTabs: false, pluginPages: false };
        (JE.pluginConfig as Record<string, unknown>).BookmarksUseCustomTabs = true;
        (JE.pluginConfig as Record<string, unknown>).BookmarksUsePluginPages = true;

        applyDeliveryFlagSanitization();

        expect(JE.pluginConfig.BookmarksUseCustomTabs).toBe(false);
        expect(JE.pluginConfig.BookmarksUsePluginPages).toBe(false);
    });
});
