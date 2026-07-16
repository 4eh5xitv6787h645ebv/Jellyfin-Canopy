import type { FeatureInstance, FeatureScope } from '../core/feature-loader';
import { installSeerrStatus } from './seerr-status';
import { installSeerrRequestManager } from './request-manager';
import { installSeerrApi } from './api';
import { installSeamlessScroll } from './seamless-scroll';
import { installSeerrUiFacade } from './ui/internal';
import './ui/icons';
import { installSeerrStyles } from './ui/styles';
import { installSeerrPopovers } from './ui/popover';
import './ui/badges';
import { installSeerrCards } from './ui/cards';
import { installDiscoveryFilter } from './discovery/filter-utils';

type Cleanup = () => void;
type Installer = () => Cleanup;

let activeDispose: Cleanup | null = null;

function composeCleanup(cleanups: Cleanup[]): Cleanup {
    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        for (const cleanup of cleanups.splice(0).reverse()) {
            try { cleanup(); } catch { /* continue exact teardown */ }
        }
    };
}

/** Synchronous installer for the single bundled Seerr foundation chunk. */
export function activateSeerrCoreImplementation(scope: FeatureScope): FeatureInstance | void {
    if (!scope.isCurrent()) return;
    activeDispose?.();

    const cleanups: Cleanup[] = [];
    let dispose: Cleanup;
    dispose = composeCleanup(cleanups);
    const ownedDispose = dispose;
    dispose = () => {
        ownedDispose();
        if (activeDispose === dispose) activeDispose = null;
    };

    const installers: Installer[] = [
        installSeerrStatus,
        installSeerrRequestManager,
        installSeerrApi,
        installSeamlessScroll,
        installSeerrUiFacade,
        installSeerrStyles,
        installSeerrPopovers,
        installSeerrCards,
        installDiscoveryFilter,
    ];

    try {
        for (const install of installers) {
            cleanups.push(install());
            if (!scope.isCurrent()) {
                dispose();
                return;
            }
        }
    } catch (error) {
        dispose();
        throw error;
    }

    activeDispose = dispose;
    scope.track(dispose);
    return { dispose };
}
