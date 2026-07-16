import type { FeatureScope } from '../../core/feature-loader';
import { JC } from '../../globals';
import type { PageDescriptor } from './types';
import { adoptedPageId, drain, refreshCurrent } from './fallback-host';
import { attachPageFacade } from './facades';
import { registerPage } from './registry';

type PageId = 'calendar' | 'downloads' | 'hidden-content' | 'bookmarks';

/**
 * Activate one import-pure page cluster. All global attachment happens only
 * after the loader scope is current and is removed by one tracked cleanup.
 */
export function activateRoutePage(
    scope: FeatureScope,
    descriptor: PageDescriptor & { id: PageId },
    facade: object
): void {
    if (!scope.isCurrent()) return;

    let resetDone = false;
    const resetCluster = (): void => {
        if (resetDone) return;
        resetDone = true;
        descriptor.onHide?.();
    };
    const runtimeDescriptor: PageDescriptor & { id: PageId } = {
        ...descriptor,
        render: (context) => {
            resetDone = false;
            return descriptor.render(context);
        },
        onHide: resetCluster,
    };
    const unregister = registerPage(runtimeDescriptor);
    const detachFacade = attachPageFacade(descriptor.id, facade);
    const unregisterIdentityReset = JC.identity.registerReset(`route-page-${descriptor.id}`, resetCluster);
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        unregister();
        detachFacade();
        if (adoptedPageId() === descriptor.id) drain('feature-disposed');
        unregisterIdentityReset();
        resetCluster();
    };
    scope.track(dispose);

    if (!scope.isCurrent()) {
        dispose();
        return;
    }
    if (adoptedPageId() === descriptor.id) refreshCurrent();
}
