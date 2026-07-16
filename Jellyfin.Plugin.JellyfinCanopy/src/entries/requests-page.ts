import type { FeatureScope } from '../core/feature-loader';
import { downloadsPageDescriptor, downloadsPageFacade } from '../arr/requests/page';
import { activateRoutePage } from '../enhanced/pages/route-feature';

/** Import-pure requests/downloads route entry. */
export function activate(scope: FeatureScope): void {
    activateRoutePage(scope, downloadsPageDescriptor, downloadsPageFacade);
}
