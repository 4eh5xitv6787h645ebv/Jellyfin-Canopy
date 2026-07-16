import { JC } from '../../globals';
import type { FeatureModule, FeatureScope } from '../../core/feature-loader';
import { initializeSpoilerGuard, installSpoilerGuard } from './index';

let activeDispose: (() => void) | null = null;
const SPOILER_GUARD_READY_EVENT = 'jc:spoiler-guard-ready';

export async function activate(scope: FeatureScope): Promise<void> {
    if (!scope.isCurrent()) return;
    activeDispose?.();
    const cleanups: Array<() => void> = [];
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (activeDispose === dispose) activeDispose = null;
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
            try { cleanups[index]?.(); } catch { /* continue exact teardown */ }
        }
    };
    activeDispose = dispose;
    scope.track(dispose);
    cleanups.push(installSpoilerGuard());
    cleanups.push(JC.identity.registerReset('spoiler-guard-feature', dispose));
    if (!scope.isCurrent()) { dispose(); return; }
    await initializeSpoilerGuard();
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    // The details dispatcher may have evaluated before this feature published
    // its facade, or while the stable facade still used inactive delegates.
    // Signal only after the identity-owned state load settles; consumers fence
    // the event with their own config/navigation scope and exact page target.
    window.dispatchEvent(new CustomEvent(SPOILER_GUARD_READY_EVENT, {
        detail: {
            serverId: scope.serverId,
            userId: scope.userId,
            identityEpoch: scope.identityEpoch,
        },
    }));
}

export const spoilerGuardFeature: FeatureModule = { activate };
