// Unit test for src/core/live-update.ts — version comparison and the one-shot
// "refresh to update" toast.
//
// notifyIfNewer() closes over the module-captured loadedVersion (JC.pluginVersion
// at import), so the notify cases re-import the module fresh with a chosen loaded
// version and a mocked toast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JC } from '../globals';
import { compareVersions } from './live-update';

describe('compareVersions', () => {
    it('orders dotted numeric versions', () => {
        expect(compareVersions('1.2.4.0', '1.2.3.0')).toBe(1);
        expect(compareVersions('1.2.3.0', '1.2.4.0')).toBe(-1);
        expect(compareVersions('1.2.3.0', '1.2.3.0')).toBe(0);
        expect(compareVersions('2.0.0.0', '1.9.9.9')).toBe(1);
    });

    it('treats missing trailing components as zero', () => {
        expect(compareVersions('1.2', '1.2.0.0')).toBe(0);
        expect(compareVersions('1.2.1', '1.2')).toBe(1);
    });

    it('returns NaN for unparseable input', () => {
        expect(Number.isNaN(compareVersions('unknown', '1.2.3'))).toBe(true);
        expect(Number.isNaN(compareVersions('1.2.3', 'dev'))).toBe(true);
    });
});

describe('notifyIfNewer (one-shot toast)', () => {
    let toast: ReturnType<typeof vi.fn>;

    async function loadWith(version: string) {
        vi.resetModules();
        JC.pluginVersion = version;
        toast = vi.fn();
        JC.core.ui = { toast } as unknown as NonNullable<typeof JC.core.ui>;
        return import('./live-update');
    }

    beforeEach(() => {
        vi.useFakeTimers(); // suppress the module's setTimeout/setInterval side effects
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('toasts once when the server version is strictly newer', async () => {
        const mod = await loadWith('1.2.3.0');
        mod.notifyIfNewer('1.2.4.0');
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls[0][0]).toMatch(/refresh to load the new version/i);

        // One-shot: a second newer report does not re-toast.
        mod.notifyIfNewer('1.2.5.0');
        expect(toast).toHaveBeenCalledTimes(1);
    });

    it('does not toast for an equal or older server version', async () => {
        const mod = await loadWith('1.2.3.0');
        mod.notifyIfNewer('1.2.3.0');
        mod.notifyIfNewer('1.2.2.0');
        expect(toast).not.toHaveBeenCalled();
    });

    it('does not toast when either version is unknown/unparseable', async () => {
        const mod = await loadWith('unknown');
        mod.notifyIfNewer('1.2.3.0');
        expect(toast).not.toHaveBeenCalled();

        const mod2 = await loadWith('1.2.3.0');
        mod2.notifyIfNewer('unknown');
        expect(toast).not.toHaveBeenCalled();
    });
});
