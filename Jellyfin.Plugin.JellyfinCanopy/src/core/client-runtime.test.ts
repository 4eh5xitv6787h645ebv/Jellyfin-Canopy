import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import type { NavigateCallback, NavigationApi } from '../types/jc';
import {
    createClientRuntime,
    type ClientFeatureDescriptor,
    type ClientManifest,
    type ClientRuntime,
} from './client-runtime';
import type { FeatureModule } from './feature-loader';

const manifest: ClientManifest = {
    schemaVersion: 2,
    buildId: 'a'.repeat(64),
    entries: {
        boot: { kind: 'module', path: 'entries/boot.js', role: 'boot' },
        calendar: { kind: 'module', path: 'entries/calendar.js', role: 'feature' },
        requests: { kind: 'module', path: 'entries/requests.js', role: 'feature' },
        compatibility: { kind: 'classic', path: 'jc.bundle.js', role: 'compatibility' },
    },
};

function descriptor(id: string, entry = id): ClientFeatureDescriptor {
    return {
        id,
        entry,
        scope: 'navigation',
        isEnabled: () => true,
        isApplicable: () => true,
    };
}

describe('client feature runtime', () => {
    let runtime: ClientRuntime | null;
    let navigate: (() => void) | null;
    let originalNavigation: NavigationApi | undefined;

    beforeEach(() => {
        runtime = null;
        navigate = null;
        originalNavigation = JC.core.navigation;
        JC.core.navigation = {
            onNavigate(callback: NavigateCallback) {
                navigate = callback;
                return () => { navigate = null; };
            },
        } as unknown as NavigationApi;
        window.history.replaceState({}, '', '/web/home');
    });

    afterEach(async () => {
        await runtime?.dispose();
        JC.core.navigation = originalNavigation;
    });

    it('validates a complete descriptor batch before installing any member', () => {
        runtime = createClientRuntime({
            manifest,
            generationUrl: (path, attempt) => `/dist/build/${path}?attempt=${attempt}`,
            importModule: vi.fn(),
        });

        expect(() => runtime!.registerFeatureDescriptors([
            descriptor('calendar'),
            descriptor('missing'),
        ])).toThrow('Unknown feature manifest entry: missing');
        expect(runtime.diagnostics().registered).toBe(0);
        expect(() => runtime!.registerFeatureDescriptors([
            descriptor('classic', 'compatibility'),
        ])).toThrow('Manifest entry is not a feature module: compatibility');
        expect(runtime.diagnostics().registered).toBe(0);
        expect(() => runtime!.registerFeatureDescriptors([
            { ...descriptor('calendar'), dependsOn: ['not-registered'] },
        ])).toThrow('Unknown feature dependency for calendar: not-registered');
        expect(runtime.diagnostics().registered).toBe(0);
        expect(() => runtime!.registerFeatureDescriptors([
            { ...descriptor('calendar'), dependsOn: ['requests'] },
            { ...descriptor('requests'), dependsOn: ['calendar'] },
        ])).toThrow('Feature dependency cycle');
        expect(runtime.diagnostics().registered).toBe(0);
    });

    it('imports only manifest paths and restarts navigation ownership by generation', async () => {
        const dispose = vi.fn();
        const activate = vi.fn(() => ({ dispose }));
        const imported: string[] = [];
        const importModule = vi.fn((url: string): Promise<FeatureModule> => {
            imported.push(url);
            return Promise.resolve({ activate });
        });
        runtime = createClientRuntime({
            manifest,
            generationUrl: (path, attempt) => `/dist/${manifest.buildId}/${path}?attempt=${attempt}`,
            importModule,
        });
        runtime.registerFeatureDescriptors([descriptor('calendar')]);
        const context = JC.identity.capture()!;

        await runtime.configurationPublished(context);
        expect(imported).toEqual([`/dist/${manifest.buildId}/entries/calendar.js?attempt=0`]);
        expect(activate).toHaveBeenCalledTimes(1);

        window.history.pushState({}, '', '/web/details?id=1');
        navigate?.();
        await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2));
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(runtime.diagnostics()).toMatchObject({
            configGeneration: 1,
            navigationGeneration: 1,
            routeKey: '/web/details?id=1',
            activeFeatures: 1,
        });
    });

    it('restarts only opted-in identity features after config publication', async () => {
        const restartingActivate = vi.fn(() => ({ dispose: vi.fn() }));
        const stableActivate = vi.fn(() => ({ dispose: vi.fn() }));
        const modules: Record<string, FeatureModule> = {
            calendar: { activate: restartingActivate },
            requests: { activate: stableActivate },
        };
        runtime = createClientRuntime({
            manifest,
            generationUrl: (path, attempt) => `/dist/${path}?attempt=${attempt}`,
            importModule: (url) => Promise.resolve(modules[url.includes('calendar') ? 'calendar' : 'requests']),
        });
        runtime.registerFeatureDescriptors([
            { ...descriptor('calendar'), scope: 'identity', restartOnConfigChange: true },
            { ...descriptor('requests'), scope: 'identity' },
        ]);
        const context = JC.identity.capture()!;

        await runtime.configurationPublished(context);
        await runtime.configurationPublished(context);

        expect(restartingActivate).toHaveBeenCalledTimes(2);
        expect(stableActivate).toHaveBeenCalledTimes(1);
        expect(runtime.diagnostics().configGeneration).toBe(2);
    });

    it('deactivates synchronously on identity reset and waits for the new config owner', async () => {
        const dispose = vi.fn();
        const activate = vi.fn(() => ({ dispose }));
        runtime = createClientRuntime({
            manifest,
            generationUrl: (path, attempt) => `/dist/${path}?attempt=${attempt}`,
            importModule: () => Promise.resolve({ activate }),
        });
        runtime.registerFeatureDescriptors([descriptor('calendar')]);
        await runtime.configurationPublished(JC.identity.capture()!);
        expect(activate).toHaveBeenCalledTimes(1);

        const next = JC.identity.transition('next-server', 'next-user', 'runtime-test')!;
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
        expect(activate).toHaveBeenCalledTimes(1);
        expect(runtime.diagnostics().activeFeatures).toBe(0);

        await runtime.configurationPublished(next);
        expect(activate).toHaveBeenCalledTimes(2);
    });
});
