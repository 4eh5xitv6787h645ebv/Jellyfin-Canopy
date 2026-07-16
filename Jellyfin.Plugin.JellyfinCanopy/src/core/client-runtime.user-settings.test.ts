import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import '../enhanced/config';
import {
    initializeClientRuntime,
    type ClientManifest,
    type ClientRuntime,
} from './client-runtime';
import type { FeatureModule } from './feature-loader';

const HASH = 'a'.repeat(64);
const manifest: ClientManifest = {
    schemaVersion: 2,
    buildId: 'b'.repeat(64),
    entries: {
        'hide-favorites-tab': {
            kind: 'module',
            path: 'entries/hide-favorites-tab.js',
            role: 'feature',
        },
    },
};

describe('acknowledged local settings feature reconciliation', () => {
    let runtime: ClientRuntime;

    beforeAll(() => {
        JC.identity.transition('', '', 'local-settings-test-logout');
        const context = JC.identity.transition(
            'test-server-id',
            'test-user-id',
            'local-settings-test-login',
        )!;
        const settings = JC.identity.own({
            Revision: 0,
            hideFavoritesTab: false,
        }, context);
        JC.currentSettings = settings;
        JC.rememberUserSettingsSnapshot!('settings.json', settings);
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await runtime?.dispose();
    });

    it('activates and disposes lazily from acknowledged saves, then rejects optimistic rollback state', async () => {
        const dispose = vi.fn();
        const activate = vi.fn(() => ({ dispose }));
        const importModule = vi.fn((): Promise<FeatureModule> => Promise.resolve({ activate }));
        runtime = initializeClientRuntime({
            manifest,
            generationUrl: (path, attempt) => `/dist/${manifest.buildId}/attempts/${attempt}/${path}`,
            importModule,
        });
        runtime.registerFeatureDescriptors([{
            id: 'hide-favorites-tab',
            entry: 'hide-favorites-tab',
            scope: 'identity',
            isEnabled: () => JC.currentSettings?.hideFavoritesTab === true,
            isApplicable: () => true,
        }]);
        const context = JC.identity.capture()!;
        await runtime.configurationPublished(context);
        expect(importModule).not.toHaveBeenCalled();

        vi.spyOn(ApiClient, 'getCurrentUserId').mockReturnValue('test-user-id');
        let revision = 0;
        const ajax = vi.spyOn(ApiClient, 'ajax').mockImplementation((request) => {
            const data = JSON.parse(String(request.data)) as Record<string, unknown>;
            revision += 1;
            return Promise.resolve({
                success: true,
                file: 'settings.json',
                revision,
                contentHash: HASH,
                data: { ...data, Revision: revision },
            });
        });

        JC.currentSettings!.hideFavoritesTab = true;
        await JC.saveUserSettings!('settings.json', JC.currentSettings);
        await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(runtime.diagnostics().configGeneration).toBe(1);

        JC.currentSettings!.hideFavoritesTab = false;
        await JC.saveUserSettings!('settings.json', JC.currentSettings);
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
        expect(runtime.diagnostics().configGeneration).toBe(1);

        ajax.mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { status: 503 }));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        JC.currentSettings!.hideFavoritesTab = true;
        await expect(JC.saveUserSettings!('settings.json', JC.currentSettings)).rejects.toMatchObject({
            kind: 'unavailable',
            status: 503,
        });
        await vi.waitFor(() => expect(JC.currentSettings!.hideFavoritesTab).toBe(false));
        expect(activate).toHaveBeenCalledTimes(1);
        expect(runtime.diagnostics()).toMatchObject({
            activeFeatures: 0,
            configGeneration: 1,
        });

        let rejectStaleSave!: (error: unknown) => void;
        ajax.mockReturnValueOnce(new Promise((_resolve, reject) => {
            rejectStaleSave = reject;
        }));
        const staleSettings = JC.currentSettings!;
        staleSettings.hideFavoritesTab = true;
        const staleSave = JC.saveUserSettings!('settings.json', staleSettings);
        await vi.waitFor(() => expect(ajax).toHaveBeenCalledTimes(4));

        const nextContext = JC.identity.transition(
            'test-server-id',
            'next-test-user-id',
            'local-settings-test-switch',
        )!;
        JC.currentSettings = JC.identity.own({
            Revision: 0,
            hideFavoritesTab: true,
        }, nextContext);
        rejectStaleSave(Object.assign(new Error('HTTP 503'), { status: 503 }));

        await expect(staleSave).rejects.toMatchObject({ kind: 'unavailable' });
        await vi.waitFor(() => expect(runtime.diagnostics().activeFeatures).toBe(0));
        expect(activate).toHaveBeenCalledTimes(1);
        expect(JC.currentSettings.hideFavoritesTab).toBe(true);
    });
});
