import type { FeatureScope } from '../core/feature-loader';
import { maintainerrPageDescriptor, maintainerrPageFacade } from '../maintainerr/page';
import { activateRoutePage } from '../enhanced/pages/route-feature';

/** Import-pure Maintainerr admin route entry. */
export function activate(scope: FeatureScope): void {
    activateRoutePage(scope, maintainerrPageDescriptor, maintainerrPageFacade);
}
