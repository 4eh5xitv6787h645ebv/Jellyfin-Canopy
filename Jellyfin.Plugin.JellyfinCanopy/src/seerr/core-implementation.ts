import type { FeatureInstance, FeatureScope } from '../core/feature-loader';
import { installSeerrStatus } from './seerr-status';
import { installSeerrRequestManager } from './request-manager';
import { installSeerrApi } from './api';
import { installSeamlessScroll } from './seamless-scroll';
import { installSeerrUiFacade } from './ui/internal';
import './ui/icons';
import './ui/styles';
import { installSeerrPopovers } from './ui/popover';
import './ui/badges';
import { installSeerrCards } from './ui/cards';
import { installDiscoveryFilter } from './discovery/filter-utils';

type Cleanup = () => void;

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
    const cleanups = [
        installSeerrStatus(),
        installSeerrRequestManager(),
        installSeerrApi(),
        installSeamlessScroll(),
        installSeerrUiFacade(),
        installSeerrPopovers(),
        installSeerrCards(),
        installDiscoveryFilter(),
    ];
    const dispose = composeCleanup(cleanups);
    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    scope.track(dispose);
    return { dispose };
}
