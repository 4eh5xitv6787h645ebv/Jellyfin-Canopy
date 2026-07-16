import type { FeatureLoaderState, FeatureModule, FeatureScope } from '../core/feature-loader';
import { LIVE } from '../core/live';
import { resetButtonUi } from '../enhanced/hidden-content/buttons';
import { clearIdentityData } from '../enhanced/hidden-content/data';
import { resetDialogUi } from '../enhanced/hidden-content/dialogs';
import {
    clearFilterIdentityState,
    invalidateParentSeriesAssociations,
} from '../enhanced/hidden-content/filter';
import {
    initializeHiddenContent,
    installHiddenContent,
} from '../enhanced/hidden-content/init';
import { resetPanelUi } from '../enhanced/hidden-content/panel';
import {
    cancelAllPersistence,
    installPersistenceLifecycle,
} from '../enhanced/hidden-content/save';
import { JC } from '../globals';

export function isHiddenContentEnabled(state: FeatureLoaderState): boolean {
    return Boolean(state.identity) && JC.pluginConfig?.HiddenContentEnabled === true;
}

let activeDispose: (() => void) | null = null;

export const hiddenContentRuntimeFeature: FeatureModule = Object.freeze({
    activate(scope: FeatureScope) {
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

        cleanups.push(installHiddenContent());
        cleanups.push(clearIdentityData);
        cleanups.push(cancelAllPersistence);
        cleanups.push(resetPanelUi);
        cleanups.push(resetDialogUi);
        cleanups.push(resetButtonUi);
        cleanups.push(clearFilterIdentityState);
        cleanups.push(() => document.getElementById('jc-hidden-content')?.remove());
        cleanups.push(installPersistenceLifecycle());
        if (JC.core.live) {
            cleanups.push(JC.core.live.on(LIVE.LIBRARY_CHANGED, invalidateParentSeriesAssociations));
        }
        cleanups.push(JC.identity.registerReset('hidden-content-runtime', dispose));

        if (!scope.isCurrent()) {
            dispose();
            return;
        }
        initializeHiddenContent();
        if (!scope.isCurrent()) dispose();
    },
});

export const activate: FeatureModule['activate'] = (scope) => hiddenContentRuntimeFeature.activate(scope);
